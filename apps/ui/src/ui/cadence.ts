import type { UiKey } from "../locales/en.js";
import { translateNow } from "../lib/i18n.js";
import { SCHEDULE_TIME_PATTERN, isValidTimeZone, scheduleSpecProblems, type ScheduleSpec, type SchedulesPayload } from "@tavi/contracts";

/** The week as people read it here: Monday first, Sunday last (0 = Sunday). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** `days` with `day` ticked or unticked, sorted; the last day ticked stays: a cadence runs on some day. */
export function toggleDay(days: readonly number[], day: number): readonly number[] {
  if (!days.includes(day)) return [...days, day].sort((a, b) => a - b);
  return days.length === 1 ? days : days.filter((value) => value !== day);
}

/** Which days a cadence runs on. */
export type DaysMode = "weekly" | "monthly" | "yearly" | "once";

/** Which times of the day. */
export type TimesMode = "times" | "hours";

export const daysMode = (spec: ScheduleSpec): DaysMode =>
  spec.once !== undefined ? "once" : spec.yearly !== undefined ? "yearly" : spec.monthly !== undefined ? "monthly" : "weekly";

export const timesMode = (spec: ScheduleSpec): TimesMode => (spec.everyHours === undefined ? "times" : "hours");

/** A spec's times of day as given: its `times`, or its `at`. */
export const listedTimes = (spec: Pick<ScheduleSpec, "at" | "times">): readonly string[] =>
  spec.times ?? (spec.at === undefined ? [] : [spec.at]);

export function withoutDays(spec: ScheduleSpec): ScheduleSpec {
  const { daysOfWeek: _days, monthly: _monthly, yearly: _yearly, once: _once, ...rest } = spec;
  return rest;
}

export function withoutTimes(spec: ScheduleSpec): ScheduleSpec {
  const { at: _at, times: _times, everyHours: _hours, between: _between, ...rest } = spec;
  return rest;
}

/** `spec` at these times of day: one is `at`, several are `times`. */
export function withTimes(spec: ScheduleSpec, times: readonly string[]): ScheduleSpec {
  const rest = withoutTimes(spec);
  return times.length === 1 ? { ...rest, at: times[0] } : { ...rest, times: [...times] };
}

/** A time after the latest of `times` that none of them is, for "Add a time". */
export function nextFreeTime(times: readonly string[]): string {
  const latest = [...times].sort().at(-1);
  const start = latest === undefined || !SCHEDULE_TIME_PATTERN.test(latest) ? 9 : Number(latest.slice(0, 2)) + 1;
  for (let step = 0; step < 24; step += 1) {
    const candidate = `${String((start + step) % 24).padStart(2, "0")}:00`;
    if (!times.includes(candidate)) return candidate;
  }
  return "12:00";
}

/** The words for what `scheduleSpecProblems` finds, as the form says them. */
const PROBLEM_WORDS: Readonly<Record<string, UiKey>> = {
  at: "ui.cadence.problemAt",
  times: "ui.cadence.problemTimes",
  between: "ui.cadence.problemBetween",
  monthly: "ui.cadence.problemMonthly",
  until: "ui.cadence.problemUntil",
  yearly: "ui.cadence.problemYearly",
};

/** What `scheduleSpecProblems` says of `path`, in the form's words where it has them. */
function problemWords(path: string, otherwise: string): string {
  const key = PROBLEM_WORDS[path];
  return key === undefined ? otherwise : translateNow(key);
}

/**
 * Why `spec` is not a cadence that can be saved, in the form's words, each
 * with the part it is about; none for one that can. The contracts' own
 * `scheduleSpecProblems`, plus what a form can leave half-typed: a time, a
 * date or a zone.
 */
export function cadenceProblems(spec: ScheduleSpec): readonly { readonly path: string; readonly message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const times = listedTimes(spec);
  if (spec.everyHours === undefined && times.length === 0) problems.push({ path: "at", message: translateNow("ui.cadence.problemAt") });
  if (times.some((time) => !SCHEDULE_TIME_PATTERN.test(time)))
    problems.push({ path: "times", message: translateNow("ui.cadence.problemTimeFormat") });
  if (spec.between !== undefined && !(SCHEDULE_TIME_PATTERN.test(spec.between.from) && SCHEDULE_TIME_PATTERN.test(spec.between.to)))
    problems.push({ path: "between", message: translateNow("ui.cadence.problemBetweenFormat") });
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (spec.once !== undefined && !date.test(spec.once)) problems.push({ path: "once", message: translateNow("ui.cadence.problemOnce") });
  if (spec.until !== undefined && !date.test(spec.until))
    problems.push({ path: "until", message: translateNow("ui.cadence.problemUntilFormat") });
  if (!isValidTimeZone(spec.timezone)) problems.push({ path: "timezone", message: translateNow("ui.cadence.problemTimezone") });
  const said = new Set(problems.map((problem) => problem.path));
  for (const problem of scheduleSpecProblems(spec))
    if (!said.has(problem.path)) problems.push({ path: problem.path, message: problemWords(problem.path, problem.message) });
  return problems;
}

/**
 * A cadence as `schedules add` and `preview` take it: its times (`at`,
 * `times`, or `everyHours` with `between`), its zone, its days (`days`, null
 * for every day, or `monthly`, `yearly`, `once`) and its end (`untilDate`).
 * Times and days are sorted, so two forms of one cadence compare equal.
 */
export function cadencePayload(
  spec: ScheduleSpec,
): Pick<SchedulesPayload, "at" | "times" | "everyHours" | "between" | "timezone" | "days" | "monthly" | "yearly" | "once" | "untilDate"> {
  const times = [...listedTimes(spec)].sort();
  return {
    ...(spec.everyHours !== undefined
      ? { everyHours: spec.everyHours, ...(spec.between === undefined ? {} : { between: { ...spec.between } }) }
      : times.length === 1
        ? { at: times[0] }
        : { times }),
    timezone: spec.timezone,
    ...(spec.once !== undefined
      ? { once: spec.once }
      : spec.yearly !== undefined
        ? { yearly: { ...spec.yearly } }
        : spec.monthly !== undefined
          ? { monthly: { ...spec.monthly } }
          : { days: spec.daysOfWeek === undefined ? null : [...spec.daysOfWeek].sort((a, b) => a - b) }),
    ...(spec.until === undefined ? {} : { untilDate: spec.until }),
  };
}

/** Whether two cadences run alike, as their payloads say them. */
export function sameCadence(a: ScheduleSpec, b: ScheduleSpec): boolean {
  return JSON.stringify(cadencePayload(a)) === JSON.stringify(cadencePayload(b));
}

/** The zones this browser knows, for the zone list; none where `Intl` cannot list them. */
export function knownZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}
