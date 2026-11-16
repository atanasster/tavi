import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { memoryScopeKey, type MemoryActor, type MemoryScope } from "@tavi/contracts";
import { APPLICATION_TABLES } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";

import { MemoryService } from "../src/memory/service.js";
import { createSnapshot, restoreSnapshot } from "../src/persistence/administration.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Memory's tables through a backup: each
 * joined `APPLICATION_TABLES` in the step that created it, and each has its
 * own round-trip there; this is the regression over all of them at once.
 * Every memory table holds a row before the snapshot, and the restore gives
 * back the same rows, so a later table that skips the declaration fails here
 * as well as in the completeness test.
 */

const AT = "2026-10-12T08:00:00.000Z";
const MODEL = "fixture/embed-1";

/** Memory's tables: the service's own and the evidence and lineage it keeps. */
const MEMORY_TABLES = APPLICATION_TABLES.filter(
  (table) => table.startsWith("tavi_memory_") || table === "tavi_evidence_sources" || table === "tavi_lineage_edges",
);

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

const rowsOf = (store: SqliteStore, table: string): unknown[] => store.handle.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();

describe("a backup of memory", () => {
  it("restores every memory table, row for row", async () => {
    const root = directories.create("tavi-memory-backup-");
    const source = join(root, "source");
    const target = join(root, "target");

    const store = new SqliteStore({ databasePath: join(source, "tavi.sqlite") });
    const persistence = store.asPort();
    let counter = 0;
    const service = new MemoryService(persistence, { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
    const memory = persistence.repositories.memory;
    const actor: MemoryActor = { principalId: "operator", workspaceId: "default", runId: "chat", caller: "cli", authority: "operator" };
    const scope: MemoryScope = { kind: "personal", principalId: "operator" };
    const revisionOf = (recordId: string): string => memory.getRecord(recordId)!.currentRevisionId!;

    // Records, revisions, reviews and the search map: one remembered and corrected, one proposed and approved.
    const kept = service.remember({ actor, scope, kind: "fact", body: "Based in Lisbon" });
    service.correct({ actor, recordId: kept.recordId, body: "Based in Porto" });
    const proposed = service.propose({ actor, scope, kind: "fact", body: "Works at Acme" });
    service.approve({ actor, recordId: proposed.recordId });
    // A forget: its deletion journal row and the scope's revocation generation.
    const gone = service.remember({ actor, scope, kind: "fact", body: "Has a cat" });
    service.forget({ actor, recordId: gone.recordId, reason: "test" });
    // Evidence and lineage, written as the knowledge path writes them.
    memory.insertEvidence({
      sourceId: "source-1",
      scopeKey: memoryScopeKey(scope),
      operatorInput: true,
      observedAt: AT,
      contentHash: "h",
      captureBasis: "explicit",
      retentionPolicy: "standard",
      revocationStatus: "active",
      recordId: kept.recordId,
    });
    memory.insertLineage({
      edgeId: "edge-1",
      fromRevisionId: revisionOf(kept.recordId),
      toRevisionId: revisionOf(proposed.recordId),
      dependencyKind: "background",
      derivedFreshness: "clean",
      affectedSourceIds: [],
      lastValidatedGeneration: 0,
    });
    // Hybrid recall's vectors and the backfill's failures.
    memory.putVectors({ vectors: [{ revisionId: revisionOf(kept.recordId), modelKey: MODEL, vector: [1, 0, 0, 0] }], now: AT });
    memory.recordVectorFailures({ revisionIds: [revisionOf(proposed.recordId)], modelKey: MODEL, now: AT });
    // A chat's memory card and its rows, and a mark.
    store.handle
      .prepare(
        "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('chat','default','operator','t','','completed',?,?)",
      )
      .run(AT, AT);
    const transcripts = persistence.repositories.transcripts;
    await transcripts.postMemoryCard({
      noticeId: "card-1",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: AT,
      records: [{ recordId: kept.recordId, workspaceId: "default", principalId: "operator" }],
    });
    expect(await transcripts.claimMemoryMark({ taskId: "chat", kind: "digest", mark: "2026-10-12", at: AT })).toBe(true);

    const before = new Map(MEMORY_TABLES.map((table) => [table, rowsOf(store, table)]));
    for (const [table, rows] of before) expect(rows.length, `${table} holds a row before the backup`).toBeGreaterThan(0);
    store.close();

    createSnapshot({
      dataDirectory: source,
      outDirectory: join(root, "snap"),
      buildId: "test",
      now: AT,
      includeArtifacts: false,
      includeCredentials: false,
      force: false,
    });
    new SqliteStore({ databasePath: join(target, "tavi.sqlite") }).close();
    restoreSnapshot({ snapshotDirectory: join(root, "snap"), dataDirectory: target, now: AT });
    const restored = new SqliteStore({ databasePath: join(target, "tavi.sqlite") });
    try {
      for (const table of MEMORY_TABLES) expect(rowsOf(restored, table), table).toEqual(before.get(table));
      expect(restored.asPort().repositories.memory.getRecord(kept.recordId)?.status).toBe("approved");
    } finally {
      restored.close();
    }
  });
});
