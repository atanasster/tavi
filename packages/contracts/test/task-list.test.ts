import { describe, expect, it } from "vitest";
import {
  isAttendedOrigin,
  isIpcOrigin,
  parseCommandPayload,
  reminderIdOfTaskKey,
  reminderTaskOperationKey,
  TaskListResultSchema,
  TaskListRowSchema,
  TaskPromptsResultSchema,
  TASK_CHANNEL_KINDS,
  TASK_LIST_LIMIT,
  TASK_NEEDS_LIMIT,
  TASK_PROMPT_TEXT_MAX,
  TASK_PROMPTS_LIMIT,
} from "../src/index.js";

describe("task list contract", () => {
  it("preserves document reads while isolating list filters", () => {
    for (const payload of [
      {},
      { taskId: "t" },
      { action: "list", workspaceId: "default", needs: ["approval", "question"], limit: 1, cursor: "opaque" },
    ]) {
      expect(parseCommandPayload("tasks", payload).ok).toBe(true);
    }
    for (const payload of [
      { action: "list", taskId: "t" },
      { taskId: "t", label: { label: "success" } },
      { query: "unscoped" },
      { action: "other" },
    ])
      expect(parseCommandPayload("tasks", payload).ok).toBe(false);
  });
  it("bounds filters, dates, cursors, and the needs set", () => {
    for (const filters of [
      { limit: 0 },
      { limit: TASK_LIST_LIMIT + 1 },
      { limit: 1.5 },
      { query: "x".repeat(257) },
      { needs: ["approval", "approval"] },
      { needs: ["unknown"] },
      { status: ["bogus"] },
      { origin: ["bogus"] },
      { cursor: "../x" },
      { since: "yesterday" },
      { since: "2026-02-02T00:00:00Z", until: "2026-01-01T00:00:00Z" },
    ])
      expect(parseCommandPayload("tasks", { action: "list", ...filters }).ok).toBe(false);
  });
  it("accepts an order and the delegated switch, and rows with or without the owner's newer fields", () => {
    for (const filters of [{ order: "created" }, { order: "updated" }, { includeDelegated: true }])
      expect(parseCommandPayload("tasks", { action: "list", ...filters }).ok).toBe(true);
    // Every kind of need at once, browser handoffs included: what the canvas's inbox asks for.
    expect(parseCommandPayload("tasks", { action: "list", needs: ["approval", "review", "question", "handoff"] }).ok).toBe(true);
    for (const filters of [{ order: "title" }, { includeDelegated: "yes" }])
      expect(parseCommandPayload("tasks", { action: "list", ...filters }).ok).toBe(false);
    const row = {
      taskId: "t",
      workspaceId: "default",
      status: "working",
      origin: "agent",
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
      needs: [],
      counts: { admissions: 1, tools: 0 },
    };
    expect(TaskListRowSchema.safeParse({ ...row, principalId: "operator", delegated: 2, rootTaskId: "root" }).success).toBe(true);
    expect(TaskListRowSchema.safeParse({ ...row, delegated: -1 }).success).toBe(false);
  });
  it("filters by person and channel kind, and carries a row's own needs", () => {
    for (const filters of [{ principalId: "ana" }, { channelKinds: ["telegram", "mailgun"] }, { channelKinds: [...TASK_CHANNEL_KINDS] }]) {
      expect(parseCommandPayload("tasks", { action: "list", ...filters }).ok).toBe(true);
    }
    for (const filters of [{ principalId: "" }, { channelKinds: [] }, { channelKinds: ["Fax!"] }, { principalId: "x".repeat(129) }]) {
      expect(parseCommandPayload("tasks", { action: "list", ...filters }).ok).toBe(false);
    }
    const row = {
      taskId: "t",
      workspaceId: "default",
      status: "input-required",
      origin: "ipc",
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
      needs: ["question"],
      counts: { admissions: 1, tools: 0 },
    };
    expect(TaskListRowSchema.safeParse({ ...row, ownNeeds: [], descendantNeeds: ["question"] }).success).toBe(true);
    expect(TaskListRowSchema.safeParse({ ...row, ownNeeds: ["question", "question"] }).success).toBe(false);
  });
  it("compares timestamp instants at storage millisecond precision", () => {
    const since = "2026-09-20T00:00:00Z";
    const until = "2026-09-20T00:00:00.100Z";
    expect(parseCommandPayload("tasks", { action: "list", since, until }).ok).toBe(true);
    expect(parseCommandPayload("tasks", { action: "list", since: until, until: since }).ok).toBe(false);
    expect(parseCommandPayload("tasks", { action: "list", since, until: "2026-09-20T00:00:00.000000Z" }).ok).toBe(true);
  });
  it("allows old rows without prompt data, multiple needs, and explicit truncation", () => {
    const row = {
      taskId: "t",
      workspaceId: "default",
      status: "input-required",
      origin: null,
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
      needs: ["approval", "review", "question"],
      counts: { admissions: 1, tools: 0 },
    };
    expect(TaskListRowSchema.safeParse(row).success).toBe(true);
    expect(TaskListRowSchema.safeParse({ ...row, counts: { admissions: 1, tools: null } }).success).toBe(true);
    expect(TaskListResultSchema.safeParse({ action: "list", rows: [row], truncated: true }).success).toBe(true);
    expect(TaskListResultSchema.safeParse({ tasks: [] }).success).toBe(false);
    // A newer owner's status this build does not know reads as unknown, never failing the list.
    expect(TaskListRowSchema.parse({ ...row, status: "idle" }).status).toBe("idle");
    expect(TaskListRowSchema.parse({ ...row, status: "dormant" }).status).toBe("unknown");
    expect(
      TaskListResultSchema.safeParse({ action: "list", rows: Array.from({ length: TASK_NEEDS_LIMIT + 1 }, () => row), truncated: false })
        .success,
    ).toBe(false);
    expect(TaskListRowSchema.safeParse({ ...row, title: "x".repeat(121) }).success).toBe(false);
  });
  it("carries a row's channel and follow-up count, and a web origin", () => {
    const row = {
      taskId: "t",
      workspaceId: "default",
      status: "completed",
      origin: "web",
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
      needs: [],
      counts: { admissions: 3, tools: 0 },
    };
    expect(TaskListRowSchema.safeParse({ ...row, channel: { kind: "web" }, followUps: 2 }).success).toBe(true);
    expect(TaskListRowSchema.safeParse({ ...row, channel: { kind: "routine", label: "Morning news" } }).success).toBe(true);
    // A messaging task's kind is its provider's id, any channel plugin's: open, but shaped.
    expect(TaskListRowSchema.safeParse({ ...row, channel: { kind: "whatsapp-cloud" } }).success).toBe(true);
    expect(TaskListRowSchema.safeParse({ ...row, channel: { kind: "Fax!" } }).success).toBe(false);
    expect(TaskListRowSchema.safeParse({ ...row, channel: { kind: "web", extra: 1 } }).success).toBe(false);
    expect(TaskListRowSchema.safeParse({ ...row, followUps: -1 }).success).toBe(false);
    expect(parseCommandPayload("tasks", { action: "list", origin: ["web"] }).ok).toBe(true);
  });
  it("reads a task's follow-ups by id, optionally in a workspace, and bounds the answer", () => {
    expect(parseCommandPayload("tasks", { action: "prompts", taskId: "t" }).ok).toBe(true);
    expect(parseCommandPayload("tasks", { action: "prompts", taskId: "t", workspaceId: "default" }).ok).toBe(true);
    for (const payload of [{ action: "prompts" }, { action: "prompts", taskId: "t", limit: 5 }, { action: "prompts", taskId: "" }])
      expect(parseCommandPayload("tasks", payload).ok).toBe(false);
    const item = { at: "2026-09-20T00:00:00Z", text: "Make it shorter" };
    expect(TaskPromptsResultSchema.safeParse({ action: "prompts", items: [item], truncated: false }).success).toBe(true);
    expect(
      TaskPromptsResultSchema.safeParse({
        action: "prompts",
        items: [{ ...item, text: "x".repeat(TASK_PROMPT_TEXT_MAX + 1) }],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      TaskPromptsResultSchema.safeParse({
        action: "prompts",
        items: Array.from({ length: TASK_PROMPTS_LIMIT + 1 }, () => item),
        truncated: true,
      }).success,
    ).toBe(false);
  });
});

describe("task origins", () => {
  it("treats web as attended and as an IPC start, like ipc", () => {
    expect(["cli", "ipc", "web"].every(isAttendedOrigin)).toBe(true);
    expect(["messaging", "schedule", "agent", "reminder", null, undefined].some(isAttendedOrigin)).toBe(false);
    expect([isIpcOrigin("ipc"), isIpcOrigin("web"), isIpcOrigin("cli")]).toEqual([true, true, false]);
  });
  it("round-trips a reminder task's operation key", () => {
    expect(reminderIdOfTaskKey(reminderTaskOperationKey("rem:1", "2026-09-20T00:00:00Z"))).toBe("rem:1");
    expect(reminderIdOfTaskKey("reminder:short")).toBeUndefined();
  });
});
