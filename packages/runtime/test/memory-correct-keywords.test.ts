import { afterEach, describe, expect, it } from "vitest";

import type { MemoryActor, MemoryScope } from "@tavi/contracts";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/** Corrections and keywords, exact dedup beside an automatic topic key, and what an update may name. */

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-06-01T00:00:00.000Z";
const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const model: MemoryActor = { ...alice, caller: "agent", authority: "model" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function service(): MemoryService {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  let counter = 0;
  return new MemoryService(store.asPort(), { now: () => NOW, newId: (prefix) => `${prefix}-${(counter += 1)}` });
}

const keywordsOf = (memory: MemoryService, recordId: string): readonly string[] | undefined =>
  memory.history({ actor: alice, recordId }).revisions[0]?.keywords;

describe("a correction's keywords", () => {
  it("are kept while the words are, dropped with the words they described, and replaced when given", () => {
    const memory = service();
    const kept = memory.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Has a standing dentist appointment",
      keywords: ["dentist", "teeth"],
    });
    memory.correct({ actor: alice, recordId: kept.recordId, validTo: LATER });
    expect(keywordsOf(memory, kept.recordId)).toEqual(["dentist", "teeth"]);
    memory.correct({ actor: alice, recordId: kept.recordId, body: "Has a standing dentist appointment" });
    expect(keywordsOf(memory, kept.recordId)).toEqual(["dentist", "teeth"]);

    memory.correct({ actor: alice, recordId: kept.recordId, body: "Has a standing physio appointment" });
    expect(keywordsOf(memory, kept.recordId)).toBeUndefined();

    memory.correct({ actor: alice, recordId: kept.recordId, keywords: ["physio"] });
    expect(keywordsOf(memory, kept.recordId)).toEqual(["physio"]);
    memory.correct({ actor: alice, recordId: kept.recordId, keywords: [] });
    expect(keywordsOf(memory, kept.recordId)).toBeUndefined();
  });
});

describe("exact dedup beside an automatic topic key", () => {
  it("finds a fact Replace gave an auto. key when the same words come again without one", () => {
    const memory = service();
    const kept = memory.remember({ actor: alice, scope: personal, kind: "fact", body: "Lives in Lisbon" });
    memory.correct({ actor: alice, recordId: kept.recordId, body: "Lives in Porto", topicKey: "auto.m_12345678" });
    const again = memory.propose({ actor: model, scope: personal, kind: "fact", body: "lives in  porto" });
    expect(again.known).toBe("exact");
    expect(again.recordId).toBe(kept.recordId);
    // An explicit topic key is still part of the content.
    expect(
      memory.propose({ actor: model, scope: personal, kind: "fact", body: "Lives in Porto", topicKey: "me.city" }).known,
    ).toBeUndefined();
  });
});

describe("a proposal naming the fact it updates", () => {
  it("is refused for a sensitive fact", () => {
    const memory = service();
    const kept = memory.remember({
      actor: alice,
      scope: personal,
      kind: "fact",
      body: "Takes a daily medication",
      sensitivity: "sensitive",
    });
    expect(() =>
      memory.propose({ actor: model, scope: personal, kind: "fact", body: "Takes a weekly medication", supersedesRecordId: kept.recordId }),
    ).toThrow(/sensitive/);
  });
});
