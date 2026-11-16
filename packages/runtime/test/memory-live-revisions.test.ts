import { describe, expect, it } from "vitest";

import { MAX_LIVE_REVISION_IDS, type MemoryActor, type MemoryScope } from "@tavi/contracts";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * `liveRevisionIds`: which of the revision ids a chat's kept context blocks
 * showed are still in force, so a forgotten record's block is dropped
 * (MEMORY.md, A.3).
 */

const AT = "2026-10-12T08:00:00.000Z";
const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };

describe("the memory store's live revision ids", () => {
  it("answers only the revisions still in force: not a forgotten or revoked record's, but a superseded one kept", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      let counter = 0;
      const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
      const kept = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Owns a bicycle" });
      const forgotten = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Lives in Lisbon" });
      const revoked = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Plays the cello" });
      const corrected = service.remember({ actor: alice, scope: personal, kind: "fact", body: "Works at Initech" });
      const ids = [kept, forgotten, revoked, corrected].map((record) => record.currentRevisionId ?? "");
      const now = service.correct({ actor: alice, recordId: corrected.recordId, body: "Works at Globex" });
      service.forget({ actor: alice, recordId: forgotten.recordId, reason: "test" });
      service.revoke({ actor: alice, recordId: revoked.recordId, reason: "test" });
      const repository = store.asPort().repositories.memory;
      const live = repository.liveRevisionIds([...ids, now.currentRevisionId ?? "", "memrev-unknown", ids[0] ?? ""]);
      expect([...live].sort()).toEqual([ids[0], ids[3], now.currentRevisionId].sort());
      expect(repository.liveRevisionIds([])).toEqual([]);
      expect(() => repository.liveRevisionIds(Array.from({ length: MAX_LIVE_REVISION_IDS + 1 }, (_, index) => `r${index}`))).toThrow(
        /At most/,
      );
    } finally {
      store.close();
    }
  });
});
