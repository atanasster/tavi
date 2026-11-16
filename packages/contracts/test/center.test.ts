import { describe, expect, it } from "vitest";

import {
  CENTER_CHANGE_KINDS,
  CENTER_SUMMARY_MAX_DAYS,
  CenterSummaryAnswerSchema,
  CenterWatchAnswerSchema,
  IPC_COMMANDS,
  UI_BRIDGE_COMMANDS,
  parseCommandPayload,
} from "../src/index.js";

describe("the center command", () => {
  it("is declared and forwarded by the bridge", () => {
    expect(IPC_COMMANDS).toContain("center");
    expect(UI_BRIDGE_COMMANDS).toContain("center");
  });

  it("accepts a summary and a watch, each with its own bounds", () => {
    for (const payload of [
      { action: "summary" },
      { action: "summary", workspaceId: "default", days: 1 },
      { action: "summary", days: CENTER_SUMMARY_MAX_DAYS },
      { action: "watch" },
      { action: "watch", workspaceId: "default", cursor: "abc_-9", timeoutMs: 1_000 },
      { action: "watch", timeoutMs: 25_000 },
    ]) {
      expect(parseCommandPayload("center", payload).ok, JSON.stringify(payload)).toBe(true);
    }
    for (const payload of [
      {},
      { action: "list" },
      { action: "summary", days: 0 },
      { action: "summary", days: CENTER_SUMMARY_MAX_DAYS + 1 },
      { action: "summary", days: 1.5 },
      { action: "summary", cursor: "abc" },
      { action: "watch", days: 3 },
      { action: "watch", timeoutMs: 999 },
      { action: "watch", timeoutMs: 25_001 },
      { action: "watch", cursor: "../x" },
      { action: "watch", cursor: "" },
      { action: "watch", cursor: "x".repeat(2049) },
    ]) {
      expect(parseCommandPayload("center", payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("bounds the summary answer", () => {
    const answer = {
      workspaceId: "default",
      timezone: "Europe/Berlin",
      today: "2026-09-29",
      counts: { approvals: 0, reviews: 1, questions: 0, runningTasks: 2, memoryProposals: 0, activeRoutines: 1, schedules: 0 },
      perDay: [{ date: "2026-09-29", tasks: 3 }],
      next: [{ kind: "routine", id: "routine-1", title: "Morning news", at: "2026-09-30T05:00:00.000Z" }],
      people: { operator: "operator" },
      cursor: "abc",
    };
    expect(CenterSummaryAnswerSchema.safeParse(answer).success).toBe(true);
    expect(CenterSummaryAnswerSchema.safeParse({ ...answer, today: "29/09/2026" }).success).toBe(false);
    expect(CenterSummaryAnswerSchema.safeParse({ ...answer, perDay: [] }).success).toBe(false);
    expect(
      CenterSummaryAnswerSchema.safeParse({ ...answer, next: [...answer.next, ...answer.next, ...answer.next, ...answer.next] }).success,
    ).toBe(false);
    // Reminders are a kind of their own; an unknown kind is still refused.
    expect(CenterSummaryAnswerSchema.safeParse({ ...answer, next: [{ ...answer.next[0], kind: "reminder" }] }).success).toBe(true);
    expect(CenterSummaryAnswerSchema.safeParse({ ...answer, next: [{ ...answer.next[0], kind: "browser" }] }).success).toBe(false);
    // An owner from before reminders sends no reminder counts; this build sends both.
    expect(CenterSummaryAnswerSchema.safeParse({ ...answer, counts: { ...answer.counts, reminders: 2, unseenReminders: 1 } }).success).toBe(
      true,
    );
    expect(CenterSummaryAnswerSchema.safeParse({ ...answer, counts: { ...answer.counts, approvals: -1 } }).success).toBe(false);
  });

  it("reports only the kinds it knows as changed", () => {
    expect(CenterWatchAnswerSchema.safeParse({ cursor: "abc", changed: [...CENTER_CHANGE_KINDS] }).success).toBe(true);
    // Browser history is a kind of its own; an unknown kind is still refused.
    expect(CenterWatchAnswerSchema.safeParse({ cursor: "abc", changed: ["browser"] }).success).toBe(true);
    expect(CenterWatchAnswerSchema.safeParse({ cursor: "abc", changed: ["gadget"] }).success).toBe(false);
  });
});
