import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseClient } from "../src/persistence/client.js";
import { createMessagingService } from "../src/messaging/service.js";
import { TaviError, type SendOutcome } from "@tavi/contracts";
const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
it("rechecks a revoked grant after waiting for the outbox claim", async () => {
  const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  clients.push(db);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const begin = db.repositories.messagingOutbox.begin;
  vi.spyOn(db.repositories.messagingOutbox, "begin").mockImplementation(async (input) => {
    const result = await begin(input);
    entered.resolve();
    await release.promise;
    return result;
  });
  let granted = true;
  const send = vi.fn(async (): Promise<SendOutcome> => ({ status: "accepted", retryable: false, parts: [] }));
  const service = createMessagingService(db, { hasGrant: () => granted });
  service.registerConnector({
    providerId: "fixture",
    version: "1",
    configSchema: z.unknown(),
    capabilities: {
      receiveMode: "none",
      send: true,
      editOrProgress: false,
      formats: ["text"],
      attachments: false,
      maxAttachmentBytes: 0,
      maxPartsPerMessage: 1,
      threads: false,
      interactions: false,
      deliveryReceipts: false,
      maxTextLength: 4096,
      approvals: "none",
    },
    createConnection: () => ({
      start: async () => {},
      stop: async () => {},
      send,
      status: () => ({ state: "running", since: "2026-09-28T00:00:00.000Z" }),
      probe: async () => ({ ok: true }),
    }),
  });
  await service.openConnection({
    connection: {
      connectionId: "connection",
      providerId: "fixture",
      accountIdentity: "fixture",
      workspaceId: "w",
      configRevision: 1,
      enabled: true,
    },
    config: {},
  });
  const pending = service.send({
    effectId: "effect",
    connectionId: "connection",
    workspaceId: "w",
    destination: { chatId: "chat" },
    parts: [{ content: "hello" }],
  });
  await entered.promise;
  granted = false;
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  expect(send).not.toHaveBeenCalled();
  expect(await db.repositories.messagingOutbox.get("effect")).toMatchObject({
    state: "resolved",
    outcome: { status: "rejected", retryable: false },
  });
  await service.closeConnection("connection");
});
it("records a connector's refusal before dispatch as rejected, and leaves any other throw pending", async () => {
  const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  clients.push(db);
  const failures = [
    new TaviError("UNAVAILABLE", "connection is not running"),
    new TaviError("INVALID_INPUT", "destination is invalid"),
    new Error("socket hang up"),
  ];
  const service = createMessagingService(db, {});
  service.registerConnector({
    providerId: "fixture",
    version: "1",
    configSchema: z.unknown(),
    capabilities: {
      receiveMode: "none",
      send: true,
      editOrProgress: false,
      formats: ["text"],
      attachments: false,
      maxAttachmentBytes: 0,
      maxPartsPerMessage: 1,
      threads: false,
      interactions: false,
      deliveryReceipts: false,
      maxTextLength: 4096,
      approvals: "none",
    },
    createConnection: () => ({
      start: async () => {},
      stop: async () => {},
      send: async () => {
        throw failures.shift();
      },
      status: () => ({ state: "running", since: "2026-09-28T00:00:00.000Z" }),
      probe: async () => ({ ok: true }),
    }),
  });
  await service.openConnection({
    connection: {
      connectionId: "connection",
      providerId: "fixture",
      accountIdentity: "fixture",
      workspaceId: "w",
      configRevision: 1,
      enabled: true,
    },
    config: {},
  });
  const send = (effectId: string) =>
    service.send({
      effectId,
      connectionId: "connection",
      workspaceId: "w",
      destination: { chatId: "chat" },
      parts: [{ content: "hello" }],
    });
  await expect(send("down")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(send("invalid")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(send("unknown")).rejects.toThrow("socket hang up");
  expect(await db.repositories.messagingOutbox.get("down")).toMatchObject({
    state: "resolved",
    outcome: { status: "rejected", retryable: true },
  });
  expect(await db.repositories.messagingOutbox.get("invalid")).toMatchObject({
    state: "resolved",
    outcome: { status: "rejected", retryable: false },
  });
  expect(await db.repositories.messagingOutbox.get("unknown")).toMatchObject({ state: "pending" });
  // The same effect again is told what happened, and sends nothing twice.
  expect(await send("down")).toMatchObject({ status: "rejected" });
  expect(await send("unknown")).toMatchObject({ status: "uncertain" });
  await service.closeConnection("connection");
});
