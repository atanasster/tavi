import { trustedLabel, untrustedLabel, type ContentLabel, type ModelPort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitForValue, delay } from "@tavi/test-support";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { remindersCommand } from "../../src/features/reminders/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions, askingForMemoryProposals } from "../support/serve-fixture.js";

/**
 * Reminders in a composed owner: a prompt starts a task of its own
 * origin that asks for its tools, the buttons work without a model, the allow
 * rule is seeded once per workspace and never after a revoke, and a routine
 * can be created on triggers.
 */

const directories = temporaryDirectories({ prefix: "tavi-reminder-owner-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

async function compose(
  dataDirectory: string,
  turns: readonly ScriptedTurn[] = [],
  extra: Partial<TaviRuntimeOptions> = {},
  model: ModelPort = createFixtureModel({ turns }),
): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(dataDirectory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: ["mutating", "external"],
      reminderSweepEnabled: true,
      reminderSweepIntervalMs: 25,
      ...extra,
    }),
    { modelOverride: model },
  );
  // A memory proposal is these tests' asked call: its seeded allow rule is revoked.
  await askingForMemoryProposals(runtime);
  runtimes.push(runtime);
  return runtime;
}

describe("a reminder with a prompt", () => {
  it("starts a task with origin reminder that asks for its tools, and records it on the fire", async () => {
    const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the train leaves at 9" } } } as const;
    const runtime = await compose(directories.create(), [propose]);
    const repositories = runtime.store.asPort().repositories;
    const at = new Date(Date.now() + 1_000).toISOString();
    const { reminder } = await repositories.reminders.create({
      reminderId: "rem-train",
      workspaceId: "default",
      principalId: "alice",
      text: "Check the train",
      prompt: "Check the Frankfurt connection",
      when: { kind: "once", at },
      timezone: "UTC",
      deliverTo: { kind: "app" },
      createdBy: "user",
      operationKey: "train",
      now: nowTimestamp(),
    });
    const fire = await waitForValue(async () =>
      (await repositories.reminders.fires({ workspaceId: "default", reminderId: reminder.reminderId, limit: 5 })).find(
        (entry) => entry.taskId !== undefined && entry.outcome !== "pending",
      ),
    );
    expect(fire).toMatchObject({ outcome: "delivered-in-app" });
    const taskId = fire.taskId ?? "";
    const task = await repositories.tasks.get(taskId);
    expect(task).toMatchObject({
      origin: "reminder",
      originScheduleId: null,
      chatKind: "run",
      principalId: "alice",
      executionPolicy: { mode: "attended" },
    });
    // Nothing is pre-approved: its mutating call waits for a person.
    const approval = await waitForValue(async () =>
      (await repositories.approvals.listForTask(taskId)).find((row) => row.state === "pending"),
    );
    expect(approval).toMatchObject({ toolId: "memory.propose" });
    expect(await repositories.toolPolicy.listSessionGrants(taskId)).toEqual([]);
  });
});

describe("a reminder's creation label", () => {
  it("starts the task of a reminder made under taint with that label, and a clean one's clean", async () => {
    const runtime = await compose(directories.create());
    const repositories = runtime.store.asPort().repositories;
    const now = nowTimestamp();
    const page = untrustedLabel("web", { principal: "host:sale.example", ref: { ref: "call-1", host: "sale.example", at: now } });
    const at = new Date(Date.now() + 800).toISOString();
    const make = (reminderId: string, label?: ContentLabel) =>
      repositories.reminders.create({
        reminderId,
        workspaceId: "default",
        principalId: "alice",
        text: `Check ${reminderId}`,
        prompt: `Look at ${reminderId}`,
        when: { kind: "once", at },
        timezone: "UTC",
        deliverTo: { kind: "app" },
        createdBy: "agent",
        operationKey: reminderId,
        now,
        ...(label === undefined ? {} : { label }),
      });
    await make("rem-tainted", page);
    await make("rem-clean");
    // Made from a chat that read private data, though trusted.
    await make("rem-personal", trustedLabel("personal"));
    const labelOf = async (reminderId: string): Promise<ContentLabel> => {
      const fire = await waitForValue(async () =>
        (await repositories.reminders.fires({ workspaceId: "default", reminderId, limit: 5 })).find((entry) => entry.taskId !== undefined),
      );
      const task = await waitForValue(async () => repositories.tasks.get(fire.taskId ?? ""));
      return waitForValue(async () => runtime.workflow?.checkpoints.contextLabel?.(task.threadId));
    };
    const tainted = await labelOf("rem-tainted");
    expect(tainted.integrity).toBe("untrusted");
    expect(tainted.sources).toContain("web");
    expect(tainted.refs.map((ref) => ref.host)).toContain("sale.example");
    expect((await labelOf("rem-clean")).integrity).toBe("trusted");
    expect(await labelOf("rem-personal")).toMatchObject({ integrity: "trusted", confidentiality: "personal" });
  });
});

describe("the operator's copy of a reminder", () => {
  it("keeps the label of the reminder it copies, and refuses one of another workspace or person", async () => {
    const runtime = await compose(directories.create(), [], { reminderSweepEnabled: false });
    const repositories = runtime.store.asPort().repositories;
    const now = nowTimestamp();
    const page = untrustedLabel("web", { principal: "host:sale.example", ref: { ref: "call-1", host: "sale.example", at: now } });
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const make = (reminderId: string, workspaceId: string, principalId: string) =>
      repositories.reminders.create({
        reminderId,
        workspaceId,
        principalId,
        text: `Check ${reminderId}`,
        prompt: `Look at ${reminderId}`,
        when: { kind: "once", at },
        timezone: "UTC",
        deliverTo: { kind: "app" },
        createdBy: "agent",
        operationKey: reminderId,
        label: page,
        now,
      });
    await make("rem-tainted", "default", "alice");
    await make("rem-elsewhere", "other", "alice");
    await make("rem-bob", "default", "bob");
    const deps = { repositories, principalOf: () => "alice", now: () => new Date() };
    const copy = (copyOf: string, principalId?: string) =>
      remindersCommand(deps, {
        action: "create",
        text: "Check again",
        prompt: "Look again",
        when: { kind: "once", at },
        copyOf,
        ...(principalId === undefined ? {} : { principalId }),
      });

    const copied = await copy("rem-tainted");
    expect(copied).toMatchObject({ ok: true, result: { reminder: { createdBy: "user", label: { integrity: "untrusted" } } } });
    expect(await copy("rem-elsewhere")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await copy("rem-missing")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await copy("rem-bob")).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await copy("rem-bob", "bob")).toMatchObject({
      ok: true,
      result: { reminder: { principalId: "bob", label: { integrity: "untrusted" } } },
    });
  });
});

describe("the messaging profile for a reminder's task", () => {
  it("holds the shell and file writes back from a reminder's task that answers in a chat, as from any chat-started task", async () => {
    const workspace = directories.create();
    const offered = new Map<string, readonly string[]>();
    const model: ModelPort = {
      async stream(request, options) {
        offered.set(
          options.context?.runId ?? "",
          request.tools.map((tool) => tool.id),
        );
        return { attemptId: request.attemptId, status: "completed", text: "Done", toolCalls: [], usage: {} };
      },
    };
    const runtime = await compose(workspace, [], { fsRoots: [workspace] }, model);
    const repositories = runtime.store.asPort().repositories;
    const chat = await runtime.workflow?.admit({
      context: { workspaceId: "default", principalId: "alice", runId: "pending", caller: "test" },
      kind: "start",
      operationKey: "chat",
      prompt: "hi",
      origin: "messaging",
    });
    await repositories.messagingConversations.record({
      connectionId: "telegram-main",
      externalConversationId: "chat-1",
      taskId: chat?.taskId ?? "",
      createdAt: nowTimestamp(),
      replyTo: { connectionId: "telegram-main", externalConversationId: "chat-1", externalSenderId: "user-1" },
    });
    const remind = async (
      reminderId: string,
      deliverTo: { kind: "app" } | { kind: "conversation"; connectionId: string; conversationId: string },
    ) => {
      await repositories.reminders.create({
        reminderId,
        workspaceId: "default",
        principalId: "alice",
        text: "Check",
        prompt: "Check the build",
        when: { kind: "once", at: new Date(Date.now() + 800).toISOString() },
        timezone: "UTC",
        deliverTo,
        originTaskId: chat?.taskId ?? "",
        createdBy: "agent",
        operationKey: reminderId,
        now: nowTimestamp(),
      });
      const fire = await waitForValue(async () =>
        (await repositories.reminders.fires({ workspaceId: "default", reminderId, limit: 5 })).find((entry) => entry.taskId !== undefined),
      );
      return waitForValue(async () => offered.get(fire.taskId ?? ""));
    };
    const inChat = await remind("rem-chat", { kind: "conversation", connectionId: "telegram-main", conversationId: "chat-1" });
    expect(offered.get(chat?.taskId ?? "")).not.toContain("fs.write");
    expect(inChat).not.toContain("fs.write");
    expect(inChat).not.toContain("fs.edit");
    // A reminder asked in the app runs as the app's own tasks do.
    expect(await remind("rem-app", { kind: "app" })).toContain("fs.write");
  });
});

describe("a reminder's buttons on an owner without a model", () => {
  it("act on a press as it arrives, and a replayed press is not refused as closed admission", async () => {
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directories.create(), {
        workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      }),
      { requireModelTransport: false },
    );
    runtimes.push(runtime);
    expect(runtime.workflow).toBeUndefined();
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "telegram-main",
      externalSenderId: "user-1",
      workspaceId: "default",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: nowTimestamp(),
    });
    const remind = async (reminderId: string) => {
      const at = new Date(Date.now() + 50).toISOString();
      await repositories.reminders.create({
        reminderId,
        workspaceId: "default",
        principalId: "alice",
        text: "Take your pills",
        when: { kind: "once", at },
        timezone: "UTC",
        deliverTo: { kind: "conversation", connectionId: "telegram-main", conversationId: "chat-1" },
        createdBy: "user",
        operationKey: reminderId,
        now: nowTimestamp(),
      });
      await delay(80);
      const [claimed] = (await repositories.reminders.claimDue({ now: nowTimestamp(), limit: 5 })).claimed;
      await repositories.reminders.recordOutcome({
        reminderId,
        fireAt: claimed?.fire.fireAt ?? "",
        outcome: "delivered",
        now: nowTimestamp(),
      });
      return claimed?.fire.token ?? "";
    };
    const press = (id: string, token: string) => ({
      connectionId: "telegram-main",
      providerEventId: id,
      kind: "interaction",
      externalSenderId: "user-1",
      externalConversationId: "chat-1",
      occurredAt: nowTimestamp(),
      receivedAt: nowTimestamp(),
      interaction: { data: `m:${token}:d`, messageId: "m-1" },
    });
    const acknowledged = async (reminderId: string) =>
      (await repositories.reminders.fires({ workspaceId: "default", reminderId, limit: 5 }))[0]?.acknowledgedAt;

    await runtime.messaging.ingest(press("press-1", await remind("rem-pills")));
    expect(await acknowledged("rem-pills")).toBeDefined();

    // A press held while the sender was unbound is acted on when replayed.
    await repositories.messagingIdentityBindings.unbind("telegram-main", "user-1");
    await runtime.messaging.ingest(press("press-2", await remind("rem-water")));
    expect(await acknowledged("rem-water")).toBeUndefined();
    await repositories.messagingIdentityBindings.bind({
      connectionId: "telegram-main",
      externalSenderId: "user-1",
      workspaceId: "default",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: nowTimestamp(),
    });
    expect(await runtime.messaging.replay({ connectionId: "telegram-main", providerEventId: "press-2" })).toMatchObject({
      outcome: "admitted",
    });
    expect(await acknowledged("rem-water")).toBeDefined();
  });
});

describe("the seeded allow rule", () => {
  it("is seeded into a new workspace, and not again once the operator revoked it", async () => {
    const path = directories.create();
    const first = await compose(path);
    const policy = first.store.asPort().repositories.toolPolicy;
    expect(await policy.getRule("default", "seeded-reminders")).toMatchObject({
      toolPattern: "reminders.*",
      decision: "allow",
      source: "operator",
    });
    expect(await policy.deleteRule("default", "seeded-reminders")).toBe(true);
    await runtimes.pop()?.close();

    const second = await compose(path);
    expect(await second.store.asPort().repositories.toolPolicy.getRule("default", "seeded-reminders")).toBeUndefined();
  });

  it("is seeded by a runtime that does not fire reminders too, since its tools are offered there", async () => {
    const runtime = await compose(directories.create(), [], { reminderSweepEnabled: false });
    expect(await runtime.store.asPort().repositories.toolPolicy.getRule("default", "seeded-reminders")).toMatchObject({
      toolPattern: "reminders.*",
      decision: "allow",
    });
  });
});

describe("routines.create with triggers", () => {
  it("arms the triggers it is given, and a daily trigger at `at` beside them", async () => {
    const runtime = await compose(directories.create());
    const scope = { workspaceId: "default", principalId: "alice" };
    const create = (operationKey: string, setup: Record<string, unknown>) =>
      runtime.routineControl.execute({
        action: "create",
        ...scope,
        operationKey,
        setup: { name: `News ${operationKey}`, objective: "Find news", timezone: "Europe/Berlin", ...setup },
      });
    await create("weekdays", {
      triggers: [
        { id: "weekdays", kind: "daily", at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] },
        { id: "friday", kind: "once", runAt: "2027-01-08T16:00:00.000Z" },
      ],
    });
    await create("both", { at: "18:00", triggers: [{ id: "friday", kind: "once", runAt: "2027-01-08T16:00:00.000Z" }] });
    await create("plain", {});
    const triggers = async (name: string) => {
      const routine = (await runtime.routines.list(scope)).find((entry) => entry.name === name);
      return (await runtime.routines.get(scope, routine?.routineId ?? "")).revision.snapshot.triggers;
    };
    expect(await triggers("News weekdays")).toEqual([
      { id: "weekdays", kind: "daily", at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] },
      { id: "friday", kind: "once", runAt: "2027-01-08T16:00:00.000Z" },
    ]);
    expect(await triggers("News both")).toEqual([
      { id: "morning", kind: "daily", at: "18:00", timezone: "Europe/Berlin" },
      { id: "friday", kind: "once", runAt: "2027-01-08T16:00:00.000Z" },
    ]);
    expect(await triggers("News plain")).toEqual([{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Berlin" }]);
    // Refused in words, not as a schema error, when `at` would make an eleventh trigger.
    const eleven = Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, kind: "once", runAt: "2027-01-08T16:00:00.000Z" }));
    await expect(Promise.resolve().then(() => create("eleven", { at: "18:00", triggers: eleven }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("at most 10 triggers"),
    });
  });
});
