import { asyncRoutineEffects } from "./async-routine-effects.js";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineCreateSchema, routineDefaults, routineTriggerNext, type RoutineFence, type RoutineTrigger } from "@tavi/contracts";
import { ToolRegistry, routineResearchTools } from "@tavi/runtime";
import { RoutineExecutionService, routineRunLateNote } from "../src/routines/runs.js";
import { RoutineRunDrain } from "../src/routines/drain.js";
import { RoutineService } from "../src/routines/service.js";
import { RoutineNewsService } from "../src/routines/news.js";
import { SqliteStore } from "../src/persistence/store.js";
import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { join } from "node:path";
import Database from "better-sqlite3";
import { temporaryDirectories } from "@tavi/test-support";
const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});
const scope = { workspaceId: "default", principalId: "operator" };
function fixture(
  setup: {
    readonly triggers?: readonly RoutineTrigger[];
    readonly engine?: boolean;
    readonly catchUpHours?: number;
    readonly detailDays?: number;
  } = {},
) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  let now = "2026-09-20T06:00:00.000Z";
  let authorized = true;
  let ready = true;
  const routines = new RoutineService(store, {
    executionAvailable: true,
    now: () => now,
    nextOccurrence: setup.engine === true ? routineTriggerNext : (trigger) => (trigger.kind === "once" ? null : "2026-09-21T06:00:00.000Z"),
  });
  const defaults = routineDefaults("Europe/Sofia");
  const raw = RoutineCreateSchema.parse({
    ...defaults,
    execution: { ...defaults.execution, catchUpHours: setup.catchUpHours ?? defaults.execution.catchUpHours },
    retention: { ...defaults.retention, detailDays: setup.detailDays ?? defaults.retention.detailDays },
    operationKey: "create",
    name: "News",
    objective: "Find news",
    agent: { agentId: "news", name: "News", instructions: "Find evidence" },
    triggers: setup.triggers ?? [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
    skills: [],
    models: {
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [{ connectionId: "fallback", model: "v2" }] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    },
    permissions: {
      revision: 1,
      researchTools: ["web_search", "http.request", "messaging.send_to"],
      allowedHosts: ["example.com"],
      networkMode: "allowlist",
    },
  });
  const created = routines.create(scope, raw);
  routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  const options = {
    now: () => now,
    authorized: () => authorized,
    researchReady: () => (ready ? { ready: true as const } : { ready: false as const, code: "credentials" as const, retryable: true }),
  };
  const runs = new RoutineExecutionService(routines, { ...options, ownerEpoch: "one" });
  const schedules = store.asPort().repositories.schedules;
  const schedule = schedules.list(scope.workspaceId)[0]!;
  schedules.setEnabled({ scheduleId: schedule.scheduleId, enabled: true, nextRunAt: now, now });
  return {
    store,
    routines,
    runs,
    options,
    id: created.routine.routineId,
    schedule: schedules.get(schedule.scheduleId)!,
    setNow: (value: string) => {
      now = value;
    },
    revoke: () => {
      authorized = false;
    },
    unready: () => {
      ready = false;
    },
  };
}
it("claims a recurring trigger's last occurrence, then consumes it, and completes the routine it was the last of", () => {
  // 09:00 Sofia on the 21st (06:00Z) is the last run before `until`.
  const f = fixture({
    engine: true,
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia", until: "2026-09-21" }],
  });
  const schedules = f.store.asPort().repositories.schedules;
  schedules.setEnabled({
    scheduleId: f.schedule.scheduleId,
    enabled: true,
    nextRunAt: "2026-09-21T06:00:00.000Z",
    now: "2026-09-20T06:00:00.000Z",
  });
  f.setNow("2026-09-21T06:00:00.000Z");
  const run = f.runs.claim(schedules.get(f.schedule.scheduleId)!, "2026-09-21T06:00:00.000Z");
  expect(run).toBeDefined();
  const row = f.store.handle.prepare("SELECT consumed FROM tavi_routine_triggers WHERE routine_id=?").get(f.id) as { consumed: number };
  expect(row.consumed).toBe(1);
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)).toMatchObject({ enabled: false, nextRunAt: null });
  expect(f.routines.get(scope, f.id).routine.status).toBe("completed");
});
it("completes a routine resumed after its ending trigger ran out while it was paused", () => {
  const f = fixture({
    engine: true,
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia", until: "2026-09-22" }],
  });
  f.routines.setStatus(scope, f.id, f.routines.get(scope, f.id).routine.version, "paused");
  f.setNow("2026-09-25T06:00:00.000Z");
  const resumed = f.routines.setStatus(scope, f.id, f.routines.get(scope, f.id).routine.version, "active");
  expect(resumed.routine.status).toBe("completed");
  const row = f.store.handle.prepare("SELECT consumed FROM tavi_routine_triggers WHERE routine_id=?").get(f.id) as { consumed: number };
  expect(row.consumed).toBe(1);
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)).toMatchObject({ enabled: false, nextRunAt: null });
});
it("completes a routine activated with ending triggers that have no fire left", () => {
  const f = fixture({
    engine: true,
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia", until: "2026-09-22" }],
  });
  f.setNow("2026-09-25T06:00:00.000Z");
  const current = f.routines.get(scope, f.id);
  const edited = f.routines.update(scope, {
    routineId: f.id,
    operationKey: "ended",
    expectedVersion: current.routine.version,
    changeSummary: "Ends earlier",
    snapshot: {
      ...current.revision.snapshot,
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia", until: "2026-09-23" }],
    },
  });
  const activated = f.routines.finishEvaluation(scope, f.id, edited.routine.latestRevision, true, "pass");
  expect(activated.routine).toMatchObject({ status: "completed", activeRevision: edited.routine.latestRevision });
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)).toMatchObject({ enabled: false, nextRunAt: null });
});
it("atomically claims one occurrence, survives admission gaps, and fences previous-owner work", () => {
  const f = fixture();
  f.store.handle.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON tavi_routine_runs BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(() => f.runs.claim(f.schedule, f.schedule.nextRunAt!)).toThrow(/injected/);
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)?.nextRunAt).toBe(f.schedule.nextRunAt);
  f.store.handle.exec("DROP TRIGGER fail_claim");
  const run = f.runs.claim(f.schedule, f.schedule.nextRunAt!)!;
  expect(f.runs.claim(f.schedule, f.schedule.nextRunAt!)).toBeUndefined();
  expect(f.runs.pending()[0]?.runId).toBe(run.runId);
  // A claimed fire that is not skipped is the trigger's last run.
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)?.lastRunAt).toBe(f.schedule.nextRunAt);
  const fence = f.runs.start(scope, run.runId)!;
  const restarted = new RoutineExecutionService(f.routines, { ...f.options, ownerEpoch: "two" });
  expect(restarted.recoverPreviousOwner()).toBe(1);
  expect(() => f.runs.finish(fence, "succeeded")).toThrow(/fenced/);
  const newFence = restarted.start(scope, run.runId)!;
  expect(newFence.generation).toBeGreaterThan(fence.generation);
  expect(restarted.get(scope, run.runId).data.operationKey).toBe(run.data.operationKey);
  restarted.finish(newFence, "succeeded");
  expect(restarted.history(scope, f.id)).toHaveLength(1);
  expect(restarted.verify(scope, f.id).valid).toBe(true);
});
it("accounts every provider fallback and tool under the same run and reserves synthesis", () => {
  const f = fixture();
  const run = f.runs.request(scope, f.id, "manual");
  const fence = f.runs.start(scope, run.runId)!;
  f.runs.beginStep(fence, "research");
  // Research may use every model call but the one held back for synthesis.
  const { modelCalls } = f.runs.get(scope, run.runId).snapshot.execution;
  for (let n = 0; n < modelCalls - 1; n++) {
    f.runs.reserveModel(
      fence,
      "research",
      `call${n}`,
      100,
      n % 2 ? { connectionId: "fallback", model: "v2" } : { connectionId: "fixture", model: "v1" },
    );
    f.runs.settleModel(fence, `call${n}`, n === 0 ? undefined : 50);
  }
  expect(() => f.runs.reserveModel(fence, "research", "excess", 100, { connectionId: "fixture", model: "v1" })).toThrow(/budget/);
  f.runs.reserveModel(fence, "synthesis", "summary", 100, { connectionId: "fixture", model: "v1" });
  expect(() => f.runs.reserveModel(fence, "synthesis", "more", 100, { connectionId: "fixture", model: "v1" })).toThrow(/budget/);
  f.runs.reserveTool(fence, "http.request", "https://example.com/path?token=secret");
  expect(() => f.runs.reserveTool(fence, "messaging.send_to")).toThrow(/grant/);
  expect(() => f.runs.reserveTool(fence, "http.request", "https://evil.test/")).toThrow(/Host/);
  expect(JSON.stringify(f.runs.ledger(scope, f.id))).not.toContain("secret");
  expect(f.runs.get(scope, run.runId).data).toMatchObject({
    modelCalls,
    toolCalls: 1,
    usageComplete: false,
    // The first research call and synthesis keep their 100 reserved; the rest settled at the 50 they used.
    tokensReserved: 200 + 50 * (modelCalls - 2),
  });
  f.revoke();
  expect(() => f.runs.reserveTool(fence, "web_search")).toThrow(/authority no longer covers/);
});
it("isolates preview production state, enforces shared concurrency, and records missed occurrences", () => {
  const f = fixture();
  const before = f.store.handle.prepare("SELECT * FROM tavi_routine_state").get();
  const preview = f.runs.request(scope, f.id, "preview", "preview");
  const fence = f.runs.start(scope, preview.runId)!;
  f.runs.heartbeat(fence);
  f.runs.finish(fence, "failed");
  expect(f.store.handle.prepare("SELECT * FROM tavi_routine_state").get()).toEqual(before);
  const run = f.runs.request(scope, f.id, "manual");
  f.runs.start(scope, run.runId);
  const overlap = f.runs.claim(f.schedule, f.schedule.nextRunAt!)!;
  expect(overlap).toMatchObject({ status: "skipped", data: { reason: "overlap" } });
  // A skipped fire is not the trigger's last run.
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)?.lastRunAt).toBeNull();
  f.runs.cancel(scope, run.runId);
  f.setNow("2026-09-22T00:00:00.000Z");
  const schedule = f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)!;
  expect(f.runs.claim(schedule, schedule.nextRunAt!)?.data.reason).toBe("missed");
});
it("records one credential skip, holds paused intents until expiry, and scopes all inspection", () => {
  const f = fixture();
  f.unready();
  const run = f.runs.claim(f.schedule, f.schedule.nextRunAt!)!;
  expect(f.runs.start(scope, run.runId)).toBeUndefined();
  expect(f.runs.get(scope, run.runId)).toMatchObject({ status: "skipped", data: { reason: "credentials" } });
  expect(f.runs.claim(f.schedule, f.schedule.nextRunAt!)).toBeUndefined();
  for (const other of [
    { ...scope, workspaceId: "other" },
    { ...scope, principalId: "other" },
  ]) {
    expect(() => f.runs.get(other, run.runId)).toThrow(/scope/);
    expect(() => f.runs.ledger(other, f.id)).toThrow(/scope/);
  }
  const queued = f.runs.request(scope, f.id, "pause");
  const aggregate = f.routines.get(scope, f.id).routine;
  f.routines.setStatus(scope, f.id, aggregate.version, "paused");
  expect(f.runs.start(scope, queued.runId)).toBeUndefined();
  f.setNow("2026-09-21T00:00:00.000Z");
  f.routines.setStatus(scope, f.id, aggregate.version + 1, "active");
  expect(f.runs.start(scope, queued.runId)).toBeUndefined();
  expect(f.runs.get(scope, queued.runId).data.reason).toBe("expired");
});
it("verifies retained envelopes after pruning and detects changed detail or envelopes", () => {
  const f = fixture();
  const run = f.runs.request(scope, f.id, "ledger");
  f.runs.append(run, { version: 1, code: "model", step: "research" }, null, { kind: "prompt", text: "App-owned instructions" });
  const event = f.runs.ledger(scope, f.id).at(-1)!;
  expect(f.runs.verify(scope, f.id)).toMatchObject({ valid: true, prunedDetails: 0 });
  f.store.handle.prepare("UPDATE tavi_routine_details SET payload='tampered' WHERE detail_id=?").run(event.detailId);
  expect(f.runs.verify(scope, f.id).valid).toBe(false);
  f.setNow("2027-09-20T00:00:00.000Z");
  expect(f.runs.pruneDetails(scope, f.id)).toBe(1);
  expect(f.runs.detail(scope, f.id, event.detailId!).payload).toBeNull();
  expect(f.runs.verify(scope, f.id)).toMatchObject({ valid: true, prunedDetails: 1 });
  f.store.handle
    .prepare("UPDATE tavi_routine_events SET envelope_json=? WHERE event_id=?")
    .run(JSON.stringify({ version: 1, code: "cancelled" }), event.eventId);
  expect(f.runs.verify(scope, f.id).valid).toBe(false);
});
it("replays durable dispatch and preserves cancellation against late completion", async () => {
  const f = fixture();
  let captured: RoutineFence | undefined;
  const service = new RoutineExecutionService(f.routines, { ...f.options, ownerEpoch: "one" });
  const run = service.request(scope, f.id, "dispatch");
  await new RoutineRunDrain(service, {
    dispatch: async (_, fence) => {
      captured = fence;
    },
  }).drain();
  expect(captured).toBeDefined();
  service.cancel(scope, run.runId);
  expect(() => service.finish(captured!, "succeeded")).toThrow(/fenced/);
  expect(service.get(scope, run.runId).status).toBe("cancelled");
});

it("expires paused queued work without consuming a root slot and fails only production streaks", () => {
  const f = fixture();
  const queued = f.runs.request(scope, f.id, "paused");
  let aggregate = f.routines.get(scope, f.id).routine;
  f.routines.setStatus(scope, f.id, aggregate.version, "paused");
  f.setNow("2026-09-20T13:00:00.000Z");
  expect(f.runs.start(scope, queued.runId)).toBeUndefined();
  expect(f.runs.get(scope, queued.runId).data.reason).toBe("expired");
  aggregate = f.routines.get(scope, f.id).routine;
  f.routines.setStatus(scope, f.id, aggregate.version, "active");
  for (let n = 0; n < 3; n++) {
    const run = f.runs.request(scope, f.id, `failed-${n}`);
    const fence = f.runs.start(scope, run.runId)!;
    f.runs.finish(fence, "failed");
  }
  expect(f.routines.get(scope, f.id).routine.status).toBe("paused-failures");
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)?.enabled).toBe(false);
});
it("holds disk-pressure claims without losing a due occurrence", () => {
  const f = fixture();
  const runs = new RoutineExecutionService(f.routines, { ...f.options, ownerEpoch: "one", freeBytes: () => 0 });
  expect(runs.claim(f.schedule, f.schedule.nextRunAt!)).toBeUndefined();
  expect(f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)?.nextRunAt).toBe(f.schedule.nextRunAt);
  expect(runs.history(scope, f.id)).toEqual([]);
});

it("keeps unevaluated revisions confined to preview", () => {
  const f = fixture();
  const current = f.routines.get(scope, f.id);
  f.routines.update(scope, {
    routineId: f.id,
    expectedVersion: current.routine.version,
    operationKey: "candidate",
    changeSummary: "Candidate",
    snapshot: { ...current.revision.snapshot, objective: "Unapproved objective" },
  });
  expect(() => f.runs.request(scope, f.id, "production", "production", 2)).toThrow(/active evaluated revision/);
  expect(f.runs.request(scope, f.id, "preview", "preview", 2).revision).toBe(2);
  f.routines.finishEvaluation(scope, f.id, 2, false, "Failed candidate");
  expect(() => f.runs.request(scope, f.id, "failed-production", "production", 2)).toThrow(/active evaluated revision/);
  expect(f.routines.get(scope, f.id).routine.activeRevision).toBe(1);
});
it("never exposes operator HTTP credentials through a research grant", async () => {
  const f = fixture();
  Object.assign(f.runs.options, { publicFetch: { resolve: async () => ["93.184.216.34"] } });
  const run = f.runs.request(scope, f.id, "credentials");
  const fence = f.runs.start(scope, run.runId)!;
  const registry = new ToolRegistry();
  let effects = 0;
  registry.register({
    id: "http.request",
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description: "HTTP fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ url: z.string() }),
    handler: async () => {
      effects++;
      return {};
    },
  });
  const tools = routineResearchTools(registry, asyncRoutineEffects(f.runs), run, fence);
  for (const field of ["credentialRef", "credentialHeader", "credentialScheme", "headers", "body"]) {
    await expect(
      tools.get("http.request")!.handler({
        input: { url: "https://example.com", [field]: "secret" },
        context: { ...scope, runId: "worker", caller: "routine" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/public GET/);
  }
  expect(effects).toBe(0);
  expect(JSON.stringify(tools.inputJsonSchemaOf("http.request"))).not.toContain("credentialRef");
  await tools.get("http.request")!.handler({
    input: { url: "https://example.com" },
    context: { ...scope, runId: "worker", caller: "routine" },
    signal: new AbortController().signal,
  });
  expect(effects).toBe(1);
});

it("distinguishes dependency blockers and emits one durable automatic-pause notification", async () => {
  const f = fixture();
  for (const code of ["transient", "model-retired", "credentials"] as const) {
    const runs = new RoutineExecutionService(f.routines, {
      ...f.options,
      ownerEpoch: "one",
      researchReady: () => ({ ready: false, code, retryable: code !== "model-retired" }),
    });
    const run = runs.request(scope, f.id, code);
    expect(runs.start(scope, run.runId)).toBeUndefined();
    expect(runs.get(scope, run.runId).data.reason).toBe(code);
    const state = f.store.handle.prepare("SELECT research_blocked_since FROM tavi_routine_state WHERE routine_id=?").get(f.id) as {
      research_blocked_since: string | null;
    };
    expect(state.research_blocked_since === null).toBe(code !== "credentials");
  }
  let alerts = 0;
  const runs = new RoutineExecutionService(f.routines, {
    ...f.options,
    ownerEpoch: "one",
    onPaused: async () => {
      alerts++;
    },
  });
  for (let n = 0; n < 3; n++) {
    const run = runs.request(scope, f.id, `failure-${n}`);
    const fence = runs.start(scope, run.runId)!;
    runs.finish(fence, "failed");
  }
  await runs.notifyPauses();
  await runs.notifyPauses();
  expect(alerts).toBe(1);
  expect(runs.ledger(scope, f.id).filter((event) => event.envelope.code === "auto-paused")).toHaveLength(1);
});
for (const withFallback of [true, false])
  it(`records explicit retirement with approved fallback ${withFallback}`, async () => {
    const { routineModelPort } = await import("@tavi/runtime");
    const f = fixture();
    if (!withFallback) {
      const current = f.routines.get(scope, f.id);
      f.routines.update(scope, {
        routineId: f.id,
        operationKey: "without-fallback",
        expectedVersion: current.routine.version,
        changeSummary: "Remove fallback",
        snapshot: {
          ...current.revision.snapshot,
          models: { ...current.revision.snapshot.models, research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] } },
        },
      });
      f.routines.finishEvaluation(scope, f.id, 2, true, "pass");
    }
    const run = f.runs.request(scope, f.id, "retirement");
    const fence = f.runs.start(scope, run.runId)!;
    const calls: string[] = [];
    const port = routineModelPort(
      {
        stream: async (request) => {
          calls.push(request.model);
          return request.model === "v1"
            ? {
                attemptId: request.attemptId,
                status: "failed",
                text: "",
                toolCalls: [],
                usage: {},
                error: { code: "model_retired", message: "Explicit retirement", retryable: false },
              }
            : { attemptId: request.attemptId, status: "completed", text: "Fallback result", toolCalls: [], usage: { totalTokens: 10 } };
        },
      },
      asyncRoutineEffects(f.runs),
      run,
      fence,
      "research",
    );
    const result = await port.stream(
      { connectionId: "fixture", model: "v1", runId: "task", attemptId: "one", attemptNumber: 1, messages: [], tools: [] },
      { signal: AbortSignal.timeout(1000), onEvent: () => {} },
    );
    expect(result.status).toBe("failed");
    expect(calls).toEqual(["v1"]); // Workflow owns fallback routing; the port accounts one attempt.
    expect(f.runs.knownRetired(f.id, { connectionId: "fixture", model: "v1" })).toBe(true);
    expect(f.runs.ledger(scope, f.id).some((event) => event.envelope.code === "model-retired")).toBe(true);
    expect(f.runs.get(scope, run.runId).snapshot.models.research.primary.model).toBe("v1");
  });
it("does not turn a transient provider failure into retirement", async () => {
  const { routineModelPort } = await import("@tavi/runtime");
  const f = fixture();
  const run = f.runs.request(scope, f.id, "transient");
  const fence = f.runs.start(scope, run.runId)!;
  const port = routineModelPort(
    {
      stream: async (request) => ({
        attemptId: request.attemptId,
        status: "failed",
        text: "",
        toolCalls: [],
        usage: {},
        error: { code: "provider", message: "Temporarily unavailable", retryable: true },
      }),
    },
    asyncRoutineEffects(f.runs),
    run,
    fence,
    "research",
  );
  await port.stream(
    { connectionId: "fixture", model: "v1", runId: "task", attemptId: "one", attemptNumber: 1, messages: [], tools: [] },
    { signal: AbortSignal.timeout(1000), onEvent: () => {} },
  );
  expect(f.runs.knownRetired(f.id, { connectionId: "fixture", model: "v1" })).toBe(false);
});

it("admits a 20:00 fire recovered at 22:00 but defers delivery to the next allowed window", async () => {
  const { routineDeliveryTime } = await import("@tavi/runtime");
  const f = fixture();
  const current = f.routines.get(scope, f.id);
  f.routines.update(scope, {
    routineId: f.id,
    operationKey: "evening",
    expectedVersion: current.routine.version,
    changeSummary: "Evening fixture",
    snapshot: {
      ...current.revision.snapshot,
      triggers: [{ id: "evening", kind: "daily", at: "20:00", timezone: "Europe/Sofia" }],
      delivery: { ...current.revision.snapshot.delivery, outsideWindow: "next_window" },
    },
  });
  f.routines.finishEvaluation(scope, f.id, 2, true, "pass");
  const schedule = f.store
    .asPort()
    .repositories.schedules.list(scope.workspaceId)
    .find((item) => item.enabled)!;
  f.store.asPort().repositories.schedules.setEnabled({
    scheduleId: schedule.scheduleId,
    enabled: true,
    nextRunAt: "2026-09-20T17:00:00.000Z",
    now: "2026-09-20T16:00:00.000Z",
  });
  f.setNow("2026-09-20T19:00:00.000Z");
  const due = f.store.asPort().repositories.schedules.get(schedule.scheduleId)!;
  const run = f.runs.claim(due, due.nextRunAt!)!;
  expect(run.status).toBe("queued");
  expect(f.runs.start(scope, run.runId)).toBeDefined();
  expect(routineDeliveryTime(run, "2026-09-20T19:00:00.000Z")).toBe("2026-09-21T04:00:00.000Z");
});
// Resuming is how a person says the routine is fixed, so a paused delivery
// target is released with it: before, its health survived and it stayed paused.
it("resumes with fresh research and delivery failure streaks", () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) {
    const run = f.runs.request(scope, f.id, `fail-${n}`);
    f.runs.finish(f.runs.start(scope, run.runId)!, "failed");
  }
  const paused = f.routines.get(scope, f.id);
  expect(paused.routine.status).toBe("paused-failures");
  f.store.handle
    .prepare(
      "UPDATE tavi_routine_state SET research_blocked_since=?,delivery_failures=2,state_json=json_set(state_json,'$.deliveryHealth',json(?))",
    )
    .run("2026-09-17T06:00:00.000Z", JSON.stringify({ target: { failures: 3, blockedSince: null, notified: true } }));
  f.routines.setStatus(scope, f.id, paused.routine.version, "active");
  const run = f.runs.request(scope, f.id, "after-resume");
  f.runs.finish(f.runs.start(scope, run.runId)!, "failed");
  expect(f.routines.get(scope, f.id).routine.status).toBe("active");
  expect(
    f.store.handle
      .prepare(
        "SELECT research_failures,research_blocked_since,delivery_failures,json_extract(state_json,'$.pendingAutoPause') AS alert,json_extract(state_json,'$.deliveryHealth') AS health FROM tavi_routine_state",
      )
      .get(),
  ).toEqual({ research_failures: 1, research_blocked_since: null, delivery_failures: 0, alert: null, health: null });
});

it("reports exactly what a local chain establishes, including a tail it cannot detect", () => {
  const f = fixture();
  const run = f.runs.request(scope, f.id, "ledger-verdict");
  for (const text of ["first", "second", "third"])
    f.runs.append(run, { version: 1, code: "model", step: "research" }, null, { kind: "prompt", text });
  const verdict = f.runs.verify(scope, f.id);
  expect(verdict).toMatchObject({
    valid: true,
    scope: { ...scope, routineId: f.id },
    events: f.runs.ledger(scope, f.id).length,
    chain: "local",
    anchored: false,
    prunedDetails: 0,
  });
  expect(verdict.headHash).toMatch(/^[a-f0-9]{64}$/);
  // The limitation ships with the verdict: a caller cannot render "valid" as
  // "untampered" without contradicting the string it was handed.
  expect(verdict.limitation).toContain("Local chain only");
  expect(verdict.limitation).toContain("not detectable without an anchor");
});

it("detects a changed middle event but not a coherently truncated tail", () => {
  const f = fixture();
  const run = f.runs.request(scope, f.id, "ledger-truncate");
  for (const text of ["first", "second", "third"])
    f.runs.append(run, { version: 1, code: "model", step: "research" }, null, { kind: "prompt", text });
  const events = f.runs.ledger(scope, f.id);
  // A changed detail payload in the middle is detected.
  const middle = events.find((event) => event.detailId !== null)!;
  const original = f.runs.detail(scope, f.id, middle.detailId!).payload!;
  f.store.handle.prepare("UPDATE tavi_routine_details SET payload='tampered' WHERE detail_id=?").run(middle.detailId);
  expect(f.runs.verify(scope, f.id).valid).toBe(false);
  f.store.handle.prepare("UPDATE tavi_routine_details SET payload=? WHERE detail_id=?").run(original, middle.detailId);
  expect(f.runs.verify(scope, f.id).valid).toBe(true);
  // A tail removed in one statement leaves a chain that verifies, and the verdict
  // says so rather than pretending otherwise.
  const keep = events[2]!.sequence;
  f.store.handle.prepare("DELETE FROM tavi_routine_events WHERE routine_id=? AND sequence>?").run(f.id, keep);
  const truncated = f.runs.verify(scope, f.id);
  expect(truncated).toMatchObject({ valid: true, events: keep });
  expect(truncated.limitation).toContain("truncation of its tail");
});

it("counts pruned details without losing the integrity envelope", () => {
  const f = fixture();
  const run = f.runs.request(scope, f.id, "ledger-pruned");
  f.runs.append(run, { version: 1, code: "model", step: "research" }, null, { kind: "prompt", text: "retained then pruned" });
  f.setNow("2027-09-20T00:00:00.000Z");
  expect(f.runs.pruneDetails(scope, f.id)).toBe(1);
  expect(f.runs.verify(scope, f.id)).toMatchObject({ valid: true, prunedDetails: 1 });
});

it("assigns the credential-blocked status the design requires while research keeps retrying", () => {
  const f = fixture();
  f.unready();
  const run = f.runs.claim(f.schedule, f.schedule.nextRunAt!)!;
  expect(f.runs.start(scope, run.runId)).toBeUndefined();
  // The status is research *health*, operator-visible, and not a stop: the
  // routine is still admitted, so a returning credential recovers it on its own.
  expect(f.routines.get(scope, f.id).routine.status).toBe("credential-blocked");
  const next = f.store.asPort().repositories.schedules.get(f.schedule.scheduleId)!;
  const queued = f.runs.claim(next, next.nextRunAt!)!;
  expect(queued.status).toBe("queued");
  // A run that gets through proves the credentials work and clears the block.
  const recovered = new RoutineExecutionService(f.routines, {
    ownerEpoch: "one",
    now: () => "2026-09-20T06:05:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
  });
  const fence = recovered.start(scope, queued.runId)!;
  recovered.finish(fence, "succeeded");
  expect(f.routines.get(scope, f.id).routine.status).toBe("active");
});

it("keeps the admission window separate from the execution budget, and never resets it", () => {
  const f = fixture();
  const run = f.runs.claim(f.schedule, f.schedule.nextRunAt!)!;
  // The claim seeds both windows from `catchUpHours` (6h here, above the 2-minute
  // floor): an unstarted occurrence is bounded by how stale it may be.
  expect(run.data.queueExpiresAt).toBe("2026-09-20T12:00:00.000Z");
  expect(run.data.deadline).toBe("2026-09-20T12:00:00.000Z");
  const fence = f.runs.start(scope, run.runId)!;
  // Starting replaces the deadline with the run's own budget; the admission
  // window is untouched, which is what keeps a paused-then-resumed intent from
  // firing hours late.
  const started = f.runs.get(scope, run.runId);
  expect(started.data.deadline).toBe("2026-09-20T06:20:00.000Z");
  expect(started.data.queueExpiresAt).toBe("2026-09-20T12:00:00.000Z");
  f.runs.finish(fence, "succeeded");
  // A one-off routine completes by exhausting its triggers; a daily one never does.
  expect(f.routines.get(scope, f.id).routine.status).toBe("active");
});

it("refuses the overlap policies it does not implement, by name", () => {
  const f = fixture();
  const current = f.routines.get(scope, f.id);
  const withOverlap = (overlap: string) => ({
    ...current.revision.snapshot,
    execution: { ...current.revision.snapshot.execution, overlap },
  });
  for (const overlap of ["queue", "cancel_previous"]) {
    try {
      f.routines.update(scope, {
        routineId: f.id,
        operationKey: `overlap-${overlap}`,
        expectedVersion: current.routine.version,
        changeSummary: `Try ${overlap}`,
        snapshot: withOverlap(overlap) as never,
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "UNSUPPORTED" });
    }
  }
  // `skip` is the only accepted value, and it is what every missed overlap records.
  expect(f.runs.claim(f.schedule, f.schedule.nextRunAt!)).toBeDefined();
  const overlap = f.runs.claim(f.schedule, f.schedule.nextRunAt!);
  expect(overlap).toBeUndefined();
});

/** Another evaluated routine in the fixture's store, firing at 09:00 as the first does. */
function another(f: ReturnType<typeof fixture>, name: string, catchUpHours = 6): string {
  const current = f.routines.get(scope, f.id).revision.snapshot;
  const created = f.routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
      execution: { ...current.execution, catchUpHours },
      operationKey: `create-${name}`,
      name,
      objective: `Find ${name}`,
      agent: { agentId: name.toLowerCase(), name, instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: current.models,
      permissions: current.permissions,
    }),
  );
  f.routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  return created.routine.routineId;
}

it("runs two routines at once, and a third waits for a slot without expiring", () => {
  const f = fixture();
  const second = another(f, "Second");
  const third = another(f, "Third", 0);
  const a = f.runs.request(scope, f.id, "a");
  const b = f.runs.request(scope, second, "b");
  const c = f.runs.request(scope, third, "c");
  // Catch-up 0 still admits a run for two minutes.
  expect(c.data.queueExpiresAt).toBe("2026-09-20T06:02:00.000Z");
  const first = f.runs.start(scope, a.runId)!;
  expect(f.runs.start(scope, b.runId)).toBeDefined();
  expect(f.runs.start(scope, c.runId)).toBeUndefined();
  // Fifteen minutes behind two running runs is a wait, not a stale fire.
  f.setNow("2026-09-20T06:15:00.000Z");
  expect(f.runs.start(scope, c.runId)).toBeUndefined();
  expect(f.runs.get(scope, c.runId)).toMatchObject({ status: "queued", data: { slotWaitSince: "2026-09-20T06:00:00.000Z" } });
  f.runs.finish(first, "succeeded");
  f.setNow("2026-09-20T06:15:30.000Z");
  expect(f.runs.start(scope, c.runId)).toBeDefined();
  const started = f.runs.get(scope, c.runId);
  expect(started.status).toBe("running");
  // Its admission window moved on by the wait, up to the moment the slot came free.
  expect(started.data.queueExpiresAt).toBe("2026-09-20T06:17:00.000Z");
  expect(started.data.slotWaitSince).toBeUndefined();
});

it("does not let a slot wait carry a fire past an owner that was stopped meanwhile", () => {
  const f = fixture();
  const second = another(f, "Second");
  const third = another(f, "Third", 0);
  const a = f.runs.start(scope, f.runs.request(scope, f.id, "a").runId)!;
  const b = f.runs.start(scope, f.runs.request(scope, second, "b").runId)!;
  const c = f.runs.request(scope, third, "c");
  expect(f.runs.start(scope, c.runId)).toBeUndefined();
  // The owner stops a minute in, and both running runs are interrupted then.
  f.setNow("2026-09-20T06:01:00.000Z");
  f.runs.interrupt(a);
  f.runs.interrupt(b);
  // The next owner comes back hours later: the wait was a minute, so the fire is stale.
  f.setNow("2026-09-20T10:00:00.000Z");
  expect(f.runs.start(scope, c.runId)).toBeUndefined();
  expect(f.runs.get(scope, c.runId)).toMatchObject({ status: "skipped", data: { reason: "expired" } });
});

it("does not let a slot wait carry a fire past an owner that crashed meanwhile", () => {
  const f = fixture();
  const second = another(f, "Second");
  const third = another(f, "Third", 0);
  const a = f.runs.request(scope, f.id, "a");
  const b = f.runs.request(scope, second, "b");
  expect(f.runs.start(scope, a.runId)).toBeDefined();
  expect(f.runs.start(scope, b.runId)).toBeDefined();
  const c = f.runs.request(scope, third, "c");
  expect(f.runs.start(scope, c.runId)).toBeUndefined();
  // The owner crashes, and the next one recovers ten minutes later and resumes both running runs first.
  f.setNow("2026-09-20T06:10:00.000Z");
  const restarted = new RoutineExecutionService(f.routines, { ...f.options, ownerEpoch: "two" });
  expect(restarted.recoverPreviousOwner()).toBe(2);
  const resumed = restarted.start(scope, a.runId)!;
  expect(restarted.start(scope, b.runId)).toBeDefined();
  f.setNow("2026-09-20T06:15:00.000Z");
  restarted.finish(resumed, "succeeded");
  expect(restarted.start(scope, c.runId)).toBeUndefined();
  expect(restarted.get(scope, c.runId)).toMatchObject({ status: "skipped", data: { reason: "expired" } });
});

it("excuses an attempt a transient failure cut short, backs off, and fails the fourth", () => {
  const f = fixture();
  const run = f.runs.request(scope, f.id, "transient");
  let fence = f.runs.start(scope, run.runId)!;
  f.runs.beginStep(fence, "research");
  for (let n = 0; n < 3; n++) f.runs.reserveModel(fence, "research", `call${n}`, 100, { connectionId: "fixture", model: "v1" });
  f.runs.reserveTool(fence, "web_search");
  const before = f.runs.get(scope, run.runId).data;
  f.setNow("2026-09-20T06:05:00.000Z");
  expect(f.runs.interrupt(fence, true)).toBe("interrupted");
  const interrupted = f.runs.get(scope, run.runId);
  expect(interrupted.status).toBe("interrupted");
  // The research the attempt spent is given back to the budget, and its clock starts again; its calls stay in the effort.
  expect(interrupted.data).toMatchObject({
    modelCalls: 3,
    toolCalls: 1,
    excusedModelCalls: 3,
    excusedToolCalls: 1,
    tokensReserved: 0,
    reservations: {},
    transientRetries: 1,
  });
  expect(f.runs.history(scope, f.id)[0]).toMatchObject({ modelCalls: 3, toolCalls: 1 });
  expect(f.runs.effortSince(scope, f.id, "2026-09-20T00:00:00.000Z")).toMatchObject({ modelCalls: 3, toolCalls: 1 });
  expect(interrupted.data.stepStarted.research).toBeUndefined();
  // The windows move on by the five-minute attempt and its 30-second backoff.
  expect(interrupted.data.retryAfter).toBe("2026-09-20T06:05:30.000Z");
  expect(Date.parse(interrupted.data.deadline) - Date.parse(before.deadline)).toBe(330_000);
  expect(f.runs.ledger(scope, f.id).at(-1)?.envelope).toMatchObject({ code: "transient", step: "research", retryable: true });
  // Not before its backoff.
  expect(f.runs.start(scope, run.runId)).toBeUndefined();
  for (const [n, at] of [
    [2, "2026-09-20T06:06:00.000Z"],
    [3, "2026-09-20T06:08:00.000Z"],
  ] as const) {
    f.setNow(at);
    fence = f.runs.start(scope, run.runId)!;
    expect(f.runs.interrupt(fence, true)).toBe("interrupted");
    expect(f.runs.get(scope, run.runId).data.transientRetries).toBe(n);
  }
  f.setNow("2026-09-20T06:12:00.000Z");
  fence = f.runs.start(scope, run.runId)!;
  // Three retries spent: the fourth transient failure is a failure.
  expect(f.runs.interrupt(fence, true)).toBe("failed");
  expect(f.runs.get(scope, run.runId)).toMatchObject({ status: "failed", data: { reason: "failed" } });
});

it("marks the attempt that ran out of budget, so one after an excused attempt is retried", async () => {
  const { routineFailureSettlement } = await import("../src/routines/failures.js");
  const f = fixture();
  const run = f.runs.request(scope, f.id, "exhausted");
  let fence = f.runs.start(scope, run.runId)!;
  f.runs.beginStep(fence, "research");
  f.runs.reserveModel(fence, "research", "first", 100, { connectionId: "fixture", model: "v1" });
  f.runs.interrupt(fence, true);
  f.setNow("2026-09-20T06:01:00.000Z");
  fence = f.runs.start(scope, run.runId)!;
  f.runs.beginStep(fence, "research");
  // Every research call the budget allows (one is held back for synthesis), then one over it.
  const { modelCalls } = f.runs.get(scope, run.runId).snapshot.execution;
  for (let n = 0; n < modelCalls - 1; n++)
    f.runs.reserveModel(fence, "research", `call${n}`, 100, { connectionId: "fixture", model: "v1" });
  expect(() => f.runs.reserveModel(fence, "research", "over", 100, { connectionId: "fixture", model: "v1" })).toThrow(/budget/);
  const marked = f.runs.get(scope, run.runId);
  expect(marked.data.budgetExhausted).toBe(fence.generation);
  const failure = new Error("Routine research workflow did not complete (failed)");
  expect(routineFailureSettlement(failure, fence, false, marked)).toBe("transient");
  // The same exhaustion with no excused attempt behind it is the routine's own failure.
  expect(routineFailureSettlement(failure, fence, false, { data: { ...marked.data, transientRetries: 0 } })).toBe("failed");
});

it("clears the budget mark once the attempt carries on past a refusal", async () => {
  const { routineFailureSettlement } = await import("../src/routines/failures.js");
  const f = fixture();
  const run = f.runs.request(scope, f.id, "absorbed");
  let fence = f.runs.start(scope, run.runId)!;
  f.runs.beginStep(fence, "research");
  f.runs.reserveModel(fence, "research", "first", 100, { connectionId: "fixture", model: "v1" });
  f.runs.interrupt(fence, true);
  f.setNow("2026-09-20T06:01:00.000Z");
  fence = f.runs.start(scope, run.runId)!;
  f.runs.beginStep(fence, "research");
  const { toolCalls } = f.runs.get(scope, run.runId).snapshot.execution;
  for (let n = 0; n < toolCalls; n++) f.runs.reserveTool(fence, "web_search");
  // The model is told its tool was refused, and goes on to its next call.
  expect(() => f.runs.reserveTool(fence, "web_search")).toThrow(/budget/);
  expect(f.runs.get(scope, run.runId).data.budgetExhausted).toBe(fence.generation);
  f.runs.reserveModel(fence, "research", "next", 100, { connectionId: "fixture", model: "v1" });
  const continued = f.runs.get(scope, run.runId);
  expect(continued.data.budgetExhausted).toBeUndefined();
  const failure = new Error("Routine research workflow did not complete (failed)");
  expect(routineFailureSettlement(failure, fence, false, continued)).toBe("failed");
});

it("dispatches two runs at once and starts a third as soon as one of them ends", async () => {
  const f = fixture();
  const second = another(f, "Second");
  const third = another(f, "Third", 0);
  // Claimed a second apart, so the queue's order is theirs.
  const queued = [
    [f.id, "a"],
    [second, "b"],
    [third, "c"],
  ].map(([routineId, key], n) => {
    f.setNow(`2026-09-20T06:00:0${n}.000Z`);
    return f.runs.request(scope, routineId!, key!);
  });
  const running = new Map<string, PromiseWithResolvers<void>>();
  const twoRunning = Promise.withResolvers<void>();
  const drained = new RoutineRunDrain(f.runs, {
    dispatch: async (run, fence) => {
      const held = Promise.withResolvers<void>();
      running.set(run.runId, held);
      if (running.size === 2) twoRunning.resolve();
      await held.promise;
      f.runs.finish(fence, "succeeded");
    },
  }).drain();
  await twoRunning.promise;
  expect([...running.keys()]).toEqual([queued[0]!.runId, queued[1]!.runId]);
  expect(f.runs.get(scope, queued[2]!.runId).status).toBe("queued");
  // Fifteen minutes on, the first ends and the third, admitted for two minutes, starts in its slot.
  f.setNow("2026-09-20T06:15:00.000Z");
  running.get(queued[0]!.runId)!.resolve();
  await vi.waitFor(() => expect(running.has(queued[2]!.runId)).toBe(true));
  running.get(queued[1]!.runId)!.resolve();
  running.get(queued[2]!.runId)!.resolve();
  await drained;
  for (const run of queued) expect(f.runs.get(scope, run.runId).status).toBe("succeeded");
});

it("starts a transiently interrupted run again in the same pass, once a slot frees after its backoff", async () => {
  const f = fixture();
  const second = another(f, "Second");
  const third = another(f, "Third");
  const queued = [
    [f.id, "a"],
    [second, "b"],
    [third, "c"],
  ].map(([routineId, key], n) => {
    f.setNow(`2026-09-20T06:00:0${n}.000Z`);
    return f.runs.request(scope, routineId!, key!);
  });
  const [x, y, z] = queued.map((run) => run.runId) as [string, string, string];
  const held = new Map<string, PromiseWithResolvers<void>>();
  const attempts: string[] = [];
  const drain = new RoutineRunDrain(f.runs, {
    dispatch: async (run, fence) => {
      attempts.push(run.runId);
      // The first attempt of the first run is cut short by a provider failure two minutes in.
      if (run.runId === x && attempts.filter((id) => id === x).length === 1) {
        await held.get("x-fails")!.promise;
        f.runs.interrupt(fence, true);
        return;
      }
      const hold = Promise.withResolvers<void>();
      held.set(run.runId, hold);
      await hold.promise;
      f.runs.finish(fence, "succeeded");
    },
  });
  held.set("x-fails", Promise.withResolvers<void>());
  const drained = drain.drain();
  await vi.waitFor(() => expect(attempts).toEqual([x, y]));
  f.setNow("2026-09-20T06:02:00.000Z");
  held.get("x-fails")!.resolve();
  // Its slot goes to the third run while it backs off.
  await vi.waitFor(() => expect(attempts).toEqual([x, y, z]));
  // Past its backoff, a sweep's wake finds both slots taken: it waits for one.
  f.setNow("2026-09-20T06:03:00.000Z");
  void drain.drain();
  await vi.waitFor(() => expect(f.runs.get(scope, x).data.slotWaitSince).toBe("2026-09-20T06:03:00.000Z"));
  f.setNow("2026-09-20T06:30:00.000Z");
  held.get(z)!.resolve();
  await vi.waitFor(() => expect(attempts).toEqual([x, y, z, x]));
  held.get(x)!.resolve();
  held.get(y)!.resolve();
  await drained;
  for (const id of [x, y, z]) expect(f.runs.get(scope, id).status).toBe("succeeded");
});

it("starts a run claimed while a drain waits on a running one, beside it", async () => {
  const f = fixture();
  const second = another(f, "Second");
  f.runs.request(scope, f.id, "a");
  const started: string[] = [];
  const release = Promise.withResolvers<void>();
  const drain = new RoutineRunDrain(f.runs, {
    dispatch: async (run, fence) => {
      started.push(run.runId);
      await release.promise;
      f.runs.finish(fence, "succeeded");
    },
  });
  const drained = drain.drain();
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const late = f.runs.request(scope, second, "b");
  // A wake while the pass waits makes it look at the queue again.
  void drain.drain();
  await vi.waitFor(() => expect(started).toContain(late.runId));
  release.resolve();
  await drained;
});

it("tells a late or resumed run its times in the routine's zone, and an on-time or requested one nothing", () => {
  const snapshot = { execution: { timezone: "Europe/Sofia" } } as Parameters<typeof routineRunLateNote>[0]["snapshot"];
  const onTime = {
    snapshot,
    scheduledFor: "2026-09-20T04:00:00.000Z",
    claimedAt: "2026-09-20T04:00:30.000Z",
    startedAt: "2026-09-20T04:00:31.000Z",
    generation: 1,
  };
  expect(routineRunLateNote(onTime, "2026-09-20T04:05:00.000Z")).toBeUndefined();
  // A prompt retry seconds later is not late.
  expect(routineRunLateNote({ ...onTime, generation: 2 }, "2026-09-20T04:01:30.000Z")).toBeUndefined();
  expect(
    routineRunLateNote({ ...onTime, scheduledFor: null, claimedAt: "2026-09-20T08:40:00.000Z" }, "2026-09-20T08:41:00.000Z"),
  ).toBeUndefined();
  expect(
    routineRunLateNote(
      { ...onTime, claimedAt: "2026-09-20T08:40:00.000Z", startedAt: "2026-09-20T08:40:05.000Z" },
      "2026-09-20T08:41:00.000Z",
    ),
  ).toBe("Scheduled for 07:00 GMT+3, running at 11:40 GMT+3 (catch-up; the window since the last run may be longer than usual).");
  expect(routineRunLateNote({ ...onTime, generation: 2 }, "2026-09-20T20:30:00.000Z")).toBe(
    "Scheduled for 07:00 GMT+3, started at 07:00 GMT+3, resumed at 23:30 GMT+3 after an interruption; the coverage window still ends when the run started.",
  );
  // Past midnight in the zone, each time carries its date.
  expect(routineRunLateNote({ ...onTime, generation: 2 }, "2026-09-20T21:30:00.000Z")).toBe(
    "Scheduled for 2026-09-20 07:00 GMT+3, started at 2026-09-20 07:00 GMT+3, resumed at 2026-09-21 00:30 GMT+3 after an interruption; the coverage window still ends when the run started.",
  );
  // On New York's fall-back day the repeated hour reads in order by its zone: 01:30 EDT, then 01:10 EST.
  const newYork = { execution: { timezone: "America/New_York" } } as Parameters<typeof routineRunLateNote>[0]["snapshot"];
  expect(
    routineRunLateNote(
      {
        ...onTime,
        snapshot: newYork,
        scheduledFor: "2026-11-01T05:30:00.000Z",
        claimedAt: "2026-11-01T06:10:00.000Z",
        startedAt: "2026-11-01T06:10:05.000Z",
      },
      "2026-11-01T06:11:00.000Z",
    ),
  ).toBe("Scheduled for 01:30 EDT, running at 01:10 EST (catch-up; the window since the last run may be longer than usual).");
});

it("counts a day's runs against the daily limit in the routine's zone, from runs that started, on an index", () => {
  const f = fixture();
  const statements: string[] = [];
  const prepare = f.store.handle.prepare.bind(f.store.handle);
  vi.spyOn(f.store.handle, "prepare").mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  // A run that never started is not counted: an overlap skip beside a queued run.
  const queued = f.runs.request(scope, f.id, "queued");
  expect(f.runs.request(scope, f.id, "overlapping").status).toBe("skipped");
  f.runs.cancel(scope, queued.runId);
  // 09:00 in Sofia on the 20th, and on to 23:59 there (20:59Z): twelve runs, the default limit.
  for (let n = 0; n < 12; n++) {
    f.setNow(new Date(Date.parse("2026-09-20T06:00:00.000Z") + n * 60 * 60_000).toISOString());
    const run = f.runs.request(scope, f.id, `day-${String(n)}`);
    f.runs.finish(f.runs.start(scope, run.runId)!, "succeeded");
  }
  f.setNow("2026-09-20T20:59:00.000Z");
  const over = f.runs.request(scope, f.id, "over");
  expect(f.runs.start(scope, over.runId)).toBeUndefined();
  expect(f.runs.get(scope, over.runId)).toMatchObject({ status: "skipped", data: { reason: "daily-budget", localDay: "2026-09-20" } });
  // 00:30 on the 21st in Sofia is still the 20th in UTC: the routine's day has turned, so it runs.
  f.setNow("2026-09-20T21:30:00.000Z");
  const next = f.runs.request(scope, f.id, "next-day");
  expect(f.runs.start(scope, next.runId)).toBeDefined();
  expect(f.runs.get(scope, next.runId).data.localDay).toBe("2026-09-21");
  const count = statements.find((sql) => sql.includes("$.localDay"));
  expect(count).toMatch(/^SELECT COUNT\(\*\)/);
  const plan = (f.store.handle.prepare(`EXPLAIN QUERY PLAN ${count!}`).all(f.id, "2026-09-21", next.runId) as { detail: string }[])
    .map((row) => row.detail)
    .join("\n");
  expect(plan).toContain("USING INDEX tavi_routine_runs_local_day_idx");
});

it("reads the runs waiting to start from an index of only those, in claim order", () => {
  const f = fixture();
  const statements: string[] = [];
  const prepare = f.store.handle.prepare.bind(f.store.handle);
  vi.spyOn(f.store.handle, "prepare").mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  const settled = f.runs.request(scope, f.id, "settled");
  f.runs.finish(f.runs.start(scope, settled.runId)!, "succeeded");
  const waiting = f.runs.request(scope, f.id, "waiting");
  expect(f.runs.pending().map((run) => run.runId)).toEqual([waiting.runId]);
  const pending = statements.find((sql) => sql.includes("r.status IN ('queued','interrupted')"));
  const plan = (
    f.store.handle.prepare(`EXPLAIN QUERY PLAN ${pending!}`).all("2026-09-20T06:00:00.000Z", "2026-09-20T06:00:00.000Z", 50) as {
      detail: string;
    }[]
  )
    .map((row) => row.detail)
    .join("\n");
  expect(plan).toContain("USING INDEX tavi_routine_runs_pending_idx");
  expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
});

it("drops old settled runs' snapshot copies to their revision's, and every run, history, ledger and prune reads the same", () => {
  const f = fixture({ detailDays: 7 });
  const settle = (key: string, at: string, override?: { style: "detailed" }) => {
    f.setNow(at);
    const run = f.runs.request(scope, f.id, key, "production", undefined, override);
    f.runs.cancel(scope, run.runId);
    return run.runId;
  };
  const hour = (n: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + n * 60 * 60_000).toISOString();
  // Five runs older than the newest fifty: one with a report override, one with a delivery still open.
  const overridden = settle("old-override", hour(0), { style: "detailed" });
  const delivering = settle("old-delivering", hour(1));
  const dropped = [settle("old-a", hour(2)), settle("old-b", hour(3)), settle("old-c", hour(4))];
  // A detail past its seven days but inside the 365-day default, and an excerpt past seven but inside the 30-day default.
  f.runs.append(f.runs.get(scope, dropped[0]!), { version: 1, code: "model", step: "research" }, null, { kind: "evidence", text: "x" });
  f.store.handle
    .prepare("INSERT INTO tavi_routine_sources (source_id,run_id,workspace_id,source_json,created_at) VALUES ('source',?,?,?,?)")
    .run(dropped[0], scope.workspaceId, JSON.stringify({ excerpt: "x" }), "2026-09-01T00:00:00.000Z");
  const newest = Array.from({ length: 50 }, (_, n) => settle(`new-${String(n)}`, hour(5 + n)));
  f.store.handle
    .prepare(
      "INSERT INTO tavi_routine_delivery_jobs (job_id,run_id,effect_id,status,not_before,expires_at,created_at,updated_at,data_json) VALUES ('job',?,'effect','deferred',?,?,?,?,'{}')",
    )
    .run(delivering, hour(1), hour(1), hour(1), hour(1));
  const before = new Map([overridden, delivering, ...dropped, newest[0]!].map((runId) => [runId, f.runs.get(scope, runId)]));
  const history = f.runs.history(scope, f.id, 100);
  const ledger = f.runs.verify(scope, f.id);
  // Within thirty days of the last of them ending, nothing goes.
  f.setNow("2026-01-31T00:00:00.000Z");
  expect(f.runs.pruneDueSnapshots(true)).toBe(0);
  f.setNow("2026-09-20T06:00:00.000Z");
  const news = new RoutineNewsService(f.runs);
  expect(f.runs.pruneDueDetails(true)).toBe(1);
  expect(news.pruneEvidence("2026-09-20T06:00:00.000Z", true)).toBe(1);
  expect(f.runs.pruneDueSnapshots(true)).toBe(3);
  expect(f.runs.pruneDueSnapshots()).toBe(3);
  expect(f.runs.pruneDueSnapshots()).toBe(0);
  const stored = (runId: string) =>
    (f.store.handle.prepare("SELECT snapshot_json FROM tavi_routine_runs WHERE run_id=?").get(runId) as { snapshot_json: string })
      .snapshot_json;
  expect(dropped.map(stored)).toEqual(["", "", ""]);
  for (const runId of [overridden, delivering, newest[0]!]) expect(stored(runId)).not.toBe("");
  for (const [runId, run] of before) expect(f.runs.get(scope, runId)).toEqual(run);
  expect(f.runs.get(scope, overridden).snapshot.report.style).toBe("detailed");
  expect(f.runs.history(scope, f.id, 100)).toEqual(history);
  expect(f.runs.verify(scope, f.id)).toEqual(ledger);
  expect(ledger.valid).toBe(true);
  // The detail and evidence sweeps still read each run's retention through its revision.
  expect(f.runs.pruneDueDetails(true)).toBe(1);
  expect(news.pruneEvidence("2026-09-20T06:00:00.000Z", true)).toBe(1);
});

it("shows a routine's one-off at its date and minute in the routine's zone, and its catch-up as the schedule's missed policy", () => {
  const once = fixture({ engine: true, triggers: [{ id: "launch", kind: "once", runAt: "2026-09-25T06:30:00.000Z" }] });
  expect(once.schedule).toMatchObject({
    spec: { once: "2026-09-25", at: "09:30", timezone: "Europe/Sofia" },
    missedRunPolicy: "run-once-if-missed-within-6h",
  });
  const strict = fixture({ catchUpHours: 0 });
  expect(strict.schedule).toMatchObject({ spec: { at: "09:00", timezone: "Europe/Sofia" }, missedRunPolicy: "skip" });
});

it("upgrades a data directory made before the daily count's index: its runs are counted on it as they were", () => {
  const databasePath = join(directories.create("tavi-local-day-"), "tavi.sqlite");
  const pre = new Database(databasePath);
  try {
    runMigrations(
      pre,
      MIGRATIONS.slice(
        0,
        MIGRATIONS.findIndex((migration) => migration.id === "0017_routine_run_local_day"),
      ),
    );
    pre
      .prepare(
        "INSERT INTO tavi_routines (routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES ('r-old','default','operator','Old',1,1,1,'active',NULL,?,?)",
      )
      .run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    const insert = pre.prepare(
      "INSERT INTO tavi_routine_runs (run_id,routine_id,workspace_id,principal_id,occurrence_key,trigger_id,revision,snapshot_json,mode,status,generation,task_id,scheduled_for,claimed_at,started_at,ended_at,data_json,grant_id) VALUES (?,'r-old','default','operator',?,NULL,1,'{}','production','succeeded',1,NULL,NULL,?,?,?,?,NULL)",
    );
    insert.run(
      "run-a",
      "a",
      "2026-09-20T06:00:00.000Z",
      "2026-09-20T06:00:00.000Z",
      "2026-09-20T06:10:00.000Z",
      JSON.stringify({ localDay: "2026-09-20" }),
    );
    insert.run(
      "run-b",
      "b",
      "2026-09-20T22:00:00.000Z",
      "2026-09-20T22:00:00.000Z",
      "2026-09-20T22:10:00.000Z",
      JSON.stringify({ localDay: "2026-09-21" }),
    );
  } finally {
    pre.close();
  }
  const store = new SqliteStore({ databasePath });
  stores.push(store);
  const count =
    "SELECT COUNT(*) AS n FROM tavi_routine_runs WHERE routine_id=? AND json_extract(data_json,'$.localDay')=? AND started_at IS NOT NULL AND run_id<>?";
  expect(store.handle.prepare(count).get("r-old", "2026-09-20", "none")).toEqual({ n: 1 });
  expect(store.handle.prepare(count).get("r-old", "2026-09-21", "none")).toEqual({ n: 1 });
  // `INDEXED BY` fails to prepare unless the index serves the query: opening ran `PRAGMA optimize`, whose
  // statistics for a two-row table rightly prefer a scan, so the planner's free choice proves nothing here.
  const indexed = count.replace("FROM tavi_routine_runs", "FROM tavi_routine_runs INDEXED BY tavi_routine_runs_local_day_idx");
  const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${indexed}`).all("r-old", "2026-09-20", "none") as { detail: string }[];
  expect(plan.map((row) => row.detail).join("\n")).toContain("USING INDEX tavi_routine_runs_local_day_idx");
});
