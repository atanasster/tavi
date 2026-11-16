import { join } from "node:path";
import Database from "better-sqlite3";
import {
  SCHEDULE_FIRE_REASONS,
  SCHEDULE_FIRES_KEPT,
  SCHEDULE_REFUSALS_KEPT,
  scheduledMonthWindow,
  scheduledWorkText,
  scheduledWorkUsage,
} from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";

/** A schedule's fire ledger: each fire with why it ended so, bounded per schedule and removed with it. */

const directories = temporaryDirectories({ prefix: "tavi-schedule-fires-" });
afterEach(() => directories.cleanup());

const NOW = "2026-10-02T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const base = {
  workspaceId: "default",
  principalId: "operator",
  prompt: "Write the brief",
  spec: { at: "07:00", timezone: "UTC" },
  missedRunPolicy: "skip" as const,
  autoApproveTools: [],
  enabled: true,
  nextRunAt: NOW,
  now: NOW,
};

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const schedules = store.asPort().repositories.schedules;
  schedules.create({ ...base, scheduleId: "s-1", name: "Brief" });
  return { store, schedules };
}

describe("the schedule fire ledger", () => {
  it("records each reason with its run, newest first, and a skip that keeps the marker without touching the row", () => {
    const { store, schedules } = fixture();
    try {
      SCHEDULE_FIRE_REASONS.forEach((reasonCode, index) => {
        schedules.recordRun({
          scheduleId: "s-1",
          taskId: reasonCode === "ok" ? "task-ok" : null,
          outcome: `${reasonCode} outcome`,
          outcomeKind: reasonCode === "ok" ? "succeeded" : reasonCode === "failed" ? "failed" : "skipped",
          fire: { fireTime: at(index), reasonCode },
          now: at(index),
        });
      });
      const fires = schedules.listFires("s-1", 100);
      expect(fires.map((fire) => fire.reasonCode)).toEqual([...SCHEDULE_FIRE_REASONS].reverse());
      expect(fires.at(-1)).toEqual({
        scheduleId: "s-1",
        fireTime: NOW,
        outcomeKind: "succeeded",
        outcome: "ok outcome",
        reasonCode: "ok",
        taskId: "task-ok",
        at: NOW,
      });
      expect(schedules.listFires("s-1", 2)).toHaveLength(2);

      // A run in flight's dispatch marker stays: the overlap skip goes to the ledger alone.
      schedules.markRunning({
        scheduleId: "s-1",
        taskId: "task-2",
        fireTime: at(SCHEDULE_FIRE_REASONS.length + 0),
        now: at(SCHEDULE_FIRE_REASONS.length + 0),
      });
      const marked = schedules.get("s-1");
      schedules.recordFire({
        scheduleId: "s-1",
        taskId: null,
        outcome: "skipped: the previous run is still in flight",
        outcomeKind: "skipped",
        fire: { fireTime: at(SCHEDULE_FIRE_REASONS.length + 1), reasonCode: "overlap" },
        now: at(SCHEDULE_FIRE_REASONS.length + 1),
      });
      expect(schedules.get("s-1")).toEqual(marked);
      expect(schedules.listFires("s-1", 1)[0]).toMatchObject({ fireTime: at(SCHEDULE_FIRE_REASONS.length + 1), reasonCode: "overlap" });

      // A run recorded without a fire (a routine's) adds nothing.
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: "task-3",
        outcome: "completed",
        outcomeKind: "succeeded",
        now: at(SCHEDULE_FIRE_REASONS.length + 2),
      });
      expect(schedules.listFires("s-1", 100)).toHaveLength(SCHEDULE_FIRE_REASONS.length + 1);
    } finally {
      store.close();
    }
  });

  it("moves the last run for a run asked for now, leaving the outcome and the task the scheduler reads", () => {
    const { store, schedules } = fixture();
    try {
      schedules.markRunning({ scheduleId: "s-1", taskId: "task-now", fireTime: at(5), now: at(5), manual: true });
      expect(schedules.get("s-1")).toMatchObject({ lastRunAt: at(5), lastRunTaskId: null, lastOutcome: null });
      schedules.markRunning({ scheduleId: "s-1", taskId: "task-fire", fireTime: at(10), now: at(10) });
      expect(schedules.get("s-1")).toMatchObject({
        lastRunAt: at(10),
        lastRunTaskId: "task-fire",
        lastOutcome: `dispatching the ${at(10)} fire`,
      });
    } finally {
      store.close();
    }
  });

  it("records a run asked for now as it ended, without touching the failures in a row", () => {
    const { store, schedules } = fixture();
    try {
      schedules.recordRun({ scheduleId: "s-1", taskId: null, outcome: "failed", outcomeKind: "failed", now: at(1) });
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: null,
        outcome: "webhook run (no payload): failed: Model connection is not active",
        outcomeKind: "failed",
        counted: false,
        fire: { fireTime: at(2), reasonCode: "webhook" },
        now: at(2),
      });
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: "task-2",
        outcome: "manual run: completed",
        outcomeKind: "succeeded",
        counted: false,
        fire: { fireTime: at(3), reasonCode: "manual" },
        now: at(3),
      });
      expect(schedules.listFires("s-1", 10).map((fire) => [fire.reasonCode, fire.outcomeKind])).toEqual([
        ["manual", "succeeded"],
        ["webhook", "failed"],
      ]);
      expect(schedules.get("s-1")).toMatchObject({ consecutiveFailures: 1 });
    } finally {
      store.close();
    }
  });

  it("keeps one row for a fire refused again for the same reason, and records an orphan only over its marker", () => {
    const { store, schedules } = fixture();
    try {
      for (const minute of [0, 1, 2]) {
        schedules.recordRun({
          scheduleId: "s-1",
          taskId: null,
          outcome: `refused: only ${10 - minute} MiB free`,
          outcomeKind: "skipped",
          fire: { fireTime: NOW, reasonCode: "disk" },
          now: at(minute),
        });
      }
      expect(schedules.listFires("s-1", 100)).toEqual([
        expect.objectContaining({ reasonCode: "disk", outcome: "refused: only 8 MiB free", at: at(2) }),
      ]);

      const orphan = {
        scheduleId: "s-1",
        expectedMarker: `dispatching the ${at(5)} fire`,
        outcome: `orphaned: the ${at(5)} fire never reported a result`,
        outcomeKind: "failed" as const,
        fire: { fireTime: at(5), reasonCode: "orphaned" as const },
        now: at(10),
      };
      expect(schedules.recordRunIfMarked(orphan)).toBe(false);
      expect(schedules.listFires("s-1", 100)).toHaveLength(1);
      schedules.markRunning({ scheduleId: "s-1", taskId: "task-5", fireTime: at(5), now: at(5) });
      expect(schedules.recordRunIfMarked(orphan)).toBe(true);
      expect(schedules.listFires("s-1", 1)[0]).toMatchObject({ fireTime: at(5), reasonCode: "orphaned", outcomeKind: "failed" });
    } finally {
      store.close();
    }
  });

  it("keeps the newest fires of each schedule, removes them with it, and drops a fire recorded after", () => {
    const { store, schedules } = fixture();
    try {
      schedules.create({ ...base, scheduleId: "s-2", name: "Other" });
      const fire = (scheduleId: string, minute: number) =>
        schedules.recordFire({
          scheduleId,
          taskId: null,
          outcome: "skipped: missed while the owner was not running",
          outcomeKind: "skipped",
          fire: { fireTime: at(minute), reasonCode: "missed" },
          now: at(minute),
        });
      for (let minute = 0; minute < SCHEDULE_FIRES_KEPT + 5; minute += 1) fire("s-1", minute);
      fire("s-2", 0);
      const kept = schedules.listFires("s-1", 1_000);
      expect(kept).toHaveLength(SCHEDULE_FIRES_KEPT);
      expect(kept[0]?.fireTime).toBe(at(SCHEDULE_FIRES_KEPT + 4));
      expect(kept.at(-1)?.fireTime).toBe(at(5));
      // Many schedules' newest fires in one read: each `listFires`, in the ids' order, an unknown id with none.
      expect(schedules.latestFires(["s-2", "nope", "s-1"], 3)).toEqual([schedules.listFires("s-2", 3), [], schedules.listFires("s-1", 3)]);
      expect(schedules.latestFires(["s-1"], 1_000)).toEqual([kept]);
      expect(schedules.latestFires([], 1)).toEqual([]);

      expect(schedules.remove("s-1")).toBe(true);
      expect(schedules.listFires("s-1", 100)).toEqual([]);
      expect(schedules.listFires("s-2", 100)).toHaveLength(1);

      // A sweep that listed the schedule before its removal records nothing for it.
      fire("s-1", SCHEDULE_FIRES_KEPT + 5);
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: "task-late",
        outcome: "completed",
        outcomeKind: "succeeded",
        fire: { fireTime: at(SCHEDULE_FIRES_KEPT + 6), reasonCode: "ok" },
        now: at(SCHEDULE_FIRES_KEPT + 6),
      });
      expect(schedules.listFires("s-1", 100)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps refused calls under their own cap, so a stream of them never prunes the schedule's fires", () => {
    const { store, schedules } = fixture();
    try {
      const fire = (minute: number, reasonCode: "missed" | "webhook-refused") =>
        schedules.recordFire({
          scheduleId: "s-1",
          taskId: null,
          outcome: reasonCode === "missed" ? "skipped: missed while the owner was not running" : "webhook refused 3 calls",
          outcomeKind: "skipped",
          fire: { fireTime: at(minute), reasonCode },
          now: at(minute),
        });
      for (let minute = 0; minute < 3; minute += 1) fire(minute, "missed");
      for (let minute = 3; minute < 3 + SCHEDULE_REFUSALS_KEPT + 10; minute += 1) fire(minute, "webhook-refused");
      const kept = schedules.listFires("s-1", 1_000);
      expect(kept.filter((row) => row.reasonCode === "missed")).toHaveLength(3);
      expect(kept.filter((row) => row.reasonCode === "webhook-refused")).toHaveLength(SCHEDULE_REFUSALS_KEPT);
      expect(kept[0]?.fireTime).toBe(at(SCHEDULE_REFUSALS_KEPT + 12));
    } finally {
      store.close();
    }
  });

  it("adds an empty ledger to a data directory made before it, and its schedules record into it", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0012_schedule_fires"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '[]', 1, ?, 'completed', 2, ?, ?)`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC" }), NOW, NOW, NOW);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      // The stored row reads as before: same next fire, outcome and failure count.
      expect(schedules.get("s-old")).toMatchObject({ nextRunAt: NOW, lastOutcome: "completed", consecutiveFailures: 2 });
      expect(schedules.listFires("s-old", 100)).toEqual([]);
      schedules.recordRun({
        scheduleId: "s-old",
        taskId: null,
        outcome: "skipped: missed by 400m (policy: skip)",
        outcomeKind: "skipped",
        fire: { fireTime: NOW, reasonCode: "missed" },
        now: at(400),
      });
      expect(schedules.listFires("s-old", 100)).toEqual([expect.objectContaining({ reasonCode: "missed", fireTime: NOW })]);
      expect(schedules.get("s-old")).toMatchObject({ lastOutcome: "skipped: missed by 400m (policy: skip)", consecutiveFailures: 2 });
    } finally {
      store.close();
    }
  });

  it("keeps a schedule's run limit: absent until set, then read back and changed", () => {
    const { store, schedules } = fixture();
    try {
      expect(schedules.get("s-1")).not.toHaveProperty("maxRunMinutes");
      schedules.create({ ...base, scheduleId: "s-2", name: "Long", maxRunMinutes: 90 });
      expect(schedules.get("s-2")?.maxRunMinutes).toBe(90);
      expect(schedules.update({ scheduleId: "s-1", maxRunMinutes: 45, now: at(1) })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ maxRunMinutes: 45, nextRunAt: NOW });
      // A hand edit past the bound is refused by the column itself.
      expect(() => store.handle.prepare("UPDATE tavi_schedules SET max_run_minutes = 0 WHERE schedule_id = 's-1'").run()).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before run limits: its schedules and fires read as before, and a run stopped at its limit records", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0013_schedule_max_run"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, deliver_to)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '["web_search"]', 1, ?, 'completed', 1, ?, ?, 'home')`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC", daysOfWeek: [1, 5] }), NOW, NOW, NOW);
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "skipped", "skipped: the previous run is still in flight", "overlap", null, at(0));
      insertFire.run(at(1), "succeeded", "completed", "ok", "task-1", at(1));
      expect(() => insertFire.run(at(2), "failed", "timed out", "timeout", "task-2", at(2))).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      expect(upgraded).toMatchObject({
        spec: { at: "07:00", timezone: "UTC", daysOfWeek: [1, 5] },
        nextRunAt: NOW,
        autoApproveTools: ["web_search"],
        deliverTo: "home",
        lastOutcome: "completed",
        consecutiveFailures: 1,
      });
      // No limit stored: its fires are held to the default.
      expect(upgraded).not.toHaveProperty("maxRunMinutes");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId])).toEqual([
        ["ok", "task-1"],
        ["overlap", null],
      ]);
      schedules.recordRun({
        scheduleId: "s-old",
        taskId: "task-2",
        outcome: "timed out: stopped after 30 minutes of work",
        outcomeKind: "failed",
        fire: { fireTime: at(2), reasonCode: "timeout" },
        now: at(32),
      });
      expect(schedules.listFires("s-old", 1)[0]).toMatchObject({ reasonCode: "timeout", outcomeKind: "failed", taskId: "task-2" });
      expect(schedules.get("s-old")).toMatchObject({ consecutiveFailures: 2 });
    } finally {
      store.close();
    }
  });
  it("keeps when a schedule tells its person and the hash it last delivered: always unless set, and a run's hash only when given", () => {
    const { store, schedules } = fixture();
    try {
      expect(schedules.get("s-1")).not.toHaveProperty("notify");
      schedules.create({ ...base, scheduleId: "s-2", name: "Jobs", notify: "when-sent" });
      expect(schedules.get("s-2")?.notify).toBe("when-sent");
      // `always` is the default, stored and read as no choice at all.
      schedules.create({ ...base, scheduleId: "s-3", name: "Every", notify: "always" });
      expect(schedules.get("s-3")).not.toHaveProperty("notify");
      expect(schedules.update({ scheduleId: "s-1", notify: "if-changed", now: at(1) })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ notify: "if-changed", nextRunAt: NOW });
      const hash = "d".repeat(64);
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: "task-1",
        outcome: "completed",
        outcomeKind: "succeeded",
        fire: { fireTime: NOW, reasonCode: "ok" },
        deliveredHash: hash,
        now: at(2),
      });
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: "task-2",
        outcome: "completed quietly: the result was unchanged, so it was not sent again",
        outcomeKind: "succeeded",
        fire: { fireTime: at(3), reasonCode: "quiet" },
        now: at(3),
      });
      expect(schedules.get("s-1")).toMatchObject({ lastDeliveredHash: hash, consecutiveFailures: 0 });
      expect(schedules.listFires("s-1", 1)[0]).toMatchObject({ reasonCode: "quiet", outcomeKind: "succeeded" });
      expect(schedules.update({ scheduleId: "s-1", notify: "always", now: at(4) })).toBe(true);
      expect(schedules.get("s-1")).not.toHaveProperty("notify");
      // A hand edit to a mode that does not exist is refused by the column itself.
      expect(() => store.handle.prepare("UPDATE tavi_schedules SET notify = 'sometimes' WHERE schedule_id = 's-1'").run()).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      store.close();
    }
  });

  it("forgets the hash it last delivered when what decides delivery changes, and keeps it through any other edit", () => {
    const { store, schedules } = fixture();
    try {
      const deliver = (now: string): void => {
        schedules.recordRun({
          scheduleId: "s-1",
          taskId: `task-${now}`,
          outcome: "completed",
          outcomeKind: "succeeded",
          fire: { fireTime: now, reasonCode: "ok" },
          deliveredHash: "e".repeat(64),
          now,
        });
      };
      expect(schedules.update({ scheduleId: "s-1", notify: "if-changed", now: at(1) })).toBe(true);
      deliver(at(2));
      expect(schedules.update({ scheduleId: "s-1", maxRunMinutes: 45, now: at(3) })).toBe(true);
      expect(schedules.get("s-1")).toHaveProperty("lastDeliveredHash", "e".repeat(64));
      const edits = [
        { alert: { connectionId: "conn-2", destination: "chat-2" } },
        { alert: null },
        { deliverTo: "home" as const },
        { prompt: "Summarise something else" },
        { notify: "when-sent" as const },
      ];
      for (const [index, edit] of edits.entries()) {
        deliver(at(10 + index * 2));
        expect(schedules.update({ scheduleId: "s-1", ...edit, now: at(11 + index * 2) })).toBe(true);
        expect(schedules.get("s-1")).not.toHaveProperty("lastDeliveredHash");
      }
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before notify: its schedules tell as before, its fires read as before, and a quiet run records", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0014_schedule_notify"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, deliver_to,
             max_run_minutes)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '["messaging.send_to"]', 1, ?,
             'completed but nothing was delivered: no brief was sent', 1, ?, ?, 'home', 45)`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC", daysOfWeek: [1, 5] }), NOW, NOW, NOW);
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "succeeded", "completed", "ok", "task-1", at(0));
      insertFire.run(at(1), "failed", "timed out: stopped after 45 minutes of work", "timeout", "task-2", at(1));
      expect(() => insertFire.run(at(2), "succeeded", "completed quietly", "quiet", "task-3", at(2))).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      expect(upgraded).toMatchObject({
        spec: { at: "07:00", timezone: "UTC", daysOfWeek: [1, 5] },
        nextRunAt: NOW,
        autoApproveTools: ["messaging.send_to"],
        deliverTo: "home",
        maxRunMinutes: 45,
        consecutiveFailures: 1,
      });
      // No choice stored: it tells after every run, as it did, and has delivered nothing it compares with.
      expect(upgraded).not.toHaveProperty("notify");
      expect(upgraded).not.toHaveProperty("lastDeliveredHash");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId])).toEqual([
        ["timeout", "task-2"],
        ["ok", "task-1"],
      ]);
      schedules.recordRun({
        scheduleId: "s-old",
        taskId: "task-3",
        outcome: "completed quietly: nothing to report, so nothing was sent",
        outcomeKind: "succeeded",
        fire: { fireTime: at(2), reasonCode: "quiet" },
        now: at(2),
      });
      expect(schedules.listFires("s-old", 1)[0]).toMatchObject({ reasonCode: "quiet", outcomeKind: "succeeded", taskId: "task-3" });
      expect(schedules.get("s-old")).toMatchObject({ consecutiveFailures: 0 });
    } finally {
      store.close();
    }
  });

  it("keeps every stored cadence shape, and finishes a schedule that ends once its last claim has settled", () => {
    const { store, schedules } = fixture();
    try {
      const spec = { times: ["07:00", "19:00"], timezone: "Europe/Sofia", monthly: { nth: -1 as const, weekday: 5 }, until: "2026-12-31" };
      schedules.create({ ...base, scheduleId: "s-2", name: "Shapes", spec });
      expect(schedules.get("s-2")?.spec).toEqual(spec);
      schedules.update({
        scheduleId: "s-2",
        spec: { everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC" },
        now: at(1),
      });
      expect(schedules.get("s-2")?.spec).toEqual({ everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC" });
      // The last fire's claim (no next run) leaves the schedule on until it settles, and not due again.
      expect(schedules.claimFire({ scheduleId: "s-1", fireTime: NOW, nextRunAt: null, now: NOW })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ enabled: true, nextRunAt: null });
      expect(schedules.listDue(at(60 * 24 * 365), 10).due.map((due) => due.scheduleId)).toEqual(["s-2"]);
      expect(schedules.claimFire({ scheduleId: "s-1", fireTime: NOW, nextRunAt: null, now: NOW })).toBe(false);
      // A retry of that fire keeps it on; the retry's own claim, once settled, finishes it.
      const retry = { count: 1, ofFireTime: NOW };
      expect(schedules.armRetry({ scheduleId: "s-1", expectedNextRunAt: null, retryAt: at(2), retry, now: NOW })).toBe(true);
      expect(schedules.finish({ scheduleId: "s-1", now: NOW })).toBe(false);
      expect(schedules.claimFire({ scheduleId: "s-1", fireTime: at(2), nextRunAt: null, now: at(2) })).toBe(true);
      expect(schedules.finish({ scheduleId: "s-1", now: at(3) })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ enabled: false, nextRunAt: null });
      expect(schedules.finish({ scheduleId: "s-1", now: at(4) })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("arms a retry only on the pointer the fire's claim armed, and the retry's claim drops it", () => {
    const { store, schedules } = fixture();
    try {
      const next = at(24 * 60);
      expect(schedules.claimFire({ scheduleId: "s-1", fireTime: NOW, nextRunAt: next, now: NOW })).toBe(true);
      const retry = { count: 1, ofFireTime: NOW };
      // An edit moved the pointer since: the retry is not this fire's to arm.
      expect(schedules.armRetry({ scheduleId: "s-1", expectedNextRunAt: at(5), retryAt: at(2), retry, now: NOW })).toBe(false);
      expect(schedules.armRetry({ scheduleId: "s-1", expectedNextRunAt: next, retryAt: at(2), retry, now: NOW })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ nextRunAt: at(2), retry });
      expect(schedules.listDue(at(2), 10).due[0]).toMatchObject({ scheduleId: "s-1", retry });
      expect(schedules.claimFire({ scheduleId: "s-1", fireTime: at(2), nextRunAt: next, now: at(2) })).toBe(true);
      expect(schedules.get("s-1")).not.toHaveProperty("retry");
      expect(schedules.get("s-1")?.nextRunAt).toBe(next);
      // A new time, or a pause, drops a retry armed at the old pointer.
      schedules.armRetry({ scheduleId: "s-1", expectedNextRunAt: next, retryAt: at(12), retry: { count: 2, ofFireTime: NOW }, now: at(2) });
      schedules.update({ scheduleId: "s-1", spec: { at: "08:00", timezone: "UTC" }, nextRunAt: next, now: at(3) });
      expect(schedules.get("s-1")).not.toHaveProperty("retry");
      // Each try of a fire is its own ledger row.
      for (const retryCount of [0, 1, 2]) {
        schedules.recordFire({
          scheduleId: "s-1",
          taskId: null,
          outcome: "retrying",
          outcomeKind: "skipped",
          fire: { fireTime: NOW, reasonCode: "retry", retryCount },
          now: at(retryCount),
        });
      }
      expect(schedules.listFires("s-1", 10).map((fire) => fire.retryCount)).toEqual([2, 1, undefined]);
    } finally {
      store.close();
    }
  });

  it("pauses a schedule failing three times in a row once, and resuming clears the reason and the count", () => {
    const { store, schedules } = fixture();
    try {
      const pause = { scheduleId: "s-1", failures: 3, fireTime: NOW, outcome: "paused: 3 failed runs in a row", now: NOW };
      for (const minute of [0, 1]) {
        schedules.recordRun({ scheduleId: "s-1", taskId: null, outcome: "failed: boom", outcomeKind: "failed", now: at(minute) });
      }
      expect(schedules.pauseForFailures(pause)).toBe(false);
      schedules.recordRun({ scheduleId: "s-1", taskId: null, outcome: "failed: boom", outcomeKind: "failed", now: at(2) });
      expect(schedules.pauseForFailures(pause)).toBe(true);
      expect(schedules.pauseForFailures(pause)).toBe(false);
      expect(schedules.get("s-1")).toMatchObject({ enabled: false, nextRunAt: null, pausedReason: "failures", consecutiveFailures: 3 });
      expect(schedules.listDue(at(60 * 24 * 7), 10).due).toEqual([]);
      expect(schedules.listFires("s-1", 1)[0]).toMatchObject({ reasonCode: "paused", outcomeKind: "skipped", fireTime: NOW });
      schedules.setEnabled({ scheduleId: "s-1", enabled: true, nextRunAt: at(60), now: at(3) });
      const resumed = schedules.get("s-1");
      expect(resumed).toMatchObject({ enabled: true, nextRunAt: at(60), consecutiveFailures: 0 });
      expect(resumed).not.toHaveProperty("pausedReason");
      // A person's pause has no reason, and enabling a running schedule leaves its count alone.
      schedules.recordRun({ scheduleId: "s-1", taskId: null, outcome: "failed: boom", outcomeKind: "failed", now: at(4) });
      schedules.setEnabled({ scheduleId: "s-1", enabled: true, nextRunAt: at(60), now: at(5) });
      expect(schedules.get("s-1")?.consecutiveFailures).toBe(1);
      schedules.setEnabled({ scheduleId: "s-1", enabled: false, nextRunAt: null, now: at(6) });
      expect(schedules.get("s-1")).not.toHaveProperty("pausedReason");
    } finally {
      store.close();
    }
  });

  it("never pauses a routine's trigger: the routine has a failure pause of its own", () => {
    const { store, schedules } = fixture();
    try {
      store.handle
        .prepare(
          "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('routine-1','default','operator','Routine',1,1,1,'active',NULL,?,?)",
        )
        .run(NOW, NOW);
      store.handle
        .prepare("INSERT INTO tavi_routine_triggers(routine_id,trigger_id,schedule_id,spec_json) VALUES('routine-1','morning','s-1','{}')")
        .run();
      for (const minute of [0, 1, 2]) {
        schedules.recordRun({ scheduleId: "s-1", taskId: null, outcome: "failed: boom", outcomeKind: "failed", now: at(minute) });
      }
      const pause = { scheduleId: "s-1", failures: 3, fireTime: NOW, outcome: "paused: 3 failed runs in a row", now: at(3) };
      expect(schedules.pauseForFailures(pause)).toBe(false);
      expect(schedules.get("s-1")).toMatchObject({ enabled: true, consecutiveFailures: 3 });
      expect(schedules.get("s-1")).not.toHaveProperty("pausedReason");
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before retries: its schedules are neither paused nor retrying, and its fires are first tries", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0015_schedule_retry_pause"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, notify)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '[]', 0, NULL, 'failed: boom', 4, ?, ?, 'when-sent')`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC" }), NOW, NOW);
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "succeeded", "completed quietly", "quiet", "task-1", at(0));
      insertFire.run(at(1), "failed", "failed: boom", "failed", "task-2", at(1));
      expect(() => insertFire.run(at(2), "skipped", "retrying", "retry", "task-3", at(2))).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      // Disabled before: a person's pause, which resumes as one did.
      expect(upgraded).toMatchObject({ enabled: false, nextRunAt: null, notify: "when-sent", consecutiveFailures: 4 });
      expect(upgraded).not.toHaveProperty("pausedReason");
      expect(upgraded).not.toHaveProperty("retry");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId, fire.retryCount])).toEqual([
        ["failed", "task-2", undefined],
        ["quiet", "task-1", undefined],
      ]);
      schedules.recordFire({
        scheduleId: "s-old",
        taskId: "task-3",
        outcome: "retrying",
        outcomeKind: "skipped",
        fire: { fireTime: at(2), reasonCode: "retry", retryCount: 1 },
        now: at(2),
      });
      expect(schedules.listFires("s-old", 1)[0]).toMatchObject({ reasonCode: "retry", retryCount: 1 });
      schedules.setEnabled({ scheduleId: "s-old", enabled: true, nextRunAt: at(60), now: at(3) });
      expect(schedules.get("s-old")).toMatchObject({ enabled: true, consecutiveFailures: 0 });
    } finally {
      store.close();
    }
  });
});

describe("a schedule's token ceiling", () => {
  it("is kept, changed and cleared, and none is set unless asked", () => {
    const { store, schedules } = fixture();
    try {
      expect(schedules.get("s-1")).not.toHaveProperty("maxTokens");
      schedules.create({ ...base, scheduleId: "s-2", name: "Capped", maxTokens: 50_000 });
      expect(schedules.get("s-2")).toMatchObject({ maxTokens: 50_000 });
      schedules.update({ scheduleId: "s-2", maxTokens: 80_000, now: at(1) });
      expect(schedules.get("s-2")).toMatchObject({ maxTokens: 80_000 });
      schedules.update({ scheduleId: "s-2", prompt: "Another brief", now: at(2) });
      expect(schedules.get("s-2")).toMatchObject({ maxTokens: 80_000 });
      schedules.update({ scheduleId: "s-2", maxTokens: null, now: at(3) });
      expect(schedules.get("s-2")).not.toHaveProperty("maxTokens");
      expect(() => store.handle.prepare("UPDATE tavi_schedules SET max_tokens = 10 WHERE schedule_id = 's-2'").run()).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before token ceilings: no schedule gets one, and its fires keep their tries", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0016_schedule_max_tokens"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, max_run_minutes)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '[]', 1, ?, 'completed', 0, ?, ?, 45)`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC" }), at(60), NOW, NOW);
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "failed", "timed out: stopped after 45 minutes of work", "timeout", "task-1", at(0), 0);
      insertFire.run(at(1), "skipped", "retrying", "retry", "task-2", at(1), 2);
      expect(() => insertFire.run(at(2), "failed", "over budget", "budget", "task-3", at(2), 0)).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      expect(upgraded).toMatchObject({ enabled: true, nextRunAt: at(60), maxRunMinutes: 45, lastOutcome: "completed" });
      expect(upgraded).not.toHaveProperty("maxTokens");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId, fire.retryCount])).toEqual([
        ["retry", "task-2", 2],
        ["timeout", "task-1", undefined],
      ]);
      schedules.recordRun({
        scheduleId: "s-old",
        taskId: "task-3",
        outcome: "over budget: stopped after 1,200 tokens, past its ceiling of 1,000 tokens",
        outcomeKind: "failed",
        fire: { fireTime: at(2), reasonCode: "budget" },
        now: at(2),
      });
      expect(schedules.listFires("s-old", 1)[0]).toMatchObject({ reasonCode: "budget", taskId: "task-3" });
    } finally {
      store.close();
    }
  });
});

describe("a schedule's pre-check", () => {
  const page = { kind: "page-changed" as const, target: "https://example.com/news" };
  const reading = (fingerprint: string, minutes: number) => ({ fingerprint, checkedAt: at(minutes) });

  it("is kept with its last reading, which a run keeps only for the pre-check that took it, and a new pre-check forgets", () => {
    const { store, schedules } = fixture();
    try {
      expect(schedules.get("s-1")).not.toHaveProperty("precheck");
      schedules.create({ ...base, scheduleId: "s-2", name: "Watched", precheck: page });
      expect(schedules.get("s-2")).toMatchObject({ precheck: page });
      expect(schedules.get("s-2")).not.toHaveProperty("precheckState");
      schedules.recordRun({
        scheduleId: "s-2",
        taskId: null,
        outcome: "unchanged: nothing new",
        outcomeKind: "skipped",
        fire: { fireTime: at(0), reasonCode: "unchanged" },
        precheckState: { of: page, state: reading("aaa", 0) },
        now: at(0),
      });
      expect(schedules.get("s-2")).toMatchObject({ precheckState: reading("aaa", 0), lastOutcome: "unchanged: nothing new" });
      expect(schedules.listFires("s-2", 1)[0]).toMatchObject({ reasonCode: "unchanged", outcomeKind: "skipped" });
      // A reading of a pre-check that is no longer the schedule's is not kept.
      schedules.recordRun({
        scheduleId: "s-2",
        taskId: null,
        outcome: "completed",
        outcomeKind: "succeeded",
        precheckState: { of: { kind: "feed-has-new", target: "https://example.com/news" }, state: reading("bbb", 1) },
        now: at(1),
      });
      expect(schedules.get("s-2")).toMatchObject({ precheckState: reading("aaa", 0) });
      // The same pre-check saved again keeps its reading; another forgets it; none removes both.
      schedules.update({ scheduleId: "s-2", precheck: page, now: at(2) });
      expect(schedules.get("s-2")).toMatchObject({ precheck: page, precheckState: reading("aaa", 0) });
      schedules.update({ scheduleId: "s-2", precheck: { kind: "page-changed", target: "https://example.com/other" }, now: at(3) });
      expect(schedules.get("s-2")).not.toHaveProperty("precheckState");
      schedules.update({ scheduleId: "s-2", precheck: null, now: at(4) });
      expect(schedules.get("s-2")).not.toHaveProperty("precheck");
      // A hand-edited pre-check is an unreadable row, never a fetch of an address nobody checked.
      store.handle
        .prepare("UPDATE tavi_schedules SET precheck_json = ? WHERE schedule_id = 's-2'")
        .run(JSON.stringify({ kind: "page-changed", target: "http://169.254.169.254/" }));
      expect(() => schedules.get("s-2")).toThrow(/unreadable/);
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before pre-checks: no schedule gets one, its fires read as before, and an unchanged fire records", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0018_schedule_precheck"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, max_tokens)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '[]', 1, ?, 'completed', 0, ?, ?, 50000)`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC" }), at(60), NOW, NOW);
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "failed", "over budget", "budget", "task-1", at(0), 0);
      insertFire.run(at(1), "skipped", "retrying", "retry", "task-2", at(1), 1);
      expect(() => insertFire.run(at(2), "skipped", "unchanged", "unchanged", null, at(2), 0)).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      expect(upgraded).toMatchObject({ enabled: true, nextRunAt: at(60), maxTokens: 50_000, lastOutcome: "completed" });
      expect(upgraded).not.toHaveProperty("precheck");
      expect(upgraded).not.toHaveProperty("precheckState");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId, fire.retryCount])).toEqual([
        ["retry", "task-2", 1],
        ["budget", "task-1", undefined],
      ]);
      schedules.recordRun({
        scheduleId: "s-old",
        taskId: null,
        outcome: "unchanged: nothing new",
        outcomeKind: "skipped",
        fire: { fireTime: at(2), reasonCode: "unchanged" },
        now: at(2),
      });
      expect(schedules.listFires("s-old", 1)[0]).toMatchObject({ reasonCode: "unchanged", taskId: null });
      expect(SCHEDULE_FIRE_REASONS).toContain("unchanged");
    } finally {
      store.close();
    }
  });
});

describe("a schedule's webhook", () => {
  const hash = (digit: string) => digit.repeat(64);

  it("is off by default, keeps only a secret's SHA-256 and when it was made, and is never read into the record", () => {
    const { store, schedules } = fixture();
    try {
      expect(schedules.get("s-1")).not.toHaveProperty("webhook");
      expect(schedules.webhookSecretHash("s-1")).toBeUndefined();
      expect(schedules.hasWebhooks()).toBe(false);
      expect(schedules.setWebhook({ scheduleId: "s-1", secretHash: hash("a"), now: at(1) })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ webhook: { since: at(1) } });
      expect(JSON.stringify(schedules.get("s-1"))).not.toContain(hash("a"));
      expect(JSON.stringify(schedules.list())).not.toContain(hash("a"));
      expect(schedules.webhookSecretHash("s-1")).toBe(hash("a"));
      expect(schedules.hasWebhooks()).toBe(true);
      expect(schedules.webhookScheduleIds()).toEqual(["s-1"]);
      expect(schedules.webhookSigningKey("s-1")).toBeUndefined();
      // A rotation replaces the secret, its signing key and its time; an edit of anything else keeps them.
      schedules.setWebhook({ scheduleId: "s-1", secretHash: hash("b"), signingKeyEncrypted: "sealed-b", now: at(2) });
      schedules.update({ scheduleId: "s-1", prompt: "Write the evening brief", now: at(3) });
      expect(schedules.webhookSecretHash("s-1")).toBe(hash("b"));
      expect(schedules.webhookSigningKey("s-1")).toBe("sealed-b");
      expect(JSON.stringify(schedules.get("s-1"))).not.toContain("sealed-b");
      expect(schedules.get("s-1")).toMatchObject({ webhook: { since: at(2) } });
      // Off forgets both; only a hash of the right shape is kept; an unknown schedule changes nothing.
      schedules.setWebhook({ scheduleId: "s-1", secretHash: null, signingKeyEncrypted: "sealed-c", now: at(4) });
      expect(schedules.get("s-1")).not.toHaveProperty("webhook");
      expect(schedules.webhookSigningKey("s-1")).toBeUndefined();
      expect(schedules.hasWebhooks()).toBe(false);
      expect(schedules.webhookScheduleIds()).toEqual([]);
      expect(() => schedules.setWebhook({ scheduleId: "s-1", secretHash: "not-a-hash", now: at(5) })).toThrow(/SHA-256/);
      expect(schedules.setWebhook({ scheduleId: "nope", secretHash: hash("c"), now: at(5) })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before webhooks: no schedule gets one, its fires read as before, and webhook rows record", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0019_schedule_webhook"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, precheck_json)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '[]', 1, ?, 'completed', 0, ?, ?, ?)`,
        )
        .run(
          JSON.stringify({ at: "07:00", timezone: "UTC" }),
          at(60),
          NOW,
          NOW,
          JSON.stringify({ kind: "page-changed", target: "https://example.com/news" }),
        );
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "skipped", "unchanged: nothing new", "unchanged", null, at(0), 0);
      insertFire.run(at(1), "skipped", "retrying", "retry", "task-2", at(1), 1);
      expect(() => insertFire.run(at(2), "skipped", "webhook run", "webhook", null, at(2), 0)).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      expect(upgraded).toMatchObject({ enabled: true, nextRunAt: at(60), precheck: { kind: "page-changed" }, lastOutcome: "completed" });
      expect(upgraded).not.toHaveProperty("webhook");
      expect(schedules.hasWebhooks()).toBe(false);
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId, fire.retryCount])).toEqual([
        ["retry", "task-2", 1],
        ["unchanged", null, undefined],
      ]);
      for (const [minutes, reasonCode] of [
        [2, "webhook"],
        [3, "webhook-refused"],
      ] as const)
        schedules.recordFire({
          scheduleId: "s-old",
          taskId: null,
          outcome: `${reasonCode} outcome`,
          outcomeKind: "skipped",
          fire: { fireTime: at(minutes), reasonCode },
          now: at(minutes),
        });
      expect(schedules.listFires("s-old", 2).map((fire) => fire.reasonCode)).toEqual(["webhook-refused", "webhook"]);
      expect(SCHEDULE_FIRE_REASONS).toEqual(expect.arrayContaining(["webhook", "webhook-refused"]));
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before watchers: no schedule is one, its fires read as before, and watch rows record", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0020_schedule_watch"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at, precheck_json)
           VALUES ('s-old', 'default', 'operator', 'Notes', 'Summarise the notes', ?, 'skip', '[]', 1, ?, 'completed', 0, ?, ?, ?)`,
        )
        .run(
          JSON.stringify({ everyHours: 1, timezone: "UTC" }),
          at(60),
          NOW,
          NOW,
          JSON.stringify({ kind: "file-changed", target: "/notes/today.md" }),
        );
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "skipped", "unchanged: nothing new", "unchanged", null, at(0), 0);
      insertFire.run(at(1), "succeeded", "webhook run: completed", "webhook", "task-2", at(1), 0);
      expect(() => insertFire.run(at(2), "skipped", "file-watch run", "watch", null, at(2), 0)).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      // A file pre-check saved before watchers stays a schedule run by its time: nothing reacts to its file.
      expect(upgraded).toMatchObject({ enabled: true, nextRunAt: at(60), precheck: { kind: "file-changed" }, lastOutcome: "completed" });
      expect(upgraded).not.toHaveProperty("watch");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId])).toEqual([
        ["webhook", "task-2"],
        ["unchanged", null],
      ]);
      schedules.recordFire({
        scheduleId: "s-old",
        taskId: null,
        outcome: "file-watch run: unchanged",
        outcomeKind: "skipped",
        fire: { fireTime: at(2), reasonCode: "watch" },
        now: at(2),
      });
      expect(schedules.listFires("s-old", 1).map((fire) => fire.reasonCode)).toEqual(["watch"]);
      expect(SCHEDULE_FIRE_REASONS).toContain("watch");
    } finally {
      store.close();
    }
  });

  it("keeps a watcher only while it has a pre-check", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const schedules = store.asPort().repositories.schedules;
      const precheck = { kind: "page-changed" as const, target: "https://example.com/news" };
      expect(schedules.create({ ...base, scheduleId: "s-w", name: "Watch", precheck, watch: true })).toMatchObject({
        watch: true,
        precheck,
      });
      // No pre-check, no watcher.
      expect(schedules.create({ ...base, scheduleId: "s-x", name: "Plain", watch: true })).not.toHaveProperty("watch");
      schedules.update({ scheduleId: "s-x", watch: true, now: at(1) });
      expect(schedules.get("s-x")).not.toHaveProperty("watch");
      // Another target keeps it a watcher; turning it off, or removing the pre-check, stops it.
      schedules.update({ scheduleId: "s-w", precheck: { kind: "feed-has-new", target: "https://example.com/feed" }, now: at(2) });
      expect(schedules.get("s-w")).toMatchObject({ watch: true, precheck: { kind: "feed-has-new" } });
      schedules.update({ scheduleId: "s-w", watch: false, now: at(3) });
      expect(schedules.get("s-w")).not.toHaveProperty("watch");
      schedules.update({ scheduleId: "s-w", watch: true, now: at(4) });
      expect(schedules.get("s-w")).toMatchObject({ watch: true });
      schedules.update({ scheduleId: "s-w", precheck: null, now: at(5) });
      expect(schedules.get("s-w")).not.toHaveProperty("watch");
      expect(schedules.get("s-w")).not.toHaveProperty("precheck");
    } finally {
      store.close();
    }
  });
});

describe("a schedule's email trigger", () => {
  const trigger = { connectionId: "mail-1", senders: ["ann@example.com", "@example.org"], since: NOW };

  it("is off by default, is kept whole and listed by its connection, and goes when turned off", () => {
    const { store, schedules } = fixture();
    try {
      schedules.create({ ...base, scheduleId: "s-2", name: "Other" });
      expect(schedules.get("s-1")).not.toHaveProperty("emailTrigger");
      expect(schedules.emailTriggered("mail-1")).toEqual([]);
      expect(schedules.setEmailTrigger({ scheduleId: "s-1", trigger: { ...trigger, subject: "invoice" }, now: at(1) })).toBe(true);
      expect(schedules.get("s-1")).toMatchObject({ emailTrigger: { ...trigger, subject: "invoice" } });
      expect(schedules.emailTriggered("mail-1").map((schedule) => schedule.scheduleId)).toEqual(["s-1"]);
      expect(schedules.emailTriggered("mail-2")).toEqual([]);
      // An edit of anything else keeps it; another connection moves it.
      schedules.update({ scheduleId: "s-1", prompt: "Write the evening brief", now: at(2) });
      expect(schedules.get("s-1")?.emailTrigger?.senders).toEqual(trigger.senders);
      schedules.setEmailTrigger({ scheduleId: "s-1", trigger: { ...trigger, connectionId: "mail-2" }, now: at(3) });
      expect(schedules.emailTriggered("mail-1")).toEqual([]);
      expect(schedules.emailTriggered("mail-2").map((schedule) => schedule.scheduleId)).toEqual(["s-1"]);
      // Off forgets it; a trigger with no sender is refused; an unknown schedule changes nothing.
      schedules.setEmailTrigger({ scheduleId: "s-1", trigger: null, now: at(4) });
      expect(schedules.get("s-1")).not.toHaveProperty("emailTrigger");
      expect(schedules.emailTriggered("mail-2")).toEqual([]);
      expect(() => schedules.setEmailTrigger({ scheduleId: "s-1", trigger: { ...trigger, senders: [] }, now: at(5) })).toThrow();
      expect(schedules.setEmailTrigger({ scheduleId: "nope", trigger, now: at(5) })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("listens to nothing from a hand-edited trigger, and leaves the rest of the schedule readable", () => {
    const { store, schedules } = fixture();
    try {
      store.handle
        .prepare("UPDATE tavi_schedules SET email_trigger_json = ? WHERE schedule_id = 's-1'")
        .run(JSON.stringify({ connectionId: "mail-1", senders: ["not an address"], since: NOW }));
      expect(schedules.emailTriggered("mail-1")).toEqual([]);
      expect(schedules.get("s-1")).toMatchObject({ name: "Brief" });
      expect(schedules.get("s-1")).not.toHaveProperty("emailTrigger");
    } finally {
      store.close();
    }
  });

  it("is looked up by its connection in an index, not by reading every schedule's trigger, and unreadable JSON matches none", () => {
    const { store, schedules } = fixture();
    try {
      schedules.create({ ...base, scheduleId: "s-2", name: "Other" });
      schedules.setEmailTrigger({ scheduleId: "s-2", trigger, now: at(1) });
      store.handle.prepare("UPDATE tavi_schedules SET email_trigger_json = 'not json' WHERE schedule_id = 's-1'").run();
      // The statement `emailTriggered` prepares, which must keep the index's expression (`0026_schedule_email_trigger_index`).
      const prepared: string[] = [];
      const prepare = store.handle.prepare.bind(store.handle);
      const spy = vi.spyOn(store.handle, "prepare").mockImplementation((sql: string) => {
        prepared.push(sql);
        return prepare(sql);
      });
      try {
        expect(schedules.emailTriggered("mail-1").map((schedule) => schedule.scheduleId)).toEqual(["s-2"]);
      } finally {
        spy.mockRestore();
      }
      expect(prepared).toHaveLength(1);
      const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${prepared[0]}`).all("mail-1") as { detail: string }[];
      expect(plan.map((row) => row.detail)).toEqual(["SEARCH tavi_schedules USING INDEX tavi_schedules_email_trigger_idx (<expr>=?)"]);
    } finally {
      store.close();
    }
  });

  it("upgrades a data directory made before email triggers: none is on, its fires read as before, and email rows record", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0021_schedule_email_trigger"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at)
           VALUES ('s-old', 'default', 'operator', 'Inbox', 'Summarise the invoice', ?, 'skip', '["reports.*"]', 1, ?, 'completed', 0, ?, ?)`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC" }), at(60), NOW, NOW);
      const insertFire = pre.prepare(
        `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         VALUES ('s-old', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFire.run(at(0), "skipped", "file-watch run: unchanged", "watch", null, at(0), 0);
      insertFire.run(at(1), "succeeded", "webhook run: completed", "webhook", "task-2", at(1), 0);
      expect(() => insertFire.run(at(2), "skipped", "email run", "email", null, at(2), 0)).toThrow(/CHECK constraint failed/);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const schedules = store.asPort().repositories.schedules;
      const upgraded = schedules.get("s-old");
      expect(upgraded).toMatchObject({ enabled: true, nextRunAt: at(60), autoApproveTools: ["reports.*"], lastOutcome: "completed" });
      expect(upgraded).not.toHaveProperty("emailTrigger");
      expect(schedules.listFires("s-old", 100).map((fire) => [fire.reasonCode, fire.taskId])).toEqual([
        ["webhook", "task-2"],
        ["watch", null],
      ]);
      for (const [minutes, reasonCode] of [
        [2, "email"],
        [3, "email-refused"],
      ] as const)
        schedules.recordFire({
          scheduleId: "s-old",
          taskId: null,
          outcome: `${reasonCode} outcome`,
          outcomeKind: "skipped",
          fire: { fireTime: at(minutes), reasonCode },
          now: at(minutes),
        });
      expect(schedules.listFires("s-old", 2).map((fire) => fire.reasonCode)).toEqual(["email-refused", "email"]);
      expect(SCHEDULE_FIRE_REASONS).toEqual(expect.arrayContaining(["email", "email-refused"]));
    } finally {
      store.close();
    }
  });
});

describe("a workspace's scheduled work this month", () => {
  /** A task of `origin`, and one model call of it at `startedAt` that used `tokens`, priced at `usd` when given. */
  function spend(
    store: SqliteStore,
    call: {
      readonly taskId: string;
      readonly origin: string | null;
      readonly startedAt: string;
      readonly tokens: number;
      readonly usd?: number;
      readonly workspaceId?: string;
    },
  ) {
    store.handle
      .prepare(
        "INSERT OR IGNORE INTO tavi_tasks (task_id, workspace_id, principal_id, thread_id, status, created_at, updated_at, origin) VALUES (?, ?, 'operator', ?, 'completed', ?, ?, ?)",
      )
      .run(call.taskId, call.workspaceId ?? "default", `thread-${call.taskId}`, call.startedAt, call.startedAt, call.origin);
    store.handle
      .prepare(
        "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, data, purpose) VALUES (?, ?, ?, 'owner', 'completed', ?, ?, 'generation')",
      )
      .run(
        `call-${call.taskId}-${call.startedAt}`,
        call.taskId,
        `attempt-${call.startedAt}`,
        call.startedAt,
        JSON.stringify({
          usage: { inputTokens: call.tokens - 1, outputTokens: 1 },
          ...(call.usd === undefined ? {} : { estimatedUsd: call.usd }),
        }),
      );
  }

  it("sums the month in the workspace's zone: schedules, routines and their workers, nothing else", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const window = scheduledMonthWindow(new Date("2026-10-15T12:00:00.000Z"), "Europe/Sofia");
      // October in Sofia runs from 00:00 EEST on the 1st to 00:00 EET on 1 November.
      expect(window).toEqual({ month: "2026-10", since: "2026-09-30T21:00:00.000Z", until: "2026-10-31T22:00:00.000Z" });
      spend(store, { taskId: "fire-sep", origin: "schedule", startedAt: "2026-09-30T20:59:59.000Z", tokens: 1_000, usd: 1 });
      spend(store, { taskId: "fire-1", origin: "schedule", startedAt: "2026-09-30T21:00:00.000Z", tokens: 100, usd: 0.01 });
      spend(store, { taskId: "fire-1", origin: "schedule", startedAt: "2026-10-31T21:59:00.000Z", tokens: 10, usd: 0.001 });
      spend(store, { taskId: "fire-nov", origin: "schedule", startedAt: "2026-10-31T22:00:00.000Z", tokens: 9_000, usd: 9 });
      spend(store, { taskId: "routine-task", origin: null, startedAt: "2026-10-15T08:00:00.000Z", tokens: 200, usd: 0.02 });
      spend(store, { taskId: "worker-1", origin: "agent", startedAt: "2026-10-20T08:00:00.000Z", tokens: 300, usd: 0.03 });
      spend(store, { taskId: "chat", origin: "web", startedAt: "2026-10-10T08:00:00.000Z", tokens: 5_000, usd: 5 });
      spend(store, { taskId: "elsewhere", origin: "schedule", startedAt: "2026-10-10T08:00:00.000Z", tokens: 7_000, workspaceId: "other" });
      store.handle
        .prepare(
          "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('routine-1','default','operator','Routine',1,1,1,'active',NULL,?,?)",
        )
        .run(NOW, NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_routine_runs(run_id,routine_id,workspace_id,principal_id,occurrence_key,revision,snapshot_json,mode,status,task_id,claimed_at,data_json) VALUES('run-1','routine-1','default','operator','k',1,'{}','production','succeeded','routine-task',?,'{}')",
        )
        .run(NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,root_task_id,parent_task_id) VALUES('default','operator','delegate-1','worker-1','researcher',?,'fire-1','fire-1')",
        )
        .run(NOW);
      const schedules = store.asPort().repositories.schedules;
      expect(schedules.scheduledUsage({ workspaceId: "default", ...window })).toEqual({ tokens: 610, usd: 0.061 });
      expect(schedules.scheduledUsage({ workspaceId: "other", ...window })).toEqual({ tokens: 7_000, usd: null });
      // September's own month, read in the same zone, holds only its last second.
      const september = scheduledMonthWindow(new Date("2026-09-30T20:59:59.000Z"), "Europe/Sofia");
      expect(september.month).toBe("2026-09");
      expect(schedules.scheduledUsage({ workspaceId: "default", ...september })).toEqual({ tokens: 1_000, usd: 1 });
    } finally {
      store.close();
    }
  });

  it("counts a worker's worker by its root, a routine's schedule-fired task once, and an unpriced call's tokens", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const window = scheduledMonthWindow(new Date("2026-10-15T12:00:00.000Z"), "UTC");
      spend(store, { taskId: "routine-fire", origin: "schedule", startedAt: "2026-10-05T08:00:00.000Z", tokens: 100, usd: 0.01 });
      spend(store, { taskId: "worker-1", origin: "agent", startedAt: "2026-10-05T09:00:00.000Z", tokens: 20, usd: 0.002 });
      spend(store, { taskId: "worker-2", origin: "agent", startedAt: "2026-10-05T10:00:00.000Z", tokens: 3, usd: 0.0003 });
      store.handle
        .prepare(
          "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('routine-1','default','operator','Routine',1,1,1,'active',NULL,?,?)",
        )
        .run(NOW, NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_routine_runs(run_id,routine_id,workspace_id,principal_id,occurrence_key,revision,snapshot_json,mode,status,task_id,claimed_at,data_json) VALUES('run-1','routine-1','default','operator','k',1,'{}','production','succeeded','routine-fire',?,'{}')",
        )
        .run(NOW);
      const delegate = store.handle.prepare(
        "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,root_task_id,parent_task_id) VALUES('default','operator',?,?,'researcher',?,'routine-fire',?)",
      );
      delegate.run("delegate-1", "worker-1", NOW, "routine-fire");
      delegate.run("delegate-2", "worker-2", NOW, "worker-1");
      const schedules = store.asPort().repositories.schedules;
      // The routine's run task is also schedule-fired: its calls count once, with both levels of workers.
      expect(schedules.scheduledUsage({ workspaceId: "default", ...window })).toEqual({ tokens: 123, usd: 0.0123 });
      // A call with no price sheet still counts its tokens, and leaves the cost unknown.
      spend(store, { taskId: "worker-2", origin: "agent", startedAt: "2026-10-06T10:00:00.000Z", tokens: 7 });
      expect(schedules.scheduledUsage({ workspaceId: "default", ...window })).toEqual({ tokens: 130, usd: null });
    } finally {
      store.close();
    }
  });

  it("rolls December over into the next year, and reports a share of its budget", () => {
    expect(scheduledMonthWindow(new Date("2026-12-31T23:30:00.000Z"), "UTC")).toEqual({
      month: "2026-12",
      since: "2026-12-01T00:00:00.000Z",
      until: "2027-01-01T00:00:00.000Z",
    });
    const window = scheduledMonthWindow(new Date("2026-12-31T23:30:00.000Z"), "Asia/Tokyo");
    expect(window.month).toBe("2027-01");
    const usage = scheduledWorkUsage(window, "Asia/Tokyo", { tokens: 812_345, usd: 1.5 }, 1_000_000);
    expect(usage).toMatchObject({ budget: 1_000_000, percent: 81 });
    expect(scheduledWorkText(usage)).toBe("812,345 tokens (about $1.50) of a 1,000,000-token monthly budget (81%)");
    expect(scheduledWorkText(scheduledWorkUsage(window, "Asia/Tokyo", { tokens: 5, usd: null }, undefined))).toBe("5 tokens");
  });
});
