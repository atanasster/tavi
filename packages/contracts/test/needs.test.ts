import { describe, expect, it } from "vitest";

import { NeedsAnswerSchema, needsOf, type PendingApprovalRow, type PendingQuestionRow, type PendingReviewRow } from "../src/index.js";

/** One queue from each kind. */

const task = { workspaceId: "default", principalId: "operator" };
const question = (waitId: string, deadlineAt: string, askedAt = "2026-10-02T09:00:00.000Z"): PendingQuestionRow => ({
  ...task,
  taskId: `t-${waitId}`,
  waitId,
  question: "Ship?",
  deadlineAt,
  askedAt,
  deliveries: [],
});
const approval = (approvalId: string, createdAt: string, expiresAt?: string): PendingApprovalRow => ({
  ...task,
  approvalId,
  taskId: `t-${approvalId}`,
  toolId: "http.request",
  callId: "c1",
  steps: 1,
  createdAt,
  taskStatus: "waiting",
  allowedScopes: ["once"],
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const review = (taskId: string, askedAt: string): PendingReviewRow => ({ ...task, taskId, artifactCount: 1, askedAt });

describe("needsOf", () => {
  it("orders by the soonest deadline, then the oldest, with undated needs last", () => {
    const needs = needsOf({
      approvals: [
        approval("a-undated-old", "2026-10-02T08:00:00.000Z"),
        approval("a-expiring", "2026-10-02T09:30:00.000Z", "2026-10-02T10:00:00.000Z"),
      ],
      questions: [question("q-later", "2026-10-02T12:00:00.000Z"), question("q-soon", "2026-10-02T09:45:00.000Z")],
      reviews: [review("t-review", "2026-10-02T07:00:00.000Z")],
    });
    expect(needs.map((need) => need.needId)).toEqual([
      "question:q-soon",
      "approval:a-expiring",
      "question:q-later",
      "review:t-review",
      "approval:a-undated-old",
    ]);
    expect(needs[1]).toMatchObject({
      kind: "approval",
      taskId: "t-a-expiring",
      askedAt: "2026-10-02T09:30:00.000Z",
      deadlineAt: "2026-10-02T10:00:00.000Z",
    });
    expect(NeedsAnswerSchema.parse({ needs, truncated: false }).needs).toHaveLength(5);
  });
});
