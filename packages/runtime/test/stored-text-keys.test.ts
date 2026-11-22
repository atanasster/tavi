import { join } from "node:path";

import Database from "better-sqlite3";
import { localizedText, noticeWordsOf, textRef } from "@tavi/contracts";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";

/** Notices and fire outcomes stored by key beside their English (`0032_stored_text_keys`), said in the reader's language. */

const AT = "2026-11-22T10:00:00.000Z";
const directories = temporaryDirectories({ prefix: "tavi-stored-text-keys-" });
afterEach(() => directories.cleanup());

const columns = (db: Database.Database, table: string): readonly string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[]).map((column) => column.name);

function fixture(): SqliteStore {
  const directory = directories.create();
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  store.asPort().repositories.tasks.admit({
    workspaceId: "w1",
    principalId: "alice",
    operationKey: "op-1",
    kind: "start",
    intent: null,
    checkpointNamespace: "",
    newTaskId: () => "home-1",
    newAdmissionId: () => "adm-1",
    newThreadId: () => "thread-1",
    now: () => AT,
  });
  return store;
}

describe("stored text keys", () => {
  it("adds the key columns to a data directory made before them, and its older rows read as their English", () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0032_stored_text_keys"),
        ),
      );
      expect(columns(pre, "tavi_chat_notices")).not.toContain("title_key");
      pre
        .prepare(
          `INSERT INTO tavi_schedules (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
             auto_approve_tools_json, enabled, next_run_at, last_outcome, consecutive_failures, created_at, updated_at)
           VALUES ('s-old', 'default', 'operator', 'Brief', 'Write the brief', ?, 'skip', '[]', 1, ?, 'completed', 0, ?, ?)`,
        )
        .run(JSON.stringify({ at: "07:00", timezone: "UTC" }), AT, AT, AT);
      pre
        .prepare(
          `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
           VALUES ('s-old', ?, 'skipped', 'webhook refused 2 calls this hour (2 auth)', 'webhook-refused', NULL, ?, 0)`,
        )
        .run(AT, AT);
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const db = new Database(databasePath, { readonly: true });
      try {
        expect(columns(db, "tavi_chat_notices")).toEqual(
          expect.arrayContaining(["title_key", "title_params_json", "summary_key", "summary_params_json"]),
        );
        expect(columns(db, "tavi_schedule_fires")).toEqual(expect.arrayContaining(["outcome_key", "outcome_params_json"]));
      } finally {
        db.close();
      }
      const [fire] = store.asPort().repositories.schedules.listFires("s-old", 10);
      expect(fire).toMatchObject({ outcome: "webhook refused 2 calls this hour (2 auth)" });
      expect(fire).not.toHaveProperty("outcomeRef");
    } finally {
      store.close();
    }
  });

  it("keeps a notice's keys and parameters beside its English, and reads them back for the reader's language", () => {
    const store = fixture();
    try {
      const transcripts = store.asPort().repositories.transcripts;
      const title = textRef("notice.routine.paused.title", { name: "News" });
      const summary = textRef("notice.routine.failures.text", {
        name: "News",
        n: "3",
        resume: textRef("notice.routine.resumeHint", { path: textRef("notice.nav.centerSchedule") }),
      });
      const { notice } = transcripts.postNotice({
        noticeId: "notice-1",
        taskId: "home-1",
        kind: "run-settled",
        sourceKey: "routine-notice:run-1:failures",
        ...noticeWordsOf({ title, summary }),
        createdAt: AT,
      });
      // The English is stored as it always was.
      expect(notice.title).toBe("Routine “News” paused");
      expect(notice.summary).toBe(
        "Routine “News” paused after 3 failed runs in a row; its run history says why. Resume it in Center → Schedule, or ask Tavi in chat to resume it.",
      );
      const [read] = transcripts.notices("home-1", { limit: 10 });
      expect(read).toMatchObject({ titleRef: title, summaryRef: summary });
      const bg = coreIn("bg");
      expect(localizedText(read?.title ?? "", read?.titleRef, bg)).toBe("Рутината „News“ е на пауза");
      expect(localizedText(read?.summary ?? "", read?.summaryRef, bg)).toContain("Център → График");
      // A later post under the same key replaces its words and keys; one in plain words keeps none.
      transcripts.postNotice({
        noticeId: "unused",
        taskId: "home-1",
        kind: "run-settled",
        sourceKey: "routine-notice:run-1:failures",
        title: "Plain words",
        summary: "said as they are",
        createdAt: AT,
        bump: true,
      });
      const [plain] = transcripts.notices("home-1", { limit: 10 });
      expect(plain).toMatchObject({ title: "Plain words", summary: "said as they are" });
      expect(plain).not.toHaveProperty("titleRef");
      expect(plain).not.toHaveProperty("summaryRef");
    } finally {
      store.close();
    }
  });

  it("joins a run's generated summary to a keyed summary as a parameter, said in the reader's language", () => {
    const store = fixture();
    try {
      store.asPort().repositories.tasks.admit({
        workspaceId: "w1",
        principalId: "alice",
        operationKey: "op-run",
        kind: "start",
        intent: null,
        checkpointNamespace: "",
        newTaskId: () => "run-1",
        newAdmissionId: () => "adm-run",
        newThreadId: () => "thread-run",
        now: () => AT,
      });
      store.handle.prepare("UPDATE tavi_tasks SET summary = 'Three meetings', summary_state = 'done' WHERE task_id = 'run-1'").run();
      const transcripts = store.asPort().repositories.transcripts;
      transcripts.postNotice({
        noticeId: "notice-3",
        taskId: "home-1",
        kind: "run-settled",
        sourceKey: "run:run-1",
        sourceTaskId: "run-1",
        ...noticeWordsOf({ title: textRef("notice.run.title", { id: "run-1" }), summary: textRef("notice.status.completed") }),
        createdAt: AT,
      });
      const [read] = transcripts.notices("home-1", { limit: 10 });
      expect(read?.summary).toBe("Completed — Three meetings");
      expect(read?.summaryRef).toEqual({
        key: "notice.summary.joined",
        params: { summary: { key: "notice.status.completed" }, detail: "Three meetings" },
      });
      expect(localizedText(read?.summary ?? "", read?.summaryRef, coreIn("bg"))).toBe("Завършено — Three meetings");
    } finally {
      store.close();
    }
  });

  it("stores no key for a reference past the schema's bounds, keeping its English", () => {
    const store = fixture();
    try {
      const transcripts = store.asPort().repositories.transcripts;
      transcripts.postNotice({
        noticeId: "notice-4",
        taskId: "home-1",
        kind: "run-settled",
        sourceKey: "too-long",
        ...noticeWordsOf({ title: textRef("notice.run.title", { id: "x".repeat(5_000) }), summary: "s" }),
        createdAt: AT,
      });
      const row = store.handle.prepare("SELECT title_key FROM tavi_chat_notices WHERE notice_id = 'notice-4'").get() as {
        readonly title_key: string | null;
      };
      expect(row.title_key).toBeNull();
      const [read] = transcripts.notices("home-1", { limit: 10 });
      expect(read?.title.startsWith("Run xxx")).toBe(true);
      expect(read).not.toHaveProperty("titleRef");
    } finally {
      store.close();
    }
  });

  it("reads a key it cannot parse as no key, so the notice shows its English", () => {
    const store = fixture();
    try {
      const transcripts = store.asPort().repositories.transcripts;
      transcripts.postNotice({
        noticeId: "notice-2",
        taskId: "home-1",
        kind: "reminder",
        sourceKey: "reminder:r1:1",
        ...noticeWordsOf({ title: textRef("notice.reminder.title"), summary: "Stretch" }),
        createdAt: AT,
      });
      store.handle.prepare("UPDATE tavi_chat_notices SET title_params_json = '{not json' WHERE notice_id = 'notice-2'").run();
      const [read] = transcripts.notices("home-1", { limit: 10 });
      expect(read).toMatchObject({ title: "Reminder", summary: "Stretch" });
      expect(read).not.toHaveProperty("titleRef");
    } finally {
      store.close();
    }
  });

  it("keeps a fire's outcome key on its ledger row, and on the row a repeat of the fire updates", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const schedules = store.asPort().repositories.schedules;
      schedules.create({
        scheduleId: "s-1",
        name: "Brief",
        workspaceId: "default",
        principalId: "operator",
        prompt: "Write the brief",
        spec: { at: "07:00", timezone: "UTC" },
        missedRunPolicy: "skip",
        autoApproveTools: [],
        enabled: true,
        nextRunAt: AT,
        now: AT,
      });
      const refused = (count: number) => ({
        scheduleId: "s-1",
        taskId: null,
        outcome: `webhook refused ${count} calls this hour (${count} auth)`,
        outcomeRef: textRef("schedule.outcome.webhookRefused", { count, n: String(count), causes: `${count} auth` }),
        outcomeKind: "skipped" as const,
        fire: { fireTime: AT, reasonCode: "webhook-refused" as const },
        now: AT,
      });
      schedules.recordFire(refused(2));
      schedules.recordFire(refused(5));
      const fires = schedules.listFires("s-1", 10);
      expect(fires).toHaveLength(1);
      expect(fires[0]?.outcomeRef).toEqual(refused(5).outcomeRef);
      expect(localizedText(fires[0]?.outcome ?? "", fires[0]?.outcomeRef, coreIn("bg"))).toBe(
        "уебхукът отказа 5 извиквания този час (5 auth)",
      );
      expect(schedules.latestFires(["s-1"], 5)[0]?.[0]?.outcomeRef).toEqual(refused(5).outcomeRef);
      // A run's record carries its key to its fire's row, as a schedule's report writes it.
      const notPosted = textRef("schedule.outcome.notPosted.failed");
      schedules.recordRun({
        scheduleId: "s-1",
        taskId: null,
        outcome: "completed, but its result was not posted: posting it into Home failed",
        outcomeRef: notPosted,
        outcomeKind: "succeeded",
        fire: { fireTime: "2026-11-23T07:00:00.000Z", reasonCode: "ok" },
        now: "2026-11-23T07:01:00.000Z",
      });
      const [ran] = schedules.listFires("s-1", 10);
      expect(ran).toMatchObject({ reasonCode: "ok", outcomeRef: notPosted });
      expect(schedules.get("s-1")?.lastOutcome).toBe("completed, but its result was not posted: posting it into Home failed");
    } finally {
      store.close();
    }
  });
});
