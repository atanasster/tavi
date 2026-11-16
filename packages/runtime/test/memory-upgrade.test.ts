import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_RETENTION_DAYS,
  MEMORY_RESTORE_RECONCILE_REASON,
  memoryScopeKey,
  type MemoryActor,
  type MemoryScope,
} from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import { needsPosix, temporaryDirectories } from "@tavi/test-support";

import { MemoryService } from "../src/memory/service.js";
import { createSnapshot, restoreSnapshot } from "../src/persistence/administration.js";
import { DatabaseClient } from "../src/persistence/client.js";
import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/**
 * What existing memory meets on upgrade and restore.
 *
 * An approved preference whose `expiryAt` passed long ago (one carried by
 * `tavi memory move`, say) is marked `expired` by the first sweep, and the
 * erasure clock starts at that mark, not at its `expiryAt`, so it still gets the whole window under *Past*.
 *
 * A restore never brings a forgotten record back — the replaced
 * database's deletion journal is carried into the restored one and replayed
 * before the first turn — and a chat's fold archives, found by their tag and by
 * what its summaries name, go when its history is forgotten.
 */

const AT = "2026-10-12T08:00:00.000Z";
const LATER = "2026-10-12T09:00:00.000Z";
const MODEL = "fixture/embed-1";
const actor: MemoryActor = { principalId: "operator", workspaceId: "default", runId: "chat", caller: "cli", authority: "operator" };
const scope: MemoryScope = { kind: "personal", principalId: "operator" };

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

function directory(): string {
  return directories.create("tavi-memory-upgrade-");
}

/** A store over `dataDirectory`, its memory service and repositories; closed by the caller. */
function open(dataDirectory: string, now = AT) {
  const store = new SqliteStore({ databasePath: join(dataDirectory, "tavi.sqlite"), artifactsDirectory: join(dataDirectory, "artifacts") });
  const persistence = store.asPort();
  let counter = 0;
  const service = new MemoryService(persistence, { now: () => now, newId: (prefix) => `${prefix}-${now}-${(counter += 1)}` });
  return { store, service, memory: persistence.repositories.memory, transcripts: persistence.repositories.transcripts };
}

const count = (store: SqliteStore, sql: string, ...args: unknown[]): number => (store.handle.prepare(sql).get(...args) as { n: number }).n;

/**
 * A live directory with one remembered record, its vector and a card's prompt
 * row, snapshotted; then the record is forgotten in the live directory, as a
 * person would after the backup. Answers the directories and the record.
 */
async function forgottenAfterBackup(options: { readonly pending?: boolean; readonly providers?: readonly string[] } = {}) {
  const root = directory();
  const live = join(root, "live");
  const snapshot = join(root, "snap");
  const before = open(live);
  const kept = before.service.remember({ actor, scope, kind: "fact", body: "Has a cat called Miso" });
  before.memory.putVectors({ vectors: [{ revisionId: kept.currentRevisionId as string, modelKey: MODEL, vector: [1, 0, 0, 0] }], now: AT });
  before.store.handle
    .prepare(
      "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('chat','default','operator','t','','completed',?,?)",
    )
    .run(AT, AT);
  await before.transcripts.postMemoryCard({
    noticeId: "card-1",
    taskId: "chat",
    sourceKey: "memory:a1",
    createdAt: AT,
    records: [{ recordId: kept.recordId, workspaceId: "default", principalId: "operator" }],
  });
  before.store.close();
  createSnapshot({
    dataDirectory: live,
    outDirectory: snapshot,
    buildId: "test",
    now: AT,
    includeArtifacts: false,
    includeCredentials: false,
    force: false,
  });

  const after = open(live, LATER);
  const deletion = after.service.forget({ actor, recordId: kept.recordId, reason: "forgotten after the backup" });
  // A provider that could not take the removal yet leaves the row pending.
  if (options.pending === true) after.memory.markDeletionPending(deletion.deletionId, options.providers);
  const generation = after.memory.revocationGeneration(kept.scopeKey);
  after.store.close();
  return { live, snapshot, recordId: kept.recordId, scopeKey: kept.scopeKey, deletionId: deletion.deletionId, generation };
}

const DAY = 86_400_000;
const at = (base: string, days: number): string => new Date(Date.parse(base) + days * DAY).toISOString();
const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const alicePersonal: MemoryScope = { kind: "personal", principalId: "alice" };

describe("memory upgrade: approved records already past expiryAt", () => {
  it("an approved record whose expiryAt passed 90 days before the upgrade is marked expired by the first sweep and still listed under Past proposalDays − 1 days later", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const persistence = store.asPort();
    let counter = 0;
    const when = (now: string): MemoryService =>
      new MemoryService(persistence, { now: () => now, newId: (prefix) => `${prefix}-${(counter += 1)}` });
    const upgrade = "2026-06-01T00:00:00.000Z";
    const expiredAt = at(upgrade, -90);
    // Written before the upgrade, as `tavi memory move` carried it: approved, its expiry already behind it.
    const old = when(at(expiredAt, -10)).remember({
      actor: alice,
      scope: alicePersonal,
      kind: "preference",
      body: "Reply in Spanish",
      preferenceKey: "reply.language",
      preference: { valueType: "string", value: "es" },
      expiryAt: expiredAt,
    });
    expect(old.status).toBe("approved");

    const first = when(upgrade).sweepExpired({ actor: alice });
    expect(first.map((entry) => [entry.recordId, entry.outcome])).toEqual([[old.recordId, "expired"]]);
    expect(when(upgrade).get({ actor: alice, recordId: old.recordId })).toMatchObject({ status: "expired", updatedAt: upgrade });

    const window = DEFAULT_MEMORY_RETENTION_DAYS.proposedOrRejected;
    const lastDay = when(at(upgrade, window - 1));
    expect(lastDay.sweepExpired({ actor: alice })).toEqual([]);
    expect(lastDay.list({ actor: alice, past: true }).map((record) => record.recordId)).toEqual([old.recordId]);
    expect(
      when(at(upgrade, window))
        .sweepExpired({ actor: alice })
        .map((entry) => [entry.recordId, entry.outcome]),
    ).toEqual([[old.recordId, "forgotten"]]);
    store.close();
  });

  it("migration 0004_memory_fts_stem backfills pre-existing indexed rows from tavi_memory_fts with matching rowids", () => {
    const dir = directory();
    const dbPath = join(dir, "tavi.sqlite");
    const pre = new Database(dbPath);
    try {
      runMigrations(pre, MIGRATIONS.slice(0, 3));
      // Simulate a pre-0004 baseline database that does not yet have tavi_memory_fts_stem.
      pre.exec("DROP TABLE IF EXISTS tavi_memory_fts_stem");
      const scopeKey = memoryScopeKey(alicePersonal);
      pre.exec(`
        INSERT INTO tavi_memory_records(
          record_id, kind, scope_kind, scope_key, principal_id, status, sensitivity,
          current_revision_id, revocation_generation, recorded_at, updated_at
        ) VALUES ('rec-pre', 'fact', 'personal', '${scopeKey}', 'alice', 'approved', 'normal', 'rev-pre', 0, '${AT}', '${AT}');
        INSERT INTO tavi_memory_revisions(
          revision_id, record_id, revision_number, schema_version, title, body,
          content_hash, author, source_ids_json, recorded_at, sensitivity
        ) VALUES ('rev-pre', 'rec-pre', 1, 1, 'Deployment notes', 'We deployed two services yesterday', 'hash-pre', 'alice', '[]', '${AT}', 'normal');
        INSERT INTO tavi_memory_fts_map(row_id, revision_id)
          VALUES (7, 'rev-pre');
        INSERT INTO tavi_memory_fts(rowid, title, body)
          VALUES (7, 'Deployment notes', 'We deployed two services yesterday');
      `);
    } finally {
      pre.close();
    }

    const { store, service } = open(dir);
    try {
      const hits = service.search({ actor: alice, query: "deploying service" }).hits;
      expect(hits.map((hit) => hit.recordId)).toEqual(["rec-pre"]);
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_fts_stem WHERE rowid = 7")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("migration 0005_memory_fts_keywords adds keywords_json and rebuilds both indexes with a keys column, keeping tavi_memory_fts_map rowids", () => {
    const dir = directory();
    const dbPath = join(dir, "tavi.sqlite");
    const pre = new Database(dbPath);
    try {
      runMigrations(pre, MIGRATIONS.slice(0, 4));
      // Simulate a pre-0005 database: two-column indexes and no keywords_json on revisions.
      pre.exec(`
        DROP TABLE tavi_memory_fts;
        DROP TABLE tavi_memory_fts_stem;
        CREATE VIRTUAL TABLE tavi_memory_fts USING fts5(title, body, tokenize = "unicode61 remove_diacritics 2");
        CREATE VIRTUAL TABLE tavi_memory_fts_stem USING fts5(title, body, tokenize = "porter unicode61 remove_diacritics 2");
        ALTER TABLE tavi_memory_revisions DROP COLUMN keywords_json;
      `);
      const scopeKey = memoryScopeKey(alicePersonal);
      const insertRecord = pre.prepare(`INSERT INTO tavi_memory_records(
          record_id, kind, scope_kind, scope_key, principal_id, status, sensitivity,
          current_revision_id, revocation_generation, recorded_at, updated_at
        ) VALUES (?, 'fact', 'personal', ?, 'alice', 'approved', 'normal', ?, 0, ?, ?)`);
      const insertRevision = pre.prepare(`INSERT INTO tavi_memory_revisions(
          revision_id, record_id, revision_number, schema_version, title, body,
          content_hash, author, source_ids_json, recorded_at, sensitivity
        ) VALUES (?, ?, 1, 1, ?, ?, ?, 'alice', '[]', ?, 'normal')`);
      const rows = [
        { rowId: 3, record: "rec-a", revision: "rev-a", title: "Deployment notes", body: "We deployed two services yesterday" },
        { rowId: 11, record: "rec-b", revision: "rev-b", title: "Garden", body: "Planted tomatoes in April" },
      ];
      for (const row of rows) {
        insertRecord.run(row.record, scopeKey, row.revision, AT, AT);
        insertRevision.run(row.revision, row.record, row.title, row.body, `hash-${row.record}`, AT);
        pre.prepare("INSERT INTO tavi_memory_fts_map(row_id, revision_id) VALUES (?, ?)").run(row.rowId, row.revision);
        for (const table of ["tavi_memory_fts", "tavi_memory_fts_stem"]) {
          pre.prepare(`INSERT INTO ${table}(rowid, title, body) VALUES (?, ?, ?)`).run(row.rowId, row.title, row.body);
        }
      }
    } finally {
      pre.close();
    }

    const { store, service, memory } = open(dir);
    try {
      const columns = (store.handle.prepare("SELECT name FROM pragma_table_info('tavi_memory_revisions')").all() as { name: string }[]).map(
        (row) => row.name,
      );
      expect(columns).toContain("keywords_json");
      expect(store.handle.prepare("SELECT revision_id, keywords_json FROM tavi_memory_revisions ORDER BY revision_id").all()).toEqual([
        { revision_id: "rev-a", keywords_json: "[]" },
        { revision_id: "rev-b", keywords_json: "[]" },
      ]);
      const mapRowIds = (store.handle.prepare("SELECT row_id FROM tavi_memory_fts_map ORDER BY row_id").all() as { row_id: number }[]).map(
        (row) => row.row_id,
      );
      expect(mapRowIds).toEqual([3, 11]);
      for (const table of ["tavi_memory_fts", "tavi_memory_fts_stem"]) {
        expect(store.handle.prepare(`SELECT rowid, title, body, keys FROM ${table} ORDER BY rowid`).all()).toEqual([
          { rowid: 3, title: "Deployment notes", body: "We deployed two services yesterday", keys: "" },
          { rowid: 11, title: "Garden", body: "Planted tomatoes in April", keys: "" },
        ]);
      }
      // "deploying" reaches "deployed" only through the stemmed index.
      expect(service.search({ actor: alice, query: "deploying", match: "all" }).hits.map((hit) => hit.recordId)).toEqual(["rec-a"]);
      expect(memory.rebuildSearchIndex().verified).toBe(true);
      expect(service.search({ actor: alice, query: "tomato", match: "all" }).hits.map((hit) => hit.recordId)).toEqual(["rec-b"]);
    } finally {
      store.close();
    }
  });
});

describe("a restore of an older backup", () => {
  it("memory invariant 9: back up, forget a record, restore the backup: after the next start it is forgotten, with no body, vector, index entry or prompt row", async () => {
    const { live, snapshot, recordId, scopeKey, deletionId, generation } = await forgottenAfterBackup();
    const restored = restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" });
    expect(restored.forgottenMemory).toEqual({ stayForgotten: 1 });
    expect(readdirSync(live).some((name) => name.startsWith("tavi.sqlite.pre-restore-"))).toBe(true);

    // The restored file holds the record again, with the journal row carried over and the scope's generation raised.
    const raw = new Database(join(live, "tavi.sqlite"), { readonly: true });
    try {
      expect(raw.prepare("SELECT status FROM tavi_memory_records WHERE record_id = ?").get(recordId)).toEqual({ status: "approved" });
      expect(raw.prepare("SELECT cleanup_status FROM tavi_memory_deletions WHERE deletion_id = ?").get(deletionId)).toEqual({
        cleanup_status: "complete",
      });
      expect(raw.prepare("SELECT revocation_generation AS g FROM tavi_memory_scope_generations WHERE scope_key = ?").get(scopeKey)).toEqual(
        { g: generation },
      );
      // Its card's prompt row is back too, so the check after the next start can fail.
      expect(raw.prepare("SELECT count(*) AS n FROM tavi_memory_prompts WHERE record_id = ?").get(recordId)).toEqual({ n: 1 });
    } finally {
      raw.close();
    }

    // The next start: the database worker forgets it again before it serves anything.
    const client = await DatabaseClient.open({ databasePath: join(live, "tavi.sqlite") });
    await client.close();

    const reopened = open(live);
    try {
      const { store, service, memory } = reopened;
      expect(memory.getRecord(recordId)).toMatchObject({ status: "deleted" });
      expect(memory.getRecord(recordId)?.currentRevisionId).toBeUndefined();
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_revisions WHERE record_id = ?", recordId)).toBe(0);
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_vectors")).toBe(0);
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_fts WHERE tavi_memory_fts MATCH 'Miso'")).toBe(0);
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_fts_stem WHERE tavi_memory_fts_stem MATCH 'Miso'")).toBe(0);
      expect(service.search({ actor, query: "Miso" }).hits).toEqual([]);
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_prompts WHERE record_id = ?", recordId)).toBe(0);
      expect(count(store, "SELECT count(*) AS n FROM tavi_memory_records WHERE record_id = ? AND content_key IS NOT NULL", recordId)).toBe(
        0,
      );
      // Through the ordinary forget path: a new journal row says why.
      expect(store.handle.prepare("SELECT reason FROM tavi_memory_deletions WHERE record_id = ? ORDER BY reason").all(recordId)).toEqual([
        { reason: "forgotten after the backup" },
        { reason: MEMORY_RESTORE_RECONCILE_REASON },
      ]);
      // Nothing is left for the next start.
      expect(store.reconcileMemoryDeletions()).toEqual({ forgotten: 0, failed: 0 });
    } finally {
      reopened.store.close();
    }
  });

  it("memory invariant 9: honours a copied journal row whose cleanup was still pending, and leaves it pending for the provider resend", async () => {
    const { live, snapshot, recordId, deletionId } = await forgottenAfterBackup({ pending: true });
    expect(restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" }).forgottenMemory).toEqual({
      stayForgotten: 1,
    });
    const client = await DatabaseClient.open({ databasePath: join(live, "tavi.sqlite") });
    await client.close();
    const reopened = open(live);
    try {
      expect(reopened.memory.getRecord(recordId)?.status).toBe("deleted");
      expect(reopened.memory.getDeletion(deletionId)?.cleanupStatus).toBe("pending");
    } finally {
      reopened.store.close();
    }
  });

  it("memory invariant 9: a copied pending row keeps the providers it waits for, so a switch to the built-in since does not complete it unsent", async () => {
    // Forgotten while acme.index was disabled; the workspace then switched to the built-in, and an older backup was restored.
    const { live, snapshot, deletionId } = await forgottenAfterBackup({ pending: true, providers: ["acme.index"] });
    restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" });
    const client = await DatabaseClient.open({ databasePath: join(live, "tavi.sqlite") });
    await client.close();
    const reopened = open(live);
    try {
      expect(reopened.memory.getDeletion(deletionId)).toMatchObject({ cleanupStatus: "pending", pendingProviders: ["acme.index"] });
      expect(reopened.memory.pendingDeletions(10)).toMatchObject([{ deletionId, pendingProviders: ["acme.index"] }]);
    } finally {
      reopened.store.close();
    }
  });

  it("a record a crash left behind its journal row is forgotten at the next start too", async () => {
    const live = join(directory(), "live");
    const { store, service, memory } = open(live);
    const kept = service.remember({ actor, scope, kind: "fact", body: "Lives in Porto" });
    // A journal row naming a record still held, as a cut-short forget would leave it.
    store.handle
      .prepare(
        `INSERT INTO tavi_memory_deletions (deletion_id, record_id, scope_key, deletion_generation, requested_by, reason, requested_at, cleanup_status)
       VALUES ('memdel-crash', ?, ?, 1, 'operator', 'forgotten', ?, 'pending')`,
      )
      .run(kept.recordId, kept.scopeKey, AT);
    expect(store.reconcileMemoryDeletions(LATER)).toEqual({ forgotten: 1, failed: 0 });
    expect(memory.getRecord(kept.recordId)?.status).toBe("deleted");
    store.close();
  });

  it("memory invariant 9: a moved-aside database that cannot be read: the restore completes and warns, naming the snapshot's time", async () => {
    const { live, snapshot } = await forgottenAfterBackup();
    // The live database is unreadable: garbage where a SQLite file should be.
    for (const sidecar of ["tavi.sqlite-wal", "tavi.sqlite-shm"]) rmSync(join(live, sidecar), { force: true });
    writeFileSync(join(live, "tavi.sqlite"), Buffer.alloc(8192, 7));
    const restored = restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" });
    expect(restored.forgottenMemory).toEqual({ unchecked: true, snapshotAt: AT });
    expect(restored.movedAside).not.toBeNull();
    const reopened = open(live);
    reopened.store.close();
  });

  it("keeps a moved-aside database's WAL and shared-memory files with it, under its new name", async () => {
    const { live, snapshot } = await forgottenAfterBackup();
    writeFileSync(join(live, "tavi.sqlite"), Buffer.alloc(8192, 7));
    writeFileSync(join(live, "tavi.sqlite-wal"), "uncheckpointed commits");
    writeFileSync(join(live, "tavi.sqlite-shm"), "shared memory");
    const restored = restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" });
    const movedAside = restored.movedAside as string;
    expect(readFileSync(`${movedAside}-wal`, "utf8")).toBe("uncheckpointed commits");
    expect(existsSync(`${movedAside}-shm`)).toBe(true);
    expect(
      existsSync(join(live, "tavi.sqlite-wal")) && readFileSync(join(live, "tavi.sqlite-wal"), "utf8") === "uncheckpointed commits",
    ).toBe(false);
  });

  it.skipIf(posixOnly || process.getuid?.() === 0)(
    "refuses a restore over a live database it is not allowed to open, moving nothing",
    async () => {
      const { live, snapshot } = await forgottenAfterBackup();
      const target = join(live, "tavi.sqlite");
      chmodSync(target, 0o000);
      try {
        expect(() => restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" })).toThrow();
      } finally {
        chmodSync(target, 0o600);
      }
      expect(readdirSync(live).filter((name) => name.includes("pre-restore"))).toEqual([]);
    },
  );

  it("counts as staying forgotten only what the restored copy holds and has not erased", async () => {
    const { live, snapshot } = await forgottenAfterBackup();
    // Made after the backup, then forgotten: the restored copy never held it, so nothing comes back to forget.
    const after = open(live, LATER);
    const later = after.service.remember({ actor, scope, kind: "fact", body: "Bought a bike" });
    after.service.forget({ actor, recordId: later.recordId, reason: "forgotten after the backup" });
    after.store.close();
    const restored = restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" });
    expect(restored.forgottenMemory).toEqual({ stayForgotten: 1 });
  });

  it("a moved-aside database that is only busy stops the restore rather than saying it was unchecked", async () => {
    const { live, snapshot } = await forgottenAfterBackup();
    // Another process holds the live database exclusively: a read of it is refused as busy, not as corrupt.
    const holder = new Database(join(live, "tavi.sqlite"), { timeout: 0 });
    holder.pragma("locking_mode = EXCLUSIVE");
    holder.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: live, now: "2026-10-12T10:00:00.000Z" })).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^SQLITE_BUSY/) }),
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(readdirSync(live).filter((name) => name.includes("pre-restore") || name.includes(".restore-"))).toEqual([]);
  }, 20_000);

  it("a restore into an empty directory has nothing to reconcile", async () => {
    const { snapshot } = await forgottenAfterBackup();
    const empty = join(directory(), "fresh");
    const restored = restoreSnapshot({ snapshotDirectory: snapshot, dataDirectory: empty, now: "2026-10-12T10:00:00.000Z" });
    expect(restored.movedAside).toBeNull();
    expect(restored.forgottenMemory).toBeUndefined();
  });
});

describe("the providers a pending removal waits for", () => {
  it("names each provider that missed it, and completes only once every one took it", () => {
    const { store, service, memory } = open(directory());
    cleanup.push(() => store.close());
    const record = service.remember({ actor, scope, kind: "fact", body: "Has a cat called Miso" });
    const deletion = service.forget({ actor, recordId: record.recordId, reason: "test" });
    memory.markDeletionPending(deletion.deletionId, ["acme.index"]);
    memory.markDeletionPending(deletion.deletionId, ["zeta.index", "acme.index"]);
    expect(memory.pendingDeletions(10)).toMatchObject([
      { deletionId: deletion.deletionId, cleanupStatus: "pending", pendingProviders: ["acme.index", "zeta.index"] },
    ]);
    memory.completeDeletion({ deletionId: deletion.deletionId, cleanedAt: LATER, providerId: "acme.index" });
    expect(memory.pendingDeletions(10)).toMatchObject([{ deletionId: deletion.deletionId, pendingProviders: ["zeta.index"] }]);
    memory.completeDeletion({ deletionId: deletion.deletionId, cleanedAt: LATER, providerId: "zeta.index" });
    expect(memory.pendingDeletions(10)).toEqual([]);
    const done = memory.getDeletion(deletion.deletionId);
    expect(done).toMatchObject({ cleanupStatus: "complete", cleanedAt: LATER });
    expect(done).not.toHaveProperty("pendingProviders");
  });
});

describe("workspace settings list", () => {
  it("answers every workspace with a stored row, by id", () => {
    const { store } = open(directory());
    cleanup.push(() => store.close());
    const settings = store.asPort().repositories.workspaceSettings;
    expect(settings.list()).toEqual([]);
    settings.set({
      workspaceId: "w2",
      settings: { memory: { provider: "acme.index" } },
      expectedRevision: 0,
      actor: "operator:cli",
      now: AT,
    });
    settings.set({ workspaceId: "default", settings: { timezone: "UTC" }, expectedRevision: 0, actor: "operator:cli", now: AT });
    expect(settings.list().map((record) => [record.workspaceId, record.settings.memory?.provider])).toEqual([
      ["default", undefined],
      ["w2", "acme.index"],
    ]);
  });
});

describe("a chat's fold archives when its history is forgotten", () => {
  /** A chat `chat` (and `other`) in a store with artifacts on disk. */
  function chats() {
    const live = join(directory(), "live");
    mkdirSync(live, { recursive: true });
    const opened = open(live);
    cleanup.push(() => opened.store.close());
    for (const taskId of ["chat", "other"]) {
      opened.store.handle
        .prepare(
          "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES(?, 'default','operator',?,'','completed',?,?)",
        )
        .run(taskId, `thread-${taskId}`, AT, AT);
    }
    /** An archive as the workflow writes one: the folded messages as JSON, under the chat's task id. */
    const archive = (
      artifactId: string,
      taskId: string,
      messages: readonly { id: string; role: string; text: string }[],
      fold?: "summary" | "epoch",
    ) =>
      opened.store.putArtifact({
        artifactId,
        workspaceId: "default",
        runId: taskId,
        contentType: "application/json",
        body: JSON.stringify(messages),
        extension: "json",
        ...(fold === undefined ? {} : { fold }),
      });
    const exists = (artifactId: string): boolean => opened.store.getArtifact(artifactId) !== undefined;
    return { ...opened, archive, exists };
  }
  const later = (): string => new Date(Date.now() + 60_000).toISOString();

  it("memory invariant 9: a forgotten epoch's archive artifacts are gone, tagged ones by their chat; another chat's and the chat's other artifacts stay", async () => {
    const { transcripts, archive, exists } = chats();
    archive("art-epoch-1", "chat", [{ id: "m1", role: "user", text: "hello" }], "epoch");
    archive("art-fold-1", "chat", [{ id: "m2", role: "tool", text: "output" }], "summary");
    archive("art-other-epoch", "other", [{ id: "m3", role: "user", text: "hi" }], "epoch");
    archive("art-chat-upload", "chat", [{ id: "m4", role: "user", text: "a file" }]);
    const result = await transcripts.forget("chat", later());
    expect(result.archives).toBe(2);
    expect(exists("art-epoch-1")).toBe(false);
    expect(exists("art-fold-1")).toBe(false);
    expect(exists("art-other-epoch")).toBe(true);
    expect(exists("art-chat-upload")).toBe(true);
  });

  it("deletes a chat's rendered previews with its history, bodies too, and leaves another chat's", async () => {
    const { transcripts, exists, store } = chats();
    const preview = (artifactId: string, taskId: string, kind: "pdf-fill" | "pdf-render") =>
      store.putArtifact({
        artifactId,
        workspaceId: "default",
        runId: taskId,
        contentType: "image/png",
        body: "png",
        extension: "png",
        preview: kind,
      });
    const filled = preview("art-fill-page", "chat", "pdf-fill");
    preview("art-render-page", "chat", "pdf-render");
    preview("art-other-page", "other", "pdf-fill");
    store.putArtifact({
      artifactId: "art-form",
      workspaceId: "default",
      runId: "chat",
      contentType: "application/pdf",
      body: "%PDF-",
      extension: "pdf",
    });
    expect(store.getArtifact("art-fill-page")?.preview).toBe("pdf-fill");
    // The tag is part of an artifact's identity, and the column holds only known previews.
    expect(() =>
      store.putArtifact({
        artifactId: "art-fill-page",
        workspaceId: "default",
        runId: "chat",
        contentType: "image/png",
        body: "png",
        extension: "png",
        preview: "pdf-render",
      }),
    ).toThrow(/different publication/);
    expect(() => store.handle.prepare("UPDATE tavi_artifacts SET preview = 'other' WHERE artifact_id = 'art-form'").run()).toThrow(
      /CHECK constraint/,
    );
    expect(store.getArtifact("art-form")).not.toHaveProperty("preview");
    const body = store.resolveArtifactPath(filled.relativePath);
    expect(existsSync(body)).toBe(true);
    const result = await transcripts.forget("chat", later());
    // Previews are not fold archives: the count says what was folded.
    expect(result.archives).toBe(0);
    expect(exists("art-fill-page")).toBe(false);
    expect(exists("art-render-page")).toBe(false);
    expect(existsSync(body)).toBe(false);
    expect(exists("art-other-page")).toBe(true);
    expect(exists("art-form")).toBe(true);
  });

  it("erases what a video tool made from an upload with the upload, whichever task made it", async () => {
    const { transcripts, exists, store } = chats();
    store.putArtifact({
      artifactId: "art-up-clip",
      workspaceId: "default",
      runId: "chat",
      contentType: "video/mp4",
      body: "mp4",
      extension: "mp4",
      untrusted: true,
    });
    // A sheet made in this chat, a frame an agent task made from the same upload (trusted, another run), and a frame of a folder file.
    store.putArtifact({
      artifactId: "art-sheet",
      workspaceId: "default",
      runId: "chat",
      contentType: "image/jpeg",
      body: "jpg",
      extension: "jpg",
      preview: "video-sheet",
      derivedFrom: "art-up-clip",
    });
    store.putArtifact({
      artifactId: "art-agent-frame",
      workspaceId: "default",
      runId: "agent-task",
      contentType: "image/jpeg",
      body: "jpg",
      extension: "jpg",
      preview: "video-frame",
      derivedFrom: "art-up-clip",
    });
    store.putArtifact({
      artifactId: "art-folder-frame",
      workspaceId: "default",
      runId: "agent-task",
      contentType: "image/jpeg",
      body: "jpg",
      extension: "jpg",
      preview: "video-frame",
      derivedFrom: `sha256:${"b".repeat(64)}`,
    });
    expect(store.getArtifact("art-agent-frame")).toMatchObject({ preview: "video-frame", derivedFrom: "art-up-clip" });
    // A source is a preview's alone, and part of its identity.
    expect(() =>
      store.putArtifact({
        artifactId: "art-plain",
        workspaceId: "default",
        contentType: "image/jpeg",
        body: "jpg",
        derivedFrom: "art-up-clip",
      }),
    ).toThrow(/only for a preview/);
    expect(() =>
      store.putArtifact({
        artifactId: "art-sheet",
        workspaceId: "default",
        runId: "chat",
        contentType: "image/jpeg",
        body: "jpg",
        extension: "jpg",
        preview: "video-sheet",
        derivedFrom: "art-other",
      }),
    ).toThrow(/different publication/);
    await transcripts.forget("chat", later());
    expect(exists("art-up-clip")).toBe(false);
    expect(exists("art-sheet")).toBe(false);
    expect(exists("art-agent-frame")).toBe(false);
    expect(exists("art-folder-frame")).toBe(true);
  });

  it("keeps an archive written after the instant forgotten before", async () => {
    const { transcripts, archive, exists } = chats();
    archive("art-e1", "chat", [{ id: "m1", role: "user", text: "first words" }], "epoch");
    const cutoff = new Date(Date.now() + 5).toISOString();
    await sleep(20);
    archive("art-e2", "chat", [{ id: "m2", role: "user", text: "second words" }], "epoch");
    const result = await transcripts.forget("chat", cutoff);
    expect(result.archives).toBe(1);
    expect(exists("art-e1")).toBe(false);
    expect(exists("art-e2")).toBe(true);
  });
});
