import { afterEach, describe, expect, it } from "vitest";

import type { MemoryActor, MemoryScope } from "@tavi/contracts";

import { MemoryService } from "../src/memory/service.js";
import { scoreVectors, unitVector, vectorFromBytes } from "../src/memory/vectors.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Hybrid recall's storage and scoring: unit vectors in `tavi_memory_vectors`, the worker's per-workspace
 * cache kept in step with every write and delete, eligible ids from SQL before
 * any scoring, reciprocal-rank fusion with bm25, and the backfill's backlog.
 * The vectors here are a scripted concept map, not a model: they show the
 * pipeline, never recall quality (that is the eval's).
 */

const NOW = "2026-10-11T09:00:00.000Z";
const LATER = "2026-10-12T09:00:00.000Z";
const MODEL = "fixture/embed-1";

const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", runId: "chat-1", caller: "cli", authority: "operator" };
const bob: MemoryActor = { principalId: "bob", workspaceId: "w1", runId: "chat-2", caller: "cli", authority: "operator" };
const personal = (principalId: string): MemoryScope => ({ kind: "personal", principalId });

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

/** A scripted concept space: each record is placed by hand, so a paraphrase sits near what it means. */
const CONCEPTS = { home: [1, 0, 0, 0], work: [0, 1, 0, 0], food: [0, 0, 1, 0], pet: [0, 0, 0, 1] } as const;
const near = (concept: keyof typeof CONCEPTS, scale = 2): number[] => CONCEPTS[concept].map((value) => value * scale + 0.05);

function fixture(now = NOW) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  const persistence = store.asPort();
  let counter = 0;
  const at = (when: string): MemoryService =>
    new MemoryService(persistence, { now: () => when, newId: (prefix) => `${prefix}-${(counter += 1)}` });
  const service = at(now);
  const memory = persistence.repositories.memory;
  const remember = (actor: MemoryActor, body: string, extra: Partial<Parameters<MemoryService["remember"]>[0]> = {}) =>
    service.remember({ actor, scope: personal(actor.principalId), kind: "fact", body, ...extra });
  const embed = (recordId: string, vector: readonly number[], modelKey = MODEL): number =>
    memory.putVectors({ vectors: [{ revisionId: memory.getRecord(recordId)!.currentRevisionId!, modelKey, vector }], now });
  const vectorRows = (): number => (store.handle.prepare("SELECT count(*) AS n FROM tavi_memory_vectors").get() as { n: number }).n;
  return { store, service, at, memory, remember, embed, vectorRows };
}

describe("vectors", () => {
  it("are stored unit-normalised as float32, so cosine is a dot product; a zero vector is refused", () => {
    const { store, remember, embed } = fixture();
    const record = remember(alice, "Based in Lisbon");
    expect(embed(record.recordId, [3, 4, 0, 0])).toBe(1);
    const row = store.handle.prepare("SELECT model_key, dims, vector FROM tavi_memory_vectors").get() as {
      model_key: string;
      dims: number;
      vector: Uint8Array;
    };
    expect(row).toMatchObject({ model_key: MODEL, dims: 4 });
    expect([...vectorFromBytes(row.vector, row.dims)!].map((value) => Number(value.toFixed(5)))).toEqual([0.6, 0.8, 0, 0]);
    expect(unitVector([0, 0, 0])).toBeUndefined();
    expect(unitVector([Number.NaN, 1])).toBeUndefined();
    const other = remember(alice, "Works at Acme");
    expect(embed(other.recordId, [0, 0, 0, 0])).toBe(0);
  });

  it("a paraphrase misses under lexical and hits under hybrid, fused with bm25 (RRF), coverage complete", () => {
    const { service, remember, embed } = fixture();
    const home = remember(alice, "Based in Lisbon");
    const work = remember(alice, "Works as a nurse at the city hospital");
    embed(home.recordId, near("home"));
    embed(work.recordId, near("work"));
    const lexical = service.search({ actor: alice, query: "where do i live", match: "any" });
    expect(lexical.hits).toEqual([]);
    const hybrid = service.search({
      actor: alice,
      query: "where do i live",
      match: "any",
      queryVector: { modelKey: MODEL, vector: [0.9, 0.1, 0, 0] },
    });
    expect(hybrid.coverage).toBe("complete");
    expect(hybrid.hits[0]).toMatchObject({ recordId: home.recordId, snippet: "Based in Lisbon", match: "meaning" });
    // A word match and a meaning match both rank; the record both lists hold ranks first and is not marked meaning-only.
    const both = service.search({ actor: alice, query: "hospital", match: "any", queryVector: { modelKey: MODEL, vector: near("work") } });
    expect(both.hits[0]?.recordId).toBe(work.recordId);
    expect(both.hits[0]?.match).toBeUndefined();
    expect(both.hits.find((hit) => hit.recordId === home.recordId)?.match).toBe("meaning");
    // An all search with no record holding every word retries with any before fusing, so partial lexical matches rank ahead of vector-only hits.
    const dog = remember(alice, "Dog is named Mochi");
    embed(dog.recordId, near("pet"));
    const retried = service.search({
      actor: alice,
      query: "dog breed",
      queryVector: { modelKey: MODEL, vector: near("home") },
    });
    expect(retried.match).toBe("any");
    expect(retried.hits.find((hit) => hit.recordId === dog.recordId)?.match).toBeUndefined();
    expect(retried.hits.find((hit) => hit.recordId === home.recordId)?.match).toBe("meaning");
  });

  it("blank words with a meaning recall by vector alone, through the same eligibility; without a vector they answer no hits; blank and meaningless is refused", () => {
    const { service, remember, embed } = fixture();
    const home = remember(alice, "Based in Lisbon");
    const work = remember(alice, "Works at Acme");
    const bare = remember(alice, "Has a cat");
    const theirs = remember(bob, "Based in Porto");
    embed(home.recordId, near("home"));
    embed(work.recordId, near("work"));
    embed(theirs.recordId, near("home"));
    const result = service.search({
      actor: alice,
      query: "",
      match: "any",
      semantic: "where do I stay?",
      queryVector: { modelKey: MODEL, vector: near("home") },
    });
    expect(result.hits[0]?.recordId).toBe(home.recordId);
    expect(result.hits.map((hit) => hit.recordId)).not.toContain(theirs.recordId);
    expect(result.hits.map((hit) => hit.recordId)).not.toContain(bare.recordId);
    expect(result.coverage).toBe("partial");
    expect(result.reducedReason).toMatch(/1 of 3 records have no vector yet, and the message held no words/);
    // Lexical (no vector): nothing to match, as when no search ran.
    expect(service.search({ actor: alice, query: " ", semantic: "where do I stay?" })).toEqual({ hits: [], coverage: "complete" });
    expect(() => service.search({ actor: alice, query: " " })).toThrow(/blank/);
    expect(() => service.search({ actor: alice, query: "", view: "operator", semantic: "where do I stay?" })).toThrow(/blank/);
  });

  it("an exact preference or topic key match joins the fusion", () => {
    const { service, remember, embed } = fixture();
    const pref = service.remember({
      actor: alice,
      scope: personal("alice"),
      kind: "preference",
      preferenceKey: "reply.language",
      preference: { valueType: "string", value: "pt" },
      body: "Answers in Portuguese",
    });
    const other = remember(alice, "Likes long walks");
    embed(pref.recordId, near("food"));
    embed(other.recordId, near("pet"));
    const result = service.search({
      actor: alice,
      query: "reply language",
      match: "any",
      queryVector: { modelKey: MODEL, vector: near("pet") },
    });
    expect(result.hits.map((hit) => hit.recordId)).toContain(pref.recordId);
    expect(result.hits.find((hit) => hit.recordId === pref.recordId)?.match).toBeUndefined();
    expect(result.hits.find((hit) => hit.recordId === other.recordId)?.match).toBe("meaning");
  });

  it("memory invariant 4: recall is filtered before it is ranked — another person's, revoked, ended and sensitive records are never scored", () => {
    const { service, memory, remember, embed } = fixture();
    const mine = remember(alice, "Based in Lisbon");
    const theirs = remember(bob, "Based in Porto");
    const revoked = remember(alice, "Lived in Berlin");
    const ended = remember(alice, "Staying in Rome", { validTo: "2026-10-11T10:00:00.000Z" });
    for (const record of [mine, theirs, revoked, ended]) embed(record.recordId, near("home"));
    service.revoke({ actor: alice, recordId: revoked.recordId, reason: "wrong" });
    const sensitive = remember(alice, "Lives with a chronic illness at home", { sensitivity: "sensitive" });
    // A sensitive record never gets a vector, even when one is offered for it.
    expect(embed(sensitive.recordId, near("home"))).toBe(0);
    const candidates = memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: LATER,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
    });
    expect(candidates.ranked.map((hit) => hit.recordId)).toEqual([mine.recordId]);
    expect(candidates.eligible).toBe(1);
    const result = service.search({ actor: alice, query: "home", match: "any", queryVector: { modelKey: MODEL, vector: near("home") } });
    expect(result.hits.map((hit) => hit.recordId)).not.toContain(theirs.recordId);
    expect(result.hits.map((hit) => hit.recordId)).not.toContain(revoked.recordId);
    expect(result.hits.map((hit) => hit.recordId)).not.toContain(sensitive.recordId);
  });

  it("memory invariant 9: a forgotten record's vector is gone in the same transaction and evicted from the cache, so the next scoring never sees it", () => {
    const { store, service, memory, remember, embed, vectorRows } = fixture();
    const record = remember(alice, "Based in Lisbon");
    const other = remember(alice, "Works at Acme");
    embed(record.recordId, near("home"));
    embed(other.recordId, near("work"));
    // The first hybrid recall loads the workspace's cache.
    memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
    });
    expect(store.memoryVectors.size("w1").vectors).toBe(2);
    service.forget({ actor: alice, recordId: record.recordId, reason: "asked" });
    expect(vectorRows()).toBe(1);
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
    const after = memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
    });
    expect(after.ranked.map((hit) => hit.recordId)).toEqual([other.recordId]);
  });

  it("revoke, a correction (supersede) and expiry delete the record's vectors too", () => {
    const { service, at, remember, embed, vectorRows } = fixture();
    const revoked = remember(alice, "Lived in Berlin");
    const corrected = remember(alice, "Works at Acme");
    const expiring = service.remember({
      actor: alice,
      scope: personal("alice"),
      kind: "lesson",
      body: "Reply briefly this week",
      expiryAt: "2026-10-11T10:00:00.000Z",
    });
    for (const record of [revoked, corrected, expiring]) embed(record.recordId, near("work"));
    expect(vectorRows()).toBe(3);
    service.revoke({ actor: alice, recordId: revoked.recordId, reason: "wrong" });
    expect(vectorRows()).toBe(2);
    service.correct({ actor: alice, recordId: corrected.recordId, body: "Works at Initech" });
    expect(vectorRows()).toBe(1);
    at(LATER).sweepExpired({ actor: alice });
    expect(vectorRows()).toBe(0);
  });

  it("approving a tidy-up deletes the vectors of the inputs it supersedes, in the approval's transaction", () => {
    const { store, service, memory, remember, embed, vectorRows } = fixture();
    const first = remember(alice, "Answer briefly");
    const second = remember(alice, "Answer in English");
    const kept = remember(alice, "Based in Lisbon");
    for (const record of [first, second, kept]) embed(record.recordId, near("work"));
    memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("work"),
      limit: 10,
    });
    expect(store.memoryVectors.size("w1").vectors).toBe(3);
    const merged = service.propose({
      actor: { ...alice, authority: "model", caller: "agent" },
      scope: personal("alice"),
      kind: "fact",
      body: "Answer briefly, in English",
      supersedes: [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId! })),
    });
    // A proposal is not approved: it has no vector, and its inputs keep theirs until it is.
    expect(vectorRows()).toBe(3);
    service.approve({ actor: alice, recordId: merged.recordId });
    expect(vectorRows()).toBe(1);
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
    expect(
      memory
        .vectorBacklog({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, limit: 10, maxFailures: 3 })
        .map((entry) => entry.text),
    ).toEqual(["Answer briefly, in English"]);
  });

  it("a preference value past its expiry, expired when a new value is approved, loses its vectors with its status (one transaction)", () => {
    const { service, at, memory, embed, vectorRows } = fixture();
    const old = service.remember({
      actor: alice,
      scope: personal("alice"),
      kind: "preference",
      preferenceKey: "reply.tone",
      preference: { valueType: "string", value: "formal" },
      body: "Formal replies",
      expiryAt: "2026-10-11T10:00:00.000Z",
    });
    embed(old.recordId, near("work"));
    expect(vectorRows()).toBe(1);
    const next = service.propose({
      actor: { ...alice, authority: "model", caller: "agent" },
      scope: personal("alice"),
      kind: "preference",
      preferenceKey: "reply.tone",
      preference: { valueType: "string", value: "casual" },
      body: "Casual replies",
    });
    // Approved after the old value lapsed (before the sweep marked it): the old one is expired and its vectors go with it.
    at(LATER).approve({ actor: alice, recordId: next.recordId });
    expect(memory.getRecord(old.recordId)?.status).toBe("expired");
    expect(vectorRows()).toBe(0);
  });

  it("memory invariant 4: a record citing a revoked source is left out before ranking, so it never takes one of the limit's slots", () => {
    const { store, service, memory, remember, embed } = fixture();
    memory.insertEvidence({
      sourceId: "src-1",
      scopeKey: "personal|p=alice",
      operatorInput: true,
      observedAt: NOW,
      contentHash: "h",
      captureBasis: "explicit",
      retentionPolicy: "standard",
      revocationStatus: "active",
    });
    const cited = remember(alice, "Lived in Berlin", { sourceIds: ["src-1"] });
    const good = remember(alice, "Based in Lisbon");
    // The cited record is the nearer one: it would rank first.
    embed(cited.recordId, near("home", 3));
    embed(good.recordId, [1, 0.6, 0, 0]);
    store.handle.prepare("UPDATE tavi_evidence_sources SET revocation_status = 'revoked' WHERE source_id = ?").run("src-1");
    const result = service.search({
      actor: alice,
      query: "where do i live",
      match: "any",
      limit: 1,
      queryVector: { modelKey: MODEL, vector: near("home") },
    });
    expect(result.hits.map((hit) => hit.recordId)).toEqual([good.recordId]);
    const candidates = memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 1,
      excludeSourceIds: ["src-1"],
    });
    expect(candidates).toMatchObject({ eligible: 1, missing: 0, ranked: [{ recordId: good.recordId }] });
  });

  it("personal: false leaves personal records out of meaning search, neither scored nor missing; pruning drops vectors of personal records no binding may embed", () => {
    const { store, service, memory, remember, embed, vectorRows } = fixture();
    const mine = remember(alice, "Based in Lisbon");
    const own = service.remember({
      actor: alice,
      scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "w1" },
      kind: "fact",
      body: "The team meets in Lisbon",
    });
    remember(alice, "Has a cat");
    embed(mine.recordId, near("home"));
    embed(own.recordId, near("home"));
    const scopeKeys = ["personal|p=alice", memory.getRecord(own.recordId)!.scopeKey];
    const all = memory.vectorCandidates({ scopeKeys, workspaceId: "w1", now: NOW, modelKey: MODEL, vector: near("home"), limit: 10 });
    expect(all).toMatchObject({ eligible: 3, missing: 1 });
    const kept = memory.vectorCandidates({
      scopeKeys,
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
      personal: false,
    });
    expect(kept).toMatchObject({ eligible: 1, missing: 0 });
    expect(kept.ranked.map((hit) => hit.recordId)).toEqual([own.recordId]);
    // Bob may keep his; alice's personal vector of the model goes (and leaves the cache); the workspace's own stays.
    expect(store.memoryVectors.size("w1").vectors).toBe(2);
    expect(memory.pruneVectors({ keepModelKeys: [MODEL], keepPersonal: [{ modelKey: MODEL, principalIds: ["bob"] }] })).toBe(1);
    expect(vectorRows()).toBe(1);
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
    // Listed for alice: nothing more goes.
    expect(memory.pruneVectors({ keepModelKeys: [MODEL], keepPersonal: [{ modelKey: MODEL, principalIds: ["alice"] }] })).toBe(0);
  });

  it("a record with no vector of the query's model ranks by its words only, and coverage is partial", () => {
    const { service, remember, embed } = fixture();
    const embedded = remember(alice, "Based in Lisbon");
    const bare = remember(alice, "Lisbon flat rent is due monthly");
    embed(embedded.recordId, near("home"));
    const result = service.search({ actor: alice, query: "lisbon", match: "any", queryVector: { modelKey: MODEL, vector: near("home") } });
    expect(result.coverage).toBe("partial");
    expect(result.reducedReason).toMatch(/1 of 2 records have no vector/);
    expect(result.hits.map((hit) => hit.recordId).sort()).toEqual([embedded.recordId, bare.recordId].sort());
    // Vectors of another model are missing to this one: a model change is partial until re-embedded.
    const changed = service.search({
      actor: alice,
      query: "lisbon",
      match: "any",
      queryVector: { modelKey: "fixture/embed-2", vector: near("home") },
    });
    expect(changed.coverage).toBe("partial");
  });

  it("the backlog lists approved, current, non-sensitive revisions without a vector of the model, re-lists them on a model change, and skips a text after three failures", () => {
    const { service, memory, remember, embed } = fixture();
    const one = remember(alice, "Based in Lisbon");
    const two = service.remember({
      actor: alice,
      scope: personal("alice"),
      kind: "preference",
      preferenceKey: "reply.language",
      preference: { valueType: "string", value: "pt" },
      body: "Answers in Portuguese",
    });
    remember(alice, "Takes insulin daily", { sensitivity: "sensitive" });
    service.propose({
      actor: { ...alice, authority: "model", caller: "agent" },
      scope: personal("alice"),
      kind: "fact",
      body: "Waiting for a person",
    });
    const backlog = memory.vectorBacklog({
      workspaceId: "w1",
      principalIds: ["alice"],
      modelKey: MODEL,
      now: NOW,
      limit: 10,
      maxFailures: 3,
    });
    expect(backlog.map((entry) => entry.text)).toEqual(["Based in Lisbon", "Answers in Portuguese\nreply.language: pt"]);
    embed(one.recordId, near("home"));
    expect(
      memory
        .vectorBacklog({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, limit: 10, maxFailures: 3 })
        .map((entry) => entry.revisionId),
    ).toEqual([two.currentRevisionId]);
    // Narrowed to named revisions: what the backfill's one-by-one retry asks for.
    expect(
      memory
        .vectorBacklog({
          workspaceId: "w1",
          principalIds: ["alice"],
          modelKey: MODEL,
          now: NOW,
          limit: 10,
          maxFailures: 3,
          revisionIds: [one.currentRevisionId!, two.currentRevisionId!],
        })
        .map((entry) => entry.revisionId),
    ).toEqual([two.currentRevisionId]);
    // Another model: both are due again.
    expect(
      memory.vectorBacklog({
        workspaceId: "w1",
        principalIds: ["alice"],
        modelKey: "fixture/embed-2",
        now: NOW,
        limit: 10,
        maxFailures: 3,
      }),
    ).toHaveLength(2);
    for (let attempt = 0; attempt < 3; attempt += 1)
      memory.recordVectorFailures({ revisionIds: [two.currentRevisionId!], modelKey: MODEL, now: NOW });
    expect(
      memory.vectorBacklog({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, limit: 10, maxFailures: 3 }),
    ).toEqual([]);
    expect(memory.vectorStats({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, maxFailures: 3 })).toMatchObject({
      eligible: 2,
      indexed: 1,
      failed: 1,
      missing: 0,
    });
    // Each model counts its own: a failure on another model leaves this one's count, and is that model's first.
    memory.recordVectorFailures({ revisionIds: [two.currentRevisionId!], modelKey: "fixture/embed-2", now: NOW });
    expect(
      memory.vectorBacklog({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, limit: 10, maxFailures: 3 }),
    ).toEqual([]);
    expect(
      memory.vectorBacklog({
        workspaceId: "w1",
        principalIds: ["alice"],
        modelKey: "fixture/embed-2",
        now: NOW,
        limit: 10,
        maxFailures: 3,
      }),
    ).toHaveLength(2);
  });

  it("the backlog and the disclosure's count hold the workspace's records and the personal ones of the people it serves, never another person's", () => {
    const { service, memory, remember } = fixture();
    remember(alice, "Based in Lisbon");
    const theirs = remember(bob, "Based in Porto");
    service.remember({
      actor: alice,
      scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "w1" },
      kind: "fact",
      body: "The team meets on Mondays",
    });
    const backlog = memory.vectorBacklog({
      workspaceId: "w1",
      principalIds: ["alice"],
      modelKey: MODEL,
      now: NOW,
      limit: 10,
      maxFailures: 3,
    });
    expect(backlog.map((entry) => entry.text).sort()).toEqual(["Based in Lisbon", "The team meets on Mondays"]);
    expect(backlog.map((entry) => entry.revisionId)).not.toContain(theirs.currentRevisionId);
    expect(memory.vectorStats({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, maxFailures: 3 })).toMatchObject({
      eligible: 2,
      personal: 1,
    });
    // Once bob is one of the people the workspace serves, his personal memory is counted, apart.
    expect(
      memory.vectorStats({ workspaceId: "w1", principalIds: ["alice", "bob"], modelKey: MODEL, now: NOW, maxFailures: 3 }),
    ).toMatchObject({ eligible: 3, personal: 2 });
  });

  it("vectors are kept per revision and model: two workspaces on different models reach a steady state, and a model no workspace binds is pruned", () => {
    const { store, memory, remember, embed, vectorRows } = fixture();
    const record = remember(alice, "Based in Lisbon");
    const other = "fixture/embed-2";
    const due = (modelKey: string) =>
      memory.vectorBacklog({ workspaceId: "w1", principalIds: ["alice"], modelKey, now: NOW, limit: 10, maxFailures: 3 });
    embed(record.recordId, near("home"));
    memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
    });
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
    // The other model's vector of the same revision leaves the first one, and the first one's cache, as they were.
    embed(record.recordId, near("work"), other);
    expect(vectorRows()).toBe(2);
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
    expect(due(MODEL)).toEqual([]);
    expect(due(other)).toEqual([]);
    memory.recordVectorFailures({ revisionIds: [record.currentRevisionId!], modelKey: "fixture/embed-3", now: NOW });
    expect(memory.pruneVectors({ keepModelKeys: [other] })).toBe(1);
    expect(vectorRows()).toBe(1);
    expect((store.handle.prepare("SELECT count(*) AS n FROM tavi_memory_vector_failures").get() as { n: number }).n).toBe(0);
    // The pruned model's cache went with its vectors.
    expect(store.memoryVectors.size("w1").vectors).toBe(0);
    expect(due(other)).toEqual([]);
  });

  it("memory invariant 7: a sensitive record is never in the backlog and never stored, so it never reaches an embedding model", () => {
    const { memory, remember, embed, vectorRows } = fixture();
    const sensitive = remember(alice, "Takes insulin daily", { sensitivity: "sensitive" });
    expect(
      memory.vectorBacklog({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, limit: 10, maxFailures: 3 }),
    ).toEqual([]);
    expect(embed(sensitive.recordId, near("food"))).toBe(0);
    expect(vectorRows()).toBe(0);
  });

  it("a record ended or expired since the backlog was read gets no vector", () => {
    const { memory, remember, vectorRows } = fixture();
    const ended = remember(alice, "Staying in Rome", { validTo: "2026-10-11T10:00:00.000Z" });
    const expired = remember(alice, "Reply briefly this week", { expiryAt: "2026-10-11T10:00:00.000Z" });
    const put = (recordId: string) =>
      memory.putVectors({
        vectors: [{ revisionId: memory.getRecord(recordId)!.currentRevisionId!, modelKey: MODEL, vector: near("home") }],
        now: LATER,
      });
    expect(put(ended.recordId)).toBe(0);
    expect(put(expired.recordId)).toBe(0);
    expect(vectorRows()).toBe(0);
  });

  it("a putVectors that rolls back leaves the cache as it was: the cache takes vectors only after the commit", () => {
    const { store, memory, remember, embed, vectorRows } = fixture();
    const loaded = remember(alice, "Based in Lisbon");
    embed(loaded.recordId, near("home"));
    memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
    });
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
    const good = remember(alice, "Works at Acme");
    const bad = remember(alice, "Has a cat");
    const badRevision = memory.getRecord(bad.recordId)!.currentRevisionId!;
    store.handle.exec(
      `CREATE TEMP TRIGGER refuse_vector BEFORE INSERT ON tavi_memory_vectors WHEN NEW.revision_id = '${badRevision}' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    expect(() =>
      memory.putVectors({
        vectors: [
          { revisionId: memory.getRecord(good.recordId)!.currentRevisionId!, modelKey: MODEL, vector: near("work") },
          { revisionId: badRevision, modelKey: MODEL, vector: near("pet") },
        ],
        now: NOW,
      }),
    ).toThrow(/refused/);
    expect(vectorRows()).toBe(1);
    expect(store.memoryVectors.size("w1").vectors).toBe(1);
  });

  it("the cache is built on first hybrid recall, joined by new vectors, and dropped on a return to lexical", () => {
    const { store, memory, remember, embed } = fixture();
    const one = remember(alice, "Based in Lisbon");
    embed(one.recordId, near("home"));
    expect(store.memoryVectors.size("w1").vectors).toBe(0);
    memory.vectorCandidates({
      scopeKeys: ["personal|p=alice"],
      workspaceId: "w1",
      now: NOW,
      modelKey: MODEL,
      vector: near("home"),
      limit: 10,
    });
    expect(store.memoryVectors.size("w1")).toEqual({ vectors: 1, bytes: 16 });
    const two = remember(alice, "Works at Acme");
    embed(two.recordId, near("work"));
    expect(store.memoryVectors.size("w1").vectors).toBe(2);
    expect(memory.vectorStats({ workspaceId: "w1", principalIds: ["alice"], modelKey: MODEL, now: NOW, maxFailures: 3 })).toMatchObject({
      eligible: 2,
      indexed: 2,
      cachedVectors: 2,
      cachedBytes: 32,
    });
    memory.dropVectorCache("w1");
    expect(store.memoryVectors.size("w1").vectors).toBe(0);
  });

  it("applies the hybrid cosine floor (0.30) and vector MMR near-duplicate filter (0.90) when applyFloor is true", () => {
    const { service, remember, embed } = fixture();
    const strongSemantic = remember(alice, "Sister Ana was born on May 14.");
    const vectorDup = remember(alice, "Ana celebrates her natal day in mid-May.");
    const weakDistractor = remember(alice, "Quarterly tax filing deadline is April 15.");
    embed(strongSemantic.recordId, [1, 0, 0, 0]);
    // Dot product with [1, 0, 0, 0] is ~0.98 >= 0.90 (vector near-duplicate of strongSemantic, low token Jaccard).
    embed(vectorDup.recordId, [0.98, 0.19, 0, 0]);
    // Dot product with [1, 0, 0, 0] is 0.10 < 0.30 (below hybrid cosine floor).
    embed(weakDistractor.recordId, [0.1, 0.99, 0, 0]);

    const unfiltered = service.search({
      actor: alice,
      query: "",
      semantic: "when is her birthday?",
      queryVector: { modelKey: MODEL, vector: [1, 0, 0, 0] },
    });
    expect(unfiltered.hits.map((hit) => hit.recordId)).toEqual([strongSemantic.recordId, vectorDup.recordId, weakDistractor.recordId]);

    const floored = service.search({
      actor: alice,
      query: "",
      semantic: "when is her birthday?",
      applyFloor: true,
      queryVector: { modelKey: MODEL, vector: [1, 0, 0, 0] },
    });
    expect(floored.hits.map((hit) => hit.recordId)).toEqual([strongSemantic.recordId]);
  });
});

describe("scoring speed", () => {
  // A wall-time budget: coverage instrumentation (`pnpm test:coverage` sets TAVI_COVERAGE) slows the loop several-fold.
  it.skipIf(process.env["TAVI_COVERAGE"] === "1")("scores 20,000 cached 1,536-dimension vectors in under 100 ms", () => {
    const dims = 1_536;
    const count = 20_000;
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648 - 0.5;
    };
    const vectors = new Map<string, Float32Array>();
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const values = new Array<number>(dims);
      for (let dim = 0; dim < dims; dim += 1) values[dim] = random();
      const id = `rev-${index}`;
      vectors.set(id, unitVector(values)!);
      ids.push(id);
    }
    const query = unitVector(Array.from({ length: dims }, random))!;
    // Warm once (JIT), then take the best of five runs, as a turn on a warm worker would see.
    scoreVectors(query, ids, vectors, 40);
    const times: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      const scored = scoreVectors(query, ids, vectors, 40);
      times.push(performance.now() - started);
      expect(scored.ranked).toHaveLength(40);
      expect(scored.missing).toBe(0);
    }
    const best = Math.min(...times);
    const median = [...times].sort((a, b) => a - b)[2]!;
    console.info(`[memory vector scoring] ${count} x ${dims}: best ${best.toFixed(1)} ms, median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(100);
  });
});
