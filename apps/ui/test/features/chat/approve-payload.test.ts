import { ApprovePayloadSchema } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { decideRound } from "../../../src/features/center/approvals-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { approvePayload } from "../../../src/features/chat/tasks-api.js";

/**
 * One `approve` payload for every surface that decides a round (the task's
 * card and the inbox): a scope where calls are approved, a reason where they
 * are rejected, as the owner reads them.
 */

const round = { taskId: "t1", workspaceId: "default", expectedSteps: 3, decidedBy: "operator" };

describe("approvePayload", () => {
  it("gives an approving verdict its scope and no note", () => {
    const payload = approvePayload(round, true, { scope: "always", note: "looks fine" });
    expect(payload).toEqual({
      taskId: "t1",
      workspaceId: "default",
      expectedSteps: 3,
      verdict: "approve",
      scope: "always",
      decidedBy: "operator",
    });
    expect(ApprovePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("sends an explicit `once`, which the owner would otherwise widen for a grouped call", () => {
    expect(approvePayload(round, true, { scope: "once" })).toMatchObject({ verdict: "approve", scope: "once" });
    expect(
      approvePayload(
        round,
        [
          { callId: "a", approved: true },
          { callId: "b", approved: false },
        ],
        { scope: "once" },
      ),
    ).toMatchObject({
      decisions: [
        { callId: "a", approved: true, scope: "once" },
        { callId: "b", approved: false },
      ],
    });
  });

  it("gives a rejecting verdict its trimmed note and no scope", () => {
    expect(approvePayload(round, false, { scope: "session", note: "  try the cache " })).toEqual({
      taskId: "t1",
      workspaceId: "default",
      expectedSteps: 3,
      verdict: "reject",
      note: "try the cache",
      decidedBy: "operator",
    });
    expect(approvePayload(round, false, { note: " \n " })).not.toHaveProperty("note");
  });

  it("puts a per-call scope on approved calls and the reason on rejected ones, none at the top", () => {
    const payload = approvePayload(
      round,
      [
        { callId: "a", approved: true },
        { callId: "b", approved: false },
        { callId: "c", approved: false, note: " its own " },
      ],
      { scope: "session", note: " shared " },
    );
    expect(payload).toEqual({
      taskId: "t1",
      workspaceId: "default",
      expectedSteps: 3,
      decisions: [
        { callId: "a", approved: true, scope: "session" },
        { callId: "b", approved: false, note: "shared" },
        { callId: "c", approved: false, note: "its own" },
      ],
      decidedBy: "operator",
    });
    expect(ApprovePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("drops a note on an approved call", () => {
    expect(approvePayload(round, [{ callId: "a", approved: true, note: "why not" }])).toMatchObject({
      decisions: [{ callId: "a", approved: true }],
    });
  });

  it("omits an unknown round and decider", () => {
    expect(approvePayload({ taskId: "t1", workspaceId: "default" }, true)).toEqual({
      taskId: "t1",
      workspaceId: "default",
      verdict: "approve",
    });
  });
});

describe("decideRound", () => {
  const sent = async (decision: Parameters<typeof decideRound>[1]) => {
    const requests: { command: string; payload: unknown }[] = [];
    const client = {
      request: (command: string, payload: unknown) => (requests.push({ command, payload }), Promise.resolve({ ok: true, result: {} })),
    } as unknown as SettingsClient;
    expect(await decideRound(client, decision)).toEqual({ ok: true });
    expect(requests.map((request) => request.command)).toEqual(["approve"]);
    return requests[0]?.payload;
  };
  const card = { workspaceId: "default", taskId: "t1", steps: 3, decidedBy: "operator" };

  it("sends what the task's card sends for the same decision", async () => {
    expect(await sent({ ...card, approved: true, scope: "session" })).toEqual({
      taskId: "t1",
      workspaceId: "default",
      expectedSteps: 3,
      verdict: "approve",
      scope: "session",
      decidedBy: "operator",
    });
    expect(await sent({ ...card, approved: false, scope: "once", note: "  not now " })).toEqual({
      taskId: "t1",
      workspaceId: "default",
      expectedSteps: 3,
      verdict: "reject",
      note: "not now",
      decidedBy: "operator",
    });
  });

  it("decides call by call with the reason on each rejected call and the scope on each approved one", async () => {
    const decisions = [
      { callId: "a", approved: true },
      { callId: "b", approved: false },
    ];
    expect(await sent({ ...card, approved: true, scope: "session", decisions, note: " wrong page " })).toEqual({
      taskId: "t1",
      workspaceId: "default",
      expectedSteps: 3,
      decisions: [
        { callId: "a", approved: true, scope: "session" },
        { callId: "b", approved: false, note: "wrong page" },
      ],
      decidedBy: "operator",
    });
  });
});
