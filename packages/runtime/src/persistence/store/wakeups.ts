import { REMINDER_CLAIM_LEASE_MS } from "@tavi/contracts";
import type { StoreContext } from "./context.js";

/**
 * When each of the owner's due-work sweeps next has something to do, read in
 * one statement so the owner can sleep until then instead of sweeping on a
 * timer. Each is the earliest instant one of that sweep's own queries would
 * find a row, or `null` with none. Work a sweep retries for as long as it fails
 * (an announcement that did not go out, a routine's bookkeeping) is due `now`:
 * the caller spaces those sweeps as the timer used to.
 *
 * The predicates mirror the sweeps' queries: `claimDue` for reminders,
 * `listDue` for schedules, and for the routine bookkeeping the schedule sweep
 * runs: a routine to keep alive, a delivery to make or expire (`delivery.ts`),
 * a queued run `pending` would drain or one whose queue time or deadline
 * lapses, a pause or expiry notice owed (`pendingPauses`), and an evaluation
 * still pending (`routine.quality.pending`, retried until its setup is fixed),
 * `listActivePastDeadline` and `listPendingResumes` for agent waits,
 * `listExpired`, `listUnannounced`, `listUnnotified` and `takeExpiredReasons`
 * for approval rounds, and `listDue` for heartbeats. A predicate missing here
 * would leave its work to the sweep's slow fallback timer, so a change to one
 * of those queries changes this one too.
 */
export interface NextWakeups {
  readonly reminders: string | null;
  readonly schedules: string | null;
  readonly agentWaits: string | null;
  readonly approvals: string | null;
  readonly heartbeats: string | null;
}

export interface NextWakeupsInput {
  readonly now: string;
  /** How long a settled wait's resume may stay unadmitted before the sweep admits it. */
  readonly resumeGraceMs: number;
  /** How far back a settled round's unsent notice is still retried. */
  readonly notifyWindowMs: number;
}

interface WakeupRow {
  readonly reminder_next: string | null;
  readonly reminder_retry: string | null;
  readonly reminder_claimed: string | null;
  readonly schedule_next: string | null;
  readonly routine_busy: number;
  readonly delivery_next: string | null;
  readonly delivery_expiry: string | null;
  readonly run_queue_expiry: string | null;
  readonly run_deadline: string | null;
  readonly wait_deadline: string | null;
  readonly wait_settled: string | null;
  readonly round_expiry: string | null;
  readonly reason_expiry: string | null;
  readonly round_retry: number;
  readonly heartbeat_next: string | null;
}

export function nextWakeups(store: StoreContext, input: NextWakeupsInput): NextWakeups {
  const nowMs = Date.parse(input.now);
  const notifySince = new Date(nowMs - input.notifyWindowMs).toISOString();
  const row = store.handle
    .prepare(
      `SELECT
        (SELECT min(next_fire_at) FROM tavi_reminders WHERE status = 'active' AND next_fire_at IS NOT NULL) AS reminder_next,
        (SELECT min(f.retry_at) FROM tavi_reminder_fires f JOIN tavi_reminders r ON r.reminder_id = f.reminder_id
          WHERE f.outcome = 'pending' AND f.retry_at IS NOT NULL AND r.status IN ('active', 'done')
          AND NOT (r.kind = 'todo' AND r.todo_status = 'done')) AS reminder_retry,
        (SELECT min(f.fired_at) FROM tavi_reminder_fires f JOIN tavi_reminders r ON r.reminder_id = f.reminder_id
          WHERE f.outcome = 'pending' AND f.fired_at IS NOT NULL AND f.retry_at IS NULL AND r.status IN ('active', 'done')
          AND NOT (r.kind = 'todo' AND r.todo_status = 'done')) AS reminder_claimed,
        (SELECT min(next_run_at) FROM tavi_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL) AS schedule_next,
        (EXISTS (SELECT 1 FROM tavi_routines WHERE status IN ('active', 'credential-blocked'))
          OR EXISTS (SELECT 1 FROM tavi_routine_delivery_jobs WHERE status IN ('dispatching', 'uncertain'))
          OR EXISTS (SELECT 1 FROM tavi_routine_state WHERE json_extract(state_json, '$.pendingAutoPause') IS NOT NULL
            OR json_extract(state_json, '$.pendingExpiry') IS NOT NULL)
          OR EXISTS (SELECT 1 FROM tavi_routine_evaluations e JOIN tavi_routines r ON r.routine_id = e.routine_id
            WHERE e.status = 'pending' AND e.revision = r.latest_revision AND r.status <> 'archived')
          OR EXISTS (SELECT 1 FROM tavi_routine_runs r JOIN tavi_routines a ON a.routine_id = r.routine_id
            WHERE r.status IN ('queued', 'interrupted') AND (r.mode = 'preview' OR a.status NOT IN ('paused', 'paused-failures')))) AS routine_busy,
        (SELECT min(not_before) FROM tavi_routine_delivery_jobs WHERE status IN ('pending', 'deferred')) AS delivery_next,
        (SELECT min(expires_at) FROM tavi_routine_delivery_jobs WHERE status IN ('pending', 'deferred')) AS delivery_expiry,
        (SELECT min(json_extract(data_json, '$.queueExpiresAt')) FROM tavi_routine_runs WHERE status IN ('queued', 'interrupted')) AS run_queue_expiry,
        (SELECT min(json_extract(data_json, '$.deadline')) FROM tavi_routine_runs WHERE status IN ('queued', 'interrupted')) AS run_deadline,
        (SELECT min(deadline_at) FROM tavi_agent_wait_intents WHERE state = 'active') AS wait_deadline,
        (SELECT min(settled_at) FROM tavi_agent_wait_intents WHERE resume_pending = 1 AND state = 'settled') AS wait_settled,
        (SELECT min(r.expires_at) FROM tavi_approval_rounds r WHERE r.settled_at IS NULL AND r.expires_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced')) AS round_expiry,
        (SELECT min(expires_at) FROM tavi_pending_reject_reasons) AS reason_expiry,
        (EXISTS (SELECT 1 FROM tavi_approval_rounds r WHERE r.settled_at IS NULL AND r.connection_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announce_failed')
            AND NOT EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced'))
          OR EXISTS (SELECT 1 FROM tavi_approval_rounds r WHERE r.settled_at IS NOT NULL AND r.settled_at > ? AND r.connection_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'announced')
            AND EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind IN ('settled', 'expired'))
            AND NOT EXISTS (SELECT 1 FROM tavi_approval_events e WHERE e.task_id = r.task_id AND e.steps = r.steps AND e.kind = 'notified'))) AS round_retry,
        (SELECT min(next_tick_at) FROM tavi_heartbeats WHERE enabled = 1 AND next_tick_at IS NOT NULL) AS heartbeat_next`,
    )
    .get(notifySince) as WakeupRow;
  const plus = (at: string | null, ms: number): string | null => (at === null ? null : new Date(Date.parse(at) + ms).toISOString());
  return {
    reminders: earliest(row.reminder_next, row.reminder_retry, plus(row.reminder_claimed, REMINDER_CLAIM_LEASE_MS)),
    schedules: earliest(
      row.schedule_next,
      row.delivery_next,
      row.delivery_expiry,
      row.run_queue_expiry,
      row.run_deadline,
      row.routine_busy === 1 ? input.now : null,
    ),
    agentWaits: earliest(row.wait_deadline, plus(row.wait_settled, input.resumeGraceMs)),
    approvals: earliest(row.round_expiry, row.reason_expiry, row.round_retry === 1 ? input.now : null),
    heartbeats: row.heartbeat_next,
  };
}

/** The earliest of ISO-8601 instants, compared as instants (stored values may differ in precision). */
function earliest(...values: readonly (string | null)[]): string | null {
  let best: { at: string; ms: number } | undefined;
  for (const at of values) {
    if (at === null) continue;
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) continue;
    if (best === undefined || ms < best.ms) best = { at, ms };
  }
  return best?.at ?? null;
}
