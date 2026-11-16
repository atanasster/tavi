import { z } from "zod";

import { TaviError } from "./errors.js";

/**
 * The time vocabulary every scheduled thing shares — schedules, routine
 * triggers, reminders, the heartbeat and the agenda: the wall-clock pattern,
 * zone validation, how late a fire may be, and the zone arithmetic the
 * occurrence math (`reminderOccurrenceSeries`) is built on.
 */

/** 24-hour `HH:MM`, a local wall-clock time. */
export const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether the platform's `Intl` accepts `value` as an IANA time zone.
 *
 * The runtime's own zone database is the authority, not a list shipped here:
 * `Intl.supportedValuesOf("timeZone")` omits aliases such as `Asia/Calcutta`
 * that `Intl.DateTimeFormat` still resolves, and the formatter is what later
 * renders the time.
 */
export function isValidTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A repeat's day each month: a day of the month, or its nth weekday (`nth: -1` for the last). */
export const ReminderMonthlySchema = z.union([
  z.strictObject({ dayOfMonth: z.number().int().min(1).max(31) }),
  z.strictObject({
    nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1)]),
    weekday: z.number().int().min(0).max(6),
  }),
]);
export type ReminderMonthly = z.infer<typeof ReminderMonthlySchema>;

/** A repeat's day each year: a month and its day. */
export const ReminderYearlySchema = z.strictObject({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });
export type ReminderYearly = z.infer<typeof ReminderYearlySchema>;

/** The most days each month has, February counted with its 29th. */
const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Whether a yearly date names a day its month has in some year: 29 February does, 31 April does not. */
export function yearlyDayExists(yearly: ReminderYearly): boolean {
  return yearly.day <= (LONGEST_MONTH[yearly.month - 1] ?? 31);
}

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
}

/**
 * A wall-clock reading observed in `timeZone`, plus that calendar date's
 * weekday.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: the latter renders midnight
 * as `24` in some ICU versions, which would silently shift a midnight schedule
 * by a day.
 */
function zonedParts(
  instant: Date,
  timeZone: string,
): LocalDate & { readonly hour: number; readonly minute: number; readonly second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value;
    if (found === undefined) {
      // An unrecognized zone is the only way here: `Intl` either accepts the
      // zone and always emits every requested part, or throws a RangeError on
      // construction. Surfaced as a typed error rather than an `NaN` date.
      throw new TaviError("INVALID_INPUT", `Could not read the ${type} of ${instant.toISOString()} in ${timeZone}`);
    }
    return Number.parseInt(found, 10);
  };
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    year,
    month,
    day,
    // The weekday of a calendar date is independent of the zone it is read in,
    // so deriving it from the pure UTC date of the same y/m/d is exact.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/**
 * The calendar date, weekday and wall-clock time `instant` reads as in
 * `timeZone` — the building block for calendar arithmetic in a zone
 * ("the previous day at 20:00") that must not be done in UTC.
 */
export function localDateTime(
  instant: Date,
  timeZone: string,
): LocalDate & { readonly hour: number; readonly minute: number; readonly second: number } {
  return zonedParts(instant, timeZone);
}

/** The zone's UTC offset, in milliseconds, at `instant`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const at = instant.getTime() - (instant.getTime() % 1000);
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - at;
}

/** A day either side of a wall time: wider than any zone's offset, and narrower than the gap between two transitions. */
const TRANSITION_PROBE_MS = 86_400_000;

/**
 * The instant at which `timeZone`'s local clock reads the given wall time.
 *
 * The zone's offsets a day before and a day after the wall time are the only
 * two it can be read under, so each is tried and kept when the zone agrees
 * that it was in effect then. The answer is chosen explicitly, the same in
 * every zone whichever side of UTC it lies:
 *
 * - **A wall time read twice** (the hour a fall-back repeats) resolves to the
 *   earlier instant, the first time the clock shows it.
 * - **A wall time that does not exist** (the hour a spring-forward skips)
 *   resolves to the gap's first minute: the transition itself, which the clock
 *   reads as the end of the gap (New York 02:30 is 03:00 EDT; Sofia 03:30 is
 *   04:00 EEST).
 */
export function instantForLocalTime(
  local: { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  const before = zoneOffsetMs(new Date(guess - TRANSITION_PROBE_MS), timeZone);
  const after = zoneOffsetMs(new Date(guess + TRANSITION_PROBE_MS), timeZone);
  const candidates = [...new Set([before, after])].map((offset) => ({ offset, at: guess - offset }));
  const valid = candidates.filter((candidate) => zoneOffsetMs(new Date(candidate.at), timeZone) === candidate.offset);
  if (valid.length > 0) return new Date(Math.min(...valid.map((candidate) => candidate.at)));

  // In a gap: the earlier candidate still reads the old offset and the later
  // one the new, so the transition lies between them. Walked by minutes, as a
  // transition falls on one; a gap is at most a couple of hours anywhere.
  const from = Math.min(...candidates.map((candidate) => candidate.at));
  const to = Math.max(...candidates.map((candidate) => candidate.at));
  let candidate = from;
  while (candidate < to && zoneOffsetMs(new Date(candidate), timeZone) === before) candidate += 60_000;
  return new Date(candidate);
}

/** The calendar date `offset` days after `base`, as a calendar (no zone involved). */
export function shiftLocalDate(base: LocalDate, offset: number): LocalDate {
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * How late a fire may be and still count as "on time".
 *
 * A tick that observes its own fire is late by up to one interval, so this must
 * comfortably exceed the interval (default 30s) without swallowing a genuine
 * miss. Two minutes is far above the first and far below any real outage. The
 * schedule sweep, the agenda and a routine run's late note all judge by it.
 */
export const ON_TIME_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * How long after a missed fire a catch-up run is still worth performing.
 * Beyond this the report's own lookback window no longer covers the period the
 * operator expected, so a late brief would be quietly wrong rather than merely
 * late. A reminder's late grace is the same six hours.
 */
export const MISSED_RUN_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * How a fire observed `lateMs` after its time stands: on time within
 * `ON_TIME_TOLERANCE_MS`, late (still run or delivered, said to be late)
 * within `MISSED_RUN_GRACE_MS`, and missed beyond it. The schedule sweep,
 * the reminder scheduler and the agenda's "overdue" all judge by it. A
 * schedule's fire exactly six hours late is still run; a reminder's
 * (`missedAtGrace`) is missed.
 */
export function fireDisposition(lateMs: number, options: { readonly missedAtGrace?: boolean } = {}): "on-time" | "late" | "missed" {
  if (lateMs <= ON_TIME_TOLERANCE_MS) return "on-time";
  const within = options.missedAtGrace === true ? lateMs < MISSED_RUN_GRACE_MS : lateMs <= MISSED_RUN_GRACE_MS;
  return within ? "late" : "missed";
}

/** The zone's short name at `instant` ("EDT", "GMT+3"), so a time on a repeated hour reads unambiguously. */
function zoneName(instant: Date, timeZone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone
  );
}

/**
 * What a run that started late is told, in `timeZone`: "Scheduled for 07:00
 * GMT+3, running at 11:40 GMT+3 (catch-up; …)", so a prompt's "since
 * yesterday" can widen. The times carry their dates when they fall on
 * different local days, and each its zone's short name. `missed` says earlier
 * occurrences went unrun, `lastRunAt` names the last one that ran, and
 * `resumedAt` says the run was cut short and is going on later, its window
 * unchanged. `retry` says the run is a fire tried again after a provider
 * failure, which covers what the fire would have. Said only to a late run: an
 * on-time one is told nothing, so its prompt does not grow.
 */
export function lateRunNote(input: {
  readonly scheduledFor: string;
  readonly runningAt: string;
  readonly timeZone: string;
  readonly resumedAt?: string;
  readonly missed?: boolean;
  readonly lastRunAt?: string;
  readonly retry?: { readonly count: number; readonly of: number };
}): string {
  const times = [input.scheduledFor, input.runningAt, input.resumedAt ?? input.lastRunAt]
    .filter((value) => value !== undefined)
    .map((value) => ({ local: localDateTime(new Date(value), input.timeZone), zone: zoneName(new Date(value), input.timeZone) }));
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = (local: LocalDate): string => `${local.year}-${pad(local.month)}-${pad(local.day)}`;
  const oneDay = times.every((time) => day(time.local) === day(times[0]!.local));
  const [scheduled, running, third] = times.map(
    ({ local, zone }) => `${oneDay ? "" : `${day(local)} `}${pad(local.hour)}:${pad(local.minute)} ${zone}`,
  );
  if (input.resumedAt !== undefined) {
    return `Scheduled for ${scheduled}, started at ${running}, resumed at ${third} after an interruption; the coverage window still ends when the run started.`;
  }
  if (input.retry !== undefined) {
    return `Scheduled for ${scheduled}, running at ${running} (retry ${input.retry.count} of ${input.retry.of}: an earlier try failed on a provider error; cover what the run due at ${scheduled} would have).`;
  }
  const since = third === undefined ? "the window since the last run may be longer than usual" : `the last run was ${third}`;
  return `Scheduled for ${scheduled}, running at ${running} (${input.missed === true ? "earlier runs were missed" : "catch-up"}; ${since}).`;
}
