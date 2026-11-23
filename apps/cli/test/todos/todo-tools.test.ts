import { join } from "node:path";

import {
  RemindersPayloadSchema,
  WorkspaceSettingsSchema,
  evaluateGate,
  formatReminderTime,
  seededTodoRule,
  tasksHomeOf,
  tasksHomeServer,
  untrustedLabel,
  type InvocationContext,
} from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { remindersCommand } from "../../src/features/reminders/owner.js";
import { registerReminderTools } from "../../src/features/reminders/tools.js";
import { todoChecklistLine, todosPayload } from "../../src/features/todos/client.js";
import { registerTodoTools } from "../../src/features/todos/tools.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * The agent's to-do tools and the operator's to-do actions: a to-do is a
 * reminder row with no fire time; a due time also reminds; each person sees
 * only their own; and reminder lists never show to-dos.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const NOW = new Date("2026-10-01T10:00:00.000Z"); // Thursday

async function fixture() {
  const directory = directories.create("tavi-todo-tools-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const repositories = store.asPort().repositories;
  await repositories.workspaceSettings.set({
    workspaceId: "default",
    settings: { timezone: "Europe/Berlin" },
    expectedRevision: 0,
    actor: "operator",
    now: NOW.toISOString(),
  });
  const registry = new ToolRegistry();
  let serial = 0;
  const deps = {
    repositories,
    isLocalConnection: (connectionId: string) => connectionId.startsWith("local:"),
    now: () => NOW,
    newId: () => `id-${(serial += 1)}`,
  };
  registerTodoTools(registry, deps);
  registerReminderTools(registry, deps);
  const context = (principalId: string, runId = "t-chat"): InvocationContext => ({
    workspaceId: "default",
    principalId,
    runId,
    caller: "test",
  });
  const call = (name: string, input: unknown, invocation: InvocationContext, contextLabel?: ReturnType<typeof untrustedLabel>) =>
    registry.get(name)?.handler({
      input,
      context: invocation,
      signal: AbortSignal.timeout(5_000),
      ...(contextLabel === undefined ? {} : { contextLabel }),
    }) as Promise<Record<string, unknown>>;
  return { store, repositories, registry, context, call };
}

describe("todos.*", () => {
  it("adds to a list, answers a retry or a repeat with the same to-do, and keeps to-dos out of reminders", async () => {
    const { store, call, context } = await fixture();
    try {
      const alice = context("alice");
      const added = await call("todos.add", { text: "Buy milk", list: "Groceries", operationKey: "k1" }, alice);
      expect(added).toMatchObject({
        text: "Buy milk",
        list: "groceries",
        status: "open",
        created: true,
        readBack: "open, on groceries, no due date",
      });
      expect(await call("todos.add", { text: "Buy milk", list: "Groceries", operationKey: "k1" }, alice)).toMatchObject({ created: false });
      expect(await call("todos.add", { text: "buy milk", list: "groceries", operationKey: "k2" }, alice)).toMatchObject({
        created: false,
        duplicate: true,
        todoId: added["todoId"],
      });
      await call("todos.add", { text: "Renew passport", operationKey: "k3" }, alice);
      const listed = await call("todos.list", {}, alice);
      expect((listed["todos"] as { text: string; list: string }[]).map((todo) => [todo.text, todo.list])).toEqual([
        ["Buy milk", "groceries"],
        ["Renew passport", "inbox"],
      ]);
      expect(await call("todos.list", { list: "GROCERIES" }, alice)).toMatchObject({ todos: [{ text: "Buy milk" }] });
      // Another person sees none of them, and cannot tick one off.
      expect(await call("todos.list", {}, context("bob"))).toMatchObject({ todos: [] });
      await expect(call("todos.complete", { todoId: added["todoId"] }, context("bob"))).rejects.toMatchObject({ code: "NOT_FOUND" });
      // A to-do is no reminder, and reminders.* cannot reach it.
      expect(await call("reminders.list", {}, alice)).toMatchObject({ reminders: [] });
      await expect(call("reminders.cancel", { reminderId: added["todoId"] }, alice)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await store.close();
    }
  });

  it("a due time reminds through the reminder machinery; a due date is only shown; completing stops the reminder", async () => {
    const { store, repositories, call, context } = await fixture();
    try {
      const alice = context("alice");
      const timed = await call("todos.add", { text: "Call the plumber", due: "2026-10-02T17:00", operationKey: "k1" }, alice);
      // 17:00 in Berlin (CEST) is 15:00 UTC.
      expect(timed).toMatchObject({
        due: "2026-10-02T15:00:00.000Z",
        readBack: "open, on inbox, due Fri 2 Oct 17:00 Europe/Berlin; I'll remind you then",
      });
      const dated = await call("todos.add", { text: "Pay rent", due: "2026-10-05", operationKey: "k2" }, alice);
      expect(dated).toMatchObject({ due: "2026-10-05", readBack: "open, on inbox, due 2026-10-05" });
      const claimed = await repositories.reminders.claimDue({ now: "2026-10-02T15:00:30.000Z", limit: 10 });
      expect(claimed.claimed.map((fire) => [fire.reminder.text, fire.reminder.kind])).toEqual([["Call the plumber", "todo"]]);
      // Ticked off before its time, a to-do no longer reminds; reopened with its time still ahead, it does again.
      const early = await call("todos.add", { text: "Water plants", due: "2026-10-03T09:00", operationKey: "k3" }, alice);
      expect(await call("todos.complete", { todoId: early["todoId"] }, alice)).toMatchObject({ status: "done", changed: true });
      expect((await repositories.reminders.getTodo(early["todoId"] as string))?.remindAt).toBeNull();
      expect(await call("todos.complete", { todoId: early["todoId"] }, alice)).toMatchObject({ changed: false });
      await call("todos.complete", { todoId: early["todoId"], reopen: true }, alice);
      expect((await repositories.reminders.getTodo(early["todoId"] as string))?.remindAt).toBe("2026-10-03T07:00:00.000Z");
      // Clearing the due clears its reminder.
      await call("todos.update", { todoId: early["todoId"], due: null, notes: "the balcony ones" }, alice);
      expect(await repositories.reminders.getTodo(early["todoId"] as string)).toMatchObject({ remindAt: null, notes: "the balcony ones" });
      expect(await call("todos.remove", { todoId: dated["todoId"] }, alice)).toMatchObject({ removed: true });
      expect(await repositories.reminders.getTodo(dated["todoId"] as string)).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("keeps a tainted call's label, and asks before a tainted change", async () => {
    const { store, registry, call, context } = await fixture();
    try {
      const alice = context("alice");
      const label = untrustedLabel("web", { ref: { ref: "call-1", at: NOW.toISOString() } });
      const added = await call("todos.add", { text: "Read the article", operationKey: "k1" }, alice, label);
      expect(added).toHaveProperty(["taviLabel"]);
      const assessed = registry.get("todos.remove")?.assess?.({ todoId: "x" }, { ...alice });
      expect(assessed).toMatchObject({ askWhenTainted: true });
      expect(registry.get("todos.add")?.assess?.({ text: "x", operationKey: "k" }, { ...alice })).not.toHaveProperty("askWhenTainted");
      // The card in the workspace's language; in English as before.
      expect(registry.get("todos.remove")?.assess?.({ todoId: "x" }, { ...alice, locale: "bg" })).toMatchObject({
        display: { title: "Премахни задачата x" },
        reasons: ["премахва задача завинаги"],
      });
      expect(assessed).toMatchObject({ display: { title: "Remove to-do x" }, reasons: ["removes a to-do for good"] });
      expect(registry.get("todos.complete")?.assess?.({ todoId: "x", reopen: true }, { ...alice, locale: "bg" })?.display.title).toBe(
        "Отвори отново задачата x",
      );
      expect(
        registry.get("todos.add")?.assess?.({ text: "Купи мляко", operationKey: "k" }, { ...alice, locale: "bg" })?.display.title,
      ).toBe("Добави задача: Купи мляко");
      expect(registry.get("todos.add")?.assess?.({ text: "Buy milk", operationKey: "k" }, { ...alice })?.display.title).toBe(
        "Add to-do: Buy milk",
      );
    } finally {
      await store.close();
    }
  });

  it("are allowed by the seeded rule; update and remove are the only deferred ones", async () => {
    const { store, registry } = await fixture();
    try {
      const rule = seededTodoRule("default", NOW.toISOString());
      expect(rule).toMatchObject({ ruleId: "seeded-todos", toolPattern: "todos.*", decision: "allow" });
      const tool = registry.get("todos.add");
      expect(tool?.sink).toBe("persist");
      expect(registry.get("todos.list")?.sink).toBe("none");
      expect(
        evaluateGate({
          workspaceId: "default",
          toolId: "todos.add",
          effect: "mutating",
          sink: "persist",
          rules: [rule],
          assessment: { subjects: [], risk: "low", reasons: [], display: { title: "Add" } },
        } as never),
      ).toMatchObject({ decision: "allow", ruleId: "seeded-todos" });
      // The rule allows the list, but not a tainted change: the assessor's `askWhenTainted` still asks.
      for (const toolId of ["todos.complete", "todos.update", "todos.remove"]) {
        const assessment = registry
          .get(toolId)
          ?.assess?.({ todoId: "todo-x" }, { workspaceId: "default", principalId: "alice", runId: "r", caller: "test" });
        expect(assessment).toMatchObject({ askWhenTainted: true });
        expect(
          evaluateGate({
            workspaceId: "default",
            toolId,
            effect: "mutating",
            sink: "persist",
            tainted: true,
            rules: [rule],
            assessment,
          } as never).decision,
        ).not.toBe("allow");
      }
    } finally {
      await store.close();
    }
  });
});

describe("todos.add and reminders.create", () => {
  it("keep their operation keys apart, so one key reused across the two makes both", async () => {
    const { store, call, context } = await fixture();
    try {
      const alice = context("alice");
      await call("todos.add", { text: "Buy milk", operationKey: "1" }, alice);
      const made = await call(
        "reminders.create",
        { text: "Stretch", when: { kind: "once", at: "2026-10-02T09:00" }, operationKey: "1" },
        alice,
      );
      expect(made).toMatchObject({ created: true, text: "Stretch" });
      expect(made).not.toHaveProperty("kind");
    } finally {
      await store.close();
    }
  });
});

describe("the operator's to-dos", () => {
  it("adds, lists, ticks off, exports and removes through the reminders command", async () => {
    const { store, repositories } = await fixture();
    try {
      const deps = {
        repositories,
        principalOf: () => "operator",
        now: () => NOW,
        newId: (() => {
          let n = 0;
          return () => `n${(n += 1)}`;
        })(),
      };
      const add = (text: string, extra: Record<string, unknown> = {}) =>
        remindersCommand(deps, RemindersPayloadSchema.parse({ action: "todo-add", text, ...extra }));
      const milk = await add("Buy milk", { list: "groceries" });
      expect(milk).toMatchObject({
        ok: true,
        result: { created: true, todo: { list: "groceries", deliverTo: { kind: "app" }, createdBy: "user" } },
      });
      await add("Renew passport", { due: "2026-11-01" });
      const plumber = await add("Call the plumber", { due: "2026-11-06T17:00:00.000Z" });
      const todoId = (milk as { result: { todo: { todoId: string } } }).result.todo.todoId;
      expect(await remindersCommand(deps, { action: "todo-update", todoId, status: "done" })).toMatchObject({
        ok: true,
        result: { todo: { status: "done" } },
      });
      expect(await remindersCommand(deps, { action: "todos" })).toMatchObject({
        ok: true,
        result: { todos: [{ text: "Renew passport" }, { text: "Call the plumber" }] },
      });
      const all = await remindersCommand(deps, todosPayload({ action: "export", workspaceId: "default", format: "text" }, "k"));
      const todos = (all as { result: { todos: Parameters<typeof todoChecklistLine>[0][] } }).result.todos;
      // A due time as `todos list` says it, in the to-do's zone; a due date as it is.
      const zone = (plumber as { result: { todo: { timezone: string } } }).result.todo.timezone;
      expect(todos.map(todoChecklistLine)).toEqual([
        "- [x] Buy milk (groceries)",
        "- [ ] Renew passport (inbox, due 2026-11-01)",
        `- [ ] Call the plumber (inbox, due ${formatReminderTime(new Date("2026-11-06T17:00:00.000Z"), zone)} ${zone})`,
      ]);
      expect(await remindersCommand(deps, { action: "todo-remove", todoId })).toMatchObject({ ok: true, result: { removed: true } });
      expect(await remindersCommand(deps, { action: "todo-remove", todoId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    } finally {
      await store.close();
    }
  });

  it("never changes a to-do as a reminder; its fires stay reachable", async () => {
    const { store, repositories } = await fixture();
    try {
      const deps = { repositories, principalOf: () => "operator", now: () => NOW, newId: () => "t1" };
      const added = await remindersCommand(deps, { action: "todo-add", text: "Call", due: "2026-10-02T09:00:00Z" });
      const todoId = (added as { result: { todo: { todoId: string } } }).result.todo.todoId;
      for (const action of ["cancel", "pause", "resume"] as const)
        expect(await remindersCommand(deps, { action, reminderId: todoId })).toMatchObject({
          ok: false,
          error: { code: "CONFLICT", message: expect.stringMatching(/That is a to-do/) },
        });
      expect(await remindersCommand(deps, { action: "get", reminderId: todoId })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(await remindersCommand(deps, { action: "fires", reminderId: todoId })).toMatchObject({ ok: true });
      expect(await repositories.reminders.getTodo(todoId)).toMatchObject({ status: "open", remindAt: "2026-10-02T09:00:00.000Z" });
    } finally {
      await store.close();
    }
  });

  it("tavi todos export reads every page, --principal keeps to one person, and control characters stay out", async () => {
    const directory = directories.create("tavi-todo-export-");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      let n = 0;
      const deps = {
        repositories: store.asPort().repositories,
        principalOf: () => "operator",
        now: () => NOW,
        newId: () => `p${(n += 1)}`,
      };
      for (let index = 0; index < 205; index += 1) await remindersCommand(deps, { action: "todo-add", text: `Item ${index}` });
      await remindersCommand(deps, { action: "todo-add", text: "Evil\u001b]52;c;aGk=\u0007", notes: "a\u001b[2Jb", principalId: "bob" });
    } finally {
      await store.close();
    }
    const all = capture();
    expect(await main(["todos", "export", "--format", "json", "--data-dir", directory], { io: all.io })).toBe(EXIT.ok);
    expect((JSON.parse(all.out()) as { todos: unknown[] }).todos).toHaveLength(206);
    const bob = capture();
    expect(await main(["todos", "export", "--principal", "bob", "--data-dir", directory], { io: bob.io })).toBe(EXIT.ok);
    expect(bob.out()).toContain("## inbox");
    expect(bob.out()).toContain("Evil");
    expect(bob.out()).not.toContain("Item 0");
    expect(bob.out()).not.toMatch(/\u001b|\u0007/);
    const listed = capture();
    expect(await main(["todos", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.out()).toContain("Item 204");
    // The text and its read-back first, the id last, every id starting in the same column.
    const lines = listed.out().trimEnd().split("\n");
    expect(lines[0]).toMatch(/^Item \d+ +\(open, on inbox, no due date\) +todo-/);
    expect(new Set(lines.map((line) => line.indexOf("todo-"))).size).toBe(1);
  });

  it("parses tavi todos", () => {
    expect(parseArgs(["todos", "add", "Buy milk", "--list", "groceries", "--due", "2026-10-30"])).toMatchObject({
      command: "todos",
      todos: { action: "add", text: "Buy milk", list: "groceries", due: "2026-10-30" },
    });
    expect(parseArgs(["todos", "list", "--all"])).toMatchObject({ todos: { action: "list", all: true } });
    expect(parseArgs(["todos", "list"])).not.toHaveProperty(["todos", "principalId"]);
    expect(parseArgs(["todos", "export", "--principal", "bob"])).toMatchObject({ todos: { action: "export", principalId: "bob" } });
    expect(parseArgs(["todos", "done", "todo-1"])).toMatchObject({ todos: { action: "done", todoId: "todo-1" } });
    expect(() => parseArgs(["todos", "add", "x", "--due", "Friday"])).toThrow(/--due expects/);
    expect(() => parseArgs(["todos", "done"])).toThrow(/needs a to-do id/);
  });
});

describe("tasks.home", () => {
  it("is Tavi's own list by default, or an MCP server", () => {
    expect(tasksHomeOf({})).toBe("tavi");
    expect(tasksHomeServer(tasksHomeOf({ tasksHome: "mcp:todoist" }))).toBe("todoist");
    expect(tasksHomeServer("tavi")).toBeUndefined();
    expect(WorkspaceSettingsSchema.safeParse({ tasksHome: "mcp:Todoist" }).success).toBe(false);
    expect(WorkspaceSettingsSchema.safeParse({ tasksHome: "todoist" }).success).toBe(false);
  });
});
