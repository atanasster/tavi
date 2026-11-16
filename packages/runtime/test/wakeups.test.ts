import { REMINDER_CLAIM_LEASE_MS } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/**
 * `nextWakeups`: when each due-work sweep next has something to do, so an idle
 * owner sleeps until then. Each answer must be the instant the sweep's own
 * query would first find the row.
 */

const NOW = "2026-10-01T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const input = (now: string) => ({ now, resumeGraceMs: 30_000, notifyWindowMs: 24 * 60 * 60_000 });

describe("nextWakeups", () => {
  it("is null for every sweep with nothing stored", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      expect(store.nextWakeups(input(NOW))).toEqual({
        reminders: null,
        schedules: null,
        agentWaits: null,
        approvals: null,
        heartbeats: null,
      });
    } finally {
      store.close();
    }
  });

  it("follows a reminder from its fire, through a claim whose outcome is owed, to its delivery", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const reminders = store.asPort().repositories.reminders;
    try {
      const { reminder } = reminders.create({
        reminderId: "rem-1",
        workspaceId: "default",
        principalId: "operator",
        text: "Call the dentist",
        when: { kind: "once", at: at(30) },
        timezone: "UTC",
        deliverTo: { kind: "app" },
        createdBy: "user",
        operationKey: "op-1",
        now: NOW,
      });
      expect(store.nextWakeups(input(NOW)).reminders).toBe(at(30));

      // Claimed, with no outcome yet: due again once the claim's lease ends (the owner stopped mid-delivery).
      const { claimed } = reminders.claimDue({ now: at(30), limit: 50 });
      expect(claimed).toHaveLength(1);
      expect(Date.parse(store.nextWakeups(input(at(30))).reminders ?? "")).toBe(Date.parse(at(30)) + REMINDER_CLAIM_LEASE_MS);

      reminders.recordOutcome({ reminderId: reminder.reminderId, fireAt: at(30), outcome: "delivered-in-app", now: at(30) });
      expect(store.nextWakeups(input(at(30))).reminders).toBeNull();
    } finally {
      store.close();
    }
  });

  /**
   * Random rows for every sweep but the reminders' (whose claim is covered
   * above): wherever a sweep's own query would act at an instant `t` from now
   * on, `nextWakeups` answers `t` or earlier. A predicate that missed a row
   * would leave that work to the slow fallback timer.
   */
  it("never answers later than a sweep's own query would first act", () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    const someTime = (): string => at(Math.round((random() - 0.5) * 240));
    const maybe = (value: string): string | null => (random() < 0.2 ? null : value);
    const window = input(NOW);
    for (let round = 0; round < 40; round += 1) {
      const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
      try {
        const db = store.handle;
        // Rows only, so the tasks and connections they name need not exist.
        db.pragma("foreign_keys = OFF");
        const probes = new Set<string>([NOW]);
        const probe = (value: string | null): void => {
          if (value === null) return;
          const ms = Date.parse(value);
          for (const offset of [-1, 0, 1, window.resumeGraceMs, window.resumeGraceMs + 1])
            if (ms + offset >= Date.parse(NOW)) probes.add(new Date(ms + offset).toISOString());
        };
        for (let index = 0; index < 6; index += 1) {
          const next = maybe(someTime());
          probe(next);
          db.prepare(
            `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
              auto_approve_tools_json, enabled, next_run_at, created_at, updated_at)
             VALUES (?, 'default', 'operator', ?, 'p', '{}', 'skip', '[]', ?, ?, ?, ?)`,
          ).run(`sch-${index}`, `s${index}`, random() < 0.7 ? 1 : 0, next, NOW, NOW);
          const tick = maybe(someTime());
          probe(tick);
          db.prepare(
            `INSERT INTO tavi_heartbeats (workspace_id, principal_id, enabled, config_json, next_tick_at, created_at, updated_at)
             VALUES ('default', ?, ?, '{}', ?, ?, ?)`,
          ).run(`p-${index}`, random() < 0.7 ? 1 : 0, tick, NOW, NOW);
          const deadline = someTime();
          const settled = someTime();
          probe(deadline);
          probe(settled);
          db.prepare(
            `INSERT INTO tavi_agent_wait_intents (wait_id, task_id, deadline_at, state, settled_at, resume_pending)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(`wait-${index}`, `task-${index}`, deadline, pick(["active", "settled", "prepared"]), settled, random() < 0.5 ? 1 : 0);
          const expires = maybe(someTime());
          const settledAt = random() < 0.5 ? someTime() : null;
          probe(expires);
          db.prepare(
            `INSERT INTO tavi_approval_rounds (task_id, steps, token, workspace_id, connection_id, message_ids_json, expires_at, settled_at, created_at)
             VALUES (?, 1, ?, 'default', ?, '[]', ?, ?, ?)`,
          ).run(`round-${index}`, `abcdefg${"hjkmnp"[index]}`, random() < 0.7 ? "conn" : null, expires, settledAt, NOW);
          for (const kind of ["announced", "announce_failed", "settled", "expired", "notified"])
            if (random() < 0.4)
              db.prepare("INSERT INTO tavi_approval_events (task_id, steps, kind, at) VALUES (?, 1, ?, ?)").run(
                `round-${index}`,
                kind,
                NOW,
              );
          const reason = someTime();
          probe(reason);
          db.prepare(
            `INSERT INTO tavi_pending_reject_reasons (reason_key, token, workspace_id, principal_id, caller, reply_target_json, expires_at)
             VALUES (?, ?, 'default', 'operator', 'c', '{"connectionId":"conn","externalConversationId":"chat","externalSenderId":"sender"}', ?)`,
          ).run(`reason-${index}`, `abcdefg${"hjkmnp"[index]}`, reason);
        }
        const answer = store.nextWakeups(window);
        const repositories = store.asPort().repositories;
        const acts: Record<keyof typeof answer, (t: string) => boolean> = {
          reminders: () => false,
          schedules: (t) => {
            const listed = repositories.schedules.listDue(t, 50);
            return listed.due.length + listed.unreadable.length > 0;
          },
          heartbeats: (t) => {
            const listed = repositories.heartbeats.listDue(t, 50);
            return listed.due.length + listed.unreadable.length > 0;
          },
          agentWaits: (t) =>
            repositories.agentWaits.listActivePastDeadline(t).length > 0 ||
            repositories.agentWaits.listPendingResumes(new Date(Date.parse(t) - window.resumeGraceMs).toISOString()).length > 0,
          approvals: (t) => {
            db.exec("BEGIN");
            try {
              if (repositories.needDeliveries.takeExpiredReasons(t).length > 0) return true;
            } finally {
              db.exec("ROLLBACK");
            }
            return (
              repositories.approvalRounds.listExpired(t, 50).length > 0 ||
              repositories.approvalRounds.listUnannounced(50).length > 0 ||
              repositories.approvalRounds.listUnnotified(new Date(Date.parse(t) - window.notifyWindowMs).toISOString(), 50).length > 0
            );
          },
        };
        for (const kind of Object.keys(acts) as (keyof typeof answer)[]) {
          const first = [...probes].sort().find((t) => acts[kind](t));
          if (first === undefined) continue;
          const planned = answer[kind];
          expect(planned, `${kind} in round ${round}`).not.toBeNull();
          expect(Date.parse(planned ?? ""), `${kind} in round ${round}`).toBeLessThanOrEqual(Date.parse(first));
        }
      } finally {
        store.close();
      }
    }
  });

  it("keeps the schedule sweep due for the routine bookkeeping it runs", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const db = store.handle;
      db.pragma("foreign_keys = OFF");
      const routine = (id: string, status: string): void => {
        db.prepare(
          `INSERT INTO tavi_routines (routine_id, workspace_id, principal_id, name, version, latest_revision, status, created_at, updated_at)
           VALUES (?, 'default', 'operator', ?, 1, 1, ?, ?, ?)`,
        ).run(id, id, status, NOW, NOW);
      };
      routine("rt-paused", "paused");
      expect(store.nextWakeups(input(NOW)).schedules).toBeNull();

      // A queued run of a paused routine, drained when its queue time lapses.
      db.prepare(
        `INSERT INTO tavi_routine_runs (run_id, routine_id, workspace_id, principal_id, occurrence_key, revision, snapshot_json, mode, status, claimed_at, data_json)
         VALUES ('run-1', 'rt-paused', 'default', 'operator', 'o1', 1, '{}', 'production', 'queued', ?, ?)`,
      ).run(NOW, JSON.stringify({ queueExpiresAt: at(20) }));
      expect(store.nextWakeups(input(NOW)).schedules).toBe(at(20));

      // A pause notice not yet told: owed now.
      db.prepare("INSERT INTO tavi_routine_state (routine_id, version, state_json) VALUES ('rt-paused', 1, ?)").run(
        JSON.stringify({ pendingAutoPause: "run-1" }),
      );
      expect(store.nextWakeups(input(NOW)).schedules).toBe(NOW);
      db.prepare("UPDATE tavi_routine_state SET state_json = '{}'").run();

      // An evaluation waiting on its setup is tried at each sweep.
      routine("rt-draft", "setup-needed");
      db.prepare(
        "INSERT INTO tavi_routine_evaluations (evaluation_id, routine_id, revision, status, detail, created_at) VALUES ('ev-1', 'rt-draft', 1, 'pending', '', ?)",
      ).run(NOW);
      expect(store.nextWakeups(input(NOW)).schedules).toBe(NOW);
    } finally {
      store.close();
    }
  });
});
