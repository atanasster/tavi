import {
  daysOfWeekText,
  repeatDaysText,
  SCHEDULE_RETRY_BACKOFF_MINUTES,
  scheduleFinished,
  schedulePausedText,
  type SchedulePausedReason,
  type AgendaCadence,
  type RoutineListTrigger,
  routineTriggerSpec,
  scheduleSpecText,
  scheduleWatchSentence,
  type ScheduleRecord,
  type ScheduleSpec,
  type ScheduleFireReason,
  type ScheduleFireRecord,
  SCHEDULED_BUDGET_NOTICE_PERCENT,
  scheduledWorkText,
  type ScheduledWorkUsage,
} from "@tavi/contracts";

import { dayTime, durationText, monthYear } from "../../lib/time.js";

/**
 * Schedule's pure reads: what a cadence says in
 * words, how far away a time is, and which workspace-zone day an agenda
 * occurrence falls on. Kept free of React so each is asserted on its own.
 */

/**
 * Weekdays (0 = Sunday) in words: "Mon–Fri", "Mon, Wed", "Sat, Sun"; every
 * day is `undefined` (the cadence is then daily). Three or more days in a row
 * read as a range.
 */
export function weekdaysText(days: readonly number[] | undefined): string | undefined {
  return daysOfWeekText(days);
}

/** A cadence in words: "Daily 21:00 · Europe/Berlin", "Mon–Fri 07:00 · Europe/Berlin", "Once". */
export function cadenceText(cadence: AgendaCadence): string {
  if (cadence.kind === "once") return "Once";
  if (cadence.kind === "repeat") return `${repeatDaysText(cadence, "label")}, ${cadence.at} · ${cadence.timezone}`;
  return `${weekdaysText(cadence.daysOfWeek) ?? "Daily"} ${cadence.at} · ${cadence.timezone}`;
}

/**
 * A schedule's or a recurring trigger's whole cadence: "Daily 21:00 · Europe/Berlin",
 * "Mon–Fri 07:00, 19:00 · Europe/Berlin", "Monthly on the 1st, 09:00 · Europe/Berlin",
 * "Daily every 2 h 08:00–18:00 · Europe/Berlin", "Once on 2026-11-05, 09:00 · Europe/Berlin".
 */
export function specText(spec: ScheduleSpec): string {
  return scheduleSpecText(spec, "label");
}

/**
 * What a watcher watches, as a sentence: "Watches the page https://… every hour; runs only when it changes".
 * None for a schedule that is not a watcher.
 */
export function watchText(schedule: Pick<ScheduleRecord, "watch" | "precheck" | "spec">): string | undefined {
  const sentence = schedule.watch === true ? scheduleWatchSentence(schedule) : undefined;
  return sentence === undefined ? undefined : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/**
 * A routine's cadence from its triggers: each recurring one in words, then
 * "Once" for any one-off still to fire; a routine whose one-off triggers have
 * all fired says so.
 */
export function routineCadence(triggers: readonly RoutineListTrigger[]): string {
  const daily = triggers.flatMap((trigger) => {
    const spec = routineTriggerSpec(trigger);
    return spec === undefined ? [] : [specText(spec)];
  });
  const once = triggers.filter((trigger) => trigger.kind === "once");
  const pending = once.filter((trigger) => trigger.consumed !== true).length;
  const parts = [...daily, ...(pending > 0 ? [pending === 1 ? "Once" : `Once ×${pending}`] : [])];
  if (parts.length > 0) return parts.join("; ");
  return once.length > 0 ? "Once · fired" : "No trigger";
}

/**
 * A plain schedule at a glance: running fine, its last fire failed or was skipped, resumed after failing (its count
 * starts again), or paused (by a person, or by its failures).
 */
export type ScheduleState = "ok" | "failed" | "skipped" | "resumed" | "paused" | "paused-failures" | "finished";

/** What the scheduler prefixes a run asked for by hand with. */
const MANUAL = "manual run: ";
/** …and a run a call to the schedule's webhook started, with what the call carried by size (`payload 312 bytes, sha256 …`). */
const WEBHOOK = /^webhook run(?: \(([^)]*)\))?: /;
/** …and a check a file watcher made because its file changed. */
const WATCH = "file-watch run: ";
/** …and a run an email started, with its sender and size (`from ann@example.com, 312 bytes, sha256 …`). */
const EMAIL = /^email run(?: \(([^)]*)\))?: /;
/** What the ledger's row of a schedule's refused webhook calls starts with, and its refused emails'. */
const WEBHOOK_REFUSED = "webhook refused ";
const EMAIL_REFUSED = "email trigger refused ";
/** The scheduler's own mark while a fire is being handed to its run: never a result. */
const DISPATCH = /^dispatching the (\S+) fire$/;
/** What the ledger row of a schedule that ended starts with. */
const FINISHED = "finished:";
/** The longest run of a run's own words a sentence repeats; the task has the rest. */
const DETAIL_CHARS = 200;

/** The reasons that end a fire as a failure, and those that end one without running it. */
const FAILED: ReadonlySet<ScheduleFireReason> = new Set(["failed", "undelivered", "timeout", "budget", "orphaned"]);
const SKIPPED: ReadonlySet<ScheduleFireReason> = new Set([
  "missed",
  "overlap",
  "disk",
  "disabled",
  "paused",
  "webhook-refused",
  "email-refused",
  "stopped",
]);

/**
 * The reason a stored outcome stands for, read from the scheduler's words
 * ("completed", "skipped: missed by 12m (policy: skip)", "admission failed: …").
 * A fire still being handed over, and words this build does not know, are none.
 */
export function outcomeReason(outcome: string | null | undefined): ScheduleFireReason | undefined {
  if (outcome === null || outcome === undefined) return undefined;
  if (outcome.startsWith(WEBHOOK_REFUSED)) return "webhook-refused";
  if (outcome.startsWith(EMAIL_REFUSED)) return "email-refused";
  const text = outcome.startsWith(MANUAL)
    ? outcome.slice(MANUAL.length)
    : outcome.startsWith(WATCH)
      ? outcome.slice(WATCH.length)
      : outcome.replace(WEBHOOK, "").replace(EMAIL, "");
  if (text.startsWith("completed but nothing was delivered")) return "undelivered";
  if (text.startsWith("completed quietly")) return "quiet";
  if (text.startsWith("unchanged:")) return "unchanged";
  if (text === "completed") return "ok";
  if (text.startsWith("timed out")) return "timeout";
  if (text.startsWith("over budget")) return "budget";
  if (text.startsWith("waiting on a worker")) return "waiting";
  if (text.startsWith("asked a question")) return "asked";
  if (/^(?:waiting:|failed|admission failed|fire threw|pre-check failed)/.test(text)) return "failed";
  if (text.startsWith("skipped: the previous run")) return "overlap";
  if (text.startsWith("skipped: missed") || text.startsWith("skipped: its retry")) return "missed";
  if (text.startsWith("refused:")) return "disk";
  if (text.startsWith("disabled:")) return "disabled";
  if (text.startsWith("orphaned:")) return "orphaned";
  if (text.startsWith("retrying at ")) return "retry";
  if (text.startsWith("paused:")) return "paused";
  if (text.startsWith("stopped:")) return "stopped";
  return undefined;
}

/** What a finished schedule's switch says of itself: it cannot be resumed as it is. */
export const FINISHED_HINT =
  "Finished: its last run is past. Edit it to move its once or until date later, or drop the until, to run it again.";

/**
 * A plain schedule's state: finished when it is off because its `once` or
 * `until` date is past (it cannot be resumed as it is), paused when it is off
 * otherwise (`paused-failures` when its failures paused it), failed while its fires
 * keep failing or the last one failed, skipped when the last one did not run,
 * and ok otherwise. One that has not fired yet, or whose fire is being handed
 * to its run, has none to show. A failure that counts toward its pause (a fire's,
 * a file watcher's) with no failure counted was forgiven by a Resume: resumed, not failed.
 */
export function scheduleState(
  row: {
    readonly enabled: boolean;
    readonly pausedReason?: SchedulePausedReason;
    readonly spec?: ScheduleSpec;
    readonly consecutiveFailures: number;
    readonly lastOutcome: string | null;
  },
  now: Date = new Date(),
): ScheduleState | undefined {
  if (!row.enabled && row.spec !== undefined && scheduleFinished(row.spec, now)) return "finished";
  if (!row.enabled) return row.pausedReason === "failures" ? "paused-failures" : "paused";
  if (row.consecutiveFailures > 0) return "failed";
  const reason = outcomeReason(row.lastOutcome);
  if (reason === undefined) return undefined;
  if (FAILED.has(reason)) return countsTowardPause(row.lastOutcome) ? "resumed" : "failed";
  return SKIPPED.has(reason) ? "skipped" : "ok";
}

/** Whether a stored outcome's failure is counted toward its schedule's pause: a fire's or a file watcher's, never a run asked for now. */
function countsTowardPause(outcome: string | null): boolean {
  if (outcome === null) return false;
  return !(outcome.startsWith(MANUAL) || WEBHOOK.test(outcome) || EMAIL.test(outcome));
}

/**
 * One fire's state in the ledger: a run asked for by hand is judged by how it
 * ended, and one tried again later is waiting on its retry.
 */
export function fireState(fire: Pick<ScheduleFireRecord, "reasonCode" | "outcome">): "ok" | "failed" | "skipped" | "waiting" {
  if (fire.reasonCode === "disabled" && fire.outcome.startsWith(FINISHED)) return "ok";
  const reason =
    fire.reasonCode === "manual" || fire.reasonCode === "webhook" || fire.reasonCode === "watch" || fire.reasonCode === "email"
      ? outcomeReason(fire.outcome)
      : fire.reasonCode;
  if (reason === undefined) return "ok";
  if (FAILED.has(reason)) return "failed";
  if (SKIPPED.has(reason)) return "skipped";
  return reason === "waiting" || reason === "asked" || reason === "retry" ? "waiting" : "ok";
}

/** Whether a schedule is paused, and why, as the line under its name says it: "Paused after 3 failed runs in a row; …", or "Finished: …" for one whose last run is past. */
export function pausedText(row: {
  readonly enabled: boolean;
  readonly pausedReason?: SchedulePausedReason;
  readonly spec?: ScheduleSpec;
}): string {
  const text = schedulePausedText(row) ?? "paused";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A run's own words, kept short and ended as a sentence. */
function detail(text: string): string {
  const trimmed = text.trim();
  const clipped = trimmed.length > DETAIL_CHARS ? `${trimmed.slice(0, DETAIL_CHARS - 1)}…` : trimmed;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** "Missed by 2 h 5 min" from the scheduler's "missed by 125m". */
function missedBy(minutes: string): string {
  return durationText(Number(minutes) * 60_000);
}

/**
 * A stored outcome as a sentence people read, in the workspace zone: what
 * happened, and what happens next where that is not obvious. The scheduler's
 * mark for a fire being handed to its run is said as the run starting; words
 * this build does not know are shown as they came, as a sentence.
 */
export function outcomeSentence(outcome: string | null | undefined, timeZone: string | undefined): string {
  if (outcome === null || outcome === undefined) return "Not run yet.";
  if (outcome.startsWith(MANUAL)) {
    const said = outcomeSentence(outcome.slice(MANUAL.length), timeZone);
    return `Run now: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  }
  if (outcome.startsWith(WATCH)) {
    const said = outcomeSentence(outcome.slice(WATCH.length), timeZone);
    return `Its file changed: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  }
  const webhook = WEBHOOK.exec(outcome);
  if (webhook !== null) {
    const said = outcomeSentence(outcome.slice(webhook[0].length), timeZone);
    const carried = webhook[1] === undefined ? "" : ` (${webhook[1].replace(/, sha256 [0-9a-f]+$/, "")})`;
    return `Webhook call${carried}: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  }
  const email = EMAIL.exec(outcome);
  if (email !== null) {
    const said = outcomeSentence(outcome.slice(email[0].length), timeZone);
    const carried = email[1] === undefined ? "" : ` (${email[1].replace(/, sha256 [0-9a-f]+$/, "")})`;
    return `Email${carried}: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  }
  const marked = DISPATCH.exec(outcome);
  if (marked !== null) return "Starting its run; no result yet.";
  if (outcome.startsWith(FINISHED)) return "Finished: its last run is past, so it runs no more.";
  const after = (prefix: string): string => outcome.slice(prefix.length).trim();
  const asCame = (): string => detail(outcome.charAt(0).toUpperCase() + outcome.slice(1));
  switch (outcomeReason(outcome)) {
    case "undelivered":
      return "Completed, but sent nothing it was to send.";
    case "ok":
      return "Completed.";
    case "stopped":
      return "You stopped this run.";
    case "quiet":
      return outcome.includes("unchanged")
        ? "Completed with the same result as last time, so it was not sent again."
        : "Completed with nothing to report, so nothing was sent.";
    case "unchanged":
      return "Nothing new at its pre-check, so nothing ran and no model was called.";
    case "timeout": {
      const timedOut = /^timed out: stopped after (\d+) minutes/.exec(outcome);
      return timedOut === null ? asCame() : `Stopped after ${timedOut[1]} minutes of work, its run limit.`;
    }
    case "budget": {
      const over = /^over budget: stopped after ([\d,]+) tokens?, past its ceiling of ([\d,]+) tokens?/.exec(outcome);
      return over === null ? asCame() : `Stopped after ${over[1]} tokens, past its ceiling of ${over[2]} tokens.`;
    }
    case "waiting":
      return "Waiting on a worker it started; goes on once that finishes.";
    case "asked":
      return "Asked a question; goes on with its default if nobody answers in time.";
    case "failed": {
      const stuck = /^waiting: suspended on (.+?), which nothing/.exec(outcome);
      if (stuck !== null) return `Stopped waiting on ${stuck[1]}, which nobody answers in an unattended run.`;
      if (outcome.startsWith("failed after its wait:")) return `Failed after its wait: ${detail(after("failed after its wait:"))}`;
      if (outcome.startsWith("admission failed:")) return `Could not start: ${detail(after("admission failed:"))}`;
      if (outcome.startsWith("fire threw:")) return `Could not start: ${detail(after("fire threw:"))}`;
      if (outcome.startsWith("pre-check failed:"))
        return `Did not run: its pre-check could not be made: ${detail(after("pre-check failed:"))}`;
      if (outcome.startsWith("failed:")) return `Failed: ${detail(after("failed:"))}`;
      return asCame();
    }
    case "overlap":
      return "Skipped: the previous run was still going.";
    case "retry": {
      const retrying = /^retrying at (\S+) \(retry (\d+) of/.exec(outcome);
      if (retrying === null) return asCame();
      const at = retrying[1] as string;
      return `Failed on a provider error; trying again at ${Number.isNaN(Date.parse(at)) ? at : dayTime(at, timeZone)} (retry ${retrying[2]} of ${SCHEDULE_RETRY_BACKOFF_MINUTES.length}).`;
    }
    case "paused":
      return `${pausedText({ enabled: false, pausedReason: "failures" })}.`;
    case "missed": {
      if (outcome.startsWith("skipped: missed while the owner was not running")) return "Missed: Tavi was not running at the time.";
      if (outcome.startsWith("skipped: its retry did not run")) return "Its retry did not run before the next run came due.";
      const missed = /^skipped: missed by (\d+)m \((policy: skip|beyond)/.exec(outcome);
      if (missed === null) return asCame();
      return missed[2] === "policy: skip"
        ? `Missed by ${missedBy(missed[1] as string)}; this schedule skips missed runs.`
        : `Missed by ${missedBy(missed[1] as string)}, too late to catch up (6 hours at most).`;
    }
    case "disk": {
      const disk = /^refused: only (\d+) MiB free/.exec(outcome);
      return disk === null ? asCame() : `Did not start: only ${disk[1]} MiB free on the data disk. It runs once space is freed.`;
    }
    case "disabled":
      return `Turned off: its time has no next run (${after("disabled:")}).`;
    case "orphaned": {
      const orphaned = /^orphaned: the (\S+) fire/.exec(outcome);
      if (orphaned === null) return asCame();
      const at = orphaned[1] as string;
      return `The run for ${Number.isNaN(Date.parse(at)) ? at : dayTime(at, timeZone)} never reported a result.`;
    }
    default:
      return asCame();
  }
}

/**
 * What the workspace's schedules and routines spent this month, as the line
 * under Recurring says it: "October 2026: 12,345 tokens (about $0.42) of a
 * 1,000,000-token monthly budget (1%)", and whether it reached the notice's share.
 */
export function scheduledWorkLine(usage: ScheduledWorkUsage): { readonly text: string; readonly over: boolean } {
  const [year, month] = usage.month.split("-").map(Number);
  const label =
    year === undefined || month === undefined || Number.isNaN(year) || Number.isNaN(month) ? usage.month : monthYear(year, month);
  return {
    text: `Scheduled work in ${label}: ${scheduledWorkText(usage)}.`,
    over: usage.percent !== undefined && usage.percent >= SCHEDULED_BUDGET_NOTICE_PERCENT,
  };
}

/** Why `schedules run` started no task, in words. */
export function notStartedText(outcome: { readonly kind?: string; readonly reason?: string } | undefined): string {
  const reason = outcome?.reason;
  switch (reason) {
    case "overlap":
      return "the previous run is still going";
    case "already-claimed":
      return "this fire was already being run";
    case "missed":
      return "it was too late to run";
    case undefined:
      return outcome?.kind ?? "the owner started no task";
    default:
      return reason;
  }
}
