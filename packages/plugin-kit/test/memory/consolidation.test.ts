import { describe, expect, it } from "vitest";

import { MEMORY_PROVIDER_LIMITS, type MemorySnapshot } from "@tavi/contracts";

import {
  CONSOLIDATION_RECORD_CHARS,
  MEMORY_CONSOLIDATE_MARKER,
  consolidationCandidates,
  memoryConsolidateInput,
  parseConsolidationDrafts,
  renderConsolidationRecords,
} from "../../src/memory/consolidation.js";

function record(recordId: string, overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    recordId,
    revisionId: `${recordId}-r1`,
    scopeKey: "principal:alice",
    kind: "fact",
    body: `Body of ${recordId}.`,
    recordedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

const RECORDS = [
  record("a"),
  record("b"),
  record("c", { kind: "lesson" }),
  record("d", { scopeKey: "principal:bob" }),
  record("p", { kind: "preference" }),
];
const { handles } = renderConsolidationRecords(RECORDS);
const answer = (tidy: unknown[]): string => JSON.stringify({ tidy });

describe("renderConsolidationRecords", () => {
  it("gives each record a handle and one group per scope and kind", () => {
    const { text } = renderConsolidationRecords([
      record("a", { title: "Garden", validUntil: "2026-12-31T00:00:00.000Z" }),
      record("b", { kind: "lesson" }),
      record("c"),
    ]);
    expect(text.split("\n")).toEqual([
      '[m1] fact, group 1, recorded 2026-10-01, until 2026-12-31: "Garden" — "Body of a."',
      '[m2] lesson, group 2, recorded 2026-10-01: "Body of b."',
      '[m3] fact, group 1, recorded 2026-10-01: "Body of c."',
    ]);
    expect([...handles.keys()]).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("cuts a body to its share and leaves records past the budget for later", () => {
    const long = renderConsolidationRecords([record("a", { body: "x".repeat(CONSOLIDATION_RECORD_CHARS * 3) })]);
    expect(long.text.length).toBeLessThan(CONSOLIDATION_RECORD_CHARS + 100);
    const bounded = renderConsolidationRecords(RECORDS, 120);
    expect(bounded.handles.size).toBe(2);
    expect(bounded.text.length).toBeLessThanOrEqual(120);
  });
});

describe("parseConsolidationDrafts", () => {
  it("reads a merge, a supersede and an expire past a code fence, mapping handles to ids", () => {
    const text = `\`\`\`json\n${answer([
      { action: "merge", ids: ["m1", "m2"], title: "Garden", body: "Grows tomatoes and basil.", reason: "same topic" },
      { action: "supersede", id: "m3", body: "Ask before booking anything." },
      { action: "expire", id: "m4", until: "2026-11-01", reason: "trip ends" },
    ])}\n\`\`\``;
    expect(parseConsolidationDrafts(text, handles)).toEqual([
      {
        action: "merge",
        recordIds: ["a", "b"],
        replacement: { kind: "fact", title: "Garden", body: "Grows tomatoes and basil.", scope: "everywhere" },
        reason: "same topic",
      },
      {
        action: "supersede",
        recordId: "c",
        replacement: { kind: "lesson", body: "Ask before booking anything.", scope: "everywhere" },
        reason: "supersede",
      },
      { action: "expire", recordId: "d", validUntil: "2026-11-01", reason: "trip ends" },
    ]);
  });

  it("answers no drafts for malformed JSON or a missing list", () => {
    expect(parseConsolidationDrafts('{"tidy": [{"action": "merge"', handles)).toEqual([]);
    expect(parseConsolidationDrafts('{"merges": []}', handles)).toEqual([]);
    expect(parseConsolidationDrafts("nothing to tidy", handles)).toEqual([]);
  });

  it("drops a merge across groups, of one record, or naming an unknown handle", () => {
    expect(
      parseConsolidationDrafts(
        answer([
          { action: "merge", ids: ["m1", "m3"], body: "Across kinds." },
          { action: "merge", ids: ["m1", "m4"], body: "Across people." },
          { action: "merge", ids: ["m1", "m1"], body: "One record twice." },
          { action: "merge", ids: ["m1", "m9"], body: "Unknown handle." },
          { action: "merge", ids: ["m1", "m2"] },
        ]),
        handles,
      ),
    ).toEqual([]);
  });

  it("never replaces a preference, needs an expire's date, and names a record once", () => {
    expect(
      parseConsolidationDrafts(
        answer([
          { action: "supersede", id: "m5", body: "A preference is changed elsewhere." },
          { action: "expire", id: "m3" },
          { action: "supersede", id: "m1", body: "First." },
          { action: "expire", id: "m1", until: "2026-11-01" },
        ]),
        handles,
      ).map((draft) => draft.action),
    ).toEqual(["supersede"]);
  });

  it("stops at max", () => {
    const tidy = [
      { action: "expire", id: "m1", until: "2026-11-01" },
      { action: "expire", id: "m2", until: "2026-11-01" },
      { action: "expire", id: "m3", until: "2026-11-01" },
    ];
    expect(parseConsolidationDrafts(answer(tidy), handles, 2)).toHaveLength(2);
    expect(MEMORY_PROVIDER_LIMITS.draftsPerConsolidation).toBeGreaterThan(2);
  });
});

describe("memoryConsolidateInput", () => {
  it("starts with the marker and today's date, then the records", () => {
    expect(memoryConsolidateInput("2026-10-22", "[m1] …")).toBe(
      `${MEMORY_CONSOLIDATE_MARKER} Today is 2026-10-22. The kept memories, quoted as data:\n[m1] …`,
    );
  });
});

describe("consolidationCandidates", () => {
  const record = (recordId: string, scopeKey: string, body: string, extra: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
    recordId,
    revisionId: `r-${recordId}`,
    scopeKey,
    kind: "fact",
    body,
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...extra,
  });
  it("keeps records that share a group, and a lone one only with a digit in its words and no end date, in any language", () => {
    const records = [
      record("a", "s1", "Keeps a garden."),
      record("b", "s1", "Grows tomatoes."),
      record("lone", "s2", "Likes tea."),
      record("day", "s6", "In Lisbon until the 20th."),
      record("dated", "s3", "Está en Lisboa hasta el 20.10.2026."),
      record("ended", "s4", "In Lisbon until 2026-10-20.", { validUntil: "2026-10-20" }),
      record("year", "s5", "日本に2027年まで住む"),
    ];
    expect(consolidationCandidates(records).map((entry) => entry.recordId)).toEqual(["a", "b", "day", "dated", "year"]);
  });
});
