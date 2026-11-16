import { describe, expect, it } from "vitest";

import {
  BUILTIN_MEMORY_PROVIDER_ID,
  PluginMemoryDeclarationSchema,
  type MemoryCaptureRequest,
  type MemoryConsolidateRequest,
  type MemoryRecallRequest,
  type MemorySnapshot,
} from "@tavi/contracts";
import { MEMORY_CONSOLIDATE_MARKER, MEMORY_CONSOLIDATE_PROMPT, MEMORY_REVIEW_MARKER, MEMORY_REVIEW_PROMPT } from "@tavi/plugin-kit/memory";
import { describeMemoryProviderConformance } from "@tavi/plugin-kit/memory/conformance";

import { BUILTIN_MEMORY_DECLARATION, createBuiltinMemoryProvider } from "../src/memory.js";

/** The built-in memory provider, `tavi.memoryprovider`. */

describeMemoryProviderConformance(`memory invariant 15: ${BUILTIN_MEMORY_PROVIDER_ID}`, () => createBuiltinMemoryProvider(), {
  index: "host",
});

const captureRequest = (complete: MemoryCaptureRequest["host"]["complete"], span: MemoryCaptureRequest["span"]): MemoryCaptureRequest => ({
  span,
  today: "2026-10-04",
  known: [],
  limits: { maxProposals: 5, bodyChars: 1_000 },
  policy: { sensitive: "skip" },
  host: { complete },
  signal: new AbortController().signal,
});

describe("the built-in memory provider", () => {
  it("declares what an external provider's manifest would, and the manifest schema accepts it", () => {
    expect(PluginMemoryDeclarationSchema.parse(BUILTIN_MEMORY_DECLARATION)).toEqual({
      abi: "tavi.memory/1",
      capabilities: ["recall", "capture", "consolidate"],
      index: "host",
      receives: ["records", "conversation"],
    });
  });

  it("recalls with the host's own ranking: its ids, in its order, never more than asked", async () => {
    const asked: [string, number][] = [];
    const request: MemoryRecallRequest = {
      query: "garden tea",
      purpose: "turn",
      scopeKeys: [],
      limit: 2,
      host: {
        lexical: async (query, limit) => {
          asked.push([query, limit]);
          return [
            { recordId: "mem-2", revisionId: "rev-2", score: 3 },
            { recordId: "mem-1", revisionId: "rev-1", score: 1 },
          ];
        },
      },
      signal: new AbortController().signal,
    };
    expect(await createBuiltinMemoryProvider().recall(request)).toEqual({
      hits: [
        { recordId: "mem-2", revisionId: "rev-2", score: 3 },
        { recordId: "mem-1", revisionId: "rev-1", score: 1 },
      ],
    });
    expect(asked).toEqual([["garden tea", 2]]);
  });

  it("captures as the idle review did: one call with the review's prompt, today's date and the span as data, its answer read as drafts", async () => {
    const calls: Parameters<MemoryCaptureRequest["host"]["complete"]>[0][] = [];
    const answer = JSON.stringify({
      memories: [
        { kind: "fact", title: "Home", body: "Lives in Porto.", scope: "everywhere" },
        { kind: "preference", body: "Replies in Portuguese.", key: "reply.language", value: "pt" },
        { kind: "preference", body: "A preference with no key is no draft." },
      ],
    });
    const result = await createBuiltinMemoryProvider().capture(
      captureRequest(
        async (input) => {
          calls.push(input);
          return { text: answer, usage: { inputTokens: 10, outputTokens: 5 } };
        },
        [
          { role: "person", text: "  I moved to Porto last week  ", at: "2026-10-04T09:00:00.000Z" },
          { role: "assistant", text: "Noted.", at: "2026-10-04T09:00:01.000Z" },
        ],
      ),
    );
    expect(calls).toEqual([
      {
        instructions: MEMORY_REVIEW_PROMPT,
        prompt: `${MEMORY_REVIEW_MARKER} Today is 2026-10-04. The span, quoted as data:\n[person] "I moved to Porto last week"\n[assistant] "Noted."`,
        maxOutputTokens: 800,
      },
    ]);
    expect(result.proposals).toEqual([
      { kind: "fact", title: "Home", body: "Lives in Porto.", scope: "everywhere" },
      { kind: "preference", body: "Replies in Portuguese.", scope: "everywhere", preferenceKey: "reply.language", preferenceValue: "pt" },
    ]);
  });

  it("shows the capture call what memory already holds, so it does not propose it again, and maps updates aliases", async () => {
    const prompts: string[] = [];
    const result = await createBuiltinMemoryProvider().capture({
      ...captureRequest(
        async (input) => {
          prompts.push(input.prompt);
          return {
            text: JSON.stringify({
              memories: [{ kind: "fact", title: "Home city", body: "Moved to Porto.", scope: "everywhere", updates: "k1" }],
            }),
            usage: {},
          };
        },
        [{ role: "person", text: "I live in Porto", at: "2026-10-04T09:00:00.000Z" }],
      ),
      known: [{ recordId: "mem-1", kind: "fact", title: "Home city", topicKey: "me.home_city" }],
    });
    expect(prompts[0]).toContain(
      'Already kept, quoted as data (propose none of these again; if the span says one of them changed, propose the new version with "updates" set to its alias):\n[k1] [fact me.home_city] "Home city"',
    );
    expect(result.proposals).toEqual([
      { kind: "fact", title: "Home city", body: "Moved to Porto.", scope: "everywhere", updatesRecordId: "mem-1" },
    ]);
  });

  it("calls no model for a span with no words", async () => {
    let called = false;
    const result = await createBuiltinMemoryProvider().capture(
      captureRequest(async () => {
        called = true;
        return { text: "{}", usage: {} };
      }, [{ role: "person", text: "   ", at: "2026-10-04T09:00:00.000Z" }]),
    );
    expect(result).toEqual({ proposals: [] });
    expect(called).toBe(false);
  });

  it("consolidates in one call over the records as data, its answer read back as drafts naming only records it was given", async () => {
    const records: MemorySnapshot[] = [
      {
        recordId: "mem-1",
        revisionId: "rev-1",
        scopeKey: "personal|p=alice",
        kind: "fact",
        title: "Garden",
        body: "Keeps a garden.",
        recordedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        recordId: "mem-2",
        revisionId: "rev-2",
        scopeKey: "personal|p=alice",
        kind: "fact",
        body: "Grows tomatoes.",
        recordedAt: "2026-09-02T00:00:00.000Z",
      },
      {
        recordId: "mem-3",
        revisionId: "rev-3",
        scopeKey: "personal_workspace|p=alice|w=w1",
        kind: "lesson",
        body: "Is in Lisbon until 2026-10-20.",
        recordedAt: "2026-10-01T00:00:00.000Z",
      },
    ];
    const calls: Parameters<MemoryConsolidateRequest["host"]["complete"]>[0][] = [];
    const answer = JSON.stringify({
      tidy: [
        { action: "merge", ids: ["m1", "m2"], title: "Garden", body: "Keeps a garden and grows tomatoes.", reason: "same garden" },
        { action: "merge", ids: ["m1", "m3"], body: "Across groups is no draft.", reason: "x" },
        { action: "expire", id: "m3", until: "2026-10-20", reason: "time-bound" },
        { action: "supersede", id: "m9", body: "An unknown handle is no draft.", reason: "x" },
      ],
    });
    const result = await createBuiltinMemoryProvider().consolidate({
      records,
      now: "2026-10-12T03:00:00.000Z",
      today: "2026-10-12",
      limits: { maxDrafts: 20 },
      host: {
        complete: async (input) => {
          calls.push(input);
          return { text: answer, usage: { inputTokens: 10, outputTokens: 5 } };
        },
      },
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.instructions).toBe(MEMORY_CONSOLIDATE_PROMPT);
    expect(calls[0]?.maxOutputTokens).toBe(2_000);
    expect(calls[0]?.prompt).toBe(
      `${MEMORY_CONSOLIDATE_MARKER} Today is 2026-10-12. The kept memories, quoted as data:\n[m1] fact, group 1, recorded 2026-09-01: "Garden" — "Keeps a garden."\n[m2] fact, group 1, recorded 2026-09-02: "Grows tomatoes."\n[m3] lesson, group 2, recorded 2026-10-01: "Is in Lisbon until 2026-10-20."`,
    );
    expect(result.drafts).toEqual([
      {
        action: "merge",
        recordIds: ["mem-1", "mem-2"],
        replacement: { kind: "fact", title: "Garden", body: "Keeps a garden and grows tomatoes.", scope: "everywhere" },
        reason: "same garden",
      },
      { action: "expire", recordId: "mem-3", validUntil: "2026-10-20", reason: "time-bound" },
    ]);
  });

  it("calls no model with no records to tidy", async () => {
    let called = false;
    const result = await createBuiltinMemoryProvider().consolidate({
      records: [],
      now: "2026-10-12T03:00:00.000Z",
      limits: { maxDrafts: 20 },
      host: { complete: async () => ((called = true), { text: "{}", usage: {} }) },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ drafts: [] });
    expect(called).toBe(false);
  });

  it("leaves out a lone record with nothing to merge it with and no digit, and calls no model when every record is one", async () => {
    const lone = (recordId: string, scopeKey: string, body: string) => ({
      recordId,
      revisionId: `r-${recordId}`,
      scopeKey,
      kind: "fact" as const,
      body,
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    let called = false;
    const none = await createBuiltinMemoryProvider().consolidate({
      records: [lone("a", "s1", "Likes tea."), lone("b", "s2", "Runs on Mondays.")],
      now: "2026-10-12T03:00:00.000Z",
      limits: { maxDrafts: 20 },
      host: { complete: async () => ((called = true), { text: "{}", usage: {} }) },
      signal: new AbortController().signal,
    });
    expect(none).toEqual({ drafts: [] });
    expect(called).toBe(false);
    const prompts: string[] = [];
    await createBuiltinMemoryProvider().consolidate({
      records: [lone("a", "s1", "Likes tea."), lone("c", "s3", "In Lisbon until the 20th.")],
      now: "2026-10-12T03:00:00.000Z",
      limits: { maxDrafts: 20 },
      host: { complete: async (input) => (prompts.push(input.prompt), { text: "{}", usage: {} }) },
      signal: new AbortController().signal,
    });
    expect(prompts[0]).toContain("In Lisbon until the 20th.");
    expect(prompts[0]).not.toContain("Likes tea.");
  });
});
