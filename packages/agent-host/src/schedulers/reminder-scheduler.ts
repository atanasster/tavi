import {
  reminderRetryDecision,
  type ClaimedReminderFire,
  type ReminderDeliveryOutcome,
  type ReminderDeliveryPort,
  type ReminderRepositoryPort,
} from "@tavi/contracts";

import { type RepeatTimer, startSweepLoop } from "./sweep-loop.js";

/**
 * The reminder scheduler.
 *
 * It lives inside the owner beside `tavi.schedules`, for the same reason: the
 * owner holds the data directory, so only it can claim fires. Each tick
 * claims the due fires in one store transaction (`claimDue` — exactly once
 * per occurrence, with the missed-fire rule applied there), hands each to the
 * delivery port, and records the outcome.
 *
 * The scheduler decides nothing about *how* a reminder is said: that is the
 * `ReminderDeliveryPort`'s. The app wires the router to the chat (Done/Snooze
 * buttons, retry, in-app fallback) and the optional task start.
 *
 * A text-only reminder makes no model call, so this runs whether or not the
 * owner has a model connection.
 */

export interface ReminderSchedulerDependencies {
  readonly reminders: Pick<ReminderRepositoryPort, "claimDue" | "recordOutcome">;
  readonly delivery: ReminderDeliveryPort;
  readonly now: () => string;
  readonly log: (event: { readonly level: "info" | "warn" | "error"; readonly message: string; readonly detail?: unknown }) => void;
  /** How long one delivery may take before it is retried; `REMINDER_DELIVERY_TIMEOUT_MS` when absent. */
  readonly deliveryTimeoutMs?: number;
}

export interface SweepRemindersResult {
  readonly delivered: readonly {
    readonly reminderId: string;
    readonly fireAt: string;
    readonly outcome: ReminderDeliveryOutcome;
    readonly late: boolean;
  }[];
  /** Occurrences recorded as missed (too late to deliver). */
  readonly missed: number;
}

/** Fires claimed in one sweep; the rest wait for the next tick. */
export const REMINDER_SWEEP_LIMIT = 50;

/**
 * How long one delivery may take. Well under `REMINDER_CLAIM_LEASE_MS`, so a
 * fire is settled before its claim could be taken again, and a delivery that
 * never settles cannot hold every other reminder, or shutdown, behind it.
 */
export const REMINDER_DELIVERY_TIMEOUT_MS = 60_000;

/** `promise`, or a rejection once `ms` pass; the timer never keeps the process alive. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reminder delivery took longer than ${ms} ms`)), ms);
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Deliver one claimed fire and record what happened. A port that throws, or
 * does not answer within the delivery timeout, is recorded rather than
 * propagated — one broken reminder must not stop the others in the sweep —
 * and treated as a refused delivery: retried with backoff inside the retry
 * window, then shown in the app, so the reminder is never lost. (The port
 * sends a retry under the same outbox effect when the earlier attempt's
 * result is unknown, so a timed-out send is not repeated.)
 */
export async function deliverReminderFire(
  claimed: ClaimedReminderFire,
  deps: ReminderSchedulerDependencies,
): Promise<{ readonly outcome: ReminderDeliveryOutcome }> {
  const { reminder, fire, late } = claimed;
  let outcome: ReminderDeliveryOutcome;
  let taskId: string | undefined;
  let retryAt: string | undefined;
  try {
    const result = await withTimeout(
      deps.delivery.deliver({ reminder, fire, late }),
      deps.deliveryTimeoutMs ?? REMINDER_DELIVERY_TIMEOUT_MS,
    );
    outcome = result.outcome;
    taskId = result.taskId;
    retryAt = result.retryAt;
  } catch (error) {
    deps.log({
      level: "error",
      message: "reminder delivery threw",
      detail: { reminderId: reminder.reminderId, fireAt: fire.fireAt, error },
    });
    const decision = reminderRetryDecision(fire, Date.parse(deps.now()));
    outcome = decision.outcome;
    retryAt = decision.outcome === "retry" ? decision.retryAt : undefined;
  }
  try {
    const recorded = await deps.reminders.recordOutcome({
      reminderId: reminder.reminderId,
      fireAt: fire.fireAt,
      outcome,
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(taskId === undefined ? {} : { taskId }),
      now: deps.now(),
    });
    if (!recorded) {
      // Another claim of the same fire recorded first (a lease that ran out
      // mid-delivery); the fire is settled either way.
      deps.log({
        level: "warn",
        message: "reminder fire was already settled",
        detail: { reminderId: reminder.reminderId, fireAt: fire.fireAt },
      });
    }
  } catch (error) {
    // The fire stays claimed and is claimed again after its lease.
    deps.log({
      level: "error",
      message: "reminder outcome could not be recorded",
      detail: { reminderId: reminder.reminderId, fireAt: fire.fireAt, error },
    });
  }
  return { outcome };
}

/**
 * One pass: claim what is due, deliver each fire in turn, record each outcome.
 * Once `stopping()` answers true the rest of the claimed fires are left
 * claimed; they are claimed again after their lease.
 */
export async function sweepReminders(
  deps: ReminderSchedulerDependencies,
  limit = REMINDER_SWEEP_LIMIT,
  stopping: () => boolean = () => false,
): Promise<SweepRemindersResult> {
  const { claimed, missed } = await deps.reminders.claimDue({ now: deps.now(), limit });
  if (missed > 0) deps.log({ level: "warn", message: "reminder fires were missed while the owner was not running", detail: { missed } });
  const delivered: { reminderId: string; fireAt: string; outcome: ReminderDeliveryOutcome; late: boolean }[] = [];
  for (const entry of claimed) {
    if (stopping()) break;
    const { outcome } = await deliverReminderFire(entry, deps);
    delivered.push({ reminderId: entry.reminder.reminderId, fireAt: entry.fire.fireAt, outcome, late: entry.late });
  }
  return { delivered, missed };
}

export interface ReminderSchedulerHandle {
  /** Stops future sweeps and waits for the delivery in progress, at most the delivery timeout. Idempotent. */
  stop(): Promise<void>;
  /** Sweep now rather than at the next tick; joins a sweep already running. */
  sweep(): Promise<SweepRemindersResult | undefined>;
}

export interface StartReminderSchedulerOptions extends ReminderSchedulerDependencies {
  readonly intervalMs: number;
  /** What runs the interval; absent, `setInterval`. */
  readonly every?: RepeatTimer;
  readonly onSwept?: (result: SweepRemindersResult) => void;
}

/**
 * Interval wrapper around `sweepReminders`, on the same single-flight loop as
 * the schedule scheduler: sweeps never overlap, and the first runs at once, so
 * fires due while the owner was stopped are delivered (late) or recorded missed
 * on start.
 */
export function startReminderScheduler(options: StartReminderSchedulerOptions): ReminderSchedulerHandle {
  return startSweepLoop({
    intervalMs: options.intervalMs,
    ...(options.every === undefined ? {} : { every: options.every }),
    run: (stopping) => sweepReminders(options, REMINDER_SWEEP_LIMIT, stopping),
    onSwept: (result) => options.onSwept?.(result),
    onError: (error) => options.log({ level: "error", message: "reminder sweep failed", detail: { error } }),
  });
}

/**
 * The in-app delivery: every fire is delivered in the app — the Center's
 * badge and rail read unacknowledged `delivered-in-app` fires.
 */
export const inAppReminderDelivery: ReminderDeliveryPort = {
  deliver: () => Promise.resolve({ outcome: "delivered-in-app" }),
};
