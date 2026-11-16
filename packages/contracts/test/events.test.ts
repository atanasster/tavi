import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CLIENT_PROTOCOL_VERSION, ClientEventSchema, EVENT_TEXT_BOUNDS, boundEventPayloads } from "../src/index.js";

/**
 * Event text bounds: every externally sourced text field is clamped
 * to the bound its schema gives it, so an event is never refused — a refusal
 * threw out of the graph's own event handler and failed the task it reported on.
 */

/** Identity and time fields: bounded, but never clamped — a clamped id breaks correlation. */
const IDENTITY_FIELDS = new Set([
  "pluginId",
  "stateKey",
  "childRunId",
  "sessionId",
  "messageId",
  "workerAgentId",
  "agentDefinitionId",
  "epoch",
  "runId",
  "attemptId",
  "at",
  "threadId",
  "workspaceId",
  "blockId",
  "callId",
  "approvalId",
  "supersededAttemptId",
  "deadlineAt",
  "waitId",
]);

/** The string schema under optional/default wrappers, if it is one. */
function stringSchema(schema: z.ZodType): z.ZodString | undefined {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current.unwrap() as z.ZodType;
  }
  return current instanceof z.ZodString ? current : undefined;
}

describe("event text bounds", () => {
  it("covers every bounded text field of every event kind with the schema's own bound", () => {
    // Walks the schema, so a field added with a new bound cannot escape the clamp.
    for (const option of ClientEventSchema.options) {
      for (const [field, schema] of Object.entries(option.shape)) {
        const text = stringSchema(schema as z.ZodType);
        if (text === undefined || text.maxLength === null || IDENTITY_FIELDS.has(field)) continue;
        expect(EVENT_TEXT_BOUNDS, `field ${field}`).toHaveProperty(field, text.maxLength);
      }
    }
  });

  it.each(Object.entries(EVENT_TEXT_BOUNDS))("clamps %s to exactly its bound, marked with …", (field, limit) => {
    const bounded = boundEventPayloads({ [field]: "x".repeat(limit + 50) });
    const value = bounded[field] as string;
    expect(value).toHaveLength(limit);
    expect(value.endsWith("…")).toBe(true);
    // Within the bound, nothing changes.
    expect(boundEventPayloads({ [field]: "fits" })[field]).toBe("fits");
  });

  it("never splits a surrogate pair at the cut", () => {
    const limit = EVENT_TEXT_BOUNDS.message;
    // An emoji straddling the cut: the high surrogate would be the last unit kept.
    const text = `${"a".repeat(limit - 2)}😀${"b".repeat(10)}`;
    const value = boundEventPayloads({ message: text }).message as string;
    expect(value.endsWith("…")).toBe(true);
    const last = value.charCodeAt(value.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("names a required label rather than leaving it empty", () => {
    expect(boundEventPayloads({ toolName: "" }).toolName).toBe("unknown");
    // An optional text field may be empty.
    expect(boundEventPayloads({ message: "" }).message).toBe("");
  });

  it("makes an event of every kind with oversized text acceptable to the schema", () => {
    const long = (limit: number) => "y".repeat(limit * 2);
    const envelope = {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      epoch: "session-1",
      sequence: 0,
      at: "2026-01-01T00:00:00.000Z",
      runId: "task-1",
      attemptId: "attempt-1",
    };
    const events = [
      { kind: "text.delta", blockId: "b", text: long(EVENT_TEXT_BOUNDS.text) },
      { kind: "tool.started", blockId: "b", callId: "c", toolName: long(EVENT_TEXT_BOUNDS.toolName), input: null },
      {
        kind: "tool.failed",
        callId: "c",
        toolName: long(EVENT_TEXT_BOUNDS.toolName),
        errorCode: long(EVENT_TEXT_BOUNDS.errorCode),
        message: long(EVENT_TEXT_BOUNDS.message),
        durationMs: 1,
      },
      {
        kind: "approval.required",
        callId: "c",
        toolName: "t",
        summary: long(EVENT_TEXT_BOUNDS.summary),
        input: null,
        steps: 1,
        approvalId: "approval:1",
        effect: long(EVENT_TEXT_BOUNDS.effect),
      },
      { kind: "approval.settled", steps: 1, decisions: [], decidedBy: long(EVENT_TEXT_BOUNDS.decidedBy) },
      { kind: "attempt.replaced", supersededAttemptId: "a0", reason: long(EVENT_TEXT_BOUNDS.reason) },
      {
        kind: "task.waiting",
        on: long(EVENT_TEXT_BOUNDS.on),
        deadlineAt: "2026-01-01T00:10:00.000Z",
        question: long(EVENT_TEXT_BOUNDS.question),
        waitId: "wait-1",
      },
      {
        kind: "wait.settled",
        waitId: "wait-1",
        outcome: "answered",
        replyText: long(EVENT_TEXT_BOUNDS.replyText),
        decidedBy: long(EVENT_TEXT_BOUNDS.decidedBy),
        via: long(EVENT_TEXT_BOUNDS.via),
      },
      { kind: "task.completed", finalText: long(EVENT_TEXT_BOUNDS.finalText) },
      { kind: "task.failed", errorCode: long(EVENT_TEXT_BOUNDS.errorCode), message: long(EVENT_TEXT_BOUNDS.message) },
      { kind: "resync.required", reason: long(EVENT_TEXT_BOUNDS.reason) },
    ];
    for (const event of events) {
      expect(ClientEventSchema.safeParse({ ...envelope, ...event }).success, `${event.kind} unclamped`).toBe(false);
      expect(ClientEventSchema.safeParse({ ...envelope, ...boundEventPayloads(event) }).success, event.kind).toBe(true);
    }
  });
});
