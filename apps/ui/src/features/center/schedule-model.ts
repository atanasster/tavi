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

import { translateCore, translateNow } from "../../lib/i18n.js";
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
  return daysOfWeekText(days, translateCore);
}

/** A cadence in words: "Daily 21:00 · Europe/Berlin", "Mon–Fri 07:00 · Europe/Berlin", "Once". */
export function cadenceText(cadence: AgendaCadence): string {
  if (cadence.kind === "once") return translateNow("center.scheduleModel.once");
  if (cadence.kind === "repeat")
    return translateNow("center.scheduleModel.repeatCadence", {
      days: repeatDaysText(cadence, "label", translateCore),
      at: cadence.at,
      zone: cadence.timezone,
    });
  const days = weekdaysText(cadence.daysOfWeek);
  return days === undefined
    ? translateNow("center.scheduleModel.dailyCadence", { at: cadence.at, zone: cadence.timezone })
    : translateNow("center.scheduleModel.daysCadence", { days, at: cadence.at, zone: cadence.timezone });
}

/**
 * A schedule's or a recurring trigger's whole cadence: "Daily 21:00 · Europe/Berlin",
 * "Mon–Fri 07:00, 19:00 · Europe/Berlin", "Monthly on the 1st, 09:00 · Europe/Berlin",
 * "Daily every 2 h 08:00–18:00 · Europe/Berlin", "Once on 2026-11-05, 09:00 · Europe/Berlin".
 */
export function specText(spec: ScheduleSpec): string {
  return scheduleSpecText(spec, "label", translateCore);
}

/**
 * What a watcher watches, as a sentence: "Watches the page https://… every hour; runs only when it changes".
 * None for a schedule that is not a watcher.
 */
export function watchText(schedule: Pick<ScheduleRecord, "watch" | "precheck" | "spec">): string | undefined {
  const sentence = schedule.watch === true ? scheduleWatchSentence(schedule, translateCore) : undefined;
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
  const parts = [
    ...daily,
    ...(pending > 0
      ? [pending === 1 ? translateNow("center.scheduleModel.once") : translateNow("center.scheduleModel.onceTimes", { times: pending })]
      : []),
  ];
  if (parts.length > 0) return parts.join("; ");
  return once.length > 0 ? translateNow("center.scheduleModel.onceFired") : translateNow("center.scheduleModel.noTrigger");
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
export const finishedHint = (): string => translateNow("center.scheduleModel.finishedHint");

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
  const text = schedulePausedText(row, new Date(), translateCore) ?? translateNow("center.scheduleModel.paused");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A run's own words, kept short and ended as a sentence. */
function detail(text: string): string {
  const trimmed = text.trim();
  const clipped = trimmed.length > DETAIL_CHARS ? `${trimmed.slice(0, DETAIL_CHARS - 1)}…` : trimmed;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** A sentence lowercased at its start, to follow the words that say how its run began. */
function lowerFirst(said: string): string {
  return `${said.charAt(0).toLowerCase()}${said.slice(1)}`;
}

/** What a call carried, without its digest: "payload 312 bytes". */
function withoutDigest(carried: string): string {
  return carried.replace(/, sha256 [0-9a-f]+$/, "");
}

/** A count of tokens as the scheduler wrote it ("12,345"), as a number to write in the page's language. */
function tokens(written: string): number {
  return Number(written.replaceAll(",", ""));
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
  if (outcome === null || outcome === undefined) return translateNow("center.scheduleModel.notRunYet");
  if (outcome.startsWith(MANUAL)) {
    const said = outcomeSentence(outcome.slice(MANUAL.length), timeZone);
    return translateNow("center.scheduleModel.runNow", { said: lowerFirst(said) });
  }
  if (outcome.startsWith(WATCH)) {
    const said = outcomeSentence(outcome.slice(WATCH.length), timeZone);
    return translateNow("center.scheduleModel.fileChanged", { said: lowerFirst(said) });
  }
  const webhook = WEBHOOK.exec(outcome);
  if (webhook !== null) {
    const said = outcomeSentence(outcome.slice(webhook[0].length), timeZone);
    return webhook[1] === undefined
      ? translateNow("center.scheduleModel.webhookCall", { said: lowerFirst(said) })
      : translateNow("center.scheduleModel.webhookCallCarrying", { carried: withoutDigest(webhook[1]), said: lowerFirst(said) });
  }
  const email = EMAIL.exec(outcome);
  if (email !== null) {
    const said = outcomeSentence(outcome.slice(email[0].length), timeZone);
    return email[1] === undefined
      ? translateNow("center.scheduleModel.email", { said: lowerFirst(said) })
      : translateNow("center.scheduleModel.emailCarrying", { carried: withoutDigest(email[1]), said: lowerFirst(said) });
  }
  const marked = DISPATCH.exec(outcome);
  if (marked !== null) return translateNow("center.scheduleModel.starting");
  if (outcome.startsWith(FINISHED)) return translateNow("center.scheduleModel.finished");
  const after = (prefix: string): string => outcome.slice(prefix.length).trim();
  const asCame = (): string => detail(outcome.charAt(0).toUpperCase() + outcome.slice(1));
  switch (outcomeReason(outcome)) {
    case "undelivered":
      return translateNow("center.scheduleModel.undelivered");
    case "ok":
      return translateNow("center.scheduleModel.completed");
    case "stopped":
      return translateNow("center.scheduleModel.stopped");
    case "quiet":
      return outcome.includes("unchanged")
        ? translateNow("center.scheduleModel.quietUnchanged")
        : translateNow("center.scheduleModel.quiet");
    case "unchanged":
      return translateNow("center.scheduleModel.unchanged");
    case "timeout": {
      const timedOut = /^timed out: stopped after (\d+) minutes/.exec(outcome);
      return timedOut === null ? asCame() : translateNow("center.scheduleModel.timeout", { count: Number(timedOut[1]) });
    }
    case "budget": {
      const over = /^over budget: stopped after ([\d,]+) tokens?, past its ceiling of ([\d,]+) tokens?/.exec(outcome);
      return over === null
        ? asCame()
        : translateNow("center.scheduleModel.budget", { spent: tokens(over[1] as string), ceiling: tokens(over[2] as string) });
    }
    case "waiting":
      return translateNow("center.scheduleModel.waiting");
    case "asked":
      return translateNow("center.scheduleModel.asked");
    case "failed": {
      const stuck = /^waiting: suspended on (.+?), which nothing/.exec(outcome);
      if (stuck !== null) return translateNow("center.scheduleModel.stuck", { what: stuck[1] as string });
      if (outcome.startsWith("failed after its wait:"))
        return translateNow("center.scheduleModel.failedAfterWait", { detail: detail(after("failed after its wait:")) });
      if (outcome.startsWith("admission failed:"))
        return translateNow("center.scheduleModel.couldNotStart", { detail: detail(after("admission failed:")) });
      if (outcome.startsWith("fire threw:"))
        return translateNow("center.scheduleModel.couldNotStart", { detail: detail(after("fire threw:")) });
      if (outcome.startsWith("pre-check failed:"))
        return translateNow("center.scheduleModel.precheckFailed", { detail: detail(after("pre-check failed:")) });
      if (outcome.startsWith("failed:")) return translateNow("center.scheduleModel.failed", { detail: detail(after("failed:")) });
      return asCame();
    }
    case "overlap":
      return translateNow("center.scheduleModel.overlap");
    case "retry": {
      const retrying = /^retrying at (\S+) \(retry (\d+) of/.exec(outcome);
      if (retrying === null) return asCame();
      const at = retrying[1] as string;
      return translateNow("center.scheduleModel.retry", {
        at: Number.isNaN(Date.parse(at)) ? at : dayTime(at, timeZone),
        retry: Number(retrying[2]),
        of: SCHEDULE_RETRY_BACKOFF_MINUTES.length,
      });
    }
    case "paused":
      return `${pausedText({ enabled: false, pausedReason: "failures" })}.`;
    case "missed": {
      if (outcome.startsWith("skipped: missed while the owner was not running")) return translateNow("center.scheduleModel.missedOffline");
      if (outcome.startsWith("skipped: its retry did not run")) return translateNow("center.scheduleModel.retryMissed");
      const missed = /^skipped: missed by (\d+)m \((policy: skip|beyond)/.exec(outcome);
      if (missed === null) return asCame();
      return missed[2] === "policy: skip"
        ? translateNow("center.scheduleModel.missedSkip", { by: missedBy(missed[1] as string) })
        : translateNow("center.scheduleModel.missedLate", { by: missedBy(missed[1] as string) });
    }
    case "disk": {
      const disk = /^refused: only (\d+) MiB free/.exec(outcome);
      return disk === null ? asCame() : translateNow("center.scheduleModel.disk", { free: disk[1] as string });
    }
    case "disabled":
      return translateNow("center.scheduleModel.disabled", { why: after("disabled:") });
    case "orphaned": {
      const orphaned = /^orphaned: the (\S+) fire/.exec(outcome);
      if (orphaned === null) return asCame();
      const at = orphaned[1] as string;
      return translateNow("center.scheduleModel.orphaned", { at: Number.isNaN(Date.parse(at)) ? at : dayTime(at, timeZone) });
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
    text: translateNow("center.scheduleModel.scheduledWork", { month: label, usage: scheduledWorkText(usage, translateCore) }),
    over: usage.percent !== undefined && usage.percent >= SCHEDULED_BUDGET_NOTICE_PERCENT,
  };
}

/** Why `schedules run` started no task, in words. */
export function notStartedText(outcome: { readonly kind?: string; readonly reason?: string } | undefined): string {
  const reason = outcome?.reason;
  switch (reason) {
    case "overlap":
      return translateNow("center.scheduleModel.notStarted.overlap");
    case "already-claimed":
      return translateNow("center.scheduleModel.notStarted.claimed");
    case "missed":
      return translateNow("center.scheduleModel.notStarted.missed");
    case undefined:
      return outcome?.kind ?? translateNow("center.scheduleModel.notStarted.none");
    default:
      return reason;
  }
}
