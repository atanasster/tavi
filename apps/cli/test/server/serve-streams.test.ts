import { fixturePromptPolicy } from "../support/prompt-policy.js";

import type { ClientEvent, InvocationContext, ModelOutcome, ModelPort } from "@tavi/contracts";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { IPC_PROTOCOL_VERSION } from "@tavi/contracts";
import { FrameReader, createIpcClient, encodeFrame, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * An owner's event streams over IPC: what an attached
 * client receives, how its subscriptions are released, and what it sees while
 * the owner shuts down under a run it is watching.
 */

const directories = temporaryDirectories({ prefix: "tavi-streams-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

async function startServe(directory: string, model: ModelPort, drainDeadlineMs = 5_000): Promise<ServeHandle> {
  const handle = await serve(
    fixtureRuntimeOptions(directory, {
      approvalRequiredFor: [],
      // Short, so a sweep that wrongly re-admitted work would do so inside a test.
      agentWaitSweepIntervalMs: 20,
      scheduleSweepIntervalMs: 20,
    }),
    { dataDirectory: directory, drainDeadlineMs },
    quietIo,
    { modelOverride: model },
  );
  handles.push(handle);
  return handle;
}

async function attach(directory: string): Promise<IpcClient> {
  const owner = await findLiveOwner(directory);
  if (owner === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(owner);
  clients.push(client);
  return client;
}

/**
 * Subscribe and collect, registering for the subscription's events from the
 * response itself — the owner writes held events right behind it.
 */
async function subscribe(
  client: IpcClient,
  payload: Record<string, unknown>,
  requestId: string,
): Promise<{ readonly response: Awaited<ReturnType<IpcClient["request"]>>; readonly events: ClientEvent[] }> {
  const events: ClientEvent[] = [];
  let subscriptionId: string | undefined;
  client.onEvent((frame) => {
    if (frame.subscriptionId === subscriptionId) events.push(frame.event);
  });
  const response = await client.request("subscribe", payload, requestId, {
    onResponse: (answer) => {
      subscriptionId = (answer.result as { subscriptionId?: string } | undefined)?.subscriptionId;
    },
  });
  return { response, events };
}

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };

/** A model whose every call runs until its signal fires, then reports the abort. */
function untilAborted(): ModelPort {
  return {
    ...createFixtureModel({ turns: [{ text: "never" }] }),
    stream: async (request, options): Promise<ModelOutcome> => {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        status: "aborted",
        attemptId: request.attemptId,
        text: "",
        toolCalls: [],
        usage: {},
        error: { code: "aborted", message: "Generation was aborted", retryable: false },
      };
    },
  };
}

/** A model whose `index`-th call (0-based) waits for `gate` before answering. */
function gatedModel(gatedCall: number, gate: Promise<void>): ModelPort {
  const fixture = createFixtureModel({ turns: [{ text: "first answer" }, { text: "second answer" }] });
  let calls = 0;
  return {
    ...fixture,
    stream: async (request, options) => {
      const call = calls;
      calls += 1;
      if (call === gatedCall) await gate;
      return fixture.stream(request, options);
    },
  };
}

describe("an owner's event streams over IPC", () => {
  it("delivers a subscription's replay and resync after its response, and releases it on unsubscribe and close", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, createFixtureModel({ turns: [{ text: "all done" }] }));
    // A run admitted inside the owner — the way a schedule or a chat admits.
    const admitted = await handle.runtime.workflow?.admit({ context, operationKey: "op-1", kind: "start", prompt: "go" });
    const taskId = admitted?.taskId ?? "";
    expect(admitted?.outcome.status).toBe("completed");

    const client = await attach(directory);
    const replay = await subscribe(client, { taskId, from: "beginning" }, "sub-beginning");
    expect(replay.response).toMatchObject({ ok: true, result: { resync: false, truncated: false } });
    await waitFor(() => replay.events.at(-1)?.kind === "task.completed");
    expect(replay.events[0]?.kind).toBe("run.started");
    expect(replay.events.map((event) => event.sequence)).toEqual(replay.events.map((_event, index) => index));

    // A cursor from another owner session: one resync, to this subscriber only.
    const stale = await subscribe(client, { taskId, from: { epoch: "a-dead-session", sequence: 3 } }, "sub-stale");
    expect(stale.response).toMatchObject({ ok: true, result: { resync: true, truncated: true, replayed: 0 } });
    await waitFor(() => stale.events.length === 1);
    expect(stale.events[0]?.kind).toBe("resync.required");
    expect(replay.events.some((event) => event.kind === "resync.required")).toBe(false);

    // Both sides of a subscription are released together.
    expect(handle.runtime.runEventBus.stats().subscriptions).toBe(2);
    const subscriptionId = (stale.response.result as { subscriptionId: string }).subscriptionId;
    const released = await client.request("unsubscribe", { subscriptionId }, "unsub-1");
    expect(released).toMatchObject({ ok: true, result: { unsubscribed: true } });
    expect(handle.runtime.runEventBus.stats().subscriptions).toBe(1);
    client.close();
    await waitFor(() => handle.runtime.runEventBus.stats().subscriptions === 0);
  });

  it("tells a subscription from now where it opened, so resubscribing from there misses nothing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directory = directories.create();
    const handle = await startServe(directory, gatedModel(0, gate));
    let taskId = "";
    const running = handle.runtime.workflow?.admit({
      context,
      operationKey: "op-now",
      kind: "start",
      prompt: "take your time",
      onClaimed: (claimed) => {
        taskId = claimed.taskId;
      },
    });
    // Its start is published; the model call is held at the gate.
    await waitFor(() => taskId !== "" && handle.runtime.runEventBus.head(taskId) !== undefined);
    const head = handle.runtime.runEventBus.head(taskId);

    const client = await attach(directory);
    const now = await subscribe(client, { taskId }, "sub-now");
    expect(now.response).toMatchObject({ ok: true, result: { cursor: head, replayed: 0 } });
    // Named its own start: nothing to report.
    const named = await subscribe(client, { taskId, from: "beginning" }, "sub-named");
    expect((named.response.result as { cursor?: unknown }).cursor).toBeUndefined();

    // What a client dropped before any event arrived asks for: the events
    // published after it opened, and only those.
    const resumed = await subscribe(client, { taskId, from: (now.response.result as { cursor: unknown }).cursor }, "sub-resumed");
    expect(resumed.response).toMatchObject({ ok: true, result: { resync: false, replayed: 0 } });
    release();
    await running;
    await waitFor(() => resumed.events.at(-1)?.kind === "task.completed" && now.events.at(-1)?.kind === "task.completed");
    expect(resumed.events).toEqual(now.events);
    expect(resumed.events[0]?.sequence).toBe((head?.sequence ?? 0) + 1);
  });

  it("refuses a subscription to a task that does not exist, creating nothing", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, createFixtureModel({ turns: [{ text: "x" }] }));
    const client = await attach(directory);
    const before = handle.runtime.runEventBus.stats().tasks;
    const refused = await client.request("subscribe", { taskId: "task-that-never-was" }, "sub-missing");
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(handle.runtime.runEventBus.stats().tasks).toBe(before);
  });

  it("keeps an attached subscriber through shutdown until the run it watches ends, and flushes that end to it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directory = directories.create();
    const handle = await startServe(directory, gatedModel(0, gate));
    let taskId = "";
    const running = handle.runtime.workflow?.admit({
      context,
      operationKey: "op-running",
      kind: "start",
      prompt: "take your time",
      onClaimed: (claimed) => {
        taskId = claimed.taskId;
      },
    });
    await waitFor(() => taskId !== "");

    const client = await attach(directory);
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    const watched = await subscribe(client, { taskId, from: "beginning" }, "sub-running");
    expect(watched.response.ok).toBe(true);

    const stopping = handle.shutdown("test shutdown under a running turn");
    // New work is refused while the owner drains…
    const refused = await client.request("tasks", {}, "during-shutdown");
    expect(refused).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(closed).toBe(false);

    // …and the run it is watching finishes inside the deadline.
    release();
    await running;
    await stopping;
    await waitFor(() => closed);
    expect(watched.events.at(-1)?.kind).toBe("task.completed");
    expect((await handle.stopped).clean).toBe(true);
  });

  it("aborts a resumed turn through `abort`, ends it stopped, and nothing re-admits it", async () => {
    // The second model call — the resumed turn — blocks until its signal fires.
    const fixture = createFixtureModel({ turns: [{ text: "first answer" }] });
    let calls = 0;
    const model: ModelPort = {
      ...fixture,
      stream: async (request, options): Promise<ModelOutcome> => {
        calls += 1;
        if (calls === 1) return fixture.stream(request, options);
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          status: "aborted",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "aborted", message: "Generation was aborted", retryable: false },
        };
      },
    };
    const directory = directories.create();
    const handle = await startServe(directory, model);
    const workflow = handle.runtime.workflow;
    if (workflow === undefined) throw new Error("no workflow");
    const first = await workflow.admit({ context, operationKey: "op-start", kind: "start", prompt: "hello" });

    let claimed = false;
    const resumed = workflow.admit({
      context,
      taskId: first.taskId,
      operationKey: "op-reply",
      kind: "reply",
      prompt: "and another thing",
      onClaimed: () => {
        claimed = true;
      },
    });
    await waitFor(() => claimed && calls === 2);

    const client = await attach(directory);
    const aborted = await client.request("abort", { taskId: first.taskId }, "abort-1");
    expect(aborted).toMatchObject({ ok: true });
    const outcome = await resumed;
    expect(outcome.outcome).toMatchObject({ status: "stopped", error: { code: "STOPPED" } });

    // Nothing is running any more, and nothing picks the task back up.
    const again = await client.request("abort", { taskId: first.taskId }, "abort-2");
    expect(again).toMatchObject({ ok: false, error: { code: "NOT_RUNNING" } });
    const admissions = (await handle.runtime.store.asPort().repositories.tasks.listAdmissions(first.taskId)).length;
    await delay(200);
    expect(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(first.taskId)).toHaveLength(admissions);
    expect(calls).toBe(2);
  });

  it("cuts off a run that outlives the drain deadline: aborts it, ends its stream, and reports an unclean stop", async () => {
    // A turn that never finishes on its own — only when its signal fires, as a
    // real model transport's does.
    const directory = directories.create();
    const handle = await startServe(directory, untilAborted(), 300);
    let taskId = "";
    void handle.runtime.workflow
      ?.admit({
        context,
        operationKey: "op-stuck",
        kind: "start",
        prompt: "never done",
        onClaimed: (claimed) => {
          taskId = claimed.taskId;
        },
      })
      .catch(() => {});
    await waitFor(() => taskId !== "");
    const client = await attach(directory);
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    const watched = await subscribe(client, { taskId, from: "beginning" }, "sub-stuck");

    const stopping = handle.shutdown("test shutdown past the deadline");
    // Admission is closed for every producer, not only IPC.
    await expect(
      handle.runtime.workflow?.admit({ context, operationKey: "op-late", kind: "start", prompt: "too late" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await stopping;

    const outcome = await handle.stopped;
    expect(outcome.clean).toBe(false);
    // Everything the owner flushed has been read once the connection has closed.
    await waitFor(() => closed);
    expect(watched.events.at(-1)).toMatchObject({ kind: "task.failed", errorCode: "ABORTED" });
  });

  it("still takes `abort` during a drain on a connection opened before it, ending the turn that holds it up", async () => {
    // A deadline well past the test's own waits: the operator's abort, not the
    // owner's, ends the turn — and a clean stop says the owner aborted nothing.
    const directory = directories.create();
    const handle = await startServe(directory, untilAborted(), 4_000);
    let taskId = "";
    const running = handle.runtime.workflow?.admit({
      context,
      operationKey: "op-holding",
      kind: "start",
      prompt: "never done",
      onClaimed: (claimed) => {
        taskId = claimed.taskId;
      },
    });
    await waitFor(() => taskId !== "");
    const client = await attach(directory);

    const stopping = handle.shutdown("test shutdown held up by a turn");
    // Nothing new is taken, and a new client finds no owner to reach…
    expect(await client.request("tasks", {}, "during-drain")).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(await findLiveOwner(directory)).toBeUndefined();
    const stderr: string[] = [];
    const io: CliIo = { stdout: () => {}, stderr: (text) => stderr.push(text), isTty: false };
    expect(await main(["abort", taskId, "--data-dir", directory], { io })).toBe(EXIT.resumeNotApplicable);
    expect(stderr.join("")).toContain("an owner that is shutting down aborts what still runs at its drain deadline");
    // …but this connection's `abort` still stops the turn, and the drain ends.
    expect(await client.request("abort", { taskId }, "abort-during-drain")).toMatchObject({ ok: true });
    expect((await running)?.outcome).toMatchObject({ status: "stopped", error: { code: "STOPPED" } });
    await stopping;
    expect((await handle.stopped).clean).toBe(true);
  });

  it("releases the bus side of a subscription the transport dropped for backlog", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, createFixtureModel({ turns: [{ text: "x" }] }));
    const admitted = await handle.runtime.workflow?.admit({ context, operationKey: "op-b", kind: "start", prompt: "go" });
    const taskId = admitted?.taskId ?? "";
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("no owner");

    // A client that subscribes, then stops reading.
    const socket = createConnection(owner.endpoint);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const reader = new FrameReader();
    const frames: unknown[] = [];
    socket.on("data", (chunk: Buffer) => frames.push(...reader.push(chunk).frames));
    socket.write(encodeFrame({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: owner.token, sessionId: owner.sessionId }));
    await waitFor(() => frames.length > 0);
    socket.write(encodeFrame({ type: "request", requestId: "sub-stalled", command: "subscribe", payload: { taskId } }));
    await waitFor(() => handle.runtime.runEventBus.stats().subscriptions === 1);
    socket.pause();

    for (let index = 0; index < 200 && handle.runtime.runEventBus.stats().subscriptions > 0; index += 1) {
      handle.runtime.runEventBus.publish(taskId, {
        kind: "text.delta",
        runId: taskId,
        attemptId: "attempt-flood",
        blockId: "b",
        text: "f".repeat(60_000),
      });
    }
    expect(handle.runtime.runEventBus.stats().subscriptions).toBe(0);
    socket.destroy();
  });

  it("lists approval rows with their own id and round", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, createFixtureModel({ turns: [{ text: "x" }] }));
    const repositories = handle.runtime.store.asPort().repositories;
    const { task } = await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-approval",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => "task-approval")(),
      newAdmissionId: (() => "adm-approval")(),
      newThreadId: (() => "thread-approval")(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
    await repositories.approvals.request({
      approvalId: "approval:row-7",
      taskId: task.taskId,
      admissionId: "adm-approval",
      toolId: "browser.create_session",
      callId: "call-1",
      steps: 7,
      inputs: {},
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    const client = await attach(directory);
    const listed = await client.request("approvals", { action: "list", workspaceId: "default" }, "list-1");
    expect(listed.ok).toBe(true);
    const rows = (listed.result as { rows: { record: { approvalId: string; steps: number | null } }[] }).rows;
    expect(rows[0]?.record).toMatchObject({ approvalId: "approval:row-7", steps: 7 });
  });

  it("says a retained transcript that does not open with run.started is truncated", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, createFixtureModel({ turns: [{ text: "x" }] }));
    const admitted = await handle.runtime.workflow?.admit({ context, operationKey: "op-t", kind: "start", prompt: "go" });
    const taskId = admitted?.taskId ?? "";
    // The same task seen by a fresh epoch: its later events, without the start.
    const other = handle.runtime.runEventBus;
    other.forget(taskId);
    other.publish(taskId, { kind: "text.delta", runId: taskId, attemptId: "attempt-later", blockId: "b", text: "later" });
    const client = await attach(directory);
    const replay = await subscribe(client, { taskId, from: "beginning" }, "sub-late");
    expect(replay.response).toMatchObject({ ok: true, result: { truncated: true } });
  });
});
