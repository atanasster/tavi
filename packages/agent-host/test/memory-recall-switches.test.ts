import type { InvocationContext, MemoryServicePort } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { buildSystemPromptText } from "../src/workflow/prompt.js";
import type { MemoryRecallSwitches } from "../src/workflow/options.js";
import type { TurnRetrievalQuery } from "../src/workflow/retrieval.js";

/**
 * `WorkflowOptions.memoryRecall`: each of turn recall's quality steps is on
 * unless switched off, so the memory eval can measure it both ways.
 */

const invocation: InvocationContext = { workspaceId: "ws-1", principalId: "operator", runId: "run-1", caller: "test" };

const query: TurnRetrievalQuery = {
  keywords: "lisbon flat",
  range: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z", pastOnly: true },
};

/** What the prompt builder asked memory for, from a port answering only those reads. */
async function askedWith(recall?: MemoryRecallSwitches): Promise<{
  readonly search: Parameters<MemoryServicePort["search"]>[0] | undefined;
  readonly profile: boolean | undefined;
}> {
  let search: Parameters<MemoryServicePort["search"]>[0] | undefined;
  let profile: boolean | undefined;
  const answers: Partial<MemoryServicePort> = {
    search: async (input) => {
      search = input;
      return { hits: [], coverage: "complete" };
    },
    resolvePreferences: async (input) => {
      profile = input.includeProfile;
      return { preferences: [], truncated: false };
    },
  };
  const memory = new Proxy(answers, {
    get: (target, property) => Reflect.get(target, property) ?? (async () => []),
  }) as MemoryServicePort;
  await buildSystemPromptText(
    memory,
    undefined,
    undefined,
    undefined,
    { maxTokens: 8_000, evidence: 10, ...(recall === undefined ? {} : { recall }) },
    "base",
    invocation,
    query,
  );
  return { search, profile };
}

describe("turn recall's quality switches", () => {
  it("turns every step on by default", async () => {
    const { search, profile } = await askedWith();
    expect(search?.applyFloor).toBe(true);
    expect(search?.rankingPriors).toBeUndefined();
    expect(search?.range).toEqual({ from: query.range?.from, to: query.range?.to });
    expect(search?.includePast).toBe(true);
    expect(profile).toBe(true);
  });

  it("turns each step off on its own", async () => {
    expect((await askedWith({ relevanceFloor: false })).search?.applyFloor).toBe(false);
    expect((await askedWith({ rankingPriors: false })).search?.rankingPriors).toBe(false);
    const dates = (await askedWith({ temporalRanking: false })).search;
    expect(dates?.range).toBeUndefined();
    expect(dates?.includePast).toBeUndefined();
    expect((await askedWith({ profile: false })).profile).not.toBe(true);
  });
});
