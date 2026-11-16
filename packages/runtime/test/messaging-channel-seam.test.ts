import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaviError, type InboundEvent, type MessagingCapabilities, type MessagingCredentials } from "@tavi/contracts";

import { DatabaseClient } from "../src/persistence/client.js";
import { createMessagingService } from "../src/messaging/service.js";

/** The channel seam the messaging service gives a connector. */

const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

const capabilities: MessagingCapabilities = {
  receiveMode: "none",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: false,
  interactions: false,
  deliveryReceipts: false,
  maxTextLength: 4096,
  approvals: "none",
};

describe("the channel seam", () => {
  it("resolves a connection's secrets by field, never an unlisted one, and has no OAuth token yet", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const secrets: Record<string, string> = { "channels.c1.token": "s3cret", "channels.other.token": "not-yours" };
    let credentials: MessagingCredentials | undefined;
    const service = createMessagingService(db, { readSecret: async (reference) => secrets[reference] ?? null });
    service.registerConnector({
      providerId: "example",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: (input) => {
        credentials = input.credentials;
        return {
          start: async () => {},
          stop: async () => {},
          status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
          probe: async () => ({ ok: true }),
          send: async () => ({ status: "accepted", retryable: false, parts: [] }),
        };
      },
      destinationFor: (target, connection) => ({ chat: target.to, account: connection.accountIdentity }),
    });
    await service.openConnection({
      connection: {
        connectionId: "c1",
        providerId: "example",
        accountIdentity: "bot",
        workspaceId: "w1",
        configRevision: 1,
        credentialRefs: { token: "channels.c1.token" },
        enabled: true,
      },
      config: {},
    });
    expect(await credentials?.get("token")).toBe("s3cret");
    expect(await credentials?.get("other")).toBeNull();
    await expect(credentials?.accessToken()).rejects.toBeInstanceOf(TaviError);
    expect(service.buildDestination("c1", { to: "42" })).toEqual({ chat: "42", account: "bot" });
    expect(service.buildDestination("not-open", { to: "42" })).toBeUndefined();
  });

  it("reads a sender as its channel writes one, and takes a message with no proof on a per-message channel as unverified", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const admitted: string[] = [];
    const service = createMessagingService(db, {
      admit: async ({ event }) => void admitted.push(event.providerEventId),
      senderOf: () => ({ normalize: "lowercase", authentication: "per-message" }),
    });
    service.registerConnector({
      providerId: "mail",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    await service.openConnection({
      connection: { connectionId: "m1", providerId: "mail", accountIdentity: "box", workspaceId: "w1", configRevision: 1, enabled: true },
      config: {},
    });
    await db.repositories.messagingIdentityBindings.bind({
      connectionId: "m1",
      externalSenderId: "ana@example.com",
      workspaceId: "w1",
      principalId: "operator",
      approvedBy: "operator",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    const mail = (id: string, senderAuthentication?: "pass" | "fail") => ({
      connectionId: "m1",
      providerEventId: id,
      kind: "message" as const,
      externalSenderId: "Ana@Example.COM",
      externalConversationId: "t",
      occurredAt: "2026-10-09T00:00:00.000Z",
      receivedAt: "2026-10-09T00:00:00.000Z",
      content: "hi",
      ...(senderAuthentication === undefined ? {} : { senderAuthentication }),
    });
    // A forged From with no verdict at all is held, as an unverified one is.
    expect(await service.ingest(mail("e1"))).toMatchObject({ unverified: true });
    // A verified one is the bound person's, however the address is cased.
    expect(await service.ingest(mail("e2", "pass"))).toMatchObject({ resolvedPrincipalId: "operator" });
    expect(admitted).toEqual(["e2"]);
  });

  it("gives a message a trigger takes to the trigger alone: done with, never admitted, and a redelivery admits nothing", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const admitted: string[] = [];
    const offered: { readonly id: string; readonly sender: string; readonly authentication?: string }[] = [];
    const service = createMessagingService(db, {
      admit: async ({ event }) => void admitted.push(event.providerEventId),
      senderOf: () => ({ normalize: "lowercase", authentication: "per-message" }),
      takeMessage: async (event) => {
        offered.push({
          id: event.providerEventId,
          sender: event.externalSenderId,
          ...(event.senderAuthentication === undefined ? {} : { authentication: event.senderAuthentication }),
        });
        if (event.providerEventId === "boom") throw new Error("the trigger broke");
        return event.content === "for the trigger" ? { fire: async () => {} } : undefined;
      },
    });
    service.registerConnector({
      providerId: "mail",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    await service.openConnection({
      connection: { connectionId: "m1", providerId: "mail", accountIdentity: "box", workspaceId: "w1", configRevision: 1, enabled: true },
      config: {},
    });
    await db.repositories.messagingIdentityBindings.bind({
      connectionId: "m1",
      externalSenderId: "ana@example.com",
      workspaceId: "w1",
      principalId: "operator",
      approvedBy: "operator",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    const mail = (id: string, content: string, senderAuthentication?: "pass" | "fail") => ({
      connectionId: "m1",
      providerEventId: id,
      kind: "message" as const,
      externalSenderId: "Ana@Example.COM",
      externalConversationId: "t",
      occurredAt: "2026-10-09T00:00:00.000Z",
      receivedAt: "2026-10-09T00:00:00.000Z",
      content,
      ...(senderAuthentication === undefined ? {} : { senderAuthentication }),
    });
    // Taken: recorded and done with, not a conversation's turn.
    expect(await service.ingest(mail("e1", "for the trigger", "pass"))).toMatchObject({ accepted: true, duplicate: false });
    expect(admitted).toEqual([]);
    expect((await db.repositories.messagingInbox.get("m1", "e1"))?.state).toBe("processed");
    // Offered as its channel reads it: the sender normalised, a message with no proof unverified.
    expect(offered[0]).toEqual({ id: "e1", sender: "ana@example.com", authentication: "pass" });
    await service.ingest(mail("e0", "not for it"));
    expect(offered[1]).toEqual({ id: "e0", sender: "ana@example.com", authentication: "fail" });
    // A redelivery is neither offered again nor admitted.
    expect(await service.ingest(mail("e1", "for the trigger", "pass"))).toMatchObject({ duplicate: true });
    expect(offered.filter((entry) => entry.id === "e1")).toHaveLength(1);
    expect(admitted).toEqual([]);
    // Not taken, or a trigger that throws: the message goes on as any other.
    await service.ingest(mail("e2", "hello", "pass"));
    await service.ingest(mail("boom", "hello again", "pass"));
    expect(admitted).toEqual(["e2", "boom"]);
  });

  it("holds a message a trigger is deciding on, and is done with it before the trigger's fire: a redelivery meanwhile or after a restart admits nothing", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const admitted: string[] = [];
    let decide: (() => void) | undefined;
    const fired: string[] = [];
    // The fire's admission never ends here: as a slow one, or a process that died while it ran.
    const takeMessage = async (event: InboundEvent) => {
      if (event.providerEventId === "slow") await new Promise<void>((resolve) => (decide = resolve));
      return {
        fire: () => {
          fired.push(event.providerEventId);
          return new Promise<void>(() => undefined);
        },
      };
    };
    const open = async () => {
      const service = createMessagingService(db, {
        admit: async ({ event }) => void admitted.push(event.providerEventId),
        senderOf: () => ({ normalize: "lowercase", authentication: "per-message" }),
        takeMessage,
      });
      service.registerConnector({
        providerId: "mail",
        version: "1",
        configSchema: z.unknown(),
        capabilities,
        createConnection: () => ({
          start: async () => {},
          stop: async () => {},
          status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
          probe: async () => ({ ok: true }),
          send: async () => ({ status: "accepted", retryable: false, parts: [] }),
        }),
      });
      await service.openConnection({
        connection: { connectionId: "m1", providerId: "mail", accountIdentity: "box", workspaceId: "w1", configRevision: 1, enabled: true },
        config: {},
      });
      return service;
    };
    const service = await open();
    await db.repositories.messagingIdentityBindings.bind({
      connectionId: "m1",
      externalSenderId: "ana@example.com",
      workspaceId: "w1",
      principalId: "operator",
      approvedBy: "operator",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    const mail = (id: string) => ({
      connectionId: "m1",
      providerEventId: id,
      kind: "message" as const,
      externalSenderId: "ana@example.com",
      externalConversationId: "t",
      occurredAt: "2026-10-09T00:00:00.000Z",
      receivedAt: "2026-10-09T00:00:00.000Z",
      content: "for the trigger",
      senderAuthentication: "pass" as const,
    });
    // Redelivered while the trigger is still deciding: held for it, never admitted as a conversation's.
    const first = service.ingest(mail("slow"));
    await vi.waitFor(() => expect(decide).toBeDefined());
    expect(await service.ingest(mail("slow"))).toMatchObject({ duplicate: true });
    expect(admitted).toEqual([]);
    decide?.();
    // Answered once it is done with, though the fire it started has not ended.
    expect(await first).toMatchObject({ duplicate: false });
    expect((await db.repositories.messagingInbox.get("m1", "slow"))?.state).toBe("processed");
    await vi.waitFor(() => expect(fired).toEqual(["slow"]));
    // Done with before the fire: a redelivery while it runs, or after a restart, admits nothing.
    expect(await service.ingest(mail("fast"))).toMatchObject({ duplicate: false });
    expect(await service.ingest(mail("fast"))).toMatchObject({ duplicate: true });
    const restarted = await open();
    expect(await restarted.ingest(mail("fast"))).toMatchObject({ duplicate: true });
    expect(admitted).toEqual([]);
  });

  it("closes a connection whose stop() fails, so it opens again, and withdraws its channel all the same", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const service = createMessagingService(db);
    service.registerConnector({
      providerId: "flaky",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {
          throw new Error("stop failed");
        },
        status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    const connection = {
      connectionId: "f1",
      providerId: "flaky",
      accountIdentity: "x",
      workspaceId: "w1",
      configRevision: 1,
      enabled: true,
    };
    await service.openConnection({ connection, config: {} });
    await expect(service.closeConnection("f1", { reopening: true })).rejects.toThrow("stop failed");
    await service.openConnection({ connection, config: {} });
    await expect(service.unregisterConnector("flaky")).rejects.toThrow("stop failed");
    await expect(service.openConnection({ connection, config: {} })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
