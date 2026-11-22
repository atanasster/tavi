import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { TaviError } from "./errors.js";
import { cadenceTimes, daysOfWeekText, reminderOccurrenceSeries, repeatDaysText, type RepeatCadence } from "./reminders.js";
import {
  MISSED_RUN_GRACE_MS,
  ReminderMonthlySchema,
  ReminderYearlySchema,
  SCHEDULE_TIME_PATTERN,
  instantForLocalTime,
  isValidTimeZone,
  localDateTime,
  yearlyDayExists,
} from "./schedule-time.js";
import { STALE_WEB_PATTERN_MESSAGE, isStaleWebPattern } from "./tool-policy.js";
import type { SchedulePrecheck, SchedulePrecheckState } from "./schedule-precheck.js";
import { definedOnly } from "./util.js";
import { coreEnglish, type CoreT } from "./locales/core.js";
import { renderTextRef, textRef, type TextRef } from "./text-ref.js";

/**
 * Recurring schedules.
 *
 * A schedule is an **operator-authored, durable** description of work to
 * perform unattended — never model-authored. That distinction is load-bearing:
 * the whole reason an unattended run can be allowed to call
 * `messaging.send_to` or `reports.generate` without a human present is that the
 * operator, not the model, decided in advance which tools a given schedule may
 * use and where its output goes.
 *
 * Reminders (`reminders.ts`) are the one scheduled record a model may
 * author, because they gain no unattended authority: a fire delivers the
 * reminder's own text to the conversation it was asked in (or a delivery
 * target the operator added), or starts a task with no pre-approved tools
 * whose every approval is asked of the person in that same place. What a
 * schedule is trusted with — tools that run with nobody present, and a
 * destination for their output — a reminder never has.
 *
 * The trigger is deliberately not a general cron expression. The need is
 * "every morning at 07:00", a few times a day, a day-of-week mask, a day each
 * month or year, a one-off date, an end date, or every few hours through a
 * working day; a full cron grammar would add a dependency (and this workspace
 * pins its dependency set deliberately) for expressive power nothing in the
 * scenario needs. Each shape is a field of `ScheduleSpec`, and they all fire
 * through the one occurrence engine reminders use (`reminderOccurrenceSeries`).
 */

export { MISSED_RUN_GRACE_MS, SCHEDULE_TIME_PATTERN };

/** Times one schedule may name in a day (`times`); a window (`everyHours`) is bounded by its step instead. */
export const SCHEDULE_MAX_TIMES_PER_DAY = 6;
/** The longest step of `everyHours`: a longer one is a few `times`. The shortest is an hour, so a cadence never costs more than a run an hour. */
export const SCHEDULE_MAX_EVERY_HOURS = 12;

const ScheduleTimeSchema = z.string().regex(SCHEDULE_TIME_PATTERN, "expected a 24-hour HH:MM time");
const ScheduleDateSchema = z.iso.date();

/**
 * The fields of `ScheduleSpec`, which a routine's recurring trigger shares
 * (`RoutineTriggerSchema`). Of the times of day, exactly one of `at`, `times`
 * or `everyHours` is given; of the days, at most one of `daysOfWeek`,
 * `monthly`, `yearly` or `once` (none is every day).
 */
export const scheduleSpecFields = {
  /** One local wall-clock firing time, e.g. `"07:00"`. Every stored schedule from before `times` has it. */
  at: ScheduleTimeSchema.optional(),
  /** Several times a day, at most `SCHEDULE_MAX_TIMES_PER_DAY`; a single time is written as `at`. */
  times: z.array(ScheduleTimeSchema).min(1).max(SCHEDULE_MAX_TIMES_PER_DAY).optional(),
  /** IANA zone, e.g. `"Europe/Sofia"`. */
  timezone: z.string().min(1).max(64),
  /**
   * Days of the week to fire on, `0` = Sunday … `6` = Saturday. Omitted
   * means every day — the default, so the common case needs no mask.
   */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  /** Once a month: on a day of the month (31 is a shorter month's last day), or its nth weekday. */
  monthly: ReminderMonthlySchema.optional(),
  /** Once a year, on a month's day (29 February is the 28th in a year without one). */
  yearly: ReminderYearlySchema.optional(),
  /** Only on this local date, `YYYY-MM-DD`: the schedule then ends. */
  once: ScheduleDateSchema.optional(),
  /** The last local date it fires on, inclusive: the schedule then ends. */
  until: ScheduleDateSchema.optional(),
  /** Every this many hours (1–12) through the day, or through `between`. */
  everyHours: z.number().int().min(1).max(SCHEDULE_MAX_EVERY_HOURS).optional(),
  /** The active window `everyHours` steps through, wall-clock `from`–`to` inclusive. Absent: 00:00–23:59. */
  between: z.strictObject({ from: ScheduleTimeSchema, to: ScheduleTimeSchema }).optional(),
};

type ScheduleSpecShape = {
  readonly at?: string | undefined;
  readonly times?: readonly string[] | undefined;
  readonly daysOfWeek?: readonly number[] | undefined;
  readonly monthly?: unknown;
  readonly yearly?: { readonly month: number; readonly day: number } | undefined;
  readonly once?: string | undefined;
  readonly until?: string | undefined;
  readonly everyHours?: number | undefined;
  readonly between?: { readonly from: string; readonly to: string } | undefined;
};

/**
 * Why a spec's fields do not make one cadence, as messages people read (each
 * with the field it is about); none for a spec that does. The schema's own
 * refinement, exported so a caller can say it before a write.
 */
export function scheduleSpecProblems(spec: ScheduleSpecShape): readonly { readonly path: string; readonly message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const timeFields = [spec.at, spec.times, spec.everyHours].filter((part) => part !== undefined).length;
  if (timeFields !== 1)
    problems.push({
      path: "at",
      message: "A schedule runs at one time (at), at several (times), or every few hours (everyHours): one of them",
    });
  if (spec.times !== undefined && new Set(spec.times).size !== spec.times.length)
    problems.push({ path: "times", message: "Each time may be named only once" });
  if (spec.between !== undefined && spec.everyHours === undefined)
    problems.push({ path: "between", message: "between is the window everyHours runs in: give everyHours too" });
  if (spec.between !== undefined && spec.between.from >= spec.between.to)
    problems.push({ path: "between", message: "between must end after it starts, within one day" });
  if ([spec.daysOfWeek, spec.monthly, spec.yearly, spec.once].filter((part) => part !== undefined).length > 1)
    problems.push({ path: "monthly", message: "A schedule runs on days of the week, monthly, yearly or once: one of them" });
  if (spec.once !== undefined && spec.until !== undefined)
    problems.push({ path: "until", message: "A schedule that runs once has no until" });
  if (spec.yearly !== undefined && !yearlyDayExists(spec.yearly)) problems.push({ path: "yearly", message: "That month has no such day" });
  return problems;
}

/** `HH:MM-HH:MM` as the window `everyHours` runs in (`between`), or `undefined` when it is not that shape of two times. */
export function parseScheduleWindow(text: string): { readonly from: string; readonly to: string } | undefined {
  const [from, to, ...rest] = text.trim().split("-");
  if (from === undefined || to === undefined || rest.length > 0) return undefined;
  if (!SCHEDULE_TIME_PATTERN.test(from) || !SCHEDULE_TIME_PATTERN.test(to)) return undefined;
  return { from, to };
}

/**
 * When a schedule fires.
 *
 * `timezone` is stored rather than derived from the host clock: "7am" is
 * otherwise ambiguous, and a machine that changes
 * region (or a container whose `TZ` is UTC) would silently shift the brief.
 * The zone is applied by the trigger calculator, which handles DST.
 */
export const ScheduleSpecSchema = z
  .strictObject(scheduleSpecFields)
  .superRefine((spec, context) => {
    for (const problem of scheduleSpecProblems(spec)) context.addIssue({ code: "custom", path: [problem.path], message: problem.message });
  })
  .describe("When a schedule fires, in an explicit IANA timezone.");
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

/** Whether a spec ends by itself: one that runs `once`, or `until` a date. Once its last run is claimed it has no next occurrence, and it is finished rather than broken. */
export function scheduleSpecEnds(spec: Pick<ScheduleSpec, "once" | "until">): boolean {
  return spec.once !== undefined || spec.until !== undefined;
}

/** A spec as the occurrence engine reads it (`reminderOccurrenceSeries`). */
export function scheduleCadence(spec: ScheduleSpec): RepeatCadence {
  return {
    kind: "repeat",
    times: spec.times ?? (spec.at === undefined ? [] : [spec.at]),
    ...(spec.everyHours === undefined
      ? {}
      : { everyHours: { hours: spec.everyHours, from: spec.between?.from ?? "00:00", to: spec.between?.to ?? "23:59" } }),
    ...definedOnly({ daysOfWeek: spec.daysOfWeek, monthly: spec.monthly, yearly: spec.yearly }),
    ...(spec.once === undefined ? {} : { from: spec.once, until: spec.once }),
    ...(spec.until === undefined ? {} : { until: spec.until }),
  };
}

/** The times of day a spec fires at, sorted: its `at`, its `times`, or each step of its `everyHours` window. */
export function scheduleTimes(spec: ScheduleSpec): readonly string[] {
  return cadenceTimes(scheduleCadence(spec));
}

/** No spec waits longer than this for its next fire: a yearly one's year, a leap day and a margin. */
const NEXT_OCCURRENCE_HORIZON_MS = 740 * 86_400_000;

/**
 * The first instant strictly after `after` at which `spec` fires, or
 * `undefined` when it fires no more (a `once` or `until` spec that has
 * ended). Read from `reminderOccurrenceSeries`, the occurrence engine every
 * scheduled thing shares, which walks the schedule's own zone day by day: the
 * day a clock changes has two possible UTC offsets and the answer depends on
 * which side of the transition the candidate lands. A zone `Intl` does not
 * know is refused as the operator's input (`INVALID_INPUT`).
 */
export function nextOccurrence(spec: ScheduleSpec, after: Date): Date | undefined {
  try {
    const begins = spec.once === undefined ? after.getTime() : Math.max(after.getTime(), Date.parse(`${spec.once}T00:00:00.000Z`));
    const next = reminderOccurrenceSeries(
      { when: scheduleCadence(spec), timezone: spec.timezone },
      after,
      new Date(begins + NEXT_OCCURRENCE_HORIZON_MS),
    ).next();
    return next.done === true ? undefined : next.value.at;
  } catch (error) {
    // An unknown zone makes `Intl` throw a bare `RangeError`, which reached the
    // operator as an internal failure rather than the usage error it is. Only
    // a *zone* RangeError is reclassified: a non-finite instant throws one too,
    // and blaming the timezone for that would send the operator after the
    // wrong input.
    if (error instanceof RangeError && !isValidTimeZone(spec.timezone)) {
      throw new TaviError("INVALID_INPUT", `Schedule timezone ${JSON.stringify(spec.timezone)} is not a known IANA time zone`, {
        details: { timezone: spec.timezone },
      });
    }
    throw error;
  }
}

/**
 * Every fire of `spec` strictly after `after` and strictly before `until`,
 * earliest first, with the time of day each is for. Lazy, as the engine is.
 */
export function* scheduleOccurrences(
  spec: ScheduleSpec,
  after: Date,
  until: Date,
): Generator<{ readonly at: Date; readonly time: string }, undefined> {
  for (const fire of reminderOccurrenceSeries({ when: scheduleCadence(spec), timezone: spec.timezone }, after, until)) {
    yield { at: fire.at, time: fire.time ?? "" };
  }
  return undefined;
}

/**
 * How far back from now the scheduler looks for the occurrence a late fire is
 * for: more than a week for a spec that fires each week or more often, more
 * than a year for a monthly or yearly one.
 */
export function scheduleCatchUpLookbackMs(spec: Pick<ScheduleSpec, "monthly" | "yearly">): number {
  return (spec.monthly === undefined && spec.yearly === undefined ? 8 : 400) * 86_400_000;
}

/**
 * When a spec runs, in words: as a sentence says it ("every day at 07:00
 * (Europe/Sofia)", "every Mon–Fri, every 2 hours from 08:00 to 18:00
 * (Europe/Sofia)") or as a label leads with it (`"label"`: "Daily 07:00 ·
 * Europe/Sofia", "Monthly on the 1st, 09:00, 18:00 · Europe/Sofia"). The CLI,
 * the tools' read-backs and the web app say a schedule's and a routine
 * trigger's cadence through it.
 */
export function scheduleSpecText(spec: ScheduleSpec, style: "sentence" | "label" = "sentence", t: CoreT = coreEnglish): string {
  const sentence = style === "sentence";
  const weekdays = daysOfWeekText(spec.daysOfWeek, t);
  const pattern = spec.monthly !== undefined || spec.yearly !== undefined;
  const days =
    spec.once !== undefined
      ? t(sentence ? "schedule.spec.once" : "schedule.spec.onceLabel", { date: spec.once })
      : pattern
        ? repeatDaysText({ monthly: spec.monthly, yearly: spec.yearly }, style, t)
        : weekdays === undefined
          ? t(sentence ? "schedule.spec.everyDay" : "schedule.spec.daily")
          : sentence
            ? t("schedule.spec.everyWeekdays", { weekdays })
            : weekdays;
  const listed = [...(spec.times ?? (spec.at === undefined ? [] : [spec.at]))].sort();
  const from = spec.between?.from ?? "00:00";
  const to = spec.between?.to ?? "23:59";
  const dated = pattern || spec.once !== undefined;
  const hours = spec.everyHours;
  if (sentence) {
    const text =
      hours !== undefined
        ? t("schedule.spec.sentenceEvery", {
            days,
            step: t("schedule.spec.everyHours", { count: hours }),
            from,
            to,
            timezone: spec.timezone,
          })
        : t("schedule.spec.sentenceAt", { days, times: listAnd(listed, t), timezone: spec.timezone });
    return spec.until === undefined ? text : t("schedule.spec.until", { spec: text, date: spec.until });
  }
  const label =
    hours !== undefined
      ? t(dated ? "schedule.spec.labelEveryDated" : "schedule.spec.labelEvery", {
          days,
          step: t("schedule.spec.everyHoursShort", { count: hours }),
          from,
          to,
        })
      : t(dated ? "schedule.spec.labelAtDated" : "schedule.spec.labelAt", { days, times: listed.join(", ") });
  const until = spec.until === undefined ? label : t("schedule.spec.until", { spec: label, date: spec.until });
  return t("schedule.spec.labelZone", { spec: until, timezone: spec.timezone });
}

/** Times as a sentence lists them: "07:00, 12:00 and 19:00". */
function listAnd(items: readonly string[], t: CoreT): string {
  return items.length <= 1
    ? items.join("")
    : t("schedule.spec.listAnd", { items: items.slice(0, -1).join(", "), last: items.at(-1) ?? "" });
}

/**
 * What to do about a fire whose time passed while no process was running.
 *
 * A machine asleep at 07:00 is the most likely real-world failure, and the
 * two behaviours are genuinely different products: catching up gives a
 * brief shortly after boot (possibly hours late, with a stale window), while
 * skipping keeps the run count predictable and logs the miss. Both are offered
 * rather than one being chosen for the operator.
 */
export const MISSED_RUN_POLICIES = ["run-once-if-missed-within-6h", "skip"] as const;
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];
export const MissedRunPolicySchema = z.enum(MISSED_RUN_POLICIES);

/**
 * The tool ids a schedule may call without a human present, matched as an
 * exact id or a `prefix.*` family (`http.*`, `reports.*`).
 *
 * Semantics are **allowlist, deny by default**: a tool not named here is
 * denied when a scheduled run asks for it, durably, the same way
 * `tavi run --approval deny` answers. `sandbox.run` therefore stays denied
 * unless an operator deliberately adds it, which is the intended shape — the
 * governance machinery is a strength, and the fix for unattended use is a
 * scoped policy rather than a blanket auto-approve.
 */
export const SCHEDULE_TOOL_PATTERN = /^(\*|web_\*|[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(\.\*)?)$/;

export const ScheduleToolPatternSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SCHEDULE_TOOL_PATTERN, "expected a tool id, a `prefix.*` family, or `*`")
  .refine((pattern) => !isStaleWebPattern(pattern), STALE_WEB_PATTERN_MESSAGE);

/** Whether a schedule's fire may ask a person; the same choice a routine has. */
export const SCHEDULE_HUMAN_CHECKPOINTS = ["off", "ask-with-default"] as const;
export type ScheduleHumanCheckpoints = (typeof SCHEDULE_HUMAN_CHECKPOINTS)[number];

/** Where a schedule's failure alert goes. Both parts are required together — a connection with no destination cannot be sent to. */
export const ScheduleAlertTargetSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  destination: z.string().min(1).max(256),
});
export type ScheduleAlertTarget = z.infer<typeof ScheduleAlertTargetSchema>;

/**
 * Where a schedule's run's result goes besides what the run itself sends:
 * `home` posts it into the schedule's person's Home as a notice when
 * the run settles. Channel delivery stays the run's own `messaging.send_to`,
 * with the `run-undelivered` alert when it sent nothing.
 */
export const SCHEDULE_DELIVERY_TARGETS = ["home"] as const;
export type ScheduleDeliveryTarget = (typeof SCHEDULE_DELIVERY_TARGETS)[number];

/**
 * When a schedule's person hears from a run that went well:
 *
 * - `always`: every completed run delivers, and one that may send and sent
 *   nothing is alerted as undelivered (the default, and what an absent value means).
 * - `when-sent`: only a run with something to tell. One that attempted no
 *   `messaging.send_to`, or ended with `SCHEDULE_NOTHING_TO_REPORT`, is a quiet
 *   success: nothing is posted to Home and nothing alerted. A send the
 *   connector refused is still undelivered.
 * - `if-changed`: as `always`, except that a result the same as the last one
 *   delivered (`lastDeliveredHash`) is not delivered again, to Home or to the
 *   schedule's own delivery target, and a run that ended with
 *   `SCHEDULE_NOTHING_TO_REPORT` is quiet too.
 *
 * Failures are told whatever this says.
 */
export const SCHEDULE_NOTIFY_MODES = ["always", "when-sent", "if-changed"] as const;
export type ScheduleNotify = (typeof SCHEDULE_NOTIFY_MODES)[number];
export const ScheduleNotifySchema = z.enum(SCHEDULE_NOTIFY_MODES);

/** When a schedule's runs tell its person, in words: the CLI's `show`, the tools' answers and the web page say it alike. */
export function scheduleNotifyText(notify: ScheduleNotify | undefined, t: CoreT = coreEnglish): string {
  if (notify === "when-sent") return t("schedule.notify.whenSent");
  if (notify === "if-changed") return t("schedule.notify.ifChanged");
  return t("schedule.notify.always");
}

/**
 * The whole final answer a run of a schedule that does not always notify ends
 * with when it has nothing to tell. Read by the scheduler, never shown.
 */
export const SCHEDULE_NOTHING_TO_REPORT = "[nothing to report]";

/** Whether a run's final text is the nothing-to-report marker, and nothing else. */
export function isNothingToReport(text: string | undefined): boolean {
  return text !== undefined && text.trim().toLowerCase() === SCHEDULE_NOTHING_TO_REPORT;
}

/**
 * A delivered result as `if-changed` compares it: its words with surrounding
 * and repeated whitespace dropped, so a re-wrapped line is the same result.
 */
export function normalisedDelivery(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * How long a fire's run may work before it is stopped, when its schedule names
 * no limit. Generous: a brief that completes today is not cut, while a run that
 * hangs no longer holds the schedule (every later fire skipped as an overlap)
 * indefinitely.
 */
export const SCHEDULE_DEFAULT_MAX_RUN_MINUTES = 30;

/**
 * A schedule's own run limit, in minutes: at least one, at most a day. The time
 * the run, or a worker it spawned, works counts; the time either waits — on a
 * person's answer, a worker or a deadline, each with its own — does not.
 */
export const ScheduleMaxRunMinutesSchema = z.number().int().min(1).max(1440);

/** The run limit a schedule's fires are held to, in minutes. */
export function scheduleMaxRunMinutes(schedule: { readonly maxRunMinutes?: number | undefined }): number {
  return schedule.maxRunMinutes ?? SCHEDULE_DEFAULT_MAX_RUN_MINUTES;
}

/**
 * A schedule's own token ceiling per fire: how many tokens its run, and the
 * workers it spawned, may use before it is stopped, as model accounting counts
 * them (input and output). Off unless set.
 */
export const ScheduleMaxTokensSchema = z.number().int().min(1_000).max(100_000_000);

/**
 * The token ceiling a run a webhook call or an email started has when its
 * schedule sets none: an event comes from outside, up to 12 times an hour, so
 * its runs are never unbounded. A schedule's own `maxTokens` replaces it.
 */
export const SCHEDULE_EVENT_MAX_TOKENS = 250_000;

/**
 * About one model call of a schedule's run: its first call alone carries the system prompt and the tool list
 * (about 25,000 tokens in the walks), and a ceiling is checked as each call ends, so one below this is passed by the
 * call that crossed it. A ceiling under it is warned about, not refused.
 */
export const SCHEDULE_ONE_CALL_TOKENS = 30_000;

/** The token ceiling a fire runs under: the schedule's own, or for a webhook's or an email's run with none, `SCHEDULE_EVENT_MAX_TOKENS`. */
export function scheduleFireMaxTokens(schedule: { readonly maxTokens?: number | undefined }, event: boolean): number | undefined {
  return schedule.maxTokens ?? (event ? SCHEDULE_EVENT_MAX_TOKENS : undefined);
}

/** A token count as people read it: "12,345 tokens". */
export function tokenCountText(tokens: number, t: CoreT = coreEnglish): string {
  return t("schedule.tokens", { count: Math.round(tokens) });
}

/** A token count as typed (digits, with `_` or `,` between them), or `undefined` when it is not one `schema` accepts. */
export function parseTokenCount(value: string, schema: z.ZodNumber): number | undefined {
  const digits = value.trim().replace(/[_,]/g, "");
  if (!/^\d{1,16}$/.test(digits)) return undefined;
  const parsed = schema.safeParse(Number(digits));
  return parsed.success ? parsed.data : undefined;
}

/** What a schedule's token ceiling says, in words: `undefined` when it has none. */
export function scheduleMaxTokensText(schedule: { readonly maxTokens?: number | undefined }, t: CoreT = coreEnglish): string | undefined {
  return schedule.maxTokens === undefined ? undefined : t("schedule.maxTokens", { tokens: tokenCountText(schedule.maxTokens, t) });
}

/**
 * How long after a run that failed on provider weather (`ProviderFailureClass`
 * `transient`: a rate limit, a retryable provider fault) its fire is tried
 * again, one entry per retry: at most three, and never once the original fire
 * is past `MISSED_RUN_GRACE_MS` or the next regular fire comes first. A run
 * that already did something — any tool call with an effect — is not retried.
 */
export const SCHEDULE_RETRY_BACKOFF_MINUTES: readonly number[] = [2, 10, 30];

/** How many failed runs in a row pause a schedule (`pausedReason: "failures"`). */
export const SCHEDULE_PAUSE_AFTER_FAILURES = 3;

/**
 * Why a schedule is paused when a person did not pause it: `failures`, its
 * runs failed `SCHEDULE_PAUSE_AFTER_FAILURES` times in a row. Resuming it
 * clears the reason and the count.
 */
export const SCHEDULE_PAUSED_REASONS = ["failures"] as const;
export type SchedulePausedReason = (typeof SCHEDULE_PAUSED_REASONS)[number];

/**
 * A schedule's webhook while it is on: when its current secret was made. The secret itself is never kept, only its
 * SHA-256; its signing key is kept encrypted with the credential key.
 */
export interface ScheduleWebhookState {
  readonly since: string;
}

/** The most bytes a call to a schedule's webhook may carry; a larger one is refused (413). */
export const SCHEDULE_WEBHOOK_MAX_PAYLOAD_BYTES = 8 * 1024;
/** A schedule's webhook fires it at most once in this many milliseconds… */
export const SCHEDULE_WEBHOOK_MIN_INTERVAL_MS = 60_000;
/** …and at most this many times an hour; a call past either is refused (429). */
export const SCHEDULE_WEBHOOK_MAX_PER_HOUR = 12;
/** How far a signed call's timestamp may be from the owner's clock, either way. */
export const SCHEDULE_WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/** The path a schedule's webhook answers at, under the ingress's public address. */
export function scheduleWebhookPath(scheduleId: string): string {
  return `/hooks/schedules/${encodeURIComponent(scheduleId)}`;
}

/** The most senders an email trigger lists. */
export const SCHEDULE_EMAIL_MAX_SENDERS = 20;
/** The most bytes of an email's subject and text an email trigger's run is given; the rest is cut. */
export const SCHEDULE_EMAIL_MAX_TEXT_BYTES = 8 * 1024;
/** The longest subject filter. */
export const SCHEDULE_EMAIL_SUBJECT_MAX = 200;

/**
 * One sender an email trigger accepts: an exact address (`ann@example.com`) or
 * every address at one domain (`@example.com`, that domain only, not its
 * subdomains). Lower-cased; no wildcards.
 */
export const ScheduleEmailSenderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(
    /^(?:[^\s@"<>(),;:\\[\]*]+)?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    "A sender is an address (ann@example.com) or a domain (@example.com)",
  );

/**
 * What a person sets on an email trigger: the email connection it listens on,
 * the senders whose mail fires it (at least one), and, optionally, text its
 * subject must hold (any case).
 */
export const ScheduleEmailTriggerInputSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  senders: z.array(ScheduleEmailSenderSchema).min(1).max(SCHEDULE_EMAIL_MAX_SENDERS),
  subject: z.string().trim().min(1).max(SCHEDULE_EMAIL_SUBJECT_MAX).optional(),
});
export type ScheduleEmailTriggerInput = z.infer<typeof ScheduleEmailTriggerInputSchema>;

/**
 * A schedule's email trigger while it is on: an email on its connection from
 * a listed sender whose domain the channel verified (a DMARC-style pass with
 * relaxed alignment: the domain, not the person), fires the schedule now, its
 * subject and text quoted to the run as untrusted data in a reader session
 * (`TaskExecutionPolicy.readOnlyTools`).
 * Off by default; only a person turns one on.
 */
export const ScheduleEmailTriggerSchema = ScheduleEmailTriggerInputSchema.extend({ since: z.string().min(1).max(64) });
export type ScheduleEmailTrigger = z.infer<typeof ScheduleEmailTriggerSchema>;

/** Whether an address is one an email trigger's `senders` names: exactly, or by its domain. */
export function scheduleEmailSenderListed(senders: readonly string[], address: string): boolean {
  const sender = address.trim().toLowerCase();
  const at = sender.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = sender.slice(at);
  return senders.some((listed) => (listed.startsWith("@") ? listed === domain : listed === sender));
}

/** Whether an email's subject holds an email trigger's subject filter (any case); with no filter, every subject does. */
export function scheduleEmailSubjectMatches(trigger: Pick<ScheduleEmailTrigger, "subject">, subject: string | undefined): boolean {
  if (trigger.subject === undefined) return true;
  return (subject ?? "").toLowerCase().includes(trigger.subject.toLowerCase());
}

/** An email trigger in a line: where it listens, whom it takes mail from, and its subject filter. */
export function scheduleEmailTriggerSentence(trigger: ScheduleEmailTrigger | undefined, t: CoreT = coreEnglish): string {
  if (trigger === undefined) return t("schedule.email.off");
  const words = { connection: trigger.connectionId, senders: trigger.senders.join(", ") };
  return trigger.subject === undefined
    ? t("schedule.email.on", words)
    : t("schedule.email.onSubject", { ...words, subject: trigger.subject });
}

/**
 * A watcher: a schedule whose trigger is a change rather than a time. It is a
 * schedule with a pre-check and an `everyHours` cadence, marked `watch`: each
 * fire of the cadence checks, and runs only when something changed. A
 * `file-changed` watcher also checks soon after its file changes while the
 * owner runs: a quiet spell of `SCHEDULE_WATCH_DEBOUNCE_MS` after the last
 * change, then at most one check a `SCHEDULE_WATCH_MIN_INTERVAL_MS` and
 * `SCHEDULE_WATCH_MAX_PER_HOUR` an hour. Off unless a person makes one.
 */
export const SCHEDULE_WATCH_DEBOUNCE_MS = 30_000;
/** A file watcher's change checks at most once in this many milliseconds… */
export const SCHEDULE_WATCH_MIN_INTERVAL_MS = 60_000;
/** …and at most this many an hour; a change past either waits until one is allowed. */
export const SCHEDULE_WATCH_MAX_PER_HOUR = 12;
/**
 * A file watcher whose changes ran it this many times in a row within an hour, each finding a change, has its
 * prompt checks stopped for an hour, its person told once: until then only its cadence checks.
 */
export const SCHEDULE_WATCH_MAX_RUNS_IN_A_ROW = 6;
/** How often a watcher checks when none is given: every hour. */
export const SCHEDULE_WATCH_DEFAULT_EVERY_HOURS = 1;

/** What a watcher does, in words: "watches the page https://… every hour; runs only when it changes". */
export function scheduleWatchSentence(
  schedule: { readonly precheck?: SchedulePrecheck; readonly spec: ScheduleSpec },
  t: CoreT = coreEnglish,
): string | undefined {
  const { precheck, spec } = schedule;
  if (precheck === undefined) return undefined;
  const cadence =
    spec.everyHours === undefined
      ? t("schedule.watch.at", { times: scheduleTimes(spec).join(", ") })
      : t("schedule.spec.everyHours", { count: spec.everyHours });
  const every =
    spec.between === undefined ? cadence : t("schedule.watch.between", { every: cadence, from: spec.between.from, to: spec.between.to });
  const key =
    precheck.kind === "page-changed"
      ? "schedule.watch.page"
      : precheck.kind === "feed-has-new"
        ? "schedule.watch.feed"
        : "schedule.watch.file";
  return t(key, { target: precheck.target, every });
}

/** A schedule's fire armed to be tried again: which retry it is, and the occurrence it retries. */
export interface ScheduleRetry {
  /** 1 for the first retry, up to `SCHEDULE_RETRY_BACKOFF_MINUTES.length`. */
  readonly count: number;
  /** The occurrence the retry is for, ISO-8601 UTC: its grace and its ledger rows are that fire's. */
  readonly ofFireTime: string;
}

/**
 * A paused schedule's state in words, as the CLI's `show` and `list`, the
 * tools' answers and the web page say it: why it is paused and how to resume
 * it; `undefined` for one that is not paused.
 */
export function schedulePausedText(
  schedule: {
    readonly enabled: boolean;
    readonly pausedReason?: SchedulePausedReason;
    readonly spec?: ScheduleSpec;
  },
  now: Date = new Date(),
  t: CoreT = coreEnglish,
): string | undefined {
  if (schedule.enabled) return undefined;
  if (schedule.spec !== undefined && scheduleFinished(schedule.spec, now)) return t("schedule.finished");
  return schedule.pausedReason === "failures"
    ? t("schedule.paused.failures", { count: SCHEDULE_PAUSE_AFTER_FAILURES })
    : t("schedule.paused.plain");
}

/** What a schedule that ended says of itself, in English. */
export const SCHEDULE_FINISHED_TEXT = coreEnglish("schedule.finished");

/** Whether a spec that ends (`once`, `until`) has no occurrence left after `now`: a schedule of it is finished, not paused. */
export function scheduleFinished(spec: ScheduleSpec, now: Date): boolean {
  if (!scheduleSpecEnds(spec)) return false;
  try {
    return nextOccurrence(spec, now) === undefined;
  } catch {
    return false;
  }
}

export interface ScheduleRecord {
  /** Present on owner list responses for revision-managed schedules. */
  readonly routineId?: string;
  readonly scheduleId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly name: string;
  /** The operator-authored instruction admitted to the model on each fire. */
  readonly prompt: string;
  readonly spec: ScheduleSpec;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly autoApproveTools: readonly string[];
  /**
   * The agent definition this schedule runs as, or
   * `undefined` for the runtime's base instructions.
   *
   * This is how "the chief of staff runs every morning" is expressed: the
   * persona belongs to the agent, and the schedule says *when* it runs and what
   * it may do unattended. A reference, like the task's own
   * `InvocationContext.agentDefinitionId` — validated when the fire is admitted.
   */
  readonly agentId?: string;
  /**
   * Where a failure alert is sent, when the operator configured one. Silence
   * at 07:00 is the worst outcome — a run that fails without telling
   * anyone is indistinguishable from a machine that is off.
   */
  readonly alert?: ScheduleAlertTarget;
  /**
   * Whether a fire may stop to ask a question in the alert destination:
   * absent is `off`. `ask-with-default` asks only with options and a default,
   * and goes on with the default if nobody answers before the next fire.
   */
  readonly humanCheckpoints?: ScheduleHumanCheckpoints;
  /** `home`: the run's result is posted into the person's Home when it settles. Absent: none. */
  readonly deliverTo?: ScheduleDeliveryTarget;
  /** How long a fire's run may work before it is stopped and recorded failed. Absent: `SCHEDULE_DEFAULT_MAX_RUN_MINUTES`. */
  readonly maxRunMinutes?: number;
  /** How many tokens a fire's run, its workers included, may use before it is stopped and recorded failed. Absent: no ceiling. */
  readonly maxTokens?: number;
  /**
   * The host folder its fires work in (a real path), pinned by a person as a routine's is: checked against the
   * owner's `--fs-root` folders when it is set and again at each fire, whose run fails, saying why, when it no
   * longer passes. Absent: each fire works in its own managed folder. Never set by the model.
   */
  readonly folder?: string;
  /** When a run that went well tells its person. Absent: `always`. */
  readonly notify?: ScheduleNotify;
  /**
   * SHA-256 of the normalised (`normalisedDelivery`) last result an `if-changed`
   * schedule delivered, which an identical result is not delivered again over.
   */
  readonly lastDeliveredHash?: string;
  /** A read-only look before each scheduled fire; a fire it finds nothing new for makes no model call. Absent: every fire runs. */
  readonly precheck?: SchedulePrecheck;
  /** What the pre-check last read, which the next check compares with. Absent until a run took a reading as its baseline. */
  readonly precheckState?: SchedulePrecheckState;
  /** Its webhook, while one is on: a call with its secret fires it now. Absent: no webhook, and its address answers nothing. */
  readonly webhook?: ScheduleWebhookState;
  /** Its email trigger, while one is on (`ScheduleEmailTrigger`). Absent: no email fires it. */
  readonly emailTrigger?: ScheduleEmailTrigger;
  /** A watcher (`scheduleWatchSentence`): its pre-check is its trigger. Only with a pre-check; absent: a schedule run by its time. */
  readonly watch?: true;
  readonly enabled: boolean;
  /** Why it is paused when a person did not pause it. Absent for one a person paused, or one that is not paused. */
  readonly pausedReason?: SchedulePausedReason;
  /** A failed fire armed to be tried again at `nextRunAt`, when one is. */
  readonly retry?: ScheduleRetry;
  /** Next fire, ISO-8601 UTC. `null` only for a disabled schedule that has never been armed. */
  readonly nextRunAt: string | null;
  /**
   * When the last run that started was due: a scheduled fire's fire time, or when a run asked for now (Run now, a
   * file watcher's change, a webhook call, an email) was asked for. A fire missed or skipped since leaves it.
   */
  readonly lastRunAt: string | null;
  readonly lastRunTaskId: string | null;
  /** A short operator-facing summary: the outcome, or why a fire was skipped. */
  readonly lastOutcome: string | null;
  readonly consecutiveFailures: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Why a fire ended as it did, as the fire ledger (`tavi_schedule_fires`) types it:
 *
 * - `ok`: the run completed (and delivered, where it was to send).
 * - `undelivered`: the run completed but sent nothing it was to send.
 * - `quiet`: the run completed with nothing new to tell, as its schedule's `notify` allows, so nothing was delivered.
 * - `unchanged`: its schedule's pre-check found nothing new, so nothing ran and no model was called.
 * - `failed`: the run, its admission or its dispatch failed.
 * - `timeout`: the run worked past its schedule's `maxRunMinutes` and was stopped.
 * - `budget`: the run used more tokens than its schedule's `maxTokens` and was stopped.
 * - `waiting`: the run waits on a worker it spawned, and goes on once it ends.
 * - `asked`: the run asked a question, and goes on with its default if nobody answers.
 * - `missed`: nothing ran at the fire's time (the owner was not running, or it was too late to run).
 * - `overlap`: skipped because the previous run was still going.
 * - `disk`: refused because the data directory's disk is nearly full; kept due.
 * - `disabled`: the schedule was disabled because its time has no next occurrence.
 * - `orphaned`: the run started and never reported a result.
 * - `manual`: a run asked for now (`tavi schedules run-now`); its outcome says how it ended.
 * - `webhook`: a run a call to the schedule's webhook started; its outcome says how it ended, and what the call carried by size and hash only.
 * - `webhook-refused`: calls to the schedule's webhook that started nothing (bad credentials, over the rate limit, too large, paused), counted per hour.
 * - `email`: a run an email from a listed, authenticated sender started; its outcome says how it ended, and the sender and the email's size and hash only.
 * - `email-refused`: emails meant for the schedule's email trigger that started nothing (unauthenticated, not a listed sender, over the rate limit, paused), counted per hour.
 * - `watch`: a check a file watcher made because its file changed; its outcome says whether it ran and how it ended.
 * - `retry`: the run failed on provider weather and its fire is tried again later; not counted as a failure.
 * - `paused`: the schedule was paused because its runs failed `SCHEDULE_PAUSE_AFTER_FAILURES` times in a row.
 * - `stopped`: a person stopped the run: not counted as a failure, nobody is alerted.
 */
export const SCHEDULE_FIRE_REASONS = [
  "ok",
  "undelivered",
  "quiet",
  "unchanged",
  "failed",
  "timeout",
  "budget",
  "waiting",
  "asked",
  "missed",
  "overlap",
  "disk",
  "disabled",
  "orphaned",
  "manual",
  "webhook",
  "webhook-refused",
  "watch",
  "email",
  "email-refused",
  "retry",
  "paused",
  "stopped",
] as const;
export type ScheduleFireReason = (typeof SCHEDULE_FIRE_REASONS)[number];

/** How many fires the ledger keeps per schedule, newest first; older ones are pruned as new ones are written. */
export const SCHEDULE_FIRES_KEPT = 100;

/**
 * The ledger rows that started nothing and come from outside (refused webhook
 * calls and emails): kept under their own smaller cap, so a stream of them
 * never prunes the schedule's own fires.
 */
export const SCHEDULE_REFUSALS: readonly ScheduleFireReason[] = ["webhook-refused", "email-refused"];
/** How many refusal rows the ledger keeps per schedule, beside its `SCHEDULE_FIRES_KEPT` fires. */
export const SCHEDULE_REFUSALS_KEPT = 24;

/** How many fires `schedules show` lists, and `schedules history` when asked for no number. */
export const SCHEDULE_SHOW_FIRES = 10;

/** One fire of a schedule, as the ledger keeps it: run, skipped or refused, and why. */
export interface ScheduleFireRecord {
  readonly scheduleId: string;
  /** The occurrence the fire was for, ISO-8601 UTC; a manual run's is when it was asked for. */
  readonly fireTime: string;
  readonly outcomeKind: "succeeded" | "failed" | "skipped";
  /** The same short summary `lastOutcome` gives. */
  readonly outcome: string;
  /** `outcome` by key (`core` catalogue) where it is Tavi's words alone, for the canvas to say in its reader's language. */
  readonly outcomeRef?: TextRef;
  readonly reasonCode: ScheduleFireReason;
  /** The run's task, when one started. */
  readonly taskId: string | null;
  /** When it was recorded. */
  readonly at: string;
  /** Which retry of the fire this was (`ScheduleRetry.count`); absent for the fire's first try. */
  readonly retryCount?: number;
}

/** The ledger row a write adds for one fire: its occurrence, which try of it, and why it ended so. */
export interface ScheduleFireEntry {
  readonly fireTime: string;
  readonly reasonCode: ScheduleFireReason;
  /** Which retry of the fire this was; absent or 0 for its first try. */
  readonly retryCount?: number;
}

export interface CreateScheduleInput {
  readonly scheduleId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly name: string;
  readonly prompt: string;
  readonly spec: ScheduleSpec;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly autoApproveTools: readonly string[];
  readonly agentId?: string;
  readonly alert?: ScheduleAlertTarget;
  readonly humanCheckpoints?: ScheduleHumanCheckpoints;
  readonly deliverTo?: ScheduleDeliveryTarget;
  readonly maxRunMinutes?: number;
  readonly maxTokens?: number;
  readonly folder?: string;
  readonly notify?: ScheduleNotify;
  readonly precheck?: SchedulePrecheck;
  /** A watcher; only with `precheck`. */
  readonly watch?: true;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly now: string;
}

/**
 * Durable storage for schedules.
 *
 * Every mutating method is a compare-and-set rather than an unconditional
 * write, because the scheduler runs inside `tavi serve` and a future
 * multi-process deployment (or an operator running `schedules run-now`
 * concurrently with a tick) must not be able to dispatch one fire twice.
 */
interface ScheduleRepositoryPortDefinition {
  /** Refuses a duplicate `(workspaceId, name)` with a typed `CONFLICT` — two schedules an operator cannot tell apart is a configuration bug, not a legitimate state. */
  create(input: CreateScheduleInput): ScheduleRecord;
  get(scheduleId: string): ScheduleRecord | undefined;
  list(workspaceId?: string): readonly ScheduleRecord[];
  /**
   * Enabled schedules whose `nextRunAt` has arrived, oldest first.
   *
   * Rows whose stored configuration cannot be validated are **excluded and
   * named** rather than thrown on: one hand-edited `spec_json` must not stop
   * every other schedule from firing (which is exactly what a throwing read did
   * — the sweep aborted before it reached any of them). The caller is expected
   * to report `unreadable` rather than ignore it.
   */
  listDue(
    now: string,
    limit: number,
  ): {
    readonly due: readonly ScheduleRecord[];
    readonly unreadable: readonly string[];
  };
  /** Deletes the schedule and its fire ledger. */
  remove(scheduleId: string): boolean;
  /**
   * Claim one fire, atomically: succeeds only if `nextRunAt` still equals
   * `fireTime`, then advances it to `nextRunAt`. A second claimant for the same
   * fire gets `false` and must not dispatch. `lastRunAt` stays: a claimed
   * fire may still be skipped, and `markRunning` sets it once one runs. A
   * retry armed at `fireTime` is dropped: the claim is that retry's. A
   * `nextRunAt` of `null` is the last fire of a schedule that ends
   * (`scheduleSpecEnds`): it is not due again, and stays enabled until that
   * fire has settled — a retry may still be armed for it — and `finish`
   * disables it.
   *
   * This is the per-schedule advisory lock, expressed as the one
   * operation that actually needs to be atomic. The run-level overlap guard
   * (the previous run is still holding its execution lease) is a separate check
   * in the scheduler, because overlap is about a *different* fire time.
   */
  claimFire(input: {
    readonly scheduleId: string;
    readonly fireTime: string;
    readonly nextRunAt: string | null;
    readonly now: string;
  }): boolean;
  /**
   * Record that a claimed fire's run has started (its `fireTime` becomes
   * `lastRunAt`), as soon as its task identity is durable — `admit`'s `onAdmitted` callback, which fires *before* the graph
   * runs and therefore while the run's execution lease is still held.
   *
   * This is what makes the overlap guard possible at all. Writing the task id
   * only after `admit` returns (the first implementation) could never see an
   * in-flight run: `admit` releases the lease in its `finally`, so by then
   * `endedAt` is set and the previous fire's id is what is stored, not the
   * current one.
   *
   * With `manual` (a run asked for now), only `lastRunAt` moves: such a run keeps no dispatch marker, and its
   * task is never the one the overlap guard reads.
   */
  markRunning(input: {
    readonly scheduleId: string;
    readonly taskId: string;
    readonly fireTime: string;
    readonly now: string;
    readonly manual?: true;
  }): void;
  /**
   * How the run ended. Does not touch `nextRunAt` — `claimFire` already advanced
   * it.
   *
   * `outcomeKind` is separate from the free-text `outcome` because
   * `consecutiveFailures` must count *consecutive failed runs*: a skipped fire
   * (overlap, or a miss beyond the catch-up window) is neither a success nor a
   * failure, and letting it reset the counter hid a broken schedule behind a
   * quiet morning.
   *
   * With `fire`, the same outcome is added to the fire ledger in the same
   * transaction (`recordFire`); with `deliveredHash`, it becomes the
   * schedule's `lastDeliveredHash`; with `precheckState`, it becomes the
   * schedule's `precheckState` — only while its pre-check is still `of`, so a
   * reading of a pre-check edited since is never kept. With `counted: false`
   * (a run a person, a webhook or an email asked for), the outcome is recorded
   * as it was but leaves `consecutiveFailures` alone.
   */
  recordRun(input: {
    readonly scheduleId: string;
    readonly taskId: string | null;
    readonly outcome: string;
    /** `outcome` by key, kept on the fire's ledger row (`ScheduleFireRecord.outcomeRef`). */
    readonly outcomeRef?: TextRef;
    readonly outcomeKind: "succeeded" | "failed" | "skipped";
    readonly counted?: false;
    readonly fire?: ScheduleFireEntry;
    readonly deliveredHash?: string;
    readonly precheckState?: { readonly of: SchedulePrecheck; readonly state: SchedulePrecheckState };
    readonly now: string;
  }): void;
  /**
   * Add one fire to the ledger without touching the schedule's own row — a
   * skip that must leave a run's dispatch marker in `lastOutcome`, or an
   * occurrence missed while the owner was not running. A fire already in the
   * ledger for the same reason and try (one kept due on a full disk is refused every
   * sweep) has its row updated rather than a second added. Each schedule keeps
   * its newest `SCHEDULE_FIRES_KEPT` fires and, apart, its newest
   * `SCHEDULE_REFUSALS_KEPT` refusals.
   */
  recordFire(input: {
    readonly scheduleId: string;
    readonly taskId: string | null;
    readonly outcome: string;
    /** `outcome` by key, kept on the fire's ledger row (`ScheduleFireRecord.outcomeRef`). */
    readonly outcomeRef?: TextRef;
    readonly outcomeKind: "succeeded" | "failed" | "skipped";
    readonly fire: ScheduleFireEntry;
    readonly now: string;
  }): void;
  /** The schedule's fires, newest first, at most `limit` (and never more than `SCHEDULE_FIRES_KEPT`). */
  listFires(scheduleId: string, limit: number): readonly ScheduleFireRecord[];
  /** `listFires(id, limit)` for each id, in their order, in one read: a listing of many schedules asks once. */
  latestFires(scheduleIds: readonly string[], limit: number): readonly (readonly ScheduleFireRecord[])[];
  /**
   * Records a run **only if** `last_outcome` still equals `expectedMarker`.
   *
   * The startup orphan scan decides from a snapshot of
   * every row and only then writes, so a fire that reported in between must win.
   * An unconditional update would overwrite its outcome — and its own dispatch
   * marker — with "orphaned", reporting a successful run as failed and, worse,
   * hiding the next real orphan. Returns whether the row still carried the marker.
   */
  recordRunIfMarked(input: {
    readonly scheduleId: string;
    readonly expectedMarker: string;
    readonly outcome: string;
    readonly outcomeKind: "failed";
    /** Added to the fire ledger only when the marker was still there. */
    readonly fire?: ScheduleFireEntry;
    readonly now: string;
  }): boolean;
  /**
   * Enable/disable, re-arming `nextRunAt` (or clearing it), and dropping any
   * retry armed. Either clears `pausedReason`: a person decided. Enabling a
   * paused schedule also clears its `consecutiveFailures`, so it gets its full
   * count again. Returns false for an unknown id.
   */
  setEnabled(input: {
    readonly scheduleId: string;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly now: string;
  }): boolean;
  /**
   * Disable a schedule whose last fire has settled, as a compare-and-set:
   * succeeds only while it is enabled with no `nextRunAt` — a retry armed for
   * that fire, or an edit that gave it another run, leaves it on. Returns
   * whether it was finished.
   */
  finish(input: { readonly scheduleId: string; readonly now: string }): boolean;
  /**
   * Arm a failed fire's retry, as a compare-and-set: succeeds only while the
   * schedule is enabled and `nextRunAt` still equals `expectedNextRunAt` (the
   * regular next fire the fire's claim armed, `null` after a last fire's
   * claim), then points `nextRunAt` at `retryAt` with `retry` recorded. The
   * fire's claim of `retryAt` arms the regular next fire again and drops
   * `retry`.
   */
  armRetry(input: {
    readonly scheduleId: string;
    readonly expectedNextRunAt: string | null;
    readonly retryAt: string;
    readonly retry: ScheduleRetry;
    readonly now: string;
  }): boolean;
  /**
   * Pause a schedule whose runs failed `failures` times in a row or more:
   * disabled, `nextRunAt` cleared, any retry dropped, `pausedReason`
   * `failures`, and a `paused` row in the fire ledger for `fireTime`. Only an
   * enabled schedule with a next run is paused, so a pause is told once and a
   * schedule whose last fire failed is finished instead. Returns whether it was.
   */
  pauseForFailures(input: {
    readonly scheduleId: string;
    readonly failures: number;
    readonly fireTime: string;
    readonly outcome: string;
    readonly now: string;
  }): boolean;
  /**
   * Turns its webhook on with the SHA-256 (hex) of a new secret and its signing key encrypted at rest (absent or `null`:
   * no signed calls), replacing any earlier ones, or off (`secretHash: null`, which forgets both).
   * Returns false for an unknown id.
   */
  setWebhook(input: {
    readonly scheduleId: string;
    readonly secretHash: string | null;
    readonly signingKeyEncrypted?: string | null;
    readonly now: string;
  }): boolean;
  /** The SHA-256 (hex) of its webhook's secret, while its webhook is on. */
  webhookSecretHash(scheduleId: string): string | undefined;
  /** Its webhook's signing key as stored, encrypted with the credential key, while its webhook is on and has one. */
  webhookSigningKey(scheduleId: string): string | undefined;
  /** Whether any schedule has its webhook on: the ingress listens while one does. */
  hasWebhooks(): boolean;
  /** The ids of the schedules whose webhook is on: the only ones a webhook call is looked up for. */
  webhookScheduleIds(): readonly string[];
  /** Turns its email trigger on (replacing any earlier one) or off (`null`). Returns false for an unknown id. */
  setEmailTrigger(input: { readonly scheduleId: string; readonly trigger: ScheduleEmailTrigger | null; readonly now: string }): boolean;
  /** The schedules whose email trigger listens on a connection, by name. */
  emailTriggered(connectionId: string): readonly ScheduleRecord[];
  /**
   * Operator-editable fields. `nextRunAt` is recomputed by the caller when the spec changed, which drops any retry armed.
   * A `precheck` given (`null` removes it) forgets the last reading, and removing it stops a watcher. Returns false for an unknown id.
   */
  update(input: {
    readonly scheduleId: string;
    readonly prompt?: string;
    readonly spec?: ScheduleSpec;
    readonly autoApproveTools?: readonly string[];
    readonly agentId?: string | null;
    readonly alert?: ScheduleAlertTarget | null;
    readonly humanCheckpoints?: ScheduleHumanCheckpoints;
    /** `null` clears it. */
    readonly deliverTo?: ScheduleDeliveryTarget | null;
    readonly maxRunMinutes?: number;
    /** `null` clears it. */
    readonly maxTokens?: number | null;
    /** A real path already checked; `null` clears it. */
    readonly folder?: string | null;
    readonly notify?: ScheduleNotify;
    /** `null` removes it. */
    readonly precheck?: SchedulePrecheck | null;
    /** Makes it a watcher, or stops it being one; a schedule with no pre-check is never one. */
    readonly watch?: boolean;
    readonly missedRunPolicy?: MissedRunPolicy;
    readonly nextRunAt?: string | null;
    readonly now: string;
  }): boolean;
  /**
   * What a workspace's scheduled work spent from `since` until before `until`:
   * the model calls of its schedules' runs and its routines' runs, and of the
   * workers either spawned.
   */
  scheduledUsage(input: { readonly workspaceId: string; readonly since: string; readonly until: string }): ScheduledSpend;
}

export type ScheduleRepositoryPort = AsyncRepository<ScheduleRepositoryPortDefinition>;

/** What model calls came to: their tokens, and their estimated cost where every one had a price sheet. */
export interface ScheduledSpend {
  readonly tokens: number;
  /** `null` when a call had no price sheet: the cost is unknown, never shown as free. */
  readonly usd: number | null;
}

/** At what share of a workspace's `scheduled.monthlyTokenBudget` its person is told, once a month. */
export const SCHEDULED_BUDGET_NOTICE_PERCENT = 80;

/**
 * A workspace's scheduled work this calendar month, in its zone: what its
 * schedules' and routines' runs spent, and its monthly budget where one is set.
 */
export interface ScheduledWorkUsage extends ScheduledSpend {
  /** The month, `YYYY-MM`, in `timezone`. */
  readonly month: string;
  readonly timezone: string;
  /** The month's first instant and the next month's, ISO-8601 UTC. */
  readonly since: string;
  readonly until: string;
  /** The workspace's `scheduled.monthlyTokenBudget`, when set. */
  readonly budget?: number;
  /** `tokens` as a whole percentage of `budget`, when one is set. */
  readonly percent?: number;
}

/** The month `now` falls in, in `timeZone`: its `YYYY-MM` and its first and last-plus-one instants. */
export function scheduledMonthWindow(
  now: Date,
  timeZone: string,
): { readonly month: string; readonly since: string; readonly until: string } {
  const local = localDateTime(now, timeZone);
  const next = local.month === 12 ? { year: local.year + 1, month: 1 } : { year: local.year, month: local.month + 1 };
  return {
    month: `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}`,
    since: instantForLocalTime({ year: local.year, month: local.month, day: 1, hour: 0, minute: 0 }, timeZone).toISOString(),
    until: instantForLocalTime({ ...next, day: 1, hour: 0, minute: 0 }, timeZone).toISOString(),
  };
}

/** `spend` for the month of `window`, with `budget` and its share where one is set. */
export function scheduledWorkUsage(
  window: { readonly month: string; readonly since: string; readonly until: string },
  timezone: string,
  spend: ScheduledSpend,
  budget: number | undefined,
): ScheduledWorkUsage {
  return {
    ...window,
    timezone,
    tokens: spend.tokens,
    usd: spend.usd,
    ...(budget === undefined ? {} : { budget, percent: Math.floor((spend.tokens * 100) / budget) }),
  };
}

/** A month's scheduled work in words: "12,345 tokens (about $0.42) of a 1,000,000-token budget (1%)". */
export function scheduledWorkText(usage: ScheduledWorkUsage, t: CoreT = coreEnglish): string {
  return renderTextRef(scheduledWorkRef(usage), t) ?? "";
}

/** `scheduledWorkText` by key, for words stored to be said later in their reader's language (a Home notice). */
export function scheduledWorkRef(usage: ScheduledWorkUsage): TextRef {
  const tokens = textRef("schedule.tokens", { count: Math.round(usage.tokens) });
  const budget = usage.budget === undefined ? undefined : { budget: Math.round(usage.budget), percent: String(usage.percent ?? 0) };
  if (usage.usd === null) return budget === undefined ? tokens : textRef("schedule.work.withBudget", { tokens, ...budget });
  const [dollars = "0", cents = "00"] = usage.usd.toFixed(2).split(".");
  return budget === undefined
    ? textRef("schedule.work.withCost", { tokens, dollars, cents })
    : textRef("schedule.work.withCostAndBudget", { tokens, dollars, cents, ...budget });
}
