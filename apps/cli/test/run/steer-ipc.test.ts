import type { ModelPort, ModelRequest, ReplyResult, RunResult } from "@tavi/contracts";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/io.js";
import { handOnSteers } from "../../src/server/reply.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Steering: a `reply` with `intent: "steer"`
 * into a chat whose turn runs is merged before that turn's next model call; a
 * steer with no turn running is a reply as any other; one the turn ends
 * before taking is the chat's next turn.
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

async function start(model: ModelPort): Promise<{ handle: ServeHandle; client: IpcClient }> {
  const directory = directories.create("tavi-steer-");
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "fixture-conn" }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quietIo,
    { modelOverride: model },
  );
  handles.push(handle);
  const owner = await findLiveOwner(directory);
  if (owner === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(owner);
  clients.push(client);
  return { handle, client };
}

const run = async (client: IpcClient, operationKey: string): Promise<RunResult> => {
  const started = await client.request(
    "run",
    { prompt: "how far is it?", workspaceId: "default", principal: "operator", operationKey, approval: "approve" },
    `run-${operationKey}`,
    { timeoutMs: 15_000 },
  );
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  return started.result as RunResult;
};

/** A reply into the chat: `intent` "none" names none, as a front end from before steering does. */
const steer = (client: IpcClient, taskId: string, text: string, clientMessageId: string, intent: "steer" | "queue" | "none" = "steer") =>
  client.request(
    "reply",
    { workspaceId: "default", taskId, text, clientMessageId, ...(intent === "none" ? {} : { intent }) },
    `reply-${clientMessageId}`,
    { timeoutMs: 15_000 },
  );

const userTexts = (request: ModelRequest | undefined): string[] =>
  (request?.messages ?? []).filter((message) => message.role === "user").map((message) => message.text);

describe("steering a running turn", () => {
  it("merges a steer into the running turn before its next model call, and saves it with the turn", async () => {
    const gated = gatedModel(
      [{ toolCall: { id: "c1", name: "memory.get", input: { recordId: "nothing-here" } } }, { text: "in kilometres" }],
      1,
    );
    const { handle, client } = await start(gated.model);
    const started = await run(client, "op-steer");
    await waitFor(async () => gated.reached());
    const answer = await steer(client, started.taskId, "answer in kilometres", "steer-1");
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    expect(answer.result as ReplyResult).toMatchObject({ taskId: started.taskId, steered: true, duplicate: false });
    // The same message again is the same steer.
    expect((await steer(client, started.taskId, "answer in kilometres", "steer-1")).result as ReplyResult).toMatchObject({
      steered: true,
      duplicate: true,
    });
    const repositories = handle.runtime.store.asPort().repositories;
    expect((await repositories.transcripts.steerOf(started.taskId, "steer-1"))?.state).toBe("pending");
    gated.release();
    await waitFor(async () => (await repositories.tasks.get(started.taskId))?.status === "completed");
    expect(userTexts(gated.calls[0]).some((text) => text.startsWith("answer in kilometres"))).toBe(false);
    expect(userTexts(gated.calls[1]).some((text) => text.startsWith("answer in kilometres"))).toBe(true);
    await waitFor(async () => (await repositories.transcripts.steerOf(started.taskId, "steer-1"))?.state === "consumed");
    // One turn: the steer started none of its own, and the saved turn shows it.
    expect((await repositories.tasks.listAdmissions(started.taskId)).map((admission) => admission.kind)).toEqual(["start"]);
    await waitFor(async () => (await repositories.transcripts.page(started.taskId, { limit: 5 })).entries.length === 1);
    const saved = (await repositories.transcripts.page(started.taskId, { limit: 5 })).entries[0];
    expect(saved?.turn.items).toEqual(expect.arrayContaining([{ kind: "steer", text: "answer in kilometres" }]));
    // Sent again as a plain reply once its turn took it (a page that missed the stream): no second turn.
    expect((await steer(client, started.taskId, "answer in kilometres", "steer-1", "none")).result as ReplyResult).toMatchObject({
      steered: true,
      duplicate: true,
    });
    expect(await repositories.tasks.listAdmissions(started.taskId)).toHaveLength(1);
  });

  it("delivers a steer with no turn running as any reply: the chat's next turn", async () => {
    const { handle, client } = await start(createFixtureModel({ turns: [{ text: "first" }, { text: "second" }] }));
    const started = await run(client, "op-idle");
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.tasks.get(started.taskId))?.status === "completed");
    const answer = await steer(client, started.taskId, "and another thing", "steer-idle");
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    expect((answer.result as ReplyResult).steered).toBeUndefined();
    expect(await repositories.transcripts.steerOf(started.taskId, "steer-idle")).toBeUndefined();
    await waitFor(async () => (await repositories.tasks.listAdmissions(started.taskId)).length === 2);
    expect((await repositories.tasks.listAdmissions(started.taskId)).map((admission) => admission.kind)).toEqual(["start", "reply"]);
  });

  it("queues a reply that names no intent, even while a turn runs (the default; a messaging message too)", async () => {
    const gated = gatedModel([{ text: "first" }, { text: "second" }], 1);
    const { handle, client } = await start(gated.model);
    const started = await run(client, "op-queue");
    await waitFor(async () => gated.reached());
    const answer = await steer(client, started.taskId, "after this", "queue-1", "none");
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    expect((answer.result as ReplyResult).steered).toBeUndefined();
    const repositories = handle.runtime.store.asPort().repositories;
    expect(await repositories.transcripts.steerOf(started.taskId, "queue-1")).toBeUndefined();
    gated.release();
    await waitFor(
      async () => (await repositories.tasks.listAdmissions(started.taskId)).filter((admission) => admission.result !== null).length === 2,
    );
    expect(userTexts(gated.calls[0]).some((text) => text.startsWith("after this"))).toBe(false);
  });

  it("makes a steer the turn ended before taking the chat's next turn, sent by the owner", async () => {
    // The turn's only model call is under way when the steer arrives: no call is left to take it.
    const gated = gatedModel([{ text: "done" }, { text: "and the next one" }], 1);
    const { handle, client } = await start(gated.model);
    const started = await run(client, "op-late");
    await waitFor(async () => gated.reached());
    const answer = await steer(client, started.taskId, "one more thing", "steer-late");
    expect((answer.result as ReplyResult).steered).toBe(true);
    gated.release();
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(
      async () => (await repositories.tasks.listAdmissions(started.taskId)).filter((admission) => admission.result !== null).length === 2,
      10_000,
    );
    expect((await repositories.tasks.listAdmissions(started.taskId)).map((admission) => admission.kind)).toEqual(["start", "reply"]);
    expect((await repositories.transcripts.steerOf(started.taskId, "steer-late"))?.state).toBe("queued");
    expect(userTexts(gated.calls[1]).some((text) => text.startsWith("one more thing"))).toBe(true);
    // A front end that sends it again once the turn ended sends the same message: no third turn.
    const resent = await steer(client, started.taskId, "one more thing", "steer-late", "none");
    expect(resent.ok, JSON.stringify(resent.error)).toBe(true);
    expect((resent.result as ReplyResult).duplicate).toBe(true);
    expect(await repositories.tasks.listAdmissions(started.taskId)).toHaveLength(2);
  });

  it("does not hand on a steer while the chat waits on a question: the turn the answer resumes takes it", async () => {
    const gated = gatedModel(
      [
        { toolCall: { id: "c-ask", name: "operator.ask_user", input: { question: "Which one: acme or globex?" } } },
        { text: "acme, in kilometres" },
      ],
      1,
    );
    const { handle, client } = await start(gated.model);
    const started = await run(client, "op-question");
    await waitFor(async () => gated.reached());
    expect(((await steer(client, started.taskId, "in kilometres", "steer-q")).result as ReplyResult).steered).toBe(true);
    gated.release();
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.agentWaits.getActiveByTask(started.taskId)) !== undefined);
    await waitFor(async () => (await repositories.tasks.listAdmissions(started.taskId)).every((admission) => admission.result !== null));
    await delay(100);
    // Not delivered as the question's answer: still pending, and no reply admitted.
    expect((await repositories.transcripts.steerOf(started.taskId, "steer-q"))?.state).toBe("pending");
    expect((await repositories.tasks.listAdmissions(started.taskId)).map((admission) => admission.kind)).toEqual(["start"]);
    // The person answers; the resumed turn's next model call takes the steer.
    expect((await steer(client, started.taskId, "acme", "answer-q", "none")).ok).toBe(true);
    await waitFor(async () => (await repositories.transcripts.steerOf(started.taskId, "steer-q"))?.state === "consumed");
    expect(userTexts(gated.calls.at(-1)).some((text) => text.startsWith("in kilometres"))).toBe(true);
  });

  it("refuses a steer while an approval round waits, hands nothing on before the decision, and the resumed turn takes the steer", async () => {
    const gated = gatedModel([{ toolCall: { id: "c-get", name: "memory.get", input: { recordId: "nothing-here" } } }, { text: "done" }], 1);
    const { handle, client } = await start(gated.model);
    const repositories = handle.runtime.store.asPort().repositories;
    await repositories.toolPolicy.putRule({
      ruleId: "ask-memory",
      workspaceId: "default",
      toolPattern: "memory.get",
      decision: "ask",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const started = await client.request(
      "run",
      { prompt: "look it up", workspaceId: "default", principal: "operator", operationKey: "op-round", approval: "client" },
      "run-op-round",
      { timeoutMs: 15_000 },
    );
    const taskId = (started.result as RunResult).taskId;
    await waitFor(async () => gated.reached());
    expect(((await steer(client, taskId, "only the newest", "steer-r")).result as ReplyResult).steered).toBe(true);
    gated.release();
    await waitFor(async () =>
      (await repositories.tasks.listAdmissions(taskId)).some((admission) => admission.result?.status === "waiting"),
    );
    const refused = await steer(client, taskId, "and quickly", "steer-r2");
    expect(refused.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("approval round") });
    await delay(100);
    expect((await repositories.transcripts.steerOf(taskId, "steer-r"))?.state).toBe("pending");
    expect(await repositories.tasks.listAdmissions(taskId)).toHaveLength(1);
    const approved = await client.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" },
      "approve-r",
      { timeoutMs: 15_000 },
    );
    expect(approved.ok, JSON.stringify(approved.error)).toBe(true);
    await waitFor(async () => (await repositories.transcripts.steerOf(taskId, "steer-r"))?.state === "consumed");
    expect(userTexts(gated.calls.at(-1)).some((text) => text.startsWith("only the newest"))).toBe(true);
  });

  it("hands on, not answers as merged, a steer left claimed with no turn running (an owner that stopped)", async () => {
    const { handle, client } = await start(createFixtureModel({ turns: [{ text: "first" }, { text: "second" }] }));
    const started = await run(client, "op-orphan");
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.tasks.get(started.taskId))?.status === "completed");
    await repositories.transcripts.recordSteer({
      steerId: "steer-orphan",
      taskId: started.taskId,
      messageId: "m-orphan",
      conversationId: "op-orphan",
      text: "left behind",
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    await repositories.transcripts.claimSteers(started.taskId, "admission-of-a-stopped-owner", ["steer-orphan"]);
    const resent = await steer(client, started.taskId, "left behind", "m-orphan", "none");
    expect(resent.ok, JSON.stringify(resent.error)).toBe(true);
    expect((resent.result as ReplyResult).steered).toBeUndefined();
    await waitFor(async () => (await repositories.tasks.listAdmissions(started.taskId)).length === 2);
    expect((await repositories.transcripts.steerOf(started.taskId, "m-orphan"))?.state).toBe("queued");
  });

  it("hands nothing on for a cancelled task", async () => {
    const { handle, client } = await start(createFixtureModel({ turns: [{ text: "first" }] }));
    const started = await run(client, "op-cancelled");
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.tasks.get(started.taskId))?.status === "completed");
    await repositories.transcripts.recordSteer({
      steerId: "steer-c",
      taskId: started.taskId,
      messageId: "m-c",
      conversationId: "op-cancelled",
      text: "too late",
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    await repositories.cancellations.request({
      taskId: started.taskId,
      requestedBy: "operator",
      reason: "stop",
      now: { execution: true },
    } as never);
    const handed = await handOnSteers(
      { repositories, localMessaging: handle.runtime.localMessaging, now: () => "2026-10-04T00:00:02.000Z", log: () => {} },
      started.taskId,
    );
    expect(handed).toBe(0);
    expect((await repositories.transcripts.steerOf(started.taskId, "m-c"))?.state).toBe("pending");
    expect(await repositories.tasks.listAdmissions(started.taskId)).toHaveLength(1);
  });

  it("reads whether a turn runs and whether the chat waits by indexed reads, never the whole admission list", async () => {
    const { handle, client } = await start(createFixtureModel({ turns: [{ text: "first" }, { text: "second" }] }));
    const started = await run(client, "op-indexed");
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.tasks.get(started.taskId))?.status === "completed");
    expect(await repositories.tasks.hasRunningAdmission(started.taskId)).toBe(false);
    await repositories.transcripts.recordSteer({
      steerId: "steer-i",
      taskId: started.taskId,
      messageId: "m-i",
      conversationId: "op-indexed",
      text: "and then this",
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    const scanned: string[] = [];
    const tasks = new Proxy(repositories.tasks, {
      get: (target, key, receiver) =>
        key === "listAdmissions"
          ? (taskId: string) => {
              scanned.push(taskId);
              return target.listAdmissions(taskId);
            }
          : Reflect.get(target, key, receiver),
    });
    const handed = await handOnSteers(
      {
        repositories: { ...repositories, tasks },
        localMessaging: handle.runtime.localMessaging,
        now: () => "2026-10-04T00:00:02.000Z",
        log: () => {},
      },
      started.taskId,
    );
    expect(handed).toBe(1);
    expect(scanned).toEqual([]);
  });
});
