import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_RETENTION_DAYS,
  IPC_COMMANDS,
  MAX_MEMORY_BODY_BYTES,
  MEMORY_IPC_LIST_MAX,
  MEMORY_PROPOSAL_TTL_DAYS,
  MemoryGetAnswerSchema,
  MemoryItemSchema,
  MemoryListAnswerSchema,
  MemoryUsageAnswerSchema,
  UI_BRIDGE_COMMANDS,
  decodeMemoryListCursor,
  encodeMemoryListCursor,
  memoryProposalExpiresAt,
  memoryScopeForTarget,
  memoryScopeTarget,
  operatorSeesChatNote,
  operatorSeesMemory,
  parseCommandPayload,
  type MemoryScope,
} from "../src/index.js";

/** The `memory` owner command. */

const operator = { principalId: "operator", workspaceId: "default" };

describe("the memory command", () => {
  it("is declared and forwarded by the bridge", () => {
    expect(IPC_COMMANDS).toContain("memory");
    expect(UI_BRIDGE_COMMANDS).toContain("memory");
  });

  it("accepts each action within its bounds", () => {
    for (const payload of [
      { action: "list" },
      {
        action: "list",
        workspaceId: "default",
        kinds: ["fact"],
        statuses: ["proposed"],
        scopes: ["personal", "agent:chief"],
        limit: MEMORY_IPC_LIST_MAX,
      },
      { action: "list", query: "garden", scopes: ["shared", "workspace"] },
      { action: "list", cursor: encodeMemoryListCursor(50) },
      { action: "get", recordId: "mem-1", reveal: true },
      { action: "remember", kind: "fact", scope: "personal", body: "keeps a garden" },
      {
        action: "remember",
        kind: "preference",
        scope: "agent:chief",
        body: "tea",
        preferenceKey: "drink",
        preferenceValue: "tea",
        sensitivity: "sensitive",
      },
      { action: "correct", recordId: "mem-1", body: "keeps two gardens", expectedRevisionId: "memrev-1" },
      { action: "approve", recordId: "mem-1", note: "right" },
      { action: "reject", recordId: "mem-1" },
      { action: "forget", recordId: "mem-1", reason: "wrong" },
      { action: "usage" },
    ]) {
      expect(parseCommandPayload("memory", payload).ok, JSON.stringify(payload)).toBe(true);
    }
    for (const payload of [
      {},
      { action: "search", query: "x" },
      { action: "list", statuses: ["deleted"] },
      { action: "list", scopes: ["run_local"] },
      { action: "list", scopes: ["agent:"] },
      { action: "list", limit: MEMORY_IPC_LIST_MAX + 1 },
      { action: "list", query: "   " },
      { action: "list", cursor: "../x" },
      { action: "get" },
      { action: "get", recordId: "mem-1", principalId: "someone" },
      { action: "remember", kind: "fact", scope: "personal" },
      { action: "remember", kind: "fact", scope: "everyone", body: "x" },
      { action: "remember", kind: "opinion", scope: "personal", body: "x" },
      { action: "remember", kind: "fact", scope: "personal", body: "x".repeat(MAX_MEMORY_BODY_BYTES + 1) },
      { action: "approve", recordId: "mem-1", note: "x".repeat(501) },
      { action: "usage", recordId: "mem-1" },
    ]) {
      expect(parseCommandPayload("memory", payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("round-trips the list cursor and refuses a foreign one", () => {
    for (const offset of [0, 1, 50, 123_456]) expect(decodeMemoryListCursor(encodeMemoryListCursor(offset))).toBe(offset);
    expect(decodeMemoryListCursor("bm90LWEtY3Vyc29y")).toBeUndefined();
    expect(decodeMemoryListCursor("o-1")).toBeUndefined();
  });
});

describe("memory answers", () => {
  it("counts other people's proposals, and reports the operator's quota, each optional for an older owner", () => {
    expect(MemoryListAnswerSchema.safeParse({ records: [], otherPeople: [] }).success).toBe(true);
    expect(
      MemoryListAnswerSchema.safeParse({ records: [], otherPeople: [], otherProposals: [{ principalId: "alice", count: 2 }] }).success,
    ).toBe(true);
    expect(
      MemoryListAnswerSchema.safeParse({ records: [], otherPeople: [], otherProposals: [{ principalId: "alice", count: 0 }] }).success,
    ).toBe(false);
    expect(MemoryUsageAnswerSchema.safeParse({ records: 3, bytes: 10 }).success).toBe(true);
    expect(
      MemoryUsageAnswerSchema.safeParse({ records: 3, bytes: 10, quota: { records: 1, bytes: 4, maxRecords: 5000, maxBytes: 1024 } })
        .success,
    ).toBe(true);
    expect(
      MemoryUsageAnswerSchema.safeParse({ records: 3, bytes: 10, quota: { records: 1, bytes: 4, maxRecords: 0, maxBytes: 1024 } }).success,
    ).toBe(false);
  });
});

describe("memory scope targets", () => {
  it("maps each target to the operator's scope and back", () => {
    expect(memoryScopeForTarget("personal", operator)).toEqual({ kind: "personal", principalId: "operator" });
    expect(memoryScopeForTarget("workspace", operator)).toEqual({
      kind: "personal_workspace",
      principalId: "operator",
      workspaceId: "default",
    });
    expect(memoryScopeForTarget("shared", operator)).toEqual({ kind: "shared_workspace", workspaceId: "default" });
    expect(memoryScopeForTarget("agent:chief", operator)).toEqual({
      kind: "personal_agent",
      principalId: "operator",
      agentId: "chief",
      workspaceId: "default",
    });
    // A chat's notes are its own run-local scope.
    expect(memoryScopeForTarget("chat:t1", operator)).toEqual({
      kind: "run_local",
      principalId: "operator",
      workspaceId: "default",
      runId: "t1",
    });
    for (const target of ["personal", "workspace", "shared", "agent:chief", "chat:t1"] as const) {
      expect(memoryScopeTarget(memoryScopeForTarget(target, operator))).toBe(target);
    }
  });

  it("reaches a chat note only as the operator's durable run-local record in this workspace", () => {
    const note = { scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "t1" }, durable: true } as const;
    expect(operatorSeesChatNote(note, operator)).toBe(true);
    expect(operatorSeesChatNote({ scope: note.scope }, operator)).toBe(false);
    expect(operatorSeesChatNote({ ...note, scope: { ...note.scope, principalId: "bob" } }, operator)).toBe(false);
    expect(operatorSeesChatNote({ ...note, scope: { ...note.scope, workspaceId: "other" } }, operator)).toBe(false);
    expect(operatorSeesChatNote({ scope: { kind: "personal", principalId: "operator" }, durable: true }, operator)).toBe(false);
    // The page that lists every scope still shows no run-local record.
    expect(operatorSeesMemory(note.scope, operator)).toBe(false);
  });

  it("shows the operator's own scopes and the workspace's shared one, never another person's or run-local memory", () => {
    const seen: readonly MemoryScope[] = [
      { kind: "personal", principalId: "operator" },
      { kind: "personal_workspace", principalId: "operator", workspaceId: "default" },
      { kind: "personal_agent", principalId: "operator", agentId: "chief" },
      { kind: "personal_agent", principalId: "operator", agentId: "chief", workspaceId: "default" },
      { kind: "shared_workspace", workspaceId: "default" },
    ];
    const hidden: readonly MemoryScope[] = [
      { kind: "personal", principalId: "bob" },
      { kind: "personal_workspace", principalId: "operator", workspaceId: "elsewhere" },
      { kind: "personal_agent", principalId: "operator", agentId: "chief", workspaceId: "elsewhere" },
      { kind: "personal_agent", principalId: "bob", agentId: "chief", workspaceId: "default" },
      { kind: "shared_workspace", workspaceId: "elsewhere" },
      { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "run-1" },
    ];
    for (const scope of seen) expect(operatorSeesMemory(scope, operator), JSON.stringify(scope)).toBe(true);
    for (const scope of hidden) expect(operatorSeesMemory(scope, operator), JSON.stringify(scope)).toBe(false);
  });
});

describe("proposal expiry", () => {
  it("is 30 days after the proposal, or the proposal's own earlier expiry", () => {
    expect(MEMORY_PROPOSAL_TTL_DAYS).toBe(30);
    expect(DEFAULT_MEMORY_RETENTION_DAYS.proposedOrRejected).toBe(MEMORY_PROPOSAL_TTL_DAYS);
    expect(memoryProposalExpiresAt({ recordedAt: "2026-01-01T00:00:00.000Z" })).toBe("2026-01-31T00:00:00.000Z");
    expect(memoryProposalExpiresAt({ recordedAt: "2026-01-01T00:00:00.000Z", expiryAt: "2026-01-05T00:00:00.000Z" })).toBe(
      "2026-01-05T00:00:00.000Z",
    );
    expect(memoryProposalExpiresAt({ recordedAt: "2026-01-01T00:00:00.000Z", expiryAt: "2026-06-01T00:00:00.000Z" })).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });
});

describe("memory answers", () => {
  const item = {
    recordId: "mem-1",
    kind: "fact",
    scope: { kind: "personal", principalId: "operator" },
    scopeKey: "personal|p=operator",
    status: "proposed",
    sensitivity: "sensitive",
    revocationGeneration: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    target: "personal",
    title: null,
    body: null,
    redacted: true,
    truncated: false,
    expiresAt: "2026-01-31T00:00:00.000Z",
    sourceCount: 2,
  };

  it("carries a redacted item and counts, never evidence", () => {
    expect(MemoryItemSchema.safeParse(item).success).toBe(true);
    expect(MemoryItemSchema.safeParse({ ...item, target: "run_local" }).success).toBe(false);
    expect(
      MemoryListAnswerSchema.safeParse({
        records: [item],
        otherPeople: [{ principalId: "bob", count: 3 }],
        nextCursor: encodeMemoryListCursor(1),
      }).success,
    ).toBe(true);
    expect(MemoryListAnswerSchema.safeParse({ records: [], otherPeople: [{ principalId: "bob", count: 0 }] }).success).toBe(false);
    const got = {
      record: item,
      revisions: [
        { revisionId: "memrev-1", revisionNumber: 1, status: "active", author: "operator:ui", recordedAt: item.recordedAt, sourceCount: 2 },
      ],
      revisionCount: 1,
      reviews: [],
    };
    expect(MemoryGetAnswerSchema.safeParse(got).success).toBe(true);
    // A revision summary is strict: no body, no source payloads.
    expect(MemoryGetAnswerSchema.safeParse({ ...got, revisions: [{ ...got.revisions[0], body: "x" }] }).success).toBe(false);
    expect(MemoryGetAnswerSchema.safeParse({ ...got, revisions: [{ ...got.revisions[0], sourceIds: ["s"] }] }).success).toBe(false);
  });
});
