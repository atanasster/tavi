import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { MessagingCapabilities, MessagingConnectorInstance, OutboundMessage, SendOutcome } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

import { createMessagingService } from "../src/messaging/service.js";
import { DatabaseClient } from "../src/persistence/client.js";

/**
 * The messaging service's group features: refused for a connection that is not
 * open, for a caller of another workspace and for a connector without the
 * feature; a post paced as a send is, and recorded as one.
 */

const AT = "2026-10-18T08:00:00.000Z";
const CAPABILITIES: MessagingCapabilities = {
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
  maxTextLength: 2000,
  approvals: "none",
};

const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function open(
  instance: Partial<MessagingConnectorInstance>,
  options: { readonly hasGrant?: (message: OutboundMessage) => boolean; readonly capabilities?: MessagingCapabilities } = {},
) {
  const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  clients.push(db);
  const messaging = createMessagingService(db, {
    now: () => AT,
    ...(options.hasGrant === undefined ? {} : { hasGrant: options.hasGrant }),
  });
  messaging.registerConnector({
    providerId: "parrot",
    version: "1.0.0",
    configSchema: z.object({}).passthrough(),
    capabilities: options.capabilities ?? CAPABILITIES,
    destinationFromInbound: (replyTo) => ({ room: replyTo.externalConversationId }),
    directDestinationOf: (sender) => ({ dm: sender }),
    createConnection: () => ({
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ state: "running", since: AT }),
      probe: async () => ({ ok: true }),
      send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      ...instance,
    }),
  });
  await messaging.openConnection({
    connection: {
      connectionId: "conn-1",
      providerId: "parrot",
      accountIdentity: "bot",
      workspaceId: "default",
      configRevision: 1,
      enabled: true,
    },
    config: {},
  });
  return messaging;
}

const poll = { effectId: "e1", destination: { room: "r" }, question: "q?", answers: ["a", "b"], hours: 1, multiSelect: false };

describe("the group features of a connection", () => {
  it("are refused for a connection not open, another workspace's caller and a connector without them", async () => {
    const messaging = await open({});
    await expect(messaging.createPoll?.("conn-9", "default", poll)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(messaging.createPoll?.("conn-1", "other", poll)).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(messaging.createPoll?.("conn-1", "default", poll)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(messaging.readPoll?.("conn-1", "default", {}, "p")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(messaging.endPoll?.("conn-1", "default", { effectId: "e", destination: {}, messageId: "p" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(
      messaging.createEvent?.("conn-1", "default", { effectId: "e", destination: {}, title: "t", start: AT, end: AT, location: "l" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("post through the connector and record the outcome as a send's", async () => {
    const outcomes: SendOutcome[] = [
      { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "poll-1" }] },
      { status: "rejected", retryable: true, retryAfterMs: 1000, parts: [{ index: 0, status: "rejected", error: "too fast" }] },
    ];
    const messaging = await open({
      createPoll: async () => {
        const next = outcomes.shift();
        if (next === undefined) throw new Error("no more outcomes");
        return next;
      },
    });
    expect((await messaging.createPoll?.("conn-1", "default", poll))?.status).toBe("accepted");
    expect(messaging.statusOf("conn-1")?.lastSendAt).toBe(AT);
    expect((await messaging.createPoll?.("conn-1", "default", poll))?.status).toBe("rejected");
    expect(messaging.statusOf("conn-1")?.lastError).toBe("too fast");
  });
});

describe("a group post's destination and a room's health", () => {
  const GROUPS: MessagingCapabilities = {
    ...CAPABILITIES,
    groups: {
      addressing: ["mention"],
      directToSender: true,
      listRooms: false,
      membershipEvents: false,
      leaveRoom: false,
      polls: { maxQuestion: 300, maxAnswers: 10, maxAnswerLength: 55, maxHours: 768, multiSelect: true, results: "fetch" },
      events: { kinds: ["external"], maxTitle: 100, maxDescription: 1000 },
    },
  };
  const accepted: SendOutcome = {
    status: "accepted",
    retryable: false,
    parts: [{ index: 0, status: "accepted", providerMessageId: "m-1" }],
  };

  it("posts a poll, ends one and creates an event only where a send would be granted", async () => {
    const calls: string[] = [];
    const messaging = await open(
      {
        createPoll: async () => {
          calls.push("poll");
          return accepted;
        },
        endPoll: async () => {
          calls.push("end");
          return accepted;
        },
        createEvent: async () => {
          calls.push("event");
          return accepted;
        },
      },
      { capabilities: GROUPS, hasGrant: (message) => (message.destination as { room?: string }).room === "granted" },
    );
    await expect(messaging.createPoll?.("conn-1", "default", { ...poll, destination: { room: "elsewhere" } })).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    await expect(
      messaging.endPoll?.("conn-1", "default", { effectId: "e", destination: { room: "elsewhere" }, messageId: "p" }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(
      messaging.createEvent?.("conn-1", "default", {
        effectId: "e",
        destination: { room: "elsewhere" },
        title: "t",
        start: AT,
        end: AT,
        location: "l",
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(calls).toEqual([]);
    expect((await messaging.createPoll?.("conn-1", "default", { ...poll, destination: { room: "granted" } }))?.status).toBe("accepted");
    expect(calls).toEqual(["poll"]);
  });

  it("reaches a sender one-to-one only for a caller of the connection's own workspace", async () => {
    const messaging = await open({}, { capabilities: GROUPS });
    expect(messaging.buildDirectDestination?.("conn-1", "s-1", "default")).toEqual({ dm: "s-1" });
    expect(messaging.buildDirectDestination?.("conn-1", "s-1", "other")).toBeUndefined();
  });

  it("names a room whose last send was refused, until one is accepted, and counts drops in the status line", async () => {
    const outcomes: SendOutcome[] = [
      {
        status: "rejected",
        retryable: false,
        parts: [{ index: 0, status: "rejected", error: "the bot lacks a permission it needs in this room" }],
      },
      accepted,
    ];
    const messaging = await open({ send: async () => outcomes.shift() ?? accepted }, { capabilities: GROUPS });
    const destination = messaging.buildReplyDestination("conn-1", { externalConversationId: "room-1", externalSenderId: "s-1" });
    await messaging.send({ effectId: "s1", connectionId: "conn-1", destination, parts: [{ content: "hi" }] });
    expect(messaging.roomDetails?.("conn-1")).toEqual({ "room-1": "the bot lacks a permission it needs in this room" });
    await messaging.send({ effectId: "s2", connectionId: "conn-1", destination, parts: [{ content: "hi again" }] });
    expect(messaging.roomDetails?.("conn-1")).toEqual({});
    // Nothing dropped yet: the connector's own status line, unchanged.
    expect(messaging.statusOf("conn-1")?.detail).toBeUndefined();
  });
});

describe("typing while a message's turn runs", () => {
  it("shows it as the turn starts and every 4 s, within Telegram's 5 s, and stops when the turn ends", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    await db.repositories.messagingIdentityBindings.bind({
      connectionId: "conn-1",
      externalSenderId: "s-1",
      workspaceId: "default",
      principalId: "friend",
      approvedBy: "operator",
      createdAt: AT,
    });
    let finish = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = (): void => undefined;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const messaging = createMessagingService(db, {
      now: () => AT,
      admit: async () => {
        started();
        await running;
      },
    });
    const typed: unknown[] = [];
    messaging.registerConnector({
      providerId: "parrot",
      version: "1.0.0",
      configSchema: z.object({}).passthrough(),
      capabilities: CAPABILITIES,
      destinationFromInbound: (replyTo) => ({ chat: replyTo.externalConversationId, thread: replyTo.externalThreadId }),
      createConnection: () => ({
        start: async () => undefined,
        stop: async () => undefined,
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
        typing: async (destination) => void typed.push(destination),
      }),
    });
    await messaging.openConnection({
      connection: {
        connectionId: "conn-1",
        providerId: "parrot",
        accountIdentity: "bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const ingesting = messaging.ingest({
        connectionId: "conn-1",
        providerEventId: "e-1",
        kind: "message",
        externalSenderId: "s-1",
        externalConversationId: "chat-1",
        externalThreadId: "t-1",
        occurredAt: AT,
        receivedAt: AT,
        content: "hi",
      });
      await admitted;
      expect(typed).toEqual([{ chat: "chat-1", thread: "t-1" }]);
      vi.advanceTimersByTime(16_000);
      expect(typed).toHaveLength(5);
      finish();
      await ingesting;
      vi.advanceTimersByTime(16_000);
      expect(typed).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a connection's probe", () => {
  it("is taken when first read and kept bounded, retaken on asking, a failure its answer, and gone once it closes", async () => {
    const answers = [
      {
        ok: true,
        setup: {
          lines: ["one", "", ...Array.from({ length: 8 }, (_, index) => `line ${String(index)} ${"x".repeat(300)}`)],
          link: { label: "Invite", url: "https://example.com/invite" },
        },
      },
      { ok: true, setup: { lines: ["two"], link: { label: "Bad", url: "http://example.com/" } } },
    ];
    let failing = false;
    const messaging = await open({
      probe: async () => {
        if (failing) throw new Error("down");
        return answers.shift() ?? { ok: false };
      },
    });
    // Nothing is asked of the provider until someone looks.
    expect(answers).toHaveLength(2);
    expect(messaging.probeOf?.("conn-1")).toBeUndefined();
    await sleep(0);
    const first = messaging.probeOf?.("conn-1");
    expect(first?.setup?.lines).toHaveLength(6);
    expect(first?.setup?.lines.every((line) => line.length <= 200)).toBe(true);
    expect(first?.setup?.link).toEqual({ label: "Invite", url: "https://example.com/invite" });
    // Only an https link is kept.
    expect(await messaging.probe?.("conn-1")).toEqual({ ok: true, setup: { lines: ["two"] } });
    // Read while fresh, it is not retaken.
    expect(messaging.probeOf?.("conn-1")).toEqual({ ok: true, setup: { lines: ["two"] } });
    expect(answers).toHaveLength(0);
    failing = true;
    expect(await messaging.probe?.("conn-1")).toEqual({ ok: false, detail: "down" });
    expect(await messaging.probe?.("conn-9")).toBeUndefined();
    await messaging.closeConnection("conn-1");
    expect(messaging.probeOf?.("conn-1")).toBeUndefined();
  });
});

describe("a kept probe gone stale", () => {
  it("is retaken in the background when read a minute or more after it was taken", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    let at = Date.parse(AT);
    let probed = 0;
    const messaging = createMessagingService(db, { now: () => new Date(at).toISOString() });
    messaging.registerConnector({
      providerId: "parrot",
      version: "1.0.0",
      configSchema: z.object({}).passthrough(),
      capabilities: CAPABILITIES,
      createConnection: () => ({
        start: async () => undefined,
        stop: async () => undefined,
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true, setup: { lines: [`probe ${String((probed += 1))}`] } }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    await messaging.openConnection({
      connection: {
        connectionId: "conn-1",
        providerId: "parrot",
        accountIdentity: "bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    expect(messaging.probeOf?.("conn-1")).toBeUndefined();
    await sleep(0);
    expect(messaging.probeOf?.("conn-1")?.setup?.lines).toEqual(["probe 1"]);
    at += 61_000;
    // The kept one answers now; the fresh one is there at the next read.
    expect(messaging.probeOf?.("conn-1")?.setup?.lines).toEqual(["probe 1"]);
    await sleep(0);
    expect(messaging.probeOf?.("conn-1")?.setup?.lines).toEqual(["probe 2"]);
  });
});

describe("a room's recent messages through the service", () => {
  it("are read within 20 and the connector's own most, trimmed to what was asked, and refused without the feature or for another workspace", async () => {
    const asked: number[] = [];
    const recent = Array.from({ length: 40 }, (_, index) => ({
      externalSenderId: "s",
      externalMessageId: `m-${String(index)}`,
      authorKind: "person" as const,
      content: String(index),
      at: AT,
    }));
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const messaging = createMessagingService(db, { now: () => AT });
    messaging.registerConnector({
      providerId: "parrot",
      version: "1.0.0",
      configSchema: z.object({}).passthrough(),
      capabilities: {
        ...CAPABILITIES,
        groups: {
          addressing: ["mention"],
          directToSender: false,
          listRooms: false,
          membershipEvents: false,
          leaveRoom: false,
          recentHistory: { maxMessages: 10 },
        },
      },
      createConnection: () => ({
        start: async () => undefined,
        stop: async () => undefined,
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
        // A connector that answers more than it was asked.
        fetchRecent: async (_destination, options) => {
          asked.push(options.limit);
          return recent;
        },
      }),
    });
    await messaging.openConnection({
      connection: {
        connectionId: "conn-1",
        providerId: "parrot",
        accountIdentity: "bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    const signal = new AbortController().signal;
    const read = await messaging.fetchRecent?.("conn-1", "default", {}, { limit: 50, signal });
    expect(asked).toEqual([10]);
    expect(read?.map((message) => message.externalMessageId)).toEqual(recent.slice(-10).map((message) => message.externalMessageId));
    await messaging.fetchRecent?.("conn-1", "default", {}, { limit: 3, signal });
    expect(asked.at(-1)).toBe(3);
    await expect(messaging.fetchRecent?.("conn-1", "other", {}, { limit: 3, signal })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    const without = await open({});
    await expect(without.fetchRecent?.("conn-1", "default", {}, { limit: 3, signal })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
