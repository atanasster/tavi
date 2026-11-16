import { type ScheduleRecord, type ScheduleRetry, scheduleCatchUpLookbackMs, scheduleOccurrences, scheduleSpecText } from "@tavi/contracts";

import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";

/** Which occurrence a fire is for, the ones it passed over, and a schedule that has no more. */

/**
 * How many occurrences the catch-up walk records as missed, at most. The walk
 * itself starts no further back than `scheduleCatchUpLookbackMs` (a stored
 * pointer older than that is walked from there instead), so it stays bounded
 * however long the owner was away.
 */
const CATCH_UP_MAX_RECORDED = 16;

/**
 * Finishes a schedule that ends (`scheduleSpecEnds`) once its last occurrence
 * has settled: disabled, and the ledger says why, in the host's words. Not
 * while a retry of that occurrence is armed, whose own claim finishes it. Not
 * alerted: nothing went wrong.
 */
export async function recordFinished(schedule: ScheduleRecord, slot: string, deps: ScheduleSchedulerDependencies): Promise<void> {
  const now = deps.now();
  if (!(await deps.schedules.finish({ scheduleId: schedule.scheduleId, now }))) return;
  await deps.schedules.recordFire({
    scheduleId: schedule.scheduleId,
    taskId: null,
    outcome: `finished: ${scheduleSpecText(schedule.spec)} has no more runs`,
    outcomeKind: "skipped",
    fire: { fireTime: slot, reasonCode: "disabled" },
    now,
  });
  deps.log({
    level: "info",
    message: "schedule finished: its last occurrence has settled",
    detail: { scheduleId: schedule.scheduleId, fireTime: slot },
  });
}

/**
 * Records in the fire ledger each occurrence from the stored pointer up to the
 * one this fire runs or skips: nothing ran at them while the owner was not
 * running, and the log alone would leave "why did it not run on Tuesday?"
 * unanswered. Bounded as `latestDueOccurrence` is.
 */
export async function recordUnrunOccurrences(
  schedule: ScheduleRecord,
  fireTime: string,
  slot: string,
  /** A retry armed at the pointer: the pointer is no occurrence, and the retry was not run either. */
  armed: ScheduleRetry | undefined,
  deps: ScheduleSchedulerDependencies,
  now: string,
): Promise<void> {
  const slotMs = Date.parse(slot);
  if (Date.parse(fireTime) >= slotMs) return;
  if (armed !== undefined) {
    await deps.schedules.recordFire({
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome: "skipped: its retry did not run before a later fire came due",
      outcomeKind: "skipped",
      fire: { fireTime: armed.ofFireTime, reasonCode: "missed", retryCount: armed.count },
      now,
    });
  }
  const unrun = armed === undefined ? [fireTime] : [];
  const from = new Date(Math.max(Date.parse(fireTime), slotMs - scheduleCatchUpLookbackMs(schedule.spec)));
  let walked = 0;
  for (const { at } of scheduleOccurrences(schedule.spec, from, new Date(slotMs))) {
    if (walked >= CATCH_UP_MAX_RECORDED) break;
    walked += 1;
    if (!unrun.includes(at.toISOString())) unrun.push(at.toISOString());
  }
  for (const occurrence of unrun) {
    await deps.schedules.recordFire({
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome: "skipped: missed while the owner was not running",
      outcomeKind: "skipped",
      fire: { fireTime: occurrence, reasonCode: "missed" },
      now,
    });
  }
}

/**
 * The latest occurrence of the schedule at or before `nowMs`, walking forward
 * from the stored pointer `fireTime` (or from a week back, when the pointer is
 * older than that); the pointer itself when nothing later is due yet.
 */
export function latestDueOccurrence(schedule: ScheduleRecord, fireTime: string, nowMs: number): string {
  const storedMs = Date.parse(fireTime);
  let latest: Date | undefined;
  const from = new Date(Math.max(storedMs, nowMs - scheduleCatchUpLookbackMs(schedule.spec)));
  for (const { at } of scheduleOccurrences(schedule.spec, from, new Date(nowMs + 1))) latest = at;
  return latest === undefined || latest.getTime() <= storedMs ? fireTime : latest.toISOString();
}
