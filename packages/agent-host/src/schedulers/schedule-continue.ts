import { textRef, type AdmissionResult, type AdmitInput, type ScheduleRecord, type WorkflowInvokeOptions } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { startRunBudget } from "./run-budget.js";
import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import { carryBudget, stopOverrunRun } from "./schedule-budget.js";
import { recordFinished } from "./schedule-cadence.js";
import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import { type Suspension, holdWhileSuspended, suspensionOf } from "./schedule-holds.js";
import { type RoundRefusal, resolveSuspensions } from "./schedule-policy.js";
import { reportFire } from "./schedule-report.js";
import {
  MANUAL_RUN,
  type ManualRun,
  WATCH_RUN,
  countedKind,
  countsTowardPause,
  definedRetry,
  fireEntry,
  parseScheduleRunKey,
  runLabel,
  scheduleRunContext,
  withEventCeiling,
} from "./schedule-run-kind.js";

/**
 * Carries a scheduled task on once what it waited on is settled — its
 * question (an answer anywhere, or the deadline's default) or its worker (the
 * worker's result, or the wait's deadline): the resume a settler admits runs,
 * and then the schedule decides its approval rounds and reviews by its tool
 * policy, as the fire would have, with the task registered as the fire's again
 * so its rounds are the schedule's to decide. How the run ended is recorded as
 * a fire's is, under the fire's own label; a run that stops to wait again keeps
 * the schedule in flight, and one that ends settles it.
 *
 * `runKey` is the task's creating admission key (`scheduleRunKey`): it says
 * whether the run was a manual one and which fire it was.
 *
 * The run's budget (`RunBudget`) counts on from what its fire left, or starts
 * whole when none is kept (an owner restarted since). A run already stopped at
 * its limit was cancelled and recorded: what carries it on only reads that.
 */
export async function continueScheduledTask(
  stored: ScheduleRecord,
  input: AdmitInput,
  deps: ScheduleSchedulerDependencies,
  run: { readonly runKey?: string | null } = {},
): Promise<AdmissionResult> {
  const taskId = input.taskId ?? "";
  const alertIdentity = `${input.operationKey}:continued`;
  const fire = run.runKey === undefined || run.runKey === null ? undefined : parseScheduleRunKey(run.runKey);
  const manual: ManualRun =
    fire?.manual !== true
      ? false
      : fire.webhook === true
        ? { reason: "webhook", label: "webhook run: " }
        : fire.watch === true
          ? WATCH_RUN
          : fire.email === true
            ? { reason: "email", label: "email run: " }
            : MANUAL_RUN;
  const schedule = withEventCeiling(stored, manual !== false && (manual.reason === "webhook" || manual.reason === "email"));
  // The fire's own time, so its outcome lands on the row its fire recorded it waiting on.
  const fireTime = fire?.fireTime ?? deps.now();
  const retryCount = fire !== undefined && !fire.manual ? fire.retry : undefined;
  // Behind the fire that suspended it, and any continuation before this one,
  // still recording how the run stood: one run's records land in order.
  const reported = await deps.inFlight?.reportingAfter(taskId);
  // Whether the run is suspended again, its schedule held for its next continuation.
  let held = false;
  try {
    const kept = deps.inFlight?.budgetOf(taskId);
    if (kept?.spent === true) return await deps.workflow.admit(input);
    const budget =
      kept ??
      startRunBudget(schedule, deps, (limit, usedTokens) =>
        stopOverrunRun(
          schedule,
          { taskId, manual, fireTime, alertIdentity: fire?.manual === false ? fire.fireTime : alertIdentity, ...definedRetry(retryCount) },
          deps,
          { limit, usedTokens },
        ),
      );
    if (kept === undefined) deps.inFlight?.keepBudget(taskId, budget);
    budget.resume();
    const leave = deps.inFlight?.enter(taskId, schedule.scheduleId, manual !== false && manual.reason === "watch");
    let admission: AdmissionResult;
    let refusal: RoundRefusal | undefined;
    try {
      // A wake to read a worker's result rebuilds the run's context, so every turn is told again how it delivers.
      admission = await deps.workflow.admit(
        { ...input, context: { ...input.context, ...scheduleRunContext(schedule) } },
        { signal: budget.signal },
      );
      ({ admission, refusal } = await resolveSuspensions(admission, schedule, `${input.operationKey}:policy`, deps, budget.signal));
    } catch (error) {
      budget.pause();
      leave?.();
      if (budget.spent) {
        await budget.stopped;
        throw error;
      }
      // A file watcher's change is kept as seen, failed or not, as its fire's report would have kept it.
      const reading = manual !== false && manual.reason === "watch" ? deps.inFlight?.readingOf(taskId) : undefined;
      budget.close();
      deps.inFlight?.keepBudget(taskId, undefined);
      deps.inFlight?.settle(taskId);
      // As a fire that could not run: recorded and alerted, not left reading "asked a question" or "waiting".
      const detail = errorMessage(error);
      await deps.schedules.recordRun({
        scheduleId: schedule.scheduleId,
        taskId,
        outcome: `${runLabel(manual)}failed after its wait: ${detail}`,
        ...countedKind(manual, "failed"),
        fire: fireEntry(manual, fireTime, "failed", retryCount),
        ...(reading === undefined ? {} : { precheckState: reading }),
        now: deps.now(),
      });
      deps.log({
        level: "error",
        message: "a scheduled task could not carry on after its wait",
        detail: { scheduleId: schedule.scheduleId, taskId, fireTime, error },
      });
      await sendAlert(
        schedule,
        {
          identity: alertIdentity,
          kind: "run-outcome",
          text: textRef("channel.schedule.alert.carryOnFailed", { name: schedule.name, taskId, detail }),
        },
        deps,
      );
      if (countsTowardPause(manual)) await pauseIfFailing(schedule, { fireTime, alertIdentity }, deps);
      throw error;
    }
    budget.pause();
    if (budget.spent) {
      await budget.stopped;
      leave?.();
      return admission;
    }
    // As a fire's report: a limit a worker's turn reaches meanwhile stops the run once this record is down.
    const resumeStops = budget.deferStop();
    let suspension: Suspension | undefined;
    try {
      suspension = await suspensionOf(admission, refusal, deps);
      const reading = deps.inFlight?.readingOf(taskId);
      await reportFire(schedule, admission, refusal, suspension, manual, alertIdentity, fireTime, deps, {
        retryCount: retryCount ?? 0,
        retryable: false,
        ...(reading === undefined ? {} : { precheckReading: reading }),
      });
      return admission;
    } finally {
      held = holdWhileSuspended(taskId, suspension, leave, deps);
      if (!held) deps.inFlight?.settle(taskId);
      carryBudget(taskId, budget, suspension, deps);
      resumeStops();
    }
  } finally {
    reported?.();
    // The run's end is its fire's: a schedule whose last occurrence it was finishes now, not when its fire suspended.
    if (!held && schedule.enabled && schedule.nextRunAt === null) await recordFinished(schedule, fireTime, deps);
  }
}

/**
 * Admits a turn of a worker a schedule's run spawned, and decides its approval
 * rounds and reviews by the schedule's tool policy — every denial the run's own
 * rounds get included — since nobody attends a scheduled run to answer them.
 * The worker is the schedule's while this decides it, so its rounds are not
 * announced and an operator's decision for one is refused meanwhile. Nothing
 * is recorded on the schedule: the worker's result goes to the task that
 * spawned it, and that task's outcome is the run's.
 *
 * The turn, its working time and its model calls' tokens, counts on the
 * budget of the run that spawned it (`run.rootTaskId`), if one is kept, and is
 * aborted with it once it is spent.
 */
export async function admitScheduledWorker(
  schedule: ScheduleRecord,
  input: AdmitInput,
  deps: ScheduleSchedulerDependencies,
  options?: WorkflowInvokeOptions,
  run: { readonly rootTaskId?: string } = {},
): Promise<AdmissionResult> {
  const budget = run.rootTaskId === undefined ? undefined : deps.inFlight?.budgetOf(run.rootTaskId);
  let signal = options?.signal;
  if (budget !== undefined) signal = signal === undefined ? budget.signal : AbortSignal.any([signal, budget.signal]);
  const done = budget?.working();
  // A watcher's run's worker is part of that run.
  const watch = run.rootTaskId !== undefined && deps.inFlight?.watchRun(run.rootTaskId) === true;
  let leave = input.taskId === undefined ? undefined : deps.inFlight?.enter(input.taskId, schedule.scheduleId, watch);
  // The worker's model calls count on the run's tokens while its turn runs.
  let uncharge = input.taskId === undefined || budget === undefined ? undefined : deps.inFlight?.chargeTo(input.taskId, budget);
  try {
    const admission = await deps.workflow.admit(
      {
        ...input,
        onAdmitted: async (admitted) => {
          leave ??= deps.inFlight?.enter(admitted.taskId, schedule.scheduleId, watch);
          if (budget !== undefined) uncharge ??= deps.inFlight?.chargeTo(admitted.taskId, budget);
          await input.onAdmitted?.(admitted);
        },
      },
      signal === undefined ? options : { ...options, signal },
    );
    const resolved = await resolveSuspensions(admission, schedule, `${input.operationKey}:policy`, deps, budget?.signal);
    if (resolved.refusal !== undefined) {
      deps.log({
        level: "warn",
        message: "a scheduled run's worker round was decided elsewhere",
        detail: { scheduleId: schedule.scheduleId, taskId: resolved.refusal.taskId, steps: resolved.refusal.steps },
      });
    }
    return resolved.admission;
  } finally {
    done?.();
    uncharge?.();
    leave?.();
  }
}
