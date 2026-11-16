import { TaviError, type ReplyResult, type RunResult } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { replyToConversation } from "../../src/server/reply.js";
import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * IPC `reply`: an IPC run opens a
 * conversation on its workspace's local connection, `operator.ask_user` in it
 * asks there, and `reply` — the connection's inbound transport — answers it
 * through the one settle point every chat uses.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

/** An owner whose model asks the operator a question, then answers with what it heard. */
async function startAsking(extraTurns: readonly string[] = []): Promise<{ handle: ServeHandle; client: IpcClient }> {
  const directory = directories.create("tavi-reply-");
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "fixture-conn" }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quietIo,
    {
      modelOverride: createFixtureModel({
        turns: [
          { toolCall: { id: "call-ask", name: "operator.ask_user", input: { question: "Which one: acme or globex?" } } },
          { text: "thanks for the answer" },
          ...extraTurns.map((text) => ({ text })),
        ],
      }),
    },
  );
  handles.push(handle);
  const owner = await findLiveOwner(directory);
  if (owner === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(owner);
  clients.push(client);
  return { handle, client };
}

/**
 * Run a prompt that asks, with no client following its stream, and wait for
 * the question. `ask_user` is an external tool the default policy gates, so
 * the run approves its own rounds: the question is what this is about.
 */
async function asked(handle: ServeHandle, client: IpcClient, operationKey: string): Promise<RunResult> {
  const started = await client.request(
    "run",
    { prompt: "pick one for me", workspaceId: "default", principal: "operator", operationKey, approval: "approve" },
    `run-${operationKey}`,
    { timeoutMs: 15_000 },
  );
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  const run = started.result as RunResult;
  const waits = handle.runtime.store.asPort().repositories.agentWaits;
  await waitFor(async () => (await waits.getActiveByTask(run.taskId)) !== undefined);
  return run;
}

const reply = (client: IpcClient, conversationId: string, text: string, clientMessageId: string, workspaceId = "default") =>
  client.request("reply", { workspaceId, conversationId, text, clientMessageId }, `reply-${clientMessageId}`, { timeoutMs: 15_000 });

describe("IPC reply", () => {
  it("refuses a reply to a task waiting on an approval round, and a blank reply: nothing is delivered", async () => {
    const { handle, client } = await startAsking();
    // Asking is allowed by a shipped rule; an operator ask rule puts a
    // round in front of it, which the client answers: that round stays pending.
    await handle.runtime.store.asPort().repositories.toolPolicy.putRule({
      ruleId: "ask-before-asking",
      workspaceId: "default",
      toolPattern: "operator.ask_user",
      decision: "ask",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const started = await client.request(
      "run",
      { prompt: "pick one for me", workspaceId: "default", principal: "operator", operationKey: "op-round", approval: "client" },
      "run-op-round",
      { timeoutMs: 15_000 },
    );
    const run = started.result as RunResult;
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () =>
      (await repositories.tasks.listAdmissions(run.taskId)).some((admission) => admission.result?.status === "waiting"),
    );
    const past = await reply(client, "op-round", "never mind, just answer", "message-round");
    expect(past.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("approval round") });
    // Nothing delivered: no follow-up admission, the round still pending.
    expect((await repositories.tasks.listAdmissions(run.taskId)).map((admission) => admission.kind)).toEqual(["start"]);
    expect(
      await repositories.messagingInbox.get(handle.runtime.localMessaging.connectionFor("default") ?? "", "message-round"),
    ).toBeUndefined();
    const blank = await reply(client, "op-round", "   ", "message-blank");
    expect(blank.error?.code).toBe("INVALID_INPUT");
  });

  it("answers an IPC run's question — asked with no client attached — through the one settle point", async () => {
    const { handle, client } = await startAsking();
    const run = await asked(handle, client, "op-ask");
    // The run's conversation is its operation key, on its workspace's local connection.
    expect(run.conversationId).toBe("op-ask");
    const repositories = handle.runtime.store.asPort().repositories;
    expect((await repositories.messagingConversations.get("local-default", "op-ask"))?.taskId).toBe(run.taskId);
    const wait = await repositories.agentWaits.getActiveByTask(run.taskId);
    // Delivered with nobody attached: accepted on the durable outbox record. The delivery follows the wait it
    // announces, so it is waited for rather than read the moment the task stops.
    await waitFor(async () => (await repositories.messagingOutbox.get(`ask:${wait?.waitId}`))?.state === "resolved");
    expect(await repositories.messagingOutbox.get(`ask:${wait?.waitId}`)).toMatchObject({
      state: "resolved",
      outcome: { status: "accepted" },
    });

    const answered = await reply(client, "op-ask", "acme", "message-1");
    expect(answered.ok, JSON.stringify(answered.error)).toBe(true);
    expect(answered.result as ReplyResult).toEqual({ taskId: run.taskId, conversationId: "op-ask", duplicate: false });
    await waitFor(async () => (await repositories.tasks.get(run.taskId))?.status === "completed");
    expect((await repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({ kind: "answered", replyText: "acme" });
    expect((await repositories.tasks.listAdmissions(run.taskId)).filter((admission) => admission.kind === "deadline")).toHaveLength(1);
  });

  it("records a retried reply once, and settles the wait once however many replies race for it", async () => {
    const { handle, client } = await startAsking(["and noted"]);
    const run = await asked(handle, client, "op-race");
    const repositories = handle.runtime.store.asPort().repositories;
    // Two different messages at once: one answers the question, the other is a follow-up turn.
    const [first, second] = await Promise.all([
      reply(client, "op-race", "acme", "message-a"),
      reply(client, "op-race", "globex", "message-b"),
    ]);
    expect(first.ok && second.ok).toBe(true);
    await waitFor(async () => {
      const kinds = (await repositories.tasks.listAdmissions(run.taskId)).map((admission) => admission.kind);
      return kinds.includes("deadline") && kinds.includes("reply") && (await repositories.tasks.get(run.taskId))?.status === "completed";
    }, 10_000);
    const kinds = (await repositories.tasks.listAdmissions(run.taskId)).map((admission) => admission.kind);
    expect(kinds.filter((kind) => kind === "deadline")).toHaveLength(1);

    // The same message again — a client retrying after a lost answer — is one message.
    const admissions = (await repositories.tasks.listAdmissions(run.taskId)).length;
    const retried = await reply(client, "op-race", "acme", "message-a");
    expect(retried.result as ReplyResult).toMatchObject({ duplicate: true });
    await delay(100);
    expect(await repositories.tasks.listAdmissions(run.taskId)).toHaveLength(admissions);
  });

  it("replies by task: into its own conversation, or one opened for a task that has none", async () => {
    const { handle, client } = await startAsking(["second answer", "third answer"]);
    const run = await asked(handle, client, "op-by-task");
    const repositories = handle.runtime.store.asPort().repositories;
    const byTask = await client.request(
      "reply",
      { workspaceId: "default", taskId: run.taskId, text: "acme", clientMessageId: "message-t1" },
      "reply-t1",
      { timeoutMs: 15_000 },
    );
    expect(byTask.ok, JSON.stringify(byTask.error)).toBe(true);
    expect(byTask.result as ReplyResult).toMatchObject({ taskId: run.taskId, conversationId: "op-by-task" });
    await waitFor(async () => (await repositories.tasks.get(run.taskId))?.status === "completed");

    // A task started elsewhere — here straight through the workflow — has no conversation on the local connection.
    const workflow = handle.runtime.workflow;
    if (workflow === undefined) throw new Error("the owner composed no workflow");
    const started = await workflow.admit(
      {
        context: { workspaceId: "default", principalId: "operator", runId: "pending", caller: "test" },
        operationKey: "elsewhere-1",
        kind: "start",
        prompt: "hello",
      },
      {},
    );
    await waitFor(async () => ["completed", "failed"].includes((await repositories.tasks.get(started.taskId))?.status ?? ""));
    const opened = await client.request(
      "reply",
      { workspaceId: "default", taskId: started.taskId, text: "and again", clientMessageId: "message-t2" },
      "reply-t2",
      { timeoutMs: 15_000 },
    );
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true);
    expect(opened.result as ReplyResult).toMatchObject({ taskId: started.taskId, conversationId: `task:${started.taskId}` });
    expect((await repositories.messagingConversations.get("local-default", `task:${started.taskId}`))?.taskId).toBe(started.taskId);

    const unknown = await client.request(
      "reply",
      { workspaceId: "default", taskId: "no-such-task", text: "hi", clientMessageId: "message-t3" },
      "reply-t3",
      { timeoutMs: 15_000 },
    );
    expect(unknown.error).toMatchObject({ code: "NOT_FOUND" });
    const both = await client.request(
      "reply",
      { workspaceId: "default", taskId: run.taskId, conversationId: "op-by-task", text: "hi", clientMessageId: "message-t4" },
      "reply-t4",
      { timeoutMs: 15_000 },
    );
    expect(both.ok).toBe(false);
  });

  it("takes `/new` typed in the canvas as ordinary text: nothing is reset and the chat goes on", async () => {
    const { handle, client } = await startAsking(["took it as text", "still here"]);
    const run = await asked(handle, client, "op-slash-new");
    const repositories = handle.runtime.store.asPort().repositories;
    expect((await reply(client, "op-slash-new", "acme", "message-n1")).ok).toBe(true);
    await waitFor(async () => (await repositories.tasks.get(run.taskId))?.status === "completed");
    const typed = await reply(client, "op-slash-new", "/new", "message-n2");
    expect(typed.ok, JSON.stringify(typed.error)).toBe(true);
    await waitFor(async () =>
      (await repositories.tasks.listAdmissions(run.taskId)).some((admission) => admission.kind === "reply" && admission.result !== null),
    );
    // The mapping is the run's still, the task was not cancelled, and the next message is a turn of it.
    expect((await repositories.messagingConversations.get("local-default", "op-slash-new"))?.taskId).toBe(run.taskId);
    expect(await repositories.cancellations.get(run.taskId)).toBeUndefined();
    const next = await client.request(
      "reply",
      { workspaceId: "default", taskId: run.taskId, text: "and more", clientMessageId: "message-n3" },
      "reply-n3",
      { timeoutMs: 15_000 },
    );
    expect(next.result as ReplyResult).toMatchObject({ taskId: run.taskId, conversationId: "op-slash-new" });
  });

  it("takes a message into a Home that never had a run, as its first", async () => {
    const { handle, client } = await startAsking(["hello"]);
    const taskId = await handle.runtime.workflow?.openHome?.({ workspaceId: "default", principalId: "operator" });
    expect((await reply(client, "home:operator", "hi", "message-h1")).ok).toBe(true);
    const repositories = handle.runtime.store.asPort().repositories;
    expect((await repositories.messagingConversations.get("local-default", "home:operator"))?.taskId).toBe(taskId);
  });

  it("opens a fresh conversation for a task whose only local mapping has ended", async () => {
    const { handle, client } = await startAsking(["after the reset"]);
    const run = await asked(handle, client, "op-ended");
    const repositories = handle.runtime.store.asPort().repositories;
    expect((await reply(client, "op-ended", "acme", "message-e1")).ok).toBe(true);
    await waitFor(async () => (await repositories.tasks.get(run.taskId))?.status === "completed");
    // A chat reset before `/new` was ordinary text on the local connection.
    await repositories.messagingConversations.reset("local-default", "op-ended", nowTimestamp());
    const resumed = await client.request(
      "reply",
      { workspaceId: "default", taskId: run.taskId, text: "go on", clientMessageId: "message-e2" },
      "reply-e2",
      { timeoutMs: 15_000 },
    );
    expect(resumed.ok, JSON.stringify(resumed.error)).toBe(true);
    expect(resumed.result as ReplyResult).toMatchObject({ taskId: run.taskId, conversationId: `task:${run.taskId}` });
    // Ended twice over: the next fresh key past it.
    await repositories.messagingConversations.reset("local-default", `task:${run.taskId}`, nowTimestamp());
    const again = await client.request(
      "reply",
      { workspaceId: "default", taskId: run.taskId, text: "and on", clientMessageId: "message-e3" },
      "reply-e3",
      { timeoutMs: 15_000 },
    );
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect((again.result as ReplyResult).conversationId).toMatch(new RegExp(`^task:${run.taskId}`));
  });

  it("refuses a reply or a steer into a worker: it is seen, not written to", async () => {
    const { handle, client } = await startAsking(["unused"]);
    const run = await asked(handle, client, "op-root");
    const repositories = handle.runtime.store.asPort().repositories;
    const workflow = handle.runtime.workflow;
    if (workflow === undefined) throw new Error("the owner composed no workflow");
    const worker = await workflow.admit(
      {
        context: { workspaceId: "default", principalId: "operator", runId: "pending", caller: "test" },
        operationKey: "worker-1",
        kind: "start",
        prompt: "hello",
      },
      {},
    );
    await waitFor(async () => ["completed", "failed"].includes((await repositories.tasks.get(worker.taskId))?.status ?? ""));
    await repositories.agentDelegations.recordSpawn({
      operationKey: "spawn-w",
      workspaceId: "default",
      principalId: "operator",
      workerTaskId: worker.taskId,
      workerAgentId: "agent-1",
      parentTaskId: run.taskId,
      rootTaskId: run.taskId,
      depth: 1,
      createdAt: nowTimestamp(),
    });
    for (const intent of [undefined, "steer"] as const) {
      const refused = await client.request(
        "reply",
        {
          workspaceId: "default",
          taskId: worker.taskId,
          text: "hi worker",
          clientMessageId: `message-w-${intent ?? "reply"}`,
          ...(intent === undefined ? {} : { intent }),
        },
        `reply-w-${intent ?? "reply"}`,
        { timeoutMs: 15_000 },
      );
      expect(refused.error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining(run.taskId) });
    }
    expect((await repositories.tasks.listAdmissions(worker.taskId)).map((admission) => admission.kind)).toEqual(["start"]);
    // Refused before a conversation is opened for it: the worker has none on the local connection.
    expect(await repositories.messagingConversations.getByTask(worker.taskId)).toBeUndefined();
  });

  it("refuses a reply into an idea's prepared step: background work, never a chat", async () => {
    const { handle, client } = await startAsking(["unused"]);
    const repositories = handle.runtime.store.asPort().repositories;
    const workflow = handle.runtime.workflow;
    if (workflow === undefined) throw new Error("the owner composed no workflow");
    const prepared = await workflow.admit(
      {
        context: { workspaceId: "default", principalId: "operator", runId: "pending", caller: "ideas" },
        operationKey: "prep-1",
        kind: "start",
        prompt: "Find flights",
        origin: "ideas",
        executionPolicy: { mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: false, toolAllowlist: [] },
      },
      {},
    );
    await waitFor(async () => ["completed", "failed"].includes((await repositories.tasks.get(prepared.taskId))?.status ?? ""));
    const refused = await client.request(
      "reply",
      { workspaceId: "default", taskId: prepared.taskId, text: "and hotels?", clientMessageId: "message-p" },
      "reply-p",
      { timeoutMs: 15_000 },
    );
    expect(refused.error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("background work, not a chat") });
    expect((await repositories.tasks.listAdmissions(prepared.taskId)).map((admission) => admission.kind)).toEqual(["start"]);
  });

  it("refuses a reply into no conversation, or into another workspace's", async () => {
    const { handle, client } = await startAsking();
    await asked(handle, client, "op-mine");
    const nowhere = await reply(client, "op-nobody", "hello", "message-x");
    expect(nowhere.error).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("named by its operation key") });
    // A workspace this owner does not serve has no local connection at all.
    const elsewhere = await reply(client, "op-mine", "hello", "message-y", "elsewhere");
    expect(elsewhere.error).toMatchObject({ code: "UNAVAILABLE" });
  });
});

it("settles a duplicate reply when its post-record lookup fails", async () => {
  const { handle, client } = await startAsking();
  const run = await asked(handle, client, "op-lookup-failure");
  expect((await reply(client, "op-lookup-failure", "acme", "message-lookup")).ok).toBe(true);
  const repositories = handle.runtime.store.asPort().repositories;
  await waitFor(async () => (await repositories.tasks.get(run.taskId))?.status === "completed");
  const answer = await replyToConversation(
    {
      repositories: {
        ...repositories,
        messagingInbox: {
          ...repositories.messagingInbox,
          get: async () => {
            throw new TaviError("UNAVAILABLE", "database worker unavailable");
          },
        },
      },
      localMessaging: handle.runtime.localMessaging,
      now: () => nowTimestamp(),
      log: () => {},
    },
    { workspaceId: "default", conversationId: "op-lookup-failure", text: "acme", clientMessageId: "message-lookup" },
  );
  expect(answer).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
});
