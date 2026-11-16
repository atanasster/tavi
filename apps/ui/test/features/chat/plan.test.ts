import type { TranscriptEntry } from "@tavi/client/browser";
import { describe, expect, it } from "vitest";

import { latestPlan, planStep } from "../../../src/features/chat/plan.js";

const plan = (
  callId: string,
  items: readonly { readonly content: string; readonly status: "pending" | "in_progress" | "done" }[],
  status: "completed" | "failed" = "completed",
): TranscriptEntry => ({ kind: "tool", key: callId, attemptId: "a", callId, toolName: "plan.update", input: { items }, status });

describe("the plan a turn keeps", () => {
  it("is the latest accepted plan.update, never a refused or malformed one", () => {
    expect(latestPlan([])).toBeUndefined();
    const entries = [
      plan("c1", [{ content: "a", status: "done" }]),
      plan("c2", [{ content: "b", status: "pending" }], "failed"),
      { ...plan("c3", []), input: { items: "nope" } },
    ];
    expect(latestPlan(entries)).toEqual([{ content: "a", status: "done" }]);
  });

  it("stands at the step in progress, else the first not done, and nowhere once all are done", () => {
    expect(
      planStep([
        { content: "a", status: "done" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ]),
    ).toEqual({ step: 2, of: 3, content: "b" });
    expect(
      planStep([
        { content: "a", status: "done" },
        { content: "b", status: "pending" },
      ]),
    ).toEqual({ step: 2, of: 2, content: "b" });
    expect(planStep([{ content: "a", status: "done" }])).toBeUndefined();
  });
});
