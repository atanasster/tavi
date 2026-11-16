import { AGENT_WAIT_MAX_DEADLINE_MS, type AdmissionResult } from "@tavi/contracts";

import { recordFinished } from "./schedule-cadence.js";
import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import type { RoundRefusal } from "./schedule-policy.js";

/**
 * A run stopped at a question: only a task whose durable policy lets it
 * ask can, and every such question carries a default, so it goes on by itself
 * once answered or past its deadline — whatever the schedule says now.
 */
function askingWithDefault(admission: AdmissionResult): boolean {
  return admission.outcome.waitInterrupt?.question !== undefined;
}

/** A run stopped to wait on a worker it spawned: the worker's end, or the wait's deadline, carries it on. */
function waitingOnWorker(admission: AdmissionResult): boolean {
  return admission.outcome.waitInterrupt?.wait.waitingOnWorkerTaskId !== undefined;
}

/** How long past its wait's deadline a suspended run's schedule stays in flight with no continuation. */
const HOLD_GRACE_MS = 5 * 60_000;

/** What a run that is not over goes on from by itself: how it is recorded meanwhile, and until when its schedule is held. */
export interface Suspension {
  readonly outcome: string;
  readonly message: string;
  readonly reasonCode: "asked" | "waiting";
  /** Absent when the wait names no deadline the hold can lapse at. */
  readonly until?: string;
}

const ASKED: Pick<Suspension, "outcome" | "message" | "reasonCode"> = {
  outcome: "asked a question; goes on with its default if nobody answers in time",
  message: "schedule fire asked a question",
  reasonCode: "asked",
};

const WAITING_ON_WORKER: Pick<Suspension, "outcome" | "message" | "reasonCode"> = {
  outcome: "waiting on a worker; goes on once it finishes",
  message: "schedule fire is waiting on a worker",
  reasonCode: "waiting",
};

/**
 * What a run is suspended on, or `undefined` when it is over: a question its
 * schedule allows or a worker it waits on (held to the wait's deadline, with
 * some grace), or — its turn ended — a worker it spawned that it has yet to
 * hear from, which wakes it to read the result (held for as long as a wait on
 * that worker could have lasted).
 */
export async function suspensionOf(
  admission: AdmissionResult,
  refusal: RoundRefusal | undefined,
  deps: ScheduleSchedulerDependencies,
): Promise<Suspension | undefined> {
  if (refusal !== undefined) return undefined;
  const status = admission.outcome.status;
  const wait = admission.outcome.waitInterrupt?.wait;
  if (status === "waiting" && wait !== undefined && (askingWithDefault(admission) || waitingOnWorker(admission))) {
    const deadlineMs = Date.parse(wait.deadlineAt);
    return {
      ...(askingWithDefault(admission) ? ASKED : WAITING_ON_WORKER),
      ...(Number.isFinite(deadlineMs) ? { until: new Date(deadlineMs + HOLD_GRACE_MS).toISOString() } : {}),
    };
  }
  if (status === "completed" && (await deps.workersOutstanding?.(admission.taskId)) === true) {
    return {
      ...WAITING_ON_WORKER,
      until: new Date(Date.parse(deps.now()) + AGENT_WAIT_MAX_DEADLINE_MS + HOLD_GRACE_MS).toISOString(),
    };
  }
  return undefined;
}

/**
 * Hands a fire's (or a continuation's) claim on its task over to the registry
 * when the run is suspended on something that carries it on by itself, so the
 * schedule stays in flight, refusing overlapping fires and edits, until its
 * continuation settles it. Otherwise releases it. True when held.
 */
export function holdWhileSuspended(
  taskId: string,
  suspension: Suspension | undefined,
  release: (() => void) | undefined,
  deps: ScheduleSchedulerDependencies,
): boolean {
  if (release === undefined) return false;
  if (suspension?.until === undefined || deps.inFlight === undefined) {
    release();
    return false;
  }
  deps.inFlight.hold(taskId, release, suspension.until);
  return true;
}

/**
 * Releases every hold whose run will not go on: past its `until`, or — told by
 * `runEnded` — its task was cancelled, failed, or ended with no worker left to
 * hear from, so a cancelled run's schedule is free again rather than held to
 * its wait's deadline.
 */
export async function releaseEndedHolds(deps: ScheduleSchedulerDependencies, now: string): Promise<void> {
  const inFlight = deps.inFlight;
  if (inFlight === undefined) return;
  const heldFor = new Set(inFlight.heldTasks().flatMap((taskId) => inFlight.scheduleOf(taskId) ?? []));
  inFlight.expireHolds(now);
  const runEnded = deps.runEnded;
  for (const taskId of runEnded === undefined ? [] : inFlight.heldTasks()) {
    if (!(await runEnded?.(taskId))) continue;
    inFlight.settle(taskId);
    // Cancelled or ended by other means: its budget is not spent on it any more.
    inFlight.budgetOf(taskId)?.close();
    inFlight.keepBudget(taskId, undefined);
  }
  // A schedule whose last run was held, and is over without a continuation to finish it, finishes now.
  for (const scheduleId of heldFor) {
    if (inFlight.hasSchedule(scheduleId)) continue;
    try {
      const stored = await deps.schedules.get(scheduleId);
      if (stored?.enabled === true && stored.nextRunAt === null) await recordFinished(stored, stored.lastRunAt ?? now, deps);
    } catch (error) {
      deps.log({ level: "error", message: "could not finish a schedule", detail: { scheduleId, error } });
    }
  }
}
