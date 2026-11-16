import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONTENT_LABEL_LIMITS,
  ROUTINE_REPORTED_LIMIT,
  TaviError,
  folderFileName,
  untrustedLabel,
  type RoutineDedupEntry,
  type RoutineFence,
  type RoutineNewsReport,
  type RoutineScope,
  type RoutineRun,
  type RoutineTemplate,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { prefixedId, sha256Hex, flushDirectory, flushFile } from "@tavi/node-kit";
import { canonicalRoutineJson } from "./service.js";
import type { RoutineExecutionService } from "./runs.js";
import type { RoutineDeliveryService } from "./delivery.js";
type Stage = {
  stage_id: string;
  run_id: string;
  artifact_id: string;
  kind: "json" | "pdf";
  relative_path: string;
  stage_path: string;
  hash: string;
  byte_size: number;
  content_type: string;
  status: string;
  created_at: string;
  updated_at: string;
};
export interface RoutinePublication {
  readonly reportArtifactId: string;
  readonly pdfArtifactId: string | null;
  readonly publishedAt: string;
  readonly pdfError: string | null;
  /** The report's first story title, or its title when it has none: what a run's history row shows of it. Absent on older publications. */
  readonly headline?: string;
}
/**
 * The boundaries a crash can land on, named so a test can stop there.
 *
 * `before-commit` is the interesting one: the bytes are durable and renamed into
 * place, the publication transaction has not run, so recovery sees a complete
 * artifact with no metadata pointing at it.
 */
export const PUBLICATION_BOUNDARIES = ["before-flush", "after-flush", "before-rename", "after-rename", "before-commit"] as const;
export type PublicationBoundary = (typeof PUBLICATION_BOUNDARIES)[number];

/** How long an unreferenced staged file is retained before recovery collects it. */
export const STAGE_GRACE_MS = 60 * 60 * 1000;

export interface RoutinePublicationOptions {
  /**
   * The clock publication stamps with.
   *
   * Injected for the same reason `RoutineExecutionService` and
   * `RoutineDeliveryService` inject one: a run's `publishedAt`, its artifact
   * timestamps and the instant its delivery window is evaluated against must all
   * come from *one* clock. Falling back to the wall clock here meant a run whose
   * own clock was injected was published at a wall-clock instant — so a delivery
   * could be judged `suppressed` by a window its run had not reached, and every
   * routine test that fixed the time of day was silently dependent on when it
   * ran.
   */
  readonly now?: () => string;
  /**
   * Test seam: called at each durability boundary so a test can simulate a crash
   * where a real one would land. Production passes nothing.
   */
  readonly failAt?: (boundary: PublicationBoundary) => void;
}
type Coverage = { from: string; to: string };
/**
 * The coverage a production publication leaves in the routine's state.
 *
 * A complete report covers its window and resolves what was outstanding; a
 * degraded one adds its window to what is outstanding. When another
 * publication committed meanwhile (`merged`), what it recorded is kept where it
 * reaches further: the later coverage wins, and an outstanding window this
 * report does not reach stays outstanding.
 */
function routineCoverageState(
  saved: { readonly [key: string]: unknown },
  report: Pick<RoutineNewsReport, "coverage" | "degraded">,
  merged: boolean,
): { coverage?: Coverage; unresolvedCoverage: Coverage | null } {
  const coverage = saved["coverage"] as Coverage | undefined;
  const unresolved = saved["unresolvedCoverage"] as Partial<Coverage> | null | undefined;
  const later = (a: string | undefined, b: string) => (a !== undefined && Date.parse(a) > Date.parse(b) ? a : b);
  if (report.degraded)
    return {
      unresolvedCoverage: {
        from: unresolved?.from ?? report.coverage.from,
        to: merged ? later(unresolved?.to, report.coverage.to) : report.coverage.to,
      },
    };
  if (!merged) return { coverage: report.coverage, unresolvedCoverage: null };
  const newer = coverage !== undefined && Date.parse(coverage.to) > Date.parse(report.coverage.to) ? coverage : report.coverage;
  const outstanding =
    unresolved?.from !== undefined && unresolved.to !== undefined && Date.parse(unresolved.from) >= Date.parse(report.coverage.to)
      ? { from: unresolved.from, to: unresolved.to }
      : null;
  return { coverage: newer, unresolvedCoverage: outstanding };
}
export class RoutinePublicationService {
  readonly runs: RoutineExecutionService;
  readonly options: RoutinePublicationOptions;
  constructor(runs: RoutineExecutionService, options: RoutinePublicationOptions = {}) {
    this.runs = runs;
    this.options = options;
  }
  private now(): string {
    return this.options.now?.() ?? nowTimestamp();
  }
  private boundary(point: PublicationBoundary): void {
    this.options.failAt?.(point);
  }
  private get store() {
    return this.runs.routines.store;
  }
  get(scope: RoutineScope, runId: string): RoutinePublication | undefined {
    const run = this.runs.get(scope, runId);
    return (run.data as typeof run.data & { publication?: RoutinePublication }).publication;
  }
  stage(fence: RoutineFence, kind: "json" | "pdf", body: Uint8Array): string {
    const run = this.runs.assertFence(fence, kind === "pdf" ? "render" : "synthesis");
    if (body.byteLength < 1 || body.byteLength > run.snapshot.retention.artifactBytes)
      throw new TaviError("INVALID_INPUT", "Report artifact exceeds the saved size budget");
    const checksum = sha256Hex(body);
    const prior = this.store.handle.prepare("SELECT * FROM tavi_routine_staging WHERE run_id=? AND kind=?").get(run.runId, kind) as
      | Stage
      | undefined;
    if (prior !== undefined) {
      if (prior.hash !== checksum) throw new TaviError("CONFLICT", "A staged report already has different bytes");
      const path = existsSync(this.store.resolveArtifactPath(prior.relative_path)) ? prior.relative_path : prior.stage_path;
      const existing = this.store.resolveArtifactPath(path);
      if (existsSync(existing)) {
        // Read and hashed once: the file is the size of a whole report.
        const matches = sha256Hex(readFileSync(existing)) === checksum;
        if (!matches && prior.status !== "writing") throw new TaviError("CONFLICT", "Staged report hash mismatch");
        if (matches) return prior.stage_id;
      }
    }
    const pending = this.store.handle
      .prepare("SELECT COALESCE(SUM(byte_size),0) AS n FROM tavi_routine_staging WHERE run_id=? AND kind<>? AND status<>'published'")
      .get(run.runId, kind) as { n: number };
    const budget = run.snapshot.retention.artifactBytes;
    let retained = this.retainedBytes(run.routineId);
    // A routine that is inside its *count* limit can still be out of *bytes*, and
    // the count-based prune after publication would then never run again: every
    // later publication fails on the budget, so nothing is ever pruned and the
    // routine is stuck. Reclaim eligible old artifacts before staging, once, and
    // say plainly when every remaining byte is protected.
    if (retained + pending.n + body.byteLength > budget) {
      const reclaimed = this.reclaimForCapacity(run, retained + pending.n + body.byteLength - budget);
      retained -= reclaimed.freedBytes;
      if (retained + pending.n + body.byteLength > budget) {
        throw new TaviError("CONFLICT", "Routine artifact retention budget exhausted", {
          details: {
            reason: "capacity-blocked",
            neededBytes: body.byteLength,
            retainedBytes: retained,
            pendingBytes: pending.n,
            budgetBytes: budget,
            reclaimedBytes: reclaimed.freedBytes,
            reclaimedArtifacts: reclaimed.artifacts,
          },
        });
      }
    }
    const stageId = prior?.stage_id ?? prefixedId("stage");
    const artifactId = prior?.artifact_id ?? prefixedId("art");
    const relativePath = prior?.relative_path ?? join("routine-reports", `${artifactId}.${kind}`);
    const stagePath = prior?.stage_path ?? join(".routine-staging", `${stageId}.bin`);
    const now = this.now();
    // Intent precedes bytes. A crash leaves a discoverable stage, never an invisible orphan.
    this.store.handle
      .prepare(
        "INSERT INTO tavi_routine_staging VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'writing', ?, ?) ON CONFLICT(stage_id) DO UPDATE SET status='writing',updated_at=excluded.updated_at",
      )
      .run(
        stageId,
        run.runId,
        artifactId,
        kind,
        relativePath,
        stagePath,
        checksum,
        body.byteLength,
        kind === "pdf" ? "application/pdf" : "application/json",
        now,
        now,
      );
    const absolute = this.store.resolveArtifactPath(stagePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, { mode: 0o600, flag: "w" });
    // Durable-write protocol, step 1: the staged bytes reach the device before
    // anything trusts them. The intent row above already exists, so a crash
    // between the two leaves a discoverable `writing` stage rather than nothing.
    this.boundary("before-flush");
    flushFile(absolute);
    this.boundary("after-flush");
    if (sha256Hex(readFileSync(absolute)) !== checksum) throw new TaviError("UNAVAILABLE", "Report staging verification failed");
    this.store.handle.prepare("UPDATE tavi_routine_staging SET status='ready',updated_at=? WHERE stage_id=?").run(now, stageId);
    return stageId;
  }
  private retainedBytes(routineId: string): number {
    return (
      this.store.handle
        .prepare(
          "SELECT COALESCE(SUM(a.byte_size),0) AS n FROM tavi_routine_blob_refs b JOIN tavi_artifacts a ON a.artifact_id=b.artifact_id WHERE b.routine_id=?",
        )
        .get(routineId) as { n: number }
    ).n;
  }
  /**
   * Reclaim eligible artifacts so a new report can be staged.
   *
   * "Eligible" is deliberately narrow, and each exclusion is a thing that must not
   * be lost: the newest publication of *each* mode (the latest usable report a
   * reader would open), any run with an unresolved delivery job (pending,
   * deferred, dispatching or uncertain), and anything the store has pinned.
   * Reclamation spans both modes because the byte budget `retainedBytes` measures
   * does too: a production stage must not be refused while an older preview
   * publication is reclaimable, and vice versa. Oldest first, and it stops as soon
   * as the shortfall is covered — there is no reason to delete more than the next
   * report needs.
   */
  reclaimForCapacity(run: RoutineRun, shortfallBytes: number): { artifacts: number; freedBytes: number } {
    if (shortfallBytes <= 0) return { artifacts: 0, freedBytes: 0 };
    let artifacts = 0;
    let freedBytes = 0;
    const protectedRunIds = new Set<string>(
      (
        this.store.handle
          .prepare(
            "SELECT DISTINCT run_id FROM tavi_routine_delivery_jobs WHERE status IN ('pending','deferred','dispatching','uncertain')",
          )
          .all() as { run_id: string }[]
      ).map((row) => row.run_id),
    );
    const candidates = this.store.handle
      .prepare(
        "SELECT b.run_id,a.artifact_id,a.byte_size,a.sha256 FROM tavi_routine_blob_refs b JOIN tavi_artifacts a ON a.artifact_id=b.artifact_id JOIN tavi_routine_runs r ON r.run_id=b.run_id WHERE b.routine_id=? AND b.pinned=0 ORDER BY r.ended_at ASC, r.run_id ASC",
      )
      .all(run.routineId) as { run_id: string; artifact_id: string; byte_size: number; sha256: string }[];
    // The newest publication of each mode is what an operator would open; one per
    // mode stays, because reclaiming either would leave that mode with no report.
    const newest = new Set<string>(
      (
        this.store.handle
          .prepare(
            "SELECT r.run_id FROM tavi_routine_runs r WHERE r.routine_id=? AND json_extract(r.data_json,'$.publication') IS NOT NULL AND r.run_id=(SELECT n.run_id FROM tavi_routine_runs n WHERE n.routine_id=r.routine_id AND n.mode=r.mode AND json_extract(n.data_json,'$.publication') IS NOT NULL ORDER BY n.ended_at DESC, n.run_id DESC LIMIT 1)",
          )
          .all(run.routineId) as { run_id: string }[]
      ).map((row) => row.run_id),
    );
    for (const candidate of candidates) {
      if (freedBytes >= shortfallBytes) break;
      if (candidate.run_id === run.runId || newest.has(candidate.run_id) || protectedRunIds.has(candidate.run_id)) continue;
      const removed = this.store.handle
        .prepare("DELETE FROM tavi_routine_blob_refs WHERE run_id=? AND artifact_id=?")
        .run(candidate.run_id, candidate.artifact_id);
      if (removed.changes === 0) continue;
      this.store.handle
        .prepare("UPDATE tavi_routine_staging SET status='reclaimed',updated_at=? WHERE run_id=? AND artifact_id=?")
        .run(this.now(), candidate.run_id, candidate.artifact_id);
      artifacts += 1;
      freedBytes += candidate.byte_size;
    }
    return { artifacts, freedBytes };
  }
  discardOptionalPdf(fence: RoutineFence): void {
    const run = this.runs.assertFence(fence);
    const stage = this.store.handle
      .prepare("SELECT * FROM tavi_routine_staging WHERE run_id=? AND kind='pdf' AND status<>'published'")
      .get(run.runId) as Stage | undefined;
    if (stage === undefined) return;
    if (this.store.getArtifact(stage.artifact_id) !== undefined) throw new TaviError("CONFLICT", "Cannot discard a registered artifact");
    rmSync(this.store.resolveArtifactPath(stage.stage_path), { force: true });
    rmSync(this.store.resolveArtifactPath(stage.relative_path), { force: true });
    this.store.handle.prepare("DELETE FROM tavi_routine_staging WHERE stage_id=? AND status<>'published'").run(stage.stage_id);
  }
  publish(
    fence: RoutineFence,
    report: RoutineNewsReport,
    expectedStateVersion: number,
    delivery: RoutineDeliveryService,
    pdfError: string | null = null,
  ): RoutinePublication {
    // Publishing closes whichever step ran last. After a render that is the
    // render step, with its own budget: checked against synthesis instead, the
    // render's time was charged to synthesis's two minutes and a slow render
    // failed a run whose PDF was already built.
    const step = this.runs.assertFence(fence).data.stepStarted.render === undefined ? "synthesis" : "render";
    const run = this.runs.assertFence(fence, step);
    if (report.runId !== run.runId || report.routineId !== run.routineId || report.revision !== run.revision || report.mode !== run.mode)
      throw new TaviError("INVALID_INPUT", "Report does not match the admitted run");
    const previous = this.get({ workspaceId: run.workspaceId, principalId: run.principalId }, run.runId);
    if (previous !== undefined) return previous;
    const stages = this.store.handle.prepare("SELECT * FROM tavi_routine_staging WHERE run_id=? ORDER BY kind").all(run.runId) as Stage[];
    const json = stages.find((stage) => stage.kind === "json");
    if (json === undefined) throw new TaviError("INVALID_INPUT", "The local report must be staged before publication");
    if (json.hash !== sha256Hex(Buffer.from(canonicalRoutineJson(report))))
      throw new TaviError("CONFLICT", "Staged JSON does not match the report");
    for (const stage of stages) {
      const from = this.store.resolveArtifactPath(stage.stage_path);
      const to = this.store.resolveArtifactPath(stage.relative_path);
      const bytes = readFileSync(existsSync(to) ? to : from);
      if (sha256Hex(bytes) !== stage.hash || bytes.byteLength !== stage.byte_size)
        throw new TaviError("CONFLICT", "Staged report bytes do not match their manifest");
      mkdirSync(dirname(to), { recursive: true });
      if (!existsSync(to)) {
        // Steps 2-4: flush the contents, rename into place (atomic within one
        // filesystem), then flush *both* directories — the staged one loses an
        // entry and the artifact one gains it, and for a cross-directory rename
        // those are two different durability boundaries.
        const source = dirname(from);
        const destination = dirname(to);
        this.boundary("before-flush");
        flushFile(from);
        this.boundary("after-flush");
        this.boundary("before-rename");
        renameSync(from, to);
        this.boundary("after-rename");
        flushDirectory(destination);
        if (source !== destination) flushDirectory(source);
      }
      this.store.handle
        .prepare("UPDATE tavi_routine_staging SET status='moved',updated_at=? WHERE stage_id=?")
        .run(this.now(), stage.stage_id);
    }
    // Immediate: the routine state read here is the one this write replaces.
    const commit = this.store.handle.transaction(() => {
      // Step 5: the metadata commit. Bytes are durable and named before this
      // runs, so a crash here leaves an artifact file with no row — which
      // `recoverStages` deletes as an unreferenced stage and counts in `removed`
      // rather than delivering it (`damaged` is the published-stage case, where
      // the row exists but its bytes are gone or changed).
      this.boundary("before-commit");
      const current = this.runs.assertFence(fence, step);
      const state = this.store.handle
        .prepare("SELECT version,state_json FROM tavi_routine_state WHERE routine_id=?")
        .get(run.routineId) as { version: number; state_json: string };
      // Another publication of this routine may have committed while this run
      // researched: its coverage and dedup are merged with this one's here, in the
      // same write, rather than failing a run whose report is already built.
      const merged = state.version !== expectedStateVersion;
      const usage = this.store.handle
        .prepare(
          "SELECT COALESCE(SUM(a.byte_size),0) AS bytes FROM tavi_routine_blob_refs b JOIN tavi_artifacts a ON a.artifact_id=b.artifact_id WHERE b.routine_id=?",
        )
        .get(run.routineId) as { bytes: number };
      if (usage.bytes + stages.reduce((sum, stage) => sum + stage.byte_size, 0) > run.snapshot.retention.artifactBytes)
        throw new TaviError("CONFLICT", "Routine artifact retention budget is full");
      const now = this.now();
      for (const stage of stages) {
        // The PDF is a report for the fire's chat folder, copied into `reports/` once this commits; the JSON is the canvas's.
        const copy =
          stage.kind === "pdf"
            ? { folder: "reports", name: folderFileName(`routine-report-${report.generatedAt.slice(0, 10)}.pdf`, "routine-report.pdf") }
            : { folder: null, name: null };
        // Built from the stories the routine fetched: untrusted routine output.
        this.store.handle
          .prepare(
            "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state,reviewed_by,reviewed_at,file_name,folder_copy,label_json) VALUES (?,?,?,?,?,?,?,?, 'approved','routine-publisher',?,?,?,?)",
          )
          .run(
            stage.artifact_id,
            run.workspaceId,
            run.taskId,
            stage.relative_path,
            stage.content_type,
            stage.byte_size,
            stage.hash,
            now,
            now,
            copy.name,
            copy.folder,
            JSON.stringify(
              untrustedLabel("routine-output", {
                principal: `routine:${run.routineId}`.slice(0, CONTENT_LABEL_LIMITS.maxPrincipalLength),
                ref: { ref: stage.artifact_id, at: now },
              }),
            ),
          );
        this.store.handle
          .prepare("INSERT INTO tavi_routine_blob_refs VALUES (?,?,?,?,?)")
          .run(run.routineId, run.runId, stage.artifact_id, stage.hash, 0);
        this.store.handle
          .prepare("UPDATE tavi_routine_staging SET status='published',updated_at=? WHERE stage_id=?")
          .run(now, stage.stage_id);
      }
      const pdf = stages.find((stage) => stage.kind === "pdf");
      const publication: RoutinePublication = {
        reportArtifactId: json.artifact_id,
        pdfArtifactId: pdf?.artifact_id ?? null,
        publishedAt: now,
        pdfError,
        headline: (report.stories[0]?.title ?? report.title).slice(0, 300),
      };
      this.store.handle
        .prepare("UPDATE tavi_routine_runs SET data_json=? WHERE run_id=?")
        .run(canonicalRoutineJson({ ...current.data, publication }), run.runId);
      if (run.mode === "production") {
        const saved = JSON.parse(state.state_json) as { dedup?: RoutineDedupEntry[]; [key: string]: unknown };
        // The clustering policy this run selected under, recorded by `news.select` on the run itself.
        const clustering = (current.data as typeof current.data & { clustering?: unknown }).clustering;
        const cutoff = Date.parse(report.generatedAt) - run.snapshot.report.dedupWindowDays * 86_400_000;
        const rows = [
          ...(saved.dedup ?? []).filter((item) => Date.parse(item.at) >= cutoff),
          // Named as well as keyed, so the next run's research and synthesis can be told what was already reported.
          ...report.stories.map(
            (story): RoutineDedupEntry => ({
              key: story.dedupKey,
              at: report.generatedAt,
              title: story.title,
              releaseIdentity: story.releaseIdentity,
            }),
          ),
        ].slice(-2000);
        // Only the newest rows are ever named to a run; the rest need just their key and time to suppress a repeat.
        const dedup = rows.map(
          (row, index): RoutineDedupEntry => (index < rows.length - ROUTINE_REPORTED_LIMIT ? { key: row.key, at: row.at } : row),
        );
        this.store.handle.prepare("UPDATE tavi_routine_state SET version=version+1,state_json=? WHERE routine_id=? AND version=?").run(
          canonicalRoutineJson({
            ...saved,
            ...(clustering === undefined ? {} : { clustering }),
            dedup,
            ...routineCoverageState(saved, report, merged),
          }),
          run.routineId,
          state.version,
        );
        // A PDF that could not be rendered no longer means no delivery (a
        // destination requires PDF generation, so this is a render failure): the
        // destination gets the report as text instead.
        if (!report.suppressed) {
          if (pdf !== undefined) delivery.enqueue(current, pdf.artifact_id, pdf.hash, now);
          else delivery.enqueue(current, json.artifact_id, json.hash, now, routineReportText(report, current.snapshot.report.template));
        }
      }
      this.runs.append(current, { version: 1, code: "published", generation: fence.generation });
      this.runs.finish(fence, report.suppressed ? "suppressed" : report.degraded || pdfError !== null ? "degraded" : "succeeded");
      return publication;
    });
    return commit.immediate();
  }
  /**
   * Reconcile intents with files. Published or still-running stages are retained.
   *
   * A staged file is collected only after `STAGE_GRACE_MS`: the write that created
   * it may be in flight in another attempt, and a recovery that deleted a stage
   * the moment it looked unreferenced would turn a slow write into data loss. The
   * grace is measured from the stage's own `updated_at`, so a paused owner does
   * not extend it.
   *
   * This runs on the persistence worker at every start, so it reads no report
   * bytes: a published stage counts as `damaged` when its file is missing or its
   * size differs from the manifest. The full hash is checked where the bytes are
   * trusted (staging, publication, a read and a delivery) and by `tavi doctor`
   * (`publishedReports`). Whether each stage's artifact row and blob reference
   * still exist is read in the same statement, not once per stage.
   */
  recoverStages(): { removed: number; damaged: number } {
    let removed = 0;
    let damaged = 0;
    const stages = this.store.handle
      .prepare(
        "SELECT s.*,r.status AS run_status,EXISTS(SELECT 1 FROM tavi_artifacts a WHERE a.artifact_id=s.artifact_id) AS has_artifact,EXISTS(SELECT 1 FROM tavi_routine_blob_refs b WHERE b.artifact_id=s.artifact_id) AS has_ref FROM tavi_routine_staging s JOIN tavi_routine_runs r ON r.run_id=s.run_id",
      )
      .all() as (Stage & { run_status: string; has_artifact: 0 | 1; has_ref: 0 | 1 })[];
    const remove = this.store.handle.prepare("DELETE FROM tavi_routine_staging WHERE stage_id=?");
    const now = Date.parse(this.now());
    for (const stage of stages) {
      const referenced = stage.has_artifact === 1 || stage.has_ref === 1;
      if (stage.status === "published") {
        if (!referenced) {
          remove.run(stage.stage_id);
          removed++;
          continue;
        }
        const file = statSync(this.store.resolveArtifactPath(stage.relative_path), { throwIfNoEntry: false });
        if (file?.isFile() !== true || file.size !== stage.byte_size) damaged++;
        continue;
      }
      if (["queued", "running", "interrupted"].includes(stage.run_status)) continue;
      if (now - Date.parse(stage.updated_at) < STAGE_GRACE_MS) continue;
      // Check both metadata and all scoped references before removing any bytes.
      if (referenced) continue;
      rmSync(this.store.resolveArtifactPath(stage.stage_path), { force: true });
      rmSync(this.store.resolveArtifactPath(stage.relative_path), { force: true });
      remove.run(stage.stage_id);
      removed++;
    }
    return { removed, damaged };
  }
  /**
   * Every published report file, for `tavi doctor` to verify in full.
   *
   * Metadata only: the hashing is the caller's, off the persistence worker, so a
   * check of large reports never queues every other database request behind it.
   */
  publishedReports(): {
    routineId: string;
    runId: string;
    artifactId: string;
    kind: "json" | "pdf";
    path: string;
    hash: string;
    byteSize: number;
  }[] {
    const rows = this.store.handle
      .prepare(
        "SELECT r.routine_id,s.run_id,s.artifact_id,s.kind,s.relative_path,s.hash,s.byte_size FROM tavi_routine_staging s JOIN tavi_routine_runs r ON r.run_id=s.run_id WHERE s.status='published' ORDER BY r.routine_id,s.run_id,s.kind",
      )
      .all() as (Pick<Stage, "run_id" | "artifact_id" | "kind" | "relative_path" | "hash" | "byte_size"> & { routine_id: string })[];
    return rows.map((row) => ({
      routineId: row.routine_id,
      runId: row.run_id,
      artifactId: row.artifact_id,
      kind: row.kind,
      path: this.store.resolveArtifactPath(row.relative_path),
      hash: row.hash,
      byteSize: row.byte_size,
    }));
  }
  prune(scope: RoutineScope, routineId: string, admitted?: Pick<RoutineRun, "mode" | "snapshot">): number {
    const detail = this.runs.routines.get(scope, routineId);
    const retention =
      admitted?.snapshot.retention ??
      this.runs.routines.get(scope, routineId, detail.routine.activeRevision ?? detail.routine.latestRevision).revision.snapshot.retention;
    let removed = 0;
    for (const mode of admitted === undefined ? (["production", "preview"] as const) : [admitted.mode]) {
      const keep = mode === "production" ? retention.productionArtifacts : retention.previewArtifacts;
      const rows = this.store.handle
        .prepare(
          "SELECT r.run_id FROM tavi_routine_runs r WHERE r.routine_id=? AND r.mode=? AND json_extract(r.data_json,'$.publication') IS NOT NULL ORDER BY r.ended_at DESC,r.run_id DESC LIMIT -1 OFFSET ?",
        )
        .all(routineId, mode, keep) as { run_id: string }[];
      for (const row of rows) {
        if (
          this.store.handle
            .prepare(
              "SELECT 1 FROM tavi_routine_delivery_jobs WHERE run_id=? AND status IN ('pending','deferred','dispatching','uncertain')",
            )
            .get(row.run_id) !== undefined
        )
          continue;
        removed += this.store.handle.prepare("DELETE FROM tavi_routine_blob_refs WHERE run_id=? AND pinned=0").run(row.run_id).changes;
      }
    }
    return removed;
  }
}

/**
 * How long a report's text may run before the rest is left to the report
 * itself. Not any channel's message limit: the messaging service splits text
 * over a channel's own `maxTextLength` into several messages, so this only keeps a chat from receiving a book.
 */
export const REPORT_TEXT_LIMIT = 12_000;

/**
 * A published report as one plain-text message: its title and coverage, then
 * each story with its claims and their HTTPS sources. Sources are the report's
 * own canonical URLs (HTTPS by construction); the text is cut at a story
 * boundary with a note, never mid-claim, past `REPORT_TEXT_LIMIT`.
 */
export function routineReportText(report: RoutineNewsReport, template?: Pick<RoutineTemplate, "quiet">): string {
  const day = report.coverage.to.slice(0, 10);
  const head = `${report.title} — ${day}`;
  if (report.quiet || report.stories.length === 0) return `${head}\n\n${template?.quiet.text ?? "No qualifying news verified."}`;
  const sources = new Map(report.sources.map((source) => [source.sourceId, source]));
  const blocks = report.stories.map((story) => {
    const lines = [`• ${story.title}`];
    for (const claim of story.claims) {
      const source = sources.get(claim.sourceId);
      lines.push(`  ${claim.text}${source?.canonicalUrl.startsWith("https://") ? ` (${source.publisher}: ${source.canonicalUrl})` : ""}`);
    }
    for (const caveat of story.caveats) lines.push(`  Note: ${caveat}`);
    return lines.join("\n");
  });
  let text = head;
  for (const [index, block] of blocks.entries()) {
    const omitted = `\n\n…and ${blocks.length - index} more in the report.`;
    if (text.length + block.length + 2 + omitted.length > REPORT_TEXT_LIMIT) return `${text}${omitted}`;
    text += `\n\n${block}`;
  }
  return text;
}
