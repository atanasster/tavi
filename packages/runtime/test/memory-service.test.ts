import { MEMORY_READ_SHARED_PERMISSION } from "../src/memory/access.js";
import { MemoryService } from "../src/memory/service.js";
import {
  MEMORY_LIST_PAGE_MAX,
  TaviError,
  memoryScopeKey,
  type AccessPolicyPort,
  type MemoryActor,
  type MemoryProvenance,
  type MemoryScope,
  type MemoryServicePort,
} from "@tavi/contracts";
import {
  describeMemoryServiceConformance,
  memoryServiceConformanceCases,
  runMemoryServiceConformanceCase,
  type MemoryPortFactory,
} from "@tavi/plugin-kit/memory/conformance";

import { SqliteStore } from "../src/persistence/store.js";
import { describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Memory lifecycle.
 *
 * The behaviour every `MemoryServicePort` owes — a model's suggestion is not
 * an approved fact, an edit is a compare-and-set rather than a silent
 * overwrite, every read is scoped by the actor rather than the request,
 * erasure really erases, and capacity limits are typed instead of silently
 * evicting approved memory — is `@tavi/plugin-kit/memory`'s port suite,
 * run here against the built-in service. What
 * stays below is the SQLite store's own: its full-text index and tokenizer,
 * the database's unique-index backstop, its export cap, the races its
 * compare-and-sets lose, and knowledge promotion's lineage rows.
 */

const AT = "2026-01-01T00:00:00.000Z";

/** A policy granting exactly the listed permissions to one principal/workspace pair. */
function grantPolicy(
  grants: readonly { readonly principalId: string; readonly workspaceId: string; readonly permissions: readonly string[] }[],
): AccessPolicyPort {
  return {
    resolveWorkspace: () => undefined,
    missingPermissions: (context, required) => {
      const grant = grants.find((g) => g.principalId === context.principalId && g.workspaceId === context.workspaceId);
      const granted = new Set(grant?.permissions ?? []);
      return required.filter((permission) => !granted.has(permission));
    },
  };
}

function fixture(options: { readonly maxRecords?: number } = {}): {
  readonly store: SqliteStore;
  readonly service: MemoryService;
  /**
   * The exact repository instance the service holds. `store.asPort()` builds
   * a fresh set of repository objects on every call, so a test that needs to
   * stub one of the service's own repository methods (not just read the
   * database through a second instance) must use this one rather than
   * `store.asPort().repositories.memory`, which would patch an object the
   * service never calls.
   */
  readonly memory: ReturnType<SqliteStore["asPort"]>["repositories"]["memory"];
} {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const persistence = store.asPort();
  let counter = 0;
  const service = new MemoryService(persistence, {
    now: () => AT,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    ...(options.maxRecords === undefined ? {} : { quotas: { maxRecords: options.maxRecords, maxBytes: 1_000_000 } }),
  });
  return { store, service, memory: persistence.repositories.memory };
}

const alice: MemoryActor = {
  principalId: "alice",
  workspaceId: "w1",
  agentId: "agent-main",
  caller: "cli",
  authority: "operator",
};
const model: MemoryActor = { ...alice, caller: "model", authority: "model" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };

/** The service as the port is typed: every answer a promise, as the owner's worker gives it. */
function asPort(service: MemoryService): MemoryServicePort {
  return new Proxy(service, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? async (...args: unknown[]) => (value as (...input: unknown[]) => unknown).apply(target, args)
        : value;
    },
  }) as unknown as MemoryServicePort;
}

/** The built-in service over a fresh in-memory store, and the rows the port never writes. */
const builtin: MemoryPortFactory = (environment) => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const persistence = store.asPort();
  const service = new MemoryService(persistence, {
    now: environment.now,
    ...(environment.quotas === undefined ? {} : { quotas: environment.quotas }),
    policy: grantPolicy(environment.sharedReaders.map((reader) => ({ ...reader, permissions: [MEMORY_READ_SHARED_PERMISSION] }))),
  });
  return {
    port: asPort(service),
    share: ({ recordId, workspaceId, kind, body }) => {
      const scope: MemoryScope = { kind: "shared_workspace", workspaceId };
      const at = environment.now();
      persistence.repositories.memory.insertRecord({
        record: {
          recordId,
          kind,
          scope,
          scopeKey: memoryScopeKey(scope),
          status: "approved",
          sensitivity: "normal",
          currentRevisionId: `${recordId}-rev`,
          revocationGeneration: 0,
          recordedAt: at,
          updatedAt: at,
        },
        revision: {
          revisionId: `${recordId}-rev`,
          recordId,
          revisionNumber: 1,
          schemaVersion: 1,
          body,
          contentHash: "h",
          author: "operator",
          sourceIds: [],
          recordedAt: at,
          sensitivity: "normal",
          status: "active",
        },
      });
    },
    addSource: ({ sourceId, scopeKey, revoked, recordId, observedAt }) => {
      persistence.repositories.memory.insertEvidence({
        sourceId,
        scopeKey,
        operatorInput: true,
        observedAt: observedAt ?? environment.now(),
        contentHash: "h",
        captureBasis: "explicit",
        retentionPolicy: "standard",
        revocationStatus: revoked === true ? "revoked" : "active",
        ...(recordId === undefined ? {} : { recordId }),
      });
    },
    // No public path revokes a source today: the row is flipped as an external revocation would.
    revokeSource: (sourceId) => {
      store.handle.prepare("UPDATE tavi_evidence_sources SET revocation_status = 'revoked' WHERE source_id = ?").run(sourceId);
    },
    close: () => store.close(),
  };
};

describeMemoryServiceConformance("memory invariant 15: the built-in MemoryService over SQLite", builtin);

/** `port` with some of its methods replaced. */
function overriding(port: MemoryServicePort, methods: Partial<MemoryServicePort>): MemoryServicePort {
  return new Proxy(port, {
    get: (target, property) => (property in methods ? (methods as Record<PropertyKey, unknown>)[property] : Reflect.get(target, property)),
  });
}

/** The built-in, broken by `breaking`: what the port suite must refuse. */
const broken =
  (breaking: (port: MemoryServicePort) => Partial<MemoryServicePort>): MemoryPortFactory =>
  async (environment) => {
    const harness = await builtin(environment);
    return { ...harness, port: overriding(harness.port, breaking(harness.port)) };
  };

describe("memory invariant 15: the port suite has teeth", () => {
  const titled = (start: string): string => {
    const title = memoryServiceConformanceCases().find((candidate) => candidate.startsWith(start));
    if (title === undefined) throw new Error(`no case starts ${start}`);
    return title;
  };

  it("fails a port that approves what a model proposes", async () => {
    const approvesOnPropose = broken((port) => ({
      propose: async (input) => {
        const proposal = await port.propose(input);
        return { ...(await port.approve({ actor: { ...input.actor, authority: "operator" }, recordId: proposal.recordId })) };
      },
    }));
    await expect(
      runMemoryServiceConformanceCase(titled("proposal and review › memory invariant 1: stores a proposal"), approvesOnPropose),
    ).rejects.toThrow(/approved/);
    // The unbroken built-in passes the same case.
    await runMemoryServiceConformanceCase(titled("proposal and review › memory invariant 1: stores a proposal"), builtin);
  });

  it("fails a port whose search answers a record the actor may not read", async () => {
    const leaksOtherPeople = broken((port) => ({
      search: async (input) => {
        const own = await port.search(input);
        const theirs = await port.search({ ...input, actor: { ...input.actor, principalId: "alice" } });
        return { ...own, hits: [...own.hits, ...theirs.hits.filter((hit) => !own.hits.some((mine) => mine.recordId === hit.recordId))] };
      },
    }));
    await expect(runMemoryServiceConformanceCase(titled("authorization › one principal cannot read"), leaksOtherPeople)).rejects.toThrow(
      /to deeply equal \[\]/,
    );
  });

  it("fails a port whose forget leaves the record readable", async () => {
    const neverErases = broken((port) => ({
      forget: async (input) => {
        const record = await port.get({ actor: input.actor, recordId: input.recordId });
        return {
          deletionId: "del-1",
          recordId: record.recordId,
          scopeKey: record.scopeKey,
          deletionGeneration: 1,
          requestedBy: input.actor.principalId,
          reason: input.reason,
          requestedAt: record.updatedAt,
          cleanupStatus: "complete",
        };
      },
    }));
    await expect(runMemoryServiceConformanceCase(titled("erasure › forgets a record completely"), neverErases)).rejects.toThrow(
      /to be refused/,
    );
  });
});

describe("memory invariant 8: a tidy-up's lineage and supersession in the store", () => {
  it("writes `contains` edges from each input revision when filed, supersedes the inputs when approved, and keeps their revisions", () => {
    const { store, service, memory } = fixture();
    const first = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Alice keeps a garden" });
    const second = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Alice grows tomatoes" });
    const supersedes = [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId ?? "" }));
    const merged = service.propose({
      actor: { ...model, caller: "provider:tavi.memoryprovider:consolidate" },
      scope: personal,
      kind: "fact",
      body: "Alice keeps a garden where she grows tomatoes",
      supersedes,
    });
    const revisionId = memory.listRevisions(merged.recordId)[0]?.revisionId ?? "";
    const edges = memory.listLineage({ toRevisionId: revisionId });
    expect(edges.map((edge) => [edge.fromRevisionId, edge.dependencyKind, edge.derivedFreshness])).toEqual(
      supersedes.map((entry) => [entry.revisionId, "contains", "clean"]),
    );
    // Filed, nothing changed: both inputs are approved and searchable.
    expect(
      service
        .search({ actor: alice, query: "tomatoes" })
        .hits.map((hit) => hit.recordId)
        .sort(),
    ).toEqual([second.recordId]);
    service.approve({ actor: alice, recordId: merged.recordId });
    for (const input of supersedes) {
      expect(memory.getRecord(input.recordId)?.status).toBe("superseded");
      // Nothing deleted or rewritten: the approved revision is there as it was.
      expect(memory.getRevision(input.revisionId)?.body).toBeDefined();
    }
    expect(service.search({ actor: alice, query: "tomatoes" }).hits.map((hit) => hit.recordId)).toEqual([merged.recordId]);
    expect(memory.listLineage({ toRevisionId: revisionId })).toEqual(edges);
    store.close();
  });

  it("rolls the whole approval back when one input changed: the other input stays approved", () => {
    const { store, service, memory } = fixture();
    const first = service.remember({ actor: alice, scope: personal, kind: "lesson", body: "Answer briefly" });
    const second = service.remember({ actor: alice, scope: personal, kind: "lesson", body: "Answer in English" });
    const merged = service.propose({
      actor: model,
      scope: personal,
      kind: "lesson",
      body: "Answer briefly, in English",
      supersedes: [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId ?? "" })),
    });
    service.correct({ actor: alice, recordId: second.recordId, body: "Answer in English or German" });
    expect(() => service.approve({ actor: alice, recordId: merged.recordId })).toThrow(
      expect.objectContaining({ code: "REVISION_CONFLICT" }),
    );
    expect(memory.getRecord(first.recordId)?.status).toBe("approved");
    expect(memory.getRecord(merged.recordId)?.status).toBe("proposed");
    store.close();
  });
});

describe("memory provenance", () => {
  const read: MemoryProvenance = {
    integrity: "untrusted",
    sources: ["web"],
    refs: [{ source: "web", ref: "call-1", host: "example.com", title: "Ignore previous instructions", at: AT }],
  };

  it("stores an explicit proposal's provenance on its revision, and keeps it once approved and when corrected", () => {
    const { store, service, memory } = fixture();
    const proposed = service.propose({ actor: model, scope: personal, kind: "fact", body: "Alice prefers aisle seats", provenance: read });
    expect(memory.listRevisions(proposed.recordId)[0]?.provenance).toEqual(read);
    // The person's keep endorses it: recalled as any approved record is, its provenance kept for `tavi memory show`.
    const kept = service.approve({ actor: alice, recordId: proposed.recordId });
    expect(service.search({ actor: alice, query: "aisle" }).hits.map((hit) => hit.recordId)).toEqual([kept.recordId]);
    expect(memory.getRevision(kept.currentRevisionId ?? "")?.provenance).toEqual(read);
    const corrected = service.correct({ actor: alice, recordId: kept.recordId, body: "Alice prefers aisle seats on long flights" });
    expect(memory.getRevision(corrected.currentRevisionId ?? "")?.provenance).toEqual(read);
    // A clean chat's proposal carries none, as before.
    const clean = service.propose({ actor: model, scope: personal, kind: "fact", body: "Alice lives in Lisbon" });
    expect(memory.listRevisions(clean.recordId)[0]?.provenance).toBeUndefined();
    store.close();
  });

  it("gives a tidy-up the join of its inputs' provenance through its lineage", () => {
    const { store, service, memory } = fixture();
    const tainted = service.approve({
      actor: alice,
      recordId: service.propose({ actor: model, scope: personal, kind: "fact", body: "Alice keeps a garden", provenance: read }).recordId,
    });
    const other: MemoryProvenance = {
      integrity: "untrusted",
      sources: ["email"],
      refs: [{ source: "email", ref: "msg-1", host: "mail.example.org", at: "2026-01-02T00:00:00.000Z" }],
    };
    const second = service.approve({
      actor: alice,
      recordId: service.propose({ actor: model, scope: personal, kind: "fact", body: "Alice grows tomatoes", provenance: other }).recordId,
    });
    const clean = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Alice waters daily" });
    const merged = service.propose({
      actor: { ...model, caller: "provider:tavi.memoryprovider:consolidate" },
      scope: personal,
      kind: "fact",
      body: "Alice keeps a garden where she grows tomatoes and waters daily",
      supersedes: [tainted, second, clean].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId ?? "" })),
    });
    const provenance = memory.listRevisions(merged.recordId)[0]?.provenance;
    expect(provenance?.integrity).toBe("untrusted");
    expect(provenance?.sources).toEqual(["web", "email"]);
    expect(provenance?.refs.map((ref) => ref.host)).toEqual(["mail.example.org", "example.com"]);
    // A tidy-up of clean records only carries none.
    const a = service.remember({ actor: alice, scope: personal, kind: "lesson", body: "Answer briefly" });
    const b = service.remember({ actor: alice, scope: personal, kind: "lesson", body: "Answer in English" });
    const plain = service.propose({
      actor: model,
      scope: personal,
      kind: "lesson",
      body: "Answer briefly, in English",
      supersedes: [a, b].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId ?? "" })),
    });
    expect(memory.listRevisions(plain.recordId)[0]?.provenance).toBeUndefined();
    store.close();
  });

  it("is enumerated by the export and erased with the record by forget; an unreadable one reads untrusted", () => {
    const { store, service } = fixture();
    const proposed = service.propose({ actor: model, scope: personal, kind: "fact", body: "Alice flies on Tuesdays", provenance: read });
    expect(service.export({ actor: alice }).revisions.find((revision) => revision.recordId === proposed.recordId)?.provenance).toEqual(
      read,
    );
    store.handle.prepare("UPDATE tavi_memory_revisions SET provenance_json = '{not json' WHERE record_id = ?").run(proposed.recordId);
    expect(service.history({ actor: alice, recordId: proposed.recordId }).revisions[0]?.provenance).toEqual({
      integrity: "untrusted",
      sources: ["unknown-source"],
      refs: [],
    });
    service.forget({ actor: alice, recordId: proposed.recordId, reason: "operator request" });
    expect(store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_revisions WHERE record_id = ?").get(proposed.recordId)).toEqual({
      count: 0,
    });
    store.close();
  });

  it("refuses a provenance that is not one", () => {
    const { store, service } = fixture();
    expect(() =>
      service.propose({
        actor: model,
        scope: personal,
        kind: "fact",
        body: "x",
        provenance: { integrity: "untrusted", sources: ["web"], refs: [], extra: 1 } as unknown as MemoryProvenance,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    // A trusted one is not stored: absent is the one encoding of clean.
    const trusted = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Alice cycles",
      provenance: { integrity: "trusted", sources: [], refs: [] },
    });
    expect(service.history({ actor: alice, recordId: trusted.recordId }).revisions[0]?.provenance).toBeUndefined();
    store.close();
  });
});

describe("the SQLite store's own (not the port's)", () => {
  it("removes a forgotten record from the full-text index", () => {
    const { store, service } = fixture();
    const record = service.approve({
      actor: alice,
      recordId: service.propose({ actor: alice, scope: personal, kind: "fact", body: "SECRETBODY here" }).recordId,
    });
    service.forget({ actor: alice, recordId: record.recordId, reason: "operator request" });
    expect(
      store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts WHERE tavi_memory_fts MATCH ?").get("SECRETBODY") as {
        count: number;
      },
    ).toEqual({ count: 0 });
    expect(
      store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_stem WHERE tavi_memory_fts_stem MATCH ?").get("SECRETBODY") as {
        count: number;
      },
    ).toEqual({ count: 0 });
    store.close();
  });

  it("matches inflections through tavi_memory_fts_stem, ranks exact matches ahead of stem-only matches, and strips trailing clitics", () => {
    const { store, service } = fixture();
    const exact = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Weekly meeting with the team" });
    const stemmed = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Prefers short meetings on Friday" });
    const bothWords = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Dog joins outdoor meetings" });
    const dogOnly = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Dog is named Mochi" });

    // Under `match: "all"`, exact index hits come first, then stem-only hits.
    const allHits = service.search({ actor: alice, query: "meeting", match: "all" }).hits.map((hit) => hit.recordId);
    expect(allHits[0]).toBe(exact.recordId);
    expect(allHits).toContain(stemmed.recordId);

    // Under `match: "any"`, a record matching an exact word + a stemmed inflection ("dog" + "meetings") beats one matching only "dog".
    const anyHits = service.search({ actor: alice, query: "dog meeting", match: "any" }).hits.map((hit) => hit.recordId);
    expect(anyHits.indexOf(bothWords.recordId)).toBeLessThan(anyHits.indexOf(dogOnly.recordId));

    // Possessives and clitics in a direct `memory.search` query ("dog's name") strip the clitic and match "Dog is named Mochi".
    const possessive = service.search({ actor: alice, query: "dog's named", match: "all" }).hits.map((hit) => hit.recordId);
    expect(possessive).toEqual([dogOnly.recordId]);
    store.close();
  });

  it("searches 5,000 indexed records across exact and stemmed FTS indexes, finding the stemmed matches", () => {
    const { store, service } = fixture({ maxRecords: 6_000 });
    const memory = store.asPort().repositories.memory;
    const scopeKey = memoryScopeKey(personal);
    store.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        const recordId = `bench-${index}`;
        const revisionId = `bench-rev-${index}`;
        memory.insertRecord({
          record: {
            recordId,
            kind: "fact",
            scope: personal,
            scopeKey,
            status: "approved",
            sensitivity: "normal",
            currentRevisionId: revisionId,
            revocationGeneration: 0,
            recordedAt: AT,
            updatedAt: AT,
          },
          revision: {
            revisionId,
            recordId,
            revisionNumber: 1,
            schemaVersion: 1,
            title: `Note ${index}`,
            body:
              index % 25 === 0
                ? `Project milestone ${index} covers meetings, deployments, and quarterly planning notes for team ${index % 50}.`
                : `Reference entry ${index} covers architecture, testing, and quarterly planning notes for team ${index % 50}.`,
            contentHash: `hash-${index}`,
            author: "alice",
            sourceIds: [],
            recordedAt: AT,
            sensitivity: "normal",
            status: "active",
          },
        });
      }
    });
    // Warm once.
    service.search({ actor: alice, query: "meeting deployment", match: "any", limit: 10 });
    const durations: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const started = performance.now();
      const result = service.search({ actor: alice, query: "meeting deployment", match: "any", limit: 10 });
      durations.push(performance.now() - started);
      expect(result.hits).toHaveLength(10);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    // A ceiling against a pathological plan only: the plan's +2 ms guardrail is
    // the delta against the exact index alone (memory-search-benchmark.test.ts).
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(250);
    store.close();
  });

  it("brackets the match in a long hit's excerpt (the FTS highlight)", () => {
    const { store, service } = fixture();
    const long = `${"filler words ".repeat(40)}the Lisbon garden ${"more filler ".repeat(40)}`;
    const longId = service.remember({ actor: alice, scope: personal, kind: "fact", body: long }).recordId;
    const longHit = service.search({ actor: alice, query: "Lisbon" }).hits.find((hit) => hit.recordId === longId);
    expect(longHit?.snippet).toContain("[Lisbon]");
    store.close();
  });

  it("erases a stale rejection through the forget path: a deletion-journal entry", () => {
    const { store, service } = fixture();
    const persistence = store.asPort();
    const rejected = service.reject({
      actor: alice,
      recordId: service.propose({ actor: alice, scope: personal, kind: "fact", body: "stale rejection" }).recordId,
    });
    const later = new MemoryService(persistence, { now: () => "2026-02-01T00:00:00.000Z" });
    expect(later.sweepExpired({ actor: alice }).map((entry) => [entry.recordId, entry.outcome])).toEqual([
      [rejected.recordId, "forgotten"],
    ]);
    const journal = persistence.repositories.memory.listDeletions({ scopeKeys: [memoryScopeKey(personal)], limit: 10 });
    expect(journal.some((entry) => entry.recordId === rejected.recordId)).toBe(true);
    store.close();
  });

  it("signals truncation past the 2000-record export cap", () => {
    const { store, service } = fixture({ maxRecords: 3_000 });
    const memory = store.asPort().repositories.memory;
    for (let i = 0; i < 2001; i += 1) {
      const recordId = `bulk-${i}`;
      memory.insertRecord({
        record: {
          recordId,
          kind: "fact",
          scope: personal,
          scopeKey: memoryScopeKey(personal),
          status: "approved",
          sensitivity: "normal",
          currentRevisionId: `${recordId}-rev`,
          revocationGeneration: 0,
          recordedAt: AT,
          updatedAt: AT,
        },
        revision: {
          revisionId: `${recordId}-rev`,
          recordId,
          revisionNumber: 1,
          schemaVersion: 1,
          body: `bulk ${i}`,
          contentHash: `h${i}`,
          author: "operator",
          sourceIds: [],
          recordedAt: AT,
          sensitivity: "normal",
          status: "active",
        },
      });
    }
    const result = service.export({ actor: alice });
    expect(result.records).toHaveLength(2000);
    expect(result.truncated).toBe(true);
    store.close();
  }, 20_000);

  it("reports coverage 'unavailable' with a bounded reason when the index genuinely fails", () => {
    const { store, service, memory } = fixture();
    const originalSearch = memory.search.bind(memory);
    memory.search = (() => {
      throw new Error("x".repeat(1_000)); // longer than the 300-char bound
    }) as typeof memory.search;
    try {
      const result = service.search({ actor: alice, query: "anything" });
      expect(result.coverage).toBe("unavailable");
      expect(result.hits).toEqual([]);
      expect(result.reducedReason?.length).toBeLessThanOrEqual(300);
    } finally {
      memory.search = originalSearch;
    }
    store.close();
  });

  it("maps the database's own UNIQUE violation to MEMORY_CONFLICT when the pre-check race is lost", () => {
    const { store, service, memory } = fixture();
    service.approve({
      actor: alice,
      recordId: service.propose({
        actor: alice,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "dark" },
        body: "dark",
      }).recordId,
    });
    const second = service.propose({
      actor: alice,
      scope: personal,
      kind: "preference",
      preferenceKey: "ui.theme",
      preference: { valueType: "string", value: "light" },
      body: "light",
    });

    // Bypass the service's own pre-check to force the write itself into the
    // database's UNIQUE constraint, exercising the fallback branch rather
    // than the pre-check. This patches the exact repository instance the
    // service holds (via fixture()'s `memory`) — a second `store.asPort()`
    // call builds unrelated repository objects that the service never calls.
    const originalListRecords = memory.listRecords.bind(memory);
    memory.listRecords = ((listInput) =>
      listInput.kinds?.includes("preference") === true ? [] : originalListRecords(listInput)) as typeof memory.listRecords;

    let error: unknown;
    try {
      service.approve({ actor: alice, recordId: second.recordId });
    } catch (caught) {
      error = caught;
    } finally {
      memory.listRecords = originalListRecords;
    }
    expect(error).toBeInstanceOf(TaviError);
    expect((error as TaviError).code).toBe("MEMORY_CONFLICT");
    store.close();
  });

  it("leaves a proposal that was approved before the sweep reached it", () => {
    const { store, service } = fixture();
    const proposal = service.propose({ actor: alice, scope: personal, kind: "fact", body: "races the sweep" });
    const persistence = store.asPort();
    const repository = persistence.repositories.memory;
    // Approved between the sweep's read and its write: the compare-and-set on
    // `proposed` loses, and the record is simply not swept.
    const original = repository.listRecords.bind(repository);
    let raced = false;
    repository.listRecords = (input) => {
      const rows = original(input);
      if (!raced && input.statuses?.includes("proposed") === true) {
        raced = true;
        service.approve({ actor: alice, recordId: proposal.recordId });
      }
      return rows;
    };
    const later = new MemoryService(persistence, { now: () => "2026-02-01T00:00:00.000Z" });
    expect(later.sweepExpired({ actor: alice })).toEqual([]);
    expect(later.get({ actor: alice, recordId: proposal.recordId }).status).toBe("approved");
    store.close();
  });

  /**
   * Simulates a source becoming revoked *after* a record already cites it —
   * there is no public API for this (evidence-source lifecycle is
   * thin by design), so the test flips the row directly the way an
   * external revocation event eventually would. A real revocation path
   * (`forget()`, `store/memory.ts`) additionally sets `access_revoked_at` and bumps
   * `tavi_memory_scope_generations.revocation_generation` for the record's
   * scope; this helper deliberately does neither, since `#revokedSourceIds`
   * only reads `revocationStatus` — if a real standalone evidence-revocation
   * API is ever added, confirm those other fields/generation bumps don't
   * become load-bearing for some other consumer before reusing this helper.
   */
  function revokeEvidence(store: ReturnType<typeof fixture>["store"], sourceId: string): void {
    store.handle.prepare("UPDATE tavi_evidence_sources SET revocation_status = 'revoked' WHERE source_id = ?").run(sourceId);
  }

  it("known limitation: misses a revoked source older than the most recent MEMORY_LIST_PAGE_MAX evidence rows", () => {
    const { store, service } = fixture();
    const memory = store.asPort().repositories.memory;
    memory.insertEvidence({
      sourceId: "src-old",
      scopeKey: memoryScopeKey(personal),
      operatorInput: true,
      observedAt: "2020-01-01T00:00:00.000Z", // older than every filler row below
      contentHash: "h",
      captureBasis: "explicit",
      retentionPolicy: "standard",
      revocationStatus: "active",
    });
    const record = service.approve({
      actor: alice,
      recordId: service.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice keeps a garden",
        sourceIds: ["src-old"],
      }).recordId,
    });
    // `listEvidence` orders by `observed_at DESC LIMIT MEMORY_LIST_PAGE_MAX`;
    // these fillers are all more recent, pushing `src-old` off the page.
    for (let index = 0; index < MEMORY_LIST_PAGE_MAX; index += 1) {
      memory.insertEvidence({
        sourceId: `src-filler-${index}`,
        scopeKey: memoryScopeKey(personal),
        operatorInput: true,
        observedAt: "2026-01-01T00:00:00.000Z",
        contentHash: "h",
        captureBasis: "explicit",
        retentionPolicy: "standard",
        revocationStatus: "active",
      });
    }

    revokeEvidence(store, "src-old");
    // Pinned, not desired: `src-old` falls outside `#revokedSourceIds`'s
    // page, so the record citing it wrongly stays visible (a documented
    // limitation — see `#revokedSourceIds`'s doc comment).
    expect(service.search({ actor: alice, query: "garden" }).hits.map((h) => h.recordId)).toEqual([record.recordId]);
    store.close();
  });
});

/**
 * Latin/Cyrillic/CJK retrieval fixtures.
 *
 * The pinned tokenizer is `unicode61 remove_diacritics 2`
 * (`MEMORY_FTS_TOKENIZER`, `packages/contracts/src/memory.ts`) — a
 * deliberate, documented choice: "Chinese/Japanese unspaced text ... need
 * dedicated retrieval fixtures; do not promise general CJK word recall.
 * Evaluate ... only against measured language-specific failures." These
 * fixtures pin what that tokenizer actually does today: full word/case/accent
 * recall for space-delimited scripts (Latin, Cyrillic), and — by design, not
 * as a bug — no sub-string recall within an unspaced CJK run, because
 * `unicode61` has no CJK word segmentation and indexes a whole contiguous
 * run of CJK ideographs as a single token.
 */
describe("search across scripts (Latin/Cyrillic/CJK)", () => {
  it("recalls Latin content case-insensitively and folds accents (café ~ cafe)", () => {
    const { store, service } = fixture();
    service.approve({
      actor: alice,
      recordId: service.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice visited a café in Paris",
      }).recordId,
    });
    expect(service.search({ actor: alice, query: "cafe" }).hits).toHaveLength(1);
    expect(service.search({ actor: alice, query: "CAFE" }).hits).toHaveLength(1);
    expect(service.search({ actor: alice, query: "café" }).hits).toHaveLength(1);
    store.close();
  });

  it("recalls Cyrillic content regardless of case", () => {
    const { store, service } = fixture();
    service.approve({
      actor: alice,
      recordId: service.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Алиса переехала в Лиссабон прошлым летом",
      }).recordId,
    });
    expect(service.search({ actor: alice, query: "Лиссабон" }).hits).toHaveLength(1);
    expect(service.search({ actor: alice, query: "лиссабон" }).hits).toHaveLength(1);
    expect(service.search({ actor: alice, query: "ЛИССАБОН" }).hits).toHaveLength(1);
    store.close();
  });

  it("recalls a record by either script in mixed Latin/Cyrillic content", () => {
    const { store, service } = fixture();
    service.approve({
      actor: alice,
      recordId: service.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: "Alice's Russian nickname is Алиса",
      }).recordId,
    });
    expect(service.search({ actor: alice, query: "Alice" }).hits).toHaveLength(1);
    expect(service.search({ actor: alice, query: "Алиса" }).hits).toHaveLength(1);
    store.close();
  });

  it("recalls CJK content only by an exact whole-run match, not a sub-string query (documented limitation)", () => {
    const { store, service } = fixture();
    service.approve({
      actor: alice,
      recordId: service.propose({
        actor: alice,
        scope: personal,
        kind: "fact",
        // "The weather in Beijing is nice today" — one unspaced CJK run.
        body: "北京今天天气很好",
      }).recordId,
    });
    // The whole indexed run matches itself: `unicode61` tokenizes it as one token.
    expect(service.search({ actor: alice, query: "北京今天天气很好" }).hits).toHaveLength(1);
    // A realistic sub-phrase query ("weather") does NOT recall the record:
    // `unicode61` has no CJK word segmentation, so "天气" is not its own
    // token. This is the documented limitation, not a regression — a fixture
    // that started passing here would mean the tokenizer changed underneath
    // this pinned behavior.
    expect(service.search({ actor: alice, query: "天气" }).hits).toHaveLength(0);
    store.close();
  });
});

describe("memory invariant 27: what a local chat wrote stays off remote models", () => {
  it("stamps a local chat's record, and a remote reader's recall leaves it out", () => {
    const { service, memory } = fixture();
    const local = service.remember({ actor: alice, scope: personal, kind: "fact", body: "The garden has tomatoes", localOrigin: true });
    const plain = service.remember({ actor: alice, scope: personal, kind: "fact", body: "The garden has peppers" });
    expect(service.get({ actor: alice, recordId: local.recordId }).localOrigin).toBe(true);
    expect(service.get({ actor: alice, recordId: plain.recordId }).localOrigin).toBeUndefined();
    const found = (excludeLocalOrigin?: boolean) =>
      service
        .search({ actor: alice, query: "garden", match: "any", ...(excludeLocalOrigin === undefined ? {} : { excludeLocalOrigin }) })
        .hits.map((hit) => hit.recordId)
        .sort();
    expect(found()).toEqual([local.recordId, plain.recordId].sort());
    expect(found(true)).toEqual([plain.recordId]);
    expect(
      service.eligible({ actor: alice, recordIds: [local.recordId, plain.recordId], excludeLocalOrigin: true }).map((hit) => hit.recordId),
    ).toEqual([plain.recordId]);
    service.remember({
      actor: alice,
      scope: personal,
      kind: "preference",
      preferenceKey: "reply.tone",
      preference: { valueType: "string", value: "warm" },
      body: "Reply warmly",
      localOrigin: true,
    });
    expect(service.resolvePreferences({ actor: alice, keys: ["reply.tone"] }).preferences).toHaveLength(1);
    expect(service.resolvePreferences({ actor: alice, keys: ["reply.tone"], excludeLocalOrigin: true }).preferences).toHaveLength(0);
    // Only a local embedding connection is handed it.
    const backlog = (withLocalOrigin?: boolean) =>
      memory
        .vectorBacklog({
          workspaceId: "w1",
          principalIds: ["alice"],
          modelKey: "c/m",
          now: AT,
          limit: 10,
          maxFailures: 3,
          ...(withLocalOrigin === undefined ? {} : { withLocalOrigin }),
        })
        .map((entry) => entry.text);
    expect(backlog()).toEqual(["The garden has peppers"]);
    expect(backlog(true)).toContain("The garden has tomatoes");
  });

  it("filters sensitive, local-origin and revoked-source records before the SQL LIMIT", () => {
    const { store, service, memory } = fixture();
    const scopeKey = memoryScopeKey(personal);
    for (let i = 1; i <= 3; i += 1) {
      service.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: `Roadmap milestone roadmap milestone sensitive note ${i}`,
        sensitivity: "sensitive",
      });
    }
    for (let i = 1; i <= 2; i += 1) {
      const sourceId = `src-revoked-${i}`;
      memory.insertEvidence({
        sourceId,
        scopeKey,
        operatorInput: true,
        observedAt: AT,
        contentHash: `hash-${sourceId}`,
        captureBasis: "explicit",
        retentionPolicy: "standard",
        revocationStatus: "active",
      });
      service.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: `Roadmap milestone roadmap milestone revoked source ${i}`,
        sourceIds: [sourceId],
      });
      store.handle.prepare("UPDATE tavi_evidence_sources SET revocation_status = 'revoked' WHERE source_id = ?").run(sourceId);
    }
    const localRecord = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Roadmap milestone roadmap milestone local chat note",
      localOrigin: true,
    });
    const eligibleIds: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const rec = service.remember({
        actor: alice,
        scope: personal,
        kind: "fact",
        body: `Roadmap milestone deliverable ${i}`,
      });
      eligibleIds.push(rec.recordId);
    }

    // With 3 sensitive + 2 revoked-source + 1 local-origin + 10 eligible records,
    // a remote-chat search with limit 10 returns all 10 eligible records.
    const hits = service.search({
      actor: alice,
      query: "roadmap milestone",
      limit: 10,
      excludeLocalOrigin: true,
    }).hits;
    expect(hits).toHaveLength(10);
    expect(hits.map((hit) => hit.recordId).sort()).toEqual([...eligibleIds].sort());

    // Hybrid vectorCandidates also excludes local-origin records before ranking when excludeLocalOrigin is true.
    memory.putVectors({
      now: AT,
      vectors: [
        { revisionId: localRecord.currentRevisionId!, modelKey: "c/m", vector: [1, 0, 0, 0] },
        ...eligibleIds.map((id) => ({
          revisionId: service.get({ actor: alice, recordId: id }).currentRevisionId!,
          modelKey: "c/m",
          vector: [0.8, 0.6, 0, 0],
        })),
      ],
    });
    const candidates = memory.vectorCandidates({
      scopeKeys: [scopeKey],
      workspaceId: "w1",
      now: AT,
      modelKey: "c/m",
      vector: [1, 0, 0, 0],
      limit: 10,
      excludeLocalOrigin: true,
    });
    expect(candidates.ranked.some((entry) => entry.recordId === localRecord.recordId)).toBe(false);
    expect(candidates.ranked).toHaveLength(10);
    store.close();
  });

  it("stamps a tidy-up of a local chat's record as that chat's", () => {
    const { service } = fixture();
    const local = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Lives in Lisbon", localOrigin: true });
    const plain = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Works remotely" });
    const merged = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Lives in Lisbon and works remotely",
      supersedes: [local, plain].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId! })),
    });
    expect(service.get({ actor: alice, recordId: merged.recordId }).localOrigin).toBe(true);
  });

  it("resolves the profile with lessons ordered by chat use then recency, and core me.* facts excluding beliefs, opinions, home_area, sensitive, local-origin and restricted actors", () => {
    let clock = "2026-01-01T00:00:00.000Z";
    const { store, persistence } = (() => {
      const f = fixture();
      return { store: f.store, persistence: f.store.asPort() };
    })();
    const service = new MemoryService(persistence, { now: () => clock });
    const lessonOld = service.remember({
      actor: alice,
      scope: personal,
      kind: "lesson",
      title: "Show diffs",
      body: "When editing files, show a diff first.",
    });
    clock = "2026-01-02T00:00:00.000Z";
    const lessonNew = service.remember({
      actor: alice,
      scope: personal,
      kind: "lesson",
      title: "Run tests",
      body: "When changing logic, run the unit tests.",
    });
    // Record two chats using lessonOld so it outranks the newer lessonNew.
    for (const id of ["task-1", "task-2"]) {
      persistence.repositories.tasks.admit({
        workspaceId: "w1",
        principalId: "alice",
        operationKey: id,
        kind: "start",
        intent: { prompt: "p" },
        checkpointNamespace: "",
        origin: "ipc",
        now: () => AT,
        newTaskId: () => id,
        newThreadId: () => `thread-${id}`,
        newAdmissionId: () => `adm-${id}`,
      });
    }
    persistence.repositories.memoryUse.record({
      taskId: "task-1",
      admissionId: "adm-task-1",
      recordIds: [lessonOld.recordId],
      at: "2026-01-03T00:00:00.000Z",
    });
    persistence.repositories.memoryUse.record({
      taskId: "task-2",
      admissionId: "adm-task-2",
      recordIds: [lessonOld.recordId],
      at: "2026-01-03T01:00:00.000Z",
    });

    clock = "2026-01-03T00:00:00.000Z";
    const cityFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Home city",
      body: "Lives in Lisbon.",
      topicKey: "me.home_city",
    });
    clock = "2026-01-04T00:00:00.000Z";
    const roleFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Role",
      body: "Works as a staff engineer.",
      topicKey: "me.role",
    });
    // Excluded from profile: belief, opinion, home_area, non-me fact, sensitive lesson, local-origin lesson.
    service.remember({ actor: alice, scope: personal, kind: "fact", body: "Believes in Georgism.", topicKey: "me.belief.tax" });
    service.remember({ actor: alice, scope: personal, kind: "fact", body: "Thinks tabs beat spaces.", topicKey: "me.opinion.indent" });
    service.remember({ actor: alice, scope: personal, kind: "fact", body: "Near Alfama.", topicKey: "me.home_area" });
    service.remember({ actor: alice, scope: personal, kind: "fact", body: "Sister lives in Porto.", topicKey: "sister.city" });
    service.remember({
      actor: alice,
      scope: personal,
      kind: "lesson",
      body: "Sensitive medical lesson.",
      sensitivity: "sensitive",
    });
    const localLesson = service.remember({
      actor: alice,
      scope: personal,
      kind: "lesson",
      body: "Local-only lesson.",
      localOrigin: true,
    });

    const full = service.resolvePreferences({ actor: model, includeProfile: true });
    expect(full.profile?.map((entry) => entry.recordId)).toEqual([
      lessonOld.recordId,
      localLesson.recordId,
      lessonNew.recordId,
      roleFact.recordId,
      cityFact.recordId,
    ]);
    expect(full.profile?.[0]?.usedChats).toBe(2);
    expect(
      persistence.repositories.memory.recordUseCounts({
        recordIds: [lessonOld.recordId, lessonNew.recordId],
        sinceCurrentRevision: true,
      }),
    ).toEqual({ [lessonOld.recordId]: 2 });

    const remote = service.resolvePreferences({ actor: model, includeProfile: true, excludeLocalOrigin: true });
    expect(remote.profile?.map((entry) => entry.recordId)).toEqual([
      lessonOld.recordId,
      lessonNew.recordId,
      roleFact.recordId,
      cityFact.recordId,
    ]);

    expect(service.resolveProfile({ actor: { ...model, reach: "chat-only" } })).toEqual([]);
    expect(service.resolveProfile({ actor: { ...model, scopeRestricted: true } })).toEqual([]);
    store.close();
  });

  it("resolves supersedesRecordId on a proposed fact directly as updates in related() and exempts it from near-match drop", () => {
    const { store, service } = fixture();
    const kept = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Alice works at Acme Corp as a Senior Software Engineer.",
    });
    const proposed = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      title: "Employer",
      body: "Alice works at Acme Corp as a Senior Software Engineer in Platform.",
      supersedesRecordId: kept.recordId,
      nearMatch: "drop",
    });
    expect(proposed.known).toBeUndefined();
    expect(proposed.supersedesRecordId).toBe(kept.recordId);
    const related = service.related({ actor: alice, recordId: proposed.recordId });
    expect(related.updates).toEqual({
      recordId: kept.recordId,
      title: "Alice works at Acme Corp as a Senior Software Engineer.",
      ...(kept.currentRevisionId === undefined ? {} : { currentRevisionId: kept.currentRevisionId }),
    });
    expect(related.mayUpdate).toBeUndefined();
    expect(related.similarTo).toBeUndefined();
    store.close();
  });

  it("lets a lesson name the kept lesson it updates, never a record of another kind or a preference", () => {
    const { store, service } = fixture();
    const lesson = service.remember({ actor: alice, scope: personal, kind: "lesson", body: "When deploying, run the tests first." });
    const fact = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Alice deploys on Fridays." });
    const proposed = service.propose({
      actor: model,
      scope: personal,
      kind: "lesson",
      body: "When deploying, run the tests and the linter first.",
      supersedesRecordId: lesson.recordId,
    });
    expect(proposed.supersedesRecordId).toBe(lesson.recordId);
    expect(service.related({ actor: alice, recordId: proposed.recordId }).updates?.recordId).toBe(lesson.recordId);
    expect(() =>
      service.propose({
        actor: model,
        scope: personal,
        kind: "lesson",
        body: "When asked, say Monday.",
        supersedesRecordId: fact.recordId,
      }),
    ).toThrow(/not an approved lesson in force/);
    expect(() =>
      service.propose({
        actor: model,
        scope: personal,
        kind: "preference",
        preferenceKey: "ui.theme",
        preference: { valueType: "string", value: "dark" },
        body: "Dark theme",
        supersedesRecordId: lesson.recordId,
      }),
    ).toThrow(/Only a fact or lesson proposal/);
    store.close();
  });

  it("applies the relevance floor and MMR near-duplicate filter on turn recall while exempting conflicts and alreadyShownIds", () => {
    const { store, service } = fixture();
    const multiMatch = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Bastion SSH port",
      body: "Production bastion SSH server listens on port 2222 in the notebook.",
    });
    const nearDup = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Bastion SSH port copy",
      body: "Production bastion SSH server listens on port 2222 in the ops notebook.",
    });
    const titleMatch = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Bastion jump host",
      body: "Uses hardware key authentication.",
    });
    const distractor1 = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Unrelated note 1",
      body: "Archival specimen alpha recorded in the notebook.",
    });
    const distractor2 = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Unrelated note 2",
      body: "Archival specimen beta recorded in the notebook.",
    });
    const conflictA = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      topicKey: "ops.notebook.owner",
      body: "The notebook owner is Alice.",
    });
    const conflictB = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      topicKey: "ops.notebook.owner",
      body: "The notebook owner is Bob.",
    });

    // Without applyFloor (explicit tool/CLI search), distractors and near-duplicates are untouched.
    const unfiltered = service.search({
      actor: alice,
      query: "bastion ssh port notebook",
      match: "any",
      limit: 10,
    });
    expect(unfiltered.hits.map((hit) => hit.recordId)).toEqual(
      expect.arrayContaining([
        multiMatch.recordId,
        nearDup.recordId,
        titleMatch.recordId,
        distractor1.recordId,
        distractor2.recordId,
        conflictA.recordId,
        conflictB.recordId,
      ]),
    );

    // With applyFloor: true, non-rare single-term body-only distractors and near-duplicates are dropped,
    // while multi-term matches, title matches, and conflicting records survive.
    const floored = service.search({
      actor: alice,
      query: "bastion ssh port notebook",
      match: "any",
      limit: 10,
      applyFloor: true,
    });
    const flooredIds = floored.hits.map((hit) => hit.recordId);
    expect(flooredIds).toContain(multiMatch.recordId);
    expect(flooredIds).toContain(titleMatch.recordId);
    expect(flooredIds).toContain(conflictA.recordId);
    expect(flooredIds).toContain(conflictB.recordId);
    expect(flooredIds).not.toContain(nearDup.recordId);
    expect(flooredIds).not.toContain(distractor1.recordId);
    expect(flooredIds).not.toContain(distractor2.recordId);

    // Items already shown in the epoch's context delta are exempt from both floor and MMR drop.
    const withShown = service.search({
      actor: alice,
      query: "bastion ssh port notebook",
      match: "any",
      limit: 10,
      applyFloor: true,
      alreadyShownIds: [`memory:${nearDup.currentRevisionId}`, `memory:${distractor1.currentRevisionId}`],
    });
    const withShownIds = withShown.hits.map((hit) => hit.recordId);
    expect(withShownIds).toContain(nearDup.recordId);
    expect(withShownIds).toContain(distractor1.recordId);
    expect(withShownIds).not.toContain(distractor2.recordId);
    store.close();
  });

  it("applies bounded recency (by observedAt, not edit time) and post-revision confirmation priors without overriding relevance", () => {
    const store = new SqliteStore({ databasePath: ":memory:" });
    const persistence = store.asPort();
    let clock = "2026-01-10T10:00:00.000Z";
    const service = new MemoryService(persistence, { now: () => clock });

    // 1. Recency by observedAt: older fact has slightly better raw BM25 (shorter body),
    //    but newer fact on the same query terms ranks first via the 0.05 recency prior.
    const olderFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Code editor",
      body: "Uses Neovim as primary code editor.",
      observedAt: "2026-01-10T10:00:00.000Z",
    });
    clock = "2026-03-15T10:00:00.000Z";
    const newerFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "I switched my primary code editor from Neovim to Helix this week.",
      observedAt: "2026-03-15T10:00:00.000Z",
    });

    const recencyOrdered = service.search({
      actor: alice,
      query: "primary code editor",
      match: "any",
      limit: 10,
    });
    expect(recencyOrdered.hits.slice(0, 2).map((hit) => hit.recordId)).toEqual([newerFact.recordId, olderFact.recordId]);

    // Editing the older fact later does NOT bump its observedAt or let it overtake the newer fact.
    clock = "2026-04-01T10:00:00.000Z";
    service.correct({
      actor: alice,
      recordId: olderFact.recordId,
      title: "Code editor",
      body: "Uses Neovim as primary code editor on laptop.",
    });
    const afterEdit = service.search({
      actor: alice,
      query: "primary code editor",
      match: "any",
      limit: 10,
    });
    expect(afterEdit.hits.slice(0, 2).map((hit) => hit.recordId)).toEqual([newerFact.recordId, olderFact.recordId]);

    // 2. Confirmation prior: among two equally matching facts observed at the same time,
    //    one used in >= 2 distinct chats since its current revision was recorded ranks first;
    //    correcting that record clears its confirmation boost.
    clock = "2026-02-01T10:00:00.000Z";
    const unconfirmed = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Prefers dark roast espresso beans from Colombia.",
      observedAt: "2026-02-01T10:00:00.000Z",
    });
    const confirmed = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Prefers light roast espresso beans from Ethiopia.",
      observedAt: "2026-02-01T10:00:00.000Z",
    });
    for (const id of ["chat-1", "chat-2", "chat-3", "chat-4"]) {
      persistence.repositories.tasks.admit({
        workspaceId: "w1",
        principalId: "alice",
        operationKey: id,
        kind: "start",
        intent: { prompt: "p" },
        checkpointNamespace: "",
        origin: "ipc",
        now: () => AT,
        newTaskId: () => id,
        newThreadId: () => `thread-${id}`,
        newAdmissionId: () => `adm-${id}`,
      });
    }
    persistence.repositories.memoryUse.record({
      taskId: "chat-1",
      admissionId: "adm-chat-1",
      recordIds: [confirmed.recordId],
      at: "2026-02-02T10:00:00.000Z",
    });
    persistence.repositories.memoryUse.record({
      taskId: "chat-2",
      admissionId: "adm-chat-2",
      recordIds: [confirmed.recordId],
      at: "2026-02-03T10:00:00.000Z",
    });
    const withConfirmation = service.search({
      actor: alice,
      query: "roast espresso beans",
      match: "any",
      limit: 10,
    });
    expect(withConfirmation.hits.slice(0, 2).map((hit) => hit.recordId)).toEqual([confirmed.recordId, unconfirmed.recordId]);

    // Correcting `confirmed` creates revision 2 at a later timestamp, so earlier chat uses no longer count as confirmation.
    clock = "2026-02-10T10:00:00.000Z";
    service.correct({
      actor: alice,
      recordId: confirmed.recordId,
      body: "Prefers light roast espresso beans from Ethiopia.",
    });
    persistence.repositories.memoryUse.record({
      taskId: "chat-3",
      admissionId: "adm-chat-3",
      recordIds: [unconfirmed.recordId],
      at: "2026-02-11T10:00:00.000Z",
    });
    persistence.repositories.memoryUse.record({
      taskId: "chat-4",
      admissionId: "adm-chat-4",
      recordIds: [unconfirmed.recordId],
      at: "2026-02-12T10:00:00.000Z",
    });
    const afterCorrection = service.search({
      actor: alice,
      query: "roast espresso beans",
      match: "any",
      limit: 10,
    });
    expect(afterCorrection.hits.slice(0, 2).map((hit) => hit.recordId)).toEqual([unconfirmed.recordId, confirmed.recordId]);
    store.close();
  });

  it("returns ended facts marked (ended <date>) and superseded fact revisions marked (replaced <date> by <title>) only when includePast is true, never expired preferences or lessons", () => {
    const store = new SqliteStore({ databasePath: ":memory:" });
    let clock = "2026-01-10T10:00:00.000Z";
    const service = new MemoryService(store.asPort(), { now: () => clock });

    const endedFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Lisbon trip",
      body: "Staying in Lisbon for the conference.",
      validTo: "2026-02-01T00:00:00.000Z",
    });
    const endedSensitiveFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Staying in Lisbon for medical treatment.",
      validTo: "2026-02-01T00:00:00.000Z",
      sensitivity: "sensitive",
    });
    const endedLocalFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Staying in Lisbon private local note.",
      validTo: "2026-02-01T00:00:00.000Z",
      localOrigin: true,
    });
    service.remember({
      actor: alice,
      scope: personal,
      kind: "preference",
      preferenceKey: "travel.city",
      preference: { valueType: "string", value: "Lisbon" },
      body: "Prefers Lisbon hotels.",
      expiryAt: "2026-02-01T00:00:00.000Z",
    });
    service.remember({
      actor: alice,
      scope: personal,
      kind: "lesson",
      body: "When in Lisbon, book tram tickets early.",
      expiryAt: "2026-02-01T00:00:00.000Z",
    });

    const replacedFact = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Employer",
      body: "Works at Northwind Analytics in Lisbon.",
    });
    clock = "2026-03-05T12:00:00.000Z";
    service.correct({
      actor: alice,
      recordId: replacedFact.recordId,
      title: "Current employer",
      body: "Works at Contoso Labs in Porto.",
    });

    const consolidatedInput = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Old gym",
      body: "Trains at FitLab in Lisbon.",
    });
    const consolidatedOther = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Climbing",
      body: "Climbs at Bloc House in Porto.",
    });
    clock = "2026-03-10T12:00:00.000Z";
    const tidyUp = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      title: "Porto climbing gym",
      body: "Climbs exclusively at Bloc House in Porto.",
      supersedes: [
        { recordId: consolidatedInput.recordId, revisionId: consolidatedInput.currentRevisionId! },
        { recordId: consolidatedOther.recordId, revisionId: consolidatedOther.currentRevisionId! },
      ],
    });
    service.approve({ actor: alice, recordId: tidyUp.recordId });

    clock = "2026-04-01T10:00:00.000Z";
    // Without includePast, none of the Lisbon past records or expired preferences/lessons are returned.
    const defaultSearch = service.search({
      actor: model,
      query: "Lisbon",
      match: "any",
      limit: 10,
    });
    expect(defaultSearch.hits).toEqual([]);

    // With includePast: true, ended facts and superseded fact revisions are returned with their markers,
    // while expired preferences, expired lessons, sensitive facts, and (when excluded) local-origin facts stay out.
    const pastSearch = service.search({
      actor: model,
      query: "Lisbon",
      match: "any",
      limit: 10,
      includePast: true,
      excludeLocalOrigin: true,
    });
    expect(pastSearch.reducedReason).toBeUndefined();
    const byRecordId = new Map(pastSearch.hits.map((hit) => [hit.recordId, hit]));
    expect(byRecordId.has(endedFact.recordId)).toBe(true);
    expect(byRecordId.get(endedFact.recordId)?.snippet).toContain("(ended 2026-02-01)");
    expect(byRecordId.get(endedFact.recordId)?.superseded).toBe(false);

    expect(byRecordId.has(replacedFact.recordId)).toBe(true);
    expect(byRecordId.get(replacedFact.recordId)?.snippet).toContain("(replaced 2026-03-05 by Current employer)");
    expect(byRecordId.get(replacedFact.recordId)?.superseded).toBe(true);

    expect(byRecordId.has(consolidatedInput.recordId)).toBe(true);
    expect(byRecordId.get(consolidatedInput.recordId)?.snippet).toContain("(replaced 2026-03-10 by Porto climbing gym)");
    expect(byRecordId.get(consolidatedInput.recordId)?.superseded).toBe(true);

    expect(byRecordId.has(endedSensitiveFact.recordId)).toBe(false);
    expect(byRecordId.has(endedLocalFact.recordId)).toBe(false);
    expect(pastSearch.hits.every((hit) => hit.kind === "fact")).toBe(true);
    store.close();
  });

  it("indexes write-time keywords in the keys column without rendering them, regenerates them on correction, and erases them on forget", () => {
    const store = new SqliteStore({ databasePath: ":memory:" });
    let clock = "2026-01-10T10:00:00.000Z";
    const service = new MemoryService(store.asPort(), { now: () => clock });
    const model: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "agent", authority: "model" };

    const proposed = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      title: "Emma",
      body: "Emma attends Lincoln Elementary.",
      keywords: ["daughter", "school", "kid", "Daughter"],
    });
    const approved = service.approve({ actor: alice, recordId: proposed.recordId });
    const revision1 = store.asPort().repositories.memory.getRevision(approved.currentRevisionId!);
    expect(revision1?.keywords).toEqual(["daughter", "school", "kid"]);

    // Turn recall (applyFloor: true) finds the record via write-time keywords and never renders keywords in the snippet.
    const byKeyword = service.search({
      actor: model,
      query: "daughter school",
      match: "any",
      limit: 10,
      applyFloor: true,
    });
    expect(byKeyword.hits.map((hit) => hit.recordId)).toEqual([approved.recordId]);
    expect(byKeyword.hits[0]?.snippet).toBe("Emma attends Lincoln Elementary.");
    expect(byKeyword.hits[0]?.snippet).not.toContain("daughter");

    // rebuildSearchIndex preserves keywords from tavi_memory_revisions.keywords_json.
    const rebuilt = store.asPort().repositories.memory.rebuildSearchIndex();
    expect(rebuilt.verified).toBe(true);
    const afterRebuild = service.search({
      actor: model,
      query: "kid",
      match: "any",
      limit: 10,
      applyFloor: true,
    });
    expect(afterRebuild.hits.map((hit) => hit.recordId)).toEqual([approved.recordId]);

    // A correction replaces keywords (and clears them when none are passed).
    clock = "2026-02-01T10:00:00.000Z";
    const corrected = service.correct({
      actor: alice,
      recordId: approved.recordId,
      body: "Emma attends Roosevelt Middle School.",
      keywords: ["teenager", "middle school"],
    });
    const revision2 = store.asPort().repositories.memory.getRevision(corrected.currentRevisionId!);
    expect(revision2?.keywords).toEqual(["teenager", "middle school"]);
    expect(
      service.search({
        actor: model,
        query: "kid",
        match: "any",
        limit: 10,
      }).hits,
    ).toEqual([]);
    expect(
      service
        .search({
          actor: model,
          query: "teenager",
          match: "any",
          limit: 10,
          applyFloor: true,
        })
        .hits.map((hit) => hit.recordId),
    ).toEqual([corrected.recordId]);

    // Forget erases revisions (and their keywords_json) and FTS rows.
    service.forget({ actor: alice, recordId: corrected.recordId, reason: "no longer needed" });
    expect(store.asPort().repositories.memory.listRevisions(corrected.recordId)).toEqual([]);
    expect(
      service.search({
        actor: model,
        query: "teenager",
        match: "any",
        limit: 10,
      }).hits,
    ).toEqual([]);

    // Bounds validation on keywords.
    expect(() =>
      service.propose({
        actor: model,
        scope: personal,
        kind: "fact",
        body: "Too many keywords.",
        keywords: ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"],
      }),
    ).toThrow(/at most 8 keywords/);
    store.close();
  });

  it("boosts records overlapping a temporal query range without filtering non-overlapping ones, and includes ended facts when range is in the past", () => {
    let clock = "2026-03-15T10:00:00.000Z";
    const store = new SqliteStore({ databasePath: ":memory:" });
    const service = new MemoryService(store.asPort(), { now: () => clock });

    const marchTrip = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Conference trip",
      body: "Attended the systems conference in Berlin.",
      observedAt: "2026-03-15T10:00:00.000Z",
    });

    clock = "2026-08-15T10:00:00.000Z";
    const augustTrip = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Conference trip",
      body: "Attended the systems conference in Zurich.",
      observedAt: "2026-08-15T10:00:00.000Z",
    });

    clock = "2026-09-15T10:00:00.000Z";
    const septemberTrip = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Conference trip",
      body: "Attended the systems conference in Vienna.",
      observedAt: "2026-09-15T10:00:00.000Z",
    });

    const endedCity = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      title: "Former city",
      body: "Lived in Lisbon before moving to Porto.",
      observedAt: "2024-01-01T00:00:00.000Z",
      validTo: "2026-09-01T00:00:00.000Z",
    });

    clock = "2026-10-14T12:00:00.000Z";
    // Without a range, the newest September trip ranks first, then August, then March.
    const unRanged = service.search({
      actor: model,
      query: "systems conference",
      match: "any",
      limit: 10,
    });
    expect(unRanged.hits.map((hit) => hit.recordId)).toEqual([septemberTrip.recordId, augustTrip.recordId, marchTrip.recordId]);

    // With a March range, the March trip is boosted to rank 1 while September and August are still kept (never filtered).
    const marchRanged = service.search({
      actor: model,
      query: "systems conference",
      match: "any",
      limit: 10,
      range: {
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-31T23:59:59.999Z",
      },
    });
    expect(marchRanged.hits.map((hit) => hit.recordId)).toEqual([marchTrip.recordId, septemberTrip.recordId, augustTrip.recordId]);

    // With an August range, the August trip is boosted to rank 1 while March does not falsely receive the August boost ahead of September.
    const augustRanged = service.search({
      actor: model,
      query: "systems conference",
      match: "any",
      limit: 10,
      range: {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-31T23:59:59.999Z",
      },
    });
    expect(augustRanged.hits.map((hit) => hit.recordId)).toEqual([augustTrip.recordId, septemberTrip.recordId, marchTrip.recordId]);

    // A past-only range lets ended facts into turn recall without explicit `includePast: true`.
    const pastTurnHits = service.search({
      actor: model,
      query: "live before porto",
      match: "any",
      limit: 10,
      applyFloor: true,
      range: {
        from: "1970-01-01T00:00:00.000Z",
        to: "2026-10-13T23:59:59.999Z",
      },
    });
    expect(pastTurnHits.hits.map((hit) => hit.recordId)).toEqual([endedCity.recordId]);
    expect(pastTurnHits.hits[0]?.snippet).toContain("(ended 2026-09-01)");
    store.close();
  });
});

it("gives a data directory made before memory records carried their chat's locality the column", async () => {
  const { join } = await import("node:path");
  const { loadBetterSqlite3 } = await import("../src/persistence/sqlite-loader.js");
  const directories = temporaryDirectories();
  const directory = directories.create("tavi-local-origin-");
  try {
    const databasePath = join(directory, "tavi.sqlite");
    new SqliteStore({ databasePath }).close();
    const raw = new (loadBetterSqlite3())(databasePath);
    raw.exec("ALTER TABLE tavi_memory_records DROP COLUMN local_origin");
    raw.close();
    const store = new SqliteStore({ databasePath });
    try {
      const service = new MemoryService(store.asPort(), { now: () => AT });
      const kept = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Kept locally", localOrigin: true });
      expect(service.get({ actor: alice, recordId: kept.recordId }).localOrigin).toBe(true);
    } finally {
      store.close();
    }
  } finally {
    directories.cleanup();
  }
});
