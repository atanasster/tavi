import { describe, expect, it } from "vitest";

import { APPROVAL_HISTORY_STATES_BY_KIND, ConnectRequestSchema, NeedRowSchema, connectNeedText, needsOf } from "../src/index.js";

/** A connect wait. */

describe("a connect need", () => {
  it("is told on a channel in Tavi's words alone: no link, no token", () => {
    const text = connectNeedText({ appName: "Google Calendar" });
    expect(text).toBe("Google Calendar needs you to sign in again. Open Tavi on your computer → Connected apps.");
    expect(text).not.toMatch(/https?:|www\.|\?|token/i);
  });

  it("asks a first sign-in of an account never signed in, not a sign-in again (QA 2091)", () => {
    expect(connectNeedText({ appName: "Google", health: "not-set-up" })).toBe(
      "Google isn't signed in yet. Open Tavi on your computer → Connected apps.",
    );
  });

  it("is a need of its own, decided as connected, declined, expired or cancelled", () => {
    expect(APPROVAL_HISTORY_STATES_BY_KIND.connect).toEqual(["connected", "declined", "expired", "cancelled"]);
    const connect = {
      taskId: "t1",
      workspaceId: "default",
      principalId: "operator",
      waitId: "w1",
      appName: "Google Calendar",
      accountId: "mcp.gcal",
      reason: "its sign-in expired",
      health: "needs-sign-in" as const,
      askedAt: "2026-10-16T09:00:00.000Z",
      deadlineAt: "2026-10-16T09:30:00.000Z",
    };
    const [need] = needsOf({ approvals: [], questions: [], reviews: [], connects: [connect] });
    expect(need).toEqual({
      kind: "connect",
      needId: "connect:w1",
      taskId: "t1",
      askedAt: connect.askedAt,
      deadlineAt: connect.deadlineAt,
      connect,
    });
    expect(NeedRowSchema.safeParse(need).success).toBe(true);
    expect(
      ConnectRequestSchema.safeParse({ appName: "X", accountId: "a", reason: "r", health: "needs-sign-in", url: "https://evil" }).success,
    ).toBe(false);
  });
});
