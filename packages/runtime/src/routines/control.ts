import { QUESTION_SQL } from "../persistence/approval-inbox.js";
import {
  joinMemoryProvenance,
  memoryProvenanceOf,
  routineProvenanceLine,
  skillProvenanceForeign,
  type RoutineProvenance,
} from "@tavi/contracts";
import {
  AgentWaitOutcomeSchema,
  AskUserChoicesSchema,
  LLM_RELEASES_ROUTINE_TEMPLATE_ID,
  ROUTINE_MIN_FREE_BYTES,
  standingAnswerKey,
  type RoutineCheckpoint,
  type RoutineNewsReport,
  type RoutineRun,
  RoutineCreateSchema,
  type RoutineDeliveryPatchSchema,
  type RoutineReportPatchSchema,
  routineSetupTriggers,
  RoutineSnapshotSchema,
  unsupportedRoutinePolicy,
  RoutinesPayloadSchema,
  TaviError,
  routineCadenceLookback,
  routineDefaults,
  routineDefaultInstructions,
  routineTemplateIdOf,
  type RoutineDetail,
  type RoutineEditResult,
  type RoutineReadiness,
  type RoutineRunStatus,
  type RoutineScope,
  type RoutineSnapshot,
  type RoutinesPayload,
} from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { zodIssues } from "@tavi/contracts/zod-util";
import type { z } from "zod";
import { sha256Hex } from "@tavi/node-kit";
import { canonicalRoutineJson, routineHash, type RoutineService } from "./service.js";
import { routineGrantableTools } from "./grants.js";
import type { RoutineExecutionService } from "./runs.js";
import type { RoutineNewsService } from "./news.js";
import type { RoutineDeliveryService } from "./delivery.js";
import { routineReportText, type RoutinePublicationService } from "./publication.js";
/** The window `get` sums its routine's runs over. */
const SEVEN_DAYS_MS = 7 * 86_400_000;
/**
 * What a routine says until one of its runs has published a report: its setup check measured the models on a fixed
 * test set, never on its own objective, so a person should see it on its topic before trusting its schedule.
 */
export const ROUTINE_UNTRIED_NOTICE =
  "Its setup check measures the models on a fixed test set, not on this routine's objective. Preview it to see a report on its topic.";
/** How old a written heartbeat may be before the view calls the owner unknown. */
export const OWNER_HEARTBEAT_STALE_MS = 90_000;
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new TaviError("INVALID_INPUT", `${label} is required`);
  return value;
};
/**
 * Which snapshot sections differ between two revisions, so the edit response
 * means the same thing on every surface that reports one.
 *
 * `routineScheduleAction` and the control service both answer
 * `RoutineEditResult.changes`, and a second copy of this expression is how the two
 * came to disagree.
 */
/**
 * A revision's report with an edit's fields over it. Its plugin template is kept while `templateVersion`
 * stays; another plugin template is chosen through an update, which the owner pins as it saves.
 */
function patchedReport(prior: RoutineSnapshot["report"], patch: z.infer<typeof RoutineReportPatchSchema>): RoutineSnapshot["report"] {
  const { template, ...fields } = prior;
  const merged = { ...fields, ...definedOnly(patch) };
  return template !== undefined && merged.templateVersion === prior.templateVersion ? { ...merged, template } : merged;
}
/** A revision's delivery with an edit's fields over it; a `null` window removes the revision's. */
function patchedDelivery(
  prior: RoutineSnapshot["delivery"],
  patch: z.infer<typeof RoutineDeliveryPatchSchema>,
): RoutineSnapshot["delivery"] {
  const { window, ...fields } = definedOnly(patch);
  const merged = { ...prior, ...fields };
  if (window === null) {
    const { window: _removed, ...rest } = merged;
    return rest;
  }
  return window === undefined ? merged : { ...merged, window };
}
export function changedSections(before: RoutineSnapshot, after: RoutineSnapshot): readonly (keyof RoutineSnapshot)[] {
  return (Object.keys(after) as (keyof RoutineSnapshot)[]).filter(
    (key) => canonicalRoutineJson(after[key]) !== canonicalRoutineJson(before[key]),
  );
}
/**
 * The research policy shown for, and pinned by, simplified routine creation.
 *
 * The owner's `RoutineControlService` shows it and this worker-side service pins
 * it, so both read it from here.
 */
export function routineSetupPermissions(allowedHosts: readonly string[]): RoutineSnapshot["permissions"] {
  return allowedHosts.length > 0
    ? { revision: 1, researchTools: ["web_search", "http.request"], allowedHosts: [...allowedHosts], networkMode: "allowlist" }
    : { revision: 1, researchTools: ["web_search", "web_fetch"], allowedHosts: [], networkMode: "open_web" };
}
/**
 * What a routine control service is built from: its routine services — the
 * worker's (`RoutineControlService` here) or the owner's facades
 * (`async-control.ts`) — and the settings both read.
 */
export type RoutineControlOptions<Services> = Services & {
  defaultModels: () => RoutineSnapshot["models"] | undefined;
  allowedHosts: readonly string[];
  wake: () => void;
  renderer?: () => { available: boolean; provider: string };
  now?: () => string;
};
/**
 * Decrypted report bytes a chunked download reads from, across requests.
 *
 * A download is many `artifact` calls (one per chunk), each served by its own
 * control service, so the bytes are kept here, outside it: read, verified and
 * decrypted once per download rather than once per chunk. A download's first
 * chunk reads afresh, its last one evicts, and only a few are held at a time:
 * at most `limit` downloads and `maxBytes` between them (the newest is always
 * kept), the least recently read going first.
 */
export class RoutineArtifactCache {
  readonly #entries = new Map<string, { hash: string; body: Buffer }>();
  #bytes = 0;
  readonly limit: number;
  readonly maxBytes: number;
  constructor(limit = 4, maxBytes = 64 * 1024 * 1024) {
    this.limit = limit;
    this.maxBytes = maxBytes;
  }
  get(artifactId: string, hash: string): Buffer | undefined {
    const entry = this.#entries.get(artifactId);
    if (entry?.hash !== hash) return undefined;
    this.#entries.delete(artifactId);
    this.#entries.set(artifactId, entry);
    return entry.body;
  }
  set(artifactId: string, hash: string, body: Buffer): void {
    this.evict(artifactId);
    this.#entries.set(artifactId, { hash, body });
    this.#bytes += body.length;
    for (const oldest of this.#entries.keys()) {
      if (oldest === artifactId || (this.#entries.size <= this.limit && this.#bytes <= this.maxBytes)) break;
      this.evict(oldest);
    }
  }
  evict(artifactId: string): void {
    const entry = this.#entries.get(artifactId);
    if (entry === undefined) return;
    this.#bytes -= entry.body.length;
    this.#entries.delete(artifactId);
  }
}
/** The most of a report's text `inspect` returns. */
const ROUTINE_REPORT_TEXT_MAX = 12_000;
/** A report JSON larger than this is not read for `inspect`'s text. */
const ROUTINE_REPORT_JSON_MAX = 4 * 1024 * 1024;

export class RoutineControlService {
  private readonly artifactCache: RoutineArtifactCache;
  readonly options: RoutineControlOptions<{
    routines: RoutineService;
    runs: RoutineExecutionService;
    news: RoutineNewsService;
    delivery: RoutineDeliveryService;
    publication: RoutinePublicationService;
  }>;
  constructor(options: RoutineControlService["options"], artifactCache = new RoutineArtifactCache()) {
    this.options = options;
    this.artifactCache = artifactCache;
  }
  private get routines() {
    return this.options.routines;
  }
  /**
   * A published run's report as text, clipped to `ROUTINE_REPORT_TEXT_MAX`: undefined when its artifact has expired,
   * is damaged, or is not a report. Read whole: a report is small, and the 64 MiB guard is the download's.
   */
  #reportText(
    workspaceId: string,
    run: Pick<RoutineRun, "snapshot">,
    artifactId: string,
  ): { readonly text: string; readonly truncated: boolean } | undefined {
    try {
      const artifact = this.routines.store.getArtifact(artifactId);
      if (!artifact || artifact.workspaceId !== workspaceId || artifact.byteSize > ROUTINE_REPORT_JSON_MAX) return undefined;
      const bytes = this.routines.store.readArtifactBody(artifactId);
      if (!bytes || sha256Hex(bytes) !== artifact.sha256) return undefined;
      const text = routineReportText(JSON.parse(Buffer.from(bytes).toString("utf8")) as RoutineNewsReport, run.snapshot.report.template);
      return { text: text.slice(0, ROUTINE_REPORT_TEXT_MAX), truncated: text.length > ROUTINE_REPORT_TEXT_MAX };
    } catch {
      return undefined;
    }
  }
  /**
   * `topicNotice` while no run of the revision has published a report, and it can still be previewed. An
   * `llm-releases-v1` revision's check is asked its own objective, so it has none.
   */
  private topicNotice(detail: RoutineDetail): { topicNotice?: string } {
    if (detail.routine.status === "archived") return {};
    if (routineTemplateIdOf(detail.revision.snapshot) === LLM_RELEASES_ROUTINE_TEMPLATE_ID) return {};
    const tried = this.routines.store.handle
      .prepare(
        "SELECT 1 FROM tavi_routine_runs WHERE routine_id=? AND revision=? AND status IN ('succeeded','degraded','suppressed') LIMIT 1",
      )
      .get(detail.routine.routineId, detail.revision.revision);
    return tried === undefined ? { topicNotice: ROUTINE_UNTRIED_NOTICE } : {};
  }
  private resolve(scope: RoutineScope, input: RoutinesPayload): string {
    if (input.routineId !== undefined) {
      this.routines.get(scope, input.routineId);
      return input.routineId;
    }
    if (input.conversationId !== undefined) {
      const row = this.routines.store.handle
        .prepare("SELECT routine_id FROM tavi_routine_conversations WHERE workspace_id=? AND principal_id=? AND conversation_id=?")
        .get(scope.workspaceId, scope.principalId, input.conversationId) as { routine_id: string } | undefined;
      if (row !== undefined) {
        this.routines.get(scope, row.routine_id);
        return row.routine_id;
      }
    }
    throw new TaviError("INVALID_INPUT", "Choose a routine; this conversation has no linked routine");
  }
  private link(scope: RoutineScope, conversationId: string | undefined, routineId: string): void {
    if (conversationId === undefined) return;
    this.routines.store.handle
      .prepare(
        "INSERT INTO tavi_routine_conversations VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,principal_id,conversation_id) DO UPDATE SET routine_id=excluded.routine_id,updated_at=excluded.updated_at",
      )
      .run(scope.workspaceId, scope.principalId, conversationId, routineId, nowTimestamp());
  }
  /**
   * The readiness view.
   *
   * Every statement comes from the real check the runtime uses: the same
   * `researchReady` predicate a run is admitted against, the same
   * `deliveryReadiness` a dispatch consults, the same `freeBytes` the claim path
   * refuses on, and the same renderer capability the pipeline branches on. The
   * probe performs no model call and sends nothing, so an operator can ask what
   * would happen without making anything happen.
   */
  private readiness(scope: RoutineScope, routineId: string): RoutineReadiness {
    const { runs } = this.options;
    const detail = this.routines.get(scope, routineId);
    const snapshot = detail.revision.snapshot;
    const state = this.routines.store.handle
      .prepare("SELECT state_json,heartbeat_at FROM tavi_routine_state WHERE routine_id=?")
      .get(routineId) as { state_json: string; heartbeat_at: string | null };
    const probe = runs.options.researchReady({ routineId, snapshot });
    const heartbeatAt = state.heartbeat_at;
    const age = heartbeatAt === null ? null : Date.parse(this.now()) - Date.parse(heartbeatAt);
    const delivery = this.routines.deliveryReadiness(scope, routineId, detail.revision.revision);
    // The grant belongs to a *run*, so the view reports the newest run's: a
    // routine that has never run has none, and so does one whose newest run was
    // admitted before routine grants existed. Both are facts the operator
    // can read, not errors, and the revision's own declaration is what a future run
    // would be admitted under.
    const latestRun = runs.history(scope, routineId, 1)[0];
    const policy = latestRun === undefined ? null : runs.effectiveGrantPolicy(scope, latestRun.runId);
    const grant: RoutineReadiness["research"]["grant"] =
      policy === null ? null : { grantId: policy.grantId, revokedAt: policy.revokedAt, policyRevision: policy.policyRevision };
    // An armed occurrence is the answer an operator wants: SQLite sorts `NULL`
    // first, so ordering by `next_run_at` alone would let a consumed one-off
    // (`next_run_at IS NULL`, disabled) mask the daily trigger that is actually due.
    const scheduleRow = this.routines.store.handle
      .prepare(
        "SELECT s.next_run_at,s.enabled,t.trigger_id FROM tavi_schedules s JOIN tavi_routine_triggers t ON t.schedule_id=s.schedule_id WHERE t.routine_id=? ORDER BY s.enabled DESC, s.next_run_at IS NULL, s.next_run_at LIMIT 1",
      )
      .get(routineId) as { next_run_at: string | null; enabled: number; trigger_id: string } | undefined;
    const freeBytes = runs.options.freeBytes?.() ?? null;
    const candidate = detail.evaluation.status !== "passed" ? detail.evaluation : null;
    return {
      routineId,
      revision: {
        active: detail.routine.activeRevision,
        latest: detail.routine.latestRevision,
        candidate: candidate === null ? null : { revision: candidate.revision, evaluation: candidate.status, detail: candidate.detail },
      },
      research: {
        ready: probe.ready,
        blockedBy: probe.ready ? null : probe.code,
        retryable: probe.ready ? null : probe.retryable,
        // The effective policy is a property of a *run*; before the first run — and
        // for a run admitted before grants existed — the revision's own declaration
        // is what a run would be admitted under, which is the same intersection the
        // grant would have pinned.
        tools:
          policy === null
            ? routineGrantableTools("research", snapshot.permissions, snapshot, runs.options.pluginReads?.() ?? [])
            : policy.researchTools,
        hosts: policy === null ? snapshot.permissions.allowedHosts : policy.allowedHosts,
        networkMode: snapshot.permissions.networkMode,
        grant,
      },
      delivery: {
        // Research health and delivery health are separate statements: a revoked
        // destination blocks a send while research continues.
        authorized: delivery.length === 0 ? false : delivery.every((entry) => entry.problem === null),
        blockedBy: delivery.find((entry) => entry.problem !== null)?.problem ?? null,
        targets: delivery,
      },
      owner: {
        heartbeatAt,
        state: heartbeatAt === null ? "never" : (age ?? 0) > OWNER_HEARTBEAT_STALE_MS ? "stale" : "live",
        heartbeatAgeMs: age,
      },
      storage: { freeBytes, belowFloor: freeBytes === null ? null : freeBytes < ROUTINE_MIN_FREE_BYTES },
      schedule:
        scheduleRow === undefined
          ? null
          : {
              nextRunAt: scheduleRow.next_run_at,
              timezone: snapshot.execution.timezone,
              triggerId: scheduleRow.trigger_id,
              enabled: scheduleRow.enabled === 1,
            },
      renderer: this.options.renderer?.() ?? null,
    };
  }
  /** One clock, injected like every other service's, so an age is measured against the caller's now. */
  private now(): string {
    return this.options.now?.() ?? nowTimestamp();
  }

  execute(raw: RoutinesPayload): unknown {
    const unsupported = unsupportedRoutinePolicy(raw);
    if (unsupported !== undefined) throw new TaviError("UNSUPPORTED", unsupported);
    const parsed = RoutinesPayloadSchema.parse(raw);
    const input = { ...parsed, routineId: parsed.routineId ?? parsed.update?.routineId };
    const scope = { workspaceId: input.workspaceId, principalId: input.principalId };
    const { runs, news, delivery, publication } = this.options;
    if (input.action === "list") {
      const routines = this.routines.listOverview(scope, input.limit);
      const latest = runs.latestRuns(
        scope,
        routines.map((routine) => routine.routineId),
      );
      return { routines: routines.map((routine) => ({ ...routine, lastRun: latest.get(routine.routineId) ?? null })) };
    }
    if (input.action === "targets")
      return {
        targets: (
          this.routines.store.handle
            .prepare("SELECT target_json FROM tavi_routine_delivery_targets WHERE workspace_id=? AND principal_id=? LIMIT 100")
            .all(scope.workspaceId, scope.principalId) as { target_json: string }[]
        ).map((row) => {
          const target = JSON.parse(row.target_json) as { targetId: string };
          try {
            return { ...this.routines.target(scope, target.targetId), authorized: true };
          } catch {
            return { ...target, authorized: false };
          }
        }),
      };
    if (input.action === "add_target") return this.routines.putTarget(scope, required(input.target, "Explicit delivery target"));
    // Standing answers: given from a question the routine asked, never typed in free.
    if (input.action === "answers") return { answers: this.routines.standingAnswers(scope, required(input.routineId, "Routine id")) };
    if (input.action === "forget_answer")
      return {
        removed: this.routines.removeStandingAnswer(
          scope,
          required(input.routineId, "Routine id"),
          required(input.questionKey, "Question key"),
        ),
      };
    if (input.action === "checkpoints") {
      const run = runs.get(scope, required(input.runId, "Run id"));
      if (run.routineId !== required(input.routineId, "Routine id")) throw new TaviError("NOT_FOUND", "No such run of this routine");
      if (run.taskId === null) return { checkpoints: [] };
      const rows = this.routines.store.handle
        .prepare(`SELECT w.wait_id, w.deadline_at, w.state, w.settled_outcome_json, w.choices_json, w.settled_by, w.settled_via, w.settled_at,
          ${QUESTION_SQL("w")} AS question
        FROM tavi_agent_wait_intents w WHERE w.task_id = ? AND w.correlation_id IS NULL AND w.waiting_on_worker_task_id IS NULL AND w.choices_json IS NOT NULL
        ORDER BY COALESCE(w.settled_at, w.deadline_at), w.wait_id LIMIT 50`)
        .all(run.taskId) as {
        wait_id: string;
        deadline_at: string;
        state: string;
        settled_outcome_json: string | null;
        choices_json: string;
        settled_by: string | null;
        settled_via: string | null;
        settled_at: string | null;
        question: string | null;
      }[];
      return {
        checkpoints: rows.map((row): RoutineCheckpoint => {
          const choices = AskUserChoicesSchema.parse(JSON.parse(row.choices_json));
          const outcome =
            row.settled_outcome_json === null ? undefined : AgentWaitOutcomeSchema.parse(JSON.parse(row.settled_outcome_json));
          const state =
            row.state !== "settled"
              ? "open"
              : outcome?.kind === "answered"
                ? "answered"
                : outcome?.kind === "wait-timeout"
                  ? "defaulted"
                  : outcome?.error?.code === "DELIVERY_FAILED"
                    ? "undelivered"
                    : "withdrawn";
          return {
            waitId: row.wait_id,
            options: choices.options.map((option) => option.label),
            multiSelect: choices.multiSelect,
            state,
            deadlineAt: row.deadline_at,
            ...(row.question === null ? {} : { question: row.question }),
            ...(choices.header === undefined ? {} : { header: choices.header }),
            ...(outcome?.answers === undefined ? {} : { answers: outcome.answers }),
            ...(outcome?.replyText === undefined || outcome.kind !== "answered" ? {} : { replyText: outcome.replyText }),
            ...(row.settled_by === null ? {} : { by: row.settled_by }),
            ...(row.settled_via === null ? {} : { via: row.settled_via }),
            ...(row.settled_at === null ? {} : { at: row.settled_at }),
          };
        }),
      };
    }
    if (input.action === "always_answer") {
      const routineId = required(input.routineId, "Routine id");
      const answers = required(input.answers, "Answers");
      const wait = this.routines.store.asPort().repositories.agentWaits.get(required(input.waitId, "Question"));
      // Only a question one of this routine's own runs asked, read as the inbox reads it.
      const row =
        wait === undefined
          ? undefined
          : (this.routines.store.handle
              .prepare(`SELECT ${QUESTION_SQL("w")} AS question, w.settled_via FROM tavi_agent_wait_intents w JOIN tavi_routine_runs r ON r.task_id = w.task_id
          WHERE w.wait_id = ? AND r.routine_id = ? AND r.workspace_id = ? AND r.principal_id = ?`)
              .get(wait.waitId, routineId, scope.workspaceId, scope.principalId) as
              | { question: string | null; settled_via: string | null }
              | undefined);
      const question = row?.question ?? undefined;
      if (wait === undefined || row === undefined || question === undefined)
        throw new TaviError("NOT_FOUND", "No question this routine asked");
      // Kept only from what a person answered: not a question still open, defaulted, withdrawn, or itself standing-answered.
      if (wait.settledOutcome?.kind !== "answered" || row.settled_via === "standing-answer" || row.settled_via === "policy") {
        throw new TaviError("INVALID_INPUT", "Only an answer a person gave can be kept for next time");
      }
      const labels = new Set(wait.choices?.options.map((option) => option.label));
      if (
        wait.choices === undefined ||
        !answers.every((answer) => labels.has(answer)) ||
        (!wait.choices.multiSelect && answers.length !== 1)
      ) {
        throw new TaviError("INVALID_INPUT", "A standing answer is one of the question's own options");
      }
      return this.routines.putStandingAnswer(scope, routineId, {
        questionKey: standingAnswerKey(question, wait.choices),
        question,
        answers: [...answers],
        createdBy: scope.principalId,
        createdAt: this.now(),
      });
    }
    if (input.action === "create") {
      const created = this.routines.store.handle.transaction(() => {
        let create = input.create;
        if (create === undefined) {
          const setup = required(input.setup, "Routine setup");
          const defaults = routineDefaults(setup.timezone);
          const models = setup.models ?? this.options.defaultModels();
          if (models === undefined)
            throw new TaviError(
              "NOT_CONFIGURED",
              "No model is configured for routines. Set a default model in Settings → Models (or `tavi models set-default`), then create the routine again.",
            );
          const triggers = routineSetupTriggers(setup);
          create = RoutineCreateSchema.parse({
            ...defaults,
            report: {
              ...defaults.report,
              // The window its cadence needs: a weekly routine reads its week.
              ...routineCadenceLookback(triggers, new Date(this.now())),
              ...(setup.style === undefined ? {} : { style: setup.style }),
              ...(setup.delivery?.pdf === true ? { formats: ["in-app", "pdf"] } : {}),
            },
            delivery: setup.delivery === undefined ? defaults.delivery : { ...defaults.delivery, targetIds: [setup.delivery.targetId] },
            name: setup.name,
            objective: setup.objective,
            operationKey: required(input.operationKey, "Operation key"),
            conversationId: input.conversationId,
            agent: {
              agentId: setup.agentId ?? `news-${routineHash({ scope, operationKey: input.operationKey }).slice(0, 16)}`,
              name: setup.name,
              instructions: setup.instructions ?? routineDefaultInstructions(defaults.report.templateVersion),
            },
            triggers,
            // A retry pins what the first try did; only a new create resolves the skills' active versions.
            skills:
              this.routines.createdSkillPins(scope, required(input.operationKey, "Operation key")) ??
              this.routines.resolveSkillPins(scope, setup.skills ?? []),
            models,
            permissions: routineSetupPermissions(this.options.allowedHosts),
          });
        }
        // A copy keeps what its source's words may have come from, unless the person rewrote them, as an edit does.
        const source = input.copyOf === undefined ? undefined : this.routines.get(scope, input.copyOf).revision;
        const keptWords =
          source !== undefined &&
          (input.modelLabel !== undefined ||
            (create.objective === source.snapshot.objective && create.agent.instructions === source.snapshot.agent.instructions));
        // Made by the model under taint: revision 1 carries its chat's provenance.
        const detail = this.routines.create(
          scope,
          create,
          joinMemoryProvenance(keptWords ? source?.provenance : undefined, memoryProvenanceOf(input.modelLabel)),
        );
        this.link(scope, input.conversationId ?? create.conversationId, detail.routine.routineId);
        return detail;
      })();
      this.options.wake();
      // Truthful next start: the schedule the creation actually armed, read back
      // rather than asserted. It is null while the routine is not active (the
      // trigger exists but is disabled until evaluation passes).
      const armed = this.routines.store.handle
        .prepare(
          "SELECT MIN(next_run_at) AS next FROM tavi_schedules s JOIN tavi_routine_triggers t ON t.schedule_id=s.schedule_id WHERE t.routine_id=? AND s.enabled=1",
        )
        .get(created.routine.routineId) as { next: string | null };
      // Said as an edit says it: a destination that is not ready, or a trigger outside the delivery window.
      return {
        ...created,
        ...this.topicNotice(created),
        nextStart: armed.next,
        deliveryReadiness: this.routines.deliveryReadiness(scope, created.routine.routineId, created.revision.revision),
      };
    }
    if (input.action === "artifact") {
      const runId = required(input.runId, "Run id");
      const published = publication.get(scope, runId);
      const artifactId = input.artifactKind === "pdf" ? published?.pdfArtifactId : published?.reportArtifactId;
      if (!artifactId) throw new TaviError("NOT_FOUND", "Report artifact is unavailable");
      const artifact = this.routines.store.getArtifact(artifactId);
      const retained = this.routines.store.handle
        .prepare("SELECT 1 FROM tavi_routine_blob_refs WHERE run_id=? AND artifact_id=?")
        .get(runId, artifactId);
      if (!artifact || !retained || artifact.workspaceId !== scope.workspaceId)
        throw new TaviError("NOT_FOUND", "Report artifact has expired");
      if (artifact.byteSize > 64 * 1024 * 1024) throw new TaviError("UNSUPPORTED", "Report exceeds the 64 MiB download limit");
      const offset = input.offset ?? 0;
      let body = offset === 0 ? undefined : this.artifactCache.get(artifactId, artifact.sha256);
      if (body === undefined) {
        const bytes = this.routines.store.readArtifactBody(artifactId);
        if (!bytes || sha256Hex(bytes) !== artifact.sha256) throw new TaviError("UNAVAILABLE", "Report bytes are missing or damaged");
        body = Buffer.from(bytes);
        this.artifactCache.set(artifactId, artifact.sha256, body);
      }
      if (offset > body.length) throw new TaviError("INVALID_INPUT", "Invalid artifact offset");
      const chunk = body.subarray(offset, offset + 128 * 1024);
      const nextOffset = offset + chunk.length < body.length ? offset + chunk.length : null;
      if (nextOffset === null) this.artifactCache.evict(artifactId);
      return {
        artifactId,
        contentType: artifact.contentType,
        hash: artifact.sha256,
        totalBytes: body.length,
        offset,
        base64: Buffer.from(chunk).toString("base64"),
        nextOffset,
      };
    }
    if (input.action === "inspect" || input.action === "cancel" || input.action === "sources" || input.action === "revoke_grant") {
      const runId = required(input.runId, "Run id");
      const run = runs.get(scope, runId);
      if (input.action === "cancel") {
        runs.cancel(scope, runId);
        return runs.get(scope, runId);
      }
      // An operator can bound a run's authority without cancelling it: the next
      // research or delivery effect fails closed, and already-fetched evidence and
      // an already-published report stay intact.
      if (input.action === "revoke_grant") return runs.revokeGrant(scope, runId, input.reason ?? "Revoked by the operator");
      if (input.action === "sources") {
        const rows = news
          .sources(scope, runId)
          .filter((source) => input.afterSourceId === undefined || source.sourceId > input.afterSourceId);
        const page = rows.slice(0, Math.min(input.limit ?? 5, 5));
        return {
          sources: page.map((source) => ({
            ...source,
            excerpt: source.excerpt.slice(0, 2000),
            excerptTruncated: source.excerpt.length > 2000,
          })),
          nextAfterSourceId: rows.length > page.length ? (page.at(-1)?.sourceId ?? null) : null,
        };
      }
      const state = this.routines.store.handle
        .prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?")
        .get(run.routineId) as { state_json: string };
      const health = (JSON.parse(state.state_json) as { deliveryHealth?: unknown }).deliveryHealth ?? {};
      // The revision the run ran, and what its words may have come from.
      const provenance = this.routines.get(scope, run.routineId, run.revision).revision.provenance;
      const provenanceNote = routineProvenanceLine(provenance);
      const published = publication.get(scope, runId);
      const report = published === undefined ? undefined : this.#reportText(scope.workspaceId, run, published.reportArtifactId);
      return {
        run,
        ...(provenance === undefined ? {} : { provenance }),
        ...(provenanceNote === undefined ? {} : { provenanceNote }),
        grant: runs.grantFor(scope, runId),
        effectivePolicy: runs.effectiveGrantPolicy(scope, runId),
        deliveryHealth: health,
        publication: published ?? null,
        // The report itself, as text (what a text delivery sends): the chat that previewed the run can say what it found.
        ...(report === undefined ? {} : { report }),
        deliveries: delivery.list(scope, runId),
        attempts: this.routines.store.handle
          .prepare(
            "SELECT attempt_id,generation,owner_epoch,status,started_at,ended_at,heartbeat_at FROM tavi_routine_attempts WHERE run_id=? ORDER BY generation DESC LIMIT 100",
          )
          .all(runId),
      };
    }
    if (input.action === "retry_delivery") {
      const job = delivery.resend(
        scope,
        required(input.jobId, "Delivery id"),
        required(input.operationKey, "Operation key"),
        input.acknowledgeDuplicateRisk === true,
      );
      this.options.wake();
      return job;
    }
    const routineId = this.resolve(scope, input);
    if (input.action === "get" || input.action === "explain") {
      const detail = this.routines.get(scope, routineId, input.revision);
      const state = this.routines.store.handle.prepare("SELECT * FROM tavi_routine_state WHERE routine_id=?").get(routineId) as {
        state_json: string;
      };
      const data = JSON.parse(state.state_json) as { dedup?: unknown[]; [key: string]: unknown };
      const provenanceNote = routineProvenanceLine(detail.revision.provenance);
      // Pins another author wrote: a run of this revision starts tainted, and the routine page says why.
      const skills = this.routines.store.asPort().repositories.skills;
      const foreignSkills = (detail.revision.snapshot.skills ?? []).flatMap((pin) => {
        const provenance = skills.getVersion(scope.workspaceId, pin.skillId, pin.version)?.provenance;
        if (provenance === undefined || !skillProvenanceForeign(provenance)) return [];
        return [
          { skillId: pin.skillId, version: pin.version, source: provenance.startsWith("chat:") ? ("chat" as const) : ("archive" as const) },
        ];
      });
      return {
        ...detail,
        ...(provenanceNote === undefined ? {} : { provenanceNote }),
        ...(foreignSkills.length === 0 ? {} : { foreignSkills }),
        ...this.topicNotice(detail),
        state: { ...state, state_json: undefined, data: { ...data, dedup: undefined, dedupEntries: data.dedup?.length ?? 0 } },
        schedules: this.routines.store.handle
          .prepare(
            "SELECT s.schedule_id,s.enabled,s.next_run_at,s.last_run_at,s.last_outcome FROM tavi_schedules s JOIN tavi_routine_triggers t ON t.schedule_id=s.schedule_id WHERE t.routine_id=?",
          )
          .all(routineId),
        hostStatus: "Local owner must remain running",
        lastSevenDays: runs.effortSince(scope, routineId, new Date(Date.parse(this.now()) - SEVEN_DAYS_MS).toISOString()),
        deliveryReadiness: this.routines.deliveryReadiness(scope, routineId, detail.revision.revision),
      };
    }
    if (input.action === "revisions") return this.routines.revisions(scope, routineId, input.limit, input.beforeRevision);
    if (input.action === "readiness") return this.readiness(scope, this.resolve(scope, input));
    if (input.action === "history") {
      const runs_ = runs.history(scope, routineId, Math.min(input.limit ?? 50, 100), input.beforeRunId, {
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome as RoutineRunStatus }),
        ...definedOnly({ mode: input.mode, triggerId: input.triggerId, skipReason: input.skipReason }),
      });
      // `triggerId` selects one trigger's history, and `history` applies it in
      // SQL: the page handed back already contains only matching runs, so a second
      // filter here could only ever be a no-op that suggests otherwise.
      return { runs: runs_ };
    }
    if (input.action === "ledger")
      return { events: runs.ledger(scope, routineId, input.afterSequence, Math.min(input.limit ?? 50, 100), input.runId) };
    if (input.action === "detail") return runs.detail(scope, routineId, required(input.detailId, "Detail id"));
    if (input.action === "verify") return runs.verify(scope, routineId);
    if (input.action === "resume_delivery") {
      delivery.resumeTarget(scope, routineId, required(input.targetId, "Target id"));
      this.options.wake();
      return { resumed: true };
    }
    if (input.action === "run" || input.action === "preview") {
      const run = runs.request(
        scope,
        routineId,
        required(input.operationKey, "Operation key"),
        input.action === "preview" ? "preview" : "production",
        input.revision,
        input.override,
      );
      this.options.wake();
      // The revision it runs, and what its words may have come from.
      const provenance = this.routines.get(scope, routineId, run.revision).revision.provenance;
      return provenance === undefined ? run : { ...run, provenance };
    }
    if (input.action === "reevaluate")
      return this.routines.reevaluate(scope, routineId, required(input.expectedVersion, "Expected version"));
    if (["pause", "resume", "archive"].includes(input.action))
      return this.routines.setStatus(
        scope,
        routineId,
        required(input.expectedVersion, "Expected version"),
        input.action === "pause" ? "paused" : input.action === "resume" ? "active" : "archived",
      );
    const edited = this.routines.store.handle.transaction(() => {
      const operationKey = required(input.operationKey ?? input.update?.operationKey, "Operation key");
      // The model's label is not the operation's input: a retry from a later turn is the same change.
      const { modelLabel, ...hashed } = input;
      const commandHash = routineHash({ ...hashed, routineId });
      const previous = this.routines.store.handle
        .prepare("SELECT request_hash,result_json FROM tavi_routine_commands WHERE workspace_id=? AND principal_id=? AND operation_key=?")
        .get(scope.workspaceId, scope.principalId, operationKey) as { request_hash: string; result_json: string } | undefined;
      if (previous !== undefined) {
        if (previous.request_hash !== commandHash) throw new TaviError("CONFLICT", "Operation key was used with different input");
        // The durable row is the immutable revision result; readiness is a
        // *current* health statement and is recomputed on every replay, so a
        // retry can never report a revoked destination as still authorized.
        const replayed = JSON.parse(previous.result_json) as { routineId?: string; revision?: { revision?: number } };
        const replayId = replayed.routineId ?? routineId;
        const replayRevision = replayed.revision?.revision ?? this.routines.get(scope, replayId).revision.revision;
        return { ...replayed, deliveryReadiness: this.routines.deliveryReadiness(scope, replayId, replayRevision) };
      }
      const before = this.routines.get(scope, routineId);
      const prior = before.revision.snapshot;
      let snapshot = prior;
      let name: string | undefined;
      let summary = "Edited routine";
      // What the new revision's words may have come from: what it keeps — the restored revision's on an
      // undo, else the one it replaces — cleared when the person edits the objective or instructions, then
      // joined with the model's call's label under taint.
      let kept: RoutineProvenance | undefined = before.revision.provenance;
      if (input.action === "undo") {
        const restored = this.routines.get(scope, routineId, required(input.revision, "Revision to restore")).revision;
        snapshot = restored.snapshot;
        kept = restored.provenance;
        summary = `Restored revision ${input.revision}`;
      } else if (input.action === "edit") {
        const edit = required(input.edit, "Routine changes");
        const { instructions, name: newName, humanCheckpoints, ...fields } = edit;
        name = newName;
        // The one execution setting an edit may change; the run's budgets stay the revision's.
        const execution = humanCheckpoints === undefined ? prior.execution : { ...prior.execution, humanCheckpoints };
        // An edit names only the report and delivery fields it changes; the rest stay the revision's.
        const report = fields.report === undefined ? prior.report : patchedReport(prior.report, fields.report);
        const delivery = fields.delivery === undefined ? prior.delivery : patchedDelivery(prior.delivery, fields.delivery);
        // The merged sections are judged whole: a window narrower than the lookback is refused here, not saved.
        const merged = RoutineSnapshotSchema.safeParse({ ...prior, ...fields, report, delivery, execution, skills: prior.skills });
        if (!merged.success) throw new TaviError("INVALID_INPUT", `Routine changes: ${zodIssues(merged.error, "routine").join("; ")}`);
        snapshot = RoutineSnapshotSchema.parse({
          ...merged.data,
          // Named by id, pinned to the exact version and hash the revision keeps.
          skills: fields.skills === undefined ? prior.skills : this.routines.resolveSkillPins(scope, fields.skills),
          agent:
            instructions === undefined
              ? prior.agent
              : this.routines.createAgentRevision(scope, { agentId: prior.agent.agentId, name: prior.agent.name, instructions }, true),
        });
        summary = `Changed ${Object.keys(edit).join(", ")}`;
      } else if (input.action === "update") {
        const update = required(input.update, "Revision update");
        snapshot = update.snapshot;
        name = update.name;
        summary = update.changeSummary;
      } else throw new TaviError("UNSUPPORTED", "Unsupported routine action");
      const personRewrote =
        modelLabel === undefined &&
        input.action !== "undo" &&
        (snapshot.objective !== prior.objective || snapshot.agent.instructions !== prior.agent.instructions);
      const provenance = joinMemoryProvenance(personRewrote ? undefined : kept, memoryProvenanceOf(modelLabel));
      const detail = this.routines.update(
        scope,
        {
          routineId,
          operationKey: required(input.operationKey ?? input.update?.operationKey, "Operation key"),
          // Checked against the revision it was read from, else the version; a change naming neither is refused.
          ...definedOnly(
            input.action === "update"
              ? { expectedVersion: input.update?.expectedVersion, expectedRevision: input.update?.expectedRevision }
              : { expectedVersion: input.expectedVersion, expectedRevision: input.expectedRevision },
          ),
          ...(name === undefined ? {} : { name }),
          snapshot,
          changeSummary: summary,
        },
        provenance ?? null,
      );
      this.link(scope, input.conversationId, routineId);
      // The edit response says whether a pinned destination is currently
      // unauthorized, so an unrelated edit succeeds *and* reports the block
      // rather than hiding it.
      const changes = changedSections(prior, snapshot);
      const durable = { ...detail, changes, previousRevision: before.revision.revision };
      const result: RoutineEditResult = {
        ...durable,
        deliveryReadiness: this.routines.deliveryReadiness(scope, routineId, detail.revision.revision),
      };
      this.routines.store.handle
        .prepare("INSERT INTO tavi_routine_commands VALUES (?,?,?,?,?)")
        .run(scope.workspaceId, scope.principalId, operationKey, commandHash, canonicalRoutineJson(durable));
      return result;
    })();
    this.options.wake();
    return edited;
  }
}
