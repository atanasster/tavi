import type { InboundEvent, MessagingConnection, OutboundMessage } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "../src/messaging.js";

const connection: MessagingConnection = {
  connectionId: "conn-1",
  providerId: "fixture",
  accountIdentity: "@fixture",
  workspaceId: "default",
  configRevision: 1,
  credentialRef: "fixture.token",
  enabled: true,
};
const message: OutboundMessage = {
  effectId: "e1",
  connectionId: "conn-1",
  destination: { chatId: "c1" },
  parts: [{ content: "hello" }, { content: "again" }],
};

function open(options: Parameters<typeof createFixtureMessagingConnectorDefinition>[0] = {}): FixtureMessagingConnectorInstance {
  let created: FixtureMessagingConnectorInstance | undefined;
  const definition = createFixtureMessagingConnectorDefinition({ ...options, onInstanceCreated: (instance) => (created = instance) });
  definition.createConnection({ connection, config: {}, credentials: { get: async () => null, accessToken: async () => "" } });
  if (created === undefined) throw new Error("no instance");
  return created;
}

describe("the fixture messaging connector", () => {
  it("sends only once started, accepting every part and recording each message", async () => {
    const instance = open();
    await expect(instance.send(message)).rejects.toThrow("fixture connector is not running");
    await instance.start();
    expect(instance.status().state).toBe("running");
    expect(await instance.send(message)).toEqual({
      status: "accepted",
      retryable: false,
      parts: [
        { index: 0, status: "accepted", providerMessageId: "pm-e1-0" },
        { index: 1, status: "accepted", providerMessageId: "pm-e1-1" },
      ],
    });
    expect(instance.sent).toEqual([message]);
  });

  it("answers a send as scripted, and delivers inbound events to the registered handler", async () => {
    const instance = open({ sendOutcome: () => ({ status: "rejected", retryable: true, parts: [] }) });
    await instance.start();
    expect((await instance.send(message)).status).toBe("rejected");
    const seen: InboundEvent[] = [];
    const event = { connectionId: "conn-1", providerEventId: "evt-1", kind: "message" } as InboundEvent;
    await instance.deliverInbound(event);
    instance.onInboundEvent?.(async (next) => void seen.push(next));
    await instance.deliverInbound(event);
    expect(seen).toEqual([event]);
  });

  it("declares its capabilities and a destination for a target", () => {
    const definition = createFixtureMessagingConnectorDefinition({ providerId: "other", capabilities: { attachments: true } });
    expect(definition.providerId).toBe("other");
    expect(definition.capabilities.attachments).toBe(true);
    expect(definition.capabilities.send).toBe(true);
    expect(definition.destinationFor?.({ to: "c9", threadId: "t1" } as never, connection)).toEqual({ chatId: "c9", threadId: "t1" });
  });
});
