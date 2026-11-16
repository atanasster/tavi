import {
  MEMORY_FTS_SCHEMA_VERSION,
  memoryScopeKey,
  type MemoryDeletion,
  type MemoryRecord,
  type MemoryRevision,
  type MemoryScope,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { SqliteStore } from "../src/persistence/store.js";
import { describe, expect, it } from "vitest";

/**
 * Personal memory storage.
 *
 * These tests pin the invariants the service relies on: scope filtering happens
 * in SQL, canonical and search state change together, forgetting leaves a
 * content-free receipt, and a concurrent edit is a conflict rather than a silent
 * overwrite.
 */

const AT = "2026-01-01T00:00:00.000Z";

function fixture(): SqliteStore {
  return new SqliteStore({ databasePath: ":memory:", inMemory: true });
}

function record(overrides: {
  readonly recordId: string;
  readonly scope: MemoryScope;
  readonly kind?: MemoryRecord["kind"];
  readonly status?: MemoryRecord["status"];
  readonly preferenceKey?: string;
  readonly currentRevisionId?: string;
  readonly validTo?: string;
  readonly expiryAt?: string;
  readonly updatedAt?: string;
}): MemoryRecord {
  return {
    recordId: overrides.recordId,
    kind: overrides.kind ?? "fact",
    scope: overrides.scope,
    scopeKey: memoryScopeKey(overrides.scope),
    status: overrides.status ?? "approved",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: AT,
    updatedAt: overrides.updatedAt ?? AT,
    ...definedOnly({
      preferenceKey: overrides.preferenceKey,
      currentRevisionId: overrides.currentRevisionId,
      validTo: overrides.validTo,
      expiryAt: overrides.expiryAt,
    }),
  };
}

function revision(overrides: {
  readonly revisionId: string;
  readonly recordId: string;
  readonly body?: string;
  readonly title?: string;
  readonly revisionNumber?: number;
}): MemoryRevision {
  return {
    revisionId: overrides.revisionId,
    recordId: overrides.recordId,
    revisionNumber: overrides.revisionNumber ?? 1,
    schemaVersion: MEMORY_FTS_SCHEMA_VERSION,
    contentHash: `hash-${overrides.revisionId}`,
    author: "operator",
    sourceIds: [],
    recordedAt: AT,
    sensitivity: "normal",
    status: "active",
    ...(overrides.body === undefined ? {} : { body: overrides.body }),
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
  };
}

const personal: MemoryScope = { kind: "personal", principalId: "alice" };
const otherPersonal: MemoryScope = { kind: "personal", principalId: "bob" };

describe("memory scope keys", () => {
  it("is stable, distinct per scope kind, and never a wildcard", () => {
    expect(memoryScopeKey(personal)).toBe("personal|p=alice");
    expect(memoryScopeKey({ kind: "personal_workspace", principalId: "alice", workspaceId: "w1" })).toBe("personal_workspace|p=alice|w=w1");
    expect(memoryScopeKey({ kind: "personal_agent", principalId: "alice", agentId: "a1" })).toBe("personal_agent|p=alice|a=a1");
    expect(memoryScopeKey({ kind: "personal_agent", principalId: "alice", agentId: "a1", workspaceId: "w1" })).toBe(
      "personal_agent|p=alice|a=a1|w=w1",
    );
    expect(memoryScopeKey({ kind: "shared_workspace", workspaceId: "w1" })).toBe("shared_workspace|w=w1");
    expect(memoryScopeKey({ kind: "run_local", principalId: "alice", workspaceId: "w1", runId: "r1" })).toBe("run_local|p=alice|w=w1|r=r1");
    // The workspace-scoped agent variant is a narrower key, not the same one.
    expect(memoryScopeKey({ kind: "personal_agent", principalId: "alice", agentId: "a1" })).not.toBe(
      memoryScopeKey({ kind: "personal_agent", principalId: "alice", agentId: "a1", workspaceId: "w1" }),
    );
  });
});

describe("memory records and scope isolation", () => {
  it("stores a record with its revision and only returns it inside its authorized scope", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m-alice", scope: personal, currentRevisionId: "r-alice" }),
      revision: revision({ revisionId: "r-alice", recordId: "m-alice", body: "Alice prefers tea" }),
    });
    memory.insertRecord({
      record: record({ recordId: "m-bob", scope: otherPersonal, currentRevisionId: "r-bob" }),
      revision: revision({ revisionId: "r-bob", recordId: "m-bob", body: "Bob prefers coffee" }),
    });

    // A query with Alice's authorized keys cannot see Bob's record, and the
    // filter is SQL rather than a post-filter the service could forget.
    const alice = memory.listRecords({ scopeKeys: [memoryScopeKey(personal)], limit: 50 });
    expect(alice.map((entry) => entry.recordId)).toEqual(["m-alice"]);
    expect(memory.listRecords({ scopeKeys: [], limit: 50 })).toEqual([]);
    expect(memory.getRevision("r-bob")?.body).toBe("Bob prefers coffee");
    store.close();
  });

  it("enforces one active approved preference per scope and key", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({
        recordId: "p1",
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        currentRevisionId: "pr1",
      }),
      revision: revision({ revisionId: "pr1", recordId: "p1", body: "dark" }),
    });

    // A second active approved value for the same scope and key is what the
    // partial unique index exists to prevent.
    expect(() =>
      memory.insertRecord({
        record: record({
          recordId: "p2",
          scope: personal,
          kind: "preference",
          preferenceKey: "ui.theme",
          currentRevisionId: "pr2",
        }),
        revision: revision({ revisionId: "pr2", recordId: "p2", body: "light" }),
      }),
    ).toThrowError(/UNIQUE|constraint/i);

    // Closing the previous validity interval is what makes room for a successor.
    expect(
      memory.applyLifecycle({
        recordId: "p1",
        expectedCurrentRevisionId: "pr1",
        status: "superseded",
        validTo: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toBe(true);
    memory.insertRecord({
      record: record({
        recordId: "p3",
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        currentRevisionId: "pr3",
      }),
      revision: revision({ revisionId: "pr3", recordId: "p3", body: "light" }),
    });
    // The rejected duplicate left nothing behind, so the scope holds the
    // superseded original and its successor.
    expect(memory.listRecords({ scopeKeys: [memoryScopeKey(personal)], limit: 50 }).map((entry) => entry.recordId)).toEqual(["p1", "p3"]);
    store.close();
  });

  it("signals a concurrent edit as a false result instead of overwriting", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1" }),
    });
    // The caller's expectation is stale: the stored revision is r1, not r9.
    expect(
      memory.applyLifecycle({
        recordId: "m1",
        expectedCurrentRevisionId: "r9",
        status: "approved",
        updatedAt: AT,
      }),
    ).toBe(false);
    expect(memory.getRecord("m1")?.status).toBe("approved");
    store.close();
  });
});

describe("search and the canonical invariant", () => {
  it("finds an approved current revision and excludes ineligible ones", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "keep", scope: personal, currentRevisionId: "kr" }),
      revision: revision({ revisionId: "kr", recordId: "keep", body: "Alice keeps a garden" }),
    });
    memory.insertRecord({
      record: record({ recordId: "draft", scope: personal, status: "proposed", currentRevisionId: "dr" }),
      revision: revision({ revisionId: "dr", recordId: "draft", body: "Alice gardens too" }),
    });
    memory.insertRecord({
      record: record({
        recordId: "expired",
        scope: personal,
        currentRevisionId: "er",
        expiryAt: "2025-01-01T00:00:00.000Z",
      }),
      revision: revision({ revisionId: "er", recordId: "expired", body: "Alice gardened" }),
    });

    const hits = memory.search({
      scopeKeys: [memoryScopeKey(personal)],
      query: "garden*",
      limit: 10,
      now: "2026-06-01T00:00:00.000Z",
    });
    // Only the approved, unexpired, current revision is a result at any rank.
    expect(hits.map((hit) => hit.record.recordId)).toEqual(["keep"]);
    expect(hits[0]?.snippet.length).toBeGreaterThan(0);
    store.close();
  });

  it("answers a body of up to 300 characters whole, with its title; a longer one as the window around the match", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    const whole = `Alice waters the garden ${"daily ".repeat(46)}`.slice(0, 300);
    const long = `${"Filler words before the match. ".repeat(12)}Alice prunes the orchard in March. ${"More filler afterwards. ".repeat(12)}`;
    memory.insertRecord({
      record: record({ recordId: "short", scope: personal, currentRevisionId: "sr" }),
      revision: revision({ revisionId: "sr", recordId: "short", title: "Garden routine", body: whole }),
    });
    memory.insertRecord({
      record: record({ recordId: "long", scope: personal, currentRevisionId: "lr" }),
      revision: revision({ revisionId: "lr", recordId: "long", title: "Orchard", body: long }),
    });
    const [short] = memory.search({ scopeKeys: [memoryScopeKey(personal)], query: "garden", limit: 10, now: AT });
    expect(Array.from(whole)).toHaveLength(300);
    expect(short).toMatchObject({ record: { recordId: "short" }, revision: { title: "Garden routine" }, snippet: whole });
    const [windowed] = memory.search({ scopeKeys: [memoryScopeKey(personal)], query: "orchard", limit: 10, now: AT });
    expect(windowed?.revision.title).toBe("Orchard");
    expect(windowed?.snippet).toContain("[orchard]");
    expect(windowed?.snippet.length).toBeLessThan(long.length);
    store.close();
  });

  it("keeps the search index out of another scope", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m-bob", scope: otherPersonal, currentRevisionId: "r-bob" }),
      revision: revision({ revisionId: "r-bob", recordId: "m-bob", body: "Bob likes hiking" }),
    });
    const hits = memory.search({
      scopeKeys: [memoryScopeKey(personal)],
      query: "hiking",
      limit: 10,
      now: AT,
    });
    expect(hits).toEqual([]);
    store.close();
  });

  it("leaves no search row behind when the canonical write fails", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "first" }),
    });
    const before = (store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_map").get() as { count: number }).count;

    // A duplicate record id fails inside the transaction: the revision and the
    // search row it would have indexed must not survive.
    expect(() =>
      memory.insertRecord({
        record: record({ recordId: "m1", scope: personal, currentRevisionId: "r2" }),
        revision: revision({ revisionId: "r2", recordId: "m1", body: "second" }),
      }),
    ).toThrowError(/UNIQUE|constraint/i);
    const after = (store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_map").get() as { count: number }).count;
    expect(after).toBe(before);
    expect(memory.getRevision("r2")).toBeUndefined();
    store.close();
  });

  it("rebuilds the index from canonical revisions and verifies coverage", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    for (const id of ["a", "b"]) {
      memory.insertRecord({
        record: record({ recordId: `m-${id}`, scope: personal, currentRevisionId: `r-${id}` }),
        revision: revision({ revisionId: `r-${id}`, recordId: `m-${id}`, body: `note ${id}` }),
      });
    }
    // Simulate index loss: a plain rebuild from FTS content could not repair a
    // disagreement with canonical memory, so the rebuild reads canonical rows.
    store.handle.exec("DELETE FROM tavi_memory_fts");
    store.handle.exec("DELETE FROM tavi_memory_fts_stem");
    store.handle.exec("DELETE FROM tavi_memory_fts_map");

    const result = memory.rebuildSearchIndex();
    expect(result).toEqual({ indexed: 2, verified: true });
    const hits = memory.search({ scopeKeys: [memoryScopeKey(personal)], query: "note", limit: 10, now: AT });
    expect(hits).toHaveLength(2);
    store.close();
  });
});

const seedIdea = (store: SqliteStore, ref: string, kind: "memory" | "task") => {
  const ideas = store.asPort().repositories.ideas;
  ideas.startRun({ runId: `run-${ref}`, workspaceId: "default", trigger: "schedule", now: "2026-03-01T00:00:00.000Z" });
  ideas.store({
    workspaceId: "default",
    runId: `run-${ref}`,
    providerId: "tavi.ideasagent",
    now: "2026-03-01T00:00:00.000Z",
    ideas: [
      {
        id: `idea-${ref}`,
        score: 0.5,
        draft: {
          key: `travel.${ref}`,
          category: "travel",
          icon: "✈️",
          title: "I can watch fares",
          pitch: "A pitch.",
          label: "Watch fares",
          prompt: "Watch fares.",
          basis: [{ kind, ref, excerpt: "what it quoted" }],
          uses: [{ capability: "web", approval: false }],
        },
      },
    ],
  });
  return () => ideas.get("default", `idea-${ref}`);
};

describe("forgetting", () => {
  it("an idea stops quoting a record no longer approved, and keeps its citation (invariant 1)", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m8", scope: personal, currentRevisionId: "r8" }),
      revision: revision({ revisionId: "r8", recordId: "m8", body: "Trip to Porto" }),
    });
    const idea = seedIdea(store, "m8", "memory");
    memory.applyLifecycle({ recordId: "m8", expectedCurrentRevisionId: "r8", status: "revoked", updatedAt: "2026-03-02T00:00:00.000Z" });
    expect(idea()).toMatchObject({ status: "expired", basis: [{ kind: "memory", ref: "m8" }] });
    expect(idea()?.basis[0]).not.toHaveProperty("excerpt");
  });

  it("deletes the ideas that quoted the record", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m9", scope: personal, currentRevisionId: "r9" }),
      revision: revision({ revisionId: "r9", recordId: "m9", body: "Trip to Lisbon" }),
    });
    const idea = seedIdea(store, "m9", "memory");
    expect(idea()).toBeDefined();
    memory.forget({
      recordId: "m9",
      deletion: {
        deletionId: "d9",
        recordId: "m9",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "forget",
        requestedAt: "2026-03-01T00:00:00.000Z",
        cleanupStatus: "complete",
        cleanedAt: "2026-03-01T00:00:00.000Z",
      },
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(idea()).toBeUndefined();
  });

  it("tombstones the record, drops its search row and journals the deletion without a body", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "Alice's tea preference" }),
    });

    const deletion: MemoryDeletion = {
      deletionId: "d1",
      recordId: "m1",
      scopeKey: memoryScopeKey(personal),
      deletionGeneration: 1,
      requestedBy: "alice",
      reason: "no longer relevant",
      requestedAt: "2026-03-01T00:00:00.000Z",
      cleanupStatus: "complete",
      cleanedAt: "2026-03-01T00:00:00.000Z",
    };
    memory.forget({ recordId: "m1", deletion, updatedAt: "2026-03-01T00:00:00.000Z" });

    expect(memory.getRecord("m1")?.status).toBe("deleted");
    // The bodies are gone, so a stale backup or index cannot resurrect them.
    expect(memory.listRevisions("m1")).toEqual([]);
    expect(memory.search({ scopeKeys: [memoryScopeKey(personal)], query: "tea", limit: 10, now: AT })).toEqual([]);
    expect(memory.revocationGeneration(memoryScopeKey(personal))).toBe(1);

    const journal = memory.listDeletions({ scopeKeys: [memoryScopeKey(personal)], limit: 10 });
    expect(journal).toHaveLength(1);
    expect(JSON.stringify(journal[0])).not.toContain("tea");
    // The authoritative read-back for a caller that knows the deletion id.
    // cleanupStatus/cleanedAt in particular are what a caller-built fallback
    // object would get wrong, since the repository always advances them.
    const fetched = memory.getDeletion("d1");
    expect(fetched?.recordId).toBe("m1");
    expect(fetched?.cleanupStatus).toBe("complete");
    expect(fetched?.cleanedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(memory.getDeletion("no-such-id")).toBeUndefined();
    store.close();
  });

  it("refuses to forget a record that does not exist", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    expect(() =>
      memory.forget({
        recordId: "absent",
        deletion: {
          deletionId: "d1",
          recordId: "absent",
          scopeKey: memoryScopeKey(personal),
          deletionGeneration: 1,
          requestedBy: "alice",
          reason: "test",
          requestedAt: AT,
          cleanupStatus: "pending",
        },
        updatedAt: AT,
      }),
    ).toThrowError(/does not exist/);
    store.close();
  });
});

describe("storage invariants the service relies on", () => {
  it("leaves no indexed copy of a forgotten body anywhere", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "SECRETBODY alpha" }),
    });
    memory.forget({
      recordId: "m1",
      deletion: {
        deletionId: "d1",
        recordId: "m1",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    // The search table itself must not hold the body: a query-time join would
    // hide this, so the assertion reads the index directly.
    const indexed = store.handle
      .prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts WHERE tavi_memory_fts MATCH ?")
      .get("SECRETBODY") as { count: number };
    expect(indexed.count).toBe(0);
    const stemmed = store.handle
      .prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_stem WHERE tavi_memory_fts_stem MATCH ?")
      .get("SECRETBODY") as { count: number };
    expect(stemmed.count).toBe(0);
    const mappings = store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_map").get() as {
      count: number;
    };
    expect(mappings.count).toBe(0);
    // The repository, not the caller, decides that cleanup completed.
    const journal = memory.listDeletions({ scopeKeys: [memoryScopeKey(personal)], limit: 10 })[0];
    expect(journal?.cleanupStatus).toBe("complete");
    expect(journal?.cleanedAt).toBe("2026-03-01T00:00:00.000Z");
    store.close();
  });

  it("never revives a tombstoned or revoked record", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "gone soon" }),
    });
    memory.forget({
      recordId: "m1",
      deletion: {
        deletionId: "d1",
        recordId: "m1",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });

    // A stale caller that believes the record is still approved cannot flip it
    // back, even though its expected revision id (null) matches the tombstone.
    expect(
      memory.applyLifecycle({
        recordId: "m1",
        expectedCurrentRevisionId: null,
        status: "approved",
        currentRevisionId: "r1",
        updatedAt: AT,
      }),
    ).toBe(false);
    expect(memory.getRecord("m1")?.status).toBe("deleted");
    store.close();
  });

  it("refuses a record whose declared scope key is not the key of its scope", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    expect(() =>
      memory.insertRecord({
        // Bob's scope key on Alice's scope: exactly the confusion that would make
        // one principal's record readable by another.
        record: { ...record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }), scopeKey: memoryScopeKey(otherPersonal) },
        revision: revision({ revisionId: "r1", recordId: "m1", body: "mine" }),
      }),
    ).toThrowError(/declares scope key/);
    store.close();
  });

  it("requires a preference key so the one-active-value index applies", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    expect(() =>
      memory.insertRecord({
        record: record({ recordId: "p", scope: personal, kind: "preference", currentRevisionId: "pr" }),
        revision: revision({ revisionId: "pr", recordId: "p", body: "dark" }),
      }),
    ).toThrowError(/needs a preference key/);
    store.close();
  });

  it("moves the scope's revocation generation even when another record already had a higher one", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    for (const id of ["a", "b"]) {
      memory.insertRecord({
        record: record({ recordId: `m-${id}`, scope: personal, currentRevisionId: `r-${id}` }),
        revision: revision({ revisionId: `r-${id}`, recordId: `m-${id}`, body: `note ${id}` }),
      });
    }
    memory.forget({
      recordId: "m-a",
      deletion: {
        deletionId: "d1",
        recordId: "m-a",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "first",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });
    const first = memory.revocationGeneration(memoryScopeKey(personal));
    memory.forget({
      recordId: "m-b",
      deletion: {
        deletionId: "d2",
        recordId: "m-b",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "second",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });
    // A per-record MAX would report the same generation for both erasures, so a
    // cache could not tell that the second one happened.
    expect(memory.revocationGeneration(memoryScopeKey(personal))).toBe(first + 1);
    store.close();
  });

  it("makes an approved proposal searchable, and revokes its evidence on forgetting", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, status: "proposed", currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "a proposal about llamas" }),
    });
    // A proposal is not searchable.
    expect(memory.search({ scopeKeys: [memoryScopeKey(personal)], query: "llamas", limit: 10, now: AT })).toEqual([]);

    expect(
      memory.applyLifecycle({
        recordId: "m1",
        expectedCurrentRevisionId: "r1",
        expectedStatus: "proposed",
        status: "approved",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toBe(true);
    // Approval is what makes it findable; indexing only at insert time would
    // leave approved memory permanently unfindable.
    expect(memory.search({ scopeKeys: [memoryScopeKey(personal)], query: "llamas", limit: 10, now: AT })).toHaveLength(1);

    memory.insertEvidence({
      sourceId: "s1",
      scopeKey: memoryScopeKey(personal),
      recordId: "m1",
      revisionId: "r1",
      operatorInput: true,
      observedAt: AT,
      contentHash: "hash-s1",
      captureBasis: "explicit-remember",
      retentionPolicy: "until-forgotten",
      revocationStatus: "active",
    });
    memory.insertLineage({
      edgeId: "e1",
      fromRevisionId: "r1",
      toRevisionId: "r-derived",
      dependencyKind: "contains",
      derivedFreshness: "clean",
      affectedSourceIds: ["s1"],
      lastValidatedGeneration: 0,
    });

    memory.forget({
      recordId: "m1",
      deletion: {
        deletionId: "d1",
        recordId: "m1",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });
    // Evidence stops being usable and dependent lineage is blocked, both without
    // carrying any deleted content.
    expect(memory.listEvidence({ scopeKeys: [memoryScopeKey(personal)], limit: 10 })[0]?.revocationStatus).toBe("revoked");
    const edge = memory.listLineage({ toRevisionId: "r-derived" })[0];
    expect(edge?.derivedFreshness).toBe("blocked");
    expect(edge?.freshnessReason).toBe("source forgotten (contained content must be excluded and regenerated)");
    // `contains` also records which forgotten record a regenerator must
    // exclude, unlike `requires`/`background`, which have no equivalent.
    // The pre-existing "s1" entry must survive: this is a merge, not a
    // replace, so a later regression that overwrites the array would show
    // up here as a missing "s1".
    expect(edge?.affectedSourceIds).toEqual(expect.arrayContaining(["s1", "m1"]));
    expect(edge?.affectedSourceIds).toHaveLength(2);
    store.close();
  });

  it("accumulates affectedSourceIds across two separate forgets of different records sharing a `contains` edge", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "first ingredient" }),
    });
    memory.insertRecord({
      record: record({ recordId: "m2", scope: personal, currentRevisionId: "r2" }),
      revision: revision({ revisionId: "r2", recordId: "m2", body: "second ingredient" }),
    });
    memory.insertLineage({
      edgeId: "e-shared",
      fromRevisionId: "r1",
      toRevisionId: "r-derived",
      dependencyKind: "contains",
      derivedFreshness: "clean",
      affectedSourceIds: [],
      lastValidatedGeneration: 0,
    });
    memory.insertLineage({
      edgeId: "e-shared-2",
      fromRevisionId: "r2",
      toRevisionId: "r-derived",
      dependencyKind: "contains",
      derivedFreshness: "clean",
      affectedSourceIds: [],
      lastValidatedGeneration: 0,
    });

    memory.forget({
      recordId: "m1",
      deletion: {
        deletionId: "d1",
        recordId: "m1",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });
    memory.forget({
      recordId: "m2",
      deletion: {
        deletionId: "d2",
        recordId: "m2",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });

    const edges = memory.listLineage({ toRevisionId: "r-derived" });
    const edgeFromM1 = edges.find((e) => e.edgeId === "e-shared");
    const edgeFromM2 = edges.find((e) => e.edgeId === "e-shared-2");
    // Each edge accumulates only the forgotten record on its own
    // fromRevisionId side; the two forgets over time don't clobber each
    // other's affectedSourceIds.
    expect(edgeFromM1?.affectedSourceIds).toEqual(["m1"]);
    expect(edgeFromM2?.affectedSourceIds).toEqual(["m2"]);
    store.close();
  });

  it("updates each `contains` edge from the same forgotten revision independently", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "shared source" }),
    });
    memory.insertLineage({
      edgeId: "e-a",
      fromRevisionId: "r1",
      toRevisionId: "r-a",
      dependencyKind: "contains",
      derivedFreshness: "clean",
      affectedSourceIds: ["pre-a"],
      lastValidatedGeneration: 0,
    });
    memory.insertLineage({
      edgeId: "e-b",
      fromRevisionId: "r1",
      toRevisionId: "r-b",
      dependencyKind: "contains",
      derivedFreshness: "clean",
      affectedSourceIds: ["pre-b"],
      lastValidatedGeneration: 0,
    });

    memory.forget({
      recordId: "m1",
      deletion: {
        deletionId: "d1",
        recordId: "m1",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });

    const edgeA = memory.listLineage({ toRevisionId: "r-a" })[0];
    const edgeB = memory.listLineage({ toRevisionId: "r-b" })[0];
    expect(edgeA?.derivedFreshness).toBe("blocked");
    expect(edgeA?.affectedSourceIds).toEqual(expect.arrayContaining(["pre-a", "m1"]));
    expect(edgeA?.affectedSourceIds).toHaveLength(2);
    expect(edgeB?.derivedFreshness).toBe("blocked");
    expect(edgeB?.affectedSourceIds).toEqual(expect.arrayContaining(["pre-b", "m1"]));
    expect(edgeB?.affectedSourceIds).toHaveLength(2);
    store.close();
  });

  it("marks a `requires` dependency blocked and a `background` dependency dirty on forget, not both blocked", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "a fact" }),
    });
    memory.insertLineage({
      edgeId: "e-requires",
      fromRevisionId: "r1",
      toRevisionId: "r-required-by",
      dependencyKind: "requires",
      derivedFreshness: "clean",
      affectedSourceIds: [],
      lastValidatedGeneration: 0,
    });
    memory.insertLineage({
      edgeId: "e-background",
      fromRevisionId: "r1",
      toRevisionId: "r-cited-by",
      dependencyKind: "background",
      derivedFreshness: "clean",
      affectedSourceIds: [],
      lastValidatedGeneration: 0,
    });

    memory.forget({
      recordId: "m1",
      deletion: {
        deletionId: "d1",
        recordId: "m1",
        scopeKey: memoryScopeKey(personal),
        deletionGeneration: 1,
        requestedBy: "alice",
        reason: "erasure",
        requestedAt: AT,
        cleanupStatus: "pending",
      },
      updatedAt: AT,
    });

    const requiresEdge = memory.listLineage({ toRevisionId: "r-required-by" })[0];
    expect(requiresEdge?.derivedFreshness).toBe("blocked");
    expect(requiresEdge?.freshnessReason).toBe("source forgotten (required dependency)");
    // No content to exclude-and-regenerate for `requires` — unlike `contains`.
    expect(requiresEdge?.affectedSourceIds).toEqual([]);

    const backgroundEdge = memory.listLineage({ toRevisionId: "r-cited-by" })[0];
    // Dirty, not blocked: "ordinary staleness does not cancel unrelated work".
    expect(backgroundEdge?.derivedFreshness).toBe("dirty");
    expect(backgroundEdge?.freshnessReason).toBe("source forgotten (background citation, needs review)");
    store.close();
  });
});

describe("evidence, reviews and lineage", () => {
  it("stores evidence, review decisions over exact revisions, and dependency edges", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "m1", scope: personal, currentRevisionId: "r1" }),
      revision: revision({ revisionId: "r1", recordId: "m1", body: "a fact" }),
    });
    memory.insertEvidence({
      sourceId: "s1",
      scopeKey: memoryScopeKey(personal),
      recordId: "m1",
      revisionId: "r1",
      operatorInput: true,
      observedAt: AT,
      contentHash: "hash-s1",
      captureBasis: "explicit-remember",
      retentionPolicy: "until-forgotten",
      revocationStatus: "active",
      claimedAuthor: "Alice (claimed)",
    });
    expect(memory.listEvidence({ scopeKeys: [memoryScopeKey(personal)], limit: 10 })).toHaveLength(1);

    memory.recordReview({
      reviewId: "rev1",
      recordId: "m1",
      revisionId: "r1",
      revisionHash: "hash-r1",
      reviewerPrincipalId: "alice",
      decision: "approved",
      decidedAt: AT,
    });
    expect(memory.listReviews("m1")).toHaveLength(1);

    memory.insertLineage({
      edgeId: "e1",
      fromRevisionId: "r0",
      toRevisionId: "r1",
      dependencyKind: "contains",
      derivedFreshness: "clean",
      affectedSourceIds: ["s1"],
      lastValidatedGeneration: 0,
    });
    expect(memory.listLineage({ toRevisionId: "r1" })).toHaveLength(1);
    store.close();
  });

  it("rejects a stored enum the migration constrains", () => {
    const store = fixture();
    expect(() =>
      store.handle
        .prepare(
          `INSERT INTO tavi_memory_records
             (record_id, scope_key, scope_kind, principal_id, kind, status, sensitivity,
              revocation_generation, recorded_at, updated_at)
           VALUES ('x', 'k', 'nowhere', 'p', 'fact', 'approved', 'normal', 0, '${AT}', '${AT}')`,
        )
        .run(),
    ).toThrowError(/CHECK|constraint/i);
    store.close();
  });
});

describe("correctRevision atomicity", () => {
  it("writes nothing when the compare-and-set loses, leaving no orphan revision", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "c1", scope: personal, status: "approved", currentRevisionId: "cr1" }),
      revision: revision({ revisionId: "cr1", recordId: "c1", body: "v1" }),
    });

    // A concurrent correction wins first, moving current_revision_id to cr2.
    expect(
      memory.correctRevision({
        recordId: "c1",
        expectedCurrentRevisionId: "cr1",
        revision: revision({ revisionId: "cr2", recordId: "c1", body: "v2", revisionNumber: 2 }),
        now: "2026-02-01T00:00:00.000Z",
      }),
    ).toBe(true);

    // A second, now-stale correction still expects cr1 to be current.
    expect(
      memory.correctRevision({
        recordId: "c1",
        expectedCurrentRevisionId: "cr1",
        revision: revision({ revisionId: "cr3", recordId: "c1", body: "PHANTOM-CORRECTION", revisionNumber: 2 }),
        now: "2026-02-02T00:00:00.000Z",
      }),
    ).toBe(false);

    const revisions = memory.listRevisions("c1");
    expect(revisions).toHaveLength(2);
    expect(revisions.some((r) => r.revisionId === "cr3" || r.body === "PHANTOM-CORRECTION")).toBe(false);
    expect(memory.getRecord("c1")?.currentRevisionId).toBe("cr2");
    store.close();
  });
});

describe("applyLifecycle preserves omitted validity fields", () => {
  it("does not null out validFrom when a caller (e.g. revoke) supplies only validTo", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "v1", scope: personal, currentRevisionId: "vr1" }),
      revision: revision({ revisionId: "vr1", recordId: "v1", body: "value" }),
    });
    expect(
      memory.applyLifecycle({
        recordId: "v1",
        expectedCurrentRevisionId: "vr1",
        status: "approved",
        currentRevisionId: "vr1",
        validFrom: AT,
        updatedAt: AT,
      }),
    ).toBe(true);
    expect(memory.getRecord("v1")?.validFrom).toBe(AT);

    // Revoking supplies only validTo; validFrom must survive untouched.
    expect(
      memory.applyLifecycle({
        recordId: "v1",
        expectedCurrentRevisionId: "vr1",
        expectedStatus: "approved",
        status: "revoked",
        validTo: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        reindexOnApproval: false,
      }),
    ).toBe(true);
    const record1 = memory.getRecord("v1");
    expect(record1?.validFrom).toBe(AT);
    expect(record1?.validTo).toBe("2026-03-01T00:00:00.000Z");
    store.close();
  });
});

describe("usage", () => {
  it("counts a record once and charges bytes for the current revision only, in UTF-8 bytes", () => {
    const store = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertRecord({
      record: record({ recordId: "u1", scope: personal, currentRevisionId: "ur1" }),
      revision: revision({ revisionId: "ur1", recordId: "u1", body: "v1" }),
    });
    expect(
      memory.correctRevision({
        recordId: "u1",
        expectedCurrentRevisionId: "ur1",
        revision: revision({ revisionId: "ur2", recordId: "u1", body: "café 日本語", revisionNumber: 2 }),
        now: "2026-02-01T00:00:00.000Z",
      }),
    ).toBe(true);

    const usage = memory.usage([memoryScopeKey(personal)]);
    expect(usage.records).toBe(1);
    // Only ur2's bytes (UTF-8, not characters, and not summed with the
    // superseded ur1).
    expect(usage.bytes).toBe(Buffer.byteLength("café 日本語", "utf8"));
    store.close();
  });
});
