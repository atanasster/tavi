import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RoutineCreateSchema, TaviError, routineDefaults, type ModelOutcome, type ModelPort, type RoutineFence } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient } from "../src/persistence/client.js";
import { RoutineService, RoutineExecutionService } from "../src/persistence/routine-facades.js";
import { observeRoutineModels } from "../src/routines/failures.js";

/**
 * How a routine attempt that threw is settled, through the owner's own drain:
 * a shutdown or a transient provider failure leaves the run to be resumed, and
 * a credential failure takes the grace path — none of them counts toward the
 * three-failure auto-pause (routines audit, execution findings 1 and 2).
 */
const cleanups: (() => void | Promise<void>)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});
const scope = { workspaceId: "default", principalId: "operator" };

async function fixture(dispatch: (runs: RoutineExecutionService, fence: RoutineFence) => Promise<void>, now?: () => string) {
  const directory = directories.create("tavi-routine-interruption-");
  const db = await DatabaseClient.open({ databasePath: join(directory, "db.sqlite") });
  cleanups.push(() => db.close());
  await db.call("routine.configure", {
    ownerEpoch: "owner",
    workspaces: [{ ...scope, permissions: [] }],
    toolPermissions: { web_search: [], "http.request": [] },
    destinations: [],
    providerConnectionIds: [],
    modelOverride: true,
    executionAvailable: true,
    allowedHosts: ["example.com"],
  });
  const routines = new RoutineService(db, now === undefined ? {} : { now });
  const runs: RoutineExecutionService = new RoutineExecutionService(routines, {
    ownerEpoch: "owner",
    ...(now === undefined ? {} : { now }),
    dispatch: (_run, fence) => dispatch(runs, fence),
  });
  const created = await routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("UTC"),
      operationKey: "create",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "daily", kind: "daily", at: "09:00", timezone: "UTC" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: { revision: 1, researchTools: ["web_search", "http.request"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  const routineId = created.routine.routineId;
  await routines.finishEvaluation(scope, routineId, 1, true, "fixture");
  return { db, routines, runs, routineId };
}

/** A model whose provider answers every call with the given failure. */
function failingModel(error: NonNullable<ModelOutcome["error"]>): ModelPort {
  return { stream: async (request) => ({ attemptId: request.attemptId, status: "failed", text: "", toolCalls: [], usage: {}, error }) };
}

async function callModel(models: ModelPort, fence: RoutineFence): Promise<void> {
  const outcome = await observeRoutineModels(models, fence, "research").stream(
    { attemptId: "attempt-1", connectionId: "fixture", model: "v1", messages: [], tools: [] } as never,
    { signal: new AbortController().signal, onEvent: () => {} },
  );
  if (outcome.status !== "completed") throw new TaviError("UNAVAILABLE", "Routine research workflow did not complete (failed)");
}

it("resumes a run a shutdown cut short instead of counting it as a failure", async () => {
  const entered = Promise.withResolvers<void>();
  const shutdown = Promise.withResolvers<void>();
  const f = await fixture(async () => {
    entered.resolve();
    await shutdown.promise;
    // What an aborted provider and a stopped work queue make the pipeline throw.
    throw new TaviError("UNAVAILABLE", "Background work is stopping");
  });
  const run = await f.runs.request(scope, f.routineId, "run");
  const drained = f.runs.drain();
  await entered.promise;
  f.runs.stop();
  shutdown.resolve();
  await drained;
  const interrupted = await f.runs.get(scope, run.runId);
  expect(interrupted.status).toBe("interrupted");
  expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("active");
  // The next owner's drain picks it up again.
  expect((await f.runs.pending()).map((pending) => pending.runId)).toContain(run.runId);
  const next = new RoutineExecutionService(f.routines, { ownerEpoch: "owner" });
  expect(await next.start(scope, run.runId)).toBeDefined();
  expect((await f.runs.ledger(scope, f.routineId)).map((event) => event.envelope.code)).not.toContain("failed");
});

it("never auto-pauses a routine for three shutdowns in a row", async () => {
  const f = await fixture(async () => {
    throw new Error("unused");
  });
  for (let n = 0; n < 3; n++) {
    const run = await f.runs.request(scope, f.routineId, `run-${n}`);
    // Each owner is shut down while its attempt is running.
    const owner: RoutineExecutionService = new RoutineExecutionService(f.routines, {
      ownerEpoch: "owner",
      dispatch: async () => {
        owner.stop();
        throw new TaviError("ABORTED", "The runtime is shutting down");
      },
    });
    await owner.drain();
    expect((await f.runs.get(scope, run.runId)).status).toBe("interrupted");
    // An interrupted run is live; clear it so the next occurrence is not an overlap.
    await f.runs.cancel(scope, run.runId);
  }
  expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("active");
});

it("interrupts a transiently failed attempt for retry, and records nothing against the routine", async () => {
  const f = await fixture((_runs, fence) =>
    callModel(failingModel({ code: "provider", message: "502 Bad Gateway", retryable: true }), fence),
  );
  const run = await f.runs.request(scope, f.routineId, "run");
  await f.runs.drain();
  expect((await f.runs.get(scope, run.runId)).status).toBe("interrupted");
  expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("active");
});

it("puts a routine whose provider refuses its credential on the grace path, not the failure streak", async () => {
  const f = await fixture((_runs, fence) =>
    callModel(failingModel({ code: "auth", message: "401 Unauthorized", retryable: false }), fence),
  );
  for (let n = 0; n < 3; n++) {
    const run = await f.runs.request(scope, f.routineId, `run-${n}`);
    await f.runs.drain();
    expect(await f.runs.get(scope, run.runId)).toMatchObject({ status: "failed", data: { reason: "credentials" } });
  }
  // Three daily credential failures inside the 72-hour grace: blocked, not paused.
  const routine = (await f.routines.get(scope, f.routineId)).routine;
  expect(routine.status).toBe("credential-blocked");
});

it("masks a secret the error it failed on quoted, before its page shows it", async () => {
  const f = await fixture(async () => {
    throw new Error("search refused the request: token=abc123secret rejected");
  });
  const run = await f.runs.request(scope, f.routineId, "run");
  await f.runs.drain();
  const detail = (await f.runs.get(scope, run.runId)).data.failureDetail;
  expect(detail).toContain("[redacted]");
  expect(detail).not.toContain("abc123secret");
});

it("still counts a real failure toward the auto-pause", async () => {
  const f = await fixture(async () => {
    throw new SyntaxError("Unexpected token < in JSON");
  });
  for (let n = 0; n < 3; n++) {
    const run = await f.runs.request(scope, f.routineId, `run-${n}`);
    await f.runs.drain();
    // The run keeps the error it ended on, for its page.
    expect(await f.runs.get(scope, run.runId)).toMatchObject({
      status: "failed",
      data: { reason: "failed", failureDetail: "Unexpected token < in JSON" },
    });
  }
  expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("paused-failures");
});

it.each([
  ["failed", { status: "failed", finalText: "aborted", error: { code: "ABORTED", message: "aborted" } }],
  ["stopped", { status: "stopped", finalText: "You stopped this.", error: { code: "STOPPED", message: "You stopped this." } }],
] as const)("gives a resumed attempt fresh research when the interrupted one's admission already settled %s", async (state, result) => {
  const f = await fixture(async (runs, fence) => {
    // The root admission settled before the attempt threw.
    const run = await runs.get(scope, fence.runId);
    const admitted = await f.db.repositories.tasks.admit({
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      operationKey: run.data.operationKey,
      kind: "start",
      intent: { prompt: "research" },
      checkpointNamespace: "",
      newTaskId: "task-root",
      newAdmissionId: "admission-root",
      newThreadId: "thread-root",
      now: nowTimestamp(),
      prompt: { builtin: { text: "Built in", version: "test-v1" } },
    });
    await runs.bindTask(fence, admitted.task.taskId);
    await f.db.repositories.tasks.commitAdmission({
      admissionId: admitted.admission.admissionId,
      taskId: admitted.task.taskId,
      state: state === "failed" ? "failed" : "committed",
      result,
    });
    runs.stop();
    throw new TaviError("UNAVAILABLE", "Routine research workflow did not complete (failed)");
  });
  const run = await f.runs.request(scope, f.routineId, "run");
  await f.runs.drain();
  const interrupted = await f.runs.get(scope, run.runId);
  expect(interrupted.status).toBe("interrupted");
  // Replaying `routine:<runId>` would answer the resumed attempt with the old failure.
  expect(interrupted.data.operationKey).not.toBe(run.data.operationKey);
  expect(interrupted.taskId).toBeNull();
});

it("keeps the operation key of an interrupted attempt whose admission never settled", async () => {
  const f = await fixture(async (runs) => {
    runs.stop();
    throw new TaviError("ABORTED", "The runtime is shutting down");
  });
  const run = await f.runs.request(scope, f.routineId, "run");
  await f.runs.drain();
  expect(await f.runs.get(scope, run.runId)).toMatchObject({ status: "interrupted", data: { operationKey: run.data.operationKey } });
});

/** A clock the test moves past a retry's backoff. */
function clock(start = Date.now()) {
  let at = start;
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms;
    },
  };
}
const target = { connectionId: "fixture", model: "v1" };

it("resumes research a rate limit cut short at its third call, and completes without counting a failure", async () => {
  const time = clock();
  let attempt = 0;
  const f = await fixture(async (runs, fence) => {
    attempt++;
    await runs.beginStep(fence, "research");
    if (attempt === 1) {
      await runs.reserveModel(fence, "research", "a1", 100, target);
      await runs.reserveModel(fence, "research", "a2", 100, target);
      await runs.reserveModel(fence, "research", "a3", 100, target);
      await callModel(failingModel({ code: "rate_limit", message: "429 Too Many Requests", retryable: true }), fence);
      return;
    }
    // A full research step and a synthesis call: more than the five-call budget
    // has left unless the cut short attempt's three were given back.
    for (let n = 0; n < 4; n++) await runs.reserveModel(fence, "research", `b${n}`, 100, target);
    await runs.beginStep(fence, "synthesis");
    await runs.reserveModel(fence, "synthesis", "summary", 100, target);
    await runs.finish(fence, "succeeded");
  }, time.now);
  const run = await f.runs.request(scope, f.routineId, "run");
  await f.runs.drain();
  expect(await f.runs.get(scope, run.runId)).toMatchObject({
    status: "interrupted",
    data: { transientRetries: 1, modelCalls: 3, excusedModelCalls: 3 },
  });
  // Not resumed before its backoff.
  await f.runs.drain();
  expect(attempt).toBe(1);
  time.advance(30_000);
  await f.runs.drain();
  expect(await f.runs.get(scope, run.runId)).toMatchObject({ status: "succeeded", data: { modelCalls: 8, excusedModelCalls: 3 } });
  expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("active");
  expect((await f.runs.ledger(scope, f.routineId)).map((event) => event.envelope.code)).not.toContain("failed");
});

it("retries a transient failure three times, and counts the fourth as a failure", async () => {
  const time = clock();
  let attempts = 0;
  const f = await fixture(async (_runs, fence) => {
    attempts++;
    await callModel(failingModel({ code: "provider", message: "503 Service Unavailable", retryable: true }), fence);
  }, time.now);
  const run = await f.runs.request(scope, f.routineId, "run");
  for (let n = 1; n <= 3; n++) {
    await f.runs.drain();
    expect(await f.runs.get(scope, run.runId)).toMatchObject({ status: "interrupted", data: { transientRetries: n } });
    time.advance(5 * 60_000);
  }
  await f.runs.drain();
  expect(attempts).toBe(4);
  expect(await f.runs.get(scope, run.runId)).toMatchObject({
    status: "failed",
    // With the error that cut the last attempt short.
    data: {
      reason: "failed",
      failureDetail: expect.stringMatching(
        /^A model or search provider failed 4 times in a row; the run stopped retrying\. The last error: \S/,
      ),
    },
  });
});

it("retries an attempt that ran out of budget after an excused one, rather than failing it", async () => {
  const time = clock();
  let attempt = 0;
  const f = await fixture(async (runs, fence) => {
    attempt++;
    await runs.beginStep(fence, "research");
    if (attempt === 1) {
      await runs.reserveModel(fence, "research", "a1", 100, target);
      await callModel(failingModel({ code: "rate_limit", message: "429 Too Many Requests", retryable: true }), fence);
      return;
    }
    // One more research call than the budget allows: this attempt runs out.
    const { modelCalls } = (await runs.get(scope, fence.runId)).snapshot.execution;
    for (let n = 0; n < modelCalls; n++) await runs.reserveModel(fence, "research", `b${attempt}-${n}`, 100, target);
  }, time.now);
  const run = await f.runs.request(scope, f.routineId, "run");
  await f.runs.drain();
  time.advance(60_000);
  await f.runs.drain();
  expect(await f.runs.get(scope, run.runId)).toMatchObject({ status: "interrupted", data: { transientRetries: 2 } });
  expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("active");
});
