import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { ContentLabelSchema } from "./content-label.js";
import { TaviError } from "./errors.js";
import { IdSchema, TimestampSchema } from "./ids.js";
import {
  MISSED_RUN_GRACE_MS,
  ON_TIME_TOLERANCE_MS,
  ReminderMonthlySchema,
  ReminderYearlySchema,
  SCHEDULE_TIME_PATTERN,
  fireDisposition,
  instantForLocalTime,
  localDateTime,
  yearlyDayExists,
  type ReminderMonthly,
  type ReminderYearly,
} from "./schedule-time.js";
import { TimeZoneSchema, isValidTimeZone } from "./workspace-settings.js";
import { plural } from "./util.js";

/**
 * Reminders: a light record that says
 * something to a person at a time — once, before an event, or on repeat.
 *
 * A reminder delivers text, or (with `prompt`) starts a task
 * with no pre-approved tools, so it gains no unattended authority; that is
 * why the agent may create one without asking, where a schedule stays
 * operator-authored.
 *
 * Each occurrence fires once: `tavi_reminder_fires` holds one row per
 * occurrence, claimed atomically, so a fire survives a restart and shows up as
 * history. The occurrence math here is pure and is the only definition of when
 * a reminder fires; the store, the scheduler, the agenda and the IPC read-back
 * all call it.
 *
 * **An event fires its notices only.** "Dentist Monday 10:00" with the default
 * notices says "I'll remind you Sun 20:00 and Mon 09:00" — the event time
 * itself is when the person is at the dentist, not when they need telling. A
 * person who wants a nudge at the time adds a `once` reminder (or a notice
 * such as `-5m`). The `event` occurrence kind is reserved for that choice.
 */

// ------------------------------------------------------------------ limits

/** Active reminders one workspace may hold. */
export const REMINDER_MAX_ACTIVE_PER_WORKSPACE = 100;
/** How far ahead a `once` or `event` reminder may be: two years, as days. */
export const REMINDER_MAX_AHEAD_DAYS = 731;
/** Times one `repeat` reminder may fire in a day. */
export const REMINDER_MAX_TIMES_PER_DAY = 6;
/** Notices one event may carry. */
export const REMINDER_MAX_NOTICES = 5;
/** The earliest a notice may come before its event. */
export const REMINDER_MAX_OFFSET_DAYS = 30;
export const REMINDER_TEXT_MAX = 500;
export const REMINDER_PROMPT_MAX = 4000;
/** The notices an event gets when none are named: the evening before at 20:00, and one hour before. */
export const REMINDER_DEFAULT_NOTIFY = ["-1d@20:00", "-1h"] as const;
/**
 * A fire missed by less than this is delivered once, marked late; an older one
 * is recorded as `missed` and not delivered. The same six hours as a
 * schedule's `run-once-if-missed-within-6h`.
 */
export const REMINDER_LATE_GRACE_MS = MISSED_RUN_GRACE_MS;
/** A fire observed within this of its time is on time: a 30-second tick is always a little late. */
export const REMINDER_ON_TIME_TOLERANCE_MS = ON_TIME_TOLERANCE_MS;
/**
 * A claimed fire whose outcome was never recorded (the owner stopped mid
 * delivery) is claimed again after this. Delivery is keyed by
 * `(reminderId, fireAt)`, so a delivery port can recognise the repeat.
 */
export const REMINDER_CLAIM_LEASE_MS = 10 * 60 * 1000;
/** How long a delivery to a chat is retried before the fire falls back to the app. */
export const REMINDER_RETRY_WINDOW_MS = 15 * 60 * 1000;
/** The first retry's wait; each later one doubles, up to `REMINDER_RETRY_MAX_BACKOFF_MS`. */
export const REMINDER_RETRY_BACKOFF_MS = 30 * 1000;
export const REMINDER_RETRY_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** The snooze choices a delivery offers. */
export const REMINDER_SNOOZE_MINUTES = [10, 60] as const;
/** The longest snooze: a week. */
export const REMINDER_SNOOZE_MAX_MINUTES = 10_080;
/**
 * Missed occurrences of one reminder recorded in one claim. A repeating
 * reminder whose owner was stopped for weeks records its most recent misses,
 * not every one of them.
 */
export const REMINDER_MAX_MISSED_RECORDED = 24;

// ------------------------------------------------------------------ notices

export type ReminderOffsetUnit = "m" | "h" | "d";
/** A parsed notice: `amount` units before the event, and for days optionally at a local time. */
export interface ReminderOffset {
  readonly amount: number;
  readonly unit: ReminderOffsetUnit;
  /** `HH:MM` local time on the day `amount` days before; only with `unit: "d"`. */
  readonly at?: string;
}

const OFFSET_PATTERN = /^-([1-9]\d{0,4})([mhd])(?:@((?:[01]\d|2[0-3]):[0-5]\d))?$/;
const UNIT_MINUTES: Readonly<Record<ReminderOffsetUnit, number>> = { m: 1, h: 60, d: 1440 };

/**
 * Parse a notice offset: `-<n>m`, `-<n>h`, `-<n>d` or `-<n>d@HH:MM`, with
 * `n ≥ 1` and at most `REMINDER_MAX_OFFSET_DAYS` before the event. Anything
 * else is `undefined`.
 */
export function parseReminderOffset(text: string): ReminderOffset | undefined {
  const match = OFFSET_PATTERN.exec(text);
  if (match === null) return undefined;
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] as ReminderOffsetUnit;
  const at = match[3];
  if (at !== undefined && unit !== "d") return undefined;
  if (amount * UNIT_MINUTES[unit] > REMINDER_MAX_OFFSET_DAYS * 1440) return undefined;
  return at === undefined ? { amount, unit } : { amount, unit, at };
}

export function formatReminderOffset(offset: ReminderOffset): string {
  return `-${offset.amount}${offset.unit}${offset.at === undefined ? "" : `@${offset.at}`}`;
}

/** "15 minutes before", "1 day before at 20:00": what a read-back or a delivery says of a notice. */
export function describeReminderOffset(offset: ReminderOffset): string {
  const noun = { m: "minute", h: "hour", d: "day" }[offset.unit];
  const span = `${plural(offset.amount, noun)} before`;
  return offset.at === undefined ? span : `${span} at ${offset.at}`;
}

export const ReminderOffsetSchema = z
  .string()
  .max(16)
  .refine((value) => parseReminderOffset(value) !== undefined, {
    message: `expected a notice such as "-15m", "-2h", "-1d" or "-1d@20:00", at most ${REMINDER_MAX_OFFSET_DAYS} days before`,
  });

// ------------------------------------------------------------------ the record

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An instant with its offset, seconds optional (`2026-10-05T10:00+02:00`), as
 * a person or a model writes one. Stored normalized to UTC
 * (`normalizeReminderWhen`).
 */
export const ReminderInstantSchema = z
  .string()
  .max(40)
  .refine((value) => INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), {
    message: "expected a date and time with its offset, such as 2026-10-05T10:00+02:00",
  });

const ReminderDateSchema = z.iso.date();

export { ReminderMonthlySchema, ReminderYearlySchema, type ReminderMonthly, type ReminderYearly };

export const ReminderWhenSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("once"), at: ReminderInstantSchema }),
    z.strictObject({
      kind: z.literal("event"),
      at: ReminderInstantSchema,
      notify: z
        .array(ReminderOffsetSchema)
        .min(1, "An event needs at least one notice")
        .max(REMINDER_MAX_NOTICES, `An event can have at most ${REMINDER_MAX_NOTICES} notices`),
    }),
    z.strictObject({
      kind: z.literal("repeat"),
      times: z
        .array(z.string().regex(SCHEDULE_TIME_PATTERN, "expected a 24-hour HH:MM time"))
        .min(1, "A repeating reminder needs at least one time")
        .max(REMINDER_MAX_TIMES_PER_DAY, `Reminders can repeat at most ${REMINDER_MAX_TIMES_PER_DAY} times a day`),
      /** 0 = Sunday … 6 = Saturday. Absent: every day. */
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      /**
       * Once a month: on a day of the month (31 is each month's last day when it is shorter), or on its
       * nth weekday (`nth: -1` for the last one, as in "the last Friday").
       */
      monthly: ReminderMonthlySchema.optional(),
      /** Once a year, on a month's day (29 February is the 28th in a year without one). */
      yearly: ReminderYearlySchema.optional(),
      /** The last local date it fires on, inclusive. */
      until: ReminderDateSchema.optional(),
    }),
  ])
  .superRefine((when, context) => {
    const repeated = (values: readonly (string | number)[]) => new Set(values).size !== values.length;
    if (when.kind === "event" && repeated(when.notify)) {
      context.addIssue({ code: "custom", path: ["notify"], message: "Each notice may be named only once" });
    }
    if (when.kind === "repeat" && repeated(when.times)) {
      context.addIssue({ code: "custom", path: ["times"], message: "Each time may be named only once" });
    }
    if (when.kind === "repeat" && when.daysOfWeek !== undefined && repeated(when.daysOfWeek)) {
      context.addIssue({ code: "custom", path: ["daysOfWeek"], message: "Each day may be named only once" });
    }
    // 29 February stands (a year without one fires on the 28th); 31 April names no day at all.
    if (when.kind === "repeat" && when.yearly !== undefined && !yearlyDayExists(when.yearly)) {
      context.addIssue({ code: "custom", path: ["yearly", "day"], message: "That month has no such day" });
    }
    if (when.kind === "repeat" && [when.daysOfWeek, when.monthly, when.yearly].filter((part) => part !== undefined).length > 1) {
      context.addIssue({
        code: "custom",
        path: ["monthly"],
        message: "A reminder repeats on days of the week, monthly or yearly: one of them",
      });
    }
  });
export type ReminderWhen = z.infer<typeof ReminderWhenSchema>;

/**
 * Where a fire is said. `conversation` is the chat the reminder was asked in,
 * or a delivery target the operator added — never a chat id a model supplied.
 * `app` is the Command Center: its badge and rail, and a browser notification
 * while the canvas is open. `home` is the person's Home: the fire is
 * a notice there, and its task's result another when it settles; with no
 * Home, or `chat.home` off, it is said in the app.
 */
export const ReminderDeliverToSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation"), connectionId: IdSchema, conversationId: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal("app") }),
  z.strictObject({ kind: z.literal("home") }),
]);
export type ReminderDeliverTo = z.infer<typeof ReminderDeliverToSchema>;

export const REMINDER_STATUSES = ["active", "paused", "done", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export const ReminderStatusSchema = z.enum(REMINDER_STATUSES);

export const REMINDER_CREATORS = ["agent", "user"] as const;
export type ReminderCreator = (typeof REMINDER_CREATORS)[number];

export const ReminderTextSchema = z
  .string()
  .trim()
  .min(1, "A reminder needs some text")
  .max(REMINDER_TEXT_MAX, `A reminder's text is at most ${REMINDER_TEXT_MAX} characters`);
export const ReminderPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(REMINDER_PROMPT_MAX, `A reminder's task prompt is at most ${REMINDER_PROMPT_MAX} characters`);
export const ReminderOperationKeySchema = z.string().min(1).max(200);

export const ReminderSchema = z.strictObject({
  reminderId: IdSchema,
  workspaceId: IdSchema,
  /** The person it is for. */
  principalId: IdSchema,
  /** What is said when it fires. */
  text: ReminderTextSchema,
  /** Also start a task when it fires. */
  prompt: ReminderPromptSchema.optional(),
  when: ReminderWhenSchema,
  timezone: TimeZoneSchema,
  deliverTo: ReminderDeliverToSchema,
  status: ReminderStatusSchema,
  /** The next fire of any kind — scheduled, or a snoozed one coming back — or null when none is due. */
  nextFireAt: TimestampSchema.nullable(),
  /** The latest fire that was delivered. */
  lastFiredAt: TimestampSchema.nullable(),
  createdBy: z.enum(REMINDER_CREATORS),
  originTaskId: IdSchema.optional(),
  operationKey: ReminderOperationKeySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Absent: a reminder. A to-do's row (`todo`) is read through `getTodo`/`listTodos`; it shows here only when its due time fires. */
  kind: z.literal("todo").optional(),
  /**
   * The context label it was made or changed under, when untrusted or not
   * public (`tavi_reminders.label_json`):
   * the task its `prompt` starts begins with it (`inheritedLabel`), as a
   * heartbeat *Do it* does, and its words are disarmed when said on a
   * channel when untrusted. Absent for one made in a trusted, public chat or by the person. A stored
   * label that no longer parses reads as untrusted `unknown-source`.
   */
  label: ContentLabelSchema.optional(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

// ------------------------------------------------------------------ fires

export const REMINDER_FIRE_OUTCOMES = ["pending", "delivered", "delivered-in-app", "missed", "failed", "snoozed"] as const;
export type ReminderFireOutcome = (typeof REMINDER_FIRE_OUTCOMES)[number];
/**
 * What a delivery may report; `pending`, `missed` and `snoozed` are the store's
 * to set. `retry` keeps the fire pending and claims it again at `retryAt`.
 */
export const REMINDER_DELIVERY_OUTCOMES = ["delivered", "delivered-in-app", "failed", "retry"] as const;
export type ReminderDeliveryOutcome = (typeof REMINDER_DELIVERY_OUTCOMES)[number];

/** `event` is reserved: events fire their notices only (see the module comment). */
export const REMINDER_OCCURRENCES = ["event", "notice", "once", "repeat"] as const;
export type ReminderOccurrenceKind = (typeof REMINDER_OCCURRENCES)[number];

/**
 * One occurrence's fire. `pending` with no `firedAt` waits for its time (a
 * snoozed follow-up); `pending` with `firedAt` is claimed and being delivered.
 */
export const ReminderFireSchema = z.strictObject({
  reminderId: IdSchema,
  fireAt: TimestampSchema,
  firedAt: TimestampSchema.nullable(),
  outcome: z.enum(REMINDER_FIRE_OUTCOMES),
  occurrence: z.enum(REMINDER_OCCURRENCES),
  noticeOffset: ReminderOffsetSchema.optional(),
  /** Delivered after its time because the owner was not running (less than six hours late). */
  late: z.boolean().optional(),
  taskId: IdSchema.optional(),
  acknowledgedAt: TimestampSchema.optional(),
  snoozedUntil: TimestampSchema.optional(),
  /** Deliveries tried and refused so far; absent before the first retry. */
  attempts: z.number().int().min(1).optional(),
  /** When a retried delivery is claimed again. */
  retryAt: TimestampSchema.optional(),
  /** After this a failing delivery stops retrying and falls back to the app. */
  retryUntil: TimestampSchema.optional(),
  /** Names this fire in a button's data, which cannot hold the ids themselves. */
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,32}$/)
    .optional(),
});
export type ReminderFire = z.infer<typeof ReminderFireSchema>;

/**
 * What a failed attempt at a chat delivery becomes: tried again with backoff
 * inside the retry window (opened by the first failure), and once the window
 * has passed, delivered in the app. The one rule for a refused send and for a
 * delivery that threw or timed out.
 */
export function reminderRetryDecision(
  fire: Pick<ReminderFire, "attempts" | "retryUntil">,
  nowMs: number,
): { readonly outcome: "retry"; readonly retryAt: string } | { readonly outcome: "delivered-in-app" } {
  const until = fire.retryUntil === undefined ? nowMs + REMINDER_RETRY_WINDOW_MS : Date.parse(fire.retryUntil);
  if (nowMs >= until) return { outcome: "delivered-in-app" };
  const wait = Math.min(REMINDER_RETRY_BACKOFF_MS * 2 ** (fire.attempts ?? 0), REMINDER_RETRY_MAX_BACKOFF_MS);
  return { outcome: "retry", retryAt: new Date(Math.min(nowMs + wait, until)).toISOString() };
}

// ------------------------------------------------------------------ occurrence math

/** The parts of a reminder its occurrences depend on. */
export type ReminderSchedule = Pick<Reminder, "when" | "timezone">;

/**
 * A repeat as the occurrence math reads it: a reminder's `repeat`, or a
 * schedule's or routine trigger's cadence (`scheduleCadence`), which may also
 * fire every few hours through an active window and start on a given date.
 */
export interface RepeatCadence {
  readonly kind: "repeat";
  /** Times of day, `HH:MM`. */
  readonly times: readonly string[];
  /** Every `hours` hours from `from` through `to` (wall-clock times), besides `times`. */
  readonly everyHours?: { readonly hours: number; readonly from: string; readonly to: string } | undefined;
  readonly daysOfWeek?: readonly number[] | undefined;
  readonly monthly?: ReminderMonthly | undefined;
  readonly yearly?: ReminderYearly | undefined;
  /** The first local date it fires on, inclusive. */
  readonly from?: string | undefined;
  /** The last local date it fires on, inclusive. */
  readonly until?: string | undefined;
}

/** What the occurrence math reads: a reminder's schedule, or any repeating cadence, in its zone. */
export interface OccurrenceSchedule {
  readonly when: ReminderWhen | RepeatCadence;
  readonly timezone: string;
}

/**
 * The wall-clock times an active window fires at: `from`, then every `hours`
 * hours up to `to` inclusive ("every 2 hours 08:00–18:00" is 08:00, 10:00, …,
 * 18:00). Wall-clock steps, so the day the clocks change keeps the same times.
 */
export function everyHoursTimes(window: { readonly hours: number; readonly from: string; readonly to: string }): string[] {
  const minutes = (text: string) => hourMinute(text).hour * 60 + hourMinute(text).minute;
  const step = Math.max(1, Math.floor(window.hours)) * 60;
  const times: string[] = [];
  for (let at = minutes(window.from); at <= minutes(window.to); at += step) {
    times.push(`${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`);
  }
  return times;
}

/** Every time of day a repeat fires at, sorted and each once: its `times`, and its window's steps. */
export function cadenceTimes(when: Pick<RepeatCadence, "times" | "everyHours">): string[] {
  return [...new Set([...when.times, ...(when.everyHours === undefined ? [] : everyHoursTimes(when.everyHours))])].sort();
}

export interface ReminderOccurrence {
  readonly at: Date;
  readonly occurrence: Exclude<ReminderOccurrenceKind, "event">;
  /** The notice this is, for an event. */
  readonly noticeOffset?: string;
  /** The configured time of day this is, for a repeat (a time the clocks skip fires later than it reads). */
  readonly time?: string;
}

const DAY_MS = 86_400_000;
/** No series looks further than this: two years of days and a margin. */
const MAX_SCAN_DAYS = REMINDER_MAX_AHEAD_DAYS + 7;

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function shiftDate(date: CalendarDate, days: number): CalendarDate & { readonly weekday: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

const dateKey = (date: CalendarDate): string =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/** A `YYYY-MM-DD` date's parts. */
function calendarDate(text: string): CalendarDate {
  const [year, month, day] = text.split("-").map((part) => Number.parseInt(part, 10));
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

function hourMinute(text: string): { readonly hour: number; readonly minute: number } {
  const [hour, minute] = text.split(":").map((part) => Number.parseInt(part, 10));
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

/**
 * The instant of one notice before `eventAt`, in `timezone`.
 *
 * Minutes and hours are elapsed time. Days are calendar days in the zone, so
 * they cross a DST change without drifting: `-1d` is the same local time the
 * day before, and `-1d@20:00` is 20:00 local on the previous calendar day.
 */
export function reminderNoticeAt(eventAt: Date, offset: ReminderOffset, timezone: string): Date {
  if (offset.unit !== "d") return new Date(eventAt.getTime() - offset.amount * UNIT_MINUTES[offset.unit] * 60_000);
  const local = localDateTime(eventAt, timezone);
  const date = shiftDate(local, -offset.amount);
  const time = offset.at === undefined ? { hour: local.hour, minute: local.minute } : hourMinute(offset.at);
  return instantForLocalTime({ ...date, ...time }, timezone);
}

/** An event's notices, earliest first; two notices that land on one instant are one fire. */
export function reminderNotices(eventAt: Date, notify: readonly string[], timezone: string): readonly ReminderOccurrence[] {
  const byInstant = new Map<number, ReminderOccurrence>();
  for (const text of notify) {
    const offset = parseReminderOffset(text);
    if (offset === undefined) continue;
    const at = reminderNoticeAt(eventAt, offset, timezone);
    if (!byInstant.has(at.getTime())) byInstant.set(at.getTime(), { at, occurrence: "notice", noticeOffset: formatReminderOffset(offset) });
  }
  return [...byInstant.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Every fire of `reminder` strictly after `after` and strictly before
 * `until`, earliest first. Lazy, so a caller that wants the first few expands
 * no more. The one definition of when anything scheduled fires: reminders,
 * schedules and routine triggers (`nextOccurrence`) and the agenda all read it.
 *
 * - `once`: its time.
 * - `event`: its notices (not the event time; see the module comment).
 * - `repeat`: each of its times (`cadenceTimes`) on each matching local day
 *   from its `from` date up to its `until` date inclusive, DST-safe through
 *   `instantForLocalTime` (a time the clocks skip fires at the first minute
 *   that exists; two times the same gap merges fire once).
 */
export function* reminderOccurrenceSeries(
  reminder: OccurrenceSchedule,
  after: Date,
  until: Date,
): Generator<ReminderOccurrence, undefined> {
  const inWindow = (at: Date) => at.getTime() > after.getTime() && at.getTime() < until.getTime();
  const { when, timezone } = reminder;
  if (when.kind === "once") {
    const at = new Date(when.at);
    if (inWindow(at)) yield { at, occurrence: "once" };
    return undefined;
  }
  if (when.kind === "event") {
    for (const notice of reminderNotices(new Date(when.at), when.notify, timezone)) {
      if (inWindow(notice.at)) yield notice;
    }
    return undefined;
  }
  const repeat: RepeatCadence = when;
  const times = cadenceTimes(repeat).map((text) => ({ text, ...hourMinute(text) }));
  const local = localDateTime(after, timezone);
  const start = repeat.from !== undefined && repeat.from > dateKey(local) ? calendarDate(repeat.from) : local;
  // The scan's two years count from the first day it may fire, so a repeat that starts later is still found.
  const begins = Math.max(after.getTime(), Date.UTC(start.year, start.month - 1, start.day) - DAY_MS);
  const horizon = Math.min(until.getTime(), begins + MAX_SCAN_DAYS * DAY_MS);
  const last = dateKey(localDateTime(new Date(horizon), timezone));
  for (let offset = 0; offset <= MAX_SCAN_DAYS; offset += 1) {
    const date = shiftDate(start, offset);
    const key = dateKey(date);
    if (key > last || (repeat.until !== undefined && key > repeat.until)) return undefined;
    if (!repeatsOn(repeat, date)) continue;
    let previous = Number.NEGATIVE_INFINITY;
    for (const time of times) {
      const at = instantForLocalTime({ ...date, hour: time.hour, minute: time.minute }, timezone);
      if (at.getTime() <= previous) continue;
      previous = at.getTime();
      if (inWindow(at)) yield { at, occurrence: "repeat", time: time.text };
    }
  }
  return undefined;
}

/** How many days `month` of `year` has. */
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Whether a repeating reminder fires on `date`: its weekdays, its monthly day, or its yearly date. */
function repeatsOn(when: RepeatCadence, date: CalendarDate & { readonly weekday: number }): boolean {
  if (when.daysOfWeek !== undefined) return when.daysOfWeek.includes(date.weekday);
  const last = daysInMonth(date.year, date.month);
  if (when.monthly !== undefined) {
    if ("dayOfMonth" in when.monthly) return date.day === Math.min(when.monthly.dayOfMonth, last);
    if (date.weekday !== when.monthly.weekday) return false;
    return when.monthly.nth === -1 ? date.day + 7 > last : Math.ceil(date.day / 7) === when.monthly.nth;
  }
  if (when.yearly !== undefined) return date.month === when.yearly.month && date.day === Math.min(when.yearly.day, last);
  return true;
}

/** The fires of `reminder` in `[from, until)`, earliest first. */
export function reminderOccurrences(reminder: ReminderSchedule, from: Date, until: Date): readonly ReminderOccurrence[] {
  return [...reminderOccurrenceSeries(reminder, new Date(from.getTime() - 1), until)];
}

/** The first fire of `reminder` strictly after `after`, or null when it has no more. */
export function nextReminderFire(reminder: ReminderSchedule, after: Date): ReminderOccurrence | null {
  const until = new Date(after.getTime() + MAX_SCAN_DAYS * DAY_MS);
  const next = reminderOccurrenceSeries(reminder, after, until).next();
  return next.done === true ? null : next.value;
}

/** The first `count` fires after `after`: a reminder's "coming up". */
export function upcomingReminderFires(reminder: ReminderSchedule, after: Date, count: number): readonly ReminderOccurrence[] {
  const series = reminderOccurrenceSeries(reminder, after, new Date(after.getTime() + MAX_SCAN_DAYS * DAY_MS));
  const fires: ReminderOccurrence[] = [];
  for (const fire of series) {
    fires.push(fire);
    if (fires.length >= count) break;
  }
  return fires;
}

/** `when` with its instants in UTC, as stored: two spellings of one time are one reminder. */
export function normalizeReminderWhen(when: ReminderWhen): ReminderWhen {
  if (when.kind === "repeat") return { ...when, times: [...when.times].sort() };
  return { ...when, at: new Date(when.at).toISOString() };
}

export interface ReminderScheduleCheck {
  /** The first fire. */
  readonly first: ReminderOccurrence;
  /** Notices of an event already in the past, which will not fire. */
  readonly skippedNotices: readonly string[];
}

const invalid = (message: string, details?: Record<string, unknown>): never => {
  throw new TaviError("INVALID_INPUT", message, details === undefined ? undefined : { details });
};

/**
 * Whether a reminder's schedule is one it may have, as of `now`: a known
 * zone, a future time at most two years ahead, at most six times a day, and at
 * least one fire to come. Notices already in the past are reported, not
 * refused, as long as one is still to come. The messages are the person's to
 * read ("That time is in the past").
 */
export function checkReminderSchedule(reminder: ReminderSchedule, now: Date): ReminderScheduleCheck {
  const { when, timezone } = reminder;
  if (!isValidTimeZone(timezone))
    invalid(`${JSON.stringify(timezone)} is not a known time zone; use one such as Europe/Berlin`, { timezone });
  const horizon = now.getTime() + REMINDER_MAX_AHEAD_DAYS * DAY_MS;
  if (when.kind === "once" || when.kind === "event") {
    const at = Date.parse(when.at);
    if (Number.isNaN(at)) invalid("That time could not be read");
    if (at <= now.getTime()) invalid("That time is in the past");
    if (at > horizon) invalid("Reminders can be set at most 2 years ahead");
  }
  if (when.kind === "repeat") {
    if (when.times.length > REMINDER_MAX_TIMES_PER_DAY) invalid(`Reminders can repeat at most ${REMINDER_MAX_TIMES_PER_DAY} times a day`);
    if (when.until !== undefined && when.until < dateKey(localDateTime(now, timezone))) invalid("That repeat ends before it starts");
  }
  if (when.kind === "event") {
    const notices = reminderNotices(new Date(when.at), when.notify, timezone);
    const skippedNotices = notices.filter((notice) => notice.at.getTime() <= now.getTime()).map((notice) => notice.noticeOffset ?? "");
    const first = notices.find((notice) => notice.at.getTime() > now.getTime());
    if (first === undefined) invalid("Every notice for that event is already in the past; add a closer one such as -15m");
    return { first: first as ReminderOccurrence, skippedNotices };
  }
  const first = nextReminderFire(reminder, now);
  if (first === null) invalid("That reminder would never fire");
  return { first: first as ReminderOccurrence, skippedNotices: [] };
}

/** Whether a fire `lateMs` after its time is delivered (late or not) or recorded as missed. */
export function reminderFireDisposition(lateMs: number): "on-time" | "late" | "missed" {
  return fireDisposition(lateMs, { missedAtGrace: true });
}

// ------------------------------------------------------------------ the repository

export const CreateReminderInputSchema = z.strictObject({
  reminderId: IdSchema,
  workspaceId: IdSchema,
  principalId: IdSchema,
  text: ReminderTextSchema,
  prompt: ReminderPromptSchema.optional(),
  when: ReminderWhenSchema,
  timezone: TimeZoneSchema,
  deliverTo: ReminderDeliverToSchema,
  createdBy: z.enum(REMINDER_CREATORS),
  originTaskId: IdSchema.optional(),
  operationKey: ReminderOperationKeySchema,
  /** The creating call's context label; stored when untrusted or not public. */
  label: ContentLabelSchema.optional(),
  now: TimestampSchema,
});
export type CreateReminderInput = z.infer<typeof CreateReminderInputSchema>;

export interface CreateReminderResult {
  readonly reminder: Reminder;
  /** False when the operation key or an exact duplicate named an existing reminder. */
  readonly created: boolean;
  /** An active reminder for the same person, text and first fire already existed and is returned. */
  readonly duplicate?: true;
  /** Notices already in the past at creation, which will not fire. */
  readonly skippedNotices: readonly string[];
}

export const UpdateReminderInputSchema = z.strictObject({
  reminderId: IdSchema,
  /** Compare-and-set: the `updatedAt` the caller read. */
  expectedUpdatedAt: TimestampSchema,
  text: ReminderTextSchema.optional(),
  /** Null clears it. */
  prompt: ReminderPromptSchema.nullable().optional(),
  when: ReminderWhenSchema.optional(),
  timezone: TimeZoneSchema.optional(),
  deliverTo: ReminderDeliverToSchema.optional(),
  /** The label the reminder holds from now on: stored when untrusted or not public, so a trusted-public one clears it. Absent: unchanged. */
  label: ContentLabelSchema.optional(),
  now: TimestampSchema,
});
export type UpdateReminderInput = z.infer<typeof UpdateReminderInputSchema>;

export const REMINDER_LIST_MAX_LIMIT = 200;
export const REMINDER_LIST_DEFAULT_LIMIT = 50;
export const ReminderCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ListRemindersInputSchema = z.strictObject({
  workspaceId: IdSchema,
  principalId: IdSchema.optional(),
  /** Only the reminders asked for in this chat. */
  originTaskId: IdSchema.optional(),
  statuses: z.array(ReminderStatusSchema).min(1).max(REMINDER_STATUSES.length).optional(),
  cursor: ReminderCursorSchema.optional(),
  limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT),
});
export type ListRemindersInput = z.infer<typeof ListRemindersInputSchema>;
export interface ListRemindersResult {
  /** Newest first. */
  readonly reminders: readonly Reminder[];
  readonly nextCursor?: string;
}

export const REMINDER_TRANSITIONS = ["cancel", "pause", "resume"] as const;
export type ReminderTransition = (typeof REMINDER_TRANSITIONS)[number];
export const TransitionReminderInputSchema = z.strictObject({
  reminderId: IdSchema,
  action: z.enum(REMINDER_TRANSITIONS),
  expectedUpdatedAt: TimestampSchema.optional(),
  now: TimestampSchema,
});
export type TransitionReminderInput = z.infer<typeof TransitionReminderInputSchema>;

export const SnoozeReminderInputSchema = z.strictObject({
  reminderId: IdSchema,
  /** The delivered fire to snooze. Absent: the latest delivered, unacknowledged one. */
  fireAt: TimestampSchema.optional(),
  /** Any span up to a week; a delivery's buttons offer `REMINDER_SNOOZE_MINUTES`. */
  minutes: z.number().int().min(1).max(REMINDER_SNOOZE_MAX_MINUTES),
  now: TimestampSchema,
});
export type SnoozeReminderInput = z.infer<typeof SnoozeReminderInputSchema>;
export interface SnoozeReminderResult {
  readonly reminder: Reminder;
  /** The fire that was snoozed. */
  readonly snoozed: ReminderFire;
  /** The follow-up fire, at `snoozedUntil`. */
  readonly followUp: ReminderFire;
}

export const AcknowledgeReminderFireInputSchema = z.strictObject({ reminderId: IdSchema, fireAt: TimestampSchema, now: TimestampSchema });
export type AcknowledgeReminderFireInput = z.infer<typeof AcknowledgeReminderFireInputSchema>;

export const REMINDER_FIRES_MAX_LIMIT = 200;
export const ListReminderFiresInputSchema = z.strictObject({
  workspaceId: IdSchema,
  reminderId: IdSchema.optional(),
  /** Only fires delivered in the app and not yet acknowledged: the rail's "fired reminders not yet seen". */
  unseen: z.boolean().optional(),
  limit: z.number().int().min(1).max(REMINDER_FIRES_MAX_LIMIT),
});
export type ListReminderFiresInput = z.infer<typeof ListReminderFiresInputSchema>;

/** A fire with what a list of fires across reminders needs to show it. */
export const ReminderFireViewSchema = ReminderFireSchema.extend({
  workspaceId: IdSchema,
  principalId: IdSchema,
  text: ReminderTextSchema,
});
export type ReminderFireView = z.infer<typeof ReminderFireViewSchema>;

export const ClaimDueRemindersInputSchema = z.strictObject({ now: TimestampSchema, limit: z.number().int().min(1).max(500) });
export type ClaimDueRemindersInput = z.infer<typeof ClaimDueRemindersInputSchema>;

/** A fire the caller now owns and must deliver, then report with `recordOutcome`. */
export interface ClaimedReminderFire {
  readonly reminder: Reminder;
  readonly fire: ReminderFire;
  /** Delivered after its time: say so. */
  readonly late: boolean;
}
export interface ClaimDueRemindersResult {
  readonly claimed: readonly ClaimedReminderFire[];
  /** Occurrences recorded as `missed` by this claim (too late to deliver). */
  readonly missed: number;
}

export const RecordReminderOutcomeInputSchema = z.strictObject({
  reminderId: IdSchema,
  fireAt: TimestampSchema,
  outcome: z.enum(REMINDER_DELIVERY_OUTCOMES),
  /** Required with `retry`: when the fire is claimed again. */
  retryAt: TimestampSchema.optional(),
  taskId: IdSchema.optional(),
  now: TimestampSchema,
});
export type RecordReminderOutcomeInput = z.infer<typeof RecordReminderOutcomeInputSchema>;

// ------------------------------------------------------------------ to-dos

/**
 * A to-do: a reminder row with no fire time of its own (`kind = 'todo'`), so
 * "add milk to my list" works in every channel with no setup. It is open or
 * done, sits on a named list, and may carry notes and a `due`:
 *
 * - A due *time* (an instant) in the future also reminds: the row's schedule
 *   is a `once` at that time, fired and delivered as any reminder's.
 * - A due *date* (`YYYY-MM-DD`), or a time already past, is shown and never
 *   fires.
 * - With nothing to fire, the row's reminder part is spent (`status: done`,
 *   no `nextFireAt`), and its `when` is a `once` at its creation, never due.
 *
 * Reminder lists (`list`) never hold to-dos, and to-do lists never hold
 * reminders. When the person keeps tasks in an app of their own
 * (`tasks.home`), these hold only Tavi's internal follow-ups.
 */
export const TODO_STATUSES = ["open", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export const TodoStatusSchema = z.enum(TODO_STATUSES);
/** Open to-dos one workspace may hold. */
export const TODO_MAX_OPEN_PER_WORKSPACE = 500;
export const TODO_NOTES_MAX = 2000;
export const TODO_LIST_NAME_MAX = 60;
/** The list a to-do goes on when none is named. */
export const DEFAULT_TODO_LIST = "inbox";

/** A list's name, as stored: trimmed and lower-case, so "Groceries" and "groceries " are one list. */
export const TodoListNameSchema = z
  .string()
  .trim()
  .min(1, "A list needs a name")
  .max(TODO_LIST_NAME_MAX, `A list's name is at most ${TODO_LIST_NAME_MAX} characters`)
  .transform((name) => name.toLowerCase());
export const TodoNotesSchema = z.string().trim().min(1).max(TODO_NOTES_MAX, `A to-do's notes are at most ${TODO_NOTES_MAX} characters`);
/** A due date (`2026-10-30`, shown, never fired) or a due time (an instant, which reminds). */
export const TodoDueSchema = z.union([ReminderDateSchema, ReminderInstantSchema]);
export type TodoDue = z.infer<typeof TodoDueSchema>;

/** Whether `due` is a time that reminds, rather than a date that is only shown. */
export const todoDueIsTime = (due: string): boolean => !/^\d{4}-\d{2}-\d{2}$/.test(due);

export const TodoSchema = z.strictObject({
  todoId: IdSchema,
  workspaceId: IdSchema,
  principalId: IdSchema,
  text: ReminderTextSchema,
  list: z.string().min(1).max(TODO_LIST_NAME_MAX),
  notes: z.string().max(TODO_NOTES_MAX).optional(),
  /** A date, or a UTC instant. */
  due: TodoDueSchema.optional(),
  status: TodoStatusSchema,
  completedAt: TimestampSchema.optional(),
  /** When its due time will remind, or null when nothing is to fire. */
  remindAt: TimestampSchema.nullable(),
  timezone: TimeZoneSchema,
  /** Where its due time is said: the chat it was asked in, as a reminder's. */
  deliverTo: ReminderDeliverToSchema,
  createdBy: z.enum(REMINDER_CREATORS),
  originTaskId: IdSchema.optional(),
  operationKey: ReminderOperationKeySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** As a reminder's: the label it was made or changed under, when untrusted or not public. */
  label: ContentLabelSchema.optional(),
});
export type Todo = z.infer<typeof TodoSchema>;

export const CreateTodoInputSchema = z.strictObject({
  todoId: IdSchema,
  workspaceId: IdSchema,
  principalId: IdSchema,
  text: ReminderTextSchema,
  /** Absent: `DEFAULT_TODO_LIST`. */
  list: TodoListNameSchema.optional(),
  notes: TodoNotesSchema.optional(),
  due: TodoDueSchema.optional(),
  timezone: TimeZoneSchema,
  deliverTo: ReminderDeliverToSchema,
  createdBy: z.enum(REMINDER_CREATORS),
  originTaskId: IdSchema.optional(),
  operationKey: ReminderOperationKeySchema,
  label: ContentLabelSchema.optional(),
  now: TimestampSchema,
});
export type CreateTodoInput = z.input<typeof CreateTodoInputSchema>;

export interface CreateTodoResult {
  readonly todo: Todo;
  /** False when the operation key, or an open to-do with the same text on the same list, named an existing one. */
  readonly created: boolean;
  readonly duplicate?: true;
}

export const UpdateTodoInputSchema = z.strictObject({
  todoId: IdSchema,
  /** Compare-and-set: the `updatedAt` the caller read. Absent: whatever is stored. */
  expectedUpdatedAt: TimestampSchema.optional(),
  text: ReminderTextSchema.optional(),
  list: TodoListNameSchema.optional(),
  /** Null clears it. */
  notes: TodoNotesSchema.nullable().optional(),
  /** Null clears it, and any reminder it set. */
  due: TodoDueSchema.nullable().optional(),
  /** `done` completes it (its reminder no longer fires); `open` reopens it. */
  status: TodoStatusSchema.optional(),
  label: ContentLabelSchema.optional(),
  now: TimestampSchema,
});
export type UpdateTodoInput = z.input<typeof UpdateTodoInputSchema>;

export const ListTodosInputSchema = z.strictObject({
  workspaceId: IdSchema,
  principalId: IdSchema.optional(),
  /** Absent: open ones only. */
  statuses: z.array(TodoStatusSchema).min(1).max(TODO_STATUSES.length).optional(),
  list: TodoListNameSchema.optional(),
  cursor: ReminderCursorSchema.optional(),
  limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT),
});
export type ListTodosInput = z.input<typeof ListTodosInputSchema>;
export interface ListTodosResult {
  /** Oldest first: a list reads in the order it was written. */
  readonly todos: readonly Todo[];
  readonly nextCursor?: string;
}

export const RemoveTodoInputSchema = z.strictObject({ todoId: IdSchema, expectedUpdatedAt: TimestampSchema.optional() });
export type RemoveTodoInput = z.infer<typeof RemoveTodoInputSchema>;

/**
 * Reminders and their fires.
 *
 * - `create` is idempotent on `(workspaceId, principalId, operationKey)`, and
 *   returns an active or paused reminder with the same person, text and first
 *   fire as a `duplicate` rather than making a second one.
 * - `update` and the transitions are compare-and-set on `updatedAt`: a stale
 *   one is `CONFLICT`.
 * - `claimDue` claims every due fire atomically, one row per occurrence, and
 *   applies the missed-fire rule: missed by less than six hours is delivered
 *   once, marked late; older is recorded `missed`; a repeating reminder sends
 *   at most one late occurrence. A claimed fire whose outcome never arrived is
 *   claimed again after `REMINDER_CLAIM_LEASE_MS`.
 * - After a claim, `nextFireAt` moves on; a `once` or `event` reminder with
 *   nothing left to fire is `done`.
 */
interface ReminderRepositoryPortDefinition {
  create(input: CreateReminderInput): CreateReminderResult;
  get(reminderId: string): Reminder | undefined;
  list(input: ListRemindersInput): ListRemindersResult;
  update(input: UpdateReminderInput): Reminder;
  transition(input: TransitionReminderInput): Reminder;
  snooze(input: SnoozeReminderInput): SnoozeReminderResult;
  acknowledge(input: AcknowledgeReminderFireInput): ReminderFire;
  fires(input: ListReminderFiresInput): readonly ReminderFireView[];
  claimDue(input: ClaimDueRemindersInput): ClaimDueRemindersResult;
  /**
   * Record a claimed fire's delivery; false when the fire is not a claimed,
   * pending one. `retry` leaves it pending until `retryAt` and opens the
   * retry window (`REMINDER_RETRY_WINDOW_MS`) on the first one.
   */
  recordOutcome(input: RecordReminderOutcomeInput): boolean;
  /** The fire a button's token names, with its reminder. */
  fireByToken(token: string): { readonly reminder: Reminder; readonly fire: ReminderFire } | undefined;
  /**
   * To-dos (see `TodoSchema`): `createTodo` is idempotent on the operation key
   * as `create` is, and answers an open to-do with the same text on the same
   * list as a `duplicate`; `updateTodo` re-times its reminder when `due` or
   * `status` changes; `removeTodo` deletes it and its fires, false when there
   * was none.
   */
  createTodo(input: CreateTodoInput): CreateTodoResult;
  getTodo(todoId: string): Todo | undefined;
  listTodos(input: ListTodosInput): ListTodosResult;
  updateTodo(input: UpdateTodoInput): Todo;
  removeTodo(input: RemoveTodoInput): boolean;
}
export type ReminderRepositoryPort = AsyncRepository<ReminderRepositoryPortDefinition>;

// ------------------------------------------------------------------ delivery

/**
 * How a claimed fire is said (the scheduler's seam): it routes to
 * `deliverTo` (a chat with Done/Snooze buttons, retry and in-app fallback),
 * else records the fire as delivered in the app, and starts the reminder's
 * task. A port must tolerate being asked twice for one `(reminderId, fireAt)`:
 * a fire claimed by an owner that stopped before recording the outcome is
 * claimed again.
 */
export interface ReminderDeliveryPort {
  deliver(input: { readonly reminder: Reminder; readonly fire: ReminderFire; readonly late: boolean }): Promise<{
    readonly outcome: ReminderDeliveryOutcome;
    /** With `retry`: when to try again. */
    readonly retryAt?: string;
    readonly taskId?: string;
  }>;
}

// ------------------------------------------------------------------ read-back

/** Fixed English month names: en-GB's own short month is "Sept" in newer ICU, "Sep" everywhere else in the app. */
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const READ_BACK_PARTS = (instant: Date, timezone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  // A numeric month makes en-GB pad the day ("06"): both are read as numbers.
  const month = MONTH_NAMES[Number(parts["month"]) - 1] ?? "";
  const day = parts["day"] === undefined ? "" : String(Number(parts["day"]));
  return {
    weekday: parts["weekday"] ?? "",
    day,
    month,
    year: parts["year"] ?? "",
    time: `${parts["hour"] ?? "00"}:${parts["minute"] ?? "00"}`,
  };
};

/** "Mon 5 Oct 10:00": an instant as a person reads it in `timezone`. */
export function formatReminderTime(instant: Date, timezone: string, now: Date = new Date()): string {
  const parts = READ_BACK_PARTS(instant, timezone);
  // A date in another year says so: "Sun 27 Aug" alone reads as the coming one.
  const year = parts.year === READ_BACK_PARTS(now, timezone).year ? "" : ` ${parts.year}`;
  return `${parts.weekday} ${parts.day} ${parts.month}${year} ${parts.time}`;
}

/** "10:00": the wall-clock time of an instant in `timezone`. */
export function formatReminderClock(instant: Date, timezone: string): string {
  return READ_BACK_PARTS(instant, timezone).time;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * What a reminder will do, in one sentence the agent repeats back so a wrong
 * reading is caught in the same turn: "Mon 5 Oct 10:00 Europe/Berlin; I'll
 * remind you Sun 20:00 and Mon 09:00". A notice within the coming week is
 * named by weekday; a later one by its date.
 */
export function reminderReadBack(reminder: ReminderSchedule, now: Date): string {
  const { when, timezone } = reminder;
  const nearby = (instant: Date) => {
    const parts = READ_BACK_PARTS(instant, timezone);
    return instant.getTime() - now.getTime() < 6 * DAY_MS ? `${parts.weekday} ${parts.time}` : formatReminderTime(instant, timezone, now);
  };
  const list = (items: readonly string[]) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
  switch (when.kind) {
    case "once":
      return `${formatReminderTime(new Date(when.at), timezone, now)} ${timezone}; I'll remind you then`;
    case "event": {
      const notices = reminderNotices(new Date(when.at), when.notify, timezone).filter((notice) => notice.at.getTime() > now.getTime());
      return `${formatReminderTime(new Date(when.at), timezone, now)} ${timezone}; ${notices.length === 0 ? "no notice is still to come" : `I'll remind you ${list(notices.map((notice) => nearby(notice.at)))}`}`;
    }
    case "repeat": {
      const days =
        when.monthly !== undefined || when.yearly !== undefined
          ? repeatDaysText(when)
          : when.daysOfWeek === undefined || when.daysOfWeek.length === 7
            ? "every day"
            : `every ${[...when.daysOfWeek]
                .sort()
                .map((day) => DAY_NAMES[day] ?? String(day))
                .join(", ")}`;
      const next = nextReminderFire(reminder, now);
      return `${days} at ${list([...when.times].sort())} ${timezone}${when.until === undefined ? "" : ` until ${when.until}`}${next === null ? "" : `; next ${formatReminderTime(next.at, timezone)}`}`;
    }
  }
}

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth"] as const;

const dayOrdinal = (day: number): string =>
  `${day}${day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th"}`;

/** The monthly or yearly pattern of a repeat: what `repeatDaysText` words. */
export interface RepeatPattern {
  readonly monthly?: ReminderMonthly | undefined;
  readonly yearly?: ReminderYearly | undefined;
}

/** The day a monthly or yearly repeat falls on: "on the 31st (the last day in shorter months)", "on the last Fri", "on 29 Feb". */
function repeatDayText(pattern: RepeatPattern): string | undefined {
  if (pattern.monthly !== undefined) {
    if ("dayOfMonth" in pattern.monthly)
      return `on the ${dayOrdinal(pattern.monthly.dayOfMonth)}${pattern.monthly.dayOfMonth > 28 ? " (the last day in shorter months)" : ""}`;
    return `on the ${pattern.monthly.nth === -1 ? "last" : ORDINALS[pattern.monthly.nth]} ${DAY_NAMES[pattern.monthly.weekday] ?? ""}`;
  }
  if (pattern.yearly !== undefined) return `on ${pattern.yearly.day} ${MONTH_NAMES[pattern.yearly.month - 1] ?? ""}`;
  return undefined;
}

/**
 * A monthly or yearly repeat in words, as a sentence says it ("every month on
 * the 31st (the last day in shorter months)", "every year on 29 Feb") or as a
 * label leads with it (`"label"`: "Monthly on the 1st", "Yearly on 29 Feb").
 * Neither is "every day" ("Daily").
 */
export function repeatDaysText(pattern: RepeatPattern, style: "sentence" | "label" = "sentence"): string {
  const day = repeatDayText(pattern);
  const [sentence, label] =
    pattern.monthly !== undefined
      ? ["every month", "Monthly"]
      : pattern.yearly !== undefined
        ? ["every year", "Yearly"]
        : ["every day", "Daily"];
  const lead = style === "label" ? label : sentence;
  return day === undefined ? lead : `${lead} ${day}`;
}

/** The week as people read it: Monday first, Sunday last. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * Weekdays (0 = Sunday) in words: "Mon–Fri", "Mon, Wed", "Sat, Sun". Every
 * day (or none given) is `undefined`, a daily cadence. Three or more days in a
 * row read as a range.
 */
export function daysOfWeekText(days: readonly number[] | undefined): string | undefined {
  if (days === undefined) return undefined;
  const picked = new Set(days);
  if (WEEK_ORDER.every((day) => picked.has(day))) return undefined;
  // Days in a row, in week order: each run with the position its last day holds.
  const runs: { days: number[]; end: number }[] = [];
  WEEK_ORDER.forEach((day, index) => {
    if (!picked.has(day)) return;
    const last = runs.at(-1);
    if (last !== undefined && last.end === index - 1) {
      last.days.push(day);
      last.end = index;
    } else runs.push({ days: [day], end: index });
  });
  return runs
    .flatMap(({ days: run }) =>
      run.length >= 3 ? [`${DAY_NAMES[run[0] ?? 0]}–${DAY_NAMES[run.at(-1) ?? 0]}`] : run.map((day) => DAY_NAMES[day] ?? String(day)),
    )
    .join(", ");
}

/** What a reminder task's operation key starts with (`reminderTaskOperationKey`). */
export const REMINDER_TASK_KEY_PREFIX = "reminder:";
/** An ISO instant as `toISOString` writes it: what ends a reminder task's operation key. */
export const REMINDER_TASK_KEY_ISO_LENGTH = 24;

/** The operation key a reminder's task is admitted under: one task per fire. */
export function reminderTaskOperationKey(reminderId: string, fireAt: string): string {
  return `${REMINDER_TASK_KEY_PREFIX}${reminderId}:${new Date(fireAt).toISOString()}`;
}

/** The reminder a task's creation key names (`reminderTaskOperationKey`), or undefined for any other key. */
export function reminderIdOfTaskKey(key: string | null): string | undefined {
  if (key === null || !key.startsWith(REMINDER_TASK_KEY_PREFIX)) return undefined;
  const rest = key.slice(REMINDER_TASK_KEY_PREFIX.length);
  const fireAt = rest.slice(-REMINDER_TASK_KEY_ISO_LENGTH);
  const instant = Date.parse(fireAt);
  if (
    rest.length <= REMINDER_TASK_KEY_ISO_LENGTH + 1 ||
    rest.at(-REMINDER_TASK_KEY_ISO_LENGTH - 1) !== ":" ||
    Number.isNaN(instant) ||
    new Date(instant).toISOString() !== fireAt
  )
    return undefined;
  return rest.slice(0, -REMINDER_TASK_KEY_ISO_LENGTH - 1);
}
