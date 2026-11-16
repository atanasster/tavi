import {
  RoutineDeliveryTargetSchema,
  TaviError,
  type MessagingServicePort,
  type RoutineDeliveryJob,
  type RoutineDeliveryStatus,
  type RoutinePauseCause,
  type RoutineRun,
  type RoutineScope,
  type SendOutcome,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import { parseJsonColumn, StoredDeliveryDataSchema } from "../persistence/json-column.js";
import { canonicalRoutineJson, routineHash } from "./service.js";
import type { RoutineExecutionService } from "./runs.js";
type Row = {
  job_id: string;
  run_id: string;
  effect_id: string;
  status: RoutineDeliveryStatus;
  not_before: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  data_json: string;
};
const decode = (row: Row): RoutineDeliveryJob => ({
  jobId: row.job_id,
  runId: row.run_id,
  effectId: row.effect_id,
  status: row.status,
  notBefore: row.not_before,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  data: parseJsonColumn(StoredDeliveryDataSchema, row.data_json, "tavi_routine_delivery_jobs.data_json"),
});
/** How long a delivery job waits before it is checked again: while its target's pause is untold, or its credentials are missing. */
const DELIVERY_RECHECK_MS = 5 * 60_000;
export function routineDeliveryTime(run: RoutineRun, at: string): string | null {
  const window = run.snapshot.delivery.window;
  if (window === undefined) return at;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: window.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const inside = (time: number) => {
    const local = formatter.format(new Date(time));
    return window.start < window.end ? local >= window.start && local < window.end : local >= window.start || local < window.end;
  };
  if (inside(Date.parse(at))) return at;
  if (run.snapshot.delivery.outsideWindow === "in_app_only") return null;
  const start = Math.ceil(Date.parse(at) / 60_000) * 60_000;
  for (let minute = 0; minute < 48 * 60; minute++)
    if (inside(start + minute * 60_000)) return new Date(start + minute * 60_000).toISOString();
  throw new TaviError("INVALID_INPUT", "Delivery window has no eligible instant in the next 48 hours");
}
export interface RoutineDeliveryOptions {
  /** `buildDestination` turns a routine's target into its channel's own destination. */
  readonly messaging: Pick<MessagingServicePort, "send" | "buildDestination">;
  readonly now?: () => string;
  readonly ready?: (job: RoutineDeliveryJob) => boolean | Promise<boolean>;
  /**
   * Tell the routine's person that delivery to `targetId` paused, and why.
   * False keeps the notice untold, to be tried again; anything else means it
   * was told, or there was nowhere to tell it.
   */
  readonly onPaused?: (run: RoutineRun, targetId: string, cause: RoutinePauseCause) => Promise<boolean | void>;
}
export class RoutineDeliveryService {
  readonly runs: RoutineExecutionService;
  readonly options: RoutineDeliveryOptions;
  constructor(runs: RoutineExecutionService, options: RoutineDeliveryOptions) {
    this.runs = runs;
    this.options = options;
  }
  private get store() {
    return this.runs.routines.store;
  }
  private now() {
    return this.options.now?.() ?? nowTimestamp();
  }
  get(scope: RoutineScope, jobId: string): RoutineDeliveryJob {
    const row = this.store.handle.prepare("SELECT * FROM tavi_routine_delivery_jobs WHERE job_id=?").get(jobId) as Row | undefined;
    if (row === undefined) throw new TaviError("NOT_FOUND", "Delivery attempt is unavailable");
    this.runs.get(scope, row.run_id);
    return decode(row);
  }
  list(scope: RoutineScope, runId: string, beforeJobId?: string, limit = 50): readonly RoutineDeliveryJob[] {
    this.runs.get(scope, runId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TaviError("INVALID_INPUT", "Invalid delivery page size");
    const cursor = beforeJobId === undefined ? undefined : this.get(scope, beforeJobId);
    if (cursor !== undefined && cursor.runId !== runId) throw new TaviError("INVALID_INPUT", "Delivery cursor belongs to another run");
    return (
      this.store.handle
        .prepare(
          "SELECT * FROM tavi_routine_delivery_jobs WHERE run_id=? AND (created_at<? OR (created_at=? AND job_id<?)) ORDER BY created_at DESC,job_id DESC LIMIT ?",
        )
        .all(runId, cursor?.createdAt ?? "9999", cursor?.createdAt ?? "9999", cursor?.jobId ?? "~", limit) as Row[]
    ).map(decode);
  }
  /** Called inside the report publication transaction; authorization is rechecked at actual dispatch. */
  /**
   * `text`, when given, is what the job sends instead of the artifact as a
   * file: a run whose PDF could not be rendered still reaches its destination,
   * as a summary of the published report.
   */
  enqueue(run: RoutineRun, artifactId: string, hash: string, at: string, text?: string): void {
    for (const targetId of run.snapshot.delivery.targetIds) {
      const row = this.store.handle
        .prepare("SELECT target_json FROM tavi_routine_delivery_targets WHERE target_id=? AND workspace_id=? AND principal_id=?")
        .get(targetId, run.workspaceId, run.principalId) as { target_json: string } | undefined;
      if (row === undefined) {
        this.runs.append(run, { version: 1, code: "delivery", step: "delivery" });
        continue;
      }
      const target = RoutineDeliveryTargetSchema.parse(JSON.parse(row.target_json));
      const effectId = `routine-delivery:${run.runId}:${targetId}`;
      const next = routineDeliveryTime(run, at);
      const status = next === null ? "suppressed" : next === at ? "pending" : "deferred";
      const data: RoutineDeliveryJob["data"] = {
        artifactId,
        hash,
        targetId,
        target,
        generation: run.generation,
        ...(text === undefined ? {} : { text }),
      };
      this.store.handle
        .prepare("INSERT INTO tavi_routine_delivery_jobs VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(effect_id) DO NOTHING")
        .run(
          `delivery-${routineHash(effectId).slice(0, 48)}`,
          run.runId,
          effectId,
          status,
          next ?? at,
          new Date(Date.parse(at) + run.snapshot.delivery.expiryHours * 3_600_000).toISOString(),
          at,
          at,
          canonicalRoutineJson(data),
        );
      if (status !== "suppressed")
        this.store.handle.prepare("UPDATE tavi_routine_blob_refs SET pinned=1 WHERE run_id=? AND artifact_id=?").run(run.runId, artifactId);
    }
  }
  private health(routineId: string, targetId: string): { failures: number; blockedSince: string | null; notified: boolean } {
    const row = this.store.handle.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(routineId) as {
      state_json: string;
    };
    const state = JSON.parse(row.state_json) as {
      deliveryHealth?: Record<string, { failures: number; blockedSince: string | null; notified: boolean }>;
    };
    return state.deliveryHealth?.[targetId] ?? { failures: 0, blockedSince: null, notified: false };
  }
  private setHealth(routineId: string, targetId: string, health: ReturnType<RoutineDeliveryService["health"]>): void {
    const row = this.store.handle.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(routineId) as {
      state_json: string;
    };
    const state = JSON.parse(row.state_json) as { deliveryHealth?: Record<string, unknown> };
    this.store.handle
      .prepare("UPDATE tavi_routine_state SET state_json=? WHERE routine_id=?")
      .run(canonicalRoutineJson({ ...state, deliveryHealth: { ...state.deliveryHealth, [targetId]: health } }), routineId);
  }
  resumeTarget(scope: RoutineScope, routineId: string, targetId: string): void {
    this.runs.routines.get(scope, routineId);
    this.runs.routines.target(scope, targetId);
    this.setHealth(routineId, targetId, { failures: 0, blockedSince: null, notified: false });
    this.runs.routines.rearmDeliveries(routineId, targetId);
  }
  private update(
    job: RoutineDeliveryJob,
    status: RoutineDeliveryStatus,
    extra: Partial<RoutineDeliveryJob["data"]> = {},
    notBefore = job.notBefore,
  ): void {
    this.store.handle
      .prepare("UPDATE tavi_routine_delivery_jobs SET status=?,not_before=?,updated_at=?,data_json=? WHERE job_id=?")
      .run(status, notBefore, this.now(), canonicalRoutineJson({ ...job.data, ...extra }), job.jobId);
  }
  private terminal(job: RoutineDeliveryJob, status: RoutineDeliveryStatus, extra: Partial<RoutineDeliveryJob["data"]> = {}): void {
    this.store.handle.transaction(() => {
      const current = this.store.handle.prepare("SELECT status FROM tavi_routine_delivery_jobs WHERE job_id=?").get(job.jobId) as
        | { status: string }
        | undefined;
      if (current?.status === status) return;
      // One send can terminalise twice — a timeout records `uncertain` and a late
      // rejection then records `failed` — so the failure counters move only on the
      // first transition out of an unresolved status. Otherwise a single failed
      // send would count twice and trip `failureThreshold` after two.
      const firstFailure = current === undefined || ["pending", "deferred", "dispatching"].includes(current.status);
      this.update(job, status, extra);
      const run = this.runs.get({ workspaceId: job.data.target.workspaceId, principalId: job.data.target.principalId }, job.runId);
      this.runs.append(run, { version: 1, code: "delivery", step: "delivery", generation: job.data.generation });
      const health = this.health(run.routineId, job.data.targetId);
      if (firstFailure && ["failed", "uncertain"].includes(status))
        this.setHealth(run.routineId, job.data.targetId, { ...health, failures: health.failures + 1 });
      if (status === "accepted") this.setHealth(run.routineId, job.data.targetId, { failures: 0, blockedSince: null, notified: false });
      if (firstFailure && ["failed", "uncertain"].includes(status))
        this.store.handle
          .prepare("UPDATE tavi_routine_state SET delivery_failures=delivery_failures+1 WHERE routine_id=?")
          .run(run.routineId);
      if (status === "accepted")
        this.store.handle
          .prepare("UPDATE tavi_routine_state SET delivery_failures=0,delivery_blocked_since=NULL WHERE routine_id=?")
          .run(run.routineId);
      if (
        this.store.handle
          .prepare("SELECT 1 FROM tavi_routine_delivery_jobs WHERE run_id=? AND status IN ('pending','deferred','dispatching','uncertain')")
          .get(job.runId) === undefined
      )
        this.store.handle.prepare("UPDATE tavi_routine_blob_refs SET pinned=0 WHERE run_id=?").run(job.runId);
    })();
  }
  private receipt(job: RoutineDeliveryJob, outcome: SendOutcome) {
    this.terminal(job, outcome.status === "accepted" ? "accepted" : outcome.status === "uncertain" ? "uncertain" : "failed", {
      providerMessageIds: outcome.parts.flatMap((part) => (part.providerMessageId === undefined ? [] : [part.providerMessageId])),
      ...(outcome.status === "accepted"
        ? {}
        : {
            error:
              outcome.status === "uncertain"
                ? "Provider acceptance is unknown; explicit resend may duplicate delivery"
                : "Provider rejected delivery",
          }),
    });
  }
  /**
   * The artifact boundary, checked immediately before a send.
   *
   * A missing or mismatched artifact is not a generic failure: it is the one
   * outcome an operator must be able to tell apart, because the report the
   * delivery promises no longer exists in a form that may be sent. It is
   * reported as `artifact_unavailable` rather than sent, and never re-rendered
   * from the run's evidence to "repair" it.
   */
  private verifyArtifact(job: RoutineDeliveryJob): void {
    const artifact = this.store.getArtifact(job.data.artifactId);
    const bytes = this.store.readArtifactBody(job.data.artifactId);
    if (artifact === undefined || bytes === undefined)
      throw new TaviError("UNAVAILABLE", "Report artifact bytes are missing", { details: { reason: "artifact_unavailable" } });
    if (
      artifact.workspaceId !== job.data.target.workspaceId ||
      artifact.contentType !== (job.data.text === undefined ? "application/pdf" : "application/json") ||
      artifact.reviewState !== "approved"
    )
      throw new TaviError("NOT_AUTHORIZED", "Approved report bytes are unavailable or changed");
    if (artifact.sha256 !== job.data.hash || sha256Hex(bytes) !== job.data.hash)
      throw new TaviError("UNAVAILABLE", "Report artifact bytes do not match the publication manifest", {
        details: { reason: "artifact_unavailable" },
      });
    if (
      this.store.handle
        .prepare("SELECT 1 FROM tavi_routine_blob_refs WHERE run_id=? AND artifact_id=? AND hash=?")
        .get(job.runId, job.data.artifactId, job.data.hash) === undefined
    )
      throw new TaviError("UNAVAILABLE", "Report artifact was pruned", { details: { reason: "artifact_unavailable" } });
  }
  /** Map an artifact-boundary refusal to the operator-visible outcome. */
  private artifactFailure(error: unknown): { error: string } {
    const reason = error instanceof TaviError ? error.details?.["reason"] : undefined;
    return {
      error: reason === "artifact_unavailable" ? "artifact_unavailable" : "Delivery target or artifact is unavailable, revoked, or changed",
    };
  }
  reconcileReceipts(): void {
    const rows = this.store.handle
      .prepare(
        "SELECT j.* FROM tavi_routine_delivery_jobs j JOIN tavi_messaging_outbox o ON o.effect_id=j.effect_id WHERE j.status='uncertain' AND o.state='resolved' AND json_extract(o.outcome_json,'$.status') IN ('accepted','rejected') ORDER BY j.updated_at,j.job_id LIMIT 100",
      )
      .all() as Row[];
    for (const row of rows) {
      const job = decode(row);
      const outcome = this.store.asPort().repositories.messagingOutbox.get(job.effectId)?.outcome;
      if (outcome !== undefined) this.receipt(job, outcome);
    }
  }
  pendingJobs(): readonly RoutineDeliveryJob[] {
    return (
      this.store.handle
        .prepare(
          "SELECT j.* FROM tavi_routine_delivery_jobs j JOIN tavi_routine_runs r ON r.run_id=j.run_id JOIN tavi_routines a ON a.routine_id=r.routine_id WHERE j.status IN ('pending','deferred','dispatching') AND (j.not_before<=? OR j.expires_at<=? OR j.status='dispatching') AND (a.status NOT IN ('paused','paused-failures') OR j.expires_at<=? OR j.status='dispatching') ORDER BY j.not_before,j.job_id LIMIT 100",
        )
        .all(this.now(), this.now(), this.now()) as Row[]
    ).map(decode);
  }
  claimDelivery(
    scope: RoutineScope,
    jobId: string,
    ready: boolean,
  ): { job: RoutineDeliveryJob; run: RoutineRun; reportName: string; notifyPause?: RoutinePauseCause } | undefined {
    return this.store.transactionImmediate(() => {
      const job = this.get(scope, jobId);
      if (!["pending", "deferred", "dispatching"].includes(job.status)) return;
      const run = this.runs.get(scope, job.runId);
      const outbox = this.store.asPort().repositories.messagingOutbox.get(job.effectId);
      if (outbox?.state === "resolved" && outbox.outcome !== undefined) {
        this.receipt(job, outbox.outcome);
        return;
      }
      // A prior claim may have reached the provider. Only receipt reconciliation can settle it.
      if (outbox?.state === "pending" || job.status === "dispatching") {
        this.terminal(job, "uncertain", { error: "Provider receipt is unknown; automatic resend is disabled" });
        return;
      }
      if (job.expiresAt <= this.now()) {
        this.terminal(job, "expired", { error: "Delivery expired" });
        return;
      }
      const aggregate = this.runs.routines.get(scope, run.routineId).routine;
      if (
        run.status === "cancelled" ||
        run.generation !== job.data.generation ||
        aggregate.status === "archived" ||
        (run.taskId !== null && this.store.asPort().repositories.cancellations.get(run.taskId) !== undefined)
      ) {
        this.terminal(job, "cancelled");
        return;
      }
      if (["paused", "paused-failures"].includes(aggregate.status)) return;
      try {
        this.runs.assertGrantForRun(scope, job.runId, "delivery", { destinationId: job.data.targetId });
        if (routineHash(this.runs.routines.target(scope, job.data.targetId)) !== routineHash(job.data.target))
          throw new TaviError("NOT_AUTHORIZED", "Original delivery target changed");
        this.verifyArtifact(job);
      } catch (error) {
        this.terminal(job, "failed", this.artifactFailure(error));
        return;
      }
      let health = this.health(run.routineId, job.data.targetId);
      const threshold = run.snapshot.execution.failureThreshold;
      // A target held only by missing credentials is released as soon as they
      // work again: nobody has to resume it, and a later outage is told afresh.
      if (ready && health.blockedSince !== null && health.failures < threshold) {
        health = { ...health, blockedSince: null, notified: false };
        this.setHealth(run.routineId, job.data.targetId, health);
        this.store.handle.prepare("UPDATE tavi_routine_state SET delivery_blocked_since=NULL WHERE routine_id=?").run(run.routineId);
      }
      const cause: RoutinePauseCause | undefined =
        health.failures >= threshold
          ? "failures"
          : health.blockedSince !== null &&
              Date.parse(this.now()) - Date.parse(health.blockedSince) >= run.snapshot.execution.credentialGraceHours * 3_600_000
            ? "credential-grace"
            : undefined;
      if (cause !== undefined) {
        // Once told, a target paused on failures waits for a resume, which
        // brings its jobs back, so the job waits until it expires. Otherwise
        // it is checked again every few minutes: to tell a pause still untold,
        // or for the return of the credentials.
        const wait =
          health.notified && cause === "failures" ? job.expiresAt : new Date(Date.parse(this.now()) + DELIVERY_RECHECK_MS).toISOString();
        this.update(
          job,
          "deferred",
          { error: "Delivery paused after repeated failures or prolonged missing credentials; research remains active" },
          wait,
        );
        return health.notified ? undefined : { job, run, reportName: run.data.reportName ?? aggregate.name, notifyPause: cause };
      }
      if (!ready) {
        this.setHealth(run.routineId, job.data.targetId, { ...health, blockedSince: health.blockedSince ?? this.now() });
        this.store.handle
          .prepare("UPDATE tavi_routine_state SET delivery_blocked_since=COALESCE(delivery_blocked_since,?) WHERE routine_id=?")
          .run(this.now(), run.routineId);
        this.update(
          job,
          "deferred",
          { error: "Delivery credentials or connector are unavailable" },
          new Date(Date.parse(this.now()) + DELIVERY_RECHECK_MS).toISOString(),
        );
        return;
      }
      const next = routineDeliveryTime(run, this.now());
      if (next === null) {
        this.terminal(job, "suppressed");
        return;
      }
      if (next > this.now()) {
        this.update(job, "deferred", {}, next);
        return;
      }
      const claimed = this.store.handle
        .prepare(
          "UPDATE tavi_routine_delivery_jobs SET status='dispatching',updated_at=? WHERE job_id=? AND status IN ('pending','deferred')",
        )
        .run(this.now(), job.jobId);
      return claimed.changes === 0 ? undefined : { job, run, reportName: run.data.reportName ?? aggregate.name };
    });
  }
  acknowledgeDeliveryPause(scope: RoutineScope, jobId: string): void {
    const job = this.get(scope, jobId);
    const run = this.runs.get(scope, job.runId);
    this.setHealth(run.routineId, job.data.targetId, { ...this.health(run.routineId, job.data.targetId), notified: true });
  }
  settleDelivery(scope: RoutineScope, jobId: string, outcome: SendOutcome | undefined, timedOut = false): void {
    const job = this.get(scope, jobId);
    if (outcome !== undefined) {
      this.receipt(job, outcome);
      return;
    }
    const after = this.store.asPort().repositories.messagingOutbox.get(job.effectId);
    if (after?.state === "resolved" && after.outcome !== undefined) this.receipt(job, after.outcome);
    else
      this.terminal(job, timedOut || after?.state === "pending" ? "uncertain" : "failed", {
        error:
          timedOut || after?.state === "pending"
            ? "Provider receipt is unknown; explicit resend is required"
            : "Delivery failed before provider dispatch",
      });
  }
  resend(scope: RoutineScope, jobId: string, operationKey: string, acknowledgeDuplicateRisk: boolean): RoutineDeliveryJob {
    if (!acknowledgeDuplicateRisk)
      throw new TaviError("INVALID_INPUT", "Explicit resend may duplicate a received PDF; acknowledge that risk first");
    if (operationKey.length < 1 || operationKey.length > 128) throw new TaviError("INVALID_INPUT", "Invalid resend operation key");
    return this.store.handle.transaction(() => {
      const original = this.get(scope, jobId);
      const run = this.runs.get(scope, original.runId);
      if (!run.snapshot.delivery.allowResend || ["pending", "deferred", "dispatching"].includes(original.status))
        throw new TaviError("INVALID_INPUT", "This delivery cannot be resent");
      this.runs.routines.target(scope, original.data.targetId);
      this.verifyArtifact(original);
      const effectId = `routine-resend:${routineHash({ jobId, operationKey })}`;
      const prior = this.store.handle.prepare("SELECT * FROM tavi_routine_delivery_jobs WHERE effect_id=?").get(effectId) as
        | Row
        | undefined;
      if (prior !== undefined) return decode(prior);
      const now = this.now();
      const next = routineDeliveryTime(run, now);
      const id = `delivery-${routineHash(effectId).slice(0, 48)}`;
      this.store.handle.prepare("INSERT INTO tavi_routine_delivery_jobs VALUES (?,?,?,?,?,?,?,?,?)").run(
        id,
        original.runId,
        effectId,
        next === null ? "suppressed" : next === now ? "pending" : "deferred",
        next ?? now,
        new Date(Date.parse(now) + run.snapshot.delivery.expiryHours * 3_600_000).toISOString(),
        now,
        now,
        canonicalRoutineJson({
          ...(original.data.text === undefined ? {} : { text: original.data.text }),
          artifactId: original.data.artifactId,
          hash: original.data.hash,
          targetId: original.data.targetId,
          target: original.data.target,
          generation: original.data.generation,
          resendOf: jobId,
        }),
      );
      if (next !== null)
        this.store.handle
          .prepare("UPDATE tavi_routine_blob_refs SET pinned=1 WHERE run_id=? AND artifact_id=?")
          .run(original.runId, original.data.artifactId);
      return this.get(scope, id);
    })();
  }
}
