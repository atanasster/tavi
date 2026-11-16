import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChannelGroupPolicy, ChannelRoomRecord, InboundEvent, MessagingCapabilities } from "@tavi/contracts";
import { z } from "zod";
import { temporaryDirectories } from "@tavi/test-support";

import { createMessagingService } from "../src/messaging/service.js";
import { DatabaseClient } from "../src/persistence/client.js";
import { createRoomPolicy } from "../src/messaging/room-policy.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * The host's room policy: each of its steps, its notices and their pace, that a redelivery is
 * never dropped as a flood, and that `ingest` keeps nothing of what it drops —
 * no inbox row and no media fetched.
 */

const AT = "2026-10-18T08:00:00.000Z";
const DROP: ChannelGroupPolicy = { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention", "reply"] };
const HOLD: ChannelGroupPolicy = { unboundSenders: "hold", unlistedRooms: "admit", defaultTrigger: ["mention"] };

const directories = temporaryDirectories();
const stores: SqliteStore[] = [];
const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

function fixture(policy: ChannelGroupPolicy | null = DROP) {
  const directory = directories.create("tavi-room-policy-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  const repositories = store.asPort().repositories;
  let clock = Date.parse(AT);
  const room = async (changes: Partial<ChannelRoomRecord> = {}) =>
    repositories.channelRooms.upsert({
      connectionId: "conn-1",
      conversationId: "room-1",
      workspaceId: "default",
      label: "Room",
      trigger: ["mention", "reply"],
      members: "bound",
      context: "off",
      introState: "sent",
      createdAt: AT,
      updatedAt: AT,
      ...changes,
    });
  const bind = async (externalSenderId: string, principalId = "friend") =>
    repositories.messagingIdentityBindings.bind({
      connectionId: "conn-1",
      externalSenderId,
      workspaceId: "default",
      principalId,
      approvedBy: "operator",
      createdAt: AT,
    });
  // The policy reads through the owner's async port; this store answers in place.
  const reads = {
    channelRooms: {
      get: async (connectionId: string, conversationId: string) => repositories.channelRooms.get(connectionId, conversationId),
    },
    messagingIdentityBindings: {
      get: async (connectionId: string, senderId: string) => repositories.messagingIdentityBindings.get(connectionId, senderId),
    },
    messagingInbox: { get: async (connectionId: string, eventId: string) => repositories.messagingInbox.get(connectionId, eventId) },
  };
  const policy_ = createRoomPolicy({
    repositories: reads,
    groupPolicyOf: () => policy ?? undefined,
    operatorOf: () => "operator",
    now: () => clock,
  });
  return {
    store,
    repositories,
    room,
    bind,
    policy: policy_,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

let next = 0;
/** A message that addressed nothing: no `addressed` at all. */
const unaddressed = (changes: Partial<InboundEvent> = {}): InboundEvent => {
  const { addressed: _addressed, ...rest } = message(changes);
  return rest;
};
const message = (changes: Partial<InboundEvent> = {}): InboundEvent => ({
  connectionId: "conn-1",
  providerEventId: `evt-${(next += 1)}`,
  kind: "message",
  externalSenderId: "s-1",
  externalConversationId: "room-1",
  conversationKind: "group",
  occurredAt: AT,
  receivedAt: AT,
  content: "hi",
  addressed: ["mention"],
  authorKind: "person",
  ...changes,
});

describe("the room policy", () => {
  it("leaves a channel without the seam alone", async () => {
    const { policy } = fixture(null);
    expect(await policy.decide(message({ authorKind: "bot", externalConversationId: "nowhere" }))).toEqual({ admit: true });
  });

  it("drops bots, the platform's own messages and membership reports, and tells the host of the agent being added", async () => {
    const { policy, room, bind } = fixture();
    await room();
    await bind("s-1");
    expect(await policy.decide(message({ authorKind: "bot" }))).toEqual({ admit: false, reason: "bot" });
    expect(await policy.decide(message({ authorKind: "system" }))).toEqual({ admit: false, reason: "system" });
    expect(await policy.decide(message({ kind: "membership", membership: { change: "added" } }))).toEqual({
      admit: false,
      reason: "membership",
    });
    expect(await policy.decide(message({ kind: "membership", membership: { change: "removed" } }))).toEqual({
      admit: false,
      reason: "membership",
      notice: "membership",
    });
    expect(await policy.decide(message({ kind: "membership", externalConversationId: "room-9", membership: { change: "added" } }))).toEqual(
      { admit: false, reason: "membership", notice: "membership" },
    );
    expect(policy.drops("conn-1")).toEqual({ bot: 1, system: 1, membership: 3 });
  });

  it("drops an unlisted room's messages, telling the host once a day per room; an admit channel takes them as before", async () => {
    const { policy, advance } = fixture();
    expect(await policy.decide(message())).toEqual({ admit: false, reason: "unlisted-room", notice: "unlisted" });
    expect(await policy.decide(message())).toEqual({ admit: false, reason: "unlisted-room" });
    expect(await policy.decide(message({ externalConversationId: "room-2" }))).toMatchObject({ notice: "unlisted" });
    advance(24 * 60 * 60 * 1000);
    expect(await policy.decide(message())).toMatchObject({ notice: "unlisted" });
    const admitting = fixture(HOLD);
    expect(await admitting.policy.decide(unaddressed())).toEqual({ admit: true });
  });

  it("drops a paused room's messages, and what does not address the agent as the room asks; `any` takes every message", async () => {
    const { policy, room, bind } = fixture();
    await bind("s-1");
    await room({ disabledAt: AT });
    expect(await policy.decide(message())).toEqual({ admit: false, reason: "room-disabled" });
    await room();
    expect(await policy.decide(unaddressed())).toEqual({ admit: false, reason: "not-addressed" });
    expect(await policy.decide(message({ addressed: ["command"] }))).toEqual({ admit: false, reason: "not-addressed" });
    expect(await policy.decide(message({ addressed: ["reply"] }))).toEqual({ admit: true });
  });

  it("drops an unbound sender on a drop channel, holds one on a hold channel, and hears only the operator in an operator-only room", async () => {
    const { policy, room, bind } = fixture();
    await room();
    expect(await policy.decide(message())).toEqual({ admit: false, reason: "unbound" });
    await bind("s-1");
    expect(await policy.decide(message())).toEqual({ admit: true });
    await room({ members: "operator-only" });
    expect(await policy.decide(message())).toEqual({ admit: false, reason: "not-operator" });
    await bind("s-op", "operator");
    expect(await policy.decide(message({ externalSenderId: "s-op" }))).toEqual({ admit: true });
    const holding = fixture({ ...HOLD, unlistedRooms: "drop" });
    await holding.room();
    expect(await holding.policy.decide(message())).toEqual({ admit: true });
  });

  it("drops a flooding room's excess and tells the host at most once an hour; one sender is bounded on its own", async () => {
    const { policy, room, bind, advance } = fixture();
    await room();
    for (const sender of ["a", "b", "c", "d"]) await bind(sender);
    const verdicts = [];
    for (const sender of ["a", "a", "a", "a", "b", "b", "b", "c"])
      verdicts.push(await policy.decide(message({ externalSenderId: sender })));
    // a's fourth is over its own 3 a minute; the room takes 6 a minute, so c's is the room's seventh.
    expect(verdicts.map((verdict) => verdict.admit)).toEqual([true, true, true, false, true, true, true, false]);
    expect(verdicts[3]).toEqual({ admit: false, reason: "flood", notice: "flood" });
    expect(verdicts[7]).toEqual({ admit: false, reason: "flood" });
    advance(60_000);
    expect(await policy.decide(message({ externalSenderId: "d" }))).toEqual({ admit: true });
    // The room's hourly bound: 20, of which 7 were taken.
    let admitted = 7;
    for (let minute = 0; minute < 6; minute += 1) {
      advance(60_000);
      for (const sender of ["a", "b", "c"]) if ((await policy.decide(message({ externalSenderId: sender }))).admit) admitted += 1;
    }
    expect(admitted).toBe(20);
    expect(policy.drops("conn-1").flood).toBeGreaterThan(2);
  });

  it("never drops a redelivery as a flood, and bounds an unknown one-to-one sender", async () => {
    const { policy, room, bind, repositories } = fixture();
    await room();
    await bind("a");
    const kept = message({ externalSenderId: "a" });
    await repositories.messagingInbox.record({
      connectionId: kept.connectionId,
      providerEventId: kept.providerEventId,
      kind: "message",
      payload: kept,
      now: () => AT,
    });
    for (let index = 0; index < 3; index += 1) await policy.decide(message({ externalSenderId: "a" }));
    expect(await policy.decide(kept)).toEqual({ admit: true });
    const direct = (sender: string) =>
      unaddressed({ conversationKind: "direct", externalConversationId: sender, externalSenderId: sender });
    const verdicts = [];
    for (let index = 0; index < 4; index += 1) verdicts.push((await policy.decide(direct("stranger"))).admit);
    expect(verdicts).toEqual([true, true, true, false]);
    for (let index = 0; index < 5; index += 1) expect(await policy.decide(direct("a"))).toEqual({ admit: true });
  });

  it("lets a press through whoever pressed, unless a bot did", async () => {
    const { policy } = fixture();
    expect(
      await policy.decide(message({ kind: "interaction", externalConversationId: "unlisted", interaction: { data: "r:abcdefgh:o" } })),
    ).toEqual({ admit: true });
    expect(await policy.decide(message({ kind: "interaction", authorKind: "bot", interaction: { data: "x" } }))).toEqual({
      admit: false,
      reason: "bot",
    });
  });
});

describe("ingest under the room policy", () => {
  it("asks a room that answers in threads to open one for a message not yet in a thread", async () => {
    const { room, bind, policy } = fixture();
    await bind("s-1");
    await room({ autoThread: true });
    expect(await policy.decide(message())).toEqual({ admit: true, autoThread: true });
    // Already in a thread, it stays there, under the room's trigger: this room's has no `thread`.
    expect(await policy.decide(message({ externalThreadId: "t-1", conversationKind: "thread" }))).toEqual({ admit: true });
    expect(await policy.decide(message({ externalThreadId: "t-1", conversationKind: "thread", addressed: ["thread"] }))).toEqual({
      admit: false,
      reason: "not-addressed",
    });
    // A room without the setting is as before.
    await room();
    expect(await policy.decide(message())).toEqual({ admit: true });
  });

  it("records an auto-thread room's message as its thread's, which its connector names, before anything else reads it", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const repositories = db.repositories;
    await repositories.channelRooms.upsert({
      connectionId: "conn-1",
      conversationId: "room-1",
      workspaceId: "default",
      label: "Room",
      trigger: ["mention", "reply", "thread"],
      members: "bound",
      context: "off",
      introState: "sent",
      createdAt: AT,
      updatedAt: AT,
      autoThread: true,
    });
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-1",
      externalSenderId: "s-1",
      workspaceId: "default",
      principalId: "friend",
      approvedBy: "operator",
      createdAt: AT,
    });
    const capabilities: MessagingCapabilities = {
      receiveMode: "none",
      send: true,
      editOrProgress: false,
      formats: ["plain"],
      attachments: false,
      maxAttachmentBytes: 0,
      maxPartsPerMessage: 1,
      threads: true,
      interactions: false,
      deliveryReceipts: false,
      maxTextLength: 2000,
      approvals: "none",
    };
    const messaging = createMessagingService(db, { now: () => AT, groupPolicyOf: () => DROP });
    messaging.registerConnector({
      providerId: "threader",
      version: "1.0.0",
      configSchema: z.object({}).passthrough(),
      capabilities,
      autoThreadOf: (event) => (event.externalMessageId === undefined ? undefined : `thread-of-${event.externalMessageId}`),
      createConnection: () => ({
        start: async () => undefined,
        stop: async () => undefined,
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    await messaging.openConnection({
      connection: {
        connectionId: "conn-1",
        providerId: "threader",
        accountIdentity: "bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    const event = message({ externalMessageId: "m-1" });
    await messaging.ingest(event);
    expect((await repositories.messagingInbox.get("conn-1", event.providerEventId))?.payload).toMatchObject({
      externalConversationId: "room-1",
      externalThreadId: "thread-of-m-1",
      threadIsTopic: true,
      conversationKind: "thread",
    });
    // The host's word alone opens a thread: a connector's claim to it is dropped.
    await repositories.channelRooms.upsert({
      connectionId: "conn-1",
      conversationId: "room-2",
      workspaceId: "default",
      label: "Other",
      trigger: ["mention"],
      members: "bound",
      context: "off",
      introState: "sent",
      createdAt: AT,
      updatedAt: AT,
    });
    const claimed = { ...message({ externalMessageId: "m-2", externalConversationId: "room-2" }), threadOpened: true };
    await messaging.ingest(claimed);
    expect((await repositories.messagingInbox.get("conn-1", claimed.providerEventId))?.payload).not.toHaveProperty("threadOpened");
    expect((await repositories.messagingInbox.get("conn-1", event.providerEventId))?.payload).toMatchObject({ threadOpened: true });
    // One that names no thread leaves the message the room's.
    const plain = message();
    await messaging.ingest(plain);
    expect((await repositories.messagingInbox.get("conn-1", plain.providerEventId))?.payload).not.toHaveProperty("externalThreadId");
  });

  it("keeps nothing of a dropped event: no inbox row, no media fetched, and the connector is told it was handled", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const repositories = db.repositories;
    const notices: string[] = [];
    const messaging = createMessagingService(db, {
      now: () => AT,
      groupPolicyOf: () => DROP,
      onRoomNotice: ({ kind }) => void notices.push(kind),
    });
    const event = message({ media: [{ ref: "file-1", filename: "secret.pdf" }] });
    expect(await messaging.ingest(event)).toEqual({ accepted: true, duplicate: false, dropped: "unlisted-room" });
    expect(await repositories.messagingInbox.get(event.connectionId, event.providerEventId)).toBeUndefined();
    expect(notices).toEqual(["unlisted"]);
    expect(messaging.roomDrops?.("conn-1")).toEqual({ "unlisted-room": 1 });
    // A notice that throws or rejects changes nothing: the drop stands.
    const throwing = createMessagingService(db, {
      now: () => AT,
      groupPolicyOf: () => DROP,
      onRoomNotice: () => {
        throw new Error("broken");
      },
    });
    expect((await throwing.ingest(message({ externalConversationId: "room-7" }))).dropped).toBe("unlisted-room");
    const rejecting = createMessagingService(db, {
      now: () => AT,
      groupPolicyOf: () => DROP,
      onRoomNotice: () => Promise.reject(new Error("broken")),
    });
    expect((await rejecting.ingest(message({ externalConversationId: "room-8" }))).dropped).toBe("unlisted-room");
    // A channel without the seam records it as before.
    const plain = createMessagingService(db, { now: () => AT });
    expect((await plain.ingest(message())).dropped).toBeUndefined();
  });
});
