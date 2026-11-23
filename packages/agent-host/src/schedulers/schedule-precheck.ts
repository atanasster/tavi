import {
  type SchedulePrecheck,
  type SchedulePrecheckResult,
  type ScheduleRecord,
  schedulePrecheckNote,
  schedulePrecheckText,
  textRef,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

import type { PrecheckReading } from "./in-flight.js";
import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import type { FireOutcome, ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import { type ManualRun, countedKind, countsTowardPause, fireEntry, runLabel } from "./schedule-run-kind.js";

/** A fire whose pre-check found something: what its run is told, and the reading it takes on. */
export interface PrecheckRun {
  readonly note: string;
  readonly reading: PrecheckReading;
}

/** How long a fire waits on its pre-check; the fetch inside it has its own, shorter deadline. */
const PRECHECK_DEADLINE_MS = 60_000;

/**
 * A scheduled fire's pre-check, or a file watcher's check: what its run is told when it found something
 * new (or had no earlier reading), or how the fire ended when it did not run.
 * A watcher's check is recorded under its own reason, and its failure counts towards a pause as a fire's does.
 *
 * - Nothing new: recorded `unchanged`, the reading kept as checked again, and
 *   nothing alerted — no run, no model call.
 * - The check could not be made (refused by the egress guard or the `--fs-root`
 *   rule, or unreadable): recorded failed and counted as a failed run, and its
 *   person told once per cause — one alert until a check works again, since a
 *   page that stays down is one problem, not one a fire.
 */
export async function precheckFire(
  schedule: ScheduleRecord,
  precheck: SchedulePrecheck,
  fire: { readonly slot: string; readonly retryCount: number | undefined; readonly alertIdentity: string; readonly manual: ManualRun },
  deps: ScheduleSchedulerDependencies,
): Promise<PrecheckRun | { readonly ended: FireOutcome }> {
  const label = runLabel(fire.manual);
  const last = schedule.precheckState;
  const check = deps.precheck;
  let result: SchedulePrecheckResult;
  try {
    result =
      check === undefined
        ? { kind: "failed", reason: "no pre-check runs here" }
        : await check(schedule, precheck, last, AbortSignal.timeout(PRECHECK_DEADLINE_MS));
  } catch (error) {
    result = { kind: "failed", reason: errorMessage(error) };
  }
  const now = deps.now();
  if (result.kind === "unchanged") {
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome: `${label}unchanged: ${schedulePrecheckText(precheck)} found nothing new${last === undefined ? "" : ` since ${last.checkedAt}`}, so nothing ran`,
      outcomeKind: "skipped",
      fire: fireEntry(fire.manual, fire.slot, "unchanged", fire.retryCount),
      precheckState: { of: precheck, state: result.state },
      now,
    });
    deps.log({
      level: "info",
      message: "schedule fire's pre-check found nothing new",
      detail: { scheduleId: schedule.scheduleId, fireTime: fire.slot },
    });
    return { ended: { kind: "skipped", reason: "unchanged" } };
  }
  if (result.kind === "failed") {
    const outcome = `${label}pre-check failed: ${result.reason}`;
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome,
      ...countedKind(fire.manual, "failed"),
      fire: fireEntry(fire.manual, fire.slot, "failed", fire.retryCount),
      now,
    });
    deps.log({
      level: "warn",
      message: "schedule fire's pre-check failed",
      detail: { scheduleId: schedule.scheduleId, reason: result.reason },
    });
    await sendAlert(
      schedule,
      {
        identity: `precheck:${sha256Hex(schedulePrecheckText(precheck)).slice(0, 16)}:${last?.checkedAt ?? "never"}`,
        kind: "precheck-failed",
        text: textRef("channel.schedule.alert.precheckFailed", {
          name: schedule.name,
          precheck: schedulePrecheckText(precheck),
          reason: result.reason,
        }),
      },
      deps,
    );
    if (countsTowardPause(fire.manual)) await pauseIfFailing(schedule, { fireTime: fire.slot, alertIdentity: fire.alertIdentity }, deps);
    return { ended: { kind: "refused", reason: outcome } };
  }
  return { note: schedulePrecheckNote(precheck, result, last?.checkedAt), reading: { of: precheck, state: result.state } };
}
