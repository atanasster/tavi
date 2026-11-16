import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryActor, MemoryScope } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { MemoryService } from "../src/memory/service.js";
import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Forgetting erases every copy (memory invariant 9), the FTS5 segment blobs included.
 *
 * Without FTS5 `secure-delete`, a deleted row only adds a tombstone: its tokens stay in
 * `tavi_memory_fts_data` and `tavi_memory_fts_stem_data` until a merge, and a `VACUUM INTO`
 * backup carries them. Migration `0006_memory_fts_secure_delete` turns the option on for both
 * indexes and merges away what earlier deletes left behind.
 */

const AT = "2026-10-12T08:00:00.000Z";
const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };
const INDEXES = ["tavi_memory_fts", "tavi_memory_fts_stem"] as const;

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

/** Segment blobs of `table` holding `token`'s bytes. Tokens here start with distinct letters, so none is prefix-compressed. */
const blobsHolding = (db: Database.Database, table: string, token: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}_data WHERE instr(block, ?) > 0`).get(Buffer.from(token)) as { n: number }).n;

const secureDelete = (db: Database.Database, table: string): unknown =>
  (db.prepare(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`).get() as { v: unknown } | undefined)?.v;

describe("memory FTS5 secure-delete", () => {
  it("a fresh store has secure-delete on both indexes, and it holds across reopen", () => {
    const databasePath = join(directories.create("tavi-fts-secure-"), "tavi.sqlite");
    new SqliteStore({ databasePath }).close();
    const reopened = new SqliteStore({ databasePath });
    try {
      for (const table of INDEXES) expect(secureDelete(reopened.handle, table)).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("memory invariant 9: a forgotten record's title, body and keyword tokens are gone from both indexes' segment blobs", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      let counter = 0;
      const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
      const kept = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Owns a bicycle" });
      const record = service.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        title: "quokkalia",
        body: "zebrinax",
        keywords: ["yakutskum"],
      });
      const tokens = ["quokkalia", "zebrinax", "yakutskum"];
      // The scan sees the tokens while they are indexed, so their absence afterwards means something.
      for (const table of INDEXES) for (const token of tokens) expect(blobsHolding(store.handle, table, token)).toBeGreaterThan(0);

      service.forget({ actor: alice, recordId: record.recordId, reason: "test" });
      for (const table of INDEXES) for (const token of tokens) expect(blobsHolding(store.handle, table, token)).toBe(0);
      // The record kept beside it is still found.
      expect(service.search({ actor: alice, query: "bicycle" }).hits.map((hit) => hit.recordId)).toEqual([kept.recordId]);
    } finally {
      store.close();
    }
  });

  it("migration 0006_memory_fts_secure_delete merges away the tokens a delete before it left in the segment blobs", () => {
    const databasePath = join(directories.create("tavi-fts-secure-"), "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(pre, MIGRATIONS.slice(0, 5));
      for (const table of INDEXES) {
        expect(secureDelete(pre, table)).toBeUndefined();
        pre.prepare(`INSERT INTO ${table}(rowid, title, body, keys) VALUES (1, 'quokkalia', 'zebrinax', 'yakutskum')`).run();
        pre.prepare(`INSERT INTO ${table}(rowid, title, body, keys) VALUES (2, '', 'bicycle', '')`).run();
        pre.prepare(`DELETE FROM ${table} WHERE rowid = 1`).run();
        // A delete without secure-delete leaves the words in place.
        expect(blobsHolding(pre, table, "zebrinax")).toBeGreaterThan(0);
      }
    } finally {
      pre.close();
    }

    const store = new SqliteStore({ databasePath });
    try {
      for (const table of INDEXES) {
        expect(secureDelete(store.handle, table)).toBe(1);
        for (const token of ["quokkalia", "zebrinax", "yakutskum"]) expect(blobsHolding(store.handle, table, token)).toBe(0);
        expect(store.handle.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'bicycle'`).all()).toEqual([{ rowid: 2 }]);
      }
    } finally {
      store.close();
    }
  });
});
