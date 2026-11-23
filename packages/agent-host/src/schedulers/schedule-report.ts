import {
  type AdmissionResult,
  MISSED_RUN_GRACE_MS,
  SCHEDULE_RETRY_BACKOFF_MINUTES,
  type ScheduleRecord,
  type ScheduleRetry,
  disarmUrls,
  isNothingToReport,
  normalisedDelivery,
  textRef,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

import type { PrecheckReading } from "./in-flight.js";
import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import type { FireOutcome, ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import type { Suspension } from "./schedule-holds.js";
import { type RoundRefusal, suspensionKind, toolAllowed } from "./schedule-policy.js";
import { type ManualRun, countedKind, countsTowardPause, fireEntry, labelledOutcome, runLabel } from "./schedule-run-kind.js";

/** No URL is known to an alert's chat, so every address in a run's words sent there is disarmed. */
const NO_KNOWN_URLS: ReadonlySet<string> = new Set();

/**
 * Whether a failed run did anything a second try could do again: a tool call
 * with an effect (every call but a read-only one is in the effect ledger) that
 * ran, or whose outcome is unknown. Without the ledger, that is not known, and
 * is taken as yes.
 */
async function actedOnce(deps: ScheduleSchedulerDependencies, taskId: string): Promise<boolean> {
  if (deps.effects === undefined) return true;
  return (await deps.effects.listForTask(taskId)).some((effect) => effect.state !== "rejected");
}

/**
 * Arms a failed run's fire to be tried again, and says when: only for a run
 * of a scheduled fire that failed on provider weather (`providerFailure`) and
 * did nothing with an effect (`actedOnce`), with a retry left
 * (`SCHEDULE_RETRY_BACKOFF_MINUTES`), whose retry falls within the fire's grace
 * and before the schedule's next regular fire, if it has one — which it would
 * otherwise run beside. `undefined` when it is not tried again.
 */
async function armRetryAfter(
  schedule: ScheduleRecord,
  admission: AdmissionResult,
  fireTime: string,
  attempt: FireAttempt,
  deps: ScheduleSchedulerDependencies,
): Promise<{ readonly retryAt: string; readonly count: number } | undefined> {
  const retried = attempt.retryCount;
  const backoffMinutes = SCHEDULE_RETRY_BACKOFF_MINUTES[retried];
  if (backoffMinutes === undefined) return undefined;
  const code = admission.outcome.error?.code;
  if (code === "CANCELLED" || code === "ABORTED") return undefined;
  if (deps.providerFailure?.(admission.taskId) !== "transient") return undefined;
  if (await actedOnce(deps, admission.taskId)) return undefined;
  const now = deps.now();
  const retryAtMs = Date.parse(now) + backoffMinutes * 60_000;
  if (retryAtMs - Date.parse(fireTime) > MISSED_RUN_GRACE_MS) return undefined;
  const claimed = attempt.claimedNextRunAt;
  if (claimed === undefined || (claimed !== null && retryAtMs >= Date.parse(claimed))) return undefined;
  const retryAt = new Date(retryAtMs).toISOString();
  const retry: ScheduleRetry = { count: retried + 1, ofFireTime: fireTime };
  const armed = await deps.schedules.armRetry({
    scheduleId: schedule.scheduleId,
    expectedNextRunAt: claimed,
    retryAt,
    retry,
    now,
  });
  return armed ? { retryAt, count: retry.count } : undefined;
}

/** How a fire's run stands once its policy loop stopped: a round decided elsewhere, or `reportRun`. */
export async function reportFire(
  schedule: ScheduleRecord,
  admission: AdmissionResult,
  refusal: RoundRefusal | undefined,
  suspension: Suspension | undefined,
  manual: ManualRun,
  alertIdentity: string,
  slot: string,
  deps: ScheduleSchedulerDependencies,
  attempt: FireAttempt = { retryCount: 0, retryable: false },
): Promise<FireOutcome> {
  const label = runLabel(manual);
  if (refusal !== undefined) {
    // The task started and is not this fire's to finish: another front end
    // decided the round this fire was about to answer, and the in-queue
    // precondition refused the fire's own decision. "Could not start", with no
    // task, would send the operator looking for a run that did not happen.
    const outcome = `${label}failed: round ${refusal.steps ?? "(unrecorded)"} was decided elsewhere: ${refusal.message}`;
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId: refusal.taskId,
      outcome,
      ...countedKind(manual, "failed"),
      fire: fireEntry(manual, slot, "failed", attempt.retryCount),
      now: deps.now(),
    });
    deps.log({
      level: "warn",
      message: "schedule round decided elsewhere",
      detail: { scheduleId: schedule.scheduleId, taskId: refusal.taskId, steps: refusal.steps },
    });
    await sendAlert(
      schedule,
      {
        identity: alertIdentity,
        kind: "round-decided-elsewhere",
        text: textRef("channel.schedule.alert.decidedElsewhere", {
          name: schedule.name,
          taskId: refusal.taskId,
          steps: refusal.steps ?? textRef("channel.schedule.alert.unrecorded"),
        }),
      },
      deps,
    );
    if (countsTowardPause(manual)) await pauseIfFailing(schedule, { fireTime: slot, alertIdentity }, deps);
    return { kind: "ran", taskId: refusal.taskId, status: "waiting", finalText: outcome };
  }

  return reportRun(schedule, admission, suspension, manual, alertIdentity, slot, deps, attempt);
}

/**
 * Which try of its fire a run is (0 its first, then each retry's count), and
 * whether a failure of it may arm another: only a scheduled fire's, never a
 * manual run's or a run's carried on after a wait.
 */
interface FireAttempt {
  readonly retryCount: number;
  readonly retryable: boolean;
  /** The next fire this fire's claim armed (`null`: it was the last): a retry is armed only while the pointer is still that. */
  readonly claimedNextRunAt?: string | null;
  /** What the fire's pre-check read: kept as the schedule's baseline once the run completes (a file watcher's: once it ends). */
  readonly precheckReading?: PrecheckReading;
}

/**
 * Records how a schedule's run ended, and alerts when it did not deliver. A run
 * that is suspended (`suspensionOf`) is not over: it is recorded as asking or
 * waiting — neither a success nor a failure — and reported again once its
 * answer, its default or its worker's result has carried it on
 * (`continueScheduledTask`).
 */
async function reportRun(
  schedule: ScheduleRecord,
  admission: AdmissionResult,
  suspension: Suspension | undefined,
  manual: ManualRun,
  alertIdentity: string,
  fireTime: string,
  deps: ScheduleSchedulerDependencies,
  attempt: FireAttempt = { retryCount: 0, retryable: false },
): Promise<FireOutcome> {
  const label = runLabel(manual);
  const status = admission.outcome.status;
  const finalText = admission.outcome.finalText;
  const taskId = admission.taskId;
  if (suspension !== undefined) {
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId,
      outcome: `${label}${suspension.outcome}`,
      outcomeKind: "skipped",
      fire: fireEntry(manual, fireTime, suspension.reasonCode, attempt.retryCount),
      // What its pre-check found is kept as seen only once the run has ended as a fire's run would be, by the report that ends it.
      now: deps.now(),
    });
    deps.log({ level: "info", message: suspension.message, detail: { scheduleId: schedule.scheduleId, fireTime, taskId } });
    return { kind: "ran", taskId, status, finalText };
  }
  // A run that failed on provider weather, having done nothing, is tried again
  // later: not a failure yet, and nobody is told unless its last try fails too.
  const retry = status === "failed" && attempt.retryable ? await armRetryAfter(schedule, admission, fireTime, attempt, deps) : undefined;
  if (retry !== undefined) {
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId,
      outcome: `retrying at ${retry.retryAt} (retry ${retry.count} of ${SCHEDULE_RETRY_BACKOFF_MINUTES.length}) after a provider error: ${finalText}`,
      outcomeKind: "skipped",
      fire: fireEntry(false, fireTime, "retry", attempt.retryCount),
      now: deps.now(),
    });
    deps.log({
      level: "warn",
      message: "schedule run failed on a provider error; its fire is tried again",
      detail: { scheduleId: schedule.scheduleId, fireTime, taskId, retryAt: retry.retryAt, retry: retry.count },
    });
    return { kind: "ran", taskId, status, finalText };
  }
  // A person's stop: no failure, so no alert, no count and no pause, and what its pre-check found is kept as seen.
  if (status === "stopped") {
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId,
      outcome: `${label}stopped: ${finalText}`,
      outcomeKind: "skipped",
      fire: fireEntry(manual, fireTime, "stopped", attempt.retryCount),
      ...(attempt.precheckReading === undefined ? {} : { precheckState: attempt.precheckReading }),
      now: deps.now(),
    });
    deps.log({
      level: "info",
      message: "schedule fire stopped by a person",
      detail: { scheduleId: schedule.scheduleId, fireTime, taskId },
    });
    return { kind: "ran", taskId, status, finalText };
  }
  const failed = status !== "completed";
  // Any other `waiting` run is reported distinctly rather than as a failure.
  // Nothing in a scheduled run answers it, so it will not finish on its own —
  // an operator has to know that, and "failed" would send them looking for a
  // bug that is not there.
  // A completed run that delivered nothing is not a success. The brief is the
  // point of the schedule, so an accepted `messaging.send_to` for this exact task
  // is what separates "the operator has a brief" from "the model finished
  // talking": without it the fire recorded `succeeded`, logged at info, and told
  // nobody — the silence the alert exists to prevent.
  // Into Home: a completed run whose schedule delivers to Home posts its
  // result there. A failed or waiting run is not posted: its alert below is
  // the one word it gets, so Home is told once. A run that may send its own
  // brief (`messaging.send_to`) still owes it: one that sent nothing is
  // alerted as undelivered, whether or not its result also reached Home.
  // Unless its schedule tells its person only when there is something
  // (`notify`): then a run with nothing to tell, or the same result as last
  // time, is a quiet success — nothing posted, nothing alerted. A send the
  // connector refused is still undelivered.
  const delivery = status === "completed" ? await runDelivery(schedule, finalText, taskId, deps) : undefined;
  // The nothing-to-report marker is the scheduler's to read, never anyone's to see: not in Home, nor in an answer.
  const marker = (schedule.notify ?? "always") !== "always" && isNothingToReport(finalText);
  const homeHash = schedule.notify === "if-changed" && delivery?.kind !== "quiet" ? sha256Hex(normalisedDelivery(finalText)) : undefined;
  const homed =
    status === "completed" && schedule.deliverTo === "home" && delivery?.kind !== "quiet" && !marker
      ? await postHome(schedule, admission, deps)
      : undefined;
  const posted = homed === "posted";
  // A result for Home that reached none is said so, in its fire and to whoever ran it now: not dropped in silence.
  const notPosted =
    homed === "no-home" ? "there is no Home to post it in (Home is off)" : homed === "failed" ? "posting it into Home failed" : undefined;
  const notPostedRef =
    homed === "no-home"
      ? textRef("schedule.outcome.notPosted.noHome")
      : homed === "failed"
        ? textRef("schedule.outcome.notPosted.failed")
        : undefined;
  const undelivered = delivery?.kind === "undelivered";
  const completed = status === "completed" && !undelivered;
  // "Nothing to report" from a run that was refused calls may only mean it was cut short: told, never quiet.
  const refusedCalls = delivery?.kind === "quiet" && !delivery.unchanged ? (deps.inFlight?.deniedCalls(taskId) ?? 0) : 0;
  const cutShort = refusedCalls === 0 ? undefined : `${refusedCalls} of its calls ${refusedCalls === 1 ? "was" : "were"} refused`;
  const outcome =
    cutShort !== undefined
      ? `${label}completed with nothing to report, but ${cutShort}, so it may have missed something`
      : delivery?.kind === "quiet"
        ? `${label}${delivery.unchanged ? "completed quietly: the result was unchanged, so it was not sent again" : "completed quietly: nothing to report, so nothing was sent"}`
        : completed
          ? `${label}completed${notPosted === undefined ? "" : `, but its result was not posted: ${notPosted}`}`
          : undelivered
            ? `${label}completed but nothing was delivered: no brief was sent`
            : status === "waiting"
              ? `${label}waiting: suspended on ${suspensionKind(admission)}, which nothing in an unattended run resolves`
              : `${label}failed: ${finalText}`;
  // The outcomes the canvas cannot read back from their words, by key: it says the rest from the words themselves.
  const saidRef =
    refusedCalls > 0
      ? textRef("schedule.outcome.cutShort", { count: refusedCalls, n: String(refusedCalls) })
      : delivery?.kind !== "quiet" && completed
        ? notPostedRef
        : undefined;
  const outcomeRef = saidRef === undefined ? undefined : labelledOutcome(manual, saidRef);
  // What an `if-changed` schedule delivered this time, which the next run's result is compared with.
  const deliveredHash =
    delivery?.kind === "delivered" && delivery.sentHash !== undefined ? delivery.sentHash : posted ? homeHash : undefined;

  await deps.schedules.recordRun({
    scheduleId: schedule.scheduleId,
    taskId,
    outcome,
    ...(outcomeRef === undefined ? {} : { outcomeRef }),
    ...countedKind(manual, completed ? "succeeded" : "failed"),
    fire: fireEntry(
      manual,
      fireTime,
      delivery?.kind === "quiet" ? "quiet" : completed ? "ok" : undelivered ? "undelivered" : "failed",
      attempt.retryCount,
    ),
    ...(deliveredHash === undefined ? {} : { deliveredHash }),
    // A completed run has seen what its pre-check found: the next fire compares with that. A failed fire's has
    // not, so the next fire (or this one's retry) finds the same change again. A failed file-watch run's change is
    // kept as seen, or each later event on the file would run the model on it again; its person is told it failed.
    ...(attempt.precheckReading === undefined || (status !== "completed" && (manual === false || manual.reason !== "watch"))
      ? {}
      : { precheckState: attempt.precheckReading }),
    now: deps.now(),
  });
  if (cutShort !== undefined) {
    await sendAlert(
      schedule,
      {
        identity: alertIdentity,
        kind: "run-outcome",
        text: textRef("channel.schedule.alert.cutShort", { name: schedule.name, count: refusedCalls, n: String(refusedCalls) }),
      },
      deps,
    );
  } else if (undelivered) {
    await sendAlert(
      schedule,
      {
        identity: alertIdentity,
        kind: "run-undelivered",
        text: textRef("channel.schedule.alert.undelivered", { name: schedule.name }),
      },
      deps,
    );
  } else if (failed) {
    await sendAlert(
      schedule,
      {
        identity: alertIdentity,
        kind: "run-outcome",
        // The run's own words, which a webhook's caller or an email's sender may have steered: no address in
        // them is a link in the alert's chat.
        text: textRef(
          status === "failed"
            ? "channel.schedule.alert.failed"
            : status === "waiting"
              ? "channel.schedule.alert.waiting"
              : "channel.schedule.alert.ended",
          {
            name: schedule.name,
            status,
            text: disarmUrls(finalText, NO_KNOWN_URLS) || textRef("channel.schedule.alert.noDetail"),
          },
        ),
        homeText: textRef(
          status === "failed"
            ? "channel.schedule.alert.failedHome"
            : status === "waiting"
              ? "channel.schedule.alert.waitingHome"
              : "channel.schedule.alert.endedHome",
          { name: schedule.name, status },
        ),
      },
      deps,
    );
  } else {
    deps.log({
      level: "info",
      message: delivery?.kind === "quiet" ? "schedule fire completed with nothing to tell" : "schedule fire completed",
      detail: { scheduleId: schedule.scheduleId, fireTime, taskId },
    });
  }
  if (!completed && countsTowardPause(manual)) await pauseIfFailing(schedule, { fireTime, alertIdentity }, deps);
  return {
    kind: "ran",
    taskId,
    status,
    finalText: marker ? "nothing to report" : finalText,
    ...(completed && notPosted !== undefined ? { notPosted } : {}),
  };
}

/**
 * How a completed run's delivery stands, by its schedule's `notify`:
 *
 * - `quiet`: nothing to tell — it ended with the nothing-to-report marker
 *   (a schedule that does not always notify), attempted no send while it may
 *   send (`when-sent`), or its result was the same as the last one delivered
 *   (`if-changed`: a send declined as unchanged, or a Home result whose hash
 *   is the stored one) — and nothing was delivered, refused or denied.
 * - `undelivered`: it may send and nothing reached its connector's acceptance.
 * - `delivered`: anything else, with the hash of what an `if-changed` send delivered.
 *
 * Under `always` the marker means nothing and nothing is declined, so the
 * answer is the one before `notify` existed.
 */
async function runDelivery(
  schedule: ScheduleRecord,
  finalText: string,
  taskId: string,
  deps: ScheduleSchedulerDependencies,
): Promise<
  | { readonly kind: "quiet"; readonly unchanged: boolean }
  | { readonly kind: "undelivered" }
  | { readonly kind: "delivered"; readonly sentHash?: string }
> {
  const notify = schedule.notify ?? "always";
  const maySend = toolAllowed("messaging.send_to", schedule.autoApproveTools);
  const sends = maySend || notify !== "always" ? await sendsOf(deps, taskId) : undefined;
  if (sends?.delivered === true)
    return { kind: "delivered", ...(sends.deliveredHash === undefined ? {} : { sentHash: sends.deliveredHash }) };
  // A send the connector refused, that failed, or that the policy denied, was something to tell that did not arrive.
  const denied = maySend && deps.inFlight?.sendDenied(taskId) === true;
  const refused = sends !== undefined && (sends.failed || denied);
  if (!refused && notify !== "always") {
    if (sends?.unchanged === true) return { kind: "quiet", unchanged: true };
    if (isNothingToReport(finalText)) return { kind: "quiet", unchanged: false };
    if (notify === "when-sent" && maySend && sends !== undefined && !sends.attempted) return { kind: "quiet", unchanged: false };
    if (
      notify === "if-changed" &&
      schedule.deliverTo === "home" &&
      !(maySend && sends !== undefined && !sends.attempted) &&
      schedule.lastDeliveredHash === sha256Hex(normalisedDelivery(finalText))
    )
      return { kind: "quiet", unchanged: true };
  }
  return maySend && sends !== undefined ? { kind: "undelivered" } : { kind: "delivered" };
}

/**
 * Post the run's result into Home, saying whether it is there, or why not: no Home to post it in (none yet, Home
 * off, or no Home here at all), or a post that failed, which is logged, never the run's failure.
 */
async function postHome(
  schedule: ScheduleRecord,
  admission: AdmissionResult,
  deps: ScheduleSchedulerDependencies,
): Promise<"posted" | "no-home" | "failed"> {
  try {
    return (await deps.deliverHome?.(schedule, admission)) === true ? "posted" : "no-home";
  } catch (error) {
    deps.log({
      level: "warn",
      message: "a schedule's result could not be posted into Home",
      detail: { scheduleId: schedule.scheduleId, taskId: admission.taskId, error },
    });
    return "failed";
  }
}

/**
 * What a completed run's `messaging.send_to` calls came to, or `undefined`
 * with no effect ledger to read.
 *
 * Three things have to be true for the ledger row to mean "the brief arrived",
 * and the first version of this check got each of them wrong:
 *
 * - the effect **state** alone is not delivery: `dispatchTool` resolves
 *   `"accepted"` for any handler that did not throw, so a Mailgun send that
 *   returned `{status: "rejected"}` is `"accepted"` in the ledger. The provider
 *   outcome is in the effect's `receipt`, and that is what has to be read;
 * - an **empty** ledger is the case this check exists for, not an exemption from
 *   it: a run where the model answered without calling any tool never attempted a
 *   send. Reading "no rows" as delivered made the check miss the most common
 *   shape of the very failure it was added for;
 * - but only a schedule that *may* send can fail by not sending. A schedule whose
 *   allowlist excludes `messaging.send_to` is not expected to deliver, and
 *   reporting it as a failed brief would be inventing a failure — so the caller
 *   gates on `toolAllowed` before reading it as one.
 *
 * `attempted` is any call that reached the tool, whatever came of it — a call
 * the policy denied never does. `unchanged` is a send to an `if-changed`
 * schedule's own destination declined as the same as the last result there,
 * `failed` any send that was neither delivered nor declined so, and
 * `deliveredHash` the hash a delivered one carried, which that schedule keeps.
 */
async function sendsOf(
  deps: ScheduleSchedulerDependencies,
  taskId: string,
): Promise<
  | {
      readonly attempted: boolean;
      readonly delivered: boolean;
      readonly unchanged: boolean;
      readonly failed: boolean;
      readonly deliveredHash?: string;
    }
  | undefined
> {
  if (deps.effects === undefined) return undefined;
  let attempted = false;
  let delivered = false;
  let unchanged = false;
  let failed = false;
  let deliveredHash: string | undefined;
  for (const effect of await deps.effects.listForTask(taskId)) {
    if (effect.toolId !== "messaging.send_to") continue;
    attempted = true;
    if (effect.state !== "accepted") {
      failed = true;
      continue;
    }
    // The typed outcome the messaging service returned, stored verbatim as the
    // receipt (`{status, retryable, parts}`); anything else is not a delivery.
    const receipt = effect.receipt as { readonly status?: unknown; readonly deliveryHash?: unknown } | null | undefined;
    if (receipt === null || typeof receipt !== "object") {
      failed = true;
      continue;
    }
    if (receipt.status === "unchanged") unchanged = true;
    if (receipt.status !== "accepted") {
      if (receipt.status !== "unchanged") failed = true;
      continue;
    }
    delivered = true;
    if (typeof receipt.deliveryHash === "string") deliveredHash = receipt.deliveryHash;
  }
  return { attempted, delivered, unchanged, failed, ...(deliveredHash === undefined ? {} : { deliveredHash }) };
}
