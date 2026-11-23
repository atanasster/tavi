import { textRef, type ScheduleRecord } from "@tavi/contracts";

import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import { recordFinished } from "./schedule-cadence.js";
import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";

/**
 * The fire time a dispatch marker names, or `undefined` when there is no marker.
 *
 * `markRunning` writes this marker before a run and the outcome replaces it, so a
 * marker that is still there means a run started and never reported. Exported
 * because the startup scan and the in-fire check must read the same shape.
 */
export function dispatchMarkerFireTime(lastOutcome: string | null | undefined): string | undefined {
  return /^dispatching the (\S+) fire$/.exec(lastOutcome ?? "")?.[1];
}

export interface OrphanedFire {
  readonly scheduleId: string;
  readonly fireTime: string;
}

/**
 * Report fires whose dispatch marker is still there *and* whose pointer has
 * already moved on.
 *
 * The check inside `fireSchedule` only runs for a row `listDue` returned, and a
 * crashed fire has already advanced `next_run_at` to its next occurrence — so the
 * marker was read a day later, at the next fire, and the operator learned on the
 * 18th that the 17th brief never happened. This scan runs at scheduler start,
 * reads every schedule rather than only the due ones, records the orphaned fire
 * as a failed run and alerts on it, which is the earliest any process can know.
 *
 * One unreadable row must not stop the others, and a failed scan must not stop
 * the scheduler from ticking: the caller logs and carries on.
 */
export async function reconcileOrphanedFires(deps: ScheduleSchedulerDependencies): Promise<readonly OrphanedFire[]> {
  const orphans: OrphanedFire[] = [];
  let schedules: readonly ScheduleRecord[];
  try {
    schedules = await deps.schedules.list();
  } catch (error) {
    deps.log({ level: "error", message: "could not read schedules while reconciling orphaned fires", detail: { error } });
    return orphans;
  }
  for (const schedule of schedules) {
    const fireTime = dispatchMarkerFireTime(schedule.lastOutcome);
    if (fireTime === undefined) continue;
    // A marker whose fire is still this schedule's `next_run_at` is not orphaned:
    // the normal due path will claim it and report it then. (A *disabled*
    // schedule keeps its marker and has no `next_run_at`, so it is reported —
    // that is the state where a crashed fire would otherwise never be mentioned.)
    if (schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) <= Date.parse(fireTime)) continue;
    // …and a marker with a **live lease** is a run that is still going, not an
    // orphan: `claimFire` advances the pointer *before* `markRunning` writes the
    // marker, so a healthy in-flight run looks exactly like a crashed one. The
    // scan runs at scheduler start, where the single-owner rule means nothing can
    // be in flight — but that is an invariant of the caller, and the lease is the
    // same evidence the overlap guard uses, so it is checked rather than assumed.
    const nowIso = deps.now();
    if (schedule.lastRunTaskId !== null) {
      const lease = await deps.executions.current(schedule.lastRunTaskId);
      if (lease !== undefined && lease.endedAt === null && lease.leaseExpiresAt > nowIso) continue;
    }
    deps.log({
      level: "error",
      message: "a schedule fire never reported a result and its pointer has already advanced",
      detail: { scheduleId: schedule.scheduleId, fireTime },
    });
    let recorded: boolean;
    try {
      // Compare-and-set on the marker: this scan runs concurrently with the
      // sweeps, and a run that reported while it was reading has to win —
      // otherwise the scan would overwrite a successful outcome (and the marker
      // of a fire that is still in flight) with "orphaned".
      recorded = await deps.schedules.recordRunIfMarked({
        scheduleId: schedule.scheduleId,
        expectedMarker: `dispatching the ${fireTime} fire`,
        outcome: `orphaned: the ${fireTime} fire never reported a result`,
        outcomeKind: "failed",
        fire: { fireTime, reasonCode: "orphaned" },
        now: nowIso,
      });
    } catch (error) {
      // The alert below is then the only signal; recording first would have been
      // nicer, but the store is exactly what can be broken.
      deps.log({ level: "error", message: "could not record an orphaned fire", detail: { scheduleId: schedule.scheduleId, error } });
      continue;
    }
    if (!recorded) {
      // The fire reported between the scan's read and this write; it was not
      // orphaned after all, and alerting would be a false failure report.
      deps.log({
        level: "info",
        message: "an apparently orphaned fire reported while reconciling; leaving it alone",
        detail: { scheduleId: schedule.scheduleId, fireTime },
      });
      continue;
    }
    orphans.push({ scheduleId: schedule.scheduleId, fireTime });
    await sendAlert(
      schedule,
      {
        identity: fireTime,
        kind: "stale-dispatch",
        text: textRef("channel.schedule.alert.staleDispatchNext", { name: schedule.name, fireTime }),
      },
      deps,
    );
    try {
      await pauseIfFailing(schedule, { fireTime, alertIdentity: fireTime }, deps);
    } catch (error) {
      deps.log({ level: "error", message: "could not pause a failing schedule", detail: { scheduleId: schedule.scheduleId, error } });
    }
  }
  // A last fire whose owner stopped before it settled: nothing fires it again,
  // and nothing is in flight before the first sweep, so it is finished here.
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.nextRunAt !== null) continue;
    try {
      await recordFinished(schedule, schedule.lastRunAt ?? schedule.updatedAt, deps);
    } catch (error) {
      deps.log({ level: "error", message: "could not finish a schedule", detail: { scheduleId: schedule.scheduleId, error } });
    }
  }
  return orphans;
}
