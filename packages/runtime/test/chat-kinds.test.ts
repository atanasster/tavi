import { join } from "node:path";

import { HOME_CHAT_INDEX, TaviError, type ChatKind } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../src/persistence/store.js";
import { queryTaskList } from "../src/persistence/task-list.js";

const AT = "2026-10-04T00:00:00.000Z";
const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function fixture(): SqliteStore {
  const directory = directories.create("tavi-chat-kinds-");
  return new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

const admit = (
  store: SqliteStore,
  taskId: string,
  extra: { readonly chatKind?: ChatKind; readonly parentChatId?: string; readonly principalId?: string } = {},
) =>
  store.asPort().repositories.tasks.admit({
    workspaceId: "w1",
    principalId: extra.principalId ?? "alice",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: { prompt: `prompt of ${taskId}` },
    checkpointNamespace: "",
    newTaskId: () => taskId,
    newAdmissionId: () => `adm-${taskId}`,
    newThreadId: () => `thread-${taskId}`,
    now: () => AT,
    ...(extra.chatKind === undefined ? {} : { chatKind: extra.chatKind }),
    ...(extra.parentChatId === undefined ? {} : { parentChatId: extra.parentChatId }),
  });

describe("chat kinds", () => {
  it("records a new task's kind and parent, and one Home per person", () => {
    const store = fixture();
    const tasks = store.asPort().repositories.tasks;
    admit(store, "home-1", { chatKind: "home" });
    admit(store, "side-1", { chatKind: "side", parentChatId: "home-1" });
    admit(store, "plain-1");
    expect(tasks.get("home-1")).toMatchObject({ chatKind: "home", title: "Home" });
    expect(tasks.get("side-1")).toMatchObject({ chatKind: "side", parentChatId: "home-1" });
    expect(tasks.get("plain-1")?.chatKind).toBeUndefined();
    expect(() => admit(store, "home-2", { chatKind: "home" })).toThrow();
    // A typed conflict naming the index, never SQLite's message.
    let refused: unknown;
    try {
      admit(store, "home-2", { chatKind: "home" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(TaviError);
    expect(refused).toMatchObject({ code: "CONFLICT", details: { index: HOME_CHAT_INDEX } });
    expect(tasks.get("home-2")).toBeUndefined();
    // A retried first message, under its own key, is the Home it made — never a conflict.
    expect(admit(store, "home-1", { chatKind: "home" })).toMatchObject({ created: false, task: { taskId: "home-1" } });
    // Another person has a Home of their own.
    expect(() => admit(store, "home-3", { chatKind: "home", principalId: "bob" })).not.toThrow();
  });

  it("lists by kind and parent, a Home under its own name", () => {
    const store = fixture();
    admit(store, "home-1", { chatKind: "home" });
    admit(store, "side-1", { chatKind: "side", parentChatId: "home-1" });
    admit(store, "plain-1");
    const list = (filters: Parameters<typeof queryTaskList>[1]) => queryTaskList(store.handle, { workspaceId: "w1", ...filters }).rows;
    expect(list({ chatKinds: ["home"] }).map((row) => [row.taskId, row.title, row.titleSource])).toEqual([["home-1", "Home", "home"]]);
    expect(list({ chatKinds: ["chat"] }).map((row) => row.taskId)).toEqual(["plain-1"]);
    expect(list({ parentChatId: "home-1" }).map((row) => [row.taskId, row.chatKind, row.parentChatId])).toEqual([
      ["side-1", "side", "home-1"],
    ]);
  });

  it("says a Home between turns is idle, never completed or failed", () => {
    const store = fixture();
    const tasks = store.asPort().repositories.tasks;
    admit(store, "home-1", { chatKind: "home" });
    admit(store, "plain-1");
    const status = (taskId: string, filters: Parameters<typeof queryTaskList>[1] = {}) =>
      queryTaskList(store.handle, { workspaceId: "w1", ...filters }).rows.find((row) => row.taskId === taskId)?.status;
    tasks.updateStatus("home-1", "running", null);
    expect(status("home-1")).toBe("working");
    tasks.updateStatus("home-1", "waiting", null);
    expect(status("home-1")).toBe("input-required");
    tasks.updateStatus("home-1", "completed", "done");
    tasks.updateStatus("plain-1", "completed", "done");
    expect(status("home-1")).toBe("idle");
    expect(status("plain-1")).toBe("completed");
    tasks.updateStatus("home-1", "failed", null);
    expect(status("home-1")).toBe("idle");
    // `status:` filters read the same word.
    expect(queryTaskList(store.handle, { workspaceId: "w1", status: ["idle"] }).rows.map((row) => row.taskId)).toEqual(["home-1"]);
    expect(queryTaskList(store.handle, { workspaceId: "w1", status: ["completed"] }).rows.map((row) => row.taskId)).toEqual(["plain-1"]);
  });

  it("lists a Home first by last touch, however many chats were touched since, and once across pages", () => {
    const store = fixture();
    admit(store, "home-1", { chatKind: "home" });
    admit(store, "home-2", { chatKind: "home", principalId: "bob" });
    for (let index = 0; index < 5; index += 1) admit(store, `chat-${index}`);
    // Every chat touched after the Homes.
    store.handle
      .prepare(
        "UPDATE tavi_tasks SET updated_at = '2026-10-04T01:00:00.000Z', created_at = '2026-10-04T01:00:00.000Z' WHERE chat_kind IS NULL",
      )
      .run();
    store.handle.prepare("UPDATE tavi_tasks SET updated_at = '2026-10-04T00:30:00.000Z' WHERE task_id = 'home-2'").run();
    const first = queryTaskList(store.handle, { workspaceId: "w1", limit: 3 });
    expect(first.rows.map((row) => row.taskId)).toEqual(["home-2", "home-1", "chat-4"]);
    const seen = first.rows.map((row) => row.taskId);
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const next = queryTaskList(store.handle, { workspaceId: "w1", limit: 3, cursor });
      seen.push(...next.rows.map((row) => row.taskId));
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(["home-2", "home-1", "chat-4", "chat-3", "chat-2", "chat-1", "chat-0"]);
    // A page of Homes alone: the next one starts at the newest chat.
    const homes = queryTaskList(store.handle, { workspaceId: "w1", limit: 2 });
    expect(homes.rows.map((row) => row.taskId)).toEqual(["home-2", "home-1"]);
    expect(queryTaskList(store.handle, { workspaceId: "w1", limit: 2, cursor: homes.nextCursor }).rows.map((row) => row.taskId)).toEqual([
      "chat-4",
      "chat-3",
    ]);
    // More Homes than a page holds: every row once, in order.
    const walk = (filters: Parameters<typeof queryTaskList>[1]) => {
      const listed: string[] = [];
      let next: string | undefined;
      do {
        const page = queryTaskList(store.handle, { workspaceId: "w1", ...filters, ...(next === undefined ? {} : { cursor: next }) });
        listed.push(...page.rows.map((row) => row.taskId));
        next = page.nextCursor;
      } while (next !== undefined);
      return listed;
    };
    expect(walk({ limit: 1 })).toEqual(["home-2", "home-1", "chat-4", "chat-3", "chat-2", "chat-1", "chat-0"]);
    expect(walk({ limit: 2 })).toEqual(["home-2", "home-1", "chat-4", "chat-3", "chat-2", "chat-1", "chat-0"]);
    expect(walk({ chatKinds: ["home"], limit: 1 })).toEqual(["home-2", "home-1"]);
    // One person's list: their Home first. By creation day, no Home goes first.
    expect(queryTaskList(store.handle, { workspaceId: "w1", principalId: "alice", limit: 2 }).rows.map((row) => row.taskId)).toEqual([
      "home-1",
      "chat-4",
    ]);
    expect(queryTaskList(store.handle, { workspaceId: "w1", order: "created", limit: 2 }).rows.map((row) => row.taskId)).not.toContain(
      "home-1",
    );
  });

  it("queues no summary for a Home turn, as it does for any other chat's", () => {
    const store = fixture();
    admit(store, "home-1", { chatKind: "home" });
    admit(store, "plain-1");
    const state = (taskId: string) =>
      (store.handle.prepare("SELECT summary_state FROM tavi_tasks WHERE task_id = ?").get(taskId) as { summary_state: string | null })
        .summary_state;
    expect(state("home-1")).toBeNull();
    expect(state("plain-1")).toBe("pending");
    store.asPort().repositories.tasks.updateStatus("home-1", "completed", "done");
    expect(state("home-1")).toBeNull();
  });

  it("refuses a parent on anything but a side chat, and a side chat with none", () => {
    const store = fixture();
    expect(() => admit(store, "x-1", { parentChatId: "p" })).toThrow(/only valid when chatKind is "side"/);
    expect(() => admit(store, "x-2", { chatKind: "side" })).toThrow(/needs the parentChatId/);
  });

  it("counts a day's turns — a start, and each reply with a prompt — not a worker's wake", () => {
    const store = fixture();
    const tasks = store.asPort().repositories.tasks;
    admit(store, "home-1", { chatKind: "home" });
    const reply = (key: string, prompt: string | undefined) =>
      tasks.admit({
        workspaceId: "w1",
        principalId: "alice",
        taskId: "home-1",
        operationKey: key,
        kind: "reply",
        intent: prompt === undefined ? {} : { prompt },
        checkpointNamespace: "",
        newTaskId: () => "unused",
        newAdmissionId: () => `adm-${key}`,
        newThreadId: () => "unused",
        now: () => AT,
      });
    reply("r1", "again");
    reply("r2", undefined);
    const summary = store
      .asPort()
      .repositories.center.summary({ workspaceId: "w1", principalId: "alice", timezone: "UTC", days: 1, now: AT });
    expect(summary.perDay.at(-1)).toEqual({ date: "2026-10-04", tasks: 2 });
  });
});
