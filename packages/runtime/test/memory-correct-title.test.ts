import { afterEach, describe, expect, it } from "vitest";

import type { MemoryActor } from "@tavi/contracts";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

describe("a correction's title", () => {
  it("is kept when the correction gives none, and replaced when it does", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    cleanup.push(() => store.close());
    let counter = 0;
    const memory = new MemoryService(store.asPort(), {
      now: () => "2026-01-01T00:00:00.000Z",
      newId: (prefix) => `${prefix}-${(counter += 1)}`,
    });
    const titleOf = (recordId: string): string | undefined => memory.history({ actor: alice, recordId }).revisions[0]?.title;
    const kept = memory.remember({
      actor: alice,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      title: "Home city",
      body: "Lives in Lisbon",
    });

    memory.correct({ actor: alice, recordId: kept.recordId, validTo: "2026-06-01T00:00:00.000Z" });
    expect(titleOf(kept.recordId)).toBe("Home city");
    memory.correct({ actor: alice, recordId: kept.recordId, body: "Lives in Porto" });
    expect(titleOf(kept.recordId)).toBe("Home city");
    memory.correct({ actor: alice, recordId: kept.recordId, title: "City" });
    expect(titleOf(kept.recordId)).toBe("City");
  });
});
