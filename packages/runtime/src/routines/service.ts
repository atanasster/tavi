import type { RoutineServicePort } from "../persistence/internal-contracts.js";
import { z } from "zod";
import {
  MemoryProvenanceSchema,
  joinMemoryProvenance,
  routineDefaults,
  unreadableMemoryProvenance,
  memoryProvenanceUntrusted,
  type RoutineProvenance,
  unsupportedRoutinePolicy,
  RoutineCreateSchema,
  type RoutineSkillPinInput,
  RoutineDeliveryTargetSchema,
  RoutineTriggerSchema,
  RoutineScopeSchema,
  RoutineSnapshotSchema,
  RoutineUpdateSchema,
  ROUTINE_STATUSES,
  TaviError,
  type RoutineCreateInput,
  type RoutineDeliveryTarget,
  type RoutineDetail,
  type RoutineEvaluation,
  type RoutineRecord,
  type RoutineRevision,
  type RoutineDeliveryReadiness,
  type RoutineListRow,
  type RoutineListTrigger,
  type RoutineRevisionPage,
  type RoutineScope,
  type RoutineSnapshot,
  type RoutineStandingAnswer,
  type RoutineTrigger,
  type RoutineUpdateInput,
  parseOrThrow,
  isBuiltinRoutineTemplate,
  routineDeliveryWindowNotice,
  localDateTime,
  routineTriggerEnds,
  routineTriggerSpec,
  type MissedRunPolicy,
  type ScheduleSpec,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { prefixedId, sha256Hex } from "@tavi/node-kit";
import type { SqliteStore } from "../persistence/store.js";

export function canonicalRoutineJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TaviError("INVALID_INPUT", "Value is not JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalRoutineJson(item === undefined ? null : item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalRoutineJson(object[key])}`)
    .join(",")}}`;
}
export const routineHash = (value: unknown): string => sha256Hex(canonicalRoutineJson(value));
const routineRow = z.object({
  routine_id: z.string(),
  workspace_id: z.string(),
  principal_id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  active_revision: z.number().nullable(),
  latest_revision: z.number(),
  status: z.enum(ROUTINE_STATUSES),
  conversation_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const revisionRow = z.object({
  routine_id: z.string(),
  revision: z.number(),
  snapshot_json: z.string(),
  hash: z.string(),
  author: z.string(),
  change_summary: z.string(),
  created_at: z.string(),
  provenance_json: z.string().nullable().optional(),
});
/** A stored provenance; one that no longer parses reads as untrusted `unknown-source` (fail safe). */
function storedRoutineProvenance(json: string | null | undefined): RoutineProvenance | undefined {
  if (json === null || json === undefined) return undefined;
  try {
    const parsed = MemoryProvenanceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : unreadableMemoryProvenance();
  } catch {
    return unreadableMemoryProvenance();
  }
}
const evaluationRow = z.object({
  evaluation_id: z.string(),
  routine_id: z.string(),
  revision: z.number(),
  status: z.enum(["pending", "running", "passed", "failed"]),
  detail: z.string(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

/**
 * What a routine trigger's schedule row says, for `tavi schedules list` and
 * `show`: a recurring trigger's own cadence, a one-off's date and minute in
 * the routine's zone. The routine claims its own fires, so the row only reads
 * back when they are.
 */
function routineScheduleSpec(trigger: RoutineTrigger, timezone: string): ScheduleSpec {
  if (trigger.kind !== "once") return routineTriggerSpec(trigger) ?? { at: "00:00", timezone };
  const local = localDateTime(new Date(trigger.runAt), timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return { once: `${String(local.year)}-${pad(local.month)}-${pad(local.day)}`, at: `${pad(local.hour)}:${pad(local.minute)}`, timezone };
}
/** The schedule policy a routine's catch-up reads as: none is `skip`; any is a catch-up the routine bounds by its own hours. */
function routineMissedRunPolicy(snapshot: RoutineSnapshot): MissedRunPolicy {
  return snapshot.execution.catchUpHours === 0 ? "skip" : "run-once-if-missed-within-6h";
}
function invalid(message: string): never {
  throw new TaviError("INVALID_INPUT", message);
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return parseOrThrow(schema, value, (issues) => issues.join("; "));
}
function refuseDeferredPolicies(value: unknown): void {
  const reason = unsupportedRoutinePolicy(value);
  if (reason !== undefined) throw new TaviError("UNSUPPORTED", reason);
}
function record(row: unknown): RoutineRecord {
  const r = routineRow.parse(row);
  return {
    routineId: r.routine_id,
    workspaceId: r.workspace_id,
    principalId: r.principal_id,
    name: r.name,
    version: r.version,
    activeRevision: r.active_revision,
    latestRevision: r.latest_revision,
    status: r.status,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function revision(row: unknown): RoutineRevision {
  const r = revisionRow.parse(row);
  const provenance = storedRoutineProvenance(r.provenance_json);
  return {
    routineId: r.routine_id,
    revision: r.revision,
    snapshot: RoutineSnapshotSchema.parse(JSON.parse(r.snapshot_json)),
    hash: r.hash,
    author: r.author,
    changeSummary: r.change_summary,
    createdAt: r.created_at,
    ...(provenance === undefined ? {} : { provenance }),
  };
}
function evaluation(row: unknown): RoutineEvaluation {
  const r = evaluationRow.parse(row);
  return {
    evaluationId: r.evaluation_id,
    routineId: r.routine_id,
    revision: r.revision,
    status: r.status,
    detail: r.detail,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}
export interface RoutineServiceOptions {
  /** Pinned provider bindings by workspace, then by the principal they were resolved for. */
  readonly toolBindings?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  readonly modelBindings?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
  readonly nextOccurrence: (trigger: RoutineTrigger, after: Date) => string | null;
  /** Composition enables this only after installing the routine dispatch path. */
  readonly executionAvailable?: boolean;
  /**
   * A composition seam, not dead code: `tavi` ships no skill-rollout gate of its
   * own, so the pinned-version check above is the whole rule here and a deployment
   * that adds one wires it through this callback. Absent means "no additional
   * rollout state to consult", which is a complete answer rather than a missing one.
   */
  readonly validateSkill?: (scope: RoutineScope, pin: RoutineSnapshot["skills"][number]) => boolean;
  readonly authorizeTarget?: (scope: RoutineScope, target: RoutineDeliveryTarget) => boolean;
}

/** The model calls a run could make under the first routine default; `raiseLegacyModelCalls` moves routines off it. */
const LEGACY_MODEL_CALLS = 5;
/** Today's default (`routineDefaults`), what a routine on the legacy one is raised to. */
const CURRENT_MODEL_CALLS = routineDefaults("UTC").execution.modelCalls;
/** `tavi_meta`: set once the legacy model-call budget was raised, to the routines raised and skipped. */
const LEGACY_MODEL_CALLS_KEY = "routines.model_calls_raised";
/** The author a revision Tavi made itself names in its history. */
const SYSTEM_AUTHOR = "tavi";

/** All mutations run on the owner's application database; never the checkpoint DB. */
/** A routine's name and the models of the revision it runs. */
export interface RoutineModelsInUse {
  readonly routineId: string;
  readonly name: string;
  readonly models: RoutineSnapshot["models"];
}

export class RoutineService implements RoutineServicePort {
  readonly store: SqliteStore;
  readonly options: RoutineServiceOptions;
  constructor(store: SqliteStore, options: RoutineServiceOptions) {
    this.store = store;
    this.options = options;
  }
  /** The service's clock, shared with the evaluation store so both stamp `updated_at` alike. */
  now(): string {
    return this.options.now?.() ?? nowTimestamp();
  }
  private id(prefix: string): string {
    return this.options.newId?.(prefix) ?? prefixedId(prefix);
  }
  private owned(scope: RoutineScope, routineId: string): RoutineRecord {
    parse(RoutineScopeSchema, scope);
    const row = this.store.handle
      .prepare("SELECT * FROM tavi_routines WHERE routine_id = ? AND workspace_id = ? AND principal_id = ?")
      .get(routineId, scope.workspaceId, scope.principalId);
    if (row === undefined) throw new TaviError("NOT_FOUND", "Routine is unavailable in this scope");
    return record(row);
  }
  get(scope: RoutineScope, routineId: string, wanted?: number): RoutineDetail {
    const routine = this.owned(scope, routineId);
    const number = wanted ?? routine.latestRevision;
    const row = this.store.handle
      .prepare("SELECT * FROM tavi_routine_revisions WHERE routine_id = ? AND revision = ?")
      .get(routineId, number);
    if (row === undefined) throw new TaviError("NOT_FOUND", "Routine revision is unavailable");
    return {
      routine,
      revision: revision(row),
      evaluation: evaluation(
        this.store.handle.prepare("SELECT * FROM tavi_routine_evaluations WHERE routine_id = ? AND revision = ?").get(routineId, number),
      ),
    };
  }
  /**
   * The principal a routine belongs to in a workspace, named by the routine, a
   * run of it, or a delivery job of such a run — so a front end that lists a
   * workspace's routines can address one without knowing whose it is.
   */
  ownerOf(workspaceId: string, ref: { readonly routineId?: string; readonly runId?: string; readonly jobId?: string }): string | undefined {
    const row =
      ref.routineId !== undefined
        ? this.store.handle
            .prepare("SELECT principal_id FROM tavi_routines WHERE routine_id = ? AND workspace_id = ?")
            .get(ref.routineId, workspaceId)
        : ref.runId !== undefined
          ? this.store.handle
              .prepare(
                "SELECT a.principal_id FROM tavi_routine_runs r JOIN tavi_routines a ON a.routine_id = r.routine_id WHERE r.run_id = ? AND a.workspace_id = ?",
              )
              .get(ref.runId, workspaceId)
          : ref.jobId !== undefined
            ? this.store.handle
                .prepare(
                  "SELECT a.principal_id FROM tavi_routine_delivery_jobs j JOIN tavi_routine_runs r ON r.run_id = j.run_id JOIN tavi_routines a ON a.routine_id = r.routine_id WHERE j.job_id = ? AND a.workspace_id = ?",
                )
                .get(ref.jobId, workspaceId)
            : undefined;
    return (row as { readonly principal_id: string } | undefined)?.principal_id;
  }
  /** Every principal that owns a routine in the workspace — including a person since revoked, whose routines are kept. */
  owners(workspaceId: string): readonly string[] {
    return (
      this.store.handle
        .prepare("SELECT DISTINCT principal_id FROM tavi_routines WHERE workspace_id = ? ORDER BY principal_id")
        .all(workspaceId) as { readonly principal_id: string }[]
    ).map((row) => row.principal_id);
  }
  list(scope: RoutineScope, limit = 100): readonly RoutineRecord[] {
    parse(RoutineScopeSchema, scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid("List limit must be 1–200");
    return this.store.handle
      .prepare("SELECT * FROM tavi_routines WHERE workspace_id = ? AND principal_id = ? ORDER BY updated_at DESC, routine_id LIMIT ?")
      .all(scope.workspaceId, scope.principalId, limit)
      .map(record);
  }
  /**
   * `list` plus each routine's next fire and its triggers, in one query: the
   * current revision's triggers (active, else latest), each marked `consumed`
   * as the trigger table records it, and the earliest `next_run_at` of an
   * enabled, unconsumed trigger schedule. Its provenance joins the current
   * revision's with the latest's: a name or words a tainted chat wrote
   * show as soon as they are saved, before the revision is activated.
   */
  listOverview(scope: RoutineScope, limit = 100): readonly RoutineListRow[] {
    parse(RoutineScopeSchema, scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid("List limit must be 1–200");
    const rows = this.store.handle
      .prepare(`SELECT r.*,
        json_extract(rev.snapshot_json, '$.triggers') AS triggers_json, rev.provenance_json AS provenance_json, latest.provenance_json AS latest_provenance_json,
        (SELECT MIN(s.next_run_at) FROM tavi_routine_triggers t JOIN tavi_schedules s ON s.schedule_id = t.schedule_id
          WHERE t.routine_id = r.routine_id AND t.consumed = 0 AND s.enabled = 1 AND s.next_run_at IS NOT NULL) AS next_run_at,
        (SELECT json_group_object(t.trigger_id, t.consumed) FROM tavi_routine_triggers t WHERE t.routine_id = r.routine_id) AS consumed_json
      FROM tavi_routines r
      LEFT JOIN tavi_routine_revisions rev ON rev.routine_id = r.routine_id AND rev.revision = COALESCE(r.active_revision, r.latest_revision)
      LEFT JOIN tavi_routine_revisions latest ON latest.routine_id = r.routine_id AND latest.revision = r.latest_revision
      WHERE r.workspace_id = ? AND r.principal_id = ? ORDER BY r.updated_at DESC, r.routine_id LIMIT ?`)
      .all(scope.workspaceId, scope.principalId, limit) as ({
      triggers_json: string | null;
      next_run_at: string | null;
      consumed_json: string | null;
      provenance_json: string | null;
      latest_provenance_json: string | null;
    } & Record<string, unknown>)[];
    return rows.map((row) => {
      const consumed = JSON.parse(row.consumed_json ?? "{}") as Record<string, number>;
      const parsedTriggers = z.array(RoutineTriggerSchema).safeParse(JSON.parse(row.triggers_json ?? "[]"));
      const triggers: RoutineListTrigger[] = (parsedTriggers.success ? parsedTriggers.data : []).map((trigger) =>
        consumed[trigger.id] === undefined ? trigger : { ...trigger, consumed: consumed[trigger.id] === 1 },
      );
      const provenance = joinMemoryProvenance(
        storedRoutineProvenance(row.provenance_json),
        storedRoutineProvenance(row.latest_provenance_json),
      );
      return { ...record(row), nextRunAt: row.next_run_at, triggers, ...(provenance === undefined ? {} : { provenance }) };
    });
  }
  /**
   * Each routine's models, in one query: those of the revision it runs (the
   * active one, else the latest, which runs once its check passes). An
   * archived routine runs nothing and is left out; so is a revision this
   * build cannot read.
   */
  modelsInUse(scope: RoutineScope, limit = 100): readonly RoutineModelsInUse[] {
    parse(RoutineScopeSchema, scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid("List limit must be 1–200");
    const rows = this.store.handle
      .prepare(`SELECT r.routine_id, r.name, json_extract(rev.snapshot_json, '$.models') AS models_json
      FROM tavi_routines r
      JOIN tavi_routine_revisions rev ON rev.routine_id = r.routine_id AND rev.revision = COALESCE(r.active_revision, r.latest_revision)
      WHERE r.workspace_id = ? AND r.principal_id = ? AND r.status <> 'archived' ORDER BY r.updated_at DESC, r.routine_id LIMIT ?`)
      .all(scope.workspaceId, scope.principalId, limit) as { routine_id: string; name: string; models_json: string | null }[];
    return rows.flatMap((row) => {
      let stored: unknown;
      try {
        stored = JSON.parse(row.models_json ?? "null");
      } catch {
        return [];
      }
      const models = RoutineSnapshotSchema.shape.models.safeParse(stored);
      return models.success ? [{ routineId: row.routine_id, name: row.name, models: models.data }] : [];
    });
  }
  revisions(scope: RoutineScope, routineId: string, limit = 50, beforeRevision?: number): RoutineRevisionPage {
    this.owned(scope, routineId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("Revision limit must be 1–100");
    if (beforeRevision !== undefined && (!Number.isInteger(beforeRevision) || beforeRevision < 1)) invalid("Invalid revision cursor");
    const rows = this.store.handle
      .prepare(
        "SELECT routine_id, revision, hash, author, change_summary, created_at FROM tavi_routine_revisions WHERE routine_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?",
      )
      .all(routineId, beforeRevision ?? Number.MAX_SAFE_INTEGER, limit + 1) as {
      routine_id: string;
      revision: number;
      hash: string;
      author: string;
      change_summary: string;
      created_at: string;
    }[];
    const items = rows.slice(0, limit).map((row) => ({
      routineId: row.routine_id,
      revision: row.revision,
      hash: row.hash,
      author: row.author,
      changeSummary: row.change_summary,
      createdAt: row.created_at,
    }));
    // A row past the limit means a page was cut, so `items` holds `limit` (≥ 1) of them.
    return { items, nextBeforeRevision: rows.length > limit ? (items.at(-1)?.revision ?? null) : null };
  }
  private replay(scope: RoutineScope, key: string, kind: string, hash: string): RoutineDetail | undefined {
    const row = this.store.handle
      .prepare(
        "SELECT request_hash, routine_id, revision FROM tavi_routine_operations WHERE workspace_id=? AND principal_id=? AND operation_key=? AND kind=?",
      )
      .get(scope.workspaceId, scope.principalId, key, kind) as { request_hash: string; routine_id: string; revision: number } | undefined;
    if (row === undefined) return undefined;
    if (row.request_hash !== hash) throw new TaviError("CONFLICT", "Operation key was already used for different input");
    return this.get(scope, row.routine_id, row.revision);
  }
  /**
   * The skills a create under `operationKey` already pinned, when that create
   * happened: a retry pins what the first try did, so it replays rather than
   * conflicting with itself after the skill's active version moved.
   */
  createdSkillPins(scope: RoutineScope, operationKey: string): RoutineSnapshot["skills"] | undefined {
    const row = this.store.handle
      .prepare(
        "SELECT routine_id, revision FROM tavi_routine_operations WHERE workspace_id=? AND principal_id=? AND operation_key=? AND kind='create'",
      )
      .get(scope.workspaceId, scope.principalId, operationKey) as { routine_id: string; revision: number } | undefined;
    return row === undefined ? undefined : this.get(scope, row.routine_id, row.revision).revision.snapshot.skills;
  }
  private saveOperation(scope: RoutineScope, key: string, kind: string, hash: string, routineId: string, number: number): void {
    this.store.handle
      .prepare("INSERT INTO tavi_routine_operations VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(scope.workspaceId, scope.principalId, key, kind, hash, routineId, number);
  }
  /**
   * Reference integrity for every object a snapshot pins.
   *
   * This is deliberately *not* the authority check. A pin the store cannot
   * describe at all makes the revision unreadable and is refused; whether a
   * destination is currently authorized is delivery health, which is reported
   * (see `deliveryReadiness`) rather than turned into a failure of an unrelated
   * edit.
   */
  private checkReferences(scope: RoutineScope, snapshot: RoutineSnapshot): void {
    const pin = snapshot.agent;
    const agent = this.store.handle
      .prepare(
        "SELECT name, instructions, hash FROM tavi_agent_revisions WHERE workspace_id=? AND principal_id=? AND agent_id=? AND revision=?",
      )
      .get(scope.workspaceId, scope.principalId, pin.agentId, pin.revision) as
      | { name: string; instructions: string; hash: string }
      | undefined;
    if (agent === undefined || agent.hash !== pin.hash || agent.instructions !== pin.instructions || agent.name !== pin.name)
      invalid("Agent revision does not match its saved snapshot");
    for (const skill of snapshot.skills) {
      const version = this.store.asPort().repositories.skills.getVersion(scope.workspaceId, skill.skillId, skill.version);
      if (
        version?.scopeKey !== scope.workspaceId ||
        version.reviewState !== "approved" ||
        version.contentHash !== skill.hash ||
        this.options.validateSkill?.(scope, skill) === false
      )
        invalid(`Skill version ${skill.skillId}/${skill.version} is unavailable or unapproved`);
    }
    // A target row that does not exist is not "unauthorized": the revision
    // genuinely cannot be described, so it is refused even on an edit that
    // retains it. Target *removal* is always available as the repair.
    for (const targetId of snapshot.delivery.targetIds) this.describeTarget(scope, targetId);
  }
  /**
   * Whether this change introduces or alters a destination.
   *
   * A destination the revision already named and still names is retained, not
   * authorized: an operator editing the objective or the schedule must not be
   * blocked because a pinned chat is currently unreachable. Creating, adding,
   * replacing or re-enabling a destination still requires current authorization,
   * and a missing authorizer is never allow-all.
   */
  private checkTargetAuthority(scope: RoutineScope, snapshot: RoutineSnapshot, retaining?: RoutineSnapshot): void {
    for (const targetId of snapshot.delivery.targetIds) {
      const target = this.rawTarget(scope, targetId);
      // `checkReferences` already refused an absent row.
      if (target === undefined) continue;
      // A destination the previous revision already named is *retained*, not
      // introduced: an objective or schedule edit must not be held hostage by a
      // chat that is currently unreachable. Its authorization is re-checked at
      // dispatch, where it is the delivery effect's own problem.
      if (retaining !== undefined && retaining.delivery.targetIds.includes(targetId)) continue;
      if (target.enabled !== true || this.options.authorizeTarget?.(scope, target) !== true)
        throw new TaviError("NOT_AUTHORIZED", "Delivery target must be explicitly authorized in this scope");
    }
  }
  /** The pinned target row, without an authority judgment; `undefined` when it is absent. */
  private rawTarget(scope: RoutineScope, targetId: string): RoutineDeliveryTarget | undefined {
    const row = this.store.handle
      .prepare("SELECT target_json FROM tavi_routine_delivery_targets WHERE target_id=? AND workspace_id=? AND principal_id=?")
      .get(targetId, scope.workspaceId, scope.principalId) as { target_json: string } | undefined;
    return row === undefined ? undefined : RoutineDeliveryTargetSchema.parse(JSON.parse(row.target_json));
  }
  private describeTarget(scope: RoutineScope, targetId: string): RoutineDeliveryTarget {
    const target = this.rawTarget(scope, targetId);
    if (target === undefined) throw new TaviError("NOT_FOUND", "Delivery target is unavailable in this scope");
    return target;
  }
  /** Reference integrity plus authority for anything this revision introduces. */
  private checkPins(scope: RoutineScope, snapshot: RoutineSnapshot, retaining?: RoutineSnapshot): void {
    this.checkReferences(scope, snapshot);
    this.checkTargetAuthority(scope, snapshot, retaining);
  }
  /**
   * Per-target delivery readiness, for the edit response and the overview.
   *
   * `problem: null` means the destination is enabled and currently authorized.
   * A trigger that fires outside the delivery window, whose report would stay in
   * the app, is said beside it (`windowNotice`).
   * Nothing here is a model call or a send.
   */
  deliveryReadiness(scope: RoutineScope, routineId: string, at?: number): readonly RoutineDeliveryReadiness[] {
    const revision = this.get(scope, routineId, at ?? this.owned(scope, routineId).latestRevision).revision;
    const authorize = this.options.authorizeTarget;
    const notice = routineDeliveryWindowNotice(revision.snapshot, new Date(this.now()));
    const told = notice === undefined ? {} : { windowNotice: notice };
    return revision.snapshot.delivery.targetIds.map((targetId) => {
      const target = this.rawTarget(scope, targetId);
      if (target === undefined)
        return { targetId, revision: revision.revision, enabled: false, authorized: false, problem: "missing" as const, ...told };
      // A construction with no authorizer cannot decide, and must not answer as
      // if it had decided against: "unverifiable" is a different statement from
      // "revoked", and an operator reads them differently.
      if (authorize === undefined)
        return {
          targetId,
          revision: revision.revision,
          enabled: target.enabled,
          authorized: false,
          problem: "unverifiable" as const,
          ...told,
        };
      const authorized = authorize(scope, target) === true;
      return {
        targetId,
        revision: revision.revision,
        enabled: target.enabled,
        authorized,
        problem: !target.enabled ? ("disabled" as const) : !authorized ? ("unauthorized" as const) : null,
        ...told,
      };
    });
  }
  private saveRevision(
    scope: RoutineScope,
    routineId: string,
    number: number,
    snapshot: RoutineSnapshot,
    summary: string,
    now: string,
    retaining?: RoutineSnapshot,
    provenance?: RoutineProvenance,
    /** Who the revision's history names: the person, or `tavi` for one Tavi made itself. */
    author: string = scope.principalId,
  ): void {
    this.checkPins(scope, snapshot, retaining);
    // A plugin's template is copied in by the owner as it saves the revision: one without it would run as nothing.
    if (!isBuiltinRoutineTemplate(snapshot.report.templateVersion) && snapshot.report.template === undefined)
      throw new TaviError(
        "NOT_FOUND",
        `No routine template ${snapshot.report.templateVersion} is installed: the plugin that provides it must be enabled on a running owner`,
      );
    if (this.options.modelBindings !== undefined) {
      snapshot = structuredClone(snapshot);
      for (const policy of [snapshot.models.research, snapshot.models.synthesis]) {
        for (const target of [policy.primary, ...policy.fallbacks]) {
          const pinned = this.options.modelBindings[scope.workspaceId]?.[scope.principalId];
          const hash = pinned?.[target.connectionId] ?? pinned?.["*"];
          // Unavailable targets can remain in a fallback policy. They gain no
          // binding and cannot become callable without a new reviewed revision.
          if (hash === undefined) continue;
          if (target.bindingHash !== undefined && target.bindingHash !== hash)
            throw new TaviError("NOT_AUTHORIZED", "Routine model binding changed; select and review it again");
          target.bindingHash = hash;
        }
      }
    }
    const available = this.options.toolBindings?.[scope.workspaceId]?.[scope.principalId];
    if (available !== undefined) {
      snapshot = structuredClone(snapshot);
      const pins: Record<string, string> = {};
      for (const tool of snapshot.permissions.researchTools) {
        const hash = available[tool];
        const previous = snapshot.permissions.providerBindings?.[tool];
        if (previous !== undefined && previous !== hash)
          throw new TaviError("NOT_AUTHORIZED", "Routine web provider changed; review its configuration again");
        if (hash !== undefined) pins[tool] = hash;
      }
      snapshot.permissions.providerBindings = pins;
    }
    // Only an untrusted provenance is stored: absent is the one encoding of clean.
    const stamped = memoryProvenanceUntrusted(provenance) ? JSON.stringify(provenance) : null;
    this.store.handle
      .prepare(
        "INSERT INTO tavi_routine_revisions (routine_id, revision, snapshot_json, hash, author, change_summary, created_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(routineId, number, canonicalRoutineJson(snapshot), routineHash(snapshot), author, summary, now, stamped);
    this.store.handle
      .prepare("INSERT INTO tavi_routine_evaluations VALUES (?, ?, ?, 'pending', '', ?, NULL)")
      .run(this.id("evaluation"), routineId, number, now);
  }
  /** `provenance`: the model's call's under taint, stamped on revision 1. */
  create(scope: RoutineScope, raw: RoutineCreateInput, provenance?: RoutineProvenance): RoutineDetail {
    parse(RoutineScopeSchema, scope);
    refuseDeferredPolicies(raw);
    const input = parse(RoutineCreateSchema, raw);
    const hash = routineHash(input);
    return this.store.handle.transaction(() => {
      const replay = this.replay(scope, input.operationKey, "create", hash);
      if (replay !== undefined) return replay;
      const now = this.now();
      const agent = this.createAgentRevision(scope, input.agent, false);
      const snapshot = parse(RoutineSnapshotSchema, {
        objective: input.objective,
        agent,
        triggers: input.triggers,
        skills: input.skills,
        models: input.models,
        report: input.report,
        delivery: input.delivery,
        execution: input.execution,
        permissions: input.permissions,
        retention: input.retention,
        ...(input.folder === undefined ? {} : { folder: input.folder }),
      });
      const routineId = this.id("routine");
      this.store.handle
        .prepare("INSERT INTO tavi_routines VALUES (?, ?, ?, ?, 1, NULL, 1, 'draft', ?, ?, ?)")
        .run(routineId, scope.workspaceId, scope.principalId, input.name, input.conversationId ?? null, now, now);
      this.saveRevision(scope, routineId, 1, snapshot, "Created routine", now, undefined, provenance);
      // The shape its readers expect: `news.ts` reads
      // `state.coverage?.to` as an instant, so the first run's fallback window
      // takes the documented branch rather than depending on `undefined`.
      this.store.handle
        .prepare("INSERT INTO tavi_routine_state(routine_id,version,state_json) VALUES (?, 1, ?)")
        .run(routineId, canonicalRoutineJson({ dedup: [], coverage: { to: null } }));
      this.syncSchedules(scope, routineId, snapshot, false, now);
      this.saveOperation(scope, input.operationKey, "create", hash, routineId, 1);
      return this.get(scope, routineId);
    })();
  }
  /**
   * Once per data directory: every routine still on the first default of 5 model calls a run gets a revision with
   * 12, the default since, made by `tavi`. Research holds one call back for synthesis, and a model that searches one
   * query a turn ran out at 4. The revision changes nothing a quality pass is keyed to, so it activates from the cached
   * pass with no model call, or is evaluated if there is none. Left as they are: archived routines, a routine whose
   * latest revision failed its quality check (a copy would only be checked again, at a cost nobody asked for), and
   * one today's rules would refuse to save. Recorded in `tavi_meta` with what was raised and skipped, so a routine
   * set to 5 afterwards keeps it. Returns how many routines were raised.
   */
  raiseLegacyModelCalls(): number {
    return this.store.transactionImmediate(() => {
      if (this.store.handle.prepare("SELECT 1 FROM tavi_meta WHERE key = ?").get(LEGACY_MODEL_CALLS_KEY) !== undefined) return 0;
      const rows = this.store.handle
        .prepare("SELECT routine_id, workspace_id, principal_id FROM tavi_routines WHERE status <> 'archived' ORDER BY routine_id")
        .all() as { routine_id: string; workspace_id: string; principal_id: string }[];
      const raised: string[] = [];
      const skipped: string[] = [];
      for (const row of rows) {
        const scope = { workspaceId: row.workspace_id, principalId: row.principal_id };
        const { routine, revision, evaluation } = this.get(scope, row.routine_id);
        if (revision.snapshot.execution.modelCalls !== LEGACY_MODEL_CALLS) continue;
        if (evaluation?.status === "failed") {
          skipped.push(routine.routineId);
          continue;
        }
        try {
          this.update(
            scope,
            {
              routineId: routine.routineId,
              operationKey: `raise-model-calls-${routine.routineId}`,
              expectedRevision: routine.latestRevision,
              snapshot: { ...revision.snapshot, execution: { ...revision.snapshot.execution, modelCalls: CURRENT_MODEL_CALLS } },
              changeSummary: `Model calls a run may make raised from ${LEGACY_MODEL_CALLS} to ${CURRENT_MODEL_CALLS}, the new default, so research that searches one query a turn has room to finish.`,
            },
            undefined,
            SYSTEM_AUTHOR,
          );
          raised.push(routine.routineId);
        } catch (error) {
          // Only today's refusal of this routine's revision is skipped; a database failure fails the whole raise.
          if (!(error instanceof TaviError)) throw error;
          skipped.push(routine.routineId);
        }
      }
      this.store.handle
        .prepare("INSERT INTO tavi_meta (key, value, updated_at) VALUES (?, ?, ?)")
        .run(LEGACY_MODEL_CALLS_KEY, canonicalRoutineJson({ raised, skipped }), this.now());
      return raised.length;
    });
  }
  /**
   * `provenance`: what the new revision carries, as the control service worked it out; `null` clears
   * it (the person rewrote the routine's words). Absent, the revision keeps the one it replaces.
   */
  update(
    scope: RoutineScope,
    raw: RoutineUpdateInput,
    provenance?: RoutineProvenance | null,
    /** Who the revision's history names; the person by default. */
    author?: string,
  ): RoutineDetail {
    parse(RoutineScopeSchema, scope);
    refuseDeferredPolicies(raw);
    const input = parse(RoutineUpdateSchema, raw);
    const hash = routineHash(input);
    return this.store.handle.transaction(() => {
      const replay = this.replay(scope, input.operationKey, `update:${input.routineId}`, hash);
      if (replay !== undefined) return replay;
      const current = this.owned(scope, input.routineId);
      if (current.status === "archived") invalid("Archived routines cannot be edited");
      // A revision read against is checked alone: an evaluation finishing bumps the version and saves no revision.
      if (input.expectedRevision !== undefined) {
        if (current.latestRevision !== input.expectedRevision)
          throw new TaviError(
            "CONFLICT",
            `Routine has revision ${current.latestRevision} now, not ${input.expectedRevision}; read it again before editing`,
          );
      } else if (input.expectedVersion === undefined) invalid("An edit names the revision or version it was read against");
      else if (current.version !== input.expectedVersion) throw new TaviError("CONFLICT", "Routine changed; refresh before editing");
      const number = current.latestRevision + 1;
      const now = this.now();
      const replaced = this.get(scope, current.routineId).revision;
      this.saveRevision(
        scope,
        current.routineId,
        number,
        input.snapshot,
        input.changeSummary,
        now,
        replaced.snapshot,
        provenance === undefined ? replaced.provenance : (provenance ?? undefined),
        author,
      );
      this.store.handle
        .prepare("UPDATE tavi_routines SET latest_revision=?, version=version+1, name=?, updated_at=? WHERE routine_id=?")
        .run(number, input.name ?? current.name, now, current.routineId);
      this.saveOperation(scope, input.operationKey, `update:${input.routineId}`, hash, current.routineId, number);
      return this.get(scope, current.routineId);
    })();
  }
  /**
   * Skills as a person or the model names them, as the exact pins a revision
   * keeps: an omitted version is the skill's active one in the workspace, an
   * omitted hash that version's own content hash. Only an approved version is
   * pinned, and a hash given must be the version's.
   */
  resolveSkillPins(scope: RoutineScope, pins: readonly RoutineSkillPinInput[]): RoutineSnapshot["skills"] {
    parse(RoutineScopeSchema, scope);
    const skills = this.store.asPort().repositories.skills;
    return pins.map((pin) => {
      const version = pin.version ?? skills.getActivation(scope.workspaceId, pin.skillId)?.activeVersion;
      if (version === undefined) invalid(`Skill ${pin.skillId} has no active version: name one, or activate it first`);
      const stored = skills.getVersion(scope.workspaceId, pin.skillId, version);
      if (stored?.scopeKey !== scope.workspaceId || stored.reviewState !== "approved")
        invalid(`Skill version ${pin.skillId}/${version} is unavailable or unapproved`);
      if (pin.hash !== undefined && pin.hash !== stored.contentHash)
        invalid(`Skill version ${pin.skillId}/${version} does not have the hash given`);
      return { skillId: pin.skillId, version, hash: stored.contentHash };
    });
  }
  createAgentRevision(scope: RoutineScope, input: RoutineCreateInput["agent"], allowNewInstructions: boolean): RoutineSnapshot["agent"] {
    parse(RoutineScopeSchema, scope);
    const agent = parse(RoutineCreateSchema.shape.agent, input);
    return this.store.handle.transaction(() => {
      const repository = this.store.asPort().repositories.agents;
      const definition = repository.get(scope.workspaceId, agent.agentId);
      if (definition !== undefined && definition.systemPrompt !== agent.instructions && !allowNewInstructions)
        throw new TaviError("CONFLICT", "Existing agent has different instructions; choose a new id or explicitly create a revision");
      const hash = routineHash({ name: agent.name, instructions: agent.instructions });
      const previous = this.store.handle
        .prepare(
          "SELECT revision, hash FROM tavi_agent_revisions WHERE workspace_id=? AND principal_id=? AND agent_id=? ORDER BY revision DESC LIMIT 1",
        )
        .get(scope.workspaceId, scope.principalId, agent.agentId) as { revision: number; hash: string } | undefined;
      if (previous?.hash === hash) return { ...agent, revision: previous.revision, hash };
      const number = (previous?.revision ?? 0) + 1;
      const now = this.now();
      if (definition === undefined)
        repository.create({
          agentId: agent.agentId,
          workspaceId: scope.workspaceId,
          name: agent.name,
          systemPrompt: agent.instructions,
          enabled: true,
          now,
        });
      this.store.handle
        .prepare("INSERT INTO tavi_agent_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(scope.workspaceId, scope.principalId, agent.agentId, number, agent.name, agent.instructions, hash, scope.principalId, now);
      // Existing live personas remain unchanged; routines bind this immutable pin.
      return { ...agent, revision: number, hash };
    })();
  }
  /**
   * Arm (or disarm) the schedule of each of the snapshot's triggers. An ending
   * trigger with no fire left when it is armed — an `until` or a one-off that
   * passed while the routine was paused or being edited — is consumed here, as
   * its last claim would have consumed it. Returns whether the routine is armed
   * with nothing left to fire.
   */
  private syncSchedules(scope: RoutineScope, routineId: string, snapshot: RoutineSnapshot, enabled: boolean, now: string): boolean {
    const schedules = this.store.asPort().repositories.schedules;
    const existing = this.store.handle
      .prepare("SELECT trigger_id, schedule_id, spec_json, consumed FROM tavi_routine_triggers WHERE routine_id=?")
      .all(routineId) as { trigger_id: string; schedule_id: string; spec_json: string; consumed: number }[];
    for (const row of existing)
      if (!snapshot.triggers.some((trigger) => trigger.id === row.trigger_id))
        schedules.setEnabled({ scheduleId: row.schedule_id, enabled: false, nextRunAt: null, now });
    for (const trigger of snapshot.triggers) {
      const found = existing.find((row) => row.trigger_id === trigger.id);
      const spec = routineScheduleSpec(trigger, snapshot.execution.timezone);
      const unchanged = found?.spec_json === canonicalRoutineJson(trigger);
      const previous = found === undefined ? undefined : schedules.get(found.schedule_id);
      const nextRunAt = enabled
        ? unchanged && previous?.enabled && previous.nextRunAt !== null
          ? previous.nextRunAt
          : this.options.nextOccurrence(trigger, new Date(now))
        : null;
      const ended = enabled && nextRunAt === null && routineTriggerEnds(trigger);
      if (found === undefined) {
        const scheduleId = this.id("schedule");
        schedules.create({
          scheduleId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          name: `${routineId}/${trigger.id}`,
          prompt: snapshot.objective,
          spec,
          missedRunPolicy: routineMissedRunPolicy(snapshot),
          autoApproveTools: [],
          agentId: snapshot.agent.agentId,
          enabled: enabled && nextRunAt !== null,
          nextRunAt,
          now,
        });
        this.store.handle
          .prepare("INSERT INTO tavi_routine_triggers(routine_id,trigger_id,schedule_id,spec_json,consumed) VALUES (?, ?, ?, ?, ?)")
          .run(routineId, trigger.id, scheduleId, canonicalRoutineJson(trigger), ended ? 1 : 0);
      } else {
        schedules.update({
          scheduleId: found.schedule_id,
          prompt: snapshot.objective,
          spec,
          agentId: snapshot.agent.agentId,
          missedRunPolicy: routineMissedRunPolicy(snapshot),
          now,
        });
        this.store.handle
          .prepare("UPDATE tavi_routine_triggers SET spec_json=?,consumed=? WHERE routine_id=? AND trigger_id=?")
          .run(canonicalRoutineJson(trigger), ended || (unchanged && found.consumed === 1) ? 1 : 0, routineId, trigger.id);
        const consumed = this.store.handle
          .prepare("SELECT consumed FROM tavi_routine_triggers WHERE routine_id=? AND trigger_id=?")
          .get(routineId, trigger.id) as { consumed: number };
        schedules.setEnabled({
          scheduleId: found.schedule_id,
          enabled: consumed.consumed === 0 && enabled && nextRunAt !== null,
          nextRunAt: consumed.consumed === 0 ? nextRunAt : null,
          now,
        });
      }
    }
    return enabled && this.exhausted(routineId, snapshot);
  }
  /** Whether every trigger of `snapshot` has been consumed: the routine has nothing left to fire. */
  private exhausted(routineId: string, snapshot: RoutineSnapshot): boolean {
    const consumed = new Set(
      (
        this.store.handle.prepare("SELECT trigger_id FROM tavi_routine_triggers WHERE routine_id=? AND consumed=1").all(routineId) as {
          trigger_id: string;
        }[]
      ).map((row) => row.trigger_id),
    );
    return snapshot.triggers.every((trigger) => consumed.has(trigger.id));
  }
  /** Internal evaluator completion; deliberately absent from the model/IPC mutation surface. */
  finishEvaluation(scope: RoutineScope, routineId: string, number: number, passed: boolean, detail: string): RoutineDetail {
    if (detail.length > 2000) invalid("Evaluation detail is too long");
    return this.store.handle.transaction(() => {
      const current = this.get(scope, routineId, number);
      if (current.evaluation.status === "passed" || current.evaluation.status === "failed") return current;
      const now = this.now();
      this.store.handle
        .prepare("UPDATE tavi_routine_evaluations SET status=?, detail=?, finished_at=? WHERE evaluation_id=?")
        .run(passed ? "passed" : "failed", detail, now, current.evaluation.evaluationId);
      if (
        !passed &&
        number === current.routine.latestRevision &&
        current.routine.activeRevision === null &&
        !["archived", "paused", "paused-failures"].includes(current.routine.status)
      )
        this.store.handle
          .prepare("UPDATE tavi_routines SET status='draft',version=version+1,updated_at=? WHERE routine_id=?")
          .run(now, routineId);
      if (passed && number === current.routine.latestRevision && current.routine.status !== "archived") {
        // Activation checks references only, never destination authority.
        //
        // Destination authority is decided where a destination *enters* the
        // routine (`create`/`update` refuse an unauthorized introduction) and
        // again at dispatch, immediately before the send. Re-deciding it here
        // would mean a destination that was legitimately authorized when pinned
        // and revoked afterwards blocks activation — a delivery-only problem
        // stopping research, which must never happen —
        // and it would do so inconsistently, since a *later* revision retaining
        // the same target would be allowed. A revoked destination leaves the
        // routine active, is reported by `deliveryReadiness`, and is refused by
        // `target()` when a delivery job reaches dispatch.
        this.checkReferences(scope, current.revision.snapshot);
        const enabled = this.options.executionAvailable === true && !["paused", "paused-failures"].includes(current.routine.status);
        const exhausted = this.syncSchedules(scope, routineId, current.revision.snapshot, enabled, now);
        this.store.handle
          .prepare("UPDATE tavi_routines SET active_revision=?, status=?, version=version+1, updated_at=? WHERE routine_id=?")
          .run(
            number,
            enabled
              ? exhausted
                ? "completed"
                : "active"
              : ["paused", "paused-failures"].includes(current.routine.status)
                ? current.routine.status
                : "setup-needed",
            now,
            routineId,
          );
        // New delivery targets start healthy: the old ones' failures are not theirs.
        const before =
          current.routine.activeRevision === null
            ? undefined
            : this.get(scope, routineId, current.routine.activeRevision).revision.snapshot.delivery.targetIds;
        const after = current.revision.snapshot.delivery.targetIds;
        if (before !== undefined && (before.length !== after.length || before.some((targetId) => !after.includes(targetId))))
          this.resetDeliveryHealth(routineId);
      }
      return this.get(scope, routineId, number);
    })();
  }
  /**
   * Run the latest revision's evaluation again after it failed — a model that
   * was down, an owner restart mid-run, a deadline — without saving a new
   * revision. The row is reset to `pending` for the evaluator's next sweep;
   * a failed quality record for it is dropped, a passed one never is.
   */
  reevaluate(scope: RoutineScope, routineId: string, expectedVersion: number): RoutineDetail {
    return this.store.handle.transaction(() => {
      const current = this.owned(scope, routineId);
      if (current.version !== expectedVersion) throw new TaviError("CONFLICT", "Routine changed; refresh before evaluating again");
      if (current.status === "archived") invalid("Archived routines cannot be evaluated");
      const latest = this.get(scope, routineId, current.latestRevision);
      if (latest.evaluation.status !== "failed") invalid("Only a failed evaluation can be run again");
      const now = this.now();
      this.store.handle
        .prepare("DELETE FROM tavi_routine_quality WHERE evaluation_id=? AND status<>'passed'")
        .run(latest.evaluation.evaluationId);
      this.store.handle
        .prepare("UPDATE tavi_routine_evaluations SET status='pending', detail='', finished_at=NULL, created_at=? WHERE evaluation_id=?")
        .run(now, latest.evaluation.evaluationId);
      this.store.handle.prepare("UPDATE tavi_routines SET version=version+1, updated_at=? WHERE routine_id=?").run(now, routineId);
      return this.get(scope, routineId);
    })();
  }
  setStatus(scope: RoutineScope, routineId: string, expectedVersion: number, status: "paused" | "active" | "archived"): RoutineDetail {
    if (!["paused", "active", "archived"].includes(status)) invalid("Unsupported routine status change");
    return this.store.handle.transaction(() => {
      const current = this.owned(scope, routineId);
      if (current.version !== expectedVersion) throw new TaviError("CONFLICT", "Routine changed; refresh before changing status");
      if (current.status === "archived")
        invalid(status === "archived" ? "Routine is already archived" : "Archived routines cannot be resumed");
      // A completed routine has consumed its triggers: resuming it would
      // show it active with nothing left to fire.
      if (status === "active" && current.status === "completed")
        invalid("A completed routine has no trigger left to run; edit it to add a schedule");
      // Resuming requires an evaluated revision *and* an execution adapter. The
      // offline `tavi schedules` service declares `executionAvailable: true` for
      // this — it is not the executor, the owner is — so an offline `enable` on a
      // routine-owned schedule arms the routine instead of failing.
      if (status === "active" && (current.activeRevision === null || this.options.executionAvailable !== true))
        invalid("Routine requires successful evaluation and execution setup");
      const snapshot = this.get(scope, routineId, current.activeRevision ?? current.latestRevision).revision.snapshot;
      // Resuming does not re-authorize a pinned destination: it re-reads the
      // same references, and delivery dispatch is where authorization is decided.
      if (status === "active") this.checkReferences(scope, snapshot);
      // Resumed with every ending trigger past its last fire, it has nothing left to run: it completes.
      const exhausted = this.syncSchedules(scope, routineId, snapshot, status === "active", this.now());
      if (status === "active" && current.status !== "active")
        this.store.handle
          .prepare(
            "UPDATE tavi_routine_state SET research_failures=0,research_blocked_since=NULL,state_json=json_remove(state_json,'$.pendingAutoPause','$.pendingAutoPauseCause') WHERE routine_id=?",
          )
          .run(routineId);
      // Resuming is also how a person says a broken delivery target is fixed,
      // whether or not research had paused.
      if (status === "active") this.resetDeliveryHealth(routineId);
      this.store.handle
        .prepare("UPDATE tavi_routines SET status=?, version=version+1, updated_at=? WHERE routine_id=?")
        .run(exhausted ? "completed" : status, this.now(), routineId);
      return this.get(scope, routineId);
    })();
  }
  /** Every delivery target of the routine healthy again, and its held deliveries due now. */
  private resetDeliveryHealth(routineId: string): void {
    this.store.handle
      .prepare(
        "UPDATE tavi_routine_state SET delivery_failures=0,delivery_blocked_since=NULL,state_json=json_remove(state_json,'$.deliveryHealth') WHERE routine_id=?",
      )
      .run(routineId);
    this.rearmDeliveries(routineId);
  }
  /**
   * The routine's deferred deliveries — every target's, or one's — due now
   * rather than when their wait ends: a paused target's job waits until it
   * expires, so a resume must bring it back. A job deferred only to the
   * delivery window is deferred to it again by its next claim.
   */
  rearmDeliveries(routineId: string, targetId?: string): void {
    const now = this.now();
    this.store.handle
      .prepare(
        "UPDATE tavi_routine_delivery_jobs SET not_before=? WHERE status='deferred' AND not_before>? AND (? IS NULL OR json_extract(data_json,'$.targetId')=?) AND run_id IN (SELECT run_id FROM tavi_routine_runs WHERE routine_id=?)",
      )
      .run(now, now, targetId ?? null, targetId ?? null, routineId);
  }
  target(scope: RoutineScope, targetId: string): RoutineDeliveryTarget {
    parse(RoutineScopeSchema, scope);
    const row = this.store.handle
      .prepare("SELECT target_json FROM tavi_routine_delivery_targets WHERE target_id=? AND workspace_id=? AND principal_id=?")
      .get(targetId, scope.workspaceId, scope.principalId) as { target_json: string } | undefined;
    if (row === undefined) throw new TaviError("NOT_FOUND", "Delivery target is unavailable in this scope");
    const target = RoutineDeliveryTargetSchema.parse(JSON.parse(row.target_json));
    if (!target.enabled || this.options.authorizeTarget?.(scope, target) !== true)
      throw new TaviError("NOT_AUTHORIZED", "Delivery target authorization is unavailable or revoked");
    return target;
  }
  /** The routine's standing answers, newest first. */
  standingAnswers(scope: RoutineScope, routineId: string): readonly RoutineStandingAnswer[] {
    this.get(scope, routineId);
    return (
      this.store.handle
        .prepare(
          "SELECT question_key, question, answers_json, created_by, created_at FROM tavi_routine_standing_answers WHERE routine_id=? ORDER BY created_at DESC, question_key LIMIT 100",
        )
        .all(routineId) as { question_key: string; question: string; answers_json: string; created_by: string; created_at: string }[]
    ).map((row) => ({
      questionKey: row.question_key,
      question: row.question,
      answers: z.array(z.string()).parse(JSON.parse(row.answers_json)),
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }
  /** The standing answer for a question under `questionKey`, if the operator gave one. */
  standingAnswerFor(
    scope: RoutineScope,
    routineId: string,
    questionKey: string,
  ): { readonly answers: readonly string[]; readonly by: string } | undefined {
    this.get(scope, routineId);
    const row = this.store.handle
      .prepare("SELECT answers_json, created_by FROM tavi_routine_standing_answers WHERE routine_id=? AND question_key=?")
      .get(routineId, questionKey) as { answers_json: string; created_by: string } | undefined;
    return row === undefined ? undefined : { answers: z.array(z.string()).parse(JSON.parse(row.answers_json)), by: row.created_by };
  }
  putStandingAnswer(scope: RoutineScope, routineId: string, answer: RoutineStandingAnswer): RoutineStandingAnswer {
    this.get(scope, routineId);
    this.store.handle
      .prepare(
        "INSERT INTO tavi_routine_standing_answers VALUES (?,?,?,?,?,?) ON CONFLICT(routine_id, question_key) DO UPDATE SET question=excluded.question, answers_json=excluded.answers_json, created_by=excluded.created_by, created_at=excluded.created_at",
      )
      .run(routineId, answer.questionKey, answer.question, JSON.stringify(answer.answers), answer.createdBy, answer.createdAt);
    return answer;
  }
  removeStandingAnswer(scope: RoutineScope, routineId: string, questionKey: string): boolean {
    this.get(scope, routineId);
    return (
      this.store.handle
        .prepare("DELETE FROM tavi_routine_standing_answers WHERE routine_id=? AND question_key=?")
        .run(routineId, questionKey).changes > 0
    );
  }
  putTarget(scope: RoutineScope, raw: RoutineDeliveryTarget): RoutineDeliveryTarget {
    parse(RoutineScopeSchema, scope);
    const target = parse(RoutineDeliveryTargetSchema, raw);
    if (
      target.workspaceId !== scope.workspaceId ||
      target.principalId !== scope.principalId ||
      this.options.authorizeTarget?.(scope, target) !== true
    )
      throw new TaviError("NOT_AUTHORIZED", "Delivery target must be explicitly authorized in this scope");
    // Immutable address: editing a destination creates another target ID.
    const previous = this.store.handle
      .prepare("SELECT target_json FROM tavi_routine_delivery_targets WHERE target_id=?")
      .get(target.targetId) as { target_json: string } | undefined;
    if (previous !== undefined) {
      if (previous.target_json !== canonicalRoutineJson(target))
        throw new TaviError("CONFLICT", "Target id already names a different destination");
      return target;
    }
    this.store.handle
      .prepare("INSERT INTO tavi_routine_delivery_targets VALUES (?, ?, ?, ?)")
      .run(target.targetId, scope.workspaceId, scope.principalId, canonicalRoutineJson(target));
    return target;
  }
  scheduleOwner(scheduleId: string): { routineId: string; triggerId: string } | undefined {
    const row = this.store.handle.prepare("SELECT routine_id,trigger_id FROM tavi_routine_triggers WHERE schedule_id=?").get(scheduleId) as
      | { routine_id: string; trigger_id: string }
      | undefined;
    return row === undefined ? undefined : { routineId: row.routine_id, triggerId: row.trigger_id };
  }
  /** `scheduleOwner` for each id, in their order, in one read: a listing of many schedules asks once. */
  scheduleOwners(scheduleIds: readonly string[]): readonly ({ routineId: string; triggerId: string } | undefined)[] {
    if (scheduleIds.length === 0) return [];
    const rows = this.store.handle
      .prepare("SELECT schedule_id,routine_id,trigger_id FROM tavi_routine_triggers WHERE schedule_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(scheduleIds)) as { schedule_id: string; routine_id: string; trigger_id: string }[];
    const owners = new Map(rows.map((row) => [row.schedule_id, { routineId: row.routine_id, triggerId: row.trigger_id }]));
    return scheduleIds.map((scheduleId) => owners.get(scheduleId));
  }
  consumeOneOff(scope: RoutineScope, routineId: string, triggerId: string): void {
    this.store.handle.transaction(() => {
      const current = this.owned(scope, routineId);
      const row = this.store.handle
        .prepare("SELECT schedule_id,spec_json FROM tavi_routine_triggers WHERE routine_id=? AND trigger_id=?")
        .get(routineId, triggerId) as { schedule_id: string; spec_json: string } | undefined;
      if (row === undefined || !routineTriggerEnds(JSON.parse(row.spec_json) as RoutineTrigger)) invalid("Trigger is not a one-off");
      const consumed = this.store.handle
        .prepare("UPDATE tavi_routine_triggers SET consumed=1 WHERE routine_id=? AND trigger_id=? AND consumed=0")
        .run(routineId, triggerId);
      if (consumed.changes === 0) return;
      this.store
        .asPort()
        .repositories.schedules.setEnabled({ scheduleId: row.schedule_id, enabled: false, nextRunAt: null, now: this.now() });
      // **A routine completes only by exhausting its triggers that end**: its
      // one-offs, and recurring ones whose `until` has passed. A routine with an
      // open-ended recurring trigger therefore never reaches `completed`: it stays `active`
      // until an operator pauses or archives it. That is intended, and it
      // is stated here and in `docs/AUTOMATION.md` so it is a documented rule rather than
      // behaviour an operator has to infer from a status that never changes.
      if (this.exhausted(routineId, this.get(scope, routineId, current.activeRevision ?? current.latestRevision).revision.snapshot))
        this.store.handle
          .prepare("UPDATE tavi_routines SET status='completed',version=version+1,updated_at=? WHERE routine_id=?")
          .run(this.now(), routineId);
    })();
  }
}
