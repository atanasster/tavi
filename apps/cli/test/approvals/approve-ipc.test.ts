import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { join } from "node:path";

import {
  IPC_EXECUTION_BUSY,
  IPC_NOT_PENDING,
  approvalRoundKey,
  approvalRowId,
  pendingRoundOf,
  resumeIntentIdentity,
  type ClientEvent,
  type InvocationContext,
  type ModelOutcome,
  type ModelPort,
} from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * IPC `approve`: a round decided by `verdict` or by its
 * complete `decisions`, under the round's own key with the round as the in-queue
 * precondition, answered once the decision is claimed.
 */

const directories = temporaryDirectories({ prefix: "tavi-approve-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

/**
 * A model that asks, per turn, for the gated calls listed (each id one
 * `browser.create_session` call), then answers.
 */
function turnsModel(
  turns: readonly (readonly string[])[],
  /** Hold the model call with this index (0-based) until the promise settles. */
  hold?: { readonly call: number; readonly until: Promise<void> },
): ModelPort & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async stream(request): Promise<ModelOutcome> {
      const turn = turns[calls];
      const index = calls;
      calls += 1;
      if (hold !== undefined && index === hold.call) await hold.until;
      if (turn === undefined) {
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      }
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: "",
        toolCalls: turn.map((id) => ({ id, name: "browser.create_session", input: {} })),
        finishReason: "tool-calls",
        usage: {},
      };
    },
  };
}

async function startServe(directory: string, model: ModelPort | undefined): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "fixture-conn" }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quietIo,
    { ...(model === undefined ? {} : { modelOverride: model }), browserOverride: createFixtureBrowser() },
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

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };

/** Start a task under the owner and return it suspended on its first round. */
async function suspended(handle: ServeHandle, operationKey = "op-start"): Promise<string> {
  const workflow = handle.runtime.workflow;
  if (workflow === undefined) throw new Error("no workflow");
  const started = await workflow.admit({ context, operationKey, kind: "start", prompt: "open a browser" });
  expect(started.outcome.status).toBe("waiting");
  return started.taskId;
}

/** Subscribe to a task's stream from its beginning and collect what arrives. */
async function watch(client: IpcClient, taskId: string): Promise<ClientEvent[]> {
  const events: ClientEvent[] = [];
  let subscriptionId: string | undefined;
  client.onEvent((frame) => {
    if (frame.subscriptionId === subscriptionId) events.push(frame.event);
  });
  await client.request("subscribe", { taskId, from: "beginning" }, `sub-${taskId}`, {
    onResponse: (answer) => {
      subscriptionId = (answer.result as { subscriptionId?: string } | undefined)?.subscriptionId;
    },
  });
  return events;
}

const statusOf = async (handle: ServeHandle, taskId: string) =>
  (await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status;

describe("IPC approve", () => {
  it("decides a two-call round by verdict, answers on the claim, and announces the settled round", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a", "call-b"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);
    const events = await watch(client, taskId);

    const response = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" }, "approve-1");
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    expect(response.result).toMatchObject({
      taskId,
      steps: 1,
      operationKey: approvalRoundKey(taskId, 1),
      replayed: false,
      decisions: [
        { callId: "call-a", approved: true },
        { callId: "call-b", approved: true },
      ],
    });

    await waitFor(() => events.some((event) => event.kind === "task.completed"));
    const kinds = events.map((event) => event.kind);
    // The decision, then the turn it resumed.
    expect(kinds).toContain("approval.required");
    expect(kinds.indexOf("approval.settled")).toBeGreaterThan(kinds.lastIndexOf("approval.required"));
    expect(kinds.indexOf("approval.settled")).toBeLessThan(kinds.indexOf("attempt.replaced"));
    expect(events.find((event) => event.kind === "approval.settled")).toMatchObject({
      steps: 1,
      decisions: [
        { callId: "call-a", approved: true },
        { callId: "call-b", approved: true },
      ],
      decidedBy: "operator",
    });
    expect(await statusOf(handle, taskId)).toBe("completed");
  });

  it("decides a mixed round by its complete decisions", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a", "call-b"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    const response = await client.request(
      "approve",
      {
        taskId,
        workspaceId: "default",
        expectedSteps: 1,
        decisions: [
          { callId: "call-b", approved: false, note: "not that one" },
          { callId: "call-a", approved: true },
        ],
        decidedBy: "alice",
      },
      "approve-mixed",
    );
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    const approvals = handle.runtime.store.asPort().repositories.approvals;
    expect(await approvals.get(approvalRowId(taskId, "call-a", 1))).toMatchObject({ state: "granted", decidedBy: "alice" });
    expect(await approvals.get(approvalRowId(taskId, "call-b", 1))).toMatchObject({ state: "denied", note: "not that one" });
  });

  it("refuses a partial or repeated decision set before admitting anything", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a", "call-b"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    const partial = await client.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, decisions: [{ callId: "call-a", approved: true }] },
      "partial",
    );
    expect(partial.error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("missing call-b") });
    const repeated = await client.request(
      "approve",
      {
        taskId,
        workspaceId: "default",
        decisions: [
          { callId: "call-a", approved: true },
          { callId: "call-a", approved: false },
        ],
      },
      "repeated",
    );
    expect(repeated.error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("repeated: call-a") });
    // No admission burned the round key: a correct decision still goes through.
    expect(await handle.runtime.store.asPort().repositories.tasks.getAdmission(taskId, approvalRoundKey(taskId, 1))).toBeUndefined();
    expect(await statusOf(handle, taskId)).toBe("waiting");
    const complete = await client.request("approve", { taskId, workspaceId: "default", verdict: "reject" }, "complete");
    expect(complete.ok, JSON.stringify(complete.error)).toBe(true);
  });

  it("makes two identical decisions one admission while the round runs, and refuses a differing one", async () => {
    // The resumed turn is held in its model call, so the second and third
    // decisions arrive while the first is claimed and running.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"]], { call: 1, until: held }));
    const taskId = await suspended(handle);
    const first = await attach(directory);
    const second = await attach(directory);
    const third = await attach(directory);

    const a = await first.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve", decidedBy: "alice" },
      "a",
    );
    expect(a.ok, JSON.stringify(a.error)).toBe(true);
    expect(a.result).toMatchObject({ replayed: false });
    // The same decision while the first one's turn is still running: answered at
    // once, not after that whole turn — the turn is held for as long as the test
    // likes, which a client's request timeout would not survive.
    const b = await second.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve", decidedBy: "bob" },
      "b",
    );
    expect(b.ok, JSON.stringify(b.error)).toBe(true);
    expect(b.result).toMatchObject({ replayed: true });
    expect((b.result as { status?: string }).status).toBeUndefined();
    const c = await third.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "reject" }, "c");
    expect(c.error?.code).toBe("CONFLICT");
    release();
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    const keys = (await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).map((admission) => admission.operationKey);
    expect(keys.filter((key) => key === approvalRoundKey(taskId, 1))).toHaveLength(1);
    // The first writer's attribution is the one recorded.
    expect((await handle.runtime.store.asPort().repositories.approvals.get(approvalRowId(taskId, "call-a", 1)))?.decidedBy).toBe("alice");

    // A retry after the task moved on still names its round: the same decision
    // replays, and a different one conflicts rather than finding "nothing pending".
    const retried = await first.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" }, "retry");
    expect(retried.result).toMatchObject({ replayed: true });
    const changed = await first.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "reject" }, "changed");
    expect(changed.error?.code).toBe("CONFLICT");
    // Without a round, there is simply nothing pending.
    const unnamed = await first.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "unnamed");
    expect(unnamed.error?.code).toBe(IPC_NOT_PENDING);
  });

  it("refuses a stale round, leaving the task waiting, and never applies it to a reused call id's next round", async () => {
    // The same provider call id in both rounds: a decision meant for round 1
    // must not be applied to round 2.
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-1"], ["call-1"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    // `once`: a browser round approved with no scope is allowed for the task, and asks no round 2.
    const round1 = await client.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve", scope: "once" },
      "r1",
    );
    expect(round1.ok, JSON.stringify(round1.error)).toBe(true);
    await waitFor(async () => pendingRoundOf(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId))?.steps === 2);

    // Round 1 was committed under its key, so a different verdict for it
    // conflicts with the record — it is never taken for round 2's.
    const stale = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "reject" }, "stale");
    expect(stale.error?.code).toBe("CONFLICT");
    expect(await statusOf(handle, taskId)).toBe("waiting");
    const approvals = handle.runtime.store.asPort().repositories.approvals;
    expect((await approvals.get(approvalRowId(taskId, "call-1", 2)))?.state).toBe("pending");

    const round2 = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 2, verdict: "reject" }, "r2");
    expect(round2.ok, JSON.stringify(round2.error)).toBe(true);
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    expect((await approvals.get(approvalRowId(taskId, "call-1", 1)))?.state).toBe("granted");
    expect((await approvals.get(approvalRowId(taskId, "call-1", 2)))?.state).toBe("denied");
  });

  it("refuses a round decided elsewhere under another key without admitting anything", async () => {
    // Round 1 was decided under a key of its own (an offline `--operation-key`),
    // so nothing is recorded under round 1's key: the round the client saw is
    // simply no longer the one pending, and that is said before any admission.
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"], ["call-b"]]));
    const taskId = await suspended(handle);
    await handle.runtime.workflow?.admit({
      context: { ...context, runId: taskId },
      taskId,
      operationKey: "offline-key",
      kind: "approval",
      resume: { decisions: [{ callId: "call-a", approved: true, scope: "once" }], expectedSteps: 1 },
    });
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    expect(pendingRoundOf(await tasks.listAdmissions(taskId))?.steps).toBe(2);
    const admissions = (await tasks.listAdmissions(taskId)).length;

    const client = await attach(directory);
    const stale = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" }, "stale");
    expect(stale.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("no longer pending") });
    // How the round was settled rides along, for a page to say so.
    expect(stale.error?.details).toMatchObject({ settled: { taskId, steps: 1, state: "granted" } });
    expect(await tasks.listAdmissions(taskId)).toHaveLength(admissions);
    expect(await statusOf(handle, taskId)).toBe("waiting");
  });

  it("refuses a schedule's round while its fire is in flight, and decides it once the fire has ended", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);
    const leave = handle.runtime.scheduleFires.enter(taskId, "sched-brief");

    const refused = await client.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "in-flight");
    expect(refused.error).toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringContaining("sched-brief") });
    expect(await statusOf(handle, taskId)).toBe("waiting");

    leave();
    const decided = await client.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "after");
    expect(decided.ok, JSON.stringify(decided.error)).toBe(true);
  });

  it("decides the round a real fire left pending when the owner stopped under it, on the next owner", async () => {
    // A real fire, in flight when the owner stops: its first turn finishes
    // inside the drain and suspends on a round, then the fire's own decision is
    // refused — admission is closed — and the fire dies with the round pending
    // on a schedule-origin task.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const model = turnsModel([["call-a"]], { call: 0, until: held });
    const directory = directories.create();
    const first = await startServe(directory, model);
    const repositories = first.runtime.store.asPort().repositories;
    await repositories.schedules.create({
      scheduleId: "sched-brief",
      workspaceId: "default",
      principalId: "operator",
      name: "brief",
      prompt: "open a browser",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "skip",
      autoApproveTools: ["browser.create_session"],
      enabled: true,
      nextRunAt: "2030-01-01T07:00:00.000Z",
      now: "2026-01-01T00:00:00.000Z",
    });
    const fired = await (await attach(directory)).request("schedules", { action: "run", scheduleId: "sched-brief" }, "fire", {
      timeoutMs: 15_000,
    });
    expect(fired.ok, JSON.stringify(fired.error)).toBe(true);
    const { taskId } = fired.result as { taskId: string };
    await waitFor(() => model.calls() === 1);
    expect(first.runtime.scheduleFires.scheduleOf(taskId)).toBe("sched-brief");

    const stopping = first.shutdown("restart under a fire");
    release();
    await stopping;
    await first.stopped;
    handles.splice(handles.indexOf(first), 1);

    // The next owner: the fire is gone, its round is not.
    const next = await startServe(directory, turnsModel([]));
    const tasks = next.runtime.store.asPort().repositories.tasks;
    expect(await tasks.get(taskId)).toMatchObject({ origin: "schedule", status: "waiting" });
    expect(pendingRoundOf(await tasks.listAdmissions(taskId))?.steps).toBe(1);
    expect(next.runtime.scheduleFires.scheduleOf(taskId)).toBeUndefined();
    const decided = await (await attach(directory)).request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" },
      "after-death",
    );
    expect(decided.ok, JSON.stringify(decided.error)).toBe(true);
    await waitFor(async () => (await statusOf(next, taskId)) === "completed");
  });

  it("answers NOT_PENDING when there is nothing to decide, and checks the workspace", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    const elsewhere = await client.request("approve", { taskId, workspaceId: "other", verdict: "approve" }, "ws");
    expect(elsewhere.error?.code).toBe("INVALID_INPUT");
    // As the offline command answers it (exit 8): nothing to decide.
    const unknown = await client.request("approve", { taskId: "task-none", workspaceId: "default", verdict: "approve" }, "none");
    expect(unknown.error?.code).toBe(IPC_NOT_PENDING);

    const cancelled = await client.request("cancel", { taskId, reason: "not needed" }, "cancel");
    expect(cancelled.ok).toBe(true);
    const afterCancel = await client.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "late");
    expect(afterCancel.error).toMatchObject({ code: IPC_NOT_PENDING, message: expect.stringContaining("cancelled") });
    expect(await statusOf(handle, taskId)).toBe("cancelled");
  });

  it("decides through `approvals approve|reject` with the offline command's semantics", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a", "call-b"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    // A call id can only assert the round's one call; this round has two.
    const narrowed = await client.request("approvals", { action: "approve", taskId, callId: "call-a" }, "narrow");
    expect(narrowed.error?.code).toBe("INVALID_INPUT");
    const decided = await client.request("approvals", { action: "reject", taskId, decidedBy: "bob" }, "reject");
    expect(decided.ok, JSON.stringify(decided.error)).toBe(true);
    expect(decided.result).toMatchObject({ steps: 1, operationKey: approvalRoundKey(taskId, 1) });
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    expect(await handle.runtime.store.asPort().repositories.approvals.get(approvalRowId(taskId, "call-b", 1))).toMatchObject({
      state: "denied",
      decidedBy: "bob",
    });
  });

  it("re-admits a round a crash left decided but uncommitted under its key, once the dead lease is recovered", async () => {
    // Crash point 1: `decide()` ran inside the resumed node, then the
    // process died — rows settled, the admission under the round key claimed
    // with no result, and a lease from a session that no longer exists.
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"]]));
    const taskId = await suspended(handle);
    const port = handle.runtime.store.asPort();
    const now = () => handle.runtime.clock.now();
    const decision = { decisions: [{ callId: "call-a", approved: true }] };
    const crashed = await port.repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      taskId,
      operationKey: approvalRoundKey(taskId, 1),
      kind: "approval",
      intent: { resume: resumeIntentIdentity(decision) },
      checkpointNamespace: "",
      newTaskId: (() => taskId)(),
      newAdmissionId: (() => "adm-crashed")(),
      newThreadId: (() => "unused")(),
      now: now(),
    });
    await port.repositories.tasks.setAdmissionState(crashed.admission.admissionId, "claimed");
    await port.repositories.approvals.decide({
      approvalId: approvalRowId(taskId, "call-a", 1),
      state: "granted",
      decidedBy: "operator",
      now: { fixed: now() },
    });
    const dead = await port.repositories.executions.acquire({
      taskId,
      ownerSession: "session-dead",
      admissionId: "adm-crashed",
      leaseMs: 60 * 60 * 1000,
      now: { fixed: now() },
    });

    const client = await attach(directory);
    // Not a conflict: the round is still pending, and the answer says how to free it.
    const busy = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" }, "busy");
    expect(busy.error).toMatchObject({
      code: IPC_EXECUTION_BUSY,
      message: expect.stringContaining(`tavi recover ${taskId} --generation ${dead.generation}`),
    });
    expect(await statusOf(handle, taskId)).toBe("waiting");

    const recovered = await client.request("recover", { taskId, generation: dead.generation, reason: "the owner crashed" }, "recover");
    expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
    const resumed = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" }, "again");
    expect(resumed.ok, JSON.stringify(resumed.error)).toBe(true);
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    expect((await port.repositories.tasks.getAdmission(taskId, approvalRoundKey(taskId, 1)))?.state).toBe("committed");
  });

  it("continues from the checkpoint when a crash left the thread past the round it decided", async () => {
    // Crash point 2: the resumed turn wrote its checkpoint — the thread
    // is suspended on round 2 — and died before committing. Re-admitting the
    // round-1 decision must not hand it to round 2's interrupt: with a reused
    // call id it would decide round 2 with round 1's verdict.
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-1"], ["call-1"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);
    const round1 = await client.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve", scope: "once" },
      "r1",
    );
    expect(round1.ok, JSON.stringify(round1.error)).toBe(true);
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    await waitFor(async () => pendingRoundOf(await tasks.listAdmissions(taskId))?.steps === 2);

    // Undo the commit, as the crash would have left it.
    inspectDatabase(handle.runtime.store)
      .prepare("UPDATE tavi_admissions SET result = NULL, state = 'claimed' WHERE task_id = ? AND operation_key = ?")
      .run(taskId, approvalRoundKey(taskId, 1));
    expect(pendingRoundOf(await tasks.listAdmissions(taskId))?.steps).toBe(1);

    const again = await client.request(
      "approve",
      { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve", scope: "once" },
      "again",
    );
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    await waitFor(async () => (await tasks.getAdmission(taskId, approvalRoundKey(taskId, 1)))?.result !== null);
    // The admission records where the thread actually is: round 2, still undecided.
    expect(pendingRoundOf(await tasks.listAdmissions(taskId))?.steps).toBe(2);
    expect(await statusOf(handle, taskId)).toBe("waiting");
    expect((await handle.runtime.store.asPort().repositories.approvals.get(approvalRowId(taskId, "call-1", 2)))?.state).toBe("pending");
  });

  it("decides by approval row id alone, and refuses a row that is not the round's one call", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"], ["call-b"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    const unknown = await client.request(
      "approvals",
      { action: "approve", approvalId: approvalRowId("task-none", "call-a", 1) },
      "unknown",
    );
    expect(unknown.error?.code).toBe("NOT_FOUND");
    const mismatched = await client.request(
      "approvals",
      { action: "approve", taskId, approvalId: approvalRowId(taskId, "call-a", 1), callId: "call-z" },
      "mismatched",
    );
    expect(mismatched.error?.code).toBe("INVALID_INPUT");
    const byRow = await client.request(
      "approvals",
      { action: "approve", approvalId: approvalRowId(taskId, "call-a", 1), scope: "once" },
      "by-row",
    );
    expect(byRow.ok, JSON.stringify(byRow.error)).toBe(true);
    expect(byRow.result).toMatchObject({ steps: 1, decisions: [{ callId: "call-a", approved: true }] });
    await waitFor(async () => pendingRoundOf(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId))?.steps === 2);
    // Round 1's row is not round 2's.
    const stale = await client.request("approvals", { action: "approve", approvalId: approvalRowId(taskId, "call-a", 1) }, "stale-row");
    expect(stale.error?.code).toBe(IPC_NOT_PENDING);
    // The row's own round, as it was settled: by whom, when, through what.
    expect(stale.error?.details).toMatchObject({
      settled: {
        taskId,
        steps: 1,
        state: "granted",
        decidedBy: "operator",
        decidedAt: expect.any(String),
        via: "cli",
        channel: "terminal",
      },
    });
  });

  it("lists the pending round enriched and the decided one in the history", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"], ["call-b"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);

    const listed = await client.request("approvals", { action: "list", workspaceId: "default" }, "list");
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.result).toMatchObject({
      truncated: false,
      rows: [
        {
          record: { taskId, callId: "call-a", steps: 1 },
          task: { workspaceId: "default", principalId: "operator" },
          taskTitle: "open a browser",
          principalId: "operator",
        },
      ],
    });
    expect(JSON.stringify(listed.result)).not.toContain('"inputs"');
    // The round went to no chat, and its risk is recorded all the same: the
    // inbox offers the scopes the call's own card offers, not `once` alone.
    expect(listed.result).toMatchObject({ rows: [{ risk: "low", allowedScopes: ["once", "session", "always"] }] });
    expect((listed.result as { rows: object[] }).rows[0]).not.toHaveProperty("announcedIn");
    // An ordinary run's chat grant lasts the chat: no "Allow until tomorrow".
    expect((listed.result as { rows: object[] }).rows[0]).not.toHaveProperty("lastingChat");
    // Another workspace's queue is its own.
    const elsewhere = await client.request("approvals", { action: "list", workspaceId: "other" }, "list-other");
    expect(elsewhere.result).toMatchObject({ rows: [], truncated: false });
    // `tavi approvals list` on the owner prints text by default, as offline and as its help says; JSON when asked.
    const listedBy = async (...flags: string[]) => {
      let out = "";
      const code = await main(["approvals", "list", ...flags, "--data-dir", directory], {
        io: { stdout: (chunk) => (out += chunk), stderr: () => {}, isTty: false },
      });
      return { code, out };
    };
    const listText = await listedBy();
    expect(listText.code).toBe(EXIT.ok);
    expect(listText.out).toMatch(new RegExp(`^${taskId}\\tbrowser\\.create_session\\tcall-a\\tdefault\\toperator\\t\\S+\\n$`));
    expect(JSON.parse((await listedBy("--format", "json")).out)).toEqual(listed.result);
    let shownOut = "";
    expect(
      await main(["approvals", "show", taskId, "--data-dir", directory], {
        io: { stdout: (chunk) => (shownOut += chunk), stderr: () => {}, isTty: false },
      }),
    ).toBe(EXIT.ok);
    expect(shownOut).toMatch(/^round 1\ttoken /);

    const decided = await client.request("approvals", { action: "approve", taskId, scope: "once", decidedBy: "ana" }, "approve");
    expect(decided.ok, JSON.stringify(decided.error)).toBe(true);
    await waitFor(async () => pendingRoundOf(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId))?.steps === 2);

    const history = await client.request("approvals", { action: "history", workspaceId: "default", kinds: ["approval"] }, "history");
    expect(history.ok, JSON.stringify(history.error)).toBe(true);
    expect(history.result).toEqual({
      items: [
        expect.objectContaining({
          kind: "approval",
          taskId,
          toolId: "browser.create_session",
          state: "granted",
          decidedBy: "ana",
          taskTitle: "open a browser",
          via: "cli",
          channel: "terminal",
          scope: "once",
        }),
      ],
    });
    const refused = await client.request("approvals", { action: "history", limit: 101 }, "history-too-many");
    expect(refused.error?.code).toBe("INVALID_INPUT");

    // `tavi approvals history` on the owner prints what it prints offline:
    // one line per decision in text, the owner's answer in JSON.
    const printed = async (...flags: string[]) => {
      let out = "";
      const code = await main(["approvals", "history", "--kind", "approval", ...flags, "--data-dir", directory], {
        io: {
          stdout: (chunk) => (out += chunk),
          stderr: () => {},
          isTty: false,
        },
      });
      return { code, out };
    };
    const text = await printed();
    expect(text.code).toBe(EXIT.ok);
    expect(text.out).toMatch(new RegExp(`^\\S+\\tapproval\\tgranted\\t${taskId}\\tbrowser\\.create_session\\tana\\tterminal\\tonce\\n$`));
    expect(JSON.parse((await printed("--format", "json")).out)).toEqual(history.result);
    // Filtered by tool and by person on the owner too.
    expect((await printed("--tool", "browser.create_session")).out).toContain(taskId);
    expect((await printed("--tool", "sandbox.run")).out).toBe("(no decisions yet)\n");
    expect((await printed("--principal", "operator")).out).toContain(taskId);
    expect((await printed("--principal", "alice")).out).toBe("(no decisions yet)\n");
  });

  it("answers NOT_PENDING for a task waiting on an artifact review, pointing at the command that decides it", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"]]));
    const taskId = await suspended(handle);
    const review = {
      status: "waiting",
      finalText: "",
      reviewInterrupt: { requests: [{ artifactId: "art-1", callId: "call-a", toolName: "sandbox.run", steps: 1 }] },
    };
    inspectDatabase(handle.runtime.store)
      .prepare("UPDATE tavi_admissions SET result = ? WHERE task_id = ? AND operation_key = 'op-start'")
      .run(JSON.stringify(review), taskId);
    const client = await attach(directory);
    const response = await client.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "review");
    expect(response.error).toMatchObject({ code: IPC_NOT_PENDING, message: expect.stringContaining("`review`") });
  });

  it("reports a decision the cancellation answered as cancelled, however often it is retried", async () => {
    // A cancellation that lands between the handler's check and the adapter's
    // commits the round's key as `failed`/`CANCELLED`: that decided nothing.
    const directory = directories.create();
    const handle = await startServe(directory, turnsModel([["call-a"]]));
    const taskId = await suspended(handle);
    const client = await attach(directory);
    expect((await client.request("cancel", { taskId, reason: "stop" }, "cancel")).ok).toBe(true);
    await handle.runtime.workflow?.admit({
      context: { ...context, runId: taskId },
      taskId,
      operationKey: approvalRoundKey(taskId, 1),
      kind: "approval",
      resume: { decisions: [{ callId: "call-a", approved: true }], expectedSteps: 1 },
    });
    const retried = await client.request("approve", { taskId, workspaceId: "default", expectedSteps: 1, verdict: "approve" }, "retry");
    expect(retried.error?.code).toBe("CANCELLED");
    expect(await statusOf(handle, taskId)).toBe("cancelled");
  });

  it("answers UNAVAILABLE when the owner has no model connection", async () => {
    const directory = directories.create();
    await startServe(directory, undefined);
    const client = await attach(directory);
    const response = await client.request("approve", { taskId: "task-1", workspaceId: "default", verdict: "approve" }, "no-model");
    expect(response.error?.code).toBe("UNAVAILABLE");
  });

  it("leaves nothing for the offline command once a round was decided over IPC", async () => {
    const directory = directories.create();
    const model = turnsModel([["call-a"]]);
    const handle = await startServe(directory, model);
    const taskId = await suspended(handle);
    const client = await attach(directory);
    const decided = await client.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "decide");
    expect(decided.ok, JSON.stringify(decided.error)).toBe(true);
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    const admissionsBefore = (await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).length;
    client.close();
    clients.pop();
    await handles.pop()?.shutdown("test: the daemon stops");

    let stderr = "";
    const code = await main(
      ["approvals", "approve", taskId, "--connection", "fixture-conn", "--model", "fixture-model", "--data-dir", directory],
      {
        io: { stdout: () => {}, stderr: (chunk) => (stderr += chunk), isTty: false },
        runtimeFactory: async (options, overrides) =>
          (await import("../../src/runtime/composition.js")).composeTaviRuntime(options, { ...overrides, modelOverride: model }),
      },
    );
    expect(code, stderr).toBe(EXIT.resumeNotApplicable);
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect(await store.asPort().repositories.tasks.listAdmissions(taskId)).toHaveLength(admissionsBefore);
    } finally {
      store.close();
    }
  });
});
