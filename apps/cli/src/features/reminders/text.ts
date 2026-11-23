import {
  describeReminderOffset,
  instantForLocalTime,
  isCoreKey,
  parseReminderOffset,
  reminderReadBack,
  type Reminder,
  type ReminderCreateAnswer,
  type ReminderFire,
  type ReminderGetAnswer,
  type ReminderSnoozeAnswer,
  type ReminderView,
  type ReminderWhen,
  type ReminderWriteAnswer,
  type RemindersListAnswer,
  type RemindersPayload,
  repeatDaysText,
} from "@tavi/contracts";

import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";
import stringWidth from "string-width";
import { alignedColumns, indentedLines } from "../../shared/terminal-text.js";
import { reminderWhenText } from "./when-text.js";
import type { ReminderTimeInput, ReminderWhenInput, RemindersCommandOptions } from "./parse.js";

/**
 * `tavi reminders`: the payload each action
 * sends — the same on the owner and offline — and what the terminal prints.
 * Times are said in the reminder's zone, which is the workspace's unless the
 * reminder was given another; an added reminder prints its read-back line, so
 * a wrong reading is caught at once.
 */

/** Whether an action needs the zone local times are read in: an `add` with a local `--at`/`--event`. */
export function needsZone(options: RemindersCommandOptions): boolean {
  const when = options.when;
  return options.action === "add" && options.zone === undefined && when !== undefined && when.kind !== "repeat" && "local" in when.at;
}

function instantOf(at: ReminderTimeInput, zone: string): string {
  return "instant" in at ? at.instant : instantForLocalTime(at.local, zone).toISOString();
}

/** `--at`/`--event`/`--repeat` as the contract's `when`, local times read in `zone`. */
export function reminderWhen(when: ReminderWhenInput, zone: string): ReminderWhen {
  switch (when.kind) {
    case "once":
      return { kind: "once", at: instantOf(when.at, zone) };
    case "event":
      return { kind: "event", at: instantOf(when.at, zone), notify: [...when.notify] };
    case "repeat":
      return {
        kind: "repeat",
        times: [...when.times],
        ...(when.daysOfWeek === undefined ? {} : { daysOfWeek: [...when.daysOfWeek] }),
        ...(when.monthly === undefined ? {} : { monthly: { ...when.monthly } }),
        ...(when.yearly === undefined ? {} : { yearly: { ...when.yearly } }),
        ...(when.until === undefined ? {} : { until: when.until }),
      };
  }
}

/**
 * The `reminders` payload for an action. `zone` is the zone local times are
 * read in (`--zone`, else the workspace's); `operationKey` makes a retried add
 * return the first one's reminder.
 */
export function remindersPayload(options: RemindersCommandOptions, zone: string | undefined, operationKey: string): RemindersPayload {
  const workspaceId = options.workspaceId;
  const reminderId = options.reminderId ?? "";
  switch (options.action) {
    case "list":
      return {
        action: "list",
        workspaceId,
        ...(options.statuses === undefined ? {} : { statuses: [...options.statuses] }),
        ...(options.taskId === undefined ? {} : { originTaskId: options.taskId }),
      };
    case "show":
      return { action: "get", workspaceId, reminderId };
    case "cancel":
    case "pause":
    case "resume":
      return { action: options.action, workspaceId, reminderId };
    case "snooze":
      return { action: "snooze", workspaceId, reminderId, minutes: options.minutes ?? 10 };
    case "add": {
      const when = options.when;
      if (when === undefined || options.text === undefined) throw new Error("reminders add was parsed without its text or time");
      const readIn = options.zone ?? zone ?? "UTC";
      return {
        action: "create",
        workspaceId,
        text: options.text,
        when: reminderWhen(when, readIn),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        // The zone the times were read in is the reminder's, so a repeat fires at the local times given.
        ...(options.zone === undefined ? {} : { timezone: options.zone }),
        ...(options.taskId === undefined ? {} : { originTaskId: options.taskId }),
        ...(options.deliverTo === undefined ? {} : { deliverTo: { kind: options.deliverTo } }),
        operationKey,
      };
    }
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A status or a fire's outcome in `t`'s words; one this release does not know is shown as it is stored. */
function codeWord(prefix: "cli.reminders.status" | "cli.reminders.outcome", code: string, t: CoreT): string {
  const key = `${prefix}.${code === "delivered-in-app" ? "deliveredInApp" : code}`;
  return isCoreKey(key) ? t(key) : code;
}

/** A reminder's cadence in words: "once Mon 5 Oct 10:00", "event Mon 5 Oct 10:00 (1 day before at 20:00, 1 hour before)", "daily 21:00". */
function reminderCadence(reminder: Pick<Reminder, "when" | "timezone">, t: CoreT): string {
  const { when, timezone } = reminder;
  switch (when.kind) {
    case "once":
      return t("cli.reminders.once", { when: reminderWhenText(new Date(when.at), timezone, t) });
    case "event": {
      const notices = when.notify.map((notice) => {
        const offset = parseReminderOffset(notice);
        return offset === undefined ? notice : describeReminderOffset(offset, t);
      });
      return t("cli.reminders.event", { when: reminderWhenText(new Date(when.at), timezone, t), notices: notices.join(", ") });
    }
    case "repeat": {
      const days =
        when.monthly !== undefined || when.yearly !== undefined
          ? repeatDaysText(when, "sentence", t)
          : when.daysOfWeek === undefined || when.daysOfWeek.length === 7
            ? t("cli.reminders.daily")
            : [...when.daysOfWeek]
                .sort()
                .map((day) => (t === coreEnglish ? (DAY_NAMES[day] ?? String(day)) : t(`date.weekdayShort.${day}` as CoreKey)))
                .join(",");
      const cadence = t("cli.reminders.repeat", { days, times: [...when.times].sort().join(",") });
      return when.until === undefined ? cadence : t("cli.reminders.until", { cadence, date: when.until });
    }
  }
}

/** The widest a line of `tavi reminders list` runs with no terminal to fit: in a pipe. */
const LIST_WIDTH = 80;
const LIST_INDENT = "    ";

/** A reminder's row: id, status, next fire. */
function reminderRow(reminder: ReminderView, timezone: string, t: CoreT): readonly string[] {
  return [
    reminder.reminderId,
    codeWord("cli.reminders.status", reminder.status, t),
    reminder.nextFireAt === null ? "-" : reminderWhenText(new Date(reminder.nextFireAt), timezone, t),
  ];
}

/** What a reminder says under its row: its text, and its cadence unless that only repeats the next fire. */
function reminderDetail(reminder: ReminderView, width: number, t: CoreT): readonly string[] {
  const { when, nextFireAt } = reminder;
  const repeatsNext = when.kind === "once" && nextFireAt !== null && Date.parse(when.at) === Date.parse(nextFireAt);
  return [
    ...indentedLines(reminder.text, LIST_INDENT, width),
    ...(repeatsNext ? [] : indentedLines(reminderCadence(reminder, t), LIST_INDENT, width)),
  ];
}

/** `tavi reminders list`: a header, padded columns, and each reminder's words on wrapped lines below its row, as `tavi permissions` lists rules. */
function reminderTable(reminders: readonly ReminderView[], timezone: string, width: number, t: CoreT): readonly string[] {
  // In the order they run: what has no next run comes last.
  const ordered = [...reminders].sort((a, b) => (a.nextFireAt ?? "\uffff").localeCompare(b.nextFireAt ?? "\uffff"));
  const [header = "", ...rows] = alignedColumns([
    [t("cli.reminders.column.reminder"), t("cli.reminders.column.status"), t("cli.reminders.column.next")],
    ...ordered.map((reminder) => reminderRow(reminder, timezone, t)),
  ]);
  // A row too wide for the terminal folds at its columns: the fold costs the alignment, not the words.
  const fitted = (row: string): readonly string[] => (stringWidth(row) > width ? indentedLines(row, "", width) : [row]);
  return [
    ...fitted(header),
    ...ordered.flatMap((reminder, index) => [...fitted(rows[index] ?? ""), ...reminderDetail(reminder, width, t)]),
  ];
}

function fireLine(fire: ReminderFire, timezone: string, t: CoreT): string {
  const notice = fire.noticeOffset === undefined ? "" : ` (${fire.noticeOffset})`;
  const late = fire.late === true ? t("cli.reminders.late") : "";
  const seen = fire.acknowledgedAt === undefined ? "" : t("cli.reminders.seen");
  return `  ${reminderWhenText(new Date(fire.fireAt), timezone, t)}\t${codeWord("cli.reminders.outcome", fire.outcome, t)}${late}${notice}${seen}`;
}

/** `tavi reminders show`: the reminder, its read-back, its next fires and its recent ones. */
function reminderShowText(answer: ReminderGetAnswer, now: Date, t: CoreT): string {
  const { reminder, fires } = answer;
  const zone = reminder.timezone;
  const added = t(reminder.createdBy === "agent" ? "cli.reminders.addedByAgent" : "cli.reminders.addedByYou");
  const lines = [
    `${reminder.reminderId}\t${codeWord("cli.reminders.status", reminder.status, t)}\t${reminder.text}`,
    t("cli.reminders.when", { when: reminderReadBack(reminder, now, t) }),
    reminder.deliverTo.kind === "app"
      ? t("cli.reminders.delivered.app")
      : reminder.deliverTo.kind === "home"
        ? t("cli.reminders.delivered.home")
        : t("cli.reminders.delivered.chat", {
            conversation: reminder.deliverTo.conversationId,
            connection: reminder.deliverTo.connectionId,
          }),
    ...(reminder.prompt === undefined ? [] : [t("cli.reminders.startsTask", { prompt: reminder.prompt })]),
    reminder.originTaskId === undefined ? added : t("cli.reminders.addedIn", { who: added, task: reminder.originTaskId }),
    reminder.upcoming.length === 0
      ? t("cli.reminders.nextNone")
      : `${t("cli.reminders.next")}\n${reminder.upcoming.map((fire) => `  ${reminderWhenText(new Date(fire.at), zone, t)}${fire.noticeOffset === undefined ? "" : ` (${fire.noticeOffset})`}`).join("\n")}`,
    fires.length === 0
      ? t("cli.reminders.firedNever")
      : `${t("cli.reminders.fired")}\n${fires.map((fire) => fireLine(fire, zone, t)).join("\n")}`,
  ];
  return lines.join("\n");
}

/** What `tavi reminders <action>` prints for the owner's answer, in `t`'s words; JSON prints the answer as it is. */
export function remindersResultText(
  options: RemindersCommandOptions,
  result: unknown,
  now: Date,
  columns: number | undefined = undefined,
  t: CoreT = coreEnglish,
): string {
  switch (options.action) {
    case "list": {
      const answer = result as RemindersListAnswer;
      if (answer.reminders.length === 0) return t("cli.reminders.none", { zone: answer.timezone });
      return `${t("cli.reminders.heading", { zone: answer.timezone })}\n${reminderTable(answer.reminders, answer.timezone, columns ?? LIST_WIDTH, t).join("\n")}${answer.nextCursor === undefined ? "" : `\n${t("cli.reminders.more")}`}`;
    }
    case "show":
      return reminderShowText(result as ReminderGetAnswer, now, t);
    case "add": {
      const answer = result as ReminderCreateAnswer;
      const reminder = answer.reminder;
      const head =
        answer.duplicate === true
          ? t("cli.reminders.alreadySet", { id: reminder.reminderId })
          : answer.created
            ? t("cli.reminders.added", { id: reminder.reminderId })
            : t("cli.reminders.alreadyAdded", { id: reminder.reminderId });
      const skipped =
        answer.skippedNotices.length === 0 ? "" : `\n${t("cli.reminders.pastNotices", { notices: answer.skippedNotices.join(", ") })}`;
      return `${head}: ${reminder.text}\n${reminderReadBack(reminder, now, t)}${skipped}`;
    }
    case "snooze": {
      const answer = result as ReminderSnoozeAnswer;
      return t("cli.reminders.snoozed", {
        id: answer.reminder.reminderId,
        when: reminderWhenText(new Date(answer.followUp.fireAt), answer.reminder.timezone, t),
        text: answer.reminder.text,
      });
    }
    default: {
      const reminder = (result as ReminderWriteAnswer).reminder;
      return `${reminder.reminderId}\t${codeWord("cli.reminders.status", reminder.status, t)}\t${reminder.text}`;
    }
  }
}
