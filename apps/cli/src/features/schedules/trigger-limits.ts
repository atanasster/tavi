import {
  SCHEDULE_WEBHOOK_MAX_PER_HOUR,
  SCHEDULE_WEBHOOK_MIN_INTERVAL_MS,
  type ScheduleFireReason,
  type ScheduleRecord,
  type ScheduleRepositoryPort,
} from "@tavi/contracts";

import type { ScheduleFireNow } from "./actions.js";

/**
 * What a schedule's event triggers — its webhook and its email trigger — share:
 * how often they may fire it, and how what they refused is counted in its fire
 * ledger without a word of what was sent.
 */

const HOUR_MS = 3_600_000;
/**
 * A refused event is written to the ledger, and logged, at most this often per schedule; the counts in between are
 * kept for the next write and line.
 */
const REFUSAL_WRITE_EVERY_MS = 5_000;

/** What an event trigger needs from the owner, whatever the event: `Event` is what it hands the run that fires. */
export interface ScheduleTriggerDeps<Event> {
  /** Fires the schedule now, as the event's run, with the run-now in-flight guard. */
  readonly fire: (schedule: ScheduleRecord, event: Event) => Promise<ScheduleFireNow>;
  /** Whether a fire of the schedule — scheduled or manual — is in flight. */
  readonly inFlight: (scheduleId: string) => boolean;
  /** Whether the schedule's owner may still act in its workspace. */
  readonly actsIn?: (workspaceId: string, principalId: string) => boolean;
  /** Whether a routine owns the schedule: a routine fires through its own run action. */
  readonly routineOwned: (scheduleId: string) => Promise<boolean>;
  readonly now: () => string;
  readonly log: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
}

/** At most one fire a minute and twelve an hour per schedule, counted from when each was let through. */
export function createTriggerRateLimit(nowMs: () => number) {
  const accepted = new Map<string, number[]>();
  return {
    /** The milliseconds until the schedule may fire again, or 0 when it may now. */
    wait(scheduleId: string): number {
      const at = nowMs();
      const recent = (accepted.get(scheduleId) ?? []).filter((time) => at - time < HOUR_MS);
      accepted.set(scheduleId, recent);
      const last = recent.at(-1);
      const sinceLast = last === undefined ? Number.POSITIVE_INFINITY : at - last;
      if (sinceLast < SCHEDULE_WEBHOOK_MIN_INTERVAL_MS) return SCHEDULE_WEBHOOK_MIN_INTERVAL_MS - sinceLast;
      if (recent.length >= SCHEDULE_WEBHOOK_MAX_PER_HOUR) return HOUR_MS - (at - recent[0]!);
      return 0;
    },
    /**
     * Counts a fire let through now: before it is awaited, so two at once are one fire. The returned function gives it
     * back, for a fire that started no run.
     */
    take(scheduleId: string): () => void {
      const at = nowMs();
      accepted.set(scheduleId, [...(accepted.get(scheduleId) ?? []), at]);
      let given = false;
      return () => {
        if (given) return;
        given = true;
        const times = accepted.get(scheduleId) ?? [];
        const index = times.lastIndexOf(at);
        if (index !== -1) accepted.set(scheduleId, times.toSpliced(index, 1));
      };
    },
  };
}

/** What a refusal counter needs: where it writes, and what its rows and log lines are called. */
export interface RefusalCounterOptions {
  readonly schedules: Pick<ScheduleRepositoryPort, "recordFire">;
  readonly reasonCode: Extract<ScheduleFireReason, "webhook-refused" | "email-refused">;
  /** What refused, as a row starts: `webhook`, `email trigger`. */
  readonly label: string;
  /** What it refused, singular and plural: `call`/`calls`. */
  readonly noun: readonly [string, string];
  /**
   * The log line for refusals, at most one every few seconds per schedule; its fields are the schedule, the cause, and
   * how many were refused since the last line (`refused`, when more than one) — never what was sent.
   */
  readonly logMessage: string;
  readonly nowMs: () => number;
  readonly now: () => string;
  readonly log: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
}

/**
 * Counts a refused event in its schedule's row for the hour (one row an hour kept current, written at most every five
 * seconds), and logs it — at most a line every five seconds, so a client hammering a webhook cannot flood the log.
 * Never a header, a body or an address.
 */
export function createRefusalCounter<Cause extends string>(
  options: RefusalCounterOptions,
): (schedule: Pick<ScheduleRecord, "scheduleId">, cause: Cause) => Promise<void> {
  const refusals = new Map<string, { hour: number; counts: Map<Cause, number>; writtenAt?: number }>();
  const logged = new Map<string, { at: number; since: number }>();
  return async (schedule, cause) => {
    const at = options.nowMs();
    const lines = logged.get(schedule.scheduleId);
    if (lines === undefined || at - lines.at >= REFUSAL_WRITE_EVERY_MS) {
      const refused = (lines?.since ?? 0) + 1;
      options.log("warn", options.logMessage, { scheduleId: schedule.scheduleId, cause, ...(refused > 1 ? { refused } : {}) });
      logged.set(schedule.scheduleId, { at, since: 0 });
    } else {
      lines.since += 1;
    }
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    let bucket = refusals.get(schedule.scheduleId);
    if (bucket === undefined || bucket.hour !== hour) {
      bucket = { hour, counts: new Map() };
      refusals.set(schedule.scheduleId, bucket);
    }
    bucket.counts.set(cause, (bucket.counts.get(cause) ?? 0) + 1);
    if (bucket.writtenAt !== undefined && at - bucket.writtenAt < REFUSAL_WRITE_EVERY_MS) return;
    bucket.writtenAt = at;
    const total = [...bucket.counts.values()].reduce((sum, count) => sum + count, 0);
    const causes = [...bucket.counts].map(([name, count]) => `${count} ${name}`).join(", ");
    try {
      await options.schedules.recordFire({
        scheduleId: schedule.scheduleId,
        taskId: null,
        outcome: `${options.label} refused ${total} ${total === 1 ? options.noun[0] : options.noun[1]} this hour (${causes})`,
        outcomeKind: "skipped",
        fire: { fireTime: new Date(hour).toISOString(), reasonCode: options.reasonCode },
        now: options.now(),
      });
    } catch (error) {
      options.log("warn", `a refused ${options.label} ${options.noun[0]} could not be recorded`, {
        scheduleId: schedule.scheduleId,
        error: String(error),
      });
    }
  };
}
