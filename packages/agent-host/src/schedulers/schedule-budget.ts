import { type ScheduleRecord, type TextRef, scheduleMaxRunMinutes, textRef, tokenCountText } from "@tavi/contracts";

import type { RunBudget, RunBudgetLimit } from "./run-budget.js";
import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import type { Suspension } from "./schedule-holds.js";
import { type ManualRun, countedKind, countsTowardPause, fireEntry, runLabel } from "./schedule-run-kind.js";

/**
 * Keeps a run's budget past the turn that ends here, paused while it waits —
 * its workers' turns count on it meanwhile (`admitScheduledWorker`) — for as
 * long as its schedule is held for it (`holdWhileSuspended`), whose lapse drops
 * it. Closed and dropped once the run is over, or nothing holds it to be
 * carried on in this process, so it stops nothing more.
 */
export function carryBudget(
  taskId: string,
  budget: RunBudget,
  suspension: Suspension | undefined,
  deps: ScheduleSchedulerDependencies,
): void {
  if (suspension?.until === undefined || deps.inFlight === undefined) {
    budget.close();
    deps.inFlight?.keepBudget(taskId, undefined);
    return;
  }
  deps.inFlight.keepBudget(taskId, budget);
}

/**
 * What an overlap alert says of the run still going: its limit only while this
 * process counts it, since a run paused on a worker or an answer, or one another
 * owner runs, is not stopped by it.
 */
export function overlapText(schedule: ScheduleRecord, deps: ScheduleSchedulerDependencies): TextRef {
  const inFlight = deps.inFlight;
  const budget = inFlight
    ?.tasksOf(schedule.scheduleId)
    .map((taskId) => inFlight.budgetOf(taskId))
    .find((kept) => kept !== undefined && !kept.spent);
  const name = schedule.name;
  const minutes = String(scheduleMaxRunMinutes(schedule));
  if (budget === undefined) return textRef("channel.schedule.alert.overlap", { name });
  if (budget.counting) return textRef("channel.schedule.alert.overlapCounting", { name, minutes });
  return textRef("channel.schedule.alert.overlapWaiting", { name, minutes });
}

/** How a run stopped at its schedule's limit is recorded: its time, or its token ceiling (`budget` its spent one, when known). */
export function overrunOutcome(schedule: ScheduleRecord, manual: ManualRun, budget?: Pick<RunBudget, "spentOn" | "usedTokens">): string {
  const prefix = runLabel(manual);
  if (budget?.spentOn === "tokens" && schedule.maxTokens !== undefined)
    return `${prefix}over budget: stopped after ${tokenCountText(budget.usedTokens)}, past its ceiling of ${tokenCountText(schedule.maxTokens)}`;
  return `${prefix}timed out: stopped after ${scheduleMaxRunMinutes(schedule)} minutes of work`;
}

/**
 * Stops a run that worked past its schedule's `maxRunMinutes`, or used more
 * tokens than its `maxTokens` (its turn in flight is already aborted): its task
 * and workers cancelled and its wait settled, recorded failed as `timeout` or
 * `budget`, alerted once, and its schedule freed so the next fire runs.
 */
export async function stopOverrunRun(
  schedule: ScheduleRecord,
  run: {
    readonly taskId: string | undefined;
    readonly manual: ManualRun;
    readonly fireTime: string;
    readonly alertIdentity: string;
    readonly retryCount?: number;
  },
  deps: ScheduleSchedulerDependencies,
  spent: { readonly limit: RunBudgetLimit; readonly usedTokens: number },
): Promise<void> {
  const minutes = scheduleMaxRunMinutes(schedule);
  const overTokens = spent.limit === "tokens" && schedule.maxTokens !== undefined;
  const ceiling = schedule.maxTokens === undefined ? "" : tokenCountText(schedule.maxTokens);
  if (run.taskId !== undefined) {
    try {
      await deps.cancelRun?.(
        schedule,
        run.taskId,
        overTokens
          ? `the run used more than its schedule's ceiling of ${ceiling}`
          : `the run worked past its schedule's ${minutes}-minute limit`,
      );
    } catch (error) {
      deps.log({
        level: "error",
        message: "a scheduled run past its limit could not be cancelled",
        detail: { scheduleId: schedule.scheduleId, taskId: run.taskId, error },
      });
    }
  }
  await deps.schedules.recordRun({
    scheduleId: schedule.scheduleId,
    taskId: run.taskId ?? null,
    outcome: overrunOutcome(schedule, run.manual, { spentOn: spent.limit, usedTokens: spent.usedTokens }),
    ...countedKind(run.manual, "failed"),
    fire: fireEntry(run.manual, run.fireTime, overTokens ? "budget" : "timeout", run.retryCount),
    now: deps.now(),
  });
  deps.log({
    level: "error",
    message: overTokens
      ? "a scheduled run used more tokens than its ceiling and was stopped"
      : "a scheduled run worked past its limit and was stopped",
    detail: overTokens
      ? {
          scheduleId: schedule.scheduleId,
          fireTime: run.fireTime,
          taskId: run.taskId,
          tokens: spent.usedTokens,
          maxTokens: schedule.maxTokens,
        }
      : { scheduleId: schedule.scheduleId, fireTime: run.fireTime, taskId: run.taskId, minutes },
  });
  const stopped =
    run.taskId === undefined
      ? textRef("channel.schedule.alert.stopped", { name: schedule.name })
      : textRef("channel.schedule.alert.stoppedTask", { name: schedule.name, taskId: run.taskId });
  await sendAlert(
    schedule,
    overTokens
      ? {
          identity: run.alertIdentity,
          kind: "run-budget",
          text: textRef("channel.schedule.alert.overTokens", {
            stopped,
            tokens: textRef("schedule.tokens", { count: Math.round(spent.usedTokens) }),
            ceiling: schedule.maxTokens === undefined ? "" : textRef("schedule.tokens", { count: Math.round(schedule.maxTokens) }),
          }),
        }
      : {
          identity: run.alertIdentity,
          kind: "run-timeout",
          text: textRef("channel.schedule.alert.overTime", { stopped, minutes: String(minutes) }),
        },
    deps,
  );
  if (countsTowardPause(run.manual)) await pauseIfFailing(schedule, run, deps);
  if (run.taskId !== undefined) deps.inFlight?.settle(run.taskId);
}
