import { describe, expect, it, vi } from "vitest";

import { createPendingBrowserActions } from "../../src/features/browser/pending-actions.js";
import { delay } from "@tavi/test-support";

/** The live view's pending-approval outline. */

const invocation = { workspaceId: "default", principalId: "operator", runId: "t1", caller: "test" };
const act = (callId: string, kind: string, toolName = "browser.act") => ({
  callId,
  toolName,
  summary: "",
  input: { sessionId: "browser-session-1", ref: "el-3", epoch: 2, kind },
});

describe("the pending-approval outline", () => {
  it("outlines a submit, upload or download waiting on a round, takes it away when denied, and leaves an approved one to run", async () => {
    const told: unknown[] = [];
    const pending = createPendingBrowserActions({ pendingAction: async (input) => void told.push(input) }, () => undefined);
    pending.announced({
      taskId: "t1",
      steps: 1,
      invocation,
      requests: [
        act("c-submit", "submit"),
        act("c-click", "click"),
        act("c-down", "download"),
        { callId: "c-mail", toolName: "messaging.send", summary: "", input: {} },
      ],
    });
    await vi.waitFor(() => expect(told).toHaveLength(2));
    expect(told).toEqual([
      { sessionId: "browser-session-1", ref: "el-3", epoch: 2, kind: "submit", callId: "c-submit" },
      { sessionId: "browser-session-1", ref: "el-3", epoch: 2, kind: "download", callId: "c-down" },
    ]);
    pending.settled({
      taskId: "t1",
      steps: 1,
      invocation,
      decisions: [
        { callId: "c-submit", toolName: "browser.act", approved: false, scope: "once", decidedBy: "operator" },
        { callId: "c-down", toolName: "browser.act", approved: true, scope: "once", decidedBy: "operator" },
      ],
    });
    await vi.waitFor(() => expect(told).toHaveLength(3));
    expect(told.at(-1)).toEqual({
      sessionId: "browser-session-1",
      ref: "el-3",
      epoch: 2,
      kind: "submit",
      callId: "c-submit",
      decided: "denied",
    });
    // Settled once: a replayed settlement says nothing again.
    pending.settled({
      taskId: "t1",
      steps: 1,
      invocation,
      decisions: [{ callId: "c-submit", toolName: "browser.act", approved: false, scope: "once", decidedBy: "operator" }],
    });
    await delay(10);
    expect(told).toHaveLength(3);
  });

  it("never lets a browser that cannot outline fail the round", async () => {
    const reported: unknown[] = [];
    const pending = createPendingBrowserActions(
      {
        pendingAction: async () => {
          throw new Error("page gone");
        },
      },
      (error) => void reported.push(error),
    );
    expect(() => pending.announced({ taskId: "t1", steps: 1, invocation, requests: [act("c", "upload")] })).not.toThrow();
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(() =>
      createPendingBrowserActions({}, () => undefined).announced({ taskId: "t1", steps: 1, invocation, requests: [act("c", "upload")] }),
    ).not.toThrow();
  });

  it("outlines a round announced again on resume once, and never lets its denial overtake the outline", async () => {
    const told: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const pending = createPendingBrowserActions(
      {
        pendingAction: async (input) => {
          if (input.decided === undefined) await slow;
          told.push(input.decided ?? "pending");
        },
      },
      () => undefined,
    );
    const round = { taskId: "t1", steps: 1, invocation, requests: [act("c", "submit")] };
    pending.announced(round);
    pending.announced(round);
    pending.settled({
      taskId: "t1",
      steps: 1,
      invocation,
      decisions: [{ callId: "c", toolName: "browser.act", approved: false, scope: "once", decidedBy: "operator" }],
    });
    await delay(10);
    expect(told).toEqual([]);
    release();
    await vi.waitFor(() => expect(told).toEqual(["pending", "denied"]));
  });
});
