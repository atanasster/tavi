import {
  redactSecretsInText,
  scrubCredentialText,
  ROUTINE_MAX_TRANSIENT_RETRIES,
  ROUTINE_MIN_FREE_BYTES,
  ROUTINE_RUN_STATUSES,
  RoutineSnapshotSchema,
  RoutineRunOverrideSchema,
  TaviError,
  routineResearchOperationKey,
  type RoutineEnvelope,
  type RoutineExecutionPort,
  type RoutineFence,
  type RoutineGrant,
  type RoutineGrantDenial,
  type RoutineGrantResolution,
  type RoutineGrantView,
  type RoutineLedgerEvent,
  type RoutineLedgerVerdict,
  type RoutinePauseCause,
  type RoutineRun,
  type RoutineRunNoticeCause,
  type RoutineRunData,
  type RoutineRunEffortTotals,
  type RoutineRunStatus,
  type RoutineRunSummary,
  type RoutineScope,
  type RoutineStep,
  type RoutineSnapshot,
  type ScheduleRecord,
} from "@tavi/contracts";
import { lateRunNote, ON_TIME_TOLERANCE_MS, routineRunDuration, routineTriggerEnds } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { parseJsonColumn, StoredRoutineRunDataSchema } from "../persistence/json-column.js";
import { canonicalRoutineJson, routineHash, type RoutineService } from "./service.js";
import {
  evaluateRoutineGrant,
  pinRoutineGrant,
  readRoutineGrant,
  routineGrantDecisionFields,
  routineGrantDenyEvent,
  routineGrantRefusal,
  routineGrantView,
  type RoutineGrantEffect,
} from "./grants.js";
import { appendRoutineEvent, routineLedgerDetail, routineLedgerPage, verifyRoutineLedger } from "./ledger.js";

type Row = {
  run_id: string;
  routine_id: string;
  workspace_id: string;
  principal_id: string;
  occurrence_key: string;
  trigger_id: string | null;
  revision: number;
  snapshot_json: string;
  mode: "production" | "preview";
  status: RoutineRunStatus;
  generation: number;
  task_id: string | null;
  grant_id: string | null;
  scheduled_for: string | null;
  claimed_at: string;
  started_at: string | null;
  ended_at: string | null;
  data_json: string;
};
/**
 * A run's snapshot in SQL: its own, or — once `pruneDueSnapshots` dropped it as
 * a byte-for-byte copy of its revision's — that revision's, which is never
 * changed or removed. `run` is the alias of the `tavi_routine_runs` row.
 */
export const routineRunSnapshotSql = (run: string): string =>
  `COALESCE(NULLIF(${run}.snapshot_json,''),(SELECT v.snapshot_json FROM tavi_routine_revisions v WHERE v.routine_id=${run}.routine_id AND v.revision=${run}.revision))`;
/** The columns `decode` reads, the snapshot resolved. */
const runColumns = (run: string): string =>
  `${["run_id", "routine_id", "workspace_id", "principal_id", "occurrence_key", "trigger_id", "revision", "mode", "status", "generation", "task_id", "grant_id", "scheduled_for", "claimed_at", "started_at", "ended_at", "data_json"].map((column) => `${run}.${column}`).join(",")},${routineRunSnapshotSql(run)} AS snapshot_json`;
/** A settled run keeps its own copy of its snapshot this long, and a routine's newest runs keep theirs whatever their age. */
const SNAPSHOT_KEEP_DAYS = 30;
const SNAPSHOT_KEEP_RUNS = 50;
const live = new Set<RoutineRunStatus>(["queued", "running", "interrupted"]);
/**
 * How many routine runs a workspace runs at once. Runs spend most of their time
 * waiting on providers, so two at the same minute both run rather than one
 * waiting out the other's research.
 */
const ROUTINE_CONCURRENT_RUNS = 2;
/** The wait before a run a transient failure cut short starts again: 30 s, then 1 and 2 minutes. */
const TRANSIENT_BACKOFF_MS = 30_000;
/** The steps in the order a run takes them: an excused step takes every later one with it. */
const STEP_ORDER = ["research", "synthesis", "render"] as const;

/**
 * What a scheduled run is told when it is late, in its routine's zone: fired
 * past its trigger time (a catch-up), or going on after an interruption well
 * after it started — whose coverage window still ends where the run began.
 * Undefined for an on-time run, and for one an operator asked for, which has no
 * trigger time to be late against.
 */
export function routineRunLateNote(
  run: Pick<RoutineRun, "scheduledFor" | "claimedAt" | "startedAt" | "generation" | "snapshot">,
  now: string,
): string | undefined {
  if (run.scheduledFor === null) return undefined;
  const runningAt = run.startedAt ?? run.claimedAt;
  const fired = Date.parse(run.claimedAt) - Date.parse(run.scheduledFor) > ON_TIME_TOLERANCE_MS;
  const resumed = run.generation > 1 && Date.parse(now) - Date.parse(runningAt) > ON_TIME_TOLERANCE_MS;
  if (!fired && !resumed) return undefined;
  return lateRunNote({
    scheduledFor: run.scheduledFor,
    runningAt,
    timeZone: run.snapshot.execution.timezone,
    ...(resumed ? { resumedAt: now } : {}),
  });
}
const decode = (r: Row): RoutineRun => ({
  runId: r.run_id,
  routineId: r.routine_id,
  workspaceId: r.workspace_id,
  principalId: r.principal_id,
  occurrenceKey: r.occurrence_key,
  triggerId: r.trigger_id,
  revision: r.revision,
  snapshot: RoutineSnapshotSchema.parse(JSON.parse(r.snapshot_json)),
  mode: r.mode,
  status: r.status,
  generation: r.generation,
  taskId: r.task_id,
  grantId: r.grant_id,
  scheduledFor: r.scheduled_for,
  claimedAt: r.claimed_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  data: parseJsonColumn(StoredRoutineRunDataSchema, r.data_json, "tavi_routine_runs.data_json"),
});
/** The model calls a run's budget counts: every call but those of attempts a transient failure cut short. */
const budgetModelCalls = (data: RoutineRunData): number => data.modelCalls - (data.excusedModelCalls ?? 0);
/** The tool calls a run's budget counts: every call but those of attempts a transient failure cut short. */
const budgetToolCalls = (data: RoutineRunData): number => data.toolCalls - (data.excusedToolCalls ?? 0);
/** A history row: the run's columns but its snapshot, and the few fields of its data a summary shows. */
type SummaryRow = Omit<Row, "snapshot_json" | "data_json"> & {
  model_calls: number | null;
  tool_calls: number | null;
  tokens_known: number | null;
  headline: string | null;
};
/** The columns a history row reads: never the snapshot, and of the data only what a summary shows. */
const SUMMARY_COLUMNS = `run_id,routine_id,workspace_id,principal_id,occurrence_key,trigger_id,revision,mode,status,generation,task_id,grant_id,
  scheduled_for,claimed_at,started_at,ended_at,json_extract(data_json,'$.modelCalls') AS model_calls,json_extract(data_json,'$.toolCalls') AS tool_calls,
  json_extract(data_json,'$.tokensKnown') AS tokens_known,json_extract(data_json,'$.publication.headline') AS headline`;
const decodeSummary = (r: SummaryRow): RoutineRunSummary => ({
  runId: r.run_id,
  routineId: r.routine_id,
  workspaceId: r.workspace_id,
  principalId: r.principal_id,
  occurrenceKey: r.occurrence_key,
  triggerId: r.trigger_id,
  revision: r.revision,
  mode: r.mode,
  status: r.status,
  generation: r.generation,
  taskId: r.task_id,
  grantId: r.grant_id,
  scheduledFor: r.scheduled_for,
  claimedAt: r.claimed_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  durationMs: routineRunDuration(r.started_at, r.ended_at),
  modelCalls: r.model_calls ?? 0,
  toolCalls: r.tool_calls ?? 0,
  tokensKnown: r.tokens_known ?? 0,
  headline: typeof r.headline === "string" ? r.headline : null,
});
/** Filters the server applies to a run history page. */
export interface RoutineHistoryFilter {
  readonly from?: string;
  readonly to?: string;
  readonly outcome?: RoutineRunStatus;
  readonly mode?: "production" | "preview";
  readonly triggerId?: string;
  readonly skipReason?: string;
}
export interface RoutineExecutionOptions {
  readonly ownerEpoch: string;
  readonly now?: () => string;
  /** Rechecked before each provider/tool call and publication, including after resume. */
  readonly authorized: (run: RoutineRun, step: RoutineStep) => boolean;
  readonly freeBytes?: () => number | undefined;
  /** The plugin tools a research step may be granted now (`routinePluginReads`); none when absent. */
  readonly pluginReads?: () => readonly string[];
  /**
   * Whether the owner could research *right now*.
   *
   * Typed against the two fields it reads rather than the whole run, so a
   * read-only readiness probe can ask the same question without admitting
   * anything — the check an operator sees is the check a run would hit.
   */
  readonly researchReady: (run: {
    readonly routineId: string;
    readonly snapshot: RoutineSnapshot;
  }) =>
    | { readonly ready: true }
    | { readonly ready: false; readonly code: "credentials" | "model-retired" | "transient" | "setup-needed"; readonly retryable: boolean };
  /**
   * Tell the routine's person that it paused, or that a run expired before it
   * could finish. False keeps the notice pending, to be tried again on the next
   * sweep; anything else means it was told, or there was nowhere to tell it.
   */
  readonly onPaused?: (run: RoutineRun, cause: RoutineRunNoticeCause) => Promise<boolean | void>;
  /** Cancels the root and descendants through the existing cancellation repository. */
  readonly cancelTask?: (taskId: string) => void;
  /**
   * Reported when a refusal could not be written to the run ledger.
   *
   * The refusal itself still stands — an unrecordable deny never becomes an
   * allow — but a silently missing audit row is not acceptable for a path whose
   * acceptance criterion is "the ledger shows the decision for every research
   * effect", so the gap is surfaced rather than swallowed.
   */
  readonly onLedgerGap?: (input: { readonly runId: string; readonly code: string; readonly error: unknown }) => void;
  /**
   * Transport seams for `web_fetch`.
   *
   * Production uses the pinned-address TLS transport and the system resolver. A
   * deployment may supply its own resolver; a test supplies a resolver and a
   * transport so the guard's refusals are exercised with no real network.
   */
  readonly publicFetch?: {
    readonly execution?: import("../provider-execution.js").ProviderExecutionOptions;
    readonly bindingGeneration?: NonNullable<import("../fetch-tool.js").PublicFetchOptions["bindingGeneration"]>;
    readonly provider?: NonNullable<import("../fetch-tool.js").PublicFetchOptions["provider"]>;
    readonly selection?: NonNullable<import("../fetch-tool.js").PublicFetchOptions["selection"]>;
    readonly resolve?: (hostname: string) => Promise<readonly string[]>;
    readonly transport?: import("../fetch-tool.js").FetchTransportPort;
    readonly maxBytes?: number;
    readonly maxDecodedBytes?: number;
    readonly timeoutMs?: number;
  };
}

/** Durable occurrence/attempt coordinator. Network work stays outside its transactions. */
export class RoutineExecutionService implements RoutineExecutionPort {
  readonly routines: RoutineService;
  readonly options: RoutineExecutionOptions;
  constructor(routines: RoutineService, options: RoutineExecutionOptions) {
    this.routines = routines;
    this.options = options;
  }
  private get db() {
    return this.routines.store.handle;
  }
  private now() {
    return this.options.now?.() ?? nowTimestamp();
  }
  private row(runId: string): RoutineRun {
    const row = this.db.prepare(`SELECT ${runColumns("r")} FROM tavi_routine_runs r WHERE r.run_id=?`).get(runId) as Row | undefined;
    if (row === undefined) throw new TaviError("NOT_FOUND", "Routine run is unavailable");
    return decode(row);
  }
  get(scope: RoutineScope, runId: string): RoutineRun {
    const run = this.row(runId);
    this.routines.get(scope, run.routineId);
    return run;
  }
  /**
   * A routine's runs, newest first, with optional filters.
   *
   * Filtering happens in SQL rather than after the page is read, because a filter
   * applied in memory would page over a shrinking set: a busy routine's new runs
   * would push older matching runs off the page and an operator paging back would
   * silently skip them. The cursor is `(claimed_at, run_id)`, so pagination stays
   * stable while runs are being added.
   */
  history(
    scope: RoutineScope,
    routineId: string,
    limit = 50,
    beforeRunId?: string,
    filter: RoutineHistoryFilter = {},
  ): readonly RoutineRunSummary[] {
    this.routines.get(scope, routineId);
    this.limit(limit);
    const cursor = beforeRunId === undefined ? undefined : this.get(scope, beforeRunId);
    if (cursor !== undefined && cursor.routineId !== routineId)
      throw new TaviError("INVALID_INPUT", "History cursor belongs to another routine");
    if (filter.from !== undefined && !Number.isFinite(Date.parse(filter.from)))
      throw new TaviError("INVALID_INPUT", "History window start is not a date");
    if (filter.to !== undefined && !Number.isFinite(Date.parse(filter.to)))
      throw new TaviError("INVALID_INPUT", "History window end is not a date");
    if (filter.from !== undefined && filter.to !== undefined && Date.parse(filter.from) > Date.parse(filter.to))
      throw new TaviError("INVALID_INPUT", "History window ends before it starts");
    if (filter.outcome !== undefined && !ROUTINE_RUN_STATUSES.includes(filter.outcome))
      throw new TaviError("INVALID_INPUT", "Unknown run outcome");
    if (filter.mode !== undefined && filter.mode !== "production" && filter.mode !== "preview")
      throw new TaviError("INVALID_INPUT", "Unknown run mode");
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM tavi_routine_runs WHERE routine_id=? AND (claimed_at < ? OR (claimed_at = ? AND run_id < ?))
      AND (? IS NULL OR claimed_at >= ?) AND (? IS NULL OR claimed_at <= ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR mode = ?) AND (? IS NULL OR trigger_id = ?)
      AND (? IS NULL OR json_extract(data_json,'$.reason') = ?)
      ORDER BY claimed_at DESC, run_id DESC LIMIT ?`)
      .all(
        routineId,
        cursor?.claimedAt ?? "9999",
        cursor?.claimedAt ?? "9999",
        cursor?.runId ?? "~",
        filter.from ?? null,
        filter.from ?? null,
        filter.to ?? null,
        filter.to ?? null,
        filter.outcome ?? null,
        filter.outcome ?? null,
        filter.mode ?? null,
        filter.mode ?? null,
        filter.triggerId ?? null,
        filter.triggerId ?? null,
        filter.skipReason ?? null,
        filter.skipReason ?? null,
        limit,
      ) as SummaryRow[];
    return rows.map(decodeSummary);
  }
  /**
   * Each routine's newest run, as `history` would page it first, in one
   * statement: the history index seeks every routine's head and the run is read
   * by its key (the unary `+` keeps the scope columns off the workspace index),
   * so a list of routines costs one query however many runs each has. A routine
   * with no run has no entry.
   */
  latestRuns(scope: RoutineScope, routineIds: readonly string[]): ReadonlyMap<string, RoutineRunSummary> {
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM tavi_routine_runs WHERE run_id IN (SELECT (SELECT n.run_id FROM tavi_routine_runs n
        WHERE n.routine_id=j.value ORDER BY n.claimed_at DESC, n.run_id DESC LIMIT 1) FROM json_each(?) j) AND +workspace_id=? AND +principal_id=?`,
      )
      .all(JSON.stringify(routineIds), scope.workspaceId, scope.principalId) as SummaryRow[];
    return new Map(rows.map((row) => [row.routine_id, decodeSummary(row)]));
  }
  /** What a routine's runs claimed since `since` took together, summed in the database; a run that never started is not counted. */
  effortSince(scope: RoutineScope, routineId: string, since: string): RoutineRunEffortTotals {
    this.routines.get(scope, routineId);
    const row = this.db
      .prepare(
        `SELECT COUNT(started_at) AS runs,COALESCE(SUM(json_extract(data_json,'$.modelCalls')),0) AS model_calls,
        COALESCE(SUM(json_extract(data_json,'$.toolCalls')),0) AS tool_calls,COALESCE(SUM(json_extract(data_json,'$.tokensKnown')),0) AS tokens_known,
        COALESCE(SUM(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL THEN MAX(0,(julianday(ended_at)-julianday(started_at))*86400000) END),0) AS duration_ms
        FROM tavi_routine_runs WHERE routine_id=? AND claimed_at>=?`,
      )
      .get(routineId, since) as { runs: number; model_calls: number; tool_calls: number; tokens_known: number; duration_ms: number };
    return {
      since,
      runs: row.runs,
      durationMs: Math.round(row.duration_ms),
      modelCalls: row.model_calls,
      toolCalls: row.tool_calls,
      tokensKnown: row.tokens_known,
    };
  }
  private limit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new TaviError("INVALID_INPUT", "Page limit must be 1–100");
  }
  private writeData(run: RoutineRun, data: RoutineRunData) {
    this.db.prepare("UPDATE tavi_routine_runs SET data_json=? WHERE run_id=?").run(canonicalRoutineJson(data), run.runId);
  }
  private create(
    scope: RoutineScope,
    routineId: string,
    occurrence: string,
    triggerId: string | null,
    scheduledFor: string | null,
    mode: "production" | "preview",
    revision?: number,
  ): RoutineRun {
    const prior = this.db.prepare("SELECT * FROM tavi_routine_runs WHERE routine_id=? AND occurrence_key=?").get(routineId, occurrence) as
      | Row
      | undefined;
    if (prior !== undefined) return this.get(scope, prior.run_id);
    const aggregate = this.routines.get(scope, routineId).routine;
    const detail = this.routines.get(scope, routineId, revision ?? aggregate.activeRevision ?? aggregate.latestRevision);
    const now = this.now();
    const runId = prefixedId("routine-run");
    // Two windows, named, because readers mistook one for the other.
    //
    // `admissionWindow` is how long after its fire time an occurrence may still be
    // *admitted*: it comes from `catchUpHours` and is what `claim` compares a late
    // fire against. `deadline` starts as that same window — an unstarted run is
    // bounded by how stale it may be — and is then overwritten at first start
    // (`start`, below) with the run's own execution budget, `totalMinutes`.
    // `queueExpiresAt` is the admission window and is *not* reset by a restart or
    // extended by a pause; with `overlap: skip` there is no queue to expire, and it
    // is what keeps a paused-then-resumed intent from firing hours late. Only time
    // the run did not choose moves both on: a wait for an execution slot (`start`)
    // and an attempt a transient failure cut short (`interrupt`).
    const admissionWindowMs = Math.max(120_000, detail.revision.snapshot.execution.catchUpHours * 3_600_000);
    const data: RoutineRunData = {
      operationKey: `routine:${runId}`,
      deadline: new Date(Date.parse(now) + admissionWindowMs).toISOString(),
      queueExpiresAt: new Date(Date.parse(now) + admissionWindowMs).toISOString(),
      localDay: new Intl.DateTimeFormat("en-CA", {
        timeZone: detail.revision.snapshot.execution.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now)),
      modelCalls: 0,
      toolCalls: 0,
      tokensReserved: 0,
      tokensKnown: 0,
      usageComplete: true,
      reservations: {},
      stepStarted: {},
    };
    this.db
      .prepare(
        "INSERT INTO tavi_routine_runs (run_id,routine_id,workspace_id,principal_id,occurrence_key,trigger_id,revision,snapshot_json,mode,status,generation,task_id,scheduled_for,claimed_at,started_at,ended_at,data_json,grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?, NULL, NULL, ?, ?)",
      )
      .run(
        runId,
        routineId,
        scope.workspaceId,
        scope.principalId,
        occurrence,
        triggerId,
        detail.revision.revision,
        canonicalRoutineJson(detail.revision.snapshot),
        mode,
        scheduledFor,
        now,
        canonicalRoutineJson(data),
        null,
      );
    // The grant commits in the same transaction as the run, so no run can exist
    // without the authority it was admitted under.
    const grant = pinRoutineGrant(
      this.db,
      scope,
      { runId, routineId, revision: detail.revision.revision, mode },
      detail.revision.snapshot,
      now,
    );
    this.db.prepare("UPDATE tavi_routine_runs SET grant_id=? WHERE run_id=?").run(grant.grantId, runId);
    const run = this.row(runId);
    this.append(run, { version: 1, code: "claimed" });
    this.append(run, { version: 1, code: "grant", decision: "allow", grantId: grant.grantId, policyRevision: grant.policyRevision });
    return run;
  }
  /** Evaluate one effect against the run's pinned grant (`evaluateRoutineGrant`). Read-only; callers decide how to refuse. */
  private evaluateGrant(run: RoutineRun, step: RoutineStep, effect?: RoutineGrantEffect): RoutineGrantResolution {
    return evaluateRoutineGrant(this.db, this.options, run, step, effect);
  }
  /**
   * Resolve the bounded policy for one effect, immediately before it happens.
   * See `evaluateRoutineGrant` for exactly what is intersected and what is deliberately narrowed.
   */
  resolveGrant(fence: RoutineFence, step: RoutineStep, effect?: RoutineGrantEffect): RoutineGrantResolution {
    return this.evaluateGrant(this.row(fence.runId), step, effect);
  }
  /**
   * Enforce one effect against the loaded grant, recording the denial before it
   * throws. The single implementation behind `assertGrant` and the grant half of
   * `assertFence`, so the fence path and the test seam cannot disagree about what
   * a denial records or what it throws.
   */
  private enforceGrant(run: RoutineRun, fence: RoutineFence, step: RoutineStep, effect?: RoutineGrantEffect): RoutineGrant {
    const resolution = this.evaluateGrant(run, step, effect);
    if (resolution.allowed) return resolution.grant;
    this.recordGrantDenial(fence, step, resolution, effect);
    throw routineGrantRefusal(resolution);
  }
  /** Fail-closed assertion form of `resolveGrant`; records the deny decision before throwing. */
  assertGrant(fence: RoutineFence, step: RoutineStep, effect?: RoutineGrantEffect): RoutineGrant {
    return this.enforceGrant(this.row(fence.runId), fence, step, effect);
  }
  /**
   * Record a refused effect against the run the fence names.
   *
   * The fence's generation and attempt travel into the event, so the ledger shows
   * which attempt of which run tried the effect; `appendGrantDeny` owns the
   * append itself.
   */
  private recordGrantDenial(
    fence: RoutineFence,
    step: RoutineStep,
    resolution: { code: RoutineGrantDenial; detail: string },
    effect?: RoutineGrantEffect,
  ): void {
    this.appendGrantDeny(this.row(fence.runId), fence.generation, fence.attemptId, step, resolution, effect);
  }
  /**
   * Record a refused effect.
   *
   * The append is atomic — the head read and the insert share one transaction, so
   * a concurrent writer cannot interleave a sequence number (the hazard
   * `SqliteStore`'s own transaction helper documents). A run that is already
   * fenced, or a database that refuses the write, still refuses the effect; the
   * difference is that the gap is *reported* rather than swallowed,
   * and the refused effect's own identity is recorded alongside the pinned one.
   */
  private appendGrantDeny(
    run: RoutineRun,
    generation: number,
    attemptId: string | null,
    step: RoutineStep,
    resolution: { code: RoutineGrantDenial; detail: string },
    effect?: RoutineGrantEffect,
  ): void {
    try {
      this.db.transaction(() => {
        const event = routineGrantDenyEvent(run, generation, step, resolution, effect);
        this.append(run, event.envelope, attemptId, event.detail);
      })();
    } catch (error) {
      this.options.onLedgerGap?.({ runId: run.runId, code: resolution.code, error });
    }
  }
  /**
   * The grant check a delivery effect uses.
   *
   * Delivery runs outside the attempt fence (a queued job outlives the attempt
   * that staged it), so it resolves against the run's current generation instead
   * of a fence — the caller has already checked generation, cancellation and
   * archive status, and this is the authority half of that boundary.
   */
  assertGrantForRun(scope: RoutineScope, runId: string, step: RoutineStep, effect?: RoutineGrantEffect): RoutineGrant {
    const run = this.get(scope, runId);
    const resolution = this.evaluateGrant(run, step, effect);
    if (resolution.allowed) return resolution.grant;
    this.appendGrantDeny(run, run.generation, null, step, resolution, effect);
    throw routineGrantRefusal(resolution);
  }
  /**
   * Record an effect the *address* guard refused.
   *
   * The grant's host list is a name rule; an address refusal is the other half of
   * the same decision, and an operator reading the ledger must see it there rather
   * than only in a thrown error. `host-outside-grant` is the accurate code: the
   * destination is outside what the grant can reach, whatever the name says.
   */
  recordEgressDenial(fence: RoutineFence, step: RoutineStep, tool: string, url: string | undefined, detail: string): void {
    this.appendGrantDeny(
      this.row(fence.runId),
      fence.generation,
      fence.attemptId,
      step,
      { code: "host-outside-grant", detail },
      { tool, ...(url === undefined ? {} : { url }) },
    );
  }
  /** The run's pinned grant as persisted (`readRoutineGrant`), or `null` when it has none. */
  grantFor(
    scope: RoutineScope,
    runId: string,
  ): (RoutineGrant & { readonly revokedAt: string | null; readonly revokedReason: string | null }) | null {
    return readRoutineGrant(this.db, this.get(scope, runId));
  }
  /** The run's grant as the operator gets it (`routineGrantView`), or `null` when it has no usable grant. */
  effectiveGrantPolicy(scope: RoutineScope, runId: string): RoutineGrantView | null {
    const run = this.get(scope, runId);
    const grant = this.grantFor(scope, runId);
    if (grant === null) return null;
    return routineGrantView(run, grant, this.options.pluginReads?.() ?? []);
  }
  /**
   * Revoke a run's authority. The next effect fails closed; already-fetched
   * evidence is untouched. Reachable from the operator surface
   * (`routines.revoke_grant`) and from `cancel`. A run with no durable grant has
   * nothing to revoke, so the view comes back `null` rather than refusing an
   * operator action that is already true.
   */
  revokeGrant(scope: RoutineScope, runId: string, reason = "Revoked by the operator"): RoutineGrantView | null {
    const run = this.get(scope, runId);
    this.db.transaction(() => {
      const changed = this.db
        .prepare("UPDATE tavi_routine_grants SET revoked_at=?,revoked_reason=? WHERE run_id=? AND revoked_at IS NULL")
        .run(this.now(), reason, runId);
      if (changed.changes > 0)
        this.append(run, {
          version: 1,
          code: "grant",
          generation: run.generation,
          decision: "deny",
          denial: "grant-revoked",
          ...(run.grantId === null ? {} : { grantId: run.grantId }),
        });
    })();
    return this.effectiveGrantPolicy(scope, runId);
  }
  /** The schedule CAS and durable dispatch intent commit together. */
  claim(schedule: ScheduleRecord, fireTime: string): RoutineRun | undefined {
    return this.db.transaction(() => {
      const free = this.options.freeBytes?.();
      if (free !== undefined && free < ROUTINE_MIN_FREE_BYTES) return undefined;
      const owner = this.routines.scheduleOwner(schedule.scheduleId);
      if (owner === undefined) return undefined;
      const scope = { workspaceId: schedule.workspaceId, principalId: schedule.principalId };
      const detail = this.routines.get(scope, owner.routineId);
      // `credential-blocked` is research *health*, not a stop: the routine keeps
      // being admitted so it can recover when the credential returns.
      if (!["active", "credential-blocked"].includes(detail.routine.status) || detail.routine.activeRevision === null) return undefined;
      const active = this.routines.get(scope, owner.routineId, detail.routine.activeRevision);
      const trigger = active.revision.snapshot.triggers.find((item) => item.id === owner.triggerId);
      if (trigger === undefined) return undefined;
      const now = this.now();
      const next = this.routines.options.nextOccurrence(trigger, new Date(now));
      // The schedule row's compare-and-set takes a string; a one-off is disabled in this same transaction.
      if (
        !this.routines.store
          .asPort()
          .repositories.schedules.claimFire({ scheduleId: schedule.scheduleId, fireTime, nextRunAt: next ?? fireTime, now })
      )
        return undefined;
      const run = this.create(
        scope,
        owner.routineId,
        `${owner.triggerId}:${fireTime}`,
        owner.triggerId,
        fireTime,
        "production",
        active.revision.revision,
      );
      if (trigger.kind === "once" || (next === null && routineTriggerEnds(trigger)))
        this.routines.consumeOneOff(scope, owner.routineId, trigger.id);
      const late = Date.parse(now) - Date.parse(fireTime);
      if (late > Math.max(120_000, run.snapshot.execution.catchUpHours * 3_600_000)) this.terminal(run, "skipped", "missed");
      else if (
        this.db
          .prepare(
            "SELECT 1 FROM tavi_routine_runs WHERE routine_id=? AND run_id<>? AND status IN ('queued','running','interrupted') LIMIT 1",
          )
          .get(run.routineId, run.runId) !== undefined
      )
        this.terminal(run, "skipped", "overlap");
      // The trigger row's "last run" names a fire that ran: one skipped above leaves it.
      else this.db.prepare("UPDATE tavi_schedules SET last_run_at=? WHERE schedule_id=?").run(fireTime, schedule.scheduleId);
      return this.row(run.runId);
    })();
  }
  request(
    scope: RoutineScope,
    routineId: string,
    operationKey: string,
    mode: "production" | "preview" = "production",
    revision?: number,
    override?: { style?: "summary" | "detailed" | undefined; maxItems?: number | undefined },
  ): RoutineRun {
    const parsedOverride = RoutineRunOverrideSchema.parse(override ?? {});
    const overrideHash = routineHash(parsedOverride);
    if (operationKey.length < 1 || operationKey.length > 128) throw new TaviError("INVALID_INPUT", "Invalid operation key");
    return this.db.transaction(() => {
      const detail = this.routines.get(scope, routineId);
      const prior = this.db
        .prepare("SELECT * FROM tavi_routine_runs WHERE routine_id=? AND occurrence_key=?")
        .get(routineId, `${mode}:${operationKey}`) as Row | undefined;
      if (prior !== undefined) {
        const saved = JSON.parse(prior.data_json) as { overrideHash?: string };
        if ((saved.overrideHash ?? routineHash({})) !== overrideHash || (revision !== undefined && prior.revision !== revision))
          throw new TaviError("CONFLICT", "Run operation key names different input");
        return this.get(scope, prior.run_id);
      }
      // `credential-blocked` is research health, not a stop: an operator may still
      // ask for a run, and the readiness check decides what happens to it.
      if (mode === "production" && !["active", "credential-blocked"].includes(detail.routine.status))
        throw new TaviError("INVALID_INPUT", "Routine is not active");
      if (mode === "production" && revision !== undefined && revision !== detail.routine.activeRevision)
        throw new TaviError("INVALID_INPUT", "Production runs require the active evaluated revision");
      if (detail.routine.status === "archived") throw new TaviError("INVALID_INPUT", "Routine is archived");
      const run = this.create(scope, routineId, `${mode}:${operationKey}`, null, null, mode, revision);
      this.db
        .prepare("UPDATE tavi_routine_runs SET snapshot_json=?,data_json=? WHERE run_id=?")
        .run(
          canonicalRoutineJson({ ...run.snapshot, report: { ...run.snapshot.report, ...parsedOverride } }),
          canonicalRoutineJson({ ...run.data, overrideHash, override: parsedOverride }),
          run.runId,
        );
      if (
        run.status === "queued" &&
        this.db
          .prepare(
            "SELECT 1 FROM tavi_routine_runs WHERE routine_id=? AND run_id<>? AND status IN ('running','queued','interrupted') LIMIT 1",
          )
          .get(routineId, run.runId) !== undefined
      )
        this.terminal(run, "skipped", "overlap");
      return this.row(run.runId);
    })();
  }
  private terminal(run: RoutineRun, status: RoutineRunStatus, reason: RoutineEnvelope["code"], detail?: string) {
    // Shown on the run's page as the ledger's text is: a key or a token an error quoted is masked first.
    const failureDetail =
      status === "failed" && detail !== undefined && detail.trim() !== ""
        ? redactSecretsInText(scrubCredentialText(detail.trim())).slice(0, 500)
        : undefined;
    this.db
      .prepare("UPDATE tavi_routine_runs SET status=?,ended_at=?,data_json=? WHERE run_id=?")
      .run(
        status,
        this.now(),
        canonicalRoutineJson({ ...run.data, reason, ...(failureDetail === undefined ? {} : { failureDetail }) }),
        run.runId,
      );
    this.append(run, { version: 1, code: reason, generation: run.generation });
  }
  /**
   * Settle every active wait the run's tasks still hold, and settle the tasks.
   *
   * A routine has no suspension owner: its root is admitted under
   * `ROUTINE_TASK_POLICY`, which refuses `agents.wait` before a wait row exists,
   * and neither the chat tool nor the IPC surface can answer one.
   * This is the invariant's backstop, not its enforcement: it runs on every
   * terminal transition so that even a wait that arrived another way — an older
   * build's checkpoint, a restored database, a provider that ignored the offered
   * tool list — cannot leave a `waiting` task behind a finished run.
   */
  settleRunWaits(run: RoutineRun, detail: string): number {
    const repositories = this.routines.store.asPort().repositories;
    const taskIds = new Set<string>();
    if (run.taskId !== null) taskIds.add(run.taskId);
    const root = repositories.tasks.getByOperationKey(run.workspaceId, run.principalId, run.data.operationKey);
    if (root !== undefined) taskIds.add(root.taskId);
    const worker = repositories.tasks.getByOperationKey(run.workspaceId, run.principalId, routineResearchOperationKey(run.data));
    if (worker !== undefined) taskIds.add(worker.taskId);
    for (const taskId of [...taskIds]) {
      for (const child of this.db
        .prepare("SELECT worker_task_id FROM tavi_agent_delegation_admissions WHERE root_task_id=? AND workspace_id=? AND principal_id=?")
        .all(taskId, run.workspaceId, run.principalId) as { worker_task_id: string }[])
        taskIds.add(child.worker_task_id);
    }
    let settled = 0;
    for (const taskId of taskIds) {
      // An approval round a routine raised (an `ask` rule, a critical call) is
      // as unanswerable as a wait once the run is over: its rows would sit in
      // the inbox as a decision nobody can make.
      settled += repositories.approvals.cancelPendingForTask(taskId, () => this.now());
      for (const round of repositories.approvalRounds.listForTask(taskId)) {
        if (round.settledAt === undefined && repositories.approvalRounds.settle(taskId, round.steps, this.now())) {
          repositories.approvalRounds.appendEvent({
            taskId,
            steps: round.steps,
            kind: "settled",
            via: "policy",
            actor: "policy",
            detail: { reason: "run-ended", detail },
            at: this.now(),
          });
          settled++;
        }
      }
      const wait = repositories.agentWaits.getActiveByTask(taskId);
      if (
        wait !== undefined &&
        repositories.agentWaits.settle({
          waitId: wait.waitId,
          outcome: { kind: "cancelled", error: { code: "ROUTINE_NO_SUSPENSION_OWNER", message: detail } },
          by: "policy",
          via: "policy",
        })
      )
        settled++;
      const task = repositories.tasks.get(taskId);
      // A task left `waiting` by a settlement is the state this method exists to
      // remove: the run is terminal, so nothing will ever resume it.
      if (task !== undefined && task.status === "waiting") {
        repositories.tasks.updateStatus(taskId, "failed", detail);
        settled++;
      }
    }
    return settled;
  }
  /**
   * Start or resume a run. A queued row is already a durable dispatch intent.
   *
   * A workspace runs `ROUTINE_CONCURRENT_RUNS` at once. A run waiting for a slot
   * is not stale: its slot is checked before its windows, and once it has one,
   * its admission window and deadline move on by the time it waited — up to the
   * moment a slot last came free. Only a wait this owner recorded counts, so an
   * owner that was stopped or crashed meanwhile does not fire it hours late.
   */
  start(scope: RoutineScope, runId: string): RoutineFence | undefined {
    return this.db.transaction(() => {
      const run = this.get(scope, runId);
      if (run.status !== "queued" && run.status !== "interrupted") return undefined;
      const aggregate = this.routines.get(scope, run.routineId).routine;
      if (run.taskId !== null && this.routines.store.asPort().repositories.cancellations.get(run.taskId) !== undefined) {
        this.terminal(run, "cancelled", "cancelled");
        return undefined;
      }
      if (aggregate.status === "archived") {
        this.terminal(run, "cancelled", "cancelled");
        return undefined;
      }
      const paused = run.mode === "production" && ["paused", "paused-failures"].includes(aggregate.status);
      if (!paused) {
        const running = this.db
          .prepare("SELECT COUNT(*) AS n FROM tavi_routine_runs WHERE workspace_id=? AND status='running'")
          .get(run.workspaceId) as { n: number };
        const ownWait = run.data.slotWaitSince !== undefined && run.data.slotWaitEpoch === this.options.ownerEpoch;
        if (running.n >= ROUTINE_CONCURRENT_RUNS) {
          if (!ownWait) this.writeData(run, { ...run.data, slotWaitSince: this.now(), slotWaitEpoch: this.options.ownerEpoch });
          return undefined;
        }
        if (run.data.slotWaitSince !== undefined && ownWait) {
          const freed = this.db
            .prepare(
              "SELECT MAX(a.ended_at) AS at FROM tavi_routine_attempts a JOIN tavi_routine_runs r ON r.run_id=a.run_id WHERE r.workspace_id=? AND a.run_id<>? AND a.ended_at>=?",
            )
            .get(run.workspaceId, run.runId, run.data.slotWaitSince) as { at: string | null };
          const waited = Math.max(0, Date.parse(freed.at ?? this.now()) - Date.parse(run.data.slotWaitSince));
          const later = (at: string) => new Date(Date.parse(at) + waited).toISOString();
          run.data.queueExpiresAt = later(run.data.queueExpiresAt);
          run.data.deadline = later(run.data.deadline);
        }
        if (run.data.slotWaitSince !== undefined) {
          delete run.data.slotWaitSince;
          delete run.data.slotWaitEpoch;
          this.writeData(run, run.data);
        }
      }
      if (this.now() > run.data.queueExpiresAt || this.now() > run.data.deadline) {
        this.terminal(run, "skipped", "expired");
        // The day's report is lost, which nobody would hear of otherwise. A
        // paused routine's runs expire too, and its pause was already told.
        if (!paused && run.mode === "production")
          this.db
            .prepare("UPDATE tavi_routine_state SET state_json=json_set(state_json,'$.pendingExpiry',?) WHERE routine_id=?")
            .run(run.runId, run.routineId);
        return undefined;
      }
      if (paused) return undefined;
      // A transient failure's backoff: the run is resumed on a later sweep.
      if (run.data.retryAfter !== undefined && this.now() < run.data.retryAfter) return undefined;
      const free = this.options.freeBytes?.();
      if (free !== undefined && free < ROUTINE_MIN_FREE_BYTES) return undefined;
      const readiness = this.options.researchReady(run);
      if (!readiness.ready) {
        this.blocked(run, readiness);
        return undefined;
      }
      if (!this.options.authorized(run, "research")) {
        this.terminal(run, "skipped", "revoked");
        return undefined;
      }
      if (run.startedAt === null)
        run.data.localDay = new Intl.DateTimeFormat("en-CA", {
          timeZone: run.snapshot.execution.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(this.now()));
      if (run.startedAt === null && this.startedOn(run.routineId, run.runId, run.data.localDay) >= run.snapshot.execution.dailyAdmissions) {
        this.terminal(run, "skipped", "daily-budget");
        return undefined;
      }
      // The admission window becomes the run's execution budget: from here the
      // deadline bounds the work, not the lateness.
      if (run.startedAt === null)
        run.data.deadline = new Date(Date.parse(this.now()) + run.snapshot.execution.totalMinutes * 60_000).toISOString();
      this.writeData(run, run.data);
      const generation = run.generation + 1;
      const attemptId = prefixedId("routine-attempt");
      const now = this.now();
      this.db
        .prepare("UPDATE tavi_routine_runs SET status='running',generation=?,started_at=COALESCE(started_at,?) WHERE run_id=?")
        .run(generation, now, runId);
      this.db
        .prepare("INSERT INTO tavi_routine_attempts VALUES (?, ?, ?, ?, 'running', ?, NULL, ?, '{}')")
        .run(attemptId, runId, generation, this.options.ownerEpoch, now, now);
      this.append(run, { version: 1, code: run.generation > 0 ? "recovered" : "started", generation }, attemptId);
      return { runId, generation, attemptId, ownerEpoch: this.options.ownerEpoch };
    })();
  }
  /**
   * How many of a routine's other runs started on `localDay`: each run's own
   * day, in its revision's zone as it started, counted on the
   * `tavi_routine_runs_local_day_idx` expression index.
   */
  private startedOn(routineId: string, runId: string, localDay: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tavi_routine_runs WHERE routine_id=? AND json_extract(data_json,'$.localDay')=? AND started_at IS NOT NULL AND run_id<>?",
        )
        .get(routineId, localDay, runId) as { n: number }
    ).n;
  }
  private blocked(
    run: RoutineRun,
    readiness: { code: "credentials" | "model-retired" | "transient" | "setup-needed"; retryable: boolean },
  ) {
    this.terminal(run, "skipped", readiness.code);
    this.append(run, { version: 1, code: readiness.code, retryable: readiness.retryable });
    if (run.mode === "preview" || readiness.code !== "credentials") return;
    this.credentialBlocked(run);
  }
  /**
   * Research could not authenticate: before admission, or mid-run when a model
   * or tool refused its credential. It is not counted as a research failure —
   * the credential grace decides when the routine pauses.
   */
  private credentialBlocked(run: RoutineRun) {
    const now = this.now();
    this.db
      .prepare("UPDATE tavi_routine_state SET research_blocked_since=COALESCE(research_blocked_since,?),heartbeat_at=? WHERE routine_id=?")
      .run(now, now, run.routineId);
    // An operator-visible `credential-blocked` status. It is research health only: `claim` keeps admitting the
    // routine, so a returning credential recovers it without an operator, and a
    // delivery-only problem never reaches this branch.
    this.db
      .prepare("UPDATE tavi_routines SET status='credential-blocked',version=version+1,updated_at=? WHERE routine_id=? AND status='active'")
      .run(now, run.routineId);
    const row = this.db.prepare("SELECT research_blocked_since FROM tavi_routine_state WHERE routine_id=?").get(run.routineId) as {
      research_blocked_since: string;
    };
    // 72 hours by default, because a credential outage an operator has not noticed within three days is
    // one worth pausing for rather than retrying forever, and the pause is
    // reported. It is a per-revision default, so an operator who disagrees changes
    // it in the revision.
    if (Date.parse(now) - Date.parse(row.research_blocked_since) >= run.snapshot.execution.credentialGraceHours * 3_600_000)
      this.pauseFailures(run, "credential-grace");
  }
  private pauseFailures(run: RoutineRun, cause: RoutinePauseCause) {
    const changed = this.db
      .prepare(
        "UPDATE tavi_routines SET status='paused-failures',version=version+1,updated_at=? WHERE routine_id=? AND status NOT IN ('archived','completed','paused','paused-failures')",
      )
      .run(this.now(), run.routineId);
    if (changed.changes === 0) return;
    this.append(run, { version: 1, code: "auto-paused" });
    this.db
      .prepare(
        "UPDATE tavi_routine_state SET state_json=json_set(state_json,'$.pendingAutoPause',?,'$.pendingAutoPauseCause',?) WHERE routine_id=?",
      )
      .run(run.runId, cause, run.routineId);
    this.db
      .prepare(
        "UPDATE tavi_schedules SET enabled=0,next_run_at=NULL WHERE schedule_id IN (SELECT schedule_id FROM tavi_routine_triggers WHERE routine_id=?)",
      )
      .run(run.routineId);
  }
  assertFence(fence: RoutineFence, step?: RoutineStep, enforceDeadline = true, effect?: RoutineGrantEffect): RoutineRun {
    const run = this.row(fence.runId);
    const attempt = this.db
      .prepare("SELECT owner_epoch,status FROM tavi_routine_attempts WHERE attempt_id=? AND run_id=? AND generation=?")
      .get(fence.attemptId, fence.runId, fence.generation) as { owner_epoch: string; status: string } | undefined;
    if (
      run.status !== "running" ||
      run.generation !== fence.generation ||
      attempt?.owner_epoch !== fence.ownerEpoch ||
      attempt.status !== "running" ||
      fence.ownerEpoch !== this.options.ownerEpoch
    )
      throw new TaviError("CONFLICT", "Routine attempt is fenced");
    if (run.taskId !== null && this.routines.store.asPort().repositories.cancellations.get(run.taskId) !== undefined)
      throw new TaviError("CANCELLED", "Routine root task was cancelled");
    if (enforceDeadline && this.now() > run.data.deadline) throw new TaviError("CONFLICT", "Routine deadline exceeded");
    // Every step-scoped fence re-resolves the durable grant from storage, so a
    // revocation between effects is observed immediately. The caller may
    // hand in the effect it is about to perform (including its identity claim)
    // so one fence evaluates the grant once.
    if (step !== undefined) this.enforceGrant(run, fence, step, effect);
    if (step !== undefined) {
      const started = run.data.stepStarted[step];
      const minutes = run.snapshot.execution[`${step}Minutes`];
      if (started !== undefined && Date.parse(this.now()) - Date.parse(started) > minutes * 60_000)
        throw new TaviError("CONFLICT", "Routine step deadline exceeded");
    }
    return run;
  }
  remainingMs(fence: RoutineFence, step: RoutineStep): number {
    const run = this.assertFence(fence, step);
    return Math.max(
      1,
      Math.min(
        Date.parse(run.data.deadline),
        Date.parse(run.data.stepStarted[step] ?? this.now()) + run.snapshot.execution[`${step}Minutes`] * 60_000,
      ) - Date.parse(this.now()),
    );
  }
  beginStep(fence: RoutineFence, step: RoutineStep): void {
    // One fence (and one grant) evaluation: the checked run is the one the
    // transaction writes, so a research effect does not pay for the authority
    // check three times.
    const run = this.assertFence(fence, step);
    this.db.transaction(() => {
      if (run.data.stepStarted[step] === undefined) {
        run.data.stepStarted[step] = this.now();
        // What the step begins from, so an attempt a transient failure cuts short can be excused.
        run.data.stepBase = {
          ...run.data.stepBase,
          [step]: { modelCalls: run.data.modelCalls, toolCalls: run.data.toolCalls, tokensReserved: run.data.tokensReserved },
        };
        this.writeData(run, run.data);
      }
    })();
  }
  /**
   * A human checkpoint's wait is not the step's work: once the question
   * is answered, the step's clock moves on by the time it waited, so a run that
   * asked keeps the whole step budget it would have had. The run's own deadline
   * is untouched; the question's deadline is held inside it.
   */
  excuseStepWait(fence: RoutineFence, step: RoutineStep, since: string): void {
    this.db
      .transaction(() => {
        const run = this.assertFence(fence, undefined, true);
        const started = run.data.stepStarted[step];
        const waited = Date.parse(this.now()) - Date.parse(since);
        if (started === undefined || !(waited > 0)) return;
        run.data.stepStarted[step] = new Date(Date.parse(started) + waited).toISOString();
        this.writeData(run, run.data);
      })
      .immediate();
  }
  bindTask(fence: RoutineFence, taskId: string): void {
    this.db.transaction(() => {
      this.assertFence(fence);
      this.db.prepare("UPDATE tavi_routine_runs SET task_id=COALESCE(task_id,?) WHERE run_id=?").run(taskId, fence.runId);
    })();
  }
  pruneDueDetails(dryRun = false): number {
    if (dryRun)
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tavi_routine_details WHERE payload IS NOT NULL AND julianday(created_at) < julianday(?) - COALESCE((SELECT json_extract(${routineRunSnapshotSql("r")},'$.retention.detailDays') FROM tavi_routine_runs r WHERE r.run_id=tavi_routine_details.run_id),365)`,
          )
          .get(this.now()) as { n: number }
      ).n;
    return this.db
      .prepare(
        `UPDATE tavi_routine_details SET payload=NULL,pruned_at=? WHERE payload IS NOT NULL AND julianday(created_at) < julianday(?) - COALESCE((SELECT json_extract(${routineRunSnapshotSql("r")},'$.retention.detailDays') FROM tavi_routine_runs r WHERE r.run_id=tavi_routine_details.run_id),365)`,
      )
      .run(this.now(), this.now()).changes;
  }
  /**
   * Drop the stored snapshot of old settled runs where it is a copy of their
   * revision's, byte for byte; returns how many (`dryRun`: would). The run then
   * reads its revision's (`routineRunSnapshotSql`), so nothing it was admitted,
   * run, delivered or verified under changes: a revision is never changed or
   * removed, and the ledger does not hash snapshots. A run keeps its own copy
   * while it is live, for `SNAPSHOT_KEEP_DAYS` after it ended, while it is among
   * its routine's newest `SNAPSHOT_KEEP_RUNS`, while a delivery of it is still
   * open, and always when its snapshot differs from the revision's (a requested
   * run's report override).
   */
  pruneDueSnapshots(dryRun = false): number {
    const due = `FROM tavi_routine_runs r WHERE r.snapshot_json<>'' AND r.status NOT IN ('queued','running','interrupted')
      AND r.ended_at IS NOT NULL AND julianday(r.ended_at) < julianday(?) - ${SNAPSHOT_KEEP_DAYS}
      AND r.snapshot_json=(SELECT v.snapshot_json FROM tavi_routine_revisions v WHERE v.routine_id=r.routine_id AND v.revision=r.revision)
      AND NOT EXISTS (SELECT 1 FROM tavi_routine_delivery_jobs j WHERE j.run_id=r.run_id AND j.status IN ('pending','deferred','dispatching','uncertain'))
      AND r.run_id NOT IN (SELECT run_id FROM (SELECT run_id,ROW_NUMBER() OVER (PARTITION BY routine_id ORDER BY claimed_at DESC,run_id DESC) AS n
        FROM tavi_routine_runs) WHERE n<=${SNAPSHOT_KEEP_RUNS})`;
    if (dryRun) return (this.db.prepare(`SELECT COUNT(*) AS n ${due}`).get(this.now()) as { n: number }).n;
    return this.db.prepare(`UPDATE tavi_routine_runs SET snapshot_json='' WHERE run_id IN (SELECT r.run_id ${due})`).run(this.now())
      .changes;
  }
  serviceHeartbeat(): void {
    this.db
      .prepare(
        "UPDATE tavi_routine_state SET heartbeat_at=? WHERE routine_id IN (SELECT routine_id FROM tavi_routines WHERE status IN ('active','credential-blocked'))",
      )
      .run(this.now());
  }
  heartbeat(fence: RoutineFence): void {
    // Immediate: a run waiting on a checkpoint question beats while its resumed
    // turn writes through another connection, and a deferred read-then-write
    // would fail on that commit rather than wait for it.
    this.db
      .transaction(() => {
        const run = this.assertFence(fence);
        this.db.prepare("UPDATE tavi_routine_attempts SET heartbeat_at=? WHERE attempt_id=?").run(this.now(), fence.attemptId);
        if (run.mode === "production")
          this.db.prepare("UPDATE tavi_routine_state SET heartbeat_at=? WHERE routine_id=?").run(this.now(), run.routineId);
      })
      .immediate();
  }
  reserveModel(
    fence: RoutineFence,
    step: "research" | "synthesis",
    reservationId: string,
    tokens: number,
    target: { connectionId: string; model: string; bindingHash?: string; operation?: import("@tavi/contracts").ProviderOperation },
    claim?: { grantId?: string | null },
  ): void {
    // The authority check happens *outside* the write transaction below: a deny
    // recorded inside a transaction that then throws would be rolled back with
    // it, and the ledger's "every research effect has a decision" guarantee would
    // fail exactly when it matters. The checked run is the
    // one the transaction writes.
    const run = this.assertFence(fence, step, true, claim);
    let exhausted = false;
    this.db.transaction(() => {
      const data = run.data;
      const policy = run.snapshot.execution;
      if (!Number.isSafeInteger(tokens) || tokens < 1 || Object.hasOwn(data.reservations, reservationId))
        throw new TaviError("INVALID_INPUT", "Invalid model reservation");
      const modelPolicy = run.snapshot.models[step];
      if (
        ![modelPolicy.primary, ...modelPolicy.fallbacks].some(
          (item) => item.connectionId === target.connectionId && item.model === target.model && item.bindingHash === target.bindingHash,
        )
      )
        throw new TaviError("NOT_AUTHORIZED", "Model is outside the admitted policy");
      // Reserve one model call for synthesis; fallback provider attempts each count.
      if (budgetModelCalls(data) >= policy.modelCalls - (step === "research" ? 1 : 0) || data.tokensReserved + tokens > policy.tokens) {
        exhausted = true;
        return;
      }
      data.modelCalls++;
      data.tokensReserved += tokens;
      data.reservations[reservationId] = tokens;
      delete data.budgetExhausted;
      this.writeData(run, data);
      this.append(
        run,
        {
          version: 1,
          code: "model",
          step,
          generation: fence.generation,
          connectionId: target.connectionId,
          model: target.model,
          ...(target.operation === undefined ? {} : { operation: target.operation }),
          modelCalls: data.modelCalls,
          tokens: null,
          ...routineGrantDecisionFields(this.db, run),
        },
        fence.attemptId,
      );
    })();
    if (exhausted) this.exhausted(fence, "Routine model budget exhausted");
  }
  /**
   * Refuse an effect over the run's budget, and say which attempt ran out: one
   * that follows a transiently failed attempt is retried, not failed
   * (`routineFailureSettlement`). The mark commits; the refusal still stands.
   * A later reservation that goes through clears it: the attempt carried on.
   */
  private exhausted(fence: RoutineFence, message: string): never {
    this.db
      .transaction(() => {
        const run = this.row(fence.runId);
        if (run.generation === fence.generation) this.writeData(run, { ...run.data, budgetExhausted: fence.generation });
      })
      .immediate();
    throw new TaviError("CONFLICT", message);
  }
  knownRetired(routineId: string, target: { connectionId: string; model: string }): boolean {
    const row = this.db.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(routineId) as
      | { state_json: string }
      | undefined;
    const state = JSON.parse(row?.state_json ?? "{}") as { retiredModels?: string[] };
    return state.retiredModels?.includes(JSON.stringify([target.connectionId, target.model])) === true;
  }
  recordRetirement(fence: RoutineFence, role: "research" | "synthesis", target: { connectionId: string; model: string }): void {
    const run = this.assertFence(fence, role);
    this.db.transaction(() => {
      this.append(
        run,
        { version: 1, code: "model-retired", step: role, connectionId: target.connectionId, model: target.model, retryable: false },
        fence.attemptId,
      );
      if (run.mode === "preview") return;
      const row = this.db.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(run.routineId) as {
        state_json: string;
      };
      const state = JSON.parse(row.state_json) as { retiredModels?: string[] };
      state.retiredModels = [...new Set([...(state.retiredModels ?? []), JSON.stringify([target.connectionId, target.model])])];
      this.db.prepare("UPDATE tavi_routine_state SET state_json=? WHERE routine_id=?").run(canonicalRoutineJson(state), run.routineId);
    })();
  }
  settleModel(fence: RoutineFence, reservationId: string, actualTokens?: number): void {
    this.db.transaction(() => {
      const run = this.assertFence(fence);
      const reserved = run.data.reservations[reservationId];
      if (reserved === undefined) throw new TaviError("CONFLICT", "Model reservation is absent or already settled");
      if (actualTokens !== undefined && (!Number.isSafeInteger(actualTokens) || actualTokens < 0))
        throw new TaviError("INVALID_INPUT", "Invalid model usage");
      delete run.data.reservations[reservationId];
      if (actualTokens === undefined) run.data.usageComplete = false;
      else {
        run.data.tokensReserved += actualTokens - reserved;
        run.data.tokensKnown += actualTokens;
      }
      this.writeData(run, run.data);
    })();
  }
  reserveControlTool(fence: RoutineFence, tool: string): void {
    const run = this.assertFence(fence, "synthesis");
    let exhausted = false;
    this.db.transaction(() => {
      // A question is orchestration only for a run whose revision turned human checkpoints on.
      const granted =
        run.snapshot.execution.humanCheckpoints === "ask-with-default"
          ? ["agents.spawn", "agents.wait", "operator.ask_user"]
          : ["agents.spawn", "agents.wait"];
      if (!granted.includes(tool)) throw new TaviError("NOT_AUTHORIZED", "Tool is outside the orchestration grant");
      if (budgetToolCalls(run.data) >= run.snapshot.execution.toolCalls) {
        exhausted = true;
        return;
      }
      run.data.toolCalls++;
      delete run.data.budgetExhausted;
      this.writeData(run, run.data);
      // No grant fields: the grant does not scope orchestration tools (it scopes
      // research tools and destinations). The step-level grant resolution this
      // call passed through is recorded by the model reservation that preceded it.
      this.append(
        run,
        { version: 1, code: "tool", step: "synthesis", generation: fence.generation, tool, toolCalls: run.data.toolCalls },
        fence.attemptId,
      );
    })();
    if (exhausted) this.exhausted(fence, "Routine tool budget exhausted");
  }
  /**
   * Reserve one research tool call.
   *
   * The authority check is *one* grant evaluation — the same predicate the tool
   * adapter would apply — and nothing re-derives host authorization here: a host
   * rule implemented twice is a host rule that disagrees with itself. `claim` is the identity the worker adapter captured
   * when it was built; it is compared against the grant read from storage.
   */
  reserveTool(
    fence: RoutineFence,
    tool: string,
    url?: string,
    claim?: { grantId?: string | null; bindingHash?: string; operation?: import("@tavi/contracts").ProviderOperation },
  ): void {
    const effect: RoutineGrantEffect = {
      tool,
      ...(url === undefined ? {} : { url }),
      ...(claim === undefined ? {} : { grantId: claim.grantId }),
    };
    const run = this.assertFence(fence, "research", true, effect);
    let exhausted = false;
    this.db.transaction(() => {
      const pinned = run.snapshot.permissions.providerBindings?.[tool];
      if (pinned !== undefined && pinned !== claim?.bindingHash)
        throw new TaviError("NOT_AUTHORIZED", "Routine provider binding changed since admission");
      const operation = claim?.operation;
      if (
        operation !== undefined &&
        (operation.binding.workspaceId !== run.workspaceId || operation.binding.principalId !== run.principalId)
      )
        throw new TaviError("NOT_AUTHORIZED", "Routine provider operation scope mismatch");
      if (tool === "http.request" && url === undefined) throw new TaviError("NOT_AUTHORIZED", "Fetch requires an authorized destination");
      // Only an https origin is recorded: `sourceOrigin` is a ledger field with an
      // https-only shape, and the loopback-http case the tool allows has no
      // meaningful public origin to name.
      const origin = url === undefined ? undefined : new URL(url).protocol === "https:" ? new URL(url).origin : undefined;
      if (budgetToolCalls(run.data) >= run.snapshot.execution.toolCalls) {
        exhausted = true;
        return;
      }
      run.data.toolCalls++;
      delete run.data.budgetExhausted;
      this.writeData(run, run.data);
      this.append(
        run,
        {
          version: 1,
          code: "tool",
          step: "research",
          generation: fence.generation,
          tool,
          ...(operation === undefined ? {} : { operation }),
          ...(origin === undefined ? {} : { sourceOrigin: origin }),
          toolCalls: run.data.toolCalls,
          ...routineGrantDecisionFields(this.db, run),
        },
        fence.attemptId,
      );
    })();
    if (exhausted) this.exhausted(fence, "Routine tool budget exhausted");
  }
  finish(
    fence: RoutineFence,
    status: "succeeded" | "degraded" | "suppressed" | "failed",
    reason: RoutineEnvelope["code"] = status === "failed" ? "failed" : "completed",
    /** For a failed run: the error it ended on, kept as `failureDetail` for its page. */
    detail?: string,
  ): void {
    this.db.transaction(() => {
      const run = this.assertFence(fence, undefined, false);
      // Terminal run and task state commit together, so no finished run can
      // leave a task of its own suspended.
      this.settleRunWaits(run, `Routine run ended as ${status} with no owner to answer a suspension`);
      this.terminal(run, status, reason, detail);
      this.db.prepare("UPDATE tavi_routine_attempts SET status=?,ended_at=? WHERE attempt_id=?").run(status, this.now(), fence.attemptId);
      if (run.mode === "production" && reason === "credentials") this.credentialBlocked(run);
      else if (run.mode === "production") {
        this.db
          .prepare(
            "UPDATE tavi_routine_state SET research_failures=CASE WHEN ? THEN research_failures+1 ELSE 0 END,research_blocked_since=NULL WHERE routine_id=?",
          )
          .run(status === "failed" ? 1 : 0, run.routineId);
        // A run that reached this point proved its credentials work, so the block
        // is over and the routine returns to `active`.
        this.db
          .prepare(
            "UPDATE tavi_routines SET status='active',version=version+1,updated_at=? WHERE routine_id=? AND status='credential-blocked'",
          )
          .run(this.now(), run.routineId);
        const state = this.db.prepare("SELECT research_failures FROM tavi_routine_state WHERE routine_id=?").get(run.routineId) as {
          research_failures: number;
        };
        if (state.research_failures >= run.snapshot.execution.failureThreshold) this.pauseFailures(run, "failures");
      }
      if (run.mode === "production") {
        const schedule = this.db
          .prepare("SELECT schedule_id FROM tavi_routine_triggers WHERE routine_id=? AND trigger_id=?")
          .get(run.routineId, run.triggerId) as { schedule_id: string } | undefined;
        if (schedule !== undefined)
          this.routines.store.asPort().repositories.schedules.recordRun({
            scheduleId: schedule.schedule_id,
            taskId: run.taskId,
            outcome: status,
            outcomeKind: status === "failed" ? "failed" : "succeeded",
            now: this.now(),
          });
      }
    })();
  }
  cancel(scope: RoutineScope, runId: string): void {
    const taskId = this.db.transaction(() => {
      const run = this.get(scope, runId);
      this.db
        .prepare(
          "UPDATE tavi_routine_delivery_jobs SET status='cancelled',updated_at=? WHERE run_id=? AND status IN ('pending','deferred')",
        )
        .run(this.now(), runId);
      if (
        this.db
          .prepare("SELECT 1 FROM tavi_routine_delivery_jobs WHERE run_id=? AND status IN ('pending','deferred','dispatching','uncertain')")
          .get(runId) === undefined
      )
        this.db.prepare("UPDATE tavi_routine_blob_refs SET pinned=0 WHERE run_id=?").run(runId);
      if (!live.has(run.status)) return null;
      this.settleRunWaits(run, "Routine run was cancelled with no owner to answer a suspension");
      // The revocation is inspector-visible state, not a race the fence loses: the
      // whole cancel body is one transaction, so no reader sees the grant revoked
      // and the run still live, and after commit `assertFence` rejects on the
      // terminal status before it ever looks at the grant. Unlike `revokeGrant`,
      // this path appends no `grant` deny event — no effect was attempted — so the
      // ledger shows the cancellation alone.
      this.db
        .prepare(
          "UPDATE tavi_routine_grants SET revoked_at=COALESCE(revoked_at,?),revoked_reason=COALESCE(revoked_reason,'Run was cancelled') WHERE run_id=?",
        )
        .run(this.now(), runId);
      this.terminal(run, "cancelled", "cancelled");
      this.db.prepare("UPDATE tavi_routine_runs SET generation=generation+1 WHERE run_id=?").run(runId);
      this.db
        .prepare("UPDATE tavi_routine_attempts SET status='cancelled',ended_at=? WHERE run_id=? AND status='running'")
        .run(this.now(), runId);
      return run.taskId;
    })();
    if (taskId !== null) this.options.cancelTask?.(taskId);
  }
  /** Called only by a new exclusive owner, not inferred from elapsed heartbeat time. */
  recoverPreviousOwner(): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT ${runColumns("r")} FROM tavi_routine_runs r JOIN tavi_routine_attempts a ON a.run_id=r.run_id AND a.generation=r.generation WHERE r.status='running' AND a.owner_epoch<>?`,
        )
        .all(this.options.ownerEpoch) as Row[];
      for (const row of rows) {
        const run = decode(row);
        const repositories = this.routines.store.asPort().repositories;
        const previousAttempt = this.db
          .prepare("SELECT owner_epoch FROM tavi_routine_attempts WHERE run_id=? AND generation=?")
          .get(run.runId, run.generation) as { owner_epoch: string };
        const root = repositories.tasks.getByOperationKey(run.workspaceId, run.principalId, run.data.operationKey);
        const worker = repositories.tasks.getByOperationKey(run.workspaceId, run.principalId, routineResearchOperationKey(run.data));
        const taskIds = new Set([run.taskId, root?.taskId, worker?.taskId].filter((id): id is string => id != null));
        if (root !== undefined) {
          this.db.prepare("UPDATE tavi_routine_runs SET task_id=? WHERE run_id=?").run(root.taskId, run.runId);
          for (const child of this.db
            .prepare(
              "SELECT worker_task_id FROM tavi_agent_delegation_admissions WHERE root_task_id=? AND workspace_id=? AND principal_id=?",
            )
            .all(root.taskId, run.workspaceId, run.principalId) as { worker_task_id: string }[])
            taskIds.add(child.worker_task_id);
        }
        for (const taskId of taskIds) {
          const task = repositories.tasks.get(taskId);
          if (task?.workspaceId !== run.workspaceId || task.principalId !== run.principalId)
            throw new TaviError("CONFLICT", "Recovery task scope mismatch");
          const lease = repositories.executions.current(taskId);
          if (lease?.state !== "active") continue;
          if (lease.ownerSession !== previousAttempt.owner_epoch)
            throw new TaviError("CONFLICT", "Recovery lease belongs to another owner");
          repositories.executions.terminate({
            taskId,
            generation: lease.generation,
            confirmedTerminated: true,
            reason: "Previous process replaced under exclusive data-directory ownership",
            terminatedBy: this.options.ownerEpoch,
            now: () => this.now(),
          });
        }
        // `interrupted` is live, not terminal, so the drain path settles too —
        // but a run whose owner crashed must not leave a `waiting` task behind
        // for however long it takes to be re-drained.
        this.settleRunWaits(run, "Routine run was interrupted by owner recovery with no owner to answer a suspension");
        this.db
          .prepare("UPDATE tavi_routine_attempts SET status='interrupted',ended_at=? WHERE run_id=? AND status='running'")
          .run(this.now(), run.runId);
        this.db.prepare("UPDATE tavi_routine_runs SET status='interrupted',generation=generation+1 WHERE run_id=?").run(run.runId);
        this.append(run, { version: 1, code: "recovered", generation: run.generation + 1 });
      }
      return rows.length;
    })();
  }
  /**
   * The notices still to tell: each routine's automatic pause, with its cause
   * (one recorded before causes were kept paused on failures), and its last
   * production run that expired unfinished.
   */
  pendingPauses(): readonly { readonly run: RoutineRun; readonly cause: RoutineRunNoticeCause }[] {
    const rows = this.db
      .prepare(
        "SELECT json_extract(state_json,'$.pendingAutoPause') AS paused,json_extract(state_json,'$.pendingAutoPauseCause') AS cause,json_extract(state_json,'$.pendingExpiry') AS expired FROM tavi_routine_state WHERE json_extract(state_json,'$.pendingAutoPause') IS NOT NULL OR json_extract(state_json,'$.pendingExpiry') IS NOT NULL",
      )
      .all() as { paused: string | null; cause: string | null; expired: string | null }[];
    return rows.flatMap((row) => [
      ...(row.paused === null
        ? []
        : [{ run: this.row(row.paused), cause: row.cause === "credential-grace" ? ("credential-grace" as const) : ("failures" as const) }]),
      ...(row.expired === null ? [] : [{ run: this.row(row.expired), cause: "expired" as const }]),
    ]);
  }
  /** A notice was told: the pending pause or expiry naming `runId` is done. */
  acknowledgePause(runId: string): void {
    this.db
      .prepare(
        "UPDATE tavi_routine_state SET state_json=json_remove(state_json,'$.pendingAutoPause','$.pendingAutoPauseCause') WHERE json_extract(state_json,'$.pendingAutoPause')=?",
      )
      .run(runId);
    this.db
      .prepare(
        "UPDATE tavi_routine_state SET state_json=json_remove(state_json,'$.pendingExpiry') WHERE json_extract(state_json,'$.pendingExpiry')=?",
      )
      .run(runId);
  }
  /**
   * Leave a running attempt for a later one to resume, counting nothing against
   * the routine: the execution slot was busy, the owner is shutting down, or a
   * provider failed transiently. `pending` returns it, and `start` resumes it on
   * the next drain — after a restart, on the next owner's first one.
   *
   * A `transient` failure is retried at most `ROUTINE_MAX_TRANSIENT_RETRIES`
   * times, each after a longer backoff; the one after that settles the run as
   * failed. The step it cut short is excused: its model and tool calls and
   * reserved tokens no longer count against the run's budget, its clock starts
   * again, and the run's windows move on by the attempt and its backoff.
   */
  interrupt(fence: RoutineFence, transient = false, detail?: string): "interrupted" | "failed" {
    if (transient && (this.row(fence.runId).data.transientRetries ?? 0) >= ROUTINE_MAX_TRANSIENT_RETRIES) {
      this.finish(
        fence,
        "failed",
        "failed",
        `A model or search provider failed ${ROUTINE_MAX_TRANSIENT_RETRIES + 1} times in a row; the run stopped retrying${detail === undefined ? "" : `. The last error: ${detail}`}`,
      );
      return "failed";
    }
    this.db.transaction(() => {
      const run = this.assertFence(fence, undefined, false);
      this.settleRunWaits(run, "Routine run was interrupted with no owner to answer a suspension");
      this.db
        .prepare("UPDATE tavi_routine_attempts SET status='interrupted',ended_at=? WHERE attempt_id=?")
        .run(this.now(), fence.attemptId);
      this.db.prepare("UPDATE tavi_routine_runs SET status='interrupted',generation=generation+1 WHERE run_id=?").run(run.runId);
      // An admission that already settled `failed` or `stopped` replays as it ended under the
      // same operation key, so the resumed attempt would fail without trying: it
      // starts again under a key of its own. Research that completed keeps its
      // key, so a synthesis that failed reuses it rather than researching again;
      // research that failed starts again too. One still pending or completed is
      // resumed or replayed as before.
      const repositories = this.routines.store.asPort().repositories;
      const failed = (key: string) => {
        const task = repositories.tasks.getByOperationKey(run.workspaceId, run.principalId, key);
        const status = task === undefined ? undefined : repositories.tasks.latestSettledAdmission(task.taskId)?.result?.status;
        return status === "failed" || status === "stopped";
      };
      const data: RoutineRunData = { ...run.data };
      const researchKey = routineResearchOperationKey(run.data);
      const researchFailed = failed(researchKey);
      if (researchFailed || failed(run.data.operationKey)) {
        data.operationKey = `routine:${run.runId}:${fence.generation + 1}`;
        if (researchFailed) delete data.researchOperationKey;
        else data.researchOperationKey = researchKey;
        this.db.prepare("UPDATE tavi_routine_runs SET task_id=NULL WHERE run_id=?").run(run.runId);
      }
      const excused = transient ? this.excuse(data, fence) : undefined;
      this.writeData(run, data);
      this.append(run, {
        version: 1,
        code: "transient",
        retryable: true,
        ...(excused === undefined ? {} : { step: excused, generation: fence.generation }),
      });
    })();
    return "interrupted";
  }
  /**
   * Excuse the step a transient failure cut short, and every step after it: the
   * calls and tokens it spent no longer count against the budget (its calls stay
   * in the run's effort), its clock starts again, and the
   * run's windows move on by the attempt and the backoff before the next one.
   */
  private excuse(data: RoutineRunData, fence: RoutineFence): RoutineStep | undefined {
    const retries = (data.transientRetries ?? 0) + 1;
    const backoff = TRANSIENT_BACKOFF_MS * 2 ** (retries - 1);
    const now = this.now();
    const attempt = this.db.prepare("SELECT started_at FROM tavi_routine_attempts WHERE attempt_id=?").get(fence.attemptId) as
      | { started_at: string }
      | undefined;
    const spent = Math.max(0, Date.parse(now) - Date.parse(attempt?.started_at ?? now)) + backoff;
    const later = (at: string) => new Date(Date.parse(at) + spent).toISOString();
    data.transientRetries = retries;
    data.retryAfter = new Date(Date.parse(now) + backoff).toISOString();
    data.deadline = later(data.deadline);
    data.queueExpiresAt = later(data.queueExpiresAt);
    delete data.budgetExhausted;
    const index = STEP_ORDER.findLastIndex((step) => data.stepStarted[step] !== undefined);
    if (index < 0) return undefined;
    const step = STEP_ORDER[index]!;
    const base = data.stepBase?.[step];
    if (base !== undefined) {
      // The calls stay in the run's effort; only its budget stops counting them.
      data.excusedModelCalls = (data.excusedModelCalls ?? 0) + Math.max(0, data.modelCalls - base.modelCalls);
      data.excusedToolCalls = (data.excusedToolCalls ?? 0) + Math.max(0, data.toolCalls - base.toolCalls);
      data.tokensReserved = base.tokensReserved;
      // A reservation the attempt left unsettled ended with it; its tokens were just given back.
      data.reservations = {};
    }
    const stepStarted = { ...data.stepStarted };
    const stepBase = { ...data.stepBase };
    for (const next of STEP_ORDER.slice(index)) {
      delete stepStarted[next];
      delete stepBase[next];
    }
    data.stepStarted = stepStarted;
    data.stepBase = stepBase;
    return step;
  }
  stateVersion(routineId: string): number {
    const row = this.db.prepare("SELECT version FROM tavi_routine_state WHERE routine_id=?").get(routineId) as
      | { version: number }
      | undefined;
    if (row === undefined) throw new TaviError("NOT_FOUND", "Routine state is unavailable");
    return row.version;
  }
  async notifyPauses(): Promise<void> {
    if (this.options.onPaused === undefined) return;
    for (const { run, cause } of this.pendingPauses())
      if ((await this.options.onPaused(run, cause)) !== false) this.acknowledgePause(run.runId);
  }
  pending(limit = 50): readonly RoutineRun[] {
    this.limit(limit);
    return (
      this.db
        .prepare(
          `SELECT ${runColumns("r")} FROM tavi_routine_runs r JOIN tavi_routines a ON a.routine_id=r.routine_id WHERE r.status IN ('queued','interrupted') AND (r.mode='preview' OR a.status NOT IN ('paused','paused-failures') OR json_extract(r.data_json,'$.queueExpiresAt')<? OR json_extract(r.data_json,'$.deadline')<?) ORDER BY r.claimed_at,r.run_id LIMIT ?`,
        )
        .all(this.now(), this.now(), limit) as Row[]
    ).map(decode);
  }
  /** Append one event to the routine's hash chain (`appendRoutineEvent`). */
  append(
    run: RoutineRun,
    input: RoutineEnvelope,
    attemptId: string | null = null,
    detail?: { kind: "prompt" | "evidence"; text: string },
  ): void {
    appendRoutineEvent(this.db, () => this.now(), run, input, attemptId, detail);
  }
  ledger(scope: RoutineScope, routineId: string, afterSequence = 0, limit = 50, runId?: string): readonly RoutineLedgerEvent[] {
    this.routines.get(scope, routineId);
    this.limit(limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TaviError("INVALID_INPUT", "Invalid ledger cursor");
    if (runId !== undefined && this.get(scope, runId).routineId !== routineId)
      throw new TaviError("INVALID_INPUT", "Run belongs to another routine");
    return routineLedgerPage(this.db, routineId, afterSequence, limit, runId);
  }
  detail(scope: RoutineScope, routineId: string, detailId: string): { payload: string | null; hash: string; prunedAt: string | null } {
    this.routines.get(scope, routineId);
    return routineLedgerDetail(this.db, routineId, detailId);
  }
  /** Verify the routine's local hash chain (`verifyRoutineLedger`, which says what that does and does not establish). */
  verify(scope: RoutineScope, routineId: string): RoutineLedgerVerdict {
    this.routines.get(scope, routineId);
    return verifyRoutineLedger(this.db, scope, routineId);
  }
  pruneDetails(scope: RoutineScope, routineId: string): number {
    const detail = this.routines.get(scope, routineId);
    const before = new Date(Date.parse(this.now()) - detail.revision.snapshot.retention.detailDays * 86_400_000).toISOString();
    return this.db
      .prepare("UPDATE tavi_routine_details SET payload=NULL,pruned_at=? WHERE routine_id=? AND created_at<? AND payload IS NOT NULL")
      .run(this.now(), routineId, before).changes;
  }
}
