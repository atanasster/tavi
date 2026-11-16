import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { TaviError, type MessagingCapabilities, type OutboundMessage } from "@tavi/contracts";

import { DatabaseClient } from "../src/persistence/client.js";
import { createMessagingService } from "../src/messaging/service.js";
import { splitMessage, splitText } from "../src/messaging/split-text.js";

/** Text over a channel's limit goes out as several messages. */

describe("splitText", () => {
  it("cuts at the last paragraph, line, sentence or word that fits, never mid-word when it can help it", () => {
    expect(splitText("short", 10)).toEqual(["short"]);
    expect(splitText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(splitText("First para.\n\nSecond one here.", 20)).toEqual(["First para.", "Second one here."]);
    expect(splitText("A sentence. Another sentence.", 15)).toEqual(["A sentence.", "Another", "sentence."]);
    expect(splitText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    for (const piece of splitText("word ".repeat(400), 64)) expect(piece.length).toBeLessThanOrEqual(64);
    // A cut with no boundary never splits an emoji in two.
    expect(splitText(`${"x".repeat(9)}😀tail`, 10)).toEqual(["x".repeat(9), "😀tail"]);
  });

  it("splits only a single text part, keeping the subject on each piece, a reply-to on the first and buttons on the last", () => {
    const message: OutboundMessage = {
      effectId: "e",
      connectionId: "c",
      destination: {},
      subject: "S",
      replyToId: "r",
      buttons: [[{ label: "OK", data: "ok" }]],
      parts: [{ content: "aaaa bbbb cccc" }],
    };
    const pieces = splitMessage(message, 5);
    expect(pieces.map((piece) => piece.effectId)).toEqual(["e#1", "e#2", "e#3"]);
    expect(pieces.map((piece) => piece.subject)).toEqual(["S", "S", "S"]);
    expect(pieces.map((piece) => piece.replyToId)).toEqual(["r", undefined, undefined]);
    expect(pieces.map((piece) => piece.buttons)).toEqual([undefined, undefined, message.buttons]);
    expect(splitMessage({ ...message, parts: [{ kind: "file", artifactId: "a" }] }, 5)).toHaveLength(1);
  });
});

describe("MessagingService.send", () => {
  const clients: DatabaseClient[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
  });

  it("sends text over the channel's limit as several messages, one outbox effect each, and answers a retry from the outbox", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const sent: string[] = [];
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
      maxTextLength: 10,
      approvals: "none",
    };
    const service = createMessagingService(db);
    service.registerConnector({
      providerId: "short",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
        probe: async () => ({ ok: true }),
        send: async (message) => {
          const text = (message.parts[0] as { content: string }).content;
          sent.push(text);
          return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: `m${sent.length}` }] };
        },
      }),
    });
    await service.openConnection({
      connection: { connectionId: "c1", providerId: "short", accountIdentity: "a", workspaceId: "w", configRevision: 1, enabled: true },
      config: {},
    });
    const message: OutboundMessage = {
      effectId: "fx",
      connectionId: "c1",
      destination: {},
      parts: [{ content: "alpha beta gamma delta" }],
    };
    const outcome = await service.send(message);
    expect(sent).toEqual(["alpha beta", "gamma", "delta"]);
    expect(outcome).toEqual({
      status: "accepted",
      retryable: false,
      parts: [
        { index: 0, status: "accepted", providerMessageId: "m1" },
        { index: 1, status: "accepted", providerMessageId: "m2" },
        { index: 2, status: "accepted", providerMessageId: "m3" },
      ],
    });
    expect(await service.send(message)).toEqual(outcome);
    expect(sent).toHaveLength(3);
    // The message's own effect holds the pieces' combined outcome, as a reader of the outbox by its id sees it.
    expect((await db.repositories.messagingOutbox.get("fx"))?.outcome).toEqual(outcome);
  });

  it("stops at a refused or failing piece: a later one makes the whole uncertain, never a throw that would resend the first", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    let mode: "refuse" | "throw" = "refuse";
    let calls = 0;
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
      maxTextLength: 10,
      approvals: "none",
    };
    const service = createMessagingService(db);
    service.registerConnector({
      providerId: "flaky",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
        probe: async () => ({ ok: true }),
        send: async () => {
          calls += 1;
          if (calls === 1)
            return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m1" }] };
          if (mode === "throw") throw new Error("socket closed");
          return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "too fast" }] };
        },
      }),
    });
    await service.openConnection({
      connection: { connectionId: "c1", providerId: "flaky", accountIdentity: "a", workspaceId: "w", configRevision: 1, enabled: true },
      config: {},
    });
    const refused = await service.send({ effectId: "fx-1", connectionId: "c1", destination: {}, parts: [{ content: "alpha beta gamma" }] });
    expect(refused.status).toBe("uncertain");
    expect(refused.parts.map((receipt) => receipt.status)).toEqual(["accepted", "rejected"]);
    calls = 0;
    mode = "throw";
    const thrown = await service.send({ effectId: "fx-2", connectionId: "c1", destination: {}, parts: [{ content: "alpha beta gamma" }] });
    expect(thrown).toMatchObject({ status: "uncertain", parts: [{ status: "accepted", providerMessageId: "m1" }] });
    // Its first piece refused before it went out: the message is not sent either, never left pending.
    service.registerConnector({
      providerId: "down",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: "2026-10-09T00:00:00.000Z" }),
        probe: async () => ({ ok: true }),
        send: async () => {
          throw new TaviError("UNAVAILABLE", "not running");
        },
      }),
    });
    await service.openConnection({
      connection: { connectionId: "d1", providerId: "down", accountIdentity: "a", workspaceId: "w", configRevision: 1, enabled: true },
      config: {},
    });
    await expect(
      service.send({ effectId: "fx-3", connectionId: "d1", destination: {}, parts: [{ content: "alpha beta gamma" }] }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await db.repositories.messagingOutbox.get("fx-3")).toMatchObject({
      state: "resolved",
      outcome: { status: "rejected", retryable: true },
    });
  });
});
