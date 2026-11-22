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

import { translateCore, translateNow } from "../../lib/i18n.js";
import { dayMonth, dayTime } from "../../lib/time.js";
import type { UiKey } from "../../locales/en.js";
import { weekdaysText } from "./schedule-model.js";

/**
 * Reminders' pure reads for Schedule and the rail: what a notice, a cadence and a fire say in words, and a local
 * date and time in the workspace zone as the instant the owner stores. Kept
 * free of React so each is asserted on its own.
 */

/** What a reminder became after `action`, as one sentence: "Reminder cancelled.", "Walk the dog paused." with its `name`. */
export function transitionSaid(action: "pause" | "resume" | "cancel", name?: string): string {
  if (name === undefined) {
    return translateNow(
      action === "cancel"
        ? "center.reminderModel.cancelled"
        : action === "pause"
          ? "center.reminderModel.paused"
          : "center.reminderModel.resumed",
    );
  }
  return translateNow(
    action === "cancel"
      ? "center.reminderModel.namedCancelled"
      : action === "pause"
        ? "center.reminderModel.namedPaused"
        : "center.reminderModel.namedResumed",
    { name },
  );
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
    const key: UiKey =
      hour >= 17
        ? "center.reminderModel.eveningBefore"
        : hour < 12
          ? "center.reminderModel.morningBefore"
          : "center.reminderModel.dayBefore";
    return translateNow(key, { at: offset.at });
  }
  return describeReminderOffset(offset, translateCore);
}

/** What `repeatText` reads of a repeat: its times, and its weekdays or its monthly or yearly day. */
export type RepeatFields = Pick<Extract<ReminderWhen, { kind: "repeat" }>, "times" | "daysOfWeek" | "monthly" | "yearly" | "until">;

/**
 * A repeat's cadence: "Daily 21:00", "Mon–Fri 07:00, 19:00", "Monthly on the
 * 1st, 09:00", "Yearly on 29 Feb, 09:00", "Daily 08:00 · until 31 Dec".
 */
export function repeatText(repeat: RepeatFields): string {
  const times = [...repeat.times].sort().join(", ");
  const days = weekdaysText(repeat.daysOfWeek);
  const cadence =
    repeat.monthly !== undefined || repeat.yearly !== undefined
      ? translateNow("center.reminderModel.repeatDated", { days: repeatDaysText(repeat, "label", translateCore), times })
      : days === undefined
        ? translateNow("center.reminderModel.repeatDaily", { times })
        : translateNow("center.reminderModel.repeatWeekdays", { days, times });
  return repeat.until === undefined ? cadence : translateNow("center.reminderModel.repeatUntil", { cadence, date: dayMonth(repeat.until) });
}

/** A reminder's cadence in words: "Once", "Event Mon 5 Oct 10:00", or its repeat. */
export function whenText(when: ReminderWhen, timeZone: string | undefined, today?: string): string {
  switch (when.kind) {
    case "once":
      return translateNow("center.reminderModel.once");
    case "event":
      return translateNow("center.reminderModel.eventAt", { at: dayTime(when.at, timeZone, today) });
    case "repeat":
      return repeatText(when);
  }
}

/** An agenda occurrence of a reminder, in words: "Once", "Event Mon 5 Oct 10:00 · the evening before at 20:00", or its repeat. */
export function agendaReminderText(item: AgendaItem, timeZone: string | undefined, today?: string): string {
  const reminder = item.reminder;
  if (reminder === undefined) return translateNow("center.reminderModel.once");
  if (reminder.cadence === "event") {
    const event =
      reminder.eventAt === undefined
        ? translateNow("center.reminderModel.event")
        : translateNow("center.reminderModel.eventAt", { at: dayTime(reminder.eventAt, timeZone, today) });
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
  return translateNow("center.reminderModel.once");
}

/**
 * An event with its notices, as the reader checks it: "Mon 10:00 · reminds
 * Sun 20:00, Mon 09:00". `notices` are the fires still to come.
 */
export function eventLine(eventAt: string, notices: readonly string[], timeZone: string | undefined, today?: string): string {
  const event = dayTime(eventAt, timeZone, today);
  return notices.length === 0
    ? translateNow("center.reminderModel.eventNoNotice", { event })
    : translateNow("center.reminderModel.eventReminds", { event, notices: notices.map((at) => dayTime(at, timeZone, today)).join(", ") });
}

const OUTCOMES: Readonly<Record<ReminderFireOutcome, UiKey>> = {
  pending: "center.reminderModel.outcome.pending",
  delivered: "center.reminderModel.outcome.delivered",
  "delivered-in-app": "center.reminderModel.outcome.deliveredInApp",
  missed: "center.reminderModel.outcome.missed",
  failed: "center.reminderModel.outcome.failed",
  snoozed: "center.reminderModel.outcome.snoozed",
};

/** An outcome in words; one this build does not know, as the owner wrote it. */
const outcomeWord = (outcome: ReminderFireOutcome): string => {
  const key = OUTCOMES[outcome] as UiKey | undefined;
  return key === undefined ? outcome : translateNow(key);
};

/** A fire's outcome as its history says it: "Delivered · late", "Snoozed", "Missed". */
export function fireOutcomeText(fire: Pick<ReminderFire, "outcome" | "late" | "acknowledgedAt">): string {
  const parts = [outcomeWord(fire.outcome)];
  if (fire.late === true) parts.push(translateNow("center.reminderModel.late"));
  if (fire.acknowledgedAt !== undefined && fire.outcome !== "snoozed") parts.push(translateNow("center.reminderModel.done"));
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
      ? translateNow("center.reminderModel.shownInApp")
      : fire.outcome === "delivered"
        ? translateNow("center.reminderModel.deliveredToChat")
        : outcomeWord(fire.outcome);
  return translateNow(fire.late === true ? "center.reminderModel.lastFireLate" : "center.reminderModel.lastFire", { what, at });
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
