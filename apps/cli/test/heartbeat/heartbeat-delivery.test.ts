import {
  defaultHeartbeatConfig,
  type HeartbeatState,
  type MessagingCapabilities,
  type MessagingConnectionRecord,
  type OutboundMessage,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createHeartbeatDelivery } from "../../src/features/heartbeat/delivery.js";

/**
 * Where a heartbeat's words go in an owner:
 * Home through the chat notices, targets through the messaging service, and
 * a target that cannot be reached now skipped and logged.
 */

const AT = "2026-10-11T09:00:00.000Z";
const state: HeartbeatState = {
  workspaceId: "default",
  principalId: "alice",
  config: { ...defaultHeartbeatConfig(), enabled: true },
  createdAt: AT,
  updatedAt: AT,
};

function connection(connectionId: string, extra: Partial<MessagingConnectionRecord> = {}): MessagingConnectionRecord {
  return {
    connectionId,
    workspaceId: "default",
    providerId: "acme.chat",
    label: connectionId,
    enabled: true,
    authState: "ok",
    configRevision: 1,
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  } as MessagingConnectionRecord;
}

function owner(options: { connections: MessagingConnectionRecord[]; open?: string[]; editable?: string[]; home?: boolean }) {
  const sent: OutboundMessage[] = [];
  const edited: { connectionId: string; messageId: string; text: string }[] = [];
  const notices: { sourceKey: string; title: string; summary: string; heartbeatItemId?: string }[] = [];
  const logged: string[] = [];
  const capabilities = (connectionId: string): MessagingCapabilities | undefined =>
    (options.open ?? options.connections.map((entry) => entry.connectionId)).includes(connectionId)
      ? ({ editOrProgress: (options.editable ?? []).includes(connectionId) } as MessagingCapabilities)
      : undefined;
  const port = createHeartbeatDelivery({
    notices: {
      postHeartbeat: async (input) => {
        notices.push(input);
        return options.home ?? true;
      },
    },
    messaging: {
      send: async (message) => {
        sent.push(message);
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: `m-${sent.length}` }] };
      },
      buildDestination: (connectionId, target) => ({ connectionId, chat: target.to }),
      capabilitiesOf: capabilities,
      editMessage: async (connectionId, input) => {
        edited.push({ connectionId, messageId: input.messageId, text: input.text });
        return true;
      },
    },
    connections: { get: async (connectionId) => options.connections.find((entry) => entry.connectionId === connectionId) },
    outbox: {
      get: async (effectId) =>
        effectId === "sent-before"
          ? {
              state: "resolved",
              outcome: { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m-42" }] },
            }
          : undefined,
    },
    log: (message, fields) => {
      logged.push(`${message}: ${String(fields["reason"])}`);
    },
  });
  return { port, sent, edited, notices, logged };
}

describe("a heartbeat's delivery in an owner", () => {
  it("posts into Home, and says when there is no Home", async () => {
    const on = owner({ connections: [] });
    expect(
      await on.port.notify(state, {
        sourceKey: "heartbeat:item:hbi-1",
        heartbeatItemId: "hbi-1",
        title: "A payment failed",
        summary: "Billing",
      }),
    ).toBe(true);
    expect(on.notices).toEqual([
      {
        workspaceId: "default",
        principalId: "alice",
        sourceKey: "heartbeat:item:hbi-1",
        heartbeatItemId: "hbi-1",
        title: "A payment failed",
        summary: "Billing",
      },
    ]);
    expect(await owner({ connections: [], home: false }).port.notify(state, { sourceKey: "k", title: "t", summary: "s" })).toBe(false);
  });

  it("sends to a target through the messaging service, under the heartbeat's effect id and workspace", async () => {
    const run = owner({ connections: [connection("chat-a")] });
    expect(
      await run.port.send(
        state,
        { connectionId: "chat-a", to: "100" },
        { effectId: "heartbeat:e1", text: "A payment failed", subject: "A payment failed" },
      ),
    ).toBe("accepted");
    expect(run.sent[0]).toMatchObject({
      effectId: "heartbeat:e1",
      connectionId: "chat-a",
      workspaceId: "default",
      destination: { connectionId: "chat-a", chat: "100" },
      subject: "A payment failed",
      parts: [{ content: "A payment failed" }],
    });
  });

  it("skips and logs a target whose connection was removed, is another workspace's, needs signing in, or is not open", async () => {
    const run = owner({
      connections: [
        connection("gone", { deletedAt: AT }),
        connection("theirs", { workspaceId: "other" }),
        connection("expired", { authState: "expired" }),
        connection("closed"),
      ],
      open: ["gone", "theirs", "expired"],
    });
    for (const connectionId of ["gone", "theirs", "expired", "closed", "unknown"]) {
      expect(await run.port.send(state, { connectionId, to: "1" }, { effectId: `e-${connectionId}`, text: "t", subject: "s" })).toBe(
        "skipped",
      );
    }
    expect(run.sent).toEqual([]);
    expect(run.logged).toHaveLength(5);
  });

  it("edits a sent message only where its channel can edit and the send was accepted", async () => {
    const run = owner({ connections: [connection("chat-a"), connection("mail")], editable: ["chat-a"] });
    expect(await run.port.edit(state, { connectionId: "chat-a", to: "100" }, { effectId: "sent-before", text: "Resolved" })).toBe(true);
    expect(run.edited).toEqual([{ connectionId: "chat-a", messageId: "m-42", text: "Resolved" }]);
    expect(await run.port.edit(state, { connectionId: "mail", to: "a@b" }, { effectId: "sent-before", text: "Resolved" })).toBe(false);
    expect(await run.port.edit(state, { connectionId: "chat-a", to: "100" }, { effectId: "never-sent", text: "Resolved" })).toBe(false);
    expect(run.edited).toHaveLength(1);
  });
});
