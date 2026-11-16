import { DEFAULT_RESUME_GRACE_MS } from "@tavi/agent-host/agent-wait-scheduler";
import { createWakePlanner, type WakePlanner } from "@tavi/agent-host/schedule-scheduler";
import type { DatabaseClient } from "@tavi/runtime";

import { NOTIFY_RETRY_WINDOW_MS } from "../features/approvals/channel-approvals.js";

/**
 * How the owner's background work wakes. Due work (reminders, schedules, agent
 * waits, approval rounds, heartbeats) is swept when its stored deadline comes
 * or something is written, through one planner; other periodic work runs only
 * when something was written since it last looked, or after its idle interval.
 * An idle owner then makes about one database call a minute, not one every
 * couple of seconds.
 *
 * Every slow periodic timer the owner keeps — the sweeps' fallbacks, the task
 * summarizer's, the memory jobs', the memory provider upkeep's, the heartbeat's
 * need poll, the file watchers' resync and `serve`'s health samples — runs on
 * the planner's timer (`every`, `after`), which wakes only at instants on one
 * `DUE_WAKE_RECHECK_MS` grid unless due work falls between. An idle owner's
 * process then wakes at most twice a minute, whatever is enabled.
 */

/** Each due-work sweep's own timer, kept as a slow fallback behind the planner. */
export const DUE_SWEEP_FALLBACK_MS = 10 * 60_000;
/** The least time between two planned sweeps of one kind: the pace of the timers the planner replaced. */
const DUE_SWEEP_FLOOR_MS = 30_000;
/** How long after a write the deadlines are read again (one read for every write meanwhile). */
const DUE_WAKE_SETTLE_MS = 1_000;
/**
 * The grid the planner's timer wakes on when nothing falls due sooner: while any deadline is planned it compares
 * the wall clock with them there (no database call), and every periodic tick shares the same instants. Timers do
 * not run while a machine sleeps, so this bounds how late due work is after it wakes — the old sweeps' 30 s — and
 * is also the most often an idle owner wakes: twice a minute. A longer grid would wake less but let due work run
 * up to that late after a sleep; a wake-from-sleep check needs a timer to run, so it cannot do better than its
 * own period. With no deadline planned and nothing ticking, the timer does not run at all.
 */
const DUE_WAKE_RECHECK_MS = 30_000;
/** The task summarizer's timer behind its drain at each task's end. */
export const TASK_SUMMARY_FALLBACK_MS = 5 * 60_000;
/** The longest the memory jobs and the memory provider upkeep go without looking when nothing is written. */
export const MEMORY_IDLE_TICK_MS = 5 * 60_000;

/** The sweeps the planner drives, named as `store.nextWakeups` answers (spelled out, so a composition's type can name it). */
export type DueSweepKind = "reminders" | "schedules" | "agentWaits" | "approvals" | "heartbeats";

/** The owner's due-work planner, woken by every write the store reports. */
export function createDuePlanner(input: {
  readonly store: Pick<DatabaseClient, "nextWakeups" | "onWrite">;
  readonly now: () => string;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}): WakePlanner<DueSweepKind> {
  const planner = createWakePlanner<DueSweepKind>({
    deadlines: async () =>
      await input.store.nextWakeups({ now: input.now(), resumeGraceMs: DEFAULT_RESUME_GRACE_MS, notifyWindowMs: NOTIFY_RETRY_WINDOW_MS }),
    floorMs: DUE_SWEEP_FLOOR_MS,
    settleMs: DUE_WAKE_SETTLE_MS,
    recheckMs: DUE_WAKE_RECHECK_MS,
    now: () => Date.parse(input.now()),
    onError: (error) => input.log("due work could not be planned", { error }),
  });
  input.store.onWrite(() => planner.changed());
  return planner;
}
