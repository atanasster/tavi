import { describe, expect, it } from "vitest";

import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_ABI,
  MEMORY_PROVIDER_LIMITS,
  MemoryDraftSchema,
  MemoryProviderError,
  MemoryRecallResultSchema,
  PluginMemoryDeclarationSchema,
  describeMemoryDeclaration,
  memoryDraftsFrom,
  consolidationDraftsFrom,
  memoryProviderFailure,
} from "../src/memory-provider.js";
import * as sdk from "../src/plugin-sdk.js";
import { PluginManifestSchema } from "../src/plugin-registry.js";

/** The memory provider contract. */
const base = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.memory",
  version: "1.0.0",
  name: "ACME memory",
  entry: "index.mjs",
};
const memory = { abi: MEMORY_PROVIDER_ABI, capabilities: ["recall", "capture"], index: "own", receives: ["records", "conversation"] };

describe("the memory provider contract", () => {
  it("is tavi.memory/1, exported from the plugin SDK with its bounds", () => {
    expect(MEMORY_PROVIDER_ABI).toBe("tavi.memory/1");
    expect(BUILTIN_MEMORY_PROVIDER_ID).toBe("tavi.memoryprovider");
    expect(sdk.MEMORY_PROVIDER_ABI).toBe(MEMORY_PROVIDER_ABI);
    expect(sdk.MEMORY_PROVIDER_LIMITS).toBe(MEMORY_PROVIDER_LIMITS);
    expect(MEMORY_PROVIDER_LIMITS).toMatchObject({
      hits: 50,
      candidates: 500,
      draftsPerCapture: 5,
      draftsPerConsolidation: 20,
      title: 120,
      body: 1_000,
      spanChars: 24_000,
      recallTurnMs: 1_500,
    });
    expect(new sdk.MemoryProviderError("budget")).toBeInstanceOf(MemoryProviderError);
  });

  it("reads a recall answer as ids and a finite score only, at most 50", () => {
    expect(
      MemoryRecallResultSchema.safeParse({ hits: [{ recordId: "mem-1", revisionId: "rev-1", score: 0.5 }], coverage: "partial" }).success,
    ).toBe(true);
    // Text in a hit is out of contract: the host renders from its own rows.
    expect(
      MemoryRecallResultSchema.safeParse({ hits: [{ recordId: "mem-1", revisionId: "rev-1", score: 1, text: "Alice keeps a garden" }] })
        .success,
    ).toBe(false);
    expect(MemoryRecallResultSchema.safeParse({ hits: [{ recordId: "mem-1", revisionId: "rev-1", score: Number.NaN }] }).success).toBe(
      false,
    );
    expect(
      MemoryRecallResultSchema.safeParse({
        hits: Array.from({ length: 51 }, (_, index) => ({ recordId: `mem-${index}`, revisionId: `rev-${index}`, score: 1 })),
      }).success,
    ).toBe(false);
    expect(MemoryRecallResultSchema.safeParse({ hits: [], coverage: "unavailable" }).success).toBe(false);
  });

  it("holds each draft to its bounds and kinds, dropping only the ones that fail", () => {
    expect(MemoryDraftSchema.safeParse({ kind: "fact", body: "Lives in Porto.", scope: "everywhere" }).success).toBe(true);
    expect(
      MemoryDraftSchema.safeParse({
        kind: "preference",
        body: "Replies in Portuguese.",
        scope: "everywhere",
        preferenceKey: "reply.language",
        preferenceValue: "pt",
      }).success,
    ).toBe(true);
    expect(MemoryDraftSchema.safeParse({ kind: "preference", body: "No key.", scope: "everywhere" }).success).toBe(false);
    expect(MemoryDraftSchema.safeParse({ kind: "summary", body: "Not a draft kind.", scope: "everywhere" }).success).toBe(false);
    expect(MemoryDraftSchema.safeParse({ kind: "fact", body: "x".repeat(1_001), scope: "everywhere" }).success).toBe(false);
    expect(MemoryDraftSchema.safeParse({ kind: "fact", title: "t".repeat(121), body: "x", scope: "everywhere" }).success).toBe(false);
    // A provider chooses no scope beyond everywhere or this chat.
    expect(MemoryDraftSchema.safeParse({ kind: "fact", body: "x", scope: "workspace" }).success).toBe(false);
    expect(MemoryDraftSchema.safeParse({ kind: "fact", body: "x", scope: "everywhere", status: "approved" }).success).toBe(false);
    const drafts = memoryDraftsFrom(
      {
        proposals: [
          { kind: "fact", body: "Lives in Porto.", scope: "everywhere" },
          { kind: "fact", body: "Approves itself.", scope: "everywhere", status: "approved" },
          { kind: "lesson", body: "Lead with the answer.", scope: "chat" },
          { kind: "fact", body: "One past the limit.", scope: "everywhere" },
        ],
      },
      2,
    );
    expect(drafts).toEqual([
      { kind: "fact", body: "Lives in Porto.", scope: "everywhere" },
      { kind: "lesson", body: "Lead with the answer.", scope: "chat" },
    ]);
    expect(memoryDraftsFrom(undefined, 5)).toEqual([]);
    expect(memoryDraftsFrom({ proposals: "none" }, 5)).toEqual([]);
    expect(
      memoryDraftsFrom(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("hostile getter");
            },
          },
        ),
        5,
      ),
    ).toEqual([]);
  });

  it("reads a failure's reason whatever was thrown", () => {
    expect(memoryProviderFailure(new MemoryProviderError("invalid"))).toBe("invalid");
    expect(memoryProviderFailure(new Error("boom"))).toBe("transport");
    expect(memoryProviderFailure({ reason: "other" })).toBe("transport");
    expect(
      memoryProviderFailure(
        new Proxy(
          {},
          {
            has: () => {
              throw new Error("hostile");
            },
          },
        ),
      ),
    ).toBe("transport");
    expect(new MemoryProviderError("transport").message).toBe("transport");
  });
});

describe("a plugin's memory declaration", () => {
  it("is refused without its block, with a block and no provides, with a wrong abi, or without recall", () => {
    const parsed = PluginManifestSchema.parse({ ...base, provides: ["memory"], memory });
    expect(parsed.memory).toEqual(memory);
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["memory"] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, memory }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["memory"], memory: { ...memory, abi: "tavi.memory/2" } }).success).toBe(
      false,
    );
    expect(
      PluginManifestSchema.safeParse({ ...base, provides: ["memory"], memory: { ...memory, capabilities: ["capture"] } }).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, provides: ["memory"], memory: { ...memory, capabilities: ["recall", "recall"] } }).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, provides: ["memory"], memory: { ...memory, receives: ["records", "secrets"] } }).success,
    ).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["memory"], memory: { ...memory, index: "remote" } }).success).toBe(false);
    // Five services now fit, each once.
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["memory", "memory"], memory }).success).toBe(false);
    expect(PluginMemoryDeclarationSchema.parse({ abi: MEMORY_PROVIDER_ABI, capabilities: ["recall"], index: "host" }).receives).toEqual([]);
  });

  it("derives its disclosure from what it does and asks to receive", () => {
    const full = describeMemoryDeclaration(
      PluginMemoryDeclarationSchema.parse({ ...memory, capabilities: ["recall", "capture", "consolidate"] }),
    );
    expect(full).toContain("ranks what memory recalls, drafts proposals from your chats, drafts tidy-ups of what is kept");
    expect(full).toContain("your approved memories");
    expect(full).toContain("each recall's query");
    expect(full).toContain("index of its own");
    expect(full).toContain("only when you switch it on");
    const quiet = describeMemoryDeclaration(
      PluginMemoryDeclarationSchema.parse({ abi: MEMORY_PROVIDER_ABI, capabilities: ["recall"], index: "host" }),
    );
    expect(quiet).toContain("nothing of yours");
    expect(quiet).not.toContain("index of its own");
  });

  it("reads a consolidation answer's drafts as data, dropping each that is out of shape", () => {
    const replacement = { kind: "fact", body: "Keeps a garden and grows tomatoes", scope: "everywhere" };
    const drafts = consolidationDraftsFrom(
      {
        drafts: [
          { action: "merge", recordIds: ["mem-1", "mem-2"], replacement, reason: "same garden" },
          { action: "merge", recordIds: ["mem-1"], replacement, reason: "one record is no merge" },
          { action: "merge", recordIds: ["mem-1", "mem-1"], replacement, reason: "named twice" },
          {
            action: "supersede",
            recordId: "mem-3",
            replacement: { ...replacement, kind: "preference" },
            reason: "a preference without its key",
          },
          { action: "expire", recordId: "mem-4", validUntil: "2026-10-20", reason: "time-bound" },
          { action: "retopic", recordId: "mem-5", reason: "no such action" },
          { action: "expire", recordId: "mem-6", validUntil: "2026-10-20", reason: "", extra: true },
        ],
      },
      20,
    );
    expect(drafts.map((draft) => draft.action)).toEqual(["merge", "expire"]);
    expect(
      consolidationDraftsFrom(
        { drafts: Array.from({ length: 30 }, () => ({ action: "expire", recordId: "mem-1", validUntil: "2026-10-20", reason: "x" })) },
        20,
      ),
    ).toHaveLength(20);
    expect(consolidationDraftsFrom(undefined, 20)).toEqual([]);
    expect(
      consolidationDraftsFrom(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("hostile getter");
            },
          },
        ),
        20,
      ),
    ).toEqual([]);
  });
});
