import { z } from "zod";
import {
  TOOL_LABEL_KEY,
  TRUSTED_PUBLIC,
  type InvocationContext,
  joinMemoryProvenance,
  memoryProvenanceLabel,
  memoryProvenanceUntrusted,
  type RoutineProvenance,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { errorMessage } from "@tavi/contracts/util";
import {
  RoutineEditSchema,
  RoutineSetupSchema,
  RoutineRunOverrideSchema,
  RoutineDeliveryTargetSchema,
  RoutineReportPatchSchema,
  RoutineDeliveryPatchSchema,
  RoutineDeliveryWindowSchema,
  SCHEDULE_TIME_PATTERN,
  TaviError,
  hostTimeZone,
  routineSetupDefaults,
  routineSetupTriggers,
  routineTriggerNext,
  routineTriggerSpec,
  type RoutineTrigger,
  type RoutinesPayload,
  type ToolSink,
} from "@tavi/contracts";
import type { RoutineControlService, ToolRegistry } from "@tavi/runtime";
import type { CoreT } from "@tavi/contracts/locales/core";

import { cardWords } from "../approvals/card-words.js";
import { reminderWhenText } from "../reminders/when-text.js";
import { cadenceReadBack, cadenceSpecFields, triggerCadence } from "../schedules/tools.js";
const id = z.string().min(1).max(128);
// Model-facing shapes express JSON constraints; the control service additionally validates IANA zones and cross-field policy invariants.
const zone = z.string().min(1).max(64).describe("Valid IANA timezone, validated again by the owner");
const routineZone = zone.describe("IANA timezone; omit for the workspace's, named in the runtime facts");
// A one-off time keeps the offset the model resolved it with; the owner stores it in UTC. The schema states its
// shape only: `z.iso.datetime`'s calendar-exact pattern cost ~130 tokens in each of `create` and `update`, so
// the date itself is checked when the call runs (`storedTriggers`).
const isoDateTime = z.iso.datetime({ offset: true });
const runAt = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/)
  .describe(
    "Date and time with its UTC offset, e.g. 2026-10-05T10:00:00+02:00, resolved against the current local time in the runtime facts",
  );
// Only the fields an edit changes; the owner keeps the rest, and the plugin template a revision pinned.
const reportSchema = z.strictObject({
  ...RoutineReportPatchSchema.shape,
  formats: z
    .array(z.enum(["in-app", "pdf"]))
    .min(1)
    .max(2)
    .optional()
    .describe("Unique formats; in-app is required"),
});
const deliverySchema = RoutineDeliveryPatchSchema.extend({
  window: z
    .strictObject({ ...RoutineDeliveryWindowSchema.shape, timezone: zone })
    .nullable()
    .optional()
    .describe("null removes the window"),
});
const triggers = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        id,
        kind: z.literal("daily"),
        at: z.string().regex(SCHEDULE_TIME_PATTERN).optional(),
        times: triggerCadence.times.optional(),
        everyHours: triggerCadence.everyHours.optional(),
        between: triggerCadence.between.optional(),
        timezone: routineZone.optional(),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
        monthly: triggerCadence.monthly.optional(),
        yearly: triggerCadence.yearly.optional(),
        until: triggerCadence.until.optional(),
      }),
      z.strictObject({ id, kind: z.literal("once"), runAt }),
    ]),
  )
  .min(1)
  .max(10);
const setupSchema = RoutineSetupSchema.extend({
  timezone: routineZone.optional(),
  triggers: triggers
    .optional()
    .describe(
      "Recurring and one-off triggers; omit for a daily routine at `at`. With both, `at` adds one more daily trigger. A recurring one runs at `at`, `times` or `everyHours` (in `between` HH:MM-HH:MM) on daysOfWeek (0 = Sunday), `monthly` (1-31, or 2:tue, last:fri) or `yearly` (MM-DD), `until` a YYYY-MM-DD",
    ),
});
const editSchema = RoutineEditSchema.extend({
  report: reportSchema.optional(),
  delivery: deliverySchema.optional(),
  triggers: triggers.optional(),
});
const identify = { routineId: id.optional() };
/** The revision an edit was read against: one saved since is a conflict, an evaluation finishing is not. */
const expectedRevision = z.number().int().positive().optional();
/** Accepted from a call written for the earlier tools: checked only when `expectedRevision` is absent. */
const legacyVersion = z.number().int().positive().optional();
const operations = {
  create: z.strictObject({ setup: setupSchema, operationKey: id }),
  update: z.strictObject({ ...identify, edit: editSchema, expectedRevision, expectedVersion: legacyVersion, operationKey: id }),
  get: z.strictObject({
    ...identify,
    revision: z.number().int().positive().optional(),
    view: z.enum(["explain", "verify", "readiness"]).optional(),
  }),
  list: z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
  pause: z.strictObject({ ...identify, expectedVersion: z.number().int().positive() }),
  resume: z.strictObject({ ...identify, expectedVersion: z.number().int().positive() }),
  archive: z.strictObject({ ...identify, expectedVersion: z.number().int().positive() }),
  reevaluate: z.strictObject({ ...identify, expectedVersion: z.number().int().positive() }),
  run: z.strictObject({ ...identify, operationKey: id, override: RoutineRunOverrideSchema.optional() }),
  preview: z.strictObject({
    ...identify,
    operationKey: id,
    revision: z.number().int().positive().optional(),
    override: RoutineRunOverrideSchema.optional(),
  }),
  history: z.strictObject({ ...identify, beforeRunId: id.optional(), limit: z.number().int().min(1).max(100).optional() }),
  inspect: z.strictObject({ runId: id }),
  cancel_run: z.strictObject({ runId: id }),
  revoke_grant: z.strictObject({ runId: id, reason: z.string().min(1).max(500).optional() }),
  retry_delivery: z.strictObject({ jobId: id, operationKey: id, acknowledgeDuplicateRisk: z.boolean() }),
  resume_delivery: z.strictObject({ ...identify, targetId: id }),
  targets: z.strictObject({}),
  add_target: z.strictObject({ target: RoutineDeliveryTargetSchema }),
  undo: z.strictObject({
    ...identify,
    revision: z.number().int().positive(),
    expectedRevision,
    expectedVersion: legacyVersion,
    operationKey: id,
  }),
} as const;
type ToolTriggers = z.infer<typeof triggers>;
/** Triggers as the owner stores them: a daily one in `timezone` unless it names its own, a one-off time in UTC. */
function storedTriggers(given: ToolTriggers, timezone: string): RoutineTrigger[] {
  return given.map((trigger) => {
    if (trigger.kind === "daily") {
      const { between: _between, monthly: _monthly, yearly: _yearly, ...rest } = trigger;
      return { ...rest, ...cadenceSpecFields(trigger), timezone: trigger.timezone ?? timezone };
    }
    if (!isoDateTime.safeParse(trigger.runAt).success)
      throw new TaviError("INVALID_INPUT", `Trigger ${trigger.id}: runAt ${trigger.runAt} is not a real calendar date and time`);
    return { ...trigger, runAt: new Date(trigger.runAt).toISOString() };
  });
}
/** A setup as the owner stores it: in `workspaceZone` unless it names a zone, with its default time filled in. */
function storedSetup(setup: z.infer<typeof setupSchema>, workspaceZone: string) {
  const { triggers: given, ...rest } = setup;
  const timezone = setup.timezone ?? workspaceZone;
  return routineSetupDefaults({ ...rest, timezone, ...(given === undefined ? {} : { triggers: storedTriggers(given, timezone) }) });
}
/**
 * When a routine will run, as its creation is shown for approval, in the words
 * a schedule's card uses: "Every Mon–Fri at 07:00 (Europe/Berlin); once at
 * 2026-10-02T15:00:00.000Z; next Thu 1 Oct 07:00". The next run is named
 * only once the zone is known (`zoneKnown`).
 */
function triggerSummary(
  setup: {
    readonly at?: string | undefined;
    readonly timezone: string;
    readonly triggers?: readonly RoutineTrigger[] | undefined;
  },
  now: Date,
  zoneKnown: boolean,
  t: CoreT,
): string {
  const triggers = routineSetupTriggers(setup);
  const summary = triggers
    .map((trigger) => {
      const spec = routineTriggerSpec(trigger);
      return spec !== undefined
        ? cadenceReadBack(spec, t)
        : trigger.kind === "once"
          ? t("approval.card.routine.onceAt", { time: trigger.runAt })
          : "";
    })
    .join("; ");
  let next: Date | undefined;
  if (zoneKnown) {
    try {
      for (const trigger of triggers) {
        const at = routineTriggerNext(trigger, now);
        if (at !== null && (next === undefined || Date.parse(at) < next.getTime())) next = new Date(at);
      }
    } catch {
      // A zone the owner refuses: the card says what was asked, and the call is refused when it runs.
      next = undefined;
    }
  }
  const withNext =
    next === undefined ? summary : t("approval.card.schedule.next", { cadence: summary, time: reminderWhenText(next, setup.timezone, t) });
  return withNext.charAt(0).toUpperCase() + withNext.slice(1);
}
/** Where a new routine's reports go, as its card says it. */
function deliveryLine(delivery: { readonly targetId: string; readonly pdf?: boolean | undefined } | undefined, t: CoreT): string {
  if (delivery === undefined) return t("approval.card.routine.savedOnly");
  return t(delivery.pdf === true ? "approval.card.routine.deliveredPdf" : "approval.card.routine.delivered", { target: delivery.targetId });
}
/**
 * A new routine's card detail: when it runs, the skills it follows, how its
 * research reaches the web and where its reports go.
 */
function createDetail(
  setup:
    | {
        readonly at?: string | undefined;
        readonly timezone: string;
        readonly triggers?: readonly RoutineTrigger[] | undefined;
        readonly skills?: readonly { readonly skillId: string; readonly version?: string | undefined }[] | undefined;
      }
    | undefined,
  when: { readonly now: Date; readonly zoneKnown: boolean } | undefined,
  openWeb: boolean,
  delivery: { readonly targetId: string; readonly pdf?: boolean | undefined } | undefined,
  t: CoreT,
): string {
  const skills = (setup?.skills ?? []).map((skill) => (skill.version === undefined ? skill.skillId : `${skill.skillId}@${skill.version}`));
  return [
    setup === undefined || when === undefined ? "" : `${triggerSummary(setup, when.now, when.zoneKnown, t)}. `,
    skills.length === 0 ? "" : `${t("approval.card.routine.skills", { skills: skills.join(", ") })} `,
    t(openWeb ? "approval.card.routine.openWeb" : "approval.card.routine.allowlist"),
    " ",
    deliveryLine(delivery, t),
  ].join("");
}
/** What a routine's `get` answers of its pinned folder. */
const PinnedFolderSchema = z.object({ revision: z.object({ snapshot: z.object({ folder: z.object({ path: z.string() }).optional() }) }) });
/**
 * The model's `routines.undo` never changes which folder the routine's fires
 * work in (I-model): the folder is the owner's to pin, from a terminal, so a
 * revision pinning another folder than the routine has now — one the owner
 * since removed or changed — is refused here.
 */
async function refuseUndoChangingFolder(
  service: Pick<RoutineControlService, "execute">,
  payload: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly conversationId: string;
    readonly routineId?: string | undefined;
    readonly revision: number;
  },
): Promise<void> {
  const scope = {
    workspaceId: payload.workspaceId,
    principalId: payload.principalId,
    conversationId: payload.conversationId,
    ...(payload.routineId === undefined ? {} : { routineId: payload.routineId }),
  };
  const [now, then] = await Promise.all([
    service.execute({ action: "get", ...scope }),
    service.execute({ action: "get", ...scope, revision: payload.revision }),
  ]);
  const current = PinnedFolderSchema.safeParse(now);
  const restored = PinnedFolderSchema.safeParse(then);
  if (!current.success || !restored.success)
    throw new TaviError("INTERNAL", "The routine's folder could not be read, so no revision is restored");
  const pinned = current.data.revision.snapshot.folder?.path;
  const wanted = restored.data.revision.snapshot.folder?.path;
  if (pinned === wanted) return;
  throw new TaviError(
    "NOT_AUTHORIZED",
    `Revision ${payload.revision} works in ${wanted ?? "its own folder each fire"}, and the routine now works in ${pinned ?? "its own folder each fire"}: a routine's folder is the owner's to pin from a terminal, so this revision is not restored. Ask the owner to restore it.`,
  );
}
/**
 * Each routine operation's sink: what leaves the chat or outlives it. Reads
 * and the operations that only narrow
 * (`pause`, `archive`, `cancel_run`, `revoke_grant`) are `none`; `run`,
 * `retry_delivery` and `resume_delivery` deliver to a configured target; the
 * rest outlive the chat — `resume` re-arms what `pause` narrowed, `reevaluate`
 * may activate the revision it evaluates, and `add_target` is a standing
 * delivery destination.
 */
const ROUTINE_SINKS = {
  create: "persist",
  update: "persist",
  get: "none",
  list: "none",
  pause: "none",
  resume: "persist",
  archive: "none",
  reevaluate: "persist",
  run: "message",
  preview: "none",
  history: "none",
  inspect: "none",
  cancel_run: "none",
  revoke_grant: "none",
  retry_delivery: "message",
  resume_delivery: "message",
  targets: "none",
  add_target: "persist",
  undo: "persist",
} as const satisfies Record<keyof typeof operations, ToolSink>;
/**
 * Routine answers' labels, decided by what an answer carries:
 * - a run's output — `inspect` (its publication, deliveries and attempts),
 *   `cancel_run` (the run, its snapshot and data), and `run` and `preview` (the queued run's id, status and revision) — is
 *   `untrustedOutput`, `routine-output`, whatever the revision;
 * - any answer that shows a revision's words (`get`, `create`,
 *   `update`, `undo`, `pause`, `resume`, `archive`, `reevaluate`, and `list`
 *   over its routines) is
 *   untrusted `routine-output`, joined with the stored provenance, when that
 *   revision carries untrusted provenance (a model's change under taint), and
 *   trusted otherwise; so is a run answer, with its revision's provenance;
 * - `history`, `get`'s `verify` and `readiness` views, `targets` and `resume_delivery` return
 *   run metadata, host checks, the operator's targets and an acknowledgement,
 *   never run output or a page's words: trusted.
 */
const RUN_OUTPUT = new Set(["inspect", "run", "preview", "cancel_run"]);
/** Omitted, a routine id is this conversation's linked routine: said once per tool that takes one. */
const LINKED = " Omit routineId for this conversation's routine.";
/**
 * Each operation's description, short: these tools are offered together, so a
 * sentence repeated in all of them is paid for many times over.
 */
const ROUTINE_DESCRIPTIONS = {
  create:
    "Save a research routine and a persistent specialist: daily at `at`, or on `triggers` (daily on chosen weekdays, or once at a time). A routine researches and publishes a report: not for being told something at a time (reminders.create) or a prompt run at set times (schedules.create). Setup evaluation is asynchronous; report returned status truthfully. Times are in the workspace's zone, named in the runtime facts, unless you give `timezone`; write a one-off `runAt` with its UTC offset. To deliver the report too, give `delivery` a target from routines.targets, with `pdf: true` for a PDF. Research runs locally while the owner is awake. " +
    'Example: {"setup":{"name":"EV news","objective":"Solid-state battery news","triggers":[{"id":"mon","kind":"daily","at":"07:00","daysOfWeek":[1]}]},"operationKey":"ev"}.',
  update:
    "Edit the linked routine (or explicit routineId). Send only the report and delivery fields that change; the rest stay. Give the latestRevision you read as expectedRevision. Delivery/report-only edits leave researcher instructions unchanged. A daily trigger without `timezone` is in the workspace's zone; a one-off `runAt` carries its UTC offset. Never infer a delivery target from message sender identity. " +
    'Example: {"edit":{"report":{"formats":["in-app","pdf"]}},"expectedRevision":1,"operationKey":"pdf"}.',
  get: `Read a routine, its revision and state. view: explain (where a revision's words came from), verify (its run ledger is intact) or readiness (can it run: research access, owner heartbeat, targets, next fire).${LINKED}`,
  list: "List your routines.",
  pause: `Pause a routine.${LINKED}`,
  resume: `Resume a paused routine.${LINKED}`,
  archive: `Archive a routine for good: it never runs again and cannot be resumed. To stop it for now, use routines.pause.${LINKED}`,
  reevaluate: `Run a routine's failed setup evaluation again, without saving a new revision.${LINKED}`,
  run: `Run a routine now; its report goes to its configured targets. routines.inspect reads the run.${LINKED}`,
  preview: `Run a routine as a preview, delivered nowhere. routines.inspect reads the run.${LINKED}`,
  history: `List a routine's past runs.${LINKED}`,
  inspect:
    "Inspect a run: its report as text (`report`), its publication (`gaps` says why a degraded run was degraded), deliveries and attempts.",
  cancel_run: "Cancel a run: stop it if it is still running, and drop its deliveries not yet sent.",
  revoke_grant:
    "Revoke a run's pinned authority. The next research fetch and any pending delivery for that run fail closed; evidence already gathered and a report already published are untouched. Use when the operator wants to bound a run without cancelling it.",
  retry_delivery:
    "Retry a failed delivery. A resend can duplicate a received PDF: set acknowledgeDuplicateRisk only once the user acknowledged that.",
  resume_delivery: `Resume a delivery target paused after repeated failures or missing credentials; its held reports go out now.${LINKED}`,
  targets: "List the delivery targets the operator configured.",
  add_target: "Add a delivery target, only one the operator authorized.",
  undo: `Restore an earlier revision of a routine.${LINKED}`,
} as const satisfies Record<keyof typeof operations, string>;
/** The provenance an answer shows: its own (a run's, `inspect`'s), its revision's, or the join over a list's routines. */
function provenanceOfAnswer(name: string, answer: object): RoutineProvenance | undefined {
  if (name === "list") {
    const routines = (answer as { readonly routines?: readonly { readonly provenance?: RoutineProvenance }[] }).routines ?? [];
    return routines.reduce<RoutineProvenance | undefined>((joined, routine) => joinMemoryProvenance(joined, routine.provenance), undefined);
  }
  const own = (answer as { readonly provenance?: RoutineProvenance }).provenance;
  if (own !== undefined) return own;
  const revision = (answer as { readonly revision?: unknown }).revision;
  return typeof revision === "object" && revision !== null
    ? (revision as { readonly provenance?: RoutineProvenance }).provenance
    : undefined;
}
/** A run summary without its headline. */
function unheadlined(run: unknown): unknown {
  if (typeof run !== "object" || run === null || !("headline" in run)) return run;
  const { headline: _headline, ...rest } = run;
  return rest;
}
/**
 * `history` and `list` without their runs' headlines: a headline is words of a
 * published report, and these answers are trusted run metadata. A run's report
 * is read through `inspect`, labelled as its output.
 */
function withoutHeadlines(name: string, answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null) return answer;
  if (name === "history" && Array.isArray((answer as { runs?: unknown }).runs))
    return { ...answer, runs: (answer as { runs: readonly unknown[] }).runs.map(unheadlined) };
  if (name === "list" && Array.isArray((answer as { routines?: unknown }).routines))
    return {
      ...answer,
      routines: (answer as { routines: readonly { lastRun?: unknown }[] }).routines.map((routine) =>
        routine.lastRun === undefined ? routine : { ...routine, lastRun: unheadlined(routine.lastRun) },
      ),
    };
  return answer;
}
/**
 * A run just requested, as the model is answered: it is queued, so its snapshot and data say nothing yet.
 * Its provenance stays, for the label.
 */
function queuedRun(answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null) return answer;
  const { runId, status, revision, provenance } = answer as {
    readonly runId?: unknown;
    readonly status?: unknown;
    readonly revision?: unknown;
    readonly provenance?: unknown;
  };
  return { runId, status, revision, ...(provenance === undefined ? {} : { provenance }) };
}
/** `answer` with its label: untrusted `routine-output` for a run's output, and for any answer whose provenance is untrusted, joined with it. */
function labelledAnswer(name: string, answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return answer;
  const provenance = provenanceOfAnswer(name, answer);
  const untrustedWords = provenance !== undefined && memoryProvenanceUntrusted(provenance);
  if (!RUN_OUTPUT.has(name) && !untrustedWords) return answer;
  return {
    ...answer,
    [TOOL_LABEL_KEY]: {
      untrusted: true,
      source: "routine-output",
      ...(untrustedWords ? { stored: memoryProvenanceLabel(provenance) } : {}),
    },
  };
}
export interface RoutineToolOptions {
  /** The workspace's effective zone, for a routine or daily trigger that names none; the host's when absent. */
  readonly workspaceTimezone?: (workspaceId: string) => Promise<string>;
  /**
   * That zone as last read, for the approval card, which cannot wait for a
   * read: undefined until one was. Absent, or before a read: the card names
   * the workspace's zone without saying which it is.
   */
  readonly workspaceTimezoneSync?: (workspaceId: string) => string | undefined;
  /** That zone read again for the card as the tools are offered; `workspaceTimezone` when absent. */
  readonly refreshWorkspaceTimezone?: (workspaceId: string) => Promise<unknown>;
  /** The clock a card's next run is counted from; the system's when absent. */
  readonly now?: () => Date;
}
export function registerRoutineTools(
  registry: ToolRegistry,
  service: Pick<RoutineControlService, "execute" | "setupPermissions">,
  options: RoutineToolOptions = {},
): void {
  const workspaceTimezone = options.workspaceTimezone ?? (() => Promise.resolve(hostTimeZone()));
  const refreshZone = options.refreshWorkspaceTimezone ?? workspaceTimezone;
  for (const [name, schema] of Object.entries(operations)) {
    const readOnly = ["get", "list", "history", "inspect", "targets"].includes(name);
    registry.register({
      id: `routines.${name}`,
      // A run starts research that takes its own time, under its own budget.
      ...(name === "run" ? { timeoutMs: 0 } : {}),
      sink: ROUTINE_SINKS[name as keyof typeof operations],
      version: "1.0.0",
      effect: readOnly ? "read-only" : "mutating",
      requiredPermissions: ["tools.invoke"],
      inputSchema: schema,
      ...(RUN_OUTPUT.has(name) ? { untrustedOutput: true, outputSource: "routine-output" as const } : {}),
      // An archived routine cannot be resumed: its card says so, and is asked about each time.
      ...(name === "archive"
        ? {
            annotations: { destructive: true },
            // An allow rule lifts a destructive call; under taint it is still asked about.
            assess: (input: unknown, context: InvocationContext | undefined) => {
              const t = cardWords(context);
              const parsed = operations.archive.safeParse(input);
              const routineId = (parsed.success ? parsed.data.routineId : undefined) ?? t("approval.card.routine.thisConversations");
              return {
                subjects: [],
                risk: "medium" as const,
                reasons: [t("approval.reason.routine.archive")],
                askWhenTainted: true,
                display: { title: t("approval.card.routine.archive", { id: routineId }) },
              };
            },
          }
        : {}),
      ...(name === "create"
        ? {
            // The workspace's zone, read whenever the tools are offered, so the card can name it.
            offered: async (context: { readonly workspaceId: string }) => {
              await Promise.resolve(refreshZone(context.workspaceId)).catch(() => undefined);
              return true;
            },
            assess: (input: unknown, context: InvocationContext | undefined) => {
              const t = cardWords(context);
              const parsed = operations.create.safeParse(input);
              const permissions = service.setupPermissions();
              // A setup whose triggers cannot be armed is refused before anyone is asked to approve it.
              // The workspace's zone as last read; before any read, it is named, not guessed.
              const workspaceZone = context === undefined ? undefined : options.workspaceTimezoneSync?.(context.workspaceId);
              const zoneKnown = parsed.success && (parsed.data.setup.timezone !== undefined || workspaceZone !== undefined);
              let setup: ReturnType<typeof storedSetup> | undefined;
              let refusal: string | undefined;
              try {
                setup = parsed.success
                  ? storedSetup(parsed.data.setup, workspaceZone ?? t("approval.card.schedule.workspaceZone"))
                  : undefined;
                if (setup !== undefined) routineSetupTriggers(setup);
              } catch (error) {
                refusal = errorMessage(error);
              }
              return {
                subjects: [],
                risk: "medium" as const,
                reasons: [t("approval.reason.routine.create")],
                ...(refusal === undefined ? {} : { hardDeny: refusal }),
                display: {
                  title: parsed.success
                    ? t("approval.card.routine.create", { name: parsed.data.setup.name }).slice(0, 300)
                    : t("approval.card.routine.createAny"),
                  detail: createDetail(
                    setup,
                    refusal === undefined ? { now: options.now?.() ?? new Date(), zoneKnown } : undefined,
                    permissions.networkMode === "open_web",
                    parsed.success ? parsed.data.setup.delivery : undefined,
                    t,
                  ),
                },
              };
            },
          }
        : {}),
      description: ROUTINE_DESCRIPTIONS[name as keyof typeof operations],
      handler: async ({ input, context, contextLabel }) => {
        const parsed = schema.safeParse(input);
        if (!parsed.success)
          throw new TaviError("INVALID_INPUT", `Invalid routine tool arguments: ${zodIssues(parsed.error, "input").join("; ")}`);
        // A routine with neither a time nor triggers runs daily at 09:00, and one naming no zone runs in the
        // workspace's: said here so the stored setup names both.
        const update = name === "update" ? operations.update.safeParse(input) : undefined;
        const data =
          "setup" in parsed.data
            ? { ...parsed.data, setup: storedSetup(parsed.data.setup, await workspaceTimezone(context.workspaceId)) }
            : update?.success === true && update.data.edit.triggers !== undefined
              ? {
                  ...update.data,
                  edit: {
                    ...update.data.edit,
                    triggers: storedTriggers(update.data.edit.triggers, await workspaceTimezone(context.workspaceId)),
                  },
                }
              : parsed.data;
        if (name === "undo") {
          const undo = operations.undo.parse(input);
          await refuseUndoChangingFolder(service, {
            workspaceId: context.workspaceId,
            principalId: context.principalId,
            conversationId: context.runId,
            routineId: undo.routineId,
            revision: undo.revision,
          });
        }
        // A change the model makes carries its call's label: one under taint is the revision's provenance.
        const byModel = name === "create" || name === "update" || name === "undo" ? { modelLabel: contextLabel ?? TRUSTED_PUBLIC } : {};
        // `get`'s view is the owner's action of that name.
        const { view, ...rest } = data as Record<string, unknown> & { view?: string };
        const answer = withoutHeadlines(
          name,
          await service.execute({
            ...rest,
            ...byModel,
            action: name === "update" ? "edit" : name === "cancel_run" ? "cancel" : (view ?? name),
            workspaceId: context.workspaceId,
            principalId: context.principalId,
            conversationId: context.runId,
          } as RoutinesPayload),
        );
        return labelledAnswer(name, name === "run" || name === "preview" ? queuedRun(answer) : answer);
      },
    });
  }
}
