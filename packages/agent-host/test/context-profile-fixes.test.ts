import type { MemoryActor, MemorySearchHit, MemoryServicePort, ResolvedProfileEntry } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { assembleContext } from "@tavi/agent-host/context";

/**
 * The "About the person" profile beside retrieved evidence: a hit the
 * profile already renders takes no evidence slot and no budget, yet stays in
 * `evidence` so its turn use is recorded; the truncation line counts lessons
 * and `me.*` facts apart.
 */

const actor: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const at = "2026-01-01T00:00:00.000Z";

function profileEntry(recordId: string, kind: "lesson" | "fact"): ResolvedProfileEntry {
  return {
    recordId,
    revisionId: `${recordId}-rev`,
    kind,
    scope: { kind: "personal", principalId: "alice" },
    snippet: `Profile ${recordId}.`,
    recordedAt: at,
    usedChats: 0,
    conflict: false,
  };
}

function hit(recordId: string): MemorySearchHit {
  return {
    recordId,
    revisionId: `${recordId}-rev`,
    scope: { kind: "personal", principalId: "alice" },
    kind: "fact",
    snippet: `Evidence ${recordId} with enough words to cost tokens.`,
    recordedAt: at,
    superseded: false,
    conflict: false,
  };
}

/** A memory port answering only what context assembly reads. */
function memoryOf(
  profile: readonly ResolvedProfileEntry[],
  hits: readonly MemorySearchHit[],
  asked: { limit?: number | undefined } = {},
): MemoryServicePort {
  const answers: Partial<MemoryServicePort> = {
    resolvePreferences: async () => ({ preferences: [], truncated: false, profile: [...profile] }),
    search: async (input) => {
      asked.limit = input.limit;
      return { hits: hits.slice(0, input.limit ?? 10), coverage: "complete" };
    },
  };
  return new Proxy(answers, {
    get: (target, property) =>
      Reflect.get(target, property) ??
      (() => {
        throw new Error(`not implemented: ${String(property)}`);
      }),
  }) as MemoryServicePort;
}

describe("profile records in retrieved evidence", () => {
  it("asks for the profile's overlap on top of the limit, and charges no slot or budget for a profile hit", async () => {
    const profile = [profileEntry("les-1", "lesson"), profileEntry("fact-1", "fact")];
    const asked: { limit?: number | undefined } = {};
    const withOverlap = await assembleContext(
      { memory: memoryOf(profile, [hit("les-1"), hit("ev-1"), hit("ev-2"), hit("ev-3"), hit("ev-4")], asked) },
      { actor, instructions: "sys", query: "q", evidenceLimit: 3 },
    );
    expect(asked.limit).toBe(5);
    // The profile hit stays (its turn use is recorded) and three other hits still fit.
    expect(withOverlap.evidence.map((entry) => entry.recordId)).toEqual(["les-1", "ev-1", "ev-2", "ev-3"]);

    const withoutOverlap = await assembleContext(
      { memory: memoryOf(profile, [hit("ev-1"), hit("ev-2"), hit("ev-3")]) },
      { actor, instructions: "sys", query: "q", evidenceLimit: 3 },
    );
    expect(withOverlap.tokenEstimate).toBe(withoutOverlap.tokenEstimate);
  });

  it("leaves the caller's limit alone when no profile is shown", async () => {
    const asked: { limit?: number | undefined } = {};
    await assembleContext({ memory: memoryOf([], [hit("ev-1")], asked) }, { actor, instructions: "sys", query: "q", evidenceLimit: 3 });
    expect(asked.limit).toBe(3);
  });
});

describe("profile truncation line", () => {
  it("counts omitted lessons and facts apart", async () => {
    const lessons = Array.from({ length: 13 }, (_, index) => profileEntry(`les-${index}`, "lesson"));
    const facts = [profileEntry("fact-1", "fact"), profileEntry("fact-2", "fact")];
    const manifest = await assembleContext({ memory: memoryOf([...lessons, ...facts], []) }, { actor, instructions: "sys" });
    expect(manifest.profile).toHaveLength(12);
    expect(manifest.truncationNote).toBe("1 more lesson and 2 facts not shown; memory.search finds them.");

    const factsOnly = await assembleContext({ memory: memoryOf([...lessons.slice(0, 12), ...facts], []) }, { actor, instructions: "sys" });
    expect(factsOnly.truncationNote).toBe("2 more facts not shown; memory.search finds them.");
  });
});
