/**
 * The `schedules.*` tools: a prompt the agent runs at set times, created,
 * listed, changed, paused and cancelled from a chat ("stop my morning
 * summary"), run now, and its recent runs read ("why didn't it run on Tuesday?"). They write through the same `writeSchedule` / `setScheduleEnabled`
 * the CLI and the canvas use, so every rule there holds.
 *
 * Guards a chat needs that a person at the CLI does not: only the chat's own
 * workspace is listed or touched; a routine's schedule (`routines.*` owns it)
 * and one with a fire in flight are refused; and the tools a schedule may run
 * without asking (`allow`) are, from a chat, read-only ones, unless the person
 * approves the others on a high-risk card shown once.
 */
import { z } from "zod";

import {
  SCHEDULE_DEFAULT_MAX_RUN_MINUTES,
  SCHEDULE_FIRES_KEPT,
  SCHEDULE_MAX_EVERY_HOURS,
  SCHEDULE_MAX_TIMES_PER_DAY,
  SCHEDULE_SHOW_FIRES,
  SCHEDULE_TIME_PATTERN,
  ScheduleSpecSchema,
  type ReminderMonthly,
  type ReminderYearly,
  TaviError,
  formatReminderTime,
  nextOccurrence,
  parseScheduleWindow,
  scheduleSpecText,
  type SchedulesPayload,
  toolPatternMatches,
  type CallAssessment,
  type InvocationContext,
  type PersistencePort,
  type ScheduleFireReason,
  type ScheduleFireRecord,
  type ScheduleRecord,
  type ScheduleSpec,
  ScheduleMaxRunMinutesSchema,
  ScheduleMaxTokensSchema,
  ScheduleNotifySchema,
  scheduleNotifyText,
  tokenCountText,
  schedulePausedText,
  parseSchedulePrecheck,
  schedulePrecheckSentence,
  scheduleWatchSentence,
  schedulePrecheckText,
  type ScheduleNotify,
  type ToolDefinition,
  DisplayNameSchema,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import type { ToolRegistry } from "@tavi/runtime";

import { UsageError } from "../../cli/argv.js";
import { OFFER_READ_REUSE_MS, recentRead } from "../../shared/recent-read.js";
import { parseReminderMonthly, parseReminderYearly } from "../reminders/parse.js";
import { composeSpec, fireTimeText, resolveSchedule, setScheduleEnabled, writeSchedule, type ScheduleFireNow } from "./actions.js";
import type { ScheduleWebhookIds } from "./webhook.js";

export interface ScheduleToolOptions {
  readonly repositories: Pick<PersistencePort["repositories"], "schedules" | "agents" | "mcp">;
  readonly tools: () => readonly ToolDefinition[];
  readonly now: () => Date;
  /** The routine whose trigger a schedule is, if any: `routines.*` changes it, not these tools. */
  readonly routineOwner: (scheduleId: string) => unknown;
  /** `routineOwner` for each id, in their order, in one call: what a listing asks. */
  readonly routineOwners: (scheduleIds: readonly string[]) => Promise<readonly unknown[]> | readonly unknown[];
  /** Whether a fire of the schedule is running now. */
  readonly fireInFlight: (scheduleId: string) => boolean;
  /** The owner's `--fs-root` rule for a `file-changed` pre-check's file; absent where none can be saved. */
  readonly precheckFile?: (path: string) => string;
  /** The owner's site profiles for a page or feed pre-check's address; absent where none are held. */
  readonly precheckSite?: (workspaceId: string, url: string) => Promise<string | undefined>;
  /** Fire a schedule now, as `tavi schedules run-now` does on the owner; absent where nothing can fire it. */
  readonly runNow?: (schedule: ScheduleRecord) => Promise<ScheduleFireNow>;
  /** The owner's webhook-enabled schedule ids: a removed schedule leaves them. Absent where no webhook is answered. */
  readonly webhookIds?: Pick<ScheduleWebhookIds, "delete">;
  /** The workspace's own zone, for a schedule that names none. */
  readonly workspaceTimezone: (workspaceId: string) => Promise<string>;
  /**
   * The workspace's zone as last read, for the approval card, which cannot
   * wait for a read: undefined until one was. Absent: the card names the
   * workspace's zone without saying which it is.
   */
  readonly workspaceTimezoneSync?: (workspaceId: string) => string | undefined;
  /** The workspace's zone read again for the card as the tools are offered; `workspaceTimezone` when absent. */
  readonly refreshWorkspaceTimezone?: (workspaceId: string) => Promise<unknown>;
}

const time = z.string().regex(SCHEDULE_TIME_PATTERN);
const at = time.describe("The time of day, 24-hour HH:MM; or give times, or everyHours");
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).describe("Days of the week it runs on, 0 = Sunday; omit for every day");
/**
 * When it runs besides `at` and `days`, each in place of one of them, written
 * as the CLI's flags are (`2:tue`, `12-25`, `08:00-18:00`) to keep the schemas
 * small. A routine's recurring trigger takes them too, but `once`.
 */
export const triggerCadence = {
  times: z.array(time).min(1).max(SCHEDULE_MAX_TIMES_PER_DAY),
  everyHours: z.number().int().min(1).max(SCHEDULE_MAX_EVERY_HOURS),
  between: z.string(),
  monthly: z.string(),
  yearly: z.string(),
  until: z.string(),
};
const cadence = {
  times: triggerCadence.times.describe("Several times a day, instead of at"),
  everyHours: triggerCadence.everyHours.describe("Every n hours instead of at, in between if given"),
  between: triggerCadence.between.describe("HH:MM-HH:MM"),
  monthly: triggerCadence.monthly.describe("Instead of days: day 1-31, or nth:weekday as 2:tue, last:fri"),
  yearly: triggerCadence.yearly.describe("Instead of days: MM-DD"),
  once: z.string().describe("Only on this YYYY-MM-DD"),
  until: triggerCadence.until.describe("Last YYYY-MM-DD it runs"),
};
/** The cadence fields as a write takes them. */
type CadenceInput = { readonly at?: string | undefined; readonly days?: readonly number[] | null | undefined } & {
  readonly [Field in Exclude<keyof typeof cadence, "until">]?: z.infer<(typeof cadence)[Field]> | undefined;
} & { readonly until?: string | null | undefined };

/** Read a cadence field the way its CLI flag is read, refusing it as the call's input. */
function asInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof UsageError) throw new TaviError("INVALID_INPUT", error.message);
    throw error;
  }
}

/** `between`, `monthly` and `yearly` as the spec holds them: a window and the day objects. */
export function cadenceSpecFields(fields: Pick<CadenceInput, "between" | "monthly" | "yearly">): {
  readonly between?: { readonly from: string; readonly to: string };
  readonly monthly?: ReminderMonthly;
  readonly yearly?: ReminderYearly;
} {
  const window = fields.between === undefined ? undefined : parseScheduleWindow(fields.between);
  if (fields.between !== undefined && window === undefined)
    throw new TaviError("INVALID_INPUT", `between expects HH:MM-HH:MM, e.g. 08:00-18:00, received ${JSON.stringify(fields.between)}`);
  return {
    ...(window === undefined ? {} : { between: window }),
    ...(fields.monthly === undefined ? {} : { monthly: asInput(() => parseReminderMonthly(fields.monthly as string, "")) }),
    ...(fields.yearly === undefined ? {} : { yearly: asInput(() => parseReminderYearly(fields.yearly as string, "")) }),
  };
}
const CadenceFieldsSchema = z
  .object({
    at: at.optional(),
    timezone: z.string().optional(),
    days: days.nullable().optional(),
    ...cadence,
    until: cadence.until.nullable(),
  })
  .partial();
const allow = z
  .array(z.string().min(1).max(200))
  .max(32)
  .describe("Tools a run may use without asking: read-only ones (web_search, reports.*); a person approves any other on its own card");
const deliverTo = z
  .enum(["home", "none"])
  .describe(
    "home: post each run's result to the person's Home chat; none: only what the run sends itself. A new schedule without it posts to Home unless allow has messaging.send_to",
  );
const maxRunMinutes = ScheduleMaxRunMinutesSchema.describe(
  `Minutes a run may work before it is stopped; ${SCHEDULE_DEFAULT_MAX_RUN_MINUTES} when omitted`,
);
const maxTokens = ScheduleMaxTokensSchema.describe(
  "Tokens a run, its workers included, may use before it is stopped; no ceiling when omitted",
);
const notify = ScheduleNotifySchema.describe(
  'when-sent: tell only when a run has something, as for "only if…"/"only when…"; if-changed: not the same result twice; always when omitted',
);
const precheck = z
  .string()
  .min(1)
  .max(2100)
  .describe("Run only when something changed: page-changed:<https url>, feed-has-new:<https url> or file-changed:<path>; none removes it");
const ref = z.string().min(1).max(200).describe("The schedule's id, or its name");

const CreateSchema = z.strictObject({
  name: DisplayNameSchema,
  prompt: z.string().min(1).max(20_000).describe("What the agent does at each run, as you would ask it"),
  at: at.optional(),
  times: cadence.times.optional(),
  everyHours: cadence.everyHours.optional(),
  between: cadence.between.optional(),
  timezone: z.string().min(1).max(64).optional().describe("An IANA zone; omit for the workspace's"),
  days: days.optional(),
  monthly: cadence.monthly.optional(),
  yearly: cadence.yearly.optional(),
  once: cadence.once.optional(),
  until: cadence.until.optional(),
  allow: allow.optional(),
  deliverTo: deliverTo.optional(),
  maxRunMinutes: maxRunMinutes.optional(),
  maxTokens: maxTokens.optional(),
  notify: notify.optional(),
  precheck: precheck.optional(),
});
const UpdateSchema = z.strictObject({
  schedule: ref,
  prompt: z.string().min(1).max(20_000).optional(),
  at: at.optional(),
  times: cadence.times.optional(),
  everyHours: cadence.everyHours.optional(),
  between: cadence.between.optional(),
  timezone: z.string().min(1).max(64).optional(),
  days: days.nullable().optional().describe("null: every day again, dropping monthly, yearly and once"),
  monthly: cadence.monthly.optional(),
  yearly: cadence.yearly.optional(),
  once: cadence.once.optional(),
  until: cadence.until.nullable().optional().describe("null: no end"),
  allow: allow.optional(),
  deliverTo: deliverTo.optional(),
  maxRunMinutes: maxRunMinutes.optional(),
  maxTokens: maxTokens.nullable().optional().describe("null removes the ceiling"),
  notify: notify.optional(),
  precheck: precheck.optional(),
});
const RefSchema = z.strictObject({ schedule: ref });
/** Named whole, so a check reading the sources finds them (`tests/tool-references.test.ts`). */
const SCHEDULES_PAUSE_ID = "schedules.pause";
const SCHEDULES_RESUME_ID = "schedules.resume";
const SCHEDULES_RUN_NOW_ID = "schedules.run_now";
const ListSchema = z.strictObject({});
const HistorySchema = z.strictObject({
  schedule: ref,
  limit: z.number().int().min(1).max(SCHEDULE_FIRES_KEPT).optional().describe(`Most runs to list; ${SCHEDULE_SHOW_FIRES} when omitted`),
});
/**
 * The reasons whose stored outcome the host wrote in full: a failed run's (or a
 * manual run's) carries the run's own last words or an error, which is the
 * run's output, so `schedules.history` names its task instead.
 */
const HOST_WORDED: ReadonlySet<ScheduleFireReason> = new Set([
  "ok",
  "undelivered",
  "quiet",
  "unchanged",
  "timeout",
  "budget",
  "waiting",
  "asked",
  "missed",
  "overlap",
  "disk",
  "orphaned",
  "paused",
]);

/** When a cadence runs, in words: "every day at 07:00 (Europe/Sofia)", "every Mon–Fri at 07:00 and 19:00 (Europe/Sofia)". */
export function cadenceReadBack(spec: ScheduleSpec): string {
  return scheduleSpecText(spec);
}

/** A write's cadence fields as the payload names them (`untilDate` for the spec's `until`). */
function cadencePayload(fields: CadenceInput): Partial<SchedulesPayload> {
  return {
    ...(fields.at === undefined ? {} : { at: fields.at }),
    ...(fields.times === undefined ? {} : { times: [...fields.times] }),
    ...(fields.everyHours === undefined ? {} : { everyHours: fields.everyHours }),
    ...cadenceSpecFields(fields),
    ...(fields.days === undefined ? {} : { days: fields.days === null ? null : [...fields.days] }),
    ...(fields.once === undefined ? {} : { once: fields.once }),
    ...(fields.until === undefined ? {} : { untilDate: fields.until }),
  };
}

/** A spec as two writes compare it: lists sorted, so the same days in another order are the same spec. */
function specKey(spec: ScheduleSpec): string {
  const sorted = (list: readonly (string | number)[] | undefined) => (list === undefined ? undefined : [...list].sort());
  const ordered = Object.entries({ ...spec, daysOfWeek: sorted(spec.daysOfWeek), times: sorted(spec.times) })
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return JSON.stringify(ordered);
}

/** When a schedule runs, in words and in its own zone: "every Mon, Fri at 07:00 (Europe/Sofia); next Wed 28 Oct, 07:00". */
function scheduleReadBack(schedule: ScheduleRecord): string {
  return `${cadenceReadBack(schedule.spec)}; ${
    schedule.enabled
      ? `next ${schedule.nextRunAt === undefined || schedule.nextRunAt === null ? "not armed" : formatReminderTime(new Date(schedule.nextRunAt), schedule.spec.timezone)}`
      : (schedulePausedText(schedule, new Date()) ?? "paused")
  }`;
}

/** A card's `notify` field, when it names one. */
function asNotify(value: unknown): ScheduleNotify | undefined {
  const parsed = ScheduleNotifySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A pre-check as typed, written as it is stored and read back; the text itself when it is not one (the write refuses it). */
function precheckOf(text: string): string | undefined {
  const parsed = parseSchedulePrecheck(text);
  if (!parsed.ok) return text;
  return parsed.precheck === null ? undefined : schedulePrecheckText(parsed.precheck);
}

/** What a card says of a write's pre-check: what it reads before each run, or that it is removed. */
function precheckLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = parseSchedulePrecheck(value);
  if (!parsed.ok) return "";
  return parsed.precheck === null
    ? "Removes the pre-check: every run goes ahead"
    : `Checks first: ${schedulePrecheckSentence(parsed.precheck)}`;
}

/** Where a schedule's results go, as its card says it. */
function deliveryText(deliverTo: "home" | "none" | undefined): string {
  return deliverTo === "home" ? "Posts each run's result to Home" : "Posts nothing to Home: only what each run sends itself";
}

/**
 * Where a schedule made from a chat delivers when the chat names nowhere: Home,
 * as a reminder is said where it was asked, unless its runs may send a message
 * themselves (`messaging.send_to` allowed), which is then how they deliver.
 */
function chatDeliverTo(allow: readonly string[] | undefined, deliverTo: "home" | "none" | undefined): "home" | "none" | undefined {
  if (deliverTo !== undefined) return deliverTo;
  return (allow ?? []).some((pattern) => toolPatternMatches(pattern, "messaging.send_to")) ? undefined : "home";
}

/**
 * What a card binds when a change keeps a schedule's writing tools: the person approves those very tools, on that
 * schedule, with the cadence, zone and delivery the card showed.
 */
function keptToolsHash(schedule: Pick<ScheduleRecord, "scheduleId" | "autoApproveTools" | "spec" | "deliverTo">): string {
  return sha256Hex(
    JSON.stringify({
      scheduleId: schedule.scheduleId,
      allow: [...schedule.autoApproveTools].sort(),
      spec: schedule.spec,
      deliverTo: schedule.deliverTo ?? "none",
    }),
  );
}

/** A fire as a tool answers it: when it was due and why it ended so, with the host's own words for it only. */
function fireSummary(fire: ScheduleFireRecord, timezone: string) {
  return {
    due: fireTimeText(fire.fireTime, timezone),
    reason: fire.reasonCode,
    ...(fire.retryCount === undefined ? {} : { retry: fire.retryCount }),
    ...(HOST_WORDED.has(fire.reasonCode) || (fire.reasonCode === "disabled" && fire.outcome.startsWith("finished:"))
      ? { outcome: fire.outcome }
      : {}),
    ...(fire.taskId === null ? {} : { taskId: fire.taskId }),
  };
}

/** A schedule as a tool answers it: what it runs and when, without its whole prompt in a list. */
function summary(schedule: ScheduleRecord, withPrompt: boolean) {
  return {
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    readBack: scheduleReadBack(schedule),
    delivery: deliveryText(schedule.deliverTo),
    enabled: schedule.enabled,
    ...(schedule.pausedReason === undefined ? {} : { pausedReason: schedule.pausedReason }),
    ...(schedule.autoApproveTools.length === 0 ? {} : { allow: schedule.autoApproveTools }),
    ...definedOnly({ deliverTo: schedule.deliverTo, maxRunMinutes: schedule.maxRunMinutes, maxTokens: schedule.maxTokens }),
    ...(schedule.notify === undefined ? {} : { notify: schedule.notify, notifies: scheduleNotifyText(schedule.notify) }),
    ...(schedule.precheck === undefined
      ? {}
      : { precheck: schedulePrecheckText(schedule.precheck), prechecks: schedulePrecheckSentence(schedule.precheck) }),
    // A watcher is made by a person (`tavi schedules watch`, the app), never through these tools; they say what it watches.
    ...(schedule.watch === true ? { watches: scheduleWatchSentence(schedule) } : {}),
    ...(withPrompt ? { prompt: schedule.prompt } : {}),
  };
}

/**
 * The patterns of `allow` that reach a tool which can change or send things (or reach no tool at all): a person
 * approves them. A search is no such tool, though its effect is `external` for reaching a provider: its sink says
 * all it carries out is the query, which the taint step still asks about in a run that read something.
 */
export function writingPatterns(patterns: readonly string[], tools: readonly ToolDefinition[]): readonly string[] {
  return patterns.filter((pattern) => {
    const matched = tools.filter((tool) => toolPatternMatches(pattern, tool.id));
    return matched.length === 0 || matched.some((tool) => tool.effect !== "read-only" && tool.sink !== "search");
  });
}

export function registerScheduleTools(registry: ToolRegistry, options: ScheduleToolOptions): void {
  const writeChecks = {
    ...(options.precheckFile === undefined ? {} : { precheckFile: options.precheckFile }),
    ...(options.precheckSite === undefined ? {} : { precheckSite: options.precheckSite }),
  };
  /** A schedule of this workspace that these tools may change, or why not. */
  const changeable = async (workspaceId: string, reference: string): Promise<ScheduleRecord> => {
    const schedule = await resolveSchedule(options.repositories.schedules, workspaceId, reference);
    if (schedule === undefined)
      throw new TaviError("NOT_FOUND", `no schedule ${JSON.stringify(reference)} here: schedules.list names them`);
    if ((await options.routineOwner(schedule.scheduleId)) !== undefined)
      throw new TaviError("CONFLICT", `${schedule.name} is a routine's: change it with routines.update or routines.pause`);
    if (options.fireInFlight(schedule.scheduleId))
      throw new TaviError("CONFLICT", `${schedule.name} is running now: change it once this run ends`);
    return schedule;
  };
  /**
   * The workspace's schedules as last read, for the card a change shows: its
   * `assess` cannot wait for a read. Refreshed each time the tools are offered
   * and after each call, so it is the list the model chose from.
   */
  const known = new Map<string, readonly ScheduleRecord[]>();
  const remember = async (workspaceId: string): Promise<void> => {
    known.set(workspaceId, await options.repositories.schedules.list(workspaceId));
  };
  const knownSchedule = (workspaceId: string | undefined, reference: string): ScheduleRecord | undefined =>
    workspaceId === undefined
      ? undefined
      : known.get(workspaceId)?.find((schedule) => schedule.scheduleId === reference || schedule.name === reference);
  /** The tools a schedule's runs use without asking that write or send: a person approves them. */
  const armedWritingTools = (schedule: Pick<ScheduleRecord, "autoApproveTools">): readonly string[] =>
    writingPatterns(schedule.autoApproveTools, options.tools());
  /**
   * Whether a change keeps writing tools a person must approve again: it changes what, when or on what condition they
   * run (its pre-check), and does not send `allow`. Delivery alone is not one: it is only Home or nowhere.
   */
  const keepsWritingTools = (schedule: Pick<ScheduleRecord, "autoApproveTools">, change: Record<string, unknown>): readonly string[] =>
    change["allow"] === undefined &&
    ["prompt", "timezone", "at", "days", "precheck", ...Object.keys(cadence)].some((field) => change[field] !== undefined)
      ? armedWritingTools(schedule)
      : [];
  /**
   * Refuses to re-arm or run a schedule whose runs use writing tools unless a person approved them on the high,
   * once-only card that named them, on this schedule as it is now.
   */
  const requireArmedApproval = (schedule: ScheduleRecord, approvedContentHash: string | undefined, doing: string): void => {
    if (armedWritingTools(schedule).length > 0 && approvedContentHash !== keptToolsHash(schedule))
      throw new TaviError(
        "INVALID_INPUT",
        `${schedule.name} may use tools that write or send (${schedule.autoApproveTools.join(", ")}): it ${doing} only once a person approves them on its card; ask again`,
      );
  };
  /**
   * The card a resume or a run now shows of the schedule it arms: what runs, where results go and the tools it uses
   * without asking; high and once-only, bound to those tools, when any of them writes. That card is always shown,
   * whatever a rule or an earlier grant says: the handler goes on only with its approval.
   */
  /** What a card says of the schedule it addresses: what runs, where results go, the tools it uses without asking. */
  const scheduleDetail = (existing: ScheduleRecord | undefined): string =>
    existing === undefined
      ? ""
      : [
          `Runs: ${existing.prompt}`,
          deliveryText(existing.deliverTo),
          existing.autoApproveTools.length === 0 ? "" : `Uses without asking: ${existing.autoApproveTools.join(", ")}`,
        ]
          .filter((line) => line !== "")
          .join("\n")
          .slice(0, 2_000);
  /** The card of a pause or a delete: it only narrows what runs, so a medium card naming the schedule and what it runs. */
  const narrowCard =
    (verb: string, reason: string) =>
    (input: unknown, context: InvocationContext | undefined): CallAssessment => {
      const parsed = RefSchema.safeParse(input);
      const reference = parsed.success ? parsed.data.schedule : "";
      const existing = knownSchedule(context?.workspaceId, reference);
      return {
        display: { title: `${verb} schedule ${existing?.name ?? reference}`.slice(0, 300), detail: scheduleDetail(existing) },
        subjects: [],
        risk: "medium",
        reasons: [reason],
      };
    };
  const armCard = (title: string, reason: string, existing: ScheduleRecord | undefined): CallAssessment => {
    const writing = existing === undefined ? [] : armedWritingTools(existing);
    return {
      display: {
        title: title.slice(0, 300),
        detail: scheduleDetail(existing),
      },
      subjects: [],
      risk: writing.length > 0 ? "high" : "medium",
      reasons: [
        reason,
        ...(writing.length === 0 ? [] : [`lets each run use ${writing.join(", ")} without asking, which can change or send things`]),
      ],
      askWhenTainted: true,
      ...(existing === undefined || writing.length === 0
        ? {}
        : { onceOnly: true, attendedOnly: true, contentHash: keptToolsHash(existing) }),
    };
  };

  /**
   * "every Mon–Fri at 07:00 (Europe/Sofia); next Thu 29 Oct, 07:00", or the
   * workspace's zone named when it was not read yet: the cadence the fields ask
   * for over the stored one. `undefined` when they name no time at all.
   */
  const whenItRuns = (
    fields: Record<string, unknown>,
    existing: ScheduleRecord | undefined,
    zone: string | undefined,
  ): string | undefined => {
    const asked = CadenceFieldsSchema.safeParse(fields);
    if (!asked.success) return undefined;
    const timezone = asked.data.timezone ?? existing?.spec.timezone ?? zone;
    let payload: Partial<SchedulesPayload>;
    try {
      payload = cadencePayload(asked.data);
    } catch {
      // A field the write refuses: the call is refused, in words, when it runs.
      return undefined;
    }
    const parsed = ScheduleSpecSchema.safeParse(
      composeSpec({ action: "update", ...payload, timezone: timezone ?? "the workspace's zone" }, existing?.spec),
    );
    if (!parsed.success) return undefined;
    const spec = parsed.data;
    if (timezone === undefined) return cadenceReadBack(spec);
    try {
      const next = nextOccurrence(spec, options.now());
      return `${cadenceReadBack(spec)}; ${next === undefined ? "no run left" : `next ${formatReminderTime(next, spec.timezone)}`}`;
    } catch {
      // A zone the write refuses: the card says what was asked, and the call is refused when it runs.
      return cadenceReadBack(spec);
    }
  };

  /**
   * The card a create or change shows: when it runs (its days, its zone or the
   * workspace's, and its next run), where results go, what runs and the tools
   * it uses without asking; a high, once-only card for a tool that writes. A
   * change is read over the schedule it changes, so a card for "only the time"
   * still says every day it runs, and the tools it keeps.
   */
  const assess =
    (title: (input: Record<string, unknown>, existing: ScheduleRecord | undefined) => string, change: boolean) =>
    (input: unknown, context: InvocationContext | undefined): CallAssessment => {
      const fields = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      const workspaceId = context?.workspaceId;
      const existing = change && typeof fields["schedule"] === "string" ? knownSchedule(workspaceId, fields["schedule"]) : undefined;
      const patterns = Array.isArray(fields["allow"]) ? fields["allow"].map(String) : [];
      const kept = existing === undefined ? [] : keepsWritingTools(existing, fields);
      const writing = [...writingPatterns(patterns, options.tools()), ...kept];
      const workspaceZone = workspaceId === undefined ? undefined : options.workspaceTimezoneSync?.(workspaceId);
      const when = whenItRuns(fields, existing, workspaceZone);
      const asked = fields["deliverTo"] === "home" || fields["deliverTo"] === "none" ? fields["deliverTo"] : undefined;
      const deliverTo = change ? (asked ?? existing?.deliverTo) : chatDeliverTo(patterns, asked);
      return {
        display: {
          title: title(fields, existing).slice(0, 300),
          detail: [
            when === undefined ? "" : `When: ${when}`,
            !change || fields["deliverTo"] !== undefined || existing !== undefined ? deliveryText(deliverTo) : "",
            typeof fields["maxRunMinutes"] === "number" ? `Stops a run after ${fields["maxRunMinutes"]} minutes of work` : "",
            typeof fields["maxTokens"] === "number"
              ? `Stops a run once it uses more than ${tokenCountText(fields["maxTokens"])}`
              : fields["maxTokens"] === null
                ? "Removes the token ceiling"
                : "",
            asNotify(fields["notify"]) === undefined ? "" : `Tells you ${scheduleNotifyText(asNotify(fields["notify"]))}`,
            precheckLine(fields["precheck"]),
            typeof fields["prompt"] === "string" ? `Runs: ${fields["prompt"]}` : "",
            patterns.length === 0 ? "" : `Uses without asking: ${patterns.join(", ")}`,
            kept.length === 0 ? "" : `Keeps using without asking: ${existing?.autoApproveTools.join(", ") ?? ""}`,
          ]
            .filter((line) => line !== "")
            .join("\n")
            .slice(0, 2_000),
        },
        subjects: [],
        risk: writing.length > 0 ? "high" : "medium",
        reasons: [
          "An unattended run does this at each time it fires",
          ...(writing.length === 0 ? [] : [`lets each run use ${writing.join(", ")} without asking, which can change or send things`]),
        ],
        // A run's words come from the chat: under taint, or with a tool that writes, it is approved once, never for good.
        askWhenTainted: true,
        ...(writing.length === 0 ? {} : { onceOnly: true }),
        // The tools a change keeps are bound to the card: its handler goes on without `allow` only when the person approved these.
        ...(existing === undefined || kept.length === 0 ? {} : { contentHash: keptToolsHash(existing) }),
      };
    };
  /** Each tool here keeps the workspace's schedules and zone read for the card its next call shows: one read for all of a step's. */
  const refreshZone = options.refreshWorkspaceTimezone ?? options.workspaceTimezone;
  const refresh = recentRead((workspaceId) => Promise.all([remember(workspaceId), refreshZone(workspaceId)]), OFFER_READ_REUSE_MS);
  const offered = async (context: { readonly workspaceId: string }): Promise<boolean> => {
    await refresh(context.workspaceId);
    return true;
  };

  registry.register({
    id: "schedules.create",
    sink: "persist",
    version: "1.0.0",
    description:
      "Run a prompt at set times without being asked (a daily inbox summary, a weekly check, every 2 hours in work hours, monthly, once on a date): a schedule. Not for being told something once or at a time (reminders.create), nor multi-agent research that publishes a report (routines.create). Answers with readBack, when it runs, in words, and delivery, where its results go.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: CreateSchema,
    assess: assess((fields) => `Schedule ${String(fields["name"] ?? "a prompt")}`, false),
    offered,
    handler: async ({ input, context }) => {
      const parsed = CreateSchema.parse(input);
      const workspaceId = context.workspaceId;
      const timezone = parsed.timezone ?? (await options.workspaceTimezone(workspaceId));
      const deliverTo = chatDeliverTo(parsed.allow, parsed.deliverTo);
      // The same create sent again (its name already there, and every field it gives the same) makes nothing new.
      const existing = await resolveSchedule(options.repositories.schedules, workspaceId, parsed.name);
      if (existing !== undefined) {
        const sameList = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) =>
          JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
        const asked = ScheduleSpecSchema.safeParse(composeSpec({ action: "add", ...cadencePayload(parsed), timezone }, undefined));
        const same =
          existing.prompt === parsed.prompt &&
          asked.success &&
          specKey(existing.spec) === specKey(asked.data) &&
          sameList(existing.autoApproveTools, parsed.allow) &&
          (existing.deliverTo ?? "none") === (deliverTo ?? "none") &&
          (existing.maxRunMinutes ?? SCHEDULE_DEFAULT_MAX_RUN_MINUTES) === (parsed.maxRunMinutes ?? SCHEDULE_DEFAULT_MAX_RUN_MINUTES) &&
          existing.maxTokens === parsed.maxTokens &&
          (existing.notify ?? "always") === (parsed.notify ?? "always") &&
          (existing.precheck === undefined ? undefined : schedulePrecheckText(existing.precheck)) ===
            (parsed.precheck === undefined ? undefined : precheckOf(parsed.precheck));
        // Only a schedule that runs as asked is the same one again: a paused one or a routine's is not what was asked for.
        if ((await options.routineOwner(existing.scheduleId)) !== undefined)
          throw new TaviError("CONFLICT", `a routine's schedule is named ${parsed.name}: choose another name`);
        if (same && !existing.enabled)
          throw new TaviError("CONFLICT", `${parsed.name} exists and is paused: start it again with schedules.resume`);
        if (same) return { ...summary(existing, false), replayed: true };
        throw new TaviError("CONFLICT", `a schedule named ${parsed.name} exists: change it with schedules.update, or choose another name`);
      }
      const created = await writeSchedule(
        options.repositories,
        {
          action: "add",
          workspaceId,
          principalId: context.principalId,
          name: parsed.name,
          prompt: parsed.prompt,
          ...cadencePayload(parsed),
          timezone,
          ...definedOnly({
            allow: parsed.allow,
            deliverTo,
            maxRunMinutes: parsed.maxRunMinutes,
            maxTokens: parsed.maxTokens,
            notify: parsed.notify,
            precheck: parsed.precheck,
          }),
        },
        options.now(),
        writeChecks,
      );
      await remember(workspaceId);
      return summary(created, false);
    },
  });

  registry.register({
    id: "schedules.list",
    sink: "none",
    version: "1.0.0",
    description:
      "List this workspace's schedules: each one's name, when it runs (readBack), whether it is paused, the tools it may use, when it tells the person, its last run and how many runs in a row failed.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ListSchema,
    handler: async ({ context }) => {
      const schedules = (await options.repositories.schedules.list(context.workspaceId)).filter(
        (schedule) => schedule.workspaceId === context.workspaceId,
      );
      known.set(context.workspaceId, schedules);
      // One read each for every schedule's routine and last run, not two a schedule.
      const scheduleIds = schedules.map((schedule) => schedule.scheduleId);
      const [owners, lastFires, timezone] = await Promise.all([
        scheduleIds.length === 0 ? [] : options.routineOwners(scheduleIds),
        scheduleIds.length === 0 ? [] : options.repositories.schedules.latestFires(scheduleIds, 1),
        options.workspaceTimezone(context.workspaceId),
      ]);
      return {
        schedules: schedules.map((schedule, index) => {
          const last = lastFires[index]?.[0];
          return {
            ...summary(schedule, false),
            ...(owners[index] !== undefined ? { routine: true } : {}),
            ...(last === undefined ? {} : { lastRun: fireSummary(last, timezone) }),
            ...(schedule.consecutiveFailures === 0 ? {} : { failures: schedule.consecutiveFailures }),
          };
        }),
      };
    },
  });

  registry.register({
    id: "schedules.history",
    sink: "none",
    version: "1.0.0",
    description:
      "A schedule's recent runs, newest first: when each was due and why it ended so (ok, undelivered, quiet, unchanged, failed, timeout, waiting, asked, missed, overlap, disk, disabled, orphaned, manual, retry, paused). For \"why didn't my brief run on Tuesday?\".",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: HistorySchema,
    handler: async ({ input, context }) => {
      const parsed = HistorySchema.parse(input);
      const schedule = await resolveSchedule(options.repositories.schedules, context.workspaceId, parsed.schedule);
      if (schedule === undefined)
        throw new TaviError("NOT_FOUND", `no schedule ${JSON.stringify(parsed.schedule)} here: schedules.list names them`);
      if ((await options.routineOwner(schedule.scheduleId)) !== undefined)
        throw new TaviError("CONFLICT", `${schedule.name} is a routine's: routines.history lists its runs`);
      const timezone = await options.workspaceTimezone(context.workspaceId);
      const fires = await options.repositories.schedules.listFires(schedule.scheduleId, parsed.limit ?? SCHEDULE_SHOW_FIRES);
      return {
        scheduleId: schedule.scheduleId,
        name: schedule.name,
        timezone,
        fires: fires.map((fire) => fireSummary(fire, timezone)),
      };
    },
  });

  registry.register({
    id: "schedules.update",
    sink: "persist",
    version: "1.0.0",
    description:
      "Change a schedule's prompt, when it runs (times, days, monthly, yearly, once, until), tools, delivery, when it tells the person, its pre-check, or run limit. Its name stays. A routine's schedule is changed with routines.update.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: UpdateSchema,
    assess: assess((fields, existing) => `Change schedule ${existing?.name ?? String(fields["schedule"] ?? "")}`, true),
    offered,
    handler: async ({ input, context, approvedContentHash }) => {
      const parsed = UpdateSchema.parse(input);
      const schedule = await changeable(context.workspaceId, parsed.schedule);
      // A watcher's pre-check is what starts its runs: only a person sets it, as only a person makes a watcher.
      if (schedule.watch === true && parsed.precheck !== undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `${schedule.name} is a watcher: what it watches is changed by a person (tavi schedules update, the app)`,
        );
      // A change to what or when tools that write run keeps them only on the high, once-only card that named them: a
      // person approved those very tools, on this schedule. Otherwise (a card read before they were known, or no person
      // asked) they are sent again, so the card they are approved on is that one.
      if (keepsWritingTools(schedule, parsed).length > 0 && approvedContentHash !== keptToolsHash(schedule))
        throw new TaviError(
          "INVALID_INPUT",
          `${schedule.name} may use tools that write or send (${schedule.autoApproveTools.join(", ")}): send allow again with this change`,
        );
      const updated = await writeSchedule(
        options.repositories,
        {
          action: "update",
          workspaceId: context.workspaceId,
          scheduleId: schedule.scheduleId,
          ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
          ...cadencePayload(parsed),
          ...definedOnly({
            timezone: parsed.timezone,
            allow: parsed.allow,
            deliverTo: parsed.deliverTo,
            maxRunMinutes: parsed.maxRunMinutes,
            maxTokens: parsed.maxTokens,
            notify: parsed.notify,
            precheck: parsed.precheck,
          }),
        },
        options.now(),
        writeChecks,
      );
      await remember(context.workspaceId);
      return summary(updated, false);
    },
  });

  for (const [name, id, enabled] of [
    ["pause", SCHEDULES_PAUSE_ID, false],
    ["resume", SCHEDULES_RESUME_ID, true],
  ] as const) {
    registry.register({
      id,
      sink: "persist",
      version: "1.0.0",
      description:
        name === "pause"
          ? 'Stop a schedule from running until resumed ("stop my morning summary"). It keeps its settings.'
          : "Start a paused schedule again, from its next time.",
      effect: "mutating",
      requiredPermissions: ["tools.invoke"],
      inputSchema: RefSchema,
      annotations: { idempotent: true },
      // Pausing only narrows what runs; resuming re-arms the schedule's tools, so its card names them.
      assess: enabled
        ? (input: unknown, context: InvocationContext | undefined): CallAssessment => {
            const parsed = RefSchema.safeParse(input);
            const reference = parsed.success ? parsed.data.schedule : "";
            const existing = knownSchedule(context?.workspaceId, reference);
            return armCard(`Resume schedule ${existing?.name ?? reference}`, "An unattended run does this at each time it fires", existing);
          }
        : narrowCard("Pause", "It stops running until resumed; its settings stay"),
      offered,
      handler: async ({ input, context, approvedContentHash }) => {
        const parsed = RefSchema.parse(input);
        const schedule = await changeable(context.workspaceId, parsed.schedule);
        if (enabled) requireArmedApproval(schedule, approvedContentHash, "starts again");
        const changed = await setScheduleEnabled(options.repositories.schedules, schedule, enabled, options.now());
        await remember(context.workspaceId);
        return summary(changed, false);
      },
    });
  }

  registry.register({
    id: SCHEDULES_RUN_NOW_ID,
    // A run sends what its schedule sends: its result to Home, and what its tools may send without asking.
    sink: "message",
    version: "1.0.0",
    description:
      "Run a schedule once now, as it would run at its time, without changing when it next runs. Answers the run's taskId once it starts; schedules.history lists how it ended.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: RefSchema,
    assess: (input: unknown, context: InvocationContext | undefined): CallAssessment => {
      const parsed = RefSchema.safeParse(input);
      const reference = parsed.success ? parsed.data.schedule : "";
      const existing = knownSchedule(context?.workspaceId, reference);
      return armCard(
        `Run schedule ${existing?.name ?? reference} now`,
        "An unattended run does now what the schedule does at its time",
        existing,
      );
    },
    offered,
    handler: async ({ input, context, approvedContentHash }) => {
      const parsed = RefSchema.parse(input);
      const schedule = await changeable(context.workspaceId, parsed.schedule);
      requireArmedApproval(schedule, approvedContentHash, "runs now");
      if (options.runNow === undefined)
        throw new TaviError("UNAVAILABLE", "Schedules cannot be run here: the owner's scheduler is not running");
      const { taskId, outcome } = await options.runNow(schedule);
      const named = { scheduleId: schedule.scheduleId, name: schedule.name };
      if (taskId !== undefined) return { ...named, started: true, taskId };
      switch (outcome?.kind) {
        case "ran":
          return { ...named, started: true, taskId: outcome.taskId };
        case "skipped":
          return { ...named, started: false, reason: outcome.reason === "overlap" ? "its previous run is still going" : outcome.reason };
        case "refused":
          return { ...named, started: false, reason: outcome.reason };
        case "routine":
          return { ...named, started: false, reason: "routine" };
        case undefined:
          return { ...named, started: false, reason: "it did not start" };
      }
    },
  });

  registry.register({
    id: "schedules.cancel",
    sink: "persist",
    version: "1.0.0",
    description: "Delete a schedule for good. To stop it for now, use schedules.pause.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: RefSchema,
    annotations: { destructive: true, idempotent: true },
    assess: narrowCard("Delete", "It is deleted for good, with its history"),
    offered,
    handler: async ({ input, context }) => {
      const parsed = RefSchema.parse(input);
      const schedule = await changeable(context.workspaceId, parsed.schedule);
      await options.repositories.schedules.remove(schedule.scheduleId);
      options.webhookIds?.delete(schedule.scheduleId);
      await remember(context.workspaceId);
      return { removed: schedule.scheduleId, name: schedule.name };
    },
  });
}
