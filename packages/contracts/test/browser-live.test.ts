import { describe, expect, it } from "vitest";

import {
  BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES,
  BROWSER_LIVE_DEFAULT_WIDTH,
  BROWSER_LIVE_INPUT_MAX_TEXT,
  BROWSER_LIVE_MAX_WIDTH,
  BROWSER_LIVE_MIN_WIDTH,
  AgentWaitOutcomeSchema,
  BrowserLiveInputEventSchema,
  BrowserRequestHandoffInputSchema,
  CLIENT_PROTOCOL_VERSION,
  ClientEventSchema,
  BrowserLiveMessageSchema,
  BrowserLiveWatchAnswerSchema,
  IPC_COMMANDS,
  IpcCommandPayloadSchemas,
  IpcFrameSchema,
  clampLiveWidth,
  parseCommandPayload,
  type BrowserLiveMessage,
} from "../src/index.js";
import { FrameReader, encodeFrame } from "../src/ipc-codec.js";

const SESSION = "6f1d2c3b-0000-4000-8000-000000000001";
const frame: BrowserLiveMessage = {
  kind: "frame",
  sessionId: SESSION,
  mime: "image/jpeg",
  data: "/9j/4AAQ",
  width: 640,
  height: 360,
  metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 120 },
  at: "2026-10-03T10:00:00.000Z",
  source: "live",
};

describe("the live browser view's contract", () => {
  it("round-trips every message kind through the IPC codec as a `live` frame", () => {
    const messages: BrowserLiveMessage[] = [
      {
        kind: "session",
        sessionId: SESSION,
        taskId: "task-1",
        state: "open",
        url: "https://example.com/a",
        title: "A",
        openedByCallId: "call-1",
      },
      { kind: "navigated", sessionId: SESSION, url: "https://example.com/b", epoch: 3 },
      {
        kind: "action",
        sessionId: SESSION,
        phase: "started",
        action: "click",
        box: { x: 10, y: 20, width: 100, height: 30 },
        callId: "call-2",
      },
      { kind: "action", sessionId: SESSION, phase: "ended", action: "click", status: "accepted" },
      {
        kind: "action",
        sessionId: SESSION,
        phase: "pending",
        action: "submit",
        box: { x: 1, y: 2, width: 3, height: 4 },
        callId: "call-3",
      },
      frame,
      { kind: "hidden", sessionId: SESSION, reason: "payment-field" },
      { kind: "ended", sessionId: SESSION, reason: "task-ended" },
      { kind: "session", sessionId: SESSION, taskId: "task-1", state: "open", control: "operator" },
      { kind: "control", sessionId: SESSION, state: "operator", controller: "you" },
      { kind: "control", sessionId: SESSION, state: "agent", pending: true },
      {
        kind: "select",
        sessionId: SESSION,
        ref: "select-1",
        box: { x: 1, y: 2, width: 3, height: 4 },
        options: [{ value: "s", label: "Small", selected: true, disabled: true }],
      },
      { kind: "dialog", sessionId: SESSION, type: "prompt", message: "Name?", defaultValue: "guest" },
      { kind: "notice", sessionId: SESSION, notice: "shortcut-refused" },
    ];
    const reader = new FrameReader();
    for (const [seq, message] of messages.entries()) {
      const read = reader.push(encodeFrame({ type: "live", subscriptionId: "live-1", seq, message }));
      expect(read.error).toBeUndefined();
      expect(read.frames).toEqual([{ type: "live", subscriptionId: "live-1", seq, message }]);
    }
  });

  it("refuses a frame past its byte bound, an unknown kind, and fields a message does not have", () => {
    // The controller's sharper stream is the largest a frame may be.
    expect(BrowserLiveMessageSchema.safeParse({ ...frame, data: "A".repeat(BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES + 1) }).success).toBe(
      false,
    );
    expect(BrowserLiveMessageSchema.safeParse({ ...frame, mime: "image/png" }).success).toBe(false);
    expect(BrowserLiveMessageSchema.safeParse({ kind: "typed", sessionId: SESSION, text: "secret" }).success).toBe(false);
    // An action never carries what was typed.
    expect(
      BrowserLiveMessageSchema.safeParse({ kind: "action", sessionId: SESSION, phase: "started", action: "type", value: "hunter2" })
        .success,
    ).toBe(false);
    expect(BrowserLiveMessageSchema.safeParse({ kind: "hidden", sessionId: SESSION, reason: "because" }).success).toBe(false);
    expect(IpcFrameSchema.safeParse({ type: "live", subscriptionId: "live-1", seq: -1, message: frame }).success).toBe(false);
  });

  it("adds `browser-live` as a validated command: watch, ack and unwatch", () => {
    expect(IPC_COMMANDS).toContain("browser-live");
    expect(Object.hasOwn(IpcCommandPayloadSchemas, "browser-live")).toBe(true);
    expect(parseCommandPayload("browser-live", { action: "watch", workspaceId: "default", taskId: "task-1", maxWidth: 640 }).ok).toBe(true);
    expect(parseCommandPayload("browser-live", { action: "watch", workspaceId: "default", taskId: "task-1", sessionId: SESSION }).ok).toBe(
      true,
    );
    expect(parseCommandPayload("browser-live", { action: "ack", subscriptionId: "live-1", seq: 4 }).ok).toBe(true);
    expect(parseCommandPayload("browser-live", { action: "unwatch", subscriptionId: "live-1" }).ok).toBe(true);
    expect(parseCommandPayload("browser-live", { action: "watch", workspaceId: "default" }).ok).toBe(false);
    expect(parseCommandPayload("browser-live", { action: "ack", subscriptionId: "live-1" }).ok).toBe(false);
    expect(parseCommandPayload("browser-live", { action: "unwatch", subscriptionId: "live-1", extra: true }).ok).toBe(false);
    expect(BrowserLiveWatchAnswerSchema.safeParse({ subscriptionId: "live-1", sessions: [] }).success).toBe(true);
  });

  it("clamps a watcher's width to the screencast's bounds", () => {
    expect(clampLiveWidth(undefined)).toBe(BROWSER_LIVE_DEFAULT_WIDTH);
    expect(clampLiveWidth(4000)).toBe(BROWSER_LIVE_MAX_WIDTH);
    expect(clampLiveWidth(10)).toBe(BROWSER_LIVE_MIN_WIDTH);
    expect(clampLiveWidth(500.4)).toBe(500);
  });

  it("bounds the controller's input events, which name a key or a point and never more", () => {
    for (const event of [
      { type: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 8 },
      { type: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 120 },
      { type: "key", action: "down", key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      { type: "text", text: "ünïcode" },
    ])
      expect(BrowserLiveInputEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    for (const event of [
      { type: "mouse", action: "click", x: 1, y: 1 },
      { type: "mouse", action: "down", x: Number.NaN, y: 1 },
      { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 16 },
      { type: "key", action: "down", key: "a", code: "KeyA", text: "too long" },
      { type: "text", text: "" },
      { type: "text", text: "x".repeat(BROWSER_LIVE_INPUT_MAX_TEXT + 1) },
      { type: "touch", x: 1, y: 1 },
      { type: "mouse", action: "move", x: 1, y: 1, extra: true },
    ])
      expect(BrowserLiveInputEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(false);
  });

  it("adds the takeover actions to `browser-live`, each naming its watch and session", () => {
    const at = { subscriptionId: "live-1", sessionId: SESSION };
    for (const payload of [
      { action: "take", ...at, maxWidth: 1600 },
      { action: "input", ...at, seq: 0, events: [{ type: "mouse", action: "move", x: 1, y: 2 }] },
      { action: "select", ...at, ref: "select-1", value: "m" },
      { action: "dialog", ...at, accept: false },
      { action: "release", ...at, outcome: "failed", note: "The code never came." },
      { action: "release", ...at, outcome: "timeout" },
      { action: "decline", ...at, note: "No access" },
    ])
      expect(parseCommandPayload("browser-live", payload).ok, payload.action).toBe(true);
    for (const payload of [
      { action: "take", subscriptionId: "live-1" },
      { action: "input", ...at, seq: 0, events: [] },
      { action: "input", ...at, seq: 0, events: Array.from({ length: 65 }, () => ({ type: "text", text: "x" })) },
      // `cancelled` is the host's alone; the controller may hand back done, failed or (its own "Still working?") timeout.
      { action: "release", ...at, outcome: "cancelled" },
      { action: "release", ...at, outcome: "done", note: "x".repeat(501) },
    ])
      expect(parseCommandPayload("browser-live", payload).ok, JSON.stringify(payload).slice(0, 60)).toBe(false);
  });

  it("bounds a handoff request, and carries the handoff on the task's wait", () => {
    const asked = { sessionId: "browser-session-1", reason: "sign-in", instructions: "Sign in to example.com, then hand back" };
    expect(BrowserRequestHandoffInputSchema.safeParse({ ...asked, timeoutMinutes: 60 }).success).toBe(true);
    for (const input of [
      { ...asked, timeoutMinutes: 61 },
      { ...asked, reason: "operator" },
      { ...asked, instructions: "x".repeat(501) },
      { ...asked, password: "x" },
    ]) {
      expect(BrowserRequestHandoffInputSchema.safeParse(input).success).toBe(false);
    }
    const waiting = {
      kind: "task.waiting",
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      epoch: "e1",
      sequence: 1,
      attemptId: "a1",
      runId: "task-1",
      at: "2026-10-04T10:00:00.000Z",
      on: "its deadline",
      deadlineAt: "2026-10-04T10:15:00.000Z",
      waitId: "wait-1",
      handoff: { sessionId: SESSION, reason: "operator" },
    };
    const parsed = ClientEventSchema.safeParse(waiting);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(
      AgentWaitOutcomeSchema.safeParse({ kind: "answered", replyText: "Signed in", handoff: { outcome: "done", controlledMs: 1 } }).success,
    ).toBe(true);
    expect(AgentWaitOutcomeSchema.safeParse({ kind: "answered", handoff: { outcome: "timeout", controlledMs: 1 } }).success).toBe(false);
  });
});
