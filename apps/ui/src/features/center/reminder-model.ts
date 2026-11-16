import {
  describeReminderOffset,
  instantForLocalTime,
  parseReminderOffset,
  repeatDaysText,
  type AgendaItem,
  type ReminderFire,
  type ReminderFireOutcome,
  type ReminderWhen,
} from "@tavi/contracts";

import { dayMonth, dayTime } from "../../lib/time.js";
import { weekdaysText } from "./schedule-model.js";

/**
 * Reminders' pure reads for Schedule and the rail: what a notice, a cadence and a fire say in words, and a local
 * date and time in the workspace zone as the instant the owner stores. Kept
 * free of React so each is asserted on its own.
 */

/** What a reminder became after `action`: "cancelled", "paused", "resumed". */
export function transitionWord(action: "pause" | "resume" | "cancel"): string {
  return action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "resumed";
}

/** The notices an event gets unless the reader changes them: the evening before at 20:00, and one hour before. */
export const DEFAULT_NOTICES = ["-1d@20:00", "-1h"] as const;

/**
 * A notice as people say it: "the evening before at 20:00", "1 hour before",
 * "2 days before at 09:00". A day-before notice at a set time is named by the
 * part of the day it falls in.
 */
export function noticeLabel(notice: string): string {
  const offset = parseReminderOffset(notice);
  if (offset === undefined) return notice;
  if (offset.unit === "d" && offset.amount === 1 && offset.at !== undefined) {
    const hour = Number.parseInt(offset.at, 10);
    const part = hour >= 17 ? "evening" : hour < 12 ? "morning" : "day";
    return `the ${part} before at ${offset.at}`;
  }
  return describeReminderOffset(offset);
}

/** What `repeatText` reads of a repeat: its times, and its weekdays or its monthly or yearly day. */
export type RepeatFields = Pick<Extract<ReminderWhen, { kind: "repeat" }>, "times" | "daysOfWeek" | "monthly" | "yearly" | "until">;

/**
 * A repeat's cadence: "Daily 21:00", "Mon–Fri 07:00, 19:00", "Monthly on the
 * 1st, 09:00", "Yearly on 29 Feb, 09:00", "Daily 08:00 · until 31 Dec".
 */
export function repeatText(repeat: RepeatFields): string {
  const times = [...repeat.times].sort().join(", ");
  const cadence =
    repeat.monthly !== undefined || repeat.yearly !== undefined
      ? `${repeatDaysText(repeat, "label")}, ${times}`
      : `${weekdaysText(repeat.daysOfWeek) ?? "Daily"} ${times}`;
  return `${cadence}${repeat.until === undefined ? "" : ` · until ${dayMonth(repeat.until)}`}`;
}

/** A reminder's cadence in words: "Once", "Event Mon 5 Oct 10:00", or its repeat. */
export function whenText(when: ReminderWhen, timeZone: string | undefined, today?: string): string {
  switch (when.kind) {
    case "once":
      return "Once";
    case "event":
      return `Event ${dayTime(when.at, timeZone, today)}`;
    case "repeat":
      return repeatText(when);
  }
}

/** An agenda occurrence of a reminder, in words: "Once", "Event Mon 5 Oct 10:00 · the evening before at 20:00", or its repeat. */
export function agendaReminderText(item: AgendaItem, timeZone: string | undefined, today?: string): string {
  const reminder = item.reminder;
  if (reminder === undefined) return "Once";
  if (reminder.cadence === "event") {
    const event = reminder.eventAt === undefined ? "Event" : `Event ${dayTime(reminder.eventAt, timeZone, today)}`;
    return reminder.notice === undefined ? event : `${event} · ${noticeLabel(reminder.notice)}`;
  }
  if (reminder.cadence === "repeat") {
    const { cadence } = item;
    return repeatText({
      times: reminder.times ?? (cadence.kind === "once" ? [] : [cadence.at]),
      daysOfWeek: cadence.kind === "daily" ? cadence.daysOfWeek : undefined,
      monthly: reminder.monthly,
      yearly: reminder.yearly,
      until: reminder.until,
    });
  }
  return "Once";
}

/**
 * An event with its notices, as the reader checks it: "Mon 10:00 · reminds
 * Sun 20:00, Mon 09:00". `notices` are the fires still to come.
 */
export function eventLine(eventAt: string, notices: readonly string[], timeZone: string | undefined, today?: string): string {
  const reminds =
    notices.length === 0 ? "no notice still to come" : `reminds ${notices.map((at) => dayTime(at, timeZone, today)).join(", ")}`;
  return `${dayTime(eventAt, timeZone, today)} · ${reminds}`;
}

const OUTCOMES: Readonly<Record<ReminderFireOutcome, string>> = {
  pending: "Due",
  delivered: "Delivered",
  "delivered-in-app": "Delivered in the app",
  missed: "Missed",
  failed: "Failed",
  snoozed: "Snoozed",
};

/** A fire's outcome as its history says it: "Delivered · late", "Snoozed", "Missed". */
export function fireOutcomeText(fire: Pick<ReminderFire, "outcome" | "late" | "acknowledgedAt">): string {
  const parts = [OUTCOMES[fire.outcome] ?? fire.outcome];
  if (fire.late === true) parts.push("late");
  if (fire.acknowledgedAt !== undefined && fire.outcome !== "snoozed") parts.push("done");
  return parts.join(" · ");
}

/**
 * A reminder's latest fire as its Recurring row says it: "Shown in the app
 * Mon 5 Oct 10:00", "Missed Mon 5 Oct 10:00", "Failed …", with "late" when it
 * came late.
 */
export function lastFireText(
  fire: Pick<ReminderFire, "outcome" | "late" | "fireAt" | "firedAt">,
  timeZone: string | undefined,
  today?: string,
): string {
  const at = dayTime(
    fire.outcome === "delivered" || fire.outcome === "delivered-in-app" ? (fire.firedAt ?? fire.fireAt) : fire.fireAt,
    timeZone,
    today,
  );
  const what =
    fire.outcome === "delivered-in-app"
      ? "Shown in the app"
      : fire.outcome === "delivered"
        ? "Delivered to the chat"
        : (OUTCOMES[fire.outcome] ?? fire.outcome);
  return `${what} ${at}${fire.late === true ? " · late" : ""}`;
}

/** Each reminder's latest fire that has happened (delivered, missed, failed or snoozed), from a list of fires newest first. */
export function latestFires<T extends Pick<ReminderFire, "reminderId" | "outcome" | "firedAt">>(
  fires: readonly T[],
): ReadonlyMap<string, T> {
  const latest = new Map<string, T>();
  for (const fire of fires) {
    if (fire.outcome === "pending" && fire.firedAt === null) continue;
    if (!latest.has(fire.reminderId)) latest.set(fire.reminderId, fire);
  }
  return latest;
}

/**
 * A date (`YYYY-MM-DD`) and time (`HH:MM`) read in `timeZone`, as the instant
 * the owner stores (ISO, UTC). Undefined for input that is not a date and time.
 * DST-safe through the contracts' own conversion: a time the clocks skip is
 * read as the first minute that exists.
 */
export function localToInstant(date: string, time: string, timeZone: string): string | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (dateMatch === null || timeMatch === null) return undefined;
  const [year, month, day] = dateMatch.slice(1).map(Number) as [number, number, number];
  const [hour, minute] = timeMatch.slice(1).map(Number) as [number, number];
  if (hour > 23 || minute > 59) return undefined;
  try {
    return instantForLocalTime({ year, month, day, hour, minute }, timeZone).toISOString();
  } catch {
    return undefined;
  }
}

/** A notice from the editor's parts: `-2h`, `-1d@20:00`; undefined when they do not make one. */
export function noticeFrom(amount: number, unit: "m" | "h" | "d", at: string | undefined): string | undefined {
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  const notice = `-${amount}${unit}${unit === "d" && at !== undefined && at !== "" ? `@${at}` : ""}`;
  return parseReminderOffset(notice) === undefined ? undefined : notice;
}
