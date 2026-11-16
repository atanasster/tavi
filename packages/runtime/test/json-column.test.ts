import { join } from "node:path";

import { HeartbeatItemSchema, HeartbeatProposedActionSchema, TaviError, type InboundEvent, type SendOutcome } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  parseJsonColumn,
  StoredDeliveryDataSchema,
  StoredInboundEventSchema,
  StoredMcpToolDefinitionSchema,
  StoredOutboundMessageSchema,
  StoredRoutineRunDataSchema,
  StoredSendOutcomeSchema,
} from "../src/persistence/json-column.js";
import { SqliteStore } from "../src/persistence/store.js";

/** Persisted JSON columns are checked on read: a corrupt row fails loudly, naming its column. */

const AT = "2026-01-01T00:00:00.000Z";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function thrown(run: () => unknown): TaviError {
  try {
    run();
  } catch (error) {
    if (error instanceof TaviError) return error;
    throw error;
  }
  throw new Error("expected a throw");
}

const event: InboundEvent = {
  connectionId: "conn-1",
  providerEventId: "evt-1",
  kind: "message",
  externalSenderId: "user-1",
  externalConversationId: "chat-1",
  occurredAt: AT,
  receivedAt: AT,
  content: "hello",
};

const runData = {
  operationKey: "routine:run-1",
  deadline: AT,
  queueExpiresAt: AT,
  localDay: "2026-01-01",
  modelCalls: 0,
  toolCalls: 0,
  tokensReserved: 0,
  tokensKnown: 0,
  usageComplete: true,
  reservations: {},
  stepStarted: { research: AT },
  report: { title: "kept as stored" },
};

const deliveryData = { artifactId: "artifact-1", hash: "abc", targetId: "t-1", target: { kind: "chat" }, generation: 0, text: "hi" };

const cases: readonly { readonly what: string; readonly schema: z.ZodType; readonly valid: unknown; readonly malformed: unknown }[] = [
  { what: "tavi_messaging_inbox.payload_json", schema: StoredInboundEventSchema, valid: event, malformed: { ...event, connectionId: 7 } },
  {
    what: "tavi_messaging_outbox.message_json",
    schema: StoredOutboundMessageSchema,
    valid: { effectId: "eff-1", connectionId: "conn-1", destination: { chatId: "1" }, parts: [{ content: "hi" }] },
    malformed: { effectId: "eff-1", connectionId: "conn-1", parts: "hi" },
  },
  {
    what: "tavi_messaging_outbox.outcome_json",
    schema: StoredSendOutcomeSchema,
    valid: { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "pm-1" }] },
    malformed: { status: "sent", retryable: false, parts: [] },
  },
  {
    what: "tavi_mcp_tools.observed_def_json",
    schema: StoredMcpToolDefinitionSchema,
    valid: { name: "search", inputSchema: { type: "object" } },
    malformed: { inputSchema: {} },
  },
  {
    what: "tavi_heartbeat_items.sources_json",
    schema: HeartbeatItemSchema.shape.sources,
    valid: [{ label: "Inbox", ref: "mail:1" }],
    malformed: [{ ref: "mail:1" }],
  },
  {
    what: "tavi_heartbeat_items.proposed_action_json",
    schema: HeartbeatProposedActionSchema,
    valid: { toolId: "mail.reply", input: { to: "a" }, summary: "Reply" },
    malformed: { toolId: "mail.reply", input: {} },
  },
  { what: "tavi_routine_runs.data_json", schema: StoredRoutineRunDataSchema, valid: runData, malformed: { ...runData, modelCalls: "0" } },
  {
    what: "tavi_routine_delivery_jobs.data_json",
    schema: StoredDeliveryDataSchema,
    valid: deliveryData,
    malformed: { ...deliveryData, generation: null },
  },
];

describe("parseJsonColumn", () => {
  it.each(cases)("reads a valid $what as stored", ({ what, schema, valid }) => {
    expect(parseJsonColumn(schema, JSON.stringify(valid), what)).toEqual(valid);
  });

  it.each(cases)("refuses a malformed $what, naming the column", ({ what, schema, malformed }) => {
    const error = thrown(() => parseJsonColumn(schema, JSON.stringify(malformed), what));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain(`${what} holds a malformed record`);
    expect(error.details).toMatchObject({ column: what });
    for (const value of [null, [], 42, "text"]) expect(() => parseJsonColumn(schema, JSON.stringify(value), what)).toThrow(what);
  });

  it("refuses text that is not JSON, naming the column", () => {
    const error = thrown(() => parseJsonColumn(StoredInboundEventSchema, "{not json", "tavi_messaging_inbox.payload_json"));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toMatch(/^tavi_messaging_inbox\.payload_json holds invalid JSON/);
  });

  it("quotes no fragment of the stored text in the invalid-JSON error", () => {
    // V8's SyntaxError quotes the first characters of the input: none may surface.
    const stored = "sk-live-QzX9wV7k0123456789";
    const error = thrown(() => parseJsonColumn(StoredInboundEventSchema, stored, "tavi_messaging_inbox.payload_json"));
    expect(error.message).toBe("tavi_messaging_inbox.payload_json holds invalid JSON");
    const surfaced = `${error.message} ${JSON.stringify(error.details)}`;
    for (let start = 0; start + 4 <= stored.length; start += 1) expect(surfaced).not.toContain(stored.slice(start, start + 4));
  });
});

describe("a corrupt messaging row", () => {
  function fixture(): SqliteStore {
    const directory = directories.create("tavi-json-column-");
    return new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  }

  it("fails the inbox read loudly, but stays listed among the held", () => {
    const store = fixture();
    const inbox = store.asPort().repositories.messagingInbox;
    inbox.record({ connectionId: "conn-1", providerEventId: "evt-1", kind: "message", payload: event, now: () => AT });
    store.handle.prepare("UPDATE tavi_messaging_inbox SET payload_json = 'null'").run();
    expect(() => inbox.get("conn-1", "evt-1")).toThrow(/tavi_messaging_inbox\.payload_json holds a malformed record/);
    expect(inbox.listHeld({ limit: 10 }).total).toBe(1);
    store.close();
  });

  it("fails the outbox reads loudly", () => {
    const store = fixture();
    const outbox = store.asPort().repositories.messagingOutbox;
    outbox.begin({
      effectId: "eff-1",
      connectionId: "conn-1",
      message: { effectId: "eff-1", connectionId: "conn-1", destination: {}, parts: [{ content: "hi" }] },
      now: () => AT,
    });
    store.handle.prepare("UPDATE tavi_messaging_outbox SET message_json = '[]'").run();
    expect(() => outbox.listPending(10)).toThrow(/tavi_messaging_outbox\.message_json/);
    store.handle.prepare(`UPDATE tavi_messaging_outbox SET state = 'resolved', outcome_json = '{"status":1}'`).run();
    expect(() => outbox.get("eff-1")).toThrow(/tavi_messaging_outbox\.outcome_json/);
    store.close();
  });

  it("refuses a malformed send outcome when it is written, leaving the row pending", () => {
    const store = fixture();
    const outbox = store.asPort().repositories.messagingOutbox;
    outbox.begin({
      effectId: "eff-1",
      connectionId: "conn-1",
      message: { effectId: "eff-1", connectionId: "conn-1", destination: {}, parts: [{ content: "hi" }] },
      now: () => AT,
    });
    // An external connector's outcome, missing `retryable` and a part's `index`.
    const outcome = { status: "accepted", parts: [{ status: "accepted", providerMessageId: "pm-1" }] } as unknown as SendOutcome;
    const error = thrown(() => outbox.resolve({ effectId: "eff-1", outcome, now: () => AT }));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toMatch(/^Connection conn-1 returned a malformed send outcome/);
    expect(error.details).toMatchObject({ effectId: "eff-1", connectionId: "conn-1" });
    expect(outbox.get("eff-1")).toMatchObject({ state: "pending" });
    store.close();
  });
});
