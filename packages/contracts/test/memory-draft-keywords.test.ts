import { describe, expect, it } from "vitest";

import { MEMORY_PROVIDER_LIMITS, memoryDraftsFrom } from "../src/memory-provider.js";

describe("a provider draft's keywords", () => {
  const draft = { kind: "fact", body: "Lives in Porto.", scope: "everywhere" } as const;

  it("never drop the draft: too many are cut to the limit, a string is one, a bad list is none", () => {
    const many = Array.from({ length: MEMORY_PROVIDER_LIMITS.keywords + 1 }, (_, index) => `term${index}`);
    expect(memoryDraftsFrom({ proposals: [{ ...draft, keywords: many }] }, 5)).toEqual([
      { ...draft, keywords: many.slice(0, MEMORY_PROVIDER_LIMITS.keywords) },
    ]);
    expect(memoryDraftsFrom({ proposals: [{ ...draft, keywords: "porto" }] }, 5)).toEqual([{ ...draft, keywords: ["porto"] }]);
    expect(memoryDraftsFrom({ proposals: [{ ...draft, keywords: 7 }] }, 5)).toEqual([draft]);
    expect(memoryDraftsFrom({ proposals: [{ ...draft, keywords: [] }] }, 5)).toEqual([draft]);
  });

  it("leave out a non-string, empty, over-long or repeated entry", () => {
    const long = "x".repeat(MEMORY_PROVIDER_LIMITS.keywordChars + 1);
    expect(memoryDraftsFrom({ proposals: [{ ...draft, keywords: [" Porto ", 3, "", long, "porto", "city"] }] }, 5)).toEqual([
      { ...draft, keywords: ["Porto", "city"] },
    ]);
  });
});
