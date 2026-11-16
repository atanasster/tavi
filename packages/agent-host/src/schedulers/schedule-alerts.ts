import { SCHEDULE_PAUSE_AFTER_FAILURES, type ScheduleRecord } from "@tavi/contracts";

import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";

export type ScheduleAlertKind =
  | "spec-disabled"
  | "disk-low"
  | "stale-dispatch"
  | "missed-run"
  | "start-failed"
  | "run-outcome"
  | "run-undelivered"
  /** A run worked past its schedule's `maxRunMinutes` and was stopped. */
  | "run-timeout"
  /** A run used more tokens than its schedule's `maxTokens` and was stopped. */
  | "run-budget"
  /** A fire was skipped because the previous run was still going. */
  | "overlap"
  | "fire-threw"
  /** A fire's round was decided by another front end first; the task started and is not this fire's to finish. */
  | "round-decided-elsewhere"
  /** A tool list saved before scheduling tools were refused names one, and a fire was denied its call. */
  | "scheduling-refused"
  /** The schedule was paused because its runs failed `SCHEDULE_PAUSE_AFTER_FAILURES` times in a row. */
  | "paused"
  /** A fire's pre-check could not be made, so it did not run; told once until a check works again. */
  | "precheck-failed"
  /** A file watcher's changes ran it `SCHEDULE_WATCH_MAX_RUNS_IN_A_ROW` times in a row, so only its cadence checks for a while. */
  | "watch-backoff";

/**
 * Send one failure/miss alert: to the schedule's alert target, or, with none —
 * or when the target refuses it or cannot be reached — into its person's Home,
 * except a round decided elsewhere, which stays in the log.
 *
 * The effect id is derived from `(schedule, identity, kind)`. `identity` is the
 * alert's dedupe identity: the scheduled fire pointer for an automatic fire, and
 * the run's own nonce for a manual `run-now` (the wall clock is not unique — two
 * manual runs in one millisecond, or a coarse injected clock, would otherwise
 * share an id and the second alert would be swallowed, which is the same bug
 * this key shape exists to fix).
 *
 * Keying on `kind` as well matters because **one fire can raise several alerts**:
 * a stale-dispatch notice and the failure of the catch-up run it preceded, or a
 * stale-dispatch notice and a missed-run notice. The messaging outbox treats a
 * repeated effect id as a replay and returns the stored outcome without calling
 * the connector, so an identity-only key silently dropped the second — the
 * "silence at 07:00" the alerts exist to prevent.
 *
 * The object parameter is deliberate: `kind` and `text` are both strings, so
 * positional arguments would let a caller swap them into a plausible-but-wrong
 * key without the compiler noticing.
 */
export async function sendAlert(
  schedule: ScheduleRecord,
  alert: { readonly identity: string; readonly kind: ScheduleAlertKind; readonly text: string; readonly homeText?: string },
  deps: ScheduleSchedulerDependencies,
): Promise<void> {
  const effectId = `schedule-alert:${schedule.scheduleId}:${alert.identity}:${alert.kind}`;
  const target = schedule.alert;
  if (target === undefined || deps.messaging === undefined) {
    await alertInHome(schedule, alert, effectId, deps, "schedule alert had nowhere to go");
    return;
  }
  try {
    const outcome = await deps.messaging.send({
      effectId,
      connectionId: target.connectionId,
      workspaceId: schedule.workspaceId,
      destination: { chatId: target.destination },
      parts: [{ content: alert.text }],
    });
    // A provider *refusal* is a return value, not a throw, and the outbox stores
    // it as a resolved row: the next sweep replays that outcome without calling
    // the connector, so an unchecked refusal is a permanently silent alert — the
    // opposite of what it exists for. Reported here at error
    // level; the alert's dedupe identity is deliberately not varied, because a
    // retry with a new id would re-send duplicates on the success path.
    if (outcome.status !== "accepted") {
      deps.log({
        level: "error",
        message: "schedule alert was not accepted by the connector and will not be retried",
        detail: { scheduleId: schedule.scheduleId, kind: alert.kind, status: outcome.status, retryable: outcome.retryable },
      });
      // A target whose connection was removed or whose token expired refuses every alert from then on, the one
      // saying the schedule was paused included: Home is told instead, once per cause as the send would have been.
      await alertInHome(schedule, alert, effectId, deps, "schedule alert was refused by its target and had nowhere else to go");
    }
  } catch (error) {
    // An alert failure must never mask the original failure or abort the sweep;
    // it is logged, which is the best available signal if the very channel the
    // operator would be told on is the thing that is broken — and Home is told instead.
    deps.log({ level: "error", message: "schedule failure alert could not be sent", detail: { scheduleId: schedule.scheduleId, error } });
    await alertInHome(schedule, alert, effectId, deps, "schedule alert could not be sent and had nowhere else to go");
  }
}

/**
 * Post an alert into its schedule's person's Home, keyed as its send (`effectId`) so it is told once per cause
 * however often it is raised — except a round decided elsewhere, which stays in the log. `homeText`, when given, is
 * what Home reads instead: a run's own words carry no label there. Never throws; `nowhere` is logged when Home did
 * not take it.
 */
async function alertInHome(
  schedule: ScheduleRecord,
  alert: { readonly kind: ScheduleAlertKind; readonly text: string; readonly homeText?: string },
  effectId: string,
  deps: ScheduleSchedulerDependencies,
  nowhere: string,
): Promise<void> {
  // A round the person decided themselves is not news to them: it stays in
  // the run history and the log.
  if (alert.kind === "round-decided-elsewhere") return;
  try {
    const posted = (await deps.alertHome?.(schedule, { sourceKey: effectId, text: alert.homeText ?? alert.text })) === true;
    if (!posted) deps.log({ level: "warn", message: nowhere, detail: { scheduleId: schedule.scheduleId, kind: alert.kind } });
  } catch (error) {
    deps.log({
      level: "error",
      message: "schedule alert could not be posted to Home",
      detail: { scheduleId: schedule.scheduleId, error },
    });
  }
}

/**
 * Pauses a schedule whose fires failed `SCHEDULE_PAUSE_AFTER_FAILURES` times
 * in a row, after the record of the failure that made it so, and tells its
 * person once, saying how to resume it. A schedule already paused, or failing
 * fewer times, is left as it is.
 */
export async function pauseIfFailing(
  schedule: ScheduleRecord,
  fire: { readonly fireTime: string; readonly alertIdentity: string },
  deps: ScheduleSchedulerDependencies,
): Promise<void> {
  const failures = SCHEDULE_PAUSE_AFTER_FAILURES;
  const paused = await deps.schedules.pauseForFailures({
    scheduleId: schedule.scheduleId,
    failures,
    fireTime: fire.fireTime,
    outcome: `paused: ${failures} failed runs in a row`,
    now: deps.now(),
  });
  if (!paused) return;
  deps.log({ level: "warn", message: "schedule paused after failed runs", detail: { scheduleId: schedule.scheduleId, failures } });
  await sendAlert(
    schedule,
    {
      identity: fire.alertIdentity,
      kind: "paused",
      text: `Schedule "${schedule.name}" was paused: its last ${failures} runs failed, so it will not run again until it is resumed. Resume it from its page, by asking in chat, or with \`tavi schedules enable ${schedule.name}\`.`,
    },
    deps,
  );
}
