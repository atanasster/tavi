/**
 * The recurring-schedule scheduler.
 *
 * It lives *inside* `tavi serve`, beside `tavi.agentwaitscheduler`, because
 * `serve` owns the data directory exclusively and `tavi run`
 * refuses while it runs, so an OS-cron design would need an IPC command to
 * reach the runtime at all.
 *
 * Two gates make an unattended run possible without weakening governance.
 * Both are operator-authored and durable, never model-authored:
 *
 *  1. **A per-schedule tool allowlist, deny by default.** When a scheduled run
 *     suspends on an approval interrupt, this scheduler answers it — the same
 *     decision path `tavi run --approval approve` already uses, scoped to the
 *     schedule instead of the process.
 *  2. **A review decision for archived tool output.** A result over 64 KiB
 *     becomes a `pending` artifact and suspends the run; the scheduler decides
 *     it by the same allowlist, so a tool the operator trusted may release its
 *     own output and a tool that is not allowlisted cannot.
 *
 * `sandbox.run` therefore stays denied for a scheduled run unless an operator
 * deliberately names it — the intended shape. The fix for unattended use is a
 * scoped policy, not a blanket auto-approve.
 */

// The package's `./schedule-scheduler` entry point: its pieces (`schedule-*.ts` beside it) are internal, and this says what it offers.

export { MIN_FREE_BYTES_FOR_A_FIRE } from "./schedule-fire.js";

/**
 * How late a fire may be and still count as "on time". Judged at the moment
 * the sweep listed the fire due, so waiting behind other fires of the same
 * sweep never counts against it.
 */
export { ON_TIME_TOLERANCE_MS } from "@tavi/contracts";

export { nextOccurrence, instantForLocalTime } from "@tavi/contracts";

export { createInFlightFires, type InFlightFireRegistry, type InFlightFires } from "./in-flight.js";
// The owner's due-work planner, beside the loop it drives: this entry point is how the CLI reaches it.
export { createWakePlanner, type PlannedSweep, type RepeatTimer, repeatEvery, type WakePlanner } from "./sweep-loop.js";
export type { RunBudget, RunBudgetLimit } from "./run-budget.js";

export { type ScheduleAlertKind, sendAlert } from "./schedule-alerts.js";
export { admitScheduledWorker, continueScheduledTask } from "./schedule-continue.js";
export type { FireOutcome, ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
export { fireSchedule, runScheduleNow } from "./schedule-fire.js";
export { releaseEndedHolds } from "./schedule-holds.js";
export { toolAllowed } from "./schedule-policy.js";
export { type OrphanedFire, dispatchMarkerFireTime, reconcileOrphanedFires } from "./schedule-reconcile.js";
export { type ScheduleEmailFire, type ScheduleWebhookFire, parseScheduleRunKey, scheduleRunKey } from "./schedule-run-kind.js";
export {
  SWEEP_FIRE_CONCURRENCY,
  type ScheduleSchedulerHandle,
  type StartScheduleSchedulerOptions,
  type SweepSchedulesResult,
  startScheduleScheduler,
  sweepSchedules,
} from "./schedule-sweep.js";
