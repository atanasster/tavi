import type { InboundEvent, MessagingIngestHooks, MessagingIngestReceipt } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createLocalConnectorDefinition, isLocalConnectionId, localConnectionId, type LocalConnectorInstance } from "../src/connector.js";

/** The local connection, on its own. */

const connection = {
  connectionId: "local-default",
  providerId: "local",
  accountIdentity: "local",
  workspaceId: "default",
  configRevision: 1,
  enabled: true,
} as const;

function open(): { instance: LocalConnectorInstance; created: string[] } {
  const created: string[] = [];
  let kept: LocalConnectorInstance | undefined;
  const definition = createLocalConnectorDefinition({
    onInstanceCreated: (connectionId, instance) => {
      created.push(connectionId);
      kept = instance;
    },
  });
  definition.createConnection({ connection, config: {}, credentials: { get: async () => null, accessToken: async () => "" } });
  if (kept === undefined) throw new Error("no instance");
  return { instance: kept, created };
}

const inbound = (overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  connectionId: "local-default",
  providerEventId: "message-1",
  kind: "message",
  externalSenderId: "operator",
  externalConversationId: "op-run-1",
  externalMessageId: "message-1",
  occurredAt: "2026-09-19T00:00:00.000Z",
  receivedAt: "2026-09-19T00:00:00.000Z",
  content: "acme",
  ...overrides,
});

describe("the local connector", () => {
  it("names one connection per workspace, and is received locally, never polled", () => {
    const definition = createLocalConnectorDefinition();
    expect(definition.providerId).toBe("local");
    expect(definition.capabilities.receiveMode).toBe("local");
    expect(localConnectionId("team")).toBe("local-team");
    expect(isLocalConnectionId("local-team")).toBe(true);
    expect(isLocalConnectionId("telegram-team")).toBe(false);
    // `ask_user` replies into the conversation the inbound message came from.
    expect(definition.destinationFromInbound?.({ externalConversationId: "op-run-1", externalSenderId: "operator" }, connection)).toEqual({
      conversationId: "op-run-1",
    });
  });

  it("accepts what it is sent — the service's outbox record is the delivery — and refuses a destination that is not a conversation", async () => {
    const { instance } = open();
    await instance.start();
    const outcome = await instance.send({
      effectId: "ask:wait-1",
      connectionId: "local-default",
      workspaceId: "default",
      destination: { conversationId: "op-run-1" },
      parts: [{ content: "Which one?" }, { content: "acme or globex" }],
    });
    expect(outcome).toEqual({
      status: "accepted",
      retryable: false,
      parts: [
        { index: 0, status: "accepted" },
        { index: 1, status: "accepted" },
      ],
    });
    await expect(
      instance.send({
        effectId: "e",
        connectionId: "local-default",
        workspaceId: "default",
        destination: { chatId: "42" },
        parts: [{ content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("hands a message to the service's handler with its hooks, and answers its receipt", async () => {
    const { instance, created } = open();
    expect(created).toEqual(["local-default"]);
    await expect(instance.deliver(inbound())).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const seen: { event: InboundEvent; hooks: MessagingIngestHooks | undefined }[] = [];
    instance.onInboundEvent?.(async (event, hooks) => {
      seen.push({ event, hooks });
      const receipt: MessagingIngestReceipt = { accepted: true, duplicate: false, resolvedPrincipalId: "operator" };
      hooks?.onRecorded?.(receipt);
      return receipt;
    });
    await instance.start();
    const recorded: MessagingIngestReceipt[] = [];
    const receipt = await instance.deliver(inbound(), {
      onRecorded: (answer) => {
        recorded.push(answer);
      },
    });
    expect(receipt).toEqual({ accepted: true, duplicate: false, resolvedPrincipalId: "operator" });
    expect(recorded).toEqual([receipt]);
    expect(seen[0]?.event.content).toBe("acme");
    // Only its own connection's events.
    await expect(instance.deliver(inbound({ connectionId: "local-other" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await instance.stop();
    expect(instance.status().state).toBe("stopped");
    await expect(instance.deliver(inbound())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
