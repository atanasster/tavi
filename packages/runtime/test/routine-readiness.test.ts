import { expect, it } from "vitest";
import { ROUTINE_MIN_FREE_BYTES, type RoutineDetail } from "@tavi/contracts";
import type { RoutineReadiness } from "@tavi/contracts";
import { OWNER_HEARTBEAT_STALE_MS } from "@tavi/runtime";
import { RoutineControlService } from "../src/routines/control.js";
import { RoutineDeliveryService } from "../src/routines/delivery.js";
import { RoutineExecutionService } from "../src/routines/runs.js";
import { RoutineNewsService } from "../src/routines/news.js";
import { RoutinePublicationService } from "../src/routines/publication.js";
import { RoutineService } from "../src/routines/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * An actionable readiness view, and history an operator can filter.
 *
 * The readiness probe is asserted to be **read-only**: no run is admitted, no
 * model is called, no message is sent. It answers what *would* happen using the
 * same checks the runtime uses, and it separates research health from delivery
 * health because they fail separately.
 */
const scope = { workspaceId: "default", principalId: "operator" };
function fixture(freeBytes?: () => number | undefined) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  let now = "2026-09-20T06:00:00.000Z";
  // Counted rather than assumed, because the claim this suite makes is an absence:
  // a readiness probe that sent a message would be answering its own question.
  // `send` throws so an accidental call is also loud. No model is reachable from
  // this fixture at all: the evaluator lives in the owner, not in these services.
  let sends = 0;
  const routines = new RoutineService(store, {
    executionAvailable: true,
    authorizeTarget: () => true,
    now: () => now,
    nextOccurrence: () => "2026-09-21T06:00:00.000Z",
  });
  const runs = new RoutineExecutionService(routines, {
    ownerEpoch: "c14",
    now: () => now,
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
    ...(freeBytes === undefined ? {} : { freeBytes }),
  });
  const news = new RoutineNewsService(runs);
  const publication = new RoutinePublicationService(runs, { now: () => now });
  const delivery = new RoutineDeliveryService(runs, {
    now: () => now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        throw new Error("no sends");
      },
    },
  });
  const control = new RoutineControlService({
    routines,
    runs,
    news,
    publication,
    delivery,
    defaultModels: () => ({
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    }),
    allowedHosts: ["example.com"],
    wake: () => {},
    renderer: () => ({ available: true, provider: "fixture" }),
    now: () => now,
  });
  const created = control.execute({
    ...scope,
    action: "create",
    operationKey: "create",
    conversationId: "conversation",
    setup: { name: "Readiness", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" },
  }) as RoutineDetail;
  // Activated, because a readiness view is about a routine the owner is admitting
  // and because only an active routine's heartbeat is this service's to write.
  routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  runs.serviceHeartbeat();
  return {
    store,
    routines,
    runs,
    control,
    routineId: created.routine.routineId,
    setNow: (value: string) => {
      now = value;
    },
    sends: () => sends,
    close: () => store.close(),
  };
}
const ready = (f: ReturnType<typeof fixture>): RoutineReadiness =>
  f.control.execute({ ...scope, action: "readiness", routineId: f.routineId }) as RoutineReadiness;

it("reports research-ready and delivery-blocked separately, without doing anything", () => {
  const f = fixture();
  try {
    const before = f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_runs").get();
    const sendsBefore = f.sends();
    const view = ready(f);
    // Nothing happened: a probe that admitted a run or sent a message would
    // answer its own question.
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_runs").get()).toEqual(before);
    expect(f.sends()).toBe(sendsBefore);
    expect(view).toMatchObject({ routineId: f.routineId, renderer: { available: true, provider: "fixture" } });
    expect(view.research).toMatchObject({
      ready: true,
      blockedBy: null,
      retryable: null,
      hosts: ["example.com"],
      networkMode: "allowlist",
    });
    expect(view.research.tools).toContain("web_search");
    // No destination is configured, so delivery is blocked while research is fine.
    expect(view.delivery).toMatchObject({ authorized: false, targets: [] });
    expect(view.owner.state).toBe("live");
    expect(view.schedule).toMatchObject({ timezone: "Europe/Sofia", enabled: true, nextRunAt: "2026-09-21T06:00:00.000Z" });
    expect(view.revision).toMatchObject({ active: 1, latest: 1, candidate: null });
  } finally {
    f.close();
  }
});

it("reports a grantless run as no durable grant instead of failing the read paths", () => {
  const f = fixture();
  try {
    const run = f.runs.request(scope, f.routineId, "manual");
    expect(ready(f).research.grant).toMatchObject({ grantId: run.grantId as string });
    // The post-upgrade shape migration `0054_routine_grants` leaves behind: the
    // column is NULL and there is no grant row. The run and its ceilings must stay
    // readable, and every read path must say "no grant" rather than `NOT_FOUND`.
    f.store.handle.prepare("UPDATE tavi_routine_runs SET grant_id=NULL WHERE run_id=?").run(run.runId);
    f.store.handle.prepare("DELETE FROM tavi_routine_grants WHERE run_id=?").run(run.runId);
    const view = ready(f);
    expect(view.research.grant).toBeNull();
    expect(view.research.tools).toContain("web_search");
    expect(view.research.hosts).toEqual(["example.com"]);
    const inspected = f.control.execute({ ...scope, action: "inspect", runId: run.runId }) as {
      run: { runId: string };
      grant: unknown;
      effectivePolicy: unknown;
    };
    expect(inspected.run.runId).toBe(run.runId);
    expect(inspected.grant).toBeNull();
    expect(inspected.effectivePolicy).toBeNull();
    // There is nothing to revoke, so the operator action is already satisfied
    // rather than refused.
    expect(() => f.control.execute({ ...scope, action: "revoke_grant", runId: run.runId })).not.toThrow();
    expect(f.control.execute({ ...scope, action: "revoke_grant", runId: run.runId })).toBeNull();
  } finally {
    f.close();
  }
});

it("prefers an armed schedule over a consumed one-off the ordering would sort first", () => {
  const f = fixture();
  try {
    // A consumed one-off: disabled, `next_run_at IS NULL`. SQLite sorts NULL before
    // every instant, so ordering by `next_run_at` alone reports this trigger as the
    // routine's next run while the daily trigger is the one actually armed.
    f.store.handle
      .prepare(
        "INSERT INTO tavi_schedules (schedule_id,workspace_id,principal_id,name,prompt,spec_json,missed_run_policy,auto_approve_tools_json,enabled,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,'{}','skip','[]',0,NULL,?,?)",
      )
      .run("schedule-oneoff", scope.workspaceId, scope.principalId, "One-off", "", "2026-09-19T06:00:00.000Z", "2026-09-19T06:00:00.000Z");
    f.store.handle
      .prepare("INSERT INTO tavi_routine_triggers (routine_id,trigger_id,schedule_id,spec_json,consumed) VALUES (?,?,?,'{}',1)")
      .run(f.routineId, "oneoff", "schedule-oneoff");
    const naive = f.store.handle
      .prepare(
        "SELECT t.trigger_id FROM tavi_schedules s JOIN tavi_routine_triggers t ON t.schedule_id=s.schedule_id WHERE t.routine_id=? ORDER BY s.next_run_at LIMIT 1",
      )
      .get(f.routineId) as { trigger_id: string };
    expect(naive.trigger_id).toBe("oneoff");
    expect(ready(f).schedule).toMatchObject({ triggerId: "morning", enabled: true, nextRunAt: "2026-09-21T06:00:00.000Z" });
  } finally {
    f.close();
  }
});

it("reports the storage floor the admission checks refuse on", () => {
  // One constant behind the readiness boundary and the admission checks, so the
  // view cannot report `belowFloor: false` for a fire the runtime is refusing.
  const under = fixture(() => ROUTINE_MIN_FREE_BYTES - 1);
  try {
    expect(ready(under).storage).toEqual({ freeBytes: ROUTINE_MIN_FREE_BYTES - 1, belowFloor: true });
  } finally {
    under.close();
  }
  const at = fixture(() => ROUTINE_MIN_FREE_BYTES);
  try {
    expect(ready(at).storage).toEqual({ freeBytes: ROUTINE_MIN_FREE_BYTES, belowFloor: false });
  } finally {
    at.close();
  }
});

it("calls a heartbeat older than the threshold unknown rather than offline", () => {
  const f = fixture();
  try {
    expect(ready(f).owner).toMatchObject({ state: "live" });
    f.setNow(new Date(Date.parse("2026-09-20T06:00:00.000Z") + OWNER_HEARTBEAT_STALE_MS + 1_000).toISOString());
    const stale = ready(f);
    // "Stale" and not "offline": nothing here can prove the owner is gone, so the
    // view says the age and lets the operator decide.
    expect(stale.owner.state).toBe("stale");
    expect(stale.owner.heartbeatAgeMs).toBeGreaterThan(OWNER_HEARTBEAT_STALE_MS);
    expect(stale.owner.heartbeatAt).toBe("2026-09-20T06:00:00.000Z");
  } finally {
    f.close();
  }
});

it("distinguishes a failed candidate from the active predecessor it left in place", () => {
  const f = fixture();
  try {
    f.store.handle.prepare("UPDATE tavi_routines SET status='active',active_revision=1 WHERE routine_id=?").run(f.routineId);
    f.store.handle.prepare("UPDATE tavi_routine_evaluations SET status='passed' WHERE routine_id=? AND revision=1").run(f.routineId);
    const current = f.routines.get(scope, f.routineId);
    f.routines.update(scope, {
      routineId: f.routineId,
      expectedVersion: current.routine.version,
      operationKey: "candidate",
      changeSummary: "Candidate",
      snapshot: { ...current.revision.snapshot, objective: "Candidate objective" },
    });
    f.routines.finishEvaluation(scope, f.routineId, 2, false, "Candidate failed the novelty threshold");
    const view = ready(f);
    expect(view.revision).toMatchObject({
      active: 1,
      latest: 2,
      candidate: { revision: 2, evaluation: "failed", detail: expect.stringContaining("novelty") },
    });
  } finally {
    f.close();
  }
});

it("filters history server-side and keeps pagination stable while runs are added", () => {
  const f = fixture();
  try {
    f.store.handle.prepare("UPDATE tavi_routines SET status='active',active_revision=1 WHERE routine_id=?").run(f.routineId);
    f.store.handle.prepare("UPDATE tavi_routine_evaluations SET status='passed' WHERE routine_id=? AND revision=1").run(f.routineId);
    const history = (input: Record<string, unknown>) =>
      f.control.execute({ ...scope, action: "history", routineId: f.routineId, ...input }) as {
        runs: { runId: string; mode: string; status: string; claimedAt: string }[];
      };
    for (const [index, mode] of (["production", "preview", "production", "preview"] as const).entries()) {
      const run = f.runs.request(scope, f.routineId, `manual-${index}`, mode);
      const fence = f.runs.start(scope, run.runId);
      if (fence !== undefined) f.runs.finish(fence, "failed");
    }
    expect(history({ mode: "preview" }).runs.every((entry) => entry.mode === "preview")).toBe(true);
    expect(history({ outcome: "failed" }).runs.every((entry) => entry.status === "failed")).toBe(true);
    // `triggerId` is applied in SQL, so the page contains only that trigger's runs
    // — the manual runs above carry no trigger at all.
    const schedule = f.store.asPort().repositories.schedules.list(scope.workspaceId)[0]!;
    const claimed = f.runs.claim(schedule, schedule.nextRunAt!)!;
    expect(history({ triggerId: "morning" }).runs.map((entry) => entry.runId)).toEqual([claimed.runId]);
    expect(history({ triggerId: "oneoff" }).runs).toEqual([]);
    const all = history({ limit: 2 });
    expect(all.runs).toHaveLength(2);
    const next = history({ limit: 2, beforeRunId: all.runs[1]!.runId });
    // A stable cursor: the second page never repeats a run from the first.
    expect(next.runs.map((entry) => entry.runId)).not.toContain(all.runs[0]!.runId);
    expect(next.runs.map((entry) => entry.runId)).not.toContain(all.runs[1]!.runId);
    // A window that ends before it starts is a mistake, not an empty page.
    expect(() => history({ from: "2026-09-21T00:00:00.000Z", to: "2026-09-20T00:00:00.000Z" })).toThrow(/ends before it starts/);
    expect(() => history({ outcome: "teleported" })).toThrow(/Unknown run outcome/);
    // An unparseable endpoint is the same kind of mistake. The control surface
    // validates its payload, so the caller that can still reach this is an
    // in-process one of the exported port: `Date.parse` returns `NaN`, and a `NaN`
    // comparison would silently drop the bound and page over every run.
    expect(() => f.runs.history(scope, f.routineId, 50, undefined, { from: "not-a-date" })).toThrow(/not a date/);
    expect(() => f.runs.history(scope, f.routineId, 50, undefined, { to: "not-a-date" })).toThrow(/not a date/);
  } finally {
    f.close();
  }
});

it("gives each history row what its run took, without its snapshot, and sums the last seven days in get", () => {
  const f = fixture();
  try {
    f.store.handle.prepare("UPDATE tavi_routines SET status='active',active_revision=1 WHERE routine_id=?").run(f.routineId);
    f.store.handle.prepare("UPDATE tavi_routine_evaluations SET status='passed' WHERE routine_id=? AND revision=1").run(f.routineId);
    const effort = (runId: string, startedAt: string | null, endedAt: string | null, data: Record<string, unknown>) => {
      f.store.handle
        .prepare("UPDATE tavi_routine_runs SET started_at=?,ended_at=?,data_json=json_patch(data_json,?) WHERE run_id=?")
        .run(startedAt, endedAt, JSON.stringify(data), runId);
    };
    // Ten days ago: outside the seven-day total, still in history.
    f.setNow("2026-09-10T06:00:00.000Z");
    const old = f.runs.request(scope, f.routineId, "old", "production");
    effort(old.runId, "2026-09-10T06:00:00.000Z", "2026-09-10T06:10:00.000Z", { modelCalls: 9, toolCalls: 9, tokensKnown: 9000 });
    // Skipped without starting: in the window, but no run to count.
    f.setNow("2026-09-18T06:00:00.000Z");
    const missed = f.runs.request(scope, f.routineId, "missed", "production");
    f.store.handle
      .prepare("UPDATE tavi_routine_runs SET status='skipped',ended_at=?,data_json=json_patch(data_json,?) WHERE run_id=?")
      .run("2026-09-18T06:00:00.000Z", JSON.stringify({ reason: "missed" }), missed.runId);
    f.setNow("2026-09-19T06:00:00.000Z");
    const done = f.runs.request(scope, f.routineId, "done", "production");
    effort(done.runId, "2026-09-19T06:00:00.000Z", "2026-09-19T06:02:05.000Z", {
      modelCalls: 3,
      toolCalls: 7,
      tokensKnown: 12_345,
      publication: {
        reportArtifactId: "art",
        pdfArtifactId: null,
        publishedAt: "2026-09-19T06:02:05.000Z",
        pdfError: null,
        headline: "GPT-9 ships",
      },
    });
    f.setNow("2026-09-20T05:00:00.000Z");
    const live = f.runs.request(scope, f.routineId, "live", "preview");
    effort(live.runId, "2026-09-20T05:00:00.000Z", null, { modelCalls: 1, toolCalls: 0, tokensKnown: 500 });
    f.setNow("2026-09-20T06:00:00.000Z");

    const { runs } = f.control.execute({ ...scope, action: "history", routineId: f.routineId }) as { runs: Record<string, unknown>[] };
    expect(runs.map((run) => run["runId"])).toEqual([live.runId, done.runId, missed.runId, old.runId]);
    expect(runs[1]).toMatchObject({ durationMs: 125_000, modelCalls: 3, toolCalls: 7, tokensKnown: 12_345, headline: "GPT-9 ships" });
    // Still running: no duration yet, and no report to head.
    expect(runs[0]).toMatchObject({ durationMs: null, modelCalls: 1, toolCalls: 0, tokensKnown: 500, headline: null });
    for (const run of runs) {
      expect(run).not.toHaveProperty("snapshot");
      expect(run).not.toHaveProperty("data");
    }

    const detail = f.control.execute({ ...scope, action: "get", routineId: f.routineId }) as Record<string, unknown>;
    expect(detail).not.toHaveProperty("cost");
    expect(detail["lastSevenDays"]).toEqual({
      since: "2026-09-13T06:00:00.000Z",
      runs: 2,
      durationMs: 125_000,
      modelCalls: 4,
      toolCalls: 7,
      tokensKnown: 12_845,
    });
  } finally {
    f.close();
  }
});
