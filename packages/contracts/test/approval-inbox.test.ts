import { describe, expect, it } from "vitest";

import {
  APPROVAL_HISTORY_MAX_LIMIT,
  ApprovalHistoryInputSchema,
  ApprovalHistoryItemSchema,
  ApprovalSettlementSchema,
  IpcResponseSchema,
  PendingApprovalRowSchema,
  TOOL_HEADLINE_INPUT_FIELDS,
  approvalChannelLabel,
  parseCommandPayload,
  toolCallHeadline,
  toolCallTitle,
  isUnifiedDiff,
} from "../src/index.js";

/** The approvals inbox and its history. */

describe("approvals history payload", () => {
  it("accepts history with its filters, and keeps list and the decisions as they were", () => {
    for (const payload of [
      { action: "history" },
      {
        action: "history",
        workspaceId: "default",
        kinds: ["approval", "question"],
        states: ["granted", "expired", "answered"],
        since: "2026-09-01T00:00:00.000Z",
        until: "2026-09-30T00:00:00Z",
        toolId: "http.request",
        principalId: "ana",
        cursor: "abc_-9",
        limit: APPROVAL_HISTORY_MAX_LIMIT,
      },
      { action: "list", limit: 1000, cursor: "abc" },
      { action: "approve", taskId: "t", scope: "session" },
      { action: "show", taskId: "t" },
    ]) {
      expect(parseCommandPayload("approvals", payload).ok, JSON.stringify(payload)).toBe(true);
    }
  });

  it("refuses a history page over the limit, an unknown kind or state, and a history filter on another action", () => {
    for (const payload of [
      { action: "history", limit: APPROVAL_HISTORY_MAX_LIMIT + 1 },
      { action: "history", kinds: ["memory"] },
      { action: "history", states: ["pending"] },
      { action: "history", kinds: [] },
      { action: "history", since: "yesterday" },
      { action: "history", cursor: "not a cursor!" },
      { action: "list", kinds: ["approval"] },
      { action: "list", toolId: "http.request" },
      { action: "approve", taskId: "t", cursor: "abc" },
    ]) {
      expect(parseCommandPayload("approvals", payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("refuses a history window whose start follows its end", () => {
    expect(
      ApprovalHistoryInputSchema.safeParse({ workspaceId: "w", limit: 1, since: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(ApprovalHistoryInputSchema.parse({ workspaceId: "w", limit: 1, since: "2026-09-01T00:00:00Z" }).since).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });
});

describe("approvals history items", () => {
  it("is a union on kind that refuses a field of another kind", () => {
    const approval = {
      kind: "approval",
      approvalId: "a",
      taskId: "t",
      principalId: "p",
      toolId: "http.request",
      state: "granted",
      decidedBy: "ana",
      decidedAt: "2026-09-29T10:00:00.000Z",
      note: null,
      scope: "always",
      ruleId: "rule-1",
      via: "telegram-main",
      channel: "Telegram",
    };
    expect(ApprovalHistoryItemSchema.safeParse(approval).success).toBe(true);
    expect(ApprovalHistoryItemSchema.safeParse({ ...approval, state: "approved" }).success).toBe(false);
    expect(ApprovalHistoryItemSchema.safeParse({ ...approval, inputs: { url: "x" } }).success).toBe(false);
    const question = {
      kind: "question",
      waitId: "w",
      taskId: "t",
      principalId: "p",
      state: "answered",
      question: "Which?",
      answer: null,
      decidedAt: "2026-09-29T10:00:00.000Z",
    };
    expect(ApprovalHistoryItemSchema.safeParse(question).success).toBe(true);
    expect(ApprovalHistoryItemSchema.safeParse({ ...question, question: "q".repeat(301) }).success).toBe(false);
    expect(
      ApprovalHistoryItemSchema.safeParse({
        kind: "review",
        artifactId: "r",
        state: "rejected",
        decidedBy: null,
        decidedAt: "x",
        note: null,
        contentType: "text/plain",
      }).success,
    ).toBe(true);
  });

  it("describes a pending row and a settlement without the call's input", () => {
    const row = {
      approvalId: "a",
      taskId: "t",
      toolId: "http.request",
      callId: "c",
      steps: 1,
      createdAt: "x",
      workspaceId: "w",
      principalId: "p",
      taskStatus: "waiting",
      allowedScopes: ["once"],
    };
    expect(PendingApprovalRowSchema.safeParse(row).success).toBe(true);
    expect(PendingApprovalRowSchema.safeParse({ ...row, allowedScopes: [] }).success).toBe(false);
    expect(PendingApprovalRowSchema.safeParse({ ...row, inputs: {} }).success).toBe(false);
    // The chat it was announced in, named as the owner names it; without a name from an older owner.
    expect(
      PendingApprovalRowSchema.safeParse({
        ...row,
        announcedIn: { connectionId: "telegram-default", conversationId: "c", channel: "Telegram" },
      }).success,
    ).toBe(true);
    expect(
      PendingApprovalRowSchema.safeParse({ ...row, announcedIn: { connectionId: "telegram-default", conversationId: "c" } }).success,
    ).toBe(true);
    expect(
      PendingApprovalRowSchema.safeParse({ ...row, announcedIn: { connectionId: "telegram-default", conversationId: "c", channel: "" } })
        .success,
    ).toBe(false);
    expect(
      ApprovalSettlementSchema.safeParse({
        taskId: "t",
        steps: 1,
        state: "expired",
        decidedBy: "policy:expired",
        decidedAt: "x",
        via: "policy",
        channel: "policy",
      }).success,
    ).toBe(true);
    expect(
      ApprovalSettlementSchema.safeParse({
        taskId: "t",
        steps: null,
        state: "expired",
        decidedBy: "policy:expired",
        decidedAt: "x",
        via: "policy",
        channel: "policy",
      }).success,
    ).toBe(false);
    // A round whose calls were decided differently says so.
    expect(ApprovalSettlementSchema.safeParse({ taskId: "t", steps: 2, state: "mixed", decidedBy: "ana", decidedAt: "x" }).success).toBe(
      true,
    );
    expect(ApprovalSettlementSchema.safeParse({ taskId: "t", steps: 2, state: "answered", decidedBy: "ana", decidedAt: "x" }).success).toBe(
      false,
    );
  });

  it("carries a refusal's details over IPC", () => {
    const frame = {
      type: "response",
      requestId: "r",
      ok: false,
      error: { code: "NOT_PENDING", message: "gone", details: { settled: { state: "granted" } } },
    };
    expect(IpcResponseSchema.parse(frame).error?.details).toEqual({ settled: { state: "granted" } });
  });
});

describe("tool call headline", () => {
  it("names a call by its family's field, first line only, clamped", () => {
    expect(toolCallHeadline("http.request", { url: "https://example.com/a\nsecond", body: "x" })).toBe("https://example.com/a");
    // A file call by its path: a waiting write is never its tool id alone.
    expect(toolCallHeadline("fs.write", { path: "notes.txt", content: "Buy milk" })).toBe("notes.txt");
    expect(toolCallHeadline("web_search", { query: "tavi" })).toBe("tavi");
    // A browser call by its page's address only: an element's ref or a session id says nothing to a person.
    expect(toolCallHeadline("browser.act", { sessionId: "s-1", ref: "el-6" })).toBeUndefined();
    expect(toolCallHeadline("browser.navigate", { sessionId: "s-1", url: "https://example.com" })).toBe("https://example.com");
    expect(toolCallHeadline("sandbox.run", { command: "c".repeat(100) })).toBe(`${"c".repeat(71)}…`);
    expect(toolCallHeadline("gsc.query", { projectId: 42 })).toBe("42");
    expect(toolCallHeadline("unknown.tool", { url: "x" })).toBeUndefined();
    expect(toolCallHeadline("constructor.x", { url: "x" })).toBeUndefined();
    expect(toolCallHeadline("http.request", "not an object")).toBeUndefined();
    expect(toolCallHeadline("http.request", { url: { nested: true } })).toBeUndefined();
  });

  it("lists every field a family reads, for a store to extract", () => {
    expect(TOOL_HEADLINE_INPUT_FIELDS).toEqual(expect.arrayContaining(["url", "query", "command", "question", "projectId"]));
    for (const field of TOOL_HEADLINE_INPUT_FIELDS) expect(field).toMatch(/^[A-Za-z]+$/);
  });
});

describe("approval channel label", () => {
  it("names the fixed front ends, and a connection by its name when known", () => {
    expect(approvalChannelLabel("bridge")).toBe("web");
    expect(approvalChannelLabel("cli")).toBe("terminal");
    expect(approvalChannelLabel("link")).toBe("email link");
    expect(approvalChannelLabel("telegram-main", (id) => (id === "telegram-main" ? "Telegram" : undefined))).toBe("Telegram");
    expect(approvalChannelLabel("mystery")).toBe("mystery");
  });
});

describe("tool call title", () => {
  it("says a known tool's call in words, any other by its id and headline, and a bare call by its id once", () => {
    expect(toolCallTitle("fs.write", "notes.txt")).toBe("Write notes.txt");
    expect(toolCallTitle("web_search", "trains")).toBe("Search the web for trains");
    expect(toolCallTitle("agents.list", "a1")).toBe("agents.list a1");
    expect(toolCallTitle("fs.write", undefined)).toBe("fs.write");
    expect(toolCallTitle("constructor", "x")).toBe("constructor x");
  });
});

describe("a card's diff", () => {
  it("is a detail that opens with --- and +++ lines, never free text that starts with a dash", () => {
    expect(isUnifiedDiff("--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+x")).toBe(true);
    expect(isUnifiedDiff("--- signed, Ana")).toBe(false);
    expect(isUnifiedDiff(undefined)).toBe(false);
  });
});
