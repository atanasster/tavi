/**
 * Opening hours: the part of
 * OSM's `opening_hours` syntax most places use, and JSON-LD's
 * `OpeningHoursSpecification`, read into one week. What this reader does not
 * know — months, dates, weeks, sunrise, `||` fallbacks, comments — makes the
 * whole value unknown rather than half read. Public holidays (`PH`) are kept
 * aside as a caveat: whether today is one is not known here.
 */

/** Minutes after midnight; an interval past 1440 runs into the next day. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** Monday first: `days[0]` is Monday, `days[6]` Sunday. */
export interface Week {
  readonly days: readonly (readonly Interval[])[];
  /** `PH`: the value names public holidays, which this week does not show. */
  readonly holidaysDiffer: boolean;
}

const DAY_CODES = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
const SCHEMA_DAYS: Readonly<Record<string, number>> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};
const MINUTES_PER_DAY = 1_440;

const emptyDays = (): Interval[][] => Array.from({ length: 7 }, () => []);

/** `HH:MM` as minutes, `24:00` allowed; `undefined` for anything else. */
function minutes(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 24 || mins > 59 || (hours === 24 && mins > 0)) return undefined;
  return hours * 60 + mins;
}

/** `09:00-18:00,19:00-22:00` as intervals; overnight `22:00-02:00` ends past midnight. */
function intervals(text: string): Interval[] | undefined {
  const out: Interval[] = [];
  for (const part of text.split(",")) {
    const [from, to, extra] = part.split("-");
    if (from === undefined || to === undefined || extra !== undefined) return undefined;
    const start = minutes(from);
    let end = minutes(to.replace(/\+$/, ""));
    if (start === undefined || end === undefined) return undefined;
    if (end <= start) end += MINUTES_PER_DAY;
    out.push({ start, end });
  }
  return out;
}

/** `Mo-Fr,Su` as day indexes; `PH` noted; `undefined` for a selector this reader does not know. */
function weekdays(text: string): { readonly days: readonly number[]; readonly holidays: boolean } | undefined {
  const days = new Set<number>();
  let holidays = false;
  for (const part of text.toLowerCase().split(",")) {
    if (part === "ph") {
      holidays = true;
      continue;
    }
    const [from, to, extra] = part.split("-");
    const start = DAY_CODES.indexOf(from as (typeof DAY_CODES)[number]);
    if (start === -1 || extra !== undefined) return undefined;
    const end = to === undefined ? start : DAY_CODES.indexOf(to as (typeof DAY_CODES)[number]);
    if (end === -1) return undefined;
    // `Fr-Mo` wraps through the weekend.
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return { days: [...days], holidays };
}

/**
 * An OSM `opening_hours` value as a week, or `undefined` when it uses syntax
 * this reader does not know. Later rules replace earlier ones for the days
 * they name, as the syntax says.
 */
export function parseOpeningHours(value: string): Week | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  if (text === "24/7") return { days: Array.from({ length: 7 }, () => [{ start: 0, end: MINUTES_PER_DAY }]), holidaysDiffer: false };
  if (/\|\||"|\[|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week|sunrise|sunset|dawn|dusk|easter|sh)\b|\d{4}/i.test(text))
    return undefined;
  const days = emptyDays();
  let holidaysDiffer = false;
  for (const rawRule of text.split(";")) {
    const rule = rawRule.trim();
    if (rule === "") continue;
    // A bare `off` or `closed` closes every day; read before a day code, which `of` and `cl` are not.
    if (/^(?:off|closed)$/i.test(rule)) {
      for (let day = 0; day < 7; day += 1) days[day] = [];
      continue;
    }
    const match = /^(?:([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s*)?(.*)$/.exec(rule);
    const selector = match?.[1]?.replace(/\s+/g, "");
    const times = (match?.[2] ?? "").trim().toLowerCase();
    const named = selector === undefined ? { days: [0, 1, 2, 3, 4, 5, 6], holidays: false } : weekdays(selector);
    if (named === undefined) return undefined;
    if (named.holidays) holidaysDiffer = true;
    if (named.days.length === 0) continue;
    const closed = times === "off" || times === "closed";
    const read = closed ? [] : times === "" ? undefined : intervals(times.replace(/\s+/g, ""));
    if (read === undefined) return undefined;
    for (const day of named.days) days[day] = [...read];
  }
  return { days, holidaysDiffer };
}

/**
 * JSON-LD `OpeningHoursSpecification` items (a business's own page, read by
 * `browser.structured`) as a week; `undefined` when none could be read.
 * Items with `validFrom`/`validThrough` are seasonal and are left out.
 */
export function weekFromSpecification(items: readonly unknown[]): Week | undefined {
  const days = emptyDays();
  let read = 0;
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const spec = item as Record<string, unknown>;
    if (spec["validFrom"] !== undefined || spec["validThrough"] !== undefined) continue;
    const names = Array.isArray(spec["dayOfWeek"]) ? spec["dayOfWeek"] : [spec["dayOfWeek"]];
    const opens = typeof spec["opens"] === "string" ? minutes(spec["opens"].slice(0, 5)) : undefined;
    const closesAt = typeof spec["closes"] === "string" ? minutes(spec["closes"].slice(0, 5)) : undefined;
    if (opens === undefined || closesAt === undefined) continue;
    const end = closesAt <= opens ? closesAt + MINUTES_PER_DAY : closesAt;
    for (const name of names) {
      if (typeof name !== "string") continue;
      const day = SCHEMA_DAYS[name.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase()];
      if (day === undefined) continue;
      // `00:00`–`00:00` is how many pages say closed that day.
      if (opens === 0 && closesAt === 0) days[day] = [];
      else (days[day] as Interval[]).push({ start: opens, end });
      read += 1;
    }
  }
  return read === 0 ? undefined : { days: days.map((day) => [...day].sort((a, b) => a.start - b.start)), holidaysDiffer: false };
}

const pad = (n: number): string => String(n).padStart(2, "0");
const clock = (mins: number): string => `${pad(Math.floor((mins % MINUTES_PER_DAY) / 60))}:${pad(mins % 60)}`;
const dayLabel = (day: number): string => (DAY_CODES[day] ?? "mo").replace(/^./, (c) => c.toUpperCase());

/** A week written back in OSM's syntax, consecutive equal days grouped: the form two sources are compared in. */
export function formatWeek(week: Week): string {
  const key = (day: readonly Interval[]): string =>
    day.length === 0
      ? "off"
      : day.map((span) => `${clock(span.start)}-${span.end === MINUTES_PER_DAY ? "24:00" : clock(span.end)}`).join(",");
  const rules: string[] = [];
  for (let day = 0; day < 7; ) {
    let last = day;
    while (last + 1 < 7 && key(week.days[last + 1] ?? []) === key(week.days[day] ?? [])) last += 1;
    rules.push(`${dayLabel(day)}${last > day ? `-${dayLabel(last)}` : ""} ${key(week.days[day] ?? [])}`);
    day = last + 1;
  }
  return `${rules.join("; ")}${week.holidaysDiffer ? "; PH differs" : ""}`;
}

/** Whether two weeks open the same hours every day. */
export function weeksAgree(a: Week, b: Week): boolean {
  return formatWeek({ ...a, holidaysDiffer: false }) === formatWeek({ ...b, holidaysDiffer: false });
}

/**
 * Whether the week is open at `at`, an ISO time whose offset is taken as the
 * place's own (the person names the time where the place is). `undefined`
 * for a time without an offset.
 */
export function openAt(week: Week, at: string): boolean | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  if (match === null || !/(Z|[+-]\d{2}:?\d{2})$/.test(at)) return undefined;
  const weekday = (new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() + 6) % 7;
  const now = Number(match[4]) * 60 + Number(match[5]);
  const today = week.days[weekday] ?? [];
  const yesterday = week.days[(weekday + 6) % 7] ?? [];
  return (
    today.some((span) => now >= span.start && now < span.end) ||
    yesterday.some((span) => span.end > MINUTES_PER_DAY && now < span.end - MINUTES_PER_DAY)
  );
}

/** Countries in one time zone (their islands abroad have codes of their own): where an instant is the place's local time without knowing where in the country it is. */
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
  AD: "Europe/Andorra",
  AE: "Asia/Dubai",
  AL: "Europe/Tirane",
  AT: "Europe/Vienna",
  BA: "Europe/Sarajevo",
  BE: "Europe/Brussels",
  BG: "Europe/Sofia",
  CH: "Europe/Zurich",
  CY: "Asia/Nicosia",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  EE: "Europe/Tallinn",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GR: "Europe/Athens",
  HR: "Europe/Zagreb",
  HU: "Europe/Budapest",
  IE: "Europe/Dublin",
  IL: "Asia/Jerusalem",
  IN: "Asia/Kolkata",
  IS: "Atlantic/Reykjavik",
  IT: "Europe/Rome",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  LI: "Europe/Vaduz",
  LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg",
  LV: "Europe/Riga",
  MC: "Europe/Monaco",
  MD: "Europe/Chisinau",
  ME: "Europe/Podgorica",
  MK: "Europe/Skopje",
  MT: "Europe/Malta",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  PL: "Europe/Warsaw",
  RO: "Europe/Bucharest",
  RS: "Europe/Belgrade",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  SI: "Europe/Ljubljana",
  SK: "Europe/Bratislava",
  TH: "Asia/Bangkok",
  TR: "Europe/Istanbul",
  ZA: "Africa/Johannesburg",
};

/**
 * `at` as the wall time where the place is, with that zone's offset, for a
 * country in one time zone: "16:00Z" in Sofia in October is 19:00+03:00.
 * Elsewhere, or for a time without an offset, `at` as given, its offset
 * taken as the place's own.
 */
export function placeLocalTime(at: string, country: string | undefined): string {
  const zone = country === undefined ? undefined : COUNTRY_ZONES[country];
  const instant = Date.parse(at);
  if (zone === undefined || !/(Z|[+-]\d{2}:?\d{2})$/.test(at) || !Number.isFinite(instant)) return at;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  const minutes = Math.round((wall - Math.floor(instant / 1000) * 1000) / 60_000);
  const offset = `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}${offset}`;
}

export type HoursConfidence = "high" | "medium" | "low";

export interface HoursReading {
  readonly week: Week;
  /** When the source last checked these hours, if it says. */
  readonly checkedAt?: string | undefined;
}

/** A recent check: within this many days counts towards high confidence. */
export const HOURS_FRESH_DAYS = 180;
/** No check newer than this: the hours are stale. */
export const HOURS_STALE_DAYS = 730;
const DAY_MS = 86_400_000;

/**
 * How far a place's hours can be trusted: `high` only when two
 * sources agree and one was checked within 180 days; `low` when they
 * disagree, or the newest check is over two years old; otherwise `medium`.
 */
export function hoursConfidence(
  readings: readonly HoursReading[],
  now: string,
): { readonly confidence: HoursConfidence; readonly conflict: boolean; readonly stale: boolean } {
  const nowMs = Date.parse(now);
  const first = readings[0];
  const conflict = first !== undefined && readings.some((reading) => !weeksAgree(reading.week, first.week));
  const checks = readings
    .map((reading) => (reading.checkedAt === undefined ? Number.NaN : Date.parse(reading.checkedAt)))
    .filter((ms) => Number.isFinite(ms));
  const newest = checks.length === 0 ? undefined : Math.max(...checks);
  const stale = newest !== undefined && nowMs - newest > HOURS_STALE_DAYS * DAY_MS;
  if (conflict || stale) return { confidence: "low", conflict, stale };
  const fresh = newest !== undefined && nowMs - newest <= HOURS_FRESH_DAYS * DAY_MS;
  return { confidence: readings.length >= 2 && fresh ? "high" : "medium", conflict, stale };
}
