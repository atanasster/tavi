import { describe, expect, it } from "vitest";

import {
  AgentStateDataSchema,
  CLIENT_PROTOCOL_VERSION,
  ClientEventSchema,
  ReplyPayloadSchema,
  STEERS_PER_TURN,
  TranscriptItemSchema,
  replyIntentOf,
} from "../src/index.js";

/** Steering: the contract's side. */
describe("a reply's intent", () => {
  const reply = { workspaceId: "ws-1", taskId: "task-1", text: "and also this", clientMessageId: "m-1" };

  it("is queue when a reply names none", () => {
    const parsed = ReplyPayloadSchema.parse(reply);
    expect(parsed.intent).toBeUndefined();
    expect(replyIntentOf(parsed)).toBe("queue");
  });

  it("takes queue or steer, and nothing else", () => {
    expect(replyIntentOf(ReplyPayloadSchema.parse({ ...reply, intent: "steer" }))).toBe("steer");
    expect(replyIntentOf(ReplyPayloadSchema.parse({ ...reply, intent: "queue" }))).toBe("queue");
    expect(ReplyPayloadSchema.safeParse({ ...reply, intent: "interrupt" }).success).toBe(false);
  });
});

describe("the turn.steered event", () => {
  it("carries the reply's message id and its text, on protocol 6", () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(8);
    const event = ClientEventSchema.parse({
      kind: "turn.steered",
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      epoch: "e1",
      sequence: 3,
      runId: "task-1",
      attemptId: "a1",
      at: "2026-10-04T10:00:00.000Z",
      messageId: "m-1",
      text: "and also this",
    });
    expect(event.kind === "turn.steered" ? event.messageId : undefined).toBe("m-1");
  });
});

describe("a steer in the saved turn and the workflow state", () => {
  it("is a transcript item of its own", () => {
    expect(TranscriptItemSchema.parse({ kind: "steer", text: "and also this" })).toEqual({ kind: "steer", text: "and also this" });
    expect(TranscriptItemSchema.safeParse({ kind: "steer", text: "" }).success).toBe(false);
  });

  it("starts each admission with no steers, and bounds them", () => {
    const state = AgentStateDataSchema.parse({
      stateVersion: 1,
      runId: "task-1",
      phase: "running",
      invocation: { workspaceId: "ws-1", principalId: "p-1", runId: "task-1", caller: "cli" },
    });
    expect(state.turnSteers).toEqual([]);
    expect(STEERS_PER_TURN).toBeLessThanOrEqual(16);
  });
});
