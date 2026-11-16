import { describe, expect, it } from "vitest";

import type { MemoryRecallRequest, MemorySnapshot } from "@tavi/contracts";

import {
  describeMemoryProviderConformance,
  memoryProviderConformanceCases,
  runMemoryProviderConformanceCase,
  type MemoryProviderUnderTest,
} from "../../src/memory/conformance.js";

/**
 * The provider suite against a fixture provider:
 * a keyword ranker over its own index, or over the host's candidates. The
 * built-in `tavi.memoryprovider` runs it in `@tavi/plugin-defaults/memory`. A broken
 * fixture shows the suite has teeth: each fault fails the case that names it.
 */

const SECRET = "sk-fixture-provider-key";

/** Ranks records by how many of the query's words their body holds; ties by id, so the order is fixed. */
function rank(records: Iterable<MemorySnapshot>, query: string, limit: number) {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 2);
  return [...records]
    .map((record) => ({
      recordId: record.recordId,
      revisionId: record.revisionId,
      score: terms.filter((term) => record.body.toLowerCase().includes(term)).length,
    }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
    .slice(0, limit);
}

interface FixtureFaults {
  /** Answers an id it was never given. */
  readonly invents?: true;
  /** Keeps a record it was told to remove. */
  readonly keepsRemoved?: true;
  /** Puts the body in each hit. */
  readonly leaksText?: true;
  /** Drafts a tidy-up of a record it was never given. */
  readonly inventsDraft?: true;
}

function keywordProvider(index: "own" | "host", faults: FixtureFaults = {}): MemoryProviderUnderTest {
  const own = new Map<string, MemorySnapshot>();
  return {
    async recall(request: MemoryRecallRequest) {
      if (request.signal.aborted) throw new Error("recall stopped");
      const pool = index === "host" ? (request.candidates ?? []) : own.values();
      const hits = rank(pool, request.query, request.limit).map((hit) =>
        faults.leaksText === true ? { ...hit, text: own.get(hit.recordId)?.body ?? "" } : hit,
      );
      return {
        hits: faults.invents === true ? [...hits, { recordId: "mem-invented", revisionId: "rev-invented", score: 0.5 }] : hits,
        coverage: "complete",
      };
    },
    async sync(batch) {
      if (batch.full === true) own.clear();
      for (const record of batch.upserts) own.set(record.recordId, record);
      if (faults.keepsRemoved !== true) for (const removal of batch.removals) own.delete(removal.recordId);
    },
    status: () => ({ ready: true, indexed: own.size }),
    async capture(request) {
      if (request.signal.aborted) throw new Error("capture stopped");
      return { proposals: [{ kind: "fact", title: "Moved to Porto", body: "Lives in Porto", scope: "everywhere", from: "person" }] };
    },
    async consolidate(request) {
      if (request.signal.aborted) throw new Error("consolidation stopped");
      // Merges the first two facts it was given.
      const facts = request.records
        .filter((record) => record.kind === "fact")
        .slice(0, 2)
        .map((record) => record.recordId);
      const recordIds = faults.inventsDraft === true ? [...facts.slice(0, 1), "mem-invented"] : facts;
      return {
        drafts:
          recordIds.length < 2
            ? []
            : [{ action: "merge", recordIds, replacement: { kind: "fact", body: "Merged", scope: "everywhere" }, reason: "same thing" }],
      };
    },
  };
}

describeMemoryProviderConformance("a keyword fixture keeping its own index", () => keywordProvider("own"), {
  index: "own",
  secrets: [SECRET],
});
describeMemoryProviderConformance("a keyword fixture ranking the host's candidates", () => keywordProvider("host"), {
  index: "host",
  secrets: [SECRET],
});

describe("the provider suite has teeth", () => {
  const titled = (start: string): string => {
    const title = memoryProviderConformanceCases().find((candidate) => candidate.startsWith(start));
    if (title === undefined) throw new Error(`no case starts ${start}`);
    return title;
  };
  const bounds = titled("answers ranked ids within the bounds");
  const removals = titled("honours a removal");

  it("fails a provider that answers an id it was never given", async () => {
    for (const index of ["own", "host"] as const) {
      await expect(runMemoryProviderConformanceCase(bounds, () => keywordProvider(index, { invents: true }), { index })).rejects.toThrow(
        /mem-invented is a record it was given/,
      );
    }
  });

  it("fails a provider that puts text in its hits", async () => {
    await expect(
      runMemoryProviderConformanceCase(bounds, () => keywordProvider("own", { leaksText: true }), { index: "own" }),
    ).rejects.toThrow(/"text":/);
  });

  it("fails a provider that keeps a removed record", async () => {
    await expect(
      runMemoryProviderConformanceCase(removals, () => keywordProvider("own", { keepsRemoved: true }), { index: "own" }),
    ).rejects.toThrow(/mem-1/);
  });

  it("fails a provider whose tidy-up names a record it was never given", async () => {
    await expect(
      runMemoryProviderConformanceCase(titled("drafts tidy-ups within the bounds"), () => keywordProvider("host", { inventsDraft: true }), {
        index: "host",
      }),
    ).rejects.toThrow(/mem-invented is a record it was given/);
  });

  it("fails a provider that leaks its secret into an error", async () => {
    const leaky: MemoryProviderUnderTest = {
      ...keywordProvider("host"),
      async recall(request) {
        await request.host.lexical(request.query, request.limit).catch((error: unknown) => {
          throw new Error(`lexical failed with key ${SECRET}: ${String(error)}`);
        });
        return { hits: [] };
      },
    };
    await expect(
      runMemoryProviderConformanceCase(titled("keeps its secrets"), () => leaky, { index: "host", secrets: [SECRET] }),
    ).rejects.toThrow(SECRET);
  });
});
