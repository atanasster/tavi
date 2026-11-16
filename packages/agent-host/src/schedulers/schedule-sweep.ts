import type { ScheduleRecord } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import type { FireOutcome, ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import { type FireEnd, fireTracked } from "./schedule-fire.js";
import { releaseEndedHolds } from "./schedule-holds.js";
import { reconcileOrphanedFires } from "./schedule-reconcile.js";
import { definedRetry } from "./schedule-run-kind.js";
import { type RepeatTimer, startSweepLoop } from "./sweep-loop.js";

/** How many fires one sweep runs at once, so one long run does not hold up the others due with it. */
export const SWEEP_FIRE_CONCURRENCY = 3;

// --------------------------------------------------------------------- sweeps

export interface SweepSchedulesResult {
  readonly fired: readonly { readonly scheduleId: string; readonly outcome: FireOutcome }[];
  readonly unreadable: readonly string[];
}

/**
 * One sweep pass: fire every schedule whose time has arrived, a few at a time
 * (`SWEEP_FIRE_CONCURRENCY`), so one long run does not delay the others due
 * with it. Each fire's lateness is judged at the moment they were listed.
 *
 * A schedule that throws is caught and recorded rather than aborting the pass —
 * one broken schedule must not stop the others, the same per-source isolation
 * the collector pipeline already uses.
 *
 * Once `stopping()` answers true no further fire starts: the rest stay due,
 * unclaimed, for the next owner's start, instead of being claimed and then
 * failed by an admission that is already closed. Fires already started finish.
 */
export async function sweepSchedules(
  deps: ScheduleSchedulerDependencies,
  limit = 50,
  /**
   * Ids already reported, so a poisoned row is logged once rather than on every
   * tick — and `listDue`'s paging fix made one sweep able to return up to
   * 50x more of them than before, i.e. thousands of identical lines every 30 s
   * from a handful of broken rows. The caller owns the set
   * so it survives across sweeps; a fresh call without it reports everything once.
   */
  reportedUnreadable?: Set<string>,
  stopping: () => boolean = () => false,
): Promise<SweepSchedulesResult> {
  if (stopping()) return { fired: [], unreadable: [] };
  try {
    await deps.routineSweep?.();
  } catch {
    deps.log({ level: "error", message: "routine background sweep failed; continuing independent schedules" });
  }
  const listedAt = deps.now();
  // A lapsed hold no longer blocks an edit either, not only the next fire.
  await releaseEndedHolds(deps, listedAt);
  const listed = await deps.schedules.listDue(listedAt, limit);
  // One unreadable row must not stop the others. `listDue` already excludes and
  // names them; this is the reporting half, and it is not optional — a schedule
  // that cannot be read is a schedule that will never fire again. Reported once
  // per id per process (plus one line saying how many were suppressed).
  const fresh = listed.unreadable.filter((scheduleId) => reportedUnreadable?.has(scheduleId) !== true);
  for (const scheduleId of fresh) reportedUnreadable?.add(scheduleId);
  for (const scheduleId of fresh) {
    deps.log({ level: "error", message: "schedule has an unreadable configuration and was skipped", detail: { scheduleId } });
  }
  const suppressed = listed.unreadable.length - fresh.length;
  if (suppressed > 0) {
    deps.log({
      level: "warn",
      message: "unreadable schedules are still present; their repair instructions were reported once",
      detail: { suppressed, total: listed.unreadable.length },
    });
  }
  const due = listed.due.flatMap((schedule) => (schedule.nextRunAt === null ? [] : [{ schedule, fireTime: schedule.nextRunAt }]));
  // Kept in listing order whatever order the fires finish in.
  const outcomes: ({ scheduleId: string; outcome: FireOutcome } | undefined)[] = due.map(() => undefined);
  const fireGuarded = async (schedule: ScheduleRecord, fireTime: string): Promise<FireOutcome> => {
    const end: FireEnd = {};
    try {
      return await fireTracked(schedule, fireTime, deps, { listedAt }, end);
    } catch (error) {
      // Keyed as every other record of the fire is: its occurrence and try, once it got that far, not the stored pointer.
      const slot = end.slot ?? fireTime;
      const alertIdentity = end.alertIdentity ?? fireTime;
      // A fire that throws must still leave a trace: without this the row keeps
      // its advanced `next_run_at`, so the fire is silently gone *and* nothing
      // says so. Recorded, not just logged — and alerted too, because a failed
      // fire that only reaches the log is exactly the silence that is the
      // worst outcome. The alert is attempted even if the store is the thing that
      // threw: `sendAlert` swallows its own failures, and the messaging outbox is
      // a different store path, so a broken schedule row does not necessarily
      // mean a broken alert channel.
      const detail = errorMessage(error);
      deps.log({ level: "error", message: "schedule fire threw", detail: { scheduleId: schedule.scheduleId, error } });
      try {
        await deps.schedules.recordRun({
          scheduleId: schedule.scheduleId,
          taskId: null,
          outcome: `fire threw: ${detail}`,
          outcomeKind: "failed",
          fire: { fireTime: slot, reasonCode: "failed", ...definedRetry(end.retryCount) },
          now: deps.now(),
        });
      } catch {
        // Recording failed too (the same store problem, most likely); the log
        // above is then the only signal, which is why it is written first.
      }
      await sendAlert(
        schedule,
        { identity: alertIdentity, kind: "fire-threw", text: `Scheduled run "${schedule.name}" could not be dispatched: ${detail}` },
        deps,
      );
      try {
        await pauseIfFailing(schedule, { fireTime: slot, alertIdentity }, deps);
      } catch {
        // The store is most likely what threw; the next fire tries again.
      }
      return { kind: "refused", reason: detail };
    }
  };
  let next = 0;
  const fireNext = async (): Promise<void> => {
    while (next < due.length && !stopping()) {
      const index = next;
      next += 1;
      const entry = due[index];
      if (entry === undefined) break;
      outcomes[index] = { scheduleId: entry.schedule.scheduleId, outcome: await fireGuarded(entry.schedule, entry.fireTime) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_FIRE_CONCURRENCY, due.length) }, fireNext));
  const fired = outcomes.filter((entry) => entry !== undefined);
  return { fired, unreadable: listed.unreadable };
}

export interface ScheduleSchedulerHandle {
  /**
   * Stops future sweeps and waits for the sweep in progress, its started fires
   * included; then no run's budget kept in `inFlight` counts on. Idempotent.
   */
  stop(): Promise<void>;
  /** Sweep now rather than at the next tick; joins a sweep already running. */
  sweep(): Promise<SweepSchedulesResult | undefined>;
}

export interface StartScheduleSchedulerOptions extends ScheduleSchedulerDependencies {
  readonly intervalMs: number;
  /** What runs the interval; absent, `setInterval`. */
  readonly every?: RepeatTimer;
  readonly onSwept?: (result: SweepSchedulesResult) => void;
  /**
   * True once the owner has begun shutting down — its admission closed before
   * this scheduler's `stop()` is reached. A sweep then starts no further fire,
   * since each would be claimed and then refused.
   */
  readonly stopping?: () => boolean;
}

/**
 * Interval wrapper around `sweepSchedules`, on the single-flight loop the
 * reminder scheduler uses: a sweep's fires can run for minutes, and a second
 * sweep started meanwhile from its own snapshot fired more runs on top, judged
 * them late for having queued, and ran the routine bookkeeping alongside
 * itself.
 *
 * The first sweep runs at start, after the orphaned-fire reconciliation — inside
 * the same single flight, so the reconciliation never races a sweep's claim or
 * dispatch marker, and a crash mid-fire is reported at start rather than a day
 * late.
 */
export function startScheduleScheduler(options: StartScheduleSchedulerOptions): ScheduleSchedulerHandle {
  // Shared across sweeps, so a poisoned row is not re-reported every 30 s.
  const reportedUnreadable = new Set<string>();
  let reconciled = false;
  const loop = startSweepLoop({
    intervalMs: options.intervalMs,
    ...(options.every === undefined ? {} : { every: options.every }),
    run: async (stopped) => {
      const stopping = (): boolean => stopped() || options.stopping?.() === true;
      if (!reconciled) {
        reconciled = true;
        try {
          await reconcileOrphanedFires(options);
        } catch (error) {
          options.log({ level: "error", message: "orphaned-fire reconciliation failed", detail: { error } });
        }
      }
      return sweepSchedules(options, 50, reportedUnreadable, stopping);
    },
    onSwept: (result) => options.onSwept?.(result),
    onError: (error) => options.log({ level: "error", message: "schedule sweep failed", detail: { error } }),
  });
  return {
    sweep: loop.sweep,
    stop: async () => {
      await loop.stop();
      options.inFlight?.dispose();
    },
  };
}
