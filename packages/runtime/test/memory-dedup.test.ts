import { afterEach, describe, expect, it } from "vitest";

import { MEMORY_NEAR_MATCH_JACCARD, memoryTextSimilarity, type MemoryActor, type MemoryScope } from "@tavi/contracts";

import { memoryContentKey } from "../src/memory/content-key.js";
import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Dedup and updates: exact
 * dedup by a content key — a SHA-256 hash of the normalised content, never the
 * text, cleared on forget — against pending proposals and records in force
 * only; and automatic capture's near-match drop.
 */

const THURSDAY = "2026-01-01T00:00:00.000Z";
const END_OF_FRIDAY = "2026-01-03T00:00:00.000Z";
const NEXT_MONTH = "2026-02-02T09:00:00.000Z";

const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const model: MemoryActor = { ...alice, caller: "agent", authority: "model" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => {
    store.close();
  });
  const persistence = store.asPort();
  let counter = 0;
  const newId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  const when = (now: string): MemoryService => new MemoryService(persistence, { now: () => now, newId });
  const keyOf = (recordId: string): string | null =>
    (
      store.handle.prepare("SELECT content_key FROM tavi_memory_records WHERE record_id = ?").get(recordId) as {
        content_key: string | null;
      }
    ).content_key;
  const count = (): number => (store.handle.prepare("SELECT count(*) AS n FROM tavi_memory_records").get() as { n: number }).n;
  return { store, when, keyOf, count };
}

describe("exact dedup", () => {
  it("memory invariant 16: the same proposal filed twice is one record, matched case- and space-folded, against a proposal or a kept record", () => {
    const { when, count } = fixture();
    const service = when(THURSDAY);
    const first = service.propose({ actor: model, scope: personal, kind: "fact", body: "You're vegetarian" });
    expect(first.known).toBeUndefined();
    const again = service.propose({ actor: model, scope: personal, kind: "fact", body: "  YOU'RE   vegetarian " });
    expect(again).toMatchObject({ recordId: first.recordId, known: "exact", status: "proposed" });
    expect(count()).toBe(1);
    // Kept, the same words again are that record, already known.
    service.approve({ actor: alice, recordId: first.recordId });
    expect(service.propose({ actor: model, scope: personal, kind: "fact", body: "you're vegetarian" })).toMatchObject({
      recordId: first.recordId,
      known: "exact",
      status: "approved",
    });
    // `remember` of kept words is the kept record, not a second one.
    expect(service.remember({ actor: alice, scope: personal, kind: "fact", body: "You're vegetarian" }).recordId).toBe(first.recordId);
    expect(count()).toBe(1);
    // Another kind, scope or preference value is another proposal.
    service.propose({ actor: model, scope: personal, kind: "lesson", body: "You're vegetarian" });
    service.propose({
      actor: { ...model, runId: "chat" },
      scope: { kind: "run_local", principalId: "alice", workspaceId: "w1", runId: "chat" },
      kind: "fact",
      body: "You're vegetarian",
      durable: true,
    });
    expect(count()).toBe(3);
    const spanish = service.propose({
      actor: model,
      scope: personal,
      kind: "preference",
      preferenceKey: "reply.language",
      preference: { valueType: "string", value: "es" },
      body: "Reply language",
    });
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "preference",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "fr" },
        body: "Reply language",
      }).recordId,
    ).not.toBe(spanish.recordId);
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "preference",
        preferenceKey: "reply.language",
        preference: { valueType: "string", value: "ES" },
        body: "reply   language",
      }).known,
    ).toBe("exact");
  });

  it("remember of words already kept or waiting is that record, said as known; a waiting proposal of them is approved", () => {
    const { when, count } = fixture();
    const service = when(THURSDAY);
    const first = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Cycles to work" });
    expect(first.known).toBeUndefined();
    expect(service.remember({ actor: alice, scope: personal, kind: "fact", body: "cycles  TO work" })).toMatchObject({
      recordId: first.recordId,
      status: "approved",
      known: "exact",
    });
    const waiting = service.propose({ actor: model, scope: personal, kind: "fact", body: "Owns a kayak" });
    expect(service.remember({ actor: alice, scope: personal, kind: "fact", body: "Owns a kayak" })).toMatchObject({
      recordId: waiting.recordId,
      status: "approved",
      known: "exact",
    });
    expect(count()).toBe(2);
  });

  it("the key is a hash, never the text; a correction re-keys the record", () => {
    const { when, keyOf } = fixture();
    const service = when(THURSDAY);
    const record = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Works at Acme" });
    const key = keyOf(record.recordId);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(memoryContentKey({ kind: "fact", scopeKey: record.scopeKey, body: "works  at ACME" }));
    service.correct({ actor: alice, recordId: record.recordId, body: "Works at Initech" });
    expect(keyOf(record.recordId)).toBe(memoryContentKey({ kind: "fact", scopeKey: record.scopeKey, body: "Works at Initech" }));
    expect(service.propose({ actor: model, scope: personal, kind: "fact", body: "Works at Initech" }).known).toBe("exact");
    expect(service.propose({ actor: model, scope: personal, kind: "fact", body: "Works at Acme" }).known).toBeUndefined();
  });

  it("the same time-bound fact proposed again after its first record ended is a new proposal, and the ended record is untouched", () => {
    const { when } = fixture();
    const trip = when(THURSDAY).remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Travelling to Lisbon until Friday",
      validTo: END_OF_FRIDAY,
    });
    const later = when(NEXT_MONTH);
    const again = later.propose({ actor: model, scope: personal, kind: "fact", body: "Travelling to Lisbon until Friday" });
    expect(again.known).toBeUndefined();
    expect(again.recordId).not.toBe(trip.recordId);
    expect(later.get({ actor: alice, recordId: trip.recordId })).toMatchObject({ status: "approved", validTo: END_OF_FRIDAY });
    // A rejected proposal is not live either: the same words may be proposed again.
    later.reject({ actor: alice, recordId: again.recordId });
    expect(later.propose({ actor: model, scope: personal, kind: "fact", body: "Travelling to Lisbon until Friday" }).known).toBeUndefined();
  });

  it("a pending proposal past its own end date is stale: the same words said again are a new proposal, not already known", () => {
    const { when } = fixture();
    const stale = when(THURSDAY).propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Travelling to Porto until Friday",
      validTo: END_OF_FRIDAY,
    });
    const later = when(NEXT_MONTH);
    const again = later.propose({ actor: model, scope: personal, kind: "fact", body: "Travelling to Porto until Friday" });
    expect(again.known).toBeUndefined();
    expect(again.recordId).not.toBe(stale.recordId);
    // Before its date, the proposal is still the one those words are.
    const fresh = when(THURSDAY).propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Hiking in Sintra until Friday",
      validTo: END_OF_FRIDAY,
    });
    expect(when(THURSDAY).propose({ actor: model, scope: personal, kind: "fact", body: "hiking in sintra until friday" })).toMatchObject({
      recordId: fresh.recordId,
      known: "exact",
    });
  });

  it("memory invariant 9: a forgotten record keeps no content key, and its words are no longer known", () => {
    const { store, when, keyOf } = fixture();
    const service = when(THURSDAY);
    const record = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Allergic to peanuts" });
    expect(keyOf(record.recordId)).not.toBeNull();
    service.forget({ actor: alice, recordId: record.recordId, reason: "test" });
    expect(keyOf(record.recordId)).toBeNull();
    // Nothing left in the record row can be matched against its words.
    const key = memoryContentKey({ kind: "fact", scopeKey: record.scopeKey, body: "Allergic to peanuts" });
    expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_memory_records WHERE content_key = ?").get(key)).toEqual({ n: 0 });
    expect(service.propose({ actor: model, scope: personal, kind: "fact", body: "Allergic to peanuts" }).known).toBeUndefined();
  });
});

describe("automatic capture's near-match drop", () => {
  it("drops a near match of a record in force only when asked (capture), and files it from the tool", () => {
    const { when, count } = fixture();
    const service = when(THURSDAY);
    const kept = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Alice lives in Lisbon with her two cats and a dog",
    });
    const near = "Alice lives in Lisbon with her two cats and dog";
    expect(memoryTextSimilarity(near, "Alice lives in Lisbon with her two cats and a dog")).toBeGreaterThanOrEqual(
      MEMORY_NEAR_MATCH_JACCARD,
    );
    expect(service.propose({ actor: model, scope: personal, kind: "fact", body: near, nearMatch: "drop" })).toMatchObject({
      recordId: kept.recordId,
      known: "near",
    });
    expect(count()).toBe(1);
    // Different enough is filed, and the tool's path files a near match.
    expect(
      service.propose({ actor: model, scope: personal, kind: "fact", body: "Alice moved to Porto last spring", nearMatch: "drop" }).known,
    ).toBeUndefined();
    expect(service.propose({ actor: model, scope: personal, kind: "fact", body: near }).known).toBeUndefined();
    expect(count()).toBe(3);
  });
});

describe("capture's near match by meaning under hybrid", () => {
  it("drops a draft whose vector has cosine at least 0.92 with a record in force of its kind, and files one further off, of another kind, or not asked", () => {
    const { store, when, count } = fixture();
    const service = when(THURSDAY);
    const memory = store.asPort().repositories.memory;
    const MODEL = "local/embed";
    const kept = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Alice lives in Lisbon" });
    const lesson = service.remember({ actor: alice, scope: personal, kind: "lesson", body: "Run the tests before a release" });
    memory.putVectors({
      vectors: [
        { revisionId: kept.currentRevisionId!, modelKey: MODEL, vector: [1, 0, 0, 0] },
        { revisionId: lesson.currentRevisionId!, modelKey: MODEL, vector: [0, 0, 1, 0] },
      ],
      now: THURSDAY,
    });
    // No shared words, so only meaning can match: cos ≈ 0.95.
    const draft = { actor: model, scope: personal, kind: "fact" as const, body: "Her home is the Portuguese capital" };
    expect(memoryTextSimilarity(draft.body, "Alice lives in Lisbon")).toBeLessThan(MEMORY_NEAR_MATCH_JACCARD);
    expect(
      service.propose({ ...draft, nearMatch: "drop", nearMatchVector: { modelKey: MODEL, vector: [0.95, 0.31, 0, 0] } }),
    ).toMatchObject({ recordId: kept.recordId, known: "near" });
    expect(count()).toBe(2);
    // cos = 0.8: filed. Another model's vectors are never compared.
    expect(
      service.propose({ ...draft, nearMatch: "drop", nearMatchVector: { modelKey: MODEL, vector: [0.8, 0.6, 0, 0] } }).known,
    ).toBeUndefined();
    expect(
      service.propose({
        ...draft,
        body: "Her home city is the Portuguese capital",
        nearMatch: "drop",
        nearMatchVector: { modelKey: "other/embed", vector: [1, 0, 0, 0] },
      }).known,
    ).toBeUndefined();
    // Close to the lesson, but a fact: filed. And the tool's path (no drop asked) files whatever the vector.
    expect(
      service.propose({
        ...draft,
        body: "Alice tests every release",
        nearMatch: "drop",
        nearMatchVector: { modelKey: MODEL, vector: [0, 0, 1, 0] },
      }).known,
    ).toBeUndefined();
    expect(
      service.propose({ ...draft, body: "Alice resides in the capital", nearMatchVector: { modelKey: MODEL, vector: [1, 0, 0, 0] } }).known,
    ).toBeUndefined();
    expect(count()).toBe(6);
  });
});

describe("auto-approve's kin", () => {
  it("names a kept record of the proposal's kind and scope akin to it by words (Jaccard ≥ 0.5) or, given a vector, by meaning (cosine ≥ 0.8); null for none, nothing unasked", () => {
    const { store, when } = fixture();
    const service = when(THURSDAY);
    const lisbon = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Lives in Lisbon" });
    service.remember({ actor: alice, scope: personal, kind: "lesson", body: "Run the tests before a release" });
    // A contradiction, not a near match: one word of four differs, so it is a possible update (`mayUpdate`) as well as kin.
    const berlin = service.propose({ actor: model, scope: personal, kind: "fact", body: "Lives in Berlin" });
    expect(memoryTextSimilarity("Lives in Berlin", "Lives in Lisbon")).toBeLessThan(MEMORY_NEAR_MATCH_JACCARD);
    expect(service.related({ actor: alice, recordId: berlin.recordId })).toEqual({
      mayUpdate: { recordId: lisbon.recordId, title: "Lives in Lisbon", currentRevisionId: lisbon.currentRevisionId },
    });
    expect(service.related({ actor: alice, recordId: berlin.recordId, kin: {} })).toEqual({
      mayUpdate: { recordId: lisbon.recordId, title: "Lives in Lisbon", currentRevisionId: lisbon.currentRevisionId },
      kin: { recordId: lisbon.recordId, title: "Lives in Lisbon" },
    });
    // Another kind, or words too far off: none.
    const lessonLike = service.propose({ actor: model, scope: personal, kind: "fact", body: "Runs the tests before a release" });
    expect(service.related({ actor: alice, recordId: lessonLike.recordId, kin: {} })).toEqual({ kin: null });
    const far = service.propose({ actor: model, scope: personal, kind: "fact", body: "Her home is the Portuguese capital" });
    expect(service.related({ actor: alice, recordId: far.recordId, kin: {} })).toEqual({ kin: null });
    // By meaning, given the draft's vector: cosine 0.8 counts, 0.6 does not, another model's vectors are never compared.
    const MODEL = "local/embed";
    store.asPort().repositories.memory.putVectors({
      vectors: [{ revisionId: lisbon.currentRevisionId!, modelKey: MODEL, vector: [1, 0, 0, 0] }],
      now: THURSDAY,
    });
    expect(
      service.related({ actor: alice, recordId: far.recordId, kin: { vector: { modelKey: MODEL, vector: [0.8, 0.6, 0, 0] } } }),
    ).toEqual({
      mayUpdate: { recordId: lisbon.recordId, title: "Lives in Lisbon", currentRevisionId: lisbon.currentRevisionId },
      kin: { recordId: lisbon.recordId, title: "Lives in Lisbon" },
    });
    expect(
      service.related({ actor: alice, recordId: far.recordId, kin: { vector: { modelKey: MODEL, vector: [0.6, 0.8, 0, 0] } } }),
    ).toEqual({ kin: null });
    expect(
      service.related({ actor: alice, recordId: far.recordId, kin: { vector: { modelKey: "other/embed", vector: [1, 0, 0, 0] } } }),
    ).toEqual({ kin: null });
    // An unreadable index answers no kin, which auto-approve reads as akin.
    store.handle.exec("DROP TABLE tavi_memory_fts");
    expect(service.related({ actor: alice, recordId: far.recordId, kin: {} })).toEqual({});
  });
});

describe("capture's near-match drop leaves updates and other kinds alone", () => {
  it("a captured preference update with a near-identical body is filed, as is a fact that shares a lesson's words", () => {
    const { when, count } = fixture();
    const service = when(THURSDAY);
    const british = "Prefers British English spelling in every reply and every written summary";
    const american = "Prefers American English spelling in every reply and every written summary";
    expect(memoryTextSimilarity(british, american)).toBeGreaterThanOrEqual(MEMORY_NEAR_MATCH_JACCARD);
    service.remember({
      actor: alice,
      scope: personal,
      kind: "preference",
      preferenceKey: "spelling",
      preference: { valueType: "string", value: "British" },
      body: british,
    });
    const update = service.propose({
      actor: model,
      scope: personal,
      kind: "preference",
      preferenceKey: "spelling",
      preference: { valueType: "string", value: "American" },
      body: american,
      nearMatch: "drop",
    });
    expect(update.known).toBeUndefined();
    // The same body with another value is an update too.
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "preference",
        preferenceKey: "spelling",
        preference: { valueType: "string", value: "Canadian" },
        body: british,
        nearMatch: "drop",
      }).known,
    ).toBeUndefined();
    const lesson = "Check the release notes before every upgrade of the build tools";
    service.remember({ actor: alice, scope: personal, kind: "lesson", body: lesson });
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "fact",
        body: "Check the release notes before every upgrade of build tools",
        nearMatch: "drop",
      }).known,
    ).toBeUndefined();
    expect(count()).toBe(5);
  });

  it("exempts value-changing near-matched facts (numbers, dates, negation, proper nouns) from nearMatch drop and surfaces mayUpdate", () => {
    const { store, when } = fixture();
    const service = when(THURSDAY);
    const port8080 = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "The staging API server listens on port 8080 in development",
    });
    const port8443 = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "The staging API server listens on port 8443 in development",
      nearMatch: "drop",
    });
    expect(port8443.known).toBeUndefined();
    expect(service.related({ actor: alice, recordId: port8443.recordId })).toEqual({
      mayUpdate: {
        recordId: port8080.recordId,
        title: "The staging API server listens on port 8080 in development",
        currentRevisionId: port8080.currentRevisionId,
      },
    });

    // Proper-noun change at Jaccard >= 0.8 also survives nearMatch: "drop" (both lexical and hybrid).
    const lisbon = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Alice lives in Lisbon with her two cats and a dog",
    });
    const MODEL = "local/embed";
    store.asPort().repositories.memory.putVectors({
      vectors: [{ revisionId: lisbon.currentRevisionId!, modelKey: MODEL, vector: [1, 0, 0, 0] }],
      now: THURSDAY,
    });
    const porto = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Alice lives in Porto with her two cats and a dog",
      nearMatch: "drop",
      nearMatchVector: { modelKey: MODEL, vector: [0.98, 0.1, 0, 0] },
    });
    expect(porto.known).toBeUndefined();
    expect(service.related({ actor: alice, recordId: porto.recordId })).toEqual({
      mayUpdate: {
        recordId: lisbon.recordId,
        title: "Alice lives in Lisbon with her two cats and a dog",
        currentRevisionId: lisbon.currentRevisionId,
      },
    });

    // Date-word change, negation-polarity change, and Unicode proper-noun change also survive nearMatch: "drop".
    service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Weekly team sync meets every Monday morning for project planning",
    });
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "fact",
        body: "Weekly team sync meets every Friday morning for project planning",
        nearMatch: "drop",
      }).known,
    ).toBeUndefined();

    service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Alice drinks coffee every morning before starting daily engineering work",
    });
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "fact",
        body: "Alice never drinks coffee every morning before starting daily engineering work",
        nearMatch: "drop",
      }).known,
    ).toBeUndefined();

    service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Alice travels to Évora every summer for the regional music festival",
    });
    expect(
      service.propose({
        actor: model,
        scope: personal,
        kind: "fact",
        body: "Alice travels to Łódź every summer for the regional music festival",
        nearMatch: "drop",
      }).known,
    ).toBeUndefined();

    // Two facts with distinct explicit topicKeys are not paired as mayUpdate.
    const homeCity = service.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      topicKey: "me.home_city",
      body: "Lives in Zurich during the winter season",
    });
    const workCity = service.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      topicKey: "me.work_city",
      body: "Lives in Geneva during the winter season",
    });
    expect(service.related({ actor: alice, recordId: workCity.recordId })).toEqual({});

    // service.correct assigns a topicKey to an untagged fact once, and refuses empty or second assignments.
    expect(() => service.correct({ actor: alice, recordId: lisbon.recordId, topicKey: "" })).toThrow(/Topic key must not be empty/);
    const tagged = service.correct({ actor: alice, recordId: lisbon.recordId, topicKey: "auto.m_12345678", body: "Alice lives in Porto" });
    expect(tagged.topicKey).toBe("auto.m_12345678");
    expect(() => service.correct({ actor: alice, recordId: homeCity.recordId, topicKey: "auto.m_87654321" })).toThrow(
      /cannot be assigned a topic key/,
    );
  });
});
