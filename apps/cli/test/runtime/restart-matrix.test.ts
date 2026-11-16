import type { InboundEvent, ModelPort, ModelRequest, ReplyResult, RunResult, TranscriptPage } from "@tavi/contracts";
import { createFixtureMessagingConnectorDefinition } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions, fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Restart matrix: the owner is
 * stopped at each seam a chat's state crosses, then started again over the
 * same data directory, and what the chat reads and does next is checked —
 * exactly once, no orphaned waits, no turn missing from the chat's history.
 *
 * The first seam of the plan's list, "worker done / envelope undelivered", is
 * `agent-worker-results.test.ts` ("announces at start a worker's result that a
 * restart lost, and wakes its parent to read it").
 */

const directories = temporaryDirectories({ prefix: "tavi-restart-matrix-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

// ---------------------------------------------------------------------------
// A served owner (the IPC front ends' path), stopped and started again.

interface Owner {
  readonly handle: ServeHandle;
  readonly client: IpcClient;
}

async function startOwner(directory: string, model: ModelPort): Promise<Owner> {
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "fixture-conn" }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quietIo,
    { modelOverride: model },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client };
}

/** Stop the owner as a restart does: its client goes, then the owner shuts down. */
async function stopOwner(owner: Owner): Promise<void> {
  owner.client.close();
  clients.splice(clients.indexOf(owner.client), 1);
  handles.splice(handles.indexOf(owner.handle), 1);
  await owner.handle.shutdown("restart matrix: the owner stops");
}

const repositoriesOf = (owner: Owner) => owner.handle.runtime.store.asPort().repositories;

async function runChat(
  client: IpcClient,
  prompt: string,
  operationKey: string,
  approval: "approve" | "client" = "approve",
): Promise<string> {
  const started = await client.request(
    "run",
    { prompt, workspaceId: "default", principal: "operator", operationKey, approval },
    `run-${operationKey}`,
    { timeoutMs: 15_000 },
  );
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  return (started.result as RunResult).taskId;
}

const reply = (client: IpcClient, taskId: string, text: string, clientMessageId: string, intent?: "steer" | "queue") =>
  client.request(
    "reply",
    { workspaceId: "default", taskId, text, clientMessageId, ...(intent === undefined ? {} : { intent }) },
    `reply-${clientMessageId}-${Math.random()}`,
    { timeoutMs: 15_000 },
  );

const settledAdmissions = async (owner: Owner, taskId: string) =>
  (await repositoriesOf(owner).tasks.listAdmissions(taskId)).filter((admission) => admission.result !== null);

const userTexts = (request: ModelRequest | undefined): string[] =>
  (request?.messages ?? []).filter((message) => message.role === "user").map((message) => message.text);
/** How many times `text` opens a user message of `request`: a message delivered once is there once. */
const timesSaid = (request: ModelRequest | undefined, text: string): number =>
  userTexts(request).filter((said) => said.startsWith(text)).length;

/** A fixture model whose `held`-th call (from 1) waits until `release` is called. */
function gatedModel(
  turns: readonly ScriptedTurn[],
  held: number,
): { model: ModelPort; calls: ModelRequest[]; release: () => void; reached: () => boolean } {
  const fixture = createFixtureModel({ turns });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  return {
    calls: fixture.calls,
    release: () => release(),
    reached: () => reached,
    model: {
      ...fixture,
      async stream(request, options) {
        if (fixture.calls.length + 1 === held) {
          reached = true;
          await gate;
        }
        return fixture.stream(request, options);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A composed owner with a messaging connection (the channels' path).

async function composeOwner(directory: string, model: ModelPort): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
    }),
    { modelOverride: model },
  );
  runtimes.push(runtime);
  runtime.messaging.registerConnector({
    ...createFixtureMessagingConnectorDefinition({ sendOutcome: () => ({ status: "accepted", retryable: false, parts: [] }) }),
    destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
  });
  await runtime.messaging.openConnection({
    connection: {
      connectionId: "conn-a",
      providerId: "fixture",
      accountIdentity: "acct-a",
      workspaceId: "default",
      configRevision: 1,
      enabled: true,
    },
    config: {},
  });
  return runtime;
}

async function closeOwner(runtime: TaviRuntime): Promise<void> {
  runtimes.splice(runtimes.indexOf(runtime), 1);
  await runtime.close();
}

async function bindAlice(runtime: TaviRuntime): Promise<void> {
  await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
    connectionId: "conn-a",
    externalSenderId: "user-1",
    workspaceId: "default",
    principalId: "alice",
    approvedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function inbound(overrides: Partial<InboundEvent>): InboundEvent {
  return {
    connectionId: "conn-a",
    providerEventId: "evt-1",
    kind: "message",
    externalSenderId: "user-1",
    externalConversationId: "chat-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: "hi there",
    ...overrides,
  };
}

/** The conversation's tasks, by the start key each epoch's first message is admitted under. */
const conversationTasks = async (runtime: TaviRuntime) => {
  const tasks = runtime.store.asPort().repositories.tasks;
  return {
    epoch0: await tasks.getByOperationKey("default", "alice", "msg-start-conn-a-chat-1"),
    epoch1: await tasks.getByOperationKey("default", "alice", "msg-start-conn-a-chat-1-e1"),
    epoch2: await tasks.getByOperationKey("default", "alice", "msg-start-conn-a-chat-1-e2"),
  };
};

describe("Restart matrix", () => {
  it("(a) a turn ended but not saved: after a restart the chat's history has it again, recovered from its admission, in order, and the chat goes on", async () => {
    const directory = directories.create();
    const model = createFixtureModel({ turns: [{ text: "answer one" }, { text: "answer two" }, { text: "answer three" }] });
    const first = await startOwner(directory, model);
    const taskId = await runChat(first.client, "first question", "op-a");
    await waitFor(async () => (await repositoriesOf(first).transcripts.page(taskId, { limit: 10 })).entries.length === 1);

    // The second turn ends, and the owner stops before its transcript entry is
    // appended: the append is the last thing an admission does, after
    // its result and checkpoint are written.
    const append = vi
      .spyOn(first.handle.runtime.store.repositories.transcripts, "append")
      .mockRejectedValueOnce(new Error("owner stopped before the turn was saved"));
    expect((await reply(first.client, taskId, "second question", "m-2")).ok).toBe(true);
    await waitFor(async () => (await settledAdmissions(first, taskId)).length === 2);
    await waitFor(() => append.mock.calls.length === 1);
    append.mockRestore();
    await stopOwner(first);

    const second = await startOwner(directory, model);
    // Serve start saved the lost turn from its admission row (`transcripts.reconcile`):
    // its prompt and answer, no tool cards, marked truncated — and in its place.
    const page = await second.client.request("tasks", { action: "transcript", taskId, workspaceId: "default" }, "transcript-1");
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    const recovered = (page.result as TranscriptPage).entries;
    expect(recovered.map((entry) => entry.turn.prompt)).toEqual(["first question", "second question"]);
    expect(recovered[1]!.turn).toEqual({
      admissionKind: "reply",
      prompt: "second question",
      items: [],
      truncated: true,
      outcome: { status: "completed", finalText: "answer two" },
    });
    const admissions = await settledAdmissions(second, taskId);
    expect(admissions.map((admission) => admission.kind)).toEqual(["start", "reply"]);
    expect(recovered[1]!.admissionId).toBe(admissions[1]!.admissionId);
    // Idempotent: a second reconcile saves nothing again.
    expect(await repositoriesOf(second).transcripts.reconcile(taskId)).toBe(0);

    // The next turn works, and its model call reads the lost turn from the checkpoint.
    expect((await reply(second.client, taskId, "third question", "m-3")).ok).toBe(true);
    await waitFor(async () => (await repositoriesOf(second).transcripts.page(taskId, { limit: 10 })).entries.length === 3);
    const last = model.calls.at(-1);
    expect(timesSaid(last, "second question")).toBe(1);
    expect(last?.messages.some((message) => message.role === "assistant" && message.text.includes("answer two"))).toBe(true);
    const after = (await repositoriesOf(second).transcripts.page(taskId, { limit: 10 })).entries;
    // No gap: the three turns in the order they were asked.
    expect(after.map((entry) => entry.turn.prompt)).toEqual(["first question", "second question", "third question"]);
    expect(after[0]!.seq).toBeLessThan(after[1]!.seq);
    expect(after[1]!.seq).toBeLessThan(after[2]!.seq);
    expect(after.map((entry) => entry.turn.outcome.status)).toEqual(["completed", "completed", "completed"]);
    expect(after[2]!.turn.truncated).toBeUndefined();
  });

  it("(b) a messaging /new half-settled (epoch ended, waits not withdrawn): the next start finishes the withdrawal, and the next message starts the next epoch", async () => {
    const directory = directories.create();
    const model = createFixtureModel({
      turns: [{ toolCall: { id: "ask-1", name: "operator.ask_user", input: { question: "Which one?" } } }],
    });
    const first = await composeOwner(directory, model);
    await bindAlice(first);
    await first.messaging.ingest(inbound({ providerEventId: "evt-1", content: "pick for me" }));
    const repositories = first.store.asPort().repositories;
    const oldTaskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const wait = await repositories.agentWaits.getActiveByTask(oldTaskId);
    expect(wait).toBeDefined();

    // `/new` ends the epoch first, then withdraws: the owner stops in between.
    vi.spyOn(first.store.repositories.agentWaits, "settle").mockRejectedValueOnce(new Error("owner stopped mid-reset"));
    await expect(first.messaging.ingest(inbound({ providerEventId: "evt-2", content: "/new" }))).rejects.toThrow("owner stopped mid-reset");
    expect(await repositories.messagingConversations.get("conn-a", "chat-1")).toBeUndefined();
    // The ended epoch is recorded as not withdrawn yet.
    expect((await repositories.messagingConversations.listUnwithdrawn()).map((ended) => [ended.taskId, ended.epoch])).toEqual([
      [oldTaskId, 0],
    ]);
    vi.restoreAllMocks();
    await closeOwner(first);

    const second = await composeOwner(directory, model);
    const after = second.store.asPort().repositories;
    // Recovered at start: the old task's question is withdrawn, the task cancelled, and the epoch marked.
    expect((await after.agentWaits.get(wait?.waitId ?? ""))?.state).toBe("settled");
    expect((await after.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "cancelled",
      error: { code: "CONVERSATION_RESET" },
    });
    expect((await after.tasks.get(oldTaskId))?.status).toBe("cancelled");
    expect(await after.messagingConversations.listUnwithdrawn()).toEqual([]);
    await second.messaging.ingest(inbound({ providerEventId: "evt-3", content: "start over" }));
    // Recovered: the next message is the next epoch's task, a new one.
    const current = await after.messagingConversations.get("conn-a", "chat-1");
    expect(current?.epoch).toBe(1);
    expect(current?.taskId).not.toBe(oldTaskId);
    expect((await conversationTasks(second)).epoch1?.taskId).toBe(current?.taskId);
    // A task of its own, which ran its first turn (the scripted model answers a new task's first step again).
    expect(
      (await after.tasks.listAdmissions(current?.taskId ?? "")).map((admission) => [
        admission.kind,
        (admission.intent as { readonly prompt?: string }).prompt,
        admission.result !== null,
      ]),
    ).toEqual([["start", "start over", true]]);
    // A `/new` that finishes records its withdrawal at once: nothing is left for a start to redo.
    await second.messaging.ingest(inbound({ providerEventId: "evt-4", content: "/new" }));
    expect(await after.messagingConversations.listUnwithdrawn()).toEqual([]);
  });

  it("(c) a reply behind an approval round across a restart: refused before and after, then delivered once after the decision; a steer recorded before the round is taken once by the resumed turn", async () => {
    const directory = directories.create();
    const gated = gatedModel(
      [
        { toolCall: { id: "c-get", name: "memory.get", input: { recordId: "nothing-here" } } },
        { text: "looked it up" },
        { text: "and then that" },
      ],
      1,
    );
    const first = await startOwner(directory, gated.model);
    await repositoriesOf(first).toolPolicy.putRule({
      ruleId: "ask-memory",
      workspaceId: "default",
      toolPattern: "memory.get",
      decision: "ask",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const taskId = await runChat(first.client, "look it up", "op-c", "client");
    await waitFor(() => gated.reached());
    // A steer into the running turn, before it reaches the round.
    expect(((await reply(first.client, taskId, "only the newest", "steer-c", "steer")).result as ReplyResult).steered).toBe(true);
    gated.release();
    await waitFor(async () => (await settledAdmissions(first, taskId)).some((admission) => admission.result?.status === "waiting"));
    // A reply while the round waits is refused: the page queues it.
    const refused = await reply(first.client, taskId, "and then this", "q-c");
    expect(refused.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("approval round") });
    await stopOwner(first);

    const second = await startOwner(directory, gated.model);
    const repositories = repositoriesOf(second);
    // Across the restart: still refused, nothing admitted, the steer still held.
    expect((await reply(second.client, taskId, "and then this", "q-c")).error).toMatchObject({ code: "CONFLICT" });
    expect(await repositories.tasks.listAdmissions(taskId)).toHaveLength(1);
    expect((await repositories.transcripts.steerOf(taskId, "steer-c"))?.state).toBe("pending");

    const approved = await second.client.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" },
      "approve-c",
      { timeoutMs: 15_000 },
    );
    expect(approved.ok, JSON.stringify(approved.error)).toBe(true);
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    await waitFor(async () => (await repositories.transcripts.steerOf(taskId, "steer-c"))?.state === "consumed");
    expect(timesSaid(gated.calls.at(-1), "only the newest")).toBe(1);

    // The page sends its queued reply once the decision is made: delivered once, a resend a duplicate.
    const sent = await reply(second.client, taskId, "and then this", "q-c");
    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    expect((sent.result as ReplyResult).duplicate).toBe(false);
    await waitFor(async () => (await settledAdmissions(second, taskId)).filter((admission) => admission.kind === "reply").length === 1);
    expect(((await reply(second.client, taskId, "and then this", "q-c")).result as ReplyResult).duplicate).toBe(true);
    await delay(100);
    expect((await repositories.tasks.listAdmissions(taskId)).filter((admission) => admission.kind === "reply")).toHaveLength(1);
    expect(timesSaid(gated.calls.at(-1), "and then this")).toBe(1);
  });

  describe("(d) a steer left claimed across a restart", () => {
    /** A finished chat with a steer claimed by its (ended) turn, as an owner that stopped before settling it leaves it. */
    async function orphanedSteer(directory: string, model: ModelPort): Promise<{ readonly taskId: string }> {
      const first = await startOwner(directory, model);
      const taskId = await runChat(first.client, "how far is it?", "op-d");
      const repositories = repositoriesOf(first);
      await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
      const admissionId = (await repositories.tasks.listAdmissions(taskId))[0]!.admissionId;
      await repositories.transcripts.recordSteer({
        steerId: "steer-d",
        taskId,
        messageId: "m-steer",
        conversationId: "op-d",
        text: "in kilometres",
        createdAt: "2026-10-04T00:00:00.000Z",
      });
      expect(await repositories.transcripts.claimSteers(taskId, admissionId, ["steer-d"])).toEqual(["steer-d"]);
      await stopOwner(first);
      return { taskId };
    }

    it("serve start hands it back pending; the front end's resend is the chat's next message, once", async () => {
      const directory = directories.create();
      const model = createFixtureModel({ turns: [{ text: "ten miles" }, { text: "sixteen kilometres" }] });
      const { taskId } = await orphanedSteer(directory, model);
      const second = await startOwner(directory, model);
      const repositories = repositoriesOf(second);
      // `releaseOrphanedSteers` at serve start.
      expect((await repositories.transcripts.steerOf(taskId, "m-steer"))?.state).toBe("pending");

      const resent = await reply(second.client, taskId, "in kilometres", "m-steer", "steer");
      expect(resent.ok, JSON.stringify(resent.error)).toBe(true);
      expect((resent.result as ReplyResult).steered).toBeUndefined();
      await waitFor(async () => (await settledAdmissions(second, taskId)).length === 2);
      expect((await repositories.transcripts.steerOf(taskId, "m-steer"))?.state).toBe("queued");
      expect(timesSaid(model.calls.at(-1), "in kilometres")).toBe(1);
      // Sent again: the same message, no third turn.
      expect(((await reply(second.client, taskId, "in kilometres", "m-steer")).result as ReplyResult).duplicate).toBe(true);
      await delay(100);
      expect(await repositories.tasks.listAdmissions(taskId)).toHaveLength(2);
    });

    it("serve start hands it back pending; the chat's next turn takes it, once", async () => {
      const directory = directories.create();
      const model = createFixtureModel({ turns: [{ text: "ten miles" }, { text: "sixteen kilometres" }] });
      const { taskId } = await orphanedSteer(directory, model);
      const second = await startOwner(directory, model);
      const repositories = repositoriesOf(second);
      expect((await repositories.transcripts.steerOf(taskId, "m-steer"))?.state).toBe("pending");

      expect((await reply(second.client, taskId, "and the time?", "m-next")).ok).toBe(true);
      await waitFor(async () => (await repositories.transcripts.steerOf(taskId, "m-steer"))?.state === "consumed");
      await waitFor(async () => (await settledAdmissions(second, taskId)).length === 2);
      expect(timesSaid(model.calls.at(-1), "in kilometres")).toBe(1);
      expect(timesSaid(model.calls.at(-1), "and the time?")).toBe(1);
      // Consumed, so a late resend is answered as merged and starts nothing.
      expect((await reply(second.client, taskId, "in kilometres", "m-steer")).result as ReplyResult).toMatchObject({
        steered: true,
        duplicate: true,
      });
      await delay(100);
      expect(await repositories.tasks.listAdmissions(taskId)).toHaveLength(2);
    });
  });

  it("(e) the -e1 start key: a task started for epoch 1 whose mapping was never recorded is found again after a restart — one task", async () => {
    const directory = directories.create();
    const model = createFixtureModel({ turns: [{ text: "first step" }, { text: "second step" }] });
    const first = await composeOwner(directory, model);
    await bindAlice(first);
    await first.messaging.ingest(inbound({ providerEventId: "evt-1", content: "hello" }));
    await first.messaging.ingest(inbound({ providerEventId: "evt-2", content: "/new" }));

    // Epoch 1's first message admits its task under the `-e1` key; the owner
    // stops before the mapping is recorded.
    vi.spyOn(first.store.repositories.messagingConversations, "record").mockRejectedValueOnce(
      new Error("owner stopped before the mapping"),
    );
    await expect(first.messaging.ingest(inbound({ providerEventId: "evt-3", content: "new topic" }))).rejects.toThrow(
      "owner stopped before the mapping",
    );
    const started = (await conversationTasks(first)).epoch1;
    expect(started).toBeDefined();
    expect(await first.store.asPort().repositories.messagingConversations.get("conn-a", "chat-1")).toBeUndefined();
    vi.restoreAllMocks();
    await closeOwner(first);

    const second = await composeOwner(directory, model);
    const repositories = second.store.asPort().repositories;
    await second.messaging.ingest(inbound({ providerEventId: "evt-4", content: "and more" }));
    const mapping = await repositories.messagingConversations.get("conn-a", "chat-1");
    // Converged: the message reached the task the crashed start made, as a reply, under epoch 1.
    expect(mapping).toMatchObject({ taskId: started?.taskId, epoch: 1 });
    const tasks = await conversationTasks(second);
    expect(tasks.epoch2).toBeUndefined();
    expect((await repositories.tasks.listAdmissions(started?.taskId ?? "")).map((admission) => admission.kind)).toEqual(["start", "reply"]);
    expect((await repositories.tasks.get(started?.taskId ?? ""))?.finalText).toBe("second step");
    expect(model.calls).toHaveLength(3);
    // The ended epoch 0 keeps its own task.
    expect((await repositories.messagingConversations.getByTask(tasks.epoch0?.taskId ?? ""))?.epoch).toBe(0);
  });
});
