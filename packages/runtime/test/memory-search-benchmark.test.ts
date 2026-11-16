import { describe, expect, it } from "vitest";

import { memoryScopeKey, type MemoryActor, type MemoryScope } from "@tavi/contracts";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * What the stemmed companion index costs a search: on one 5,000-record store, the
 * dual search (`tavi_memory_fts` + `tavi_memory_fts_stem`, RRF-fused) against the
 * same search once the stemmed index is emptied, which leaves the exact index alone.
 * The plan's bound is p95 within +2 ms of a single-index search; the assertion keeps
 * headroom for a loaded CI machine (median delta under 2 ms, p95 delta under 5 ms).
 */

const AT = "2026-01-01T00:00:00.000Z";
const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };
const RUNS = 100;

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

describe("memory search over 5,000 records", () => {
  it("the stemmed index adds under 2 ms to the median search and under 5 ms to its p95", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const persistence = store.asPort();
      const memory = persistence.repositories.memory;
      const service = new MemoryService(persistence, { now: () => AT, quotas: { maxRecords: 6_000, maxBytes: 1_000_000 } });
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

      const measure = (): number[] => {
        for (let warm = 0; warm < 5; warm += 1) service.search({ actor: alice, query: "meetings deployments", match: "any", limit: 10 });
        const durations: number[] = [];
        for (let run = 0; run < RUNS; run += 1) {
          const started = performance.now();
          const result = service.search({ actor: alice, query: "meetings deployments", match: "any", limit: 10 });
          durations.push(performance.now() - started);
          expect(result.hits).toHaveLength(10);
        }
        return durations;
      };

      const dual = measure();
      store.handle.exec("DELETE FROM tavi_memory_fts_stem");
      const single = measure();

      const medianDelta = percentile(dual, 0.5) - percentile(single, 0.5);
      const p95Delta = percentile(dual, 0.95) - percentile(single, 0.95);
      console.info(
        `memory search, 5,000 records: dual median ${percentile(dual, 0.5).toFixed(2)} ms, p95 ${percentile(dual, 0.95).toFixed(2)} ms; ` +
          `exact-only median ${percentile(single, 0.5).toFixed(2)} ms, p95 ${percentile(single, 0.95).toFixed(2)} ms`,
      );
      expect(medianDelta).toBeLessThan(2);
      expect(p95Delta).toBeLessThan(5);
    } finally {
      store.close();
    }
  }, 60_000);
});
