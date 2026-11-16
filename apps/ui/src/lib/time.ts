import { hostTimeZone, instantForLocalTime } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

/**
 * The canvas's words for days, times and spans. Days and times are the
 * workspace zone's — the one `center summary` names — never the browser's, so
 * this page and Telegram agree on what today is. Kept free of React so each
 * is asserted on its own.
 */

const formatters = new Map<
  string,
  { readonly date: Intl.DateTimeFormat; readonly time: Intl.DateTimeFormat; readonly day: Intl.DateTimeFormat }
>();

/**
 * The zone's formatters, made once. A zone this browser's ICU does not know
 * falls back to the browser's own rather than throwing mid-render: the times
 * are then the reader's, not the workspace's, which is the lesser wrong.
 */
function formattersFor(timeZone: string | undefined): {
  readonly date: Intl.DateTimeFormat;
  readonly time: Intl.DateTimeFormat;
  readonly day: Intl.DateTimeFormat;
} {
  const key = timeZone ?? "";
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  const make = (zone: string | undefined) => ({
    date: new Intl.DateTimeFormat("en-CA", {
      ...(zone === undefined ? {} : { timeZone: zone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    time: new Intl.DateTimeFormat("en-GB", {
      ...(zone === undefined ? {} : { timeZone: zone }),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
    day: new Intl.DateTimeFormat("en-GB", {
      ...(zone === undefined ? {} : { timeZone: zone }),
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
  });
  let made: ReturnType<typeof make>;
  try {
    made = make(timeZone);
  } catch {
    made = make(undefined);
  }
  formatters.set(key, made);
  return made;
}

/** The calendar day `iso` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function localDate(iso: string, timeZone: string | undefined): string {
  const parts = formattersFor(timeZone).date.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Today in `timeZone`, as `YYYY-MM-DD` (`now`: a test's or a clock's own time). */
export function todayIn(timeZone: string | undefined, now: Date | number = Date.now()): string {
  return localDate(new Date(now).toISOString(), timeZone);
}

/** One day in milliseconds: a span measured on the clock, not the calendar. */
export const DAY_MS = 86_400_000;

/** "14:20" today, or "Tue 12 Oct 14:20" on another day: a day-long snooze or pause never reads as later today. */
export function whenLocal(iso: string, timeZone: string | undefined, now: Date | number = Date.now()): string {
  if (localDate(iso, timeZone) === todayIn(timeZone, now)) return localTime(iso, timeZone);
  return `${localDay(iso, timeZone)} ${localTime(iso, timeZone)}`;
}

/** The day `iso` falls on in `timeZone`, as "Tue 12 Oct". */
export function localDay(iso: string, timeZone: string | undefined): string {
  return formattersFor(timeZone).day.format(new Date(iso));
}

/** The day `iso` falls on in `timeZone`, with the year when that is not this year there: "Tue 12 Oct", "Sun 12 Oct 2025". */
export function localDayWithYear(iso: string, timeZone: string | undefined, now: Date | number = Date.now()): string {
  const year = localDate(iso, timeZone).slice(0, 4);
  return year === todayIn(timeZone, now).slice(0, 4) ? localDay(iso, timeZone) : `${localDay(iso, timeZone)} ${year}`;
}

/** Like `whenLocal`, with the year on a day that is not this year: for a record that may be old. */
export function whenLocalWithYear(iso: string, timeZone: string | undefined, now: Date | number = Date.now()): string {
  if (localDate(iso, timeZone) === todayIn(timeZone, now)) return localTime(iso, timeZone);
  return `${localDayWithYear(iso, timeZone, now)} ${localTime(iso, timeZone)}`;
}

/** The wall-clock time `iso` shows in `timeZone`, `HH:MM` on a 24-hour clock. */
export function localTime(iso: string, timeZone: string | undefined): string {
  return formattersFor(timeZone).time.format(new Date(iso));
}

/** How a new chat greets the reader at `now` in `timeZone`: morning from 05:00, afternoon from 12:00, evening from 18:00. */
export function greeting(timeZone: string | undefined, now: Date | number = Date.now()): string {
  const hour = Number(formattersFor(timeZone).time.format(now).slice(0, 2));
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/** `date` (`YYYY-MM-DD`) at UTC midnight, moved by `days`: calendar arithmetic, so no zone or DST is involved. */
function utcMidnight(date: string, days = 0): number {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day + days);
}

/** `date` (`YYYY-MM-DD`) moved by `days`: calendar arithmetic, so no zone or DST is involved. */
export function shiftDate(date: string, days: number): string {
  return new Date(utcMidnight(date, days)).toISOString().slice(0, 10);
}

/**
 * The last millisecond of `date` (`YYYY-MM-DD`) in `timeZone`, as ISO: the
 * `until` that lists a day and everything before it. A zone this browser does
 * not know is read as the browser's own, as the formatters do.
 */
export function dayEnd(date: string, timeZone: string | undefined): string {
  const [year = 1970, month = 1, day = 1] = shiftDate(date, 1).split("-").map(Number);
  const zone = timeZone ?? hostTimeZone();
  let midnight: Date;
  try {
    midnight = instantForLocalTime({ year, month, day, hour: 0, minute: 0 }, zone);
  } catch {
    midnight = new Date(year, month - 1, day);
  }
  return new Date(midnight.getTime() - 1).toISOString();
}

// Spelled here rather than asked of `Intl`: ICU's en-GB month abbreviations
// differ between versions ("Sep" / "Sept"), and the heading must not.
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function calendar(date: string): { readonly weekday: string; readonly day: number; readonly month: string; readonly year: number } {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(utcMidnight(date)).getUTCDay()] ?? "";
  return { weekday, day, month: MONTHS[month - 1] ?? "", year };
}

/** A `YYYY-MM-DD` date as "31 Dec". */
export function dayMonth(date: string): string {
  const { day, month } = calendar(date);
  return `${day} ${month}`;
}

/**
 * `date` said relative to `today`, when it is today or the day next to it
 * `toward` the past ("yesterday") or the future ("tomorrow"); otherwise
 * `undefined`, for the caller's own words.
 */
export function relativeDay(date: string, today: string, toward: "past" | "future"): "today" | "yesterday" | "tomorrow" | undefined {
  if (date === today) return "today";
  if (date === shiftDate(today, toward === "past" ? -1 : 1)) return toward === "past" ? "yesterday" : "tomorrow";
  return undefined;
}

/** `date` as a short day: "Tue 29 Sep", with the year when it is not `today`'s. */
export function shortDay(date: string, today?: string): string {
  const { weekday, day, month, year } = calendar(date);
  const other = today !== undefined && calendar(today).year !== year;
  return `${weekday.slice(0, 3)} ${day} ${month}${other ? ` ${year}` : ""}`;
}

/** `date` as a long day: "Wednesday 30 Sep", with the year when it is not `today`'s. */
export function longDay(date: string, today?: string): string {
  const { weekday, day, month, year } = calendar(date);
  const other = today !== undefined && calendar(today).year !== year;
  return `${weekday} ${day} ${month}${other ? ` ${year}` : ""}`;
}

/** "Mon 5 Oct 10:00": an instant as a day and time in the workspace zone. */
export function dayTime(iso: string, timeZone: string | undefined, today?: string): string {
  return `${shortDay(localDate(iso, timeZone), today)} ${localTime(iso, timeZone)}`;
}

/**
 * An instant as people scan it: the time alone on `today`, else the short day
 * and the time ("Tue 29 Sep 14:30"), both in `timeZone`.
 */
export function instantLabel(iso: string, timeZone: string | undefined, today: string): string {
  return localDate(iso, timeZone) === today ? localTime(iso, timeZone) : dayTime(iso, timeZone, today);
}

/**
 * A day group's heading, in two parts so the page can weigh them: "Today" and
 * "Tue 29 Sep", "Yesterday" and "Mon 28 Sep", else "Sunday" and "27 Sep".
 */
export function dayHeading(date: string, today: string): { readonly title: string; readonly detail: string } {
  if (date === today) return { title: "Today", detail: shortDay(date, today) };
  if (date === shiftDate(today, -1)) return { title: "Yesterday", detail: shortDay(date, today) };
  const { weekday, day, month, year } = calendar(date);
  return { title: weekday, detail: `${day} ${month}${calendar(today).year === year ? "" : ` ${year}`}` };
}

/**
 * Items grouped by the day `at` falls on in `timeZone`, in the order given:
 * the items come sorted (newest or soonest first), so a day's are together.
 */
export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => string,
  timeZone: string | undefined,
): readonly { readonly date: string; readonly items: readonly T[] }[] {
  const groups: { date: string; items: T[] }[] = [];
  for (const item of items) {
    const date = localDate(at(item), timeZone);
    const last = groups.at(-1);
    if (last?.date === date) last.items.push(item);
    else groups.push({ date, items: [item] });
  }
  return groups;
}

/**
 * `date` said relative to `today` when it is today or the day next to it
 * `toward` the past or the future ("yesterday", "tomorrow"), else as a short day.
 */
export function nearDay(date: string, today: string, toward: "past" | "future"): string {
  return relativeDay(date, today, toward) ?? shortDay(date, today);
}

/**
 * An owner timestamp as people read it, in the workspace's `timeZone`: the
 * time today, else the day and time; anything unparseable is shown as sent.
 */
export function when(value: string | null | undefined, timeZone: string | undefined, empty = "—", now: Date = new Date()): string {
  if (value === null || value === undefined) return empty;
  if (Number.isNaN(Date.parse(value))) return value;
  return instantLabel(value, timeZone, todayIn(timeZone, now));
}

/** How far `at` is from `now`, as the timeline says it: "in 5 min", "in 14 h", "in 1 day", "in 6 days" — days counted on the calendar in `timeZone`. */
export function relativeTime(at: string, now: number, timeZone?: string): string {
  const ms = Date.parse(at) - now;
  if (Number.isNaN(ms)) return "";
  if (ms < 60_000) return ms < 0 ? "due now" : "in under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `in ${hours} h`;
  // Days on the calendar, as the list's day headings count them: tomorrow's 07:00 and 19:30 are both "in 1 day".
  const days = Math.max(1, calendarDaysBetween(todayIn(timeZone, now), localDate(at, timeZone)));
  return `in ${plural(days, "day")}`;
}

/** Whole calendar days from one `YYYY-MM-DD` to another. */
function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

/**
 * A time left, rounded up: "25 min", "2 h", "2 h 5 min". With `seconds`, under
 * two minutes it is "45 s"; with `days`, a day or more is "1 d" or "1 d 3 h".
 */
export function durationText(
  ms: number,
  { seconds = false, days = false }: { readonly seconds?: boolean; readonly days?: boolean } = {},
): string {
  if (seconds && ms < 120_000) return `${Math.max(1, Math.ceil(ms / 1000))} s`;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (!days || hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const whole = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${whole} d` : `${whole} d ${hours % 24} h`;
}

/** `1.4s`, `2m 05s`, `1h 02m` — short enough for a strip, exact enough to act on. */
export function formatElapsed(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `1.2s`, `340ms` — a tool call's own duration, as the owner measured it. */
export function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}
