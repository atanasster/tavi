import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaviError, triggerInWords } from "@tavi/contracts";
import type {
  ChannelDescriptor,
  ChannelRoomRecord,
  MessagingCapabilities,
  MessagingConnectionRecord,
  OutboundMessage,
  SendOutcome,
} from "@tavi/contracts";

import { registerChannelDescriptor, unregisterChannelDescriptor } from "../../src/features/channels/catalog.js";
import {
  channelRooms,
  roomContextIntroduction,
  roomIntroduction,
  type ChannelRoomsDependencies,
} from "../../src/features/channels/rooms.js";
import { parseChannels } from "../../src/features/channels/parse.js";
import { runChannelsCli } from "../../src/features/channels/client.js";
import { delay } from "@tavi/test-support";

/** A group channel's rooms. */

const AT = "2026-10-18T00:00:00.000Z";
const descriptor = {
  providerId: "grouplike",
  label: "Grouplike",
  kind: "chat",
  description: "d",
  settings: [],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Token" }] },
  sender: { label: "S", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "T", placeholder: "", pattern: ".+", normalize: "none" },
  groups: { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention", "reply"] },
} as unknown as ChannelDescriptor;
const plain = { ...descriptor, providerId: "plainchat", label: "Plain", groups: undefined } as unknown as ChannelDescriptor;
const capabilities = {
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
  groups: { addressing: ["mention", "reply", "command"], directToSender: true, listRooms: true, membershipEvents: true, leaveRoom: true },
} as unknown as MessagingCapabilities;
const threading = {
  ...capabilities,
  groups: {
    ...capabilities.groups,
    addressing: ["mention", "reply", "thread", "command"],
    autoThread: true,
    recentHistory: { maxMessages: 50 },
  },
} as MessagingCapabilities;

const connection = (connectionId: string, providerId = "grouplike", workspaceId = "w1"): MessagingConnectionRecord => ({
  connectionId,
  providerId,
  workspaceId,
  accountIdentity: "bot",
  settings: {},
  credentialRefs: {},
  enabled: true,
  configRevision: 1,
  authState: "none",
  createdAt: AT,
  updatedAt: AT,
});

function setup(
  options: {
    outcome?: SendOutcome["status"];
    readonly open?: readonly string[];
    readonly unreadable?: boolean;
    throws?: Error;
    hold?: Promise<void>;
  } = {},
) {
  const rooms = new Map<string, ChannelRoomRecord>();
  const key = (connectionId: string, conversationId: string) => `${connectionId}|${conversationId}`;
  const sent: OutboundMessage[] = [];
  const left: unknown[] = [];
  const settled: string[] = [];
  const connections = [connection("g1"), connection("g2"), connection("p1", "plainchat")];
  const open = new Set(options.open ?? ["g1", "g2"]);
  const clock = { now: AT };
  const deps: ChannelRoomsDependencies = {
    channels: { configured: () => connections.map((record) => ({ ...record, source: "saved" as const })) },
    repositories: {
      messagingIdentityBindings: {
        list: async () => [
          {
            connectionId: "g1",
            externalSenderId: "7",
            workspaceId: "w1",
            principalId: "owner",
            approvedBy: "owner",
            createdAt: AT,
            displayName: "Ada",
          },
        ],
      } as never,
      channelRooms: {
        get: async (connectionId: string, conversationId: string) => rooms.get(key(connectionId, conversationId)),
        listForConnection: async (connectionId: string) => [...rooms.values()].filter((room) => room.connectionId === connectionId),
        upsert: async (room: ChannelRoomRecord) => void rooms.set(key(room.connectionId, room.conversationId), room),
        setIntroState: async (connectionId: string, conversationId: string, introState: ChannelRoomRecord["introState"], at: string) => {
          const room = rooms.get(key(connectionId, conversationId));
          if (room !== undefined) rooms.set(key(connectionId, conversationId), { ...room, introState, updatedAt: at });
          return room !== undefined;
        },
        remove: async (connectionId: string, conversationId: string) => rooms.delete(key(connectionId, conversationId)),
      } as never,
    },
    messaging: {
      // g2's connector can open a thread for each message; g1's cannot.
      capabilitiesOf: (connectionId) => (!open.has(connectionId) ? undefined : connectionId === "g2" ? threading : capabilities),
      buildReplyDestination: (connectionId, replyTo) => (open.has(connectionId) ? { chatId: replyTo.externalConversationId } : undefined),
      send: async (message) => {
        sent.push(message);
        await options.hold;
        if (options.throws !== undefined) throw options.throws;
        const status = options.outcome ?? "accepted";
        return { status, retryable: false, parts: [{ index: 0, status, ...(status === "rejected" ? { error: "forbidden" } : {}) }] };
      },
      listRooms: async () => [{ id: "-100", name: "Team" }],
      leaveRoom: async (_connectionId, _workspaceId, destination) => void left.push(destination),
      roomDrops: () => ({ "not-addressed": 3 }),
      roomDetails: () => ({ "-100": "the bot lacks a permission it needs in this room", "dm-7": "blocked" }),
      fetchRecent: async () => {
        if (options.unreadable === true) throw new TaviError("UNAVAILABLE", "the bot lacks Read Message History in this room");
        return [];
      },
    },
    roomInvitations: {
      list: () => [{ connectionId: "g1", conversationId: "-300", by: "9", how: "added", at: AT }],
      settle: (_connectionId, conversationId) => void settled.push(conversationId),
    },
    operatorOf: () => "owner",
    now: () => clock.now,
  };
  return { deps, rooms, sent, left, settled, key, clock, open, options };
}

beforeEach(() => {
  registerChannelDescriptor(descriptor);
  registerChannelDescriptor(plain);
});
afterEach(() => {
  unregisterChannelDescriptor("grouplike");
  unregisterChannelDescriptor("plainchat");
});

describe("channels rooms", () => {
  it("adds a room with the channel's default trigger and sends its introduction once, by its effect id", async () => {
    const { deps, rooms, sent, settled, key } = setup();
    const answer = await channelRooms(deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g1",
      op: "add",
      conversationId: "-100",
      label: "Team",
    });
    expect(answer.rooms).toMatchObject([
      { conversationId: "-100", label: "Team", trigger: ["mention", "reply"], members: "bound", context: "off", introState: "sent" },
    ]);
    expect(answer.notApplied).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ effectId: `room-intro:g1:-100:${AT}`, destination: { chatId: "-100" } });
    const intro = String(sent[0]?.parts[0] && "content" in sent[0].parts[0] ? sent[0].parts[0].content : "");
    expect(intro).toContain("Ada's assistant");
    expect(intro).toContain("mention me or reply to one of my messages");
    expect(intro).toContain("never read messages from people Tavi doesn't know");
    expect(intro).toContain("ask Ada");
    expect(settled).toEqual(["-100"]);
    expect(rooms.get(key("g1", "-100"))?.introState).toBe("sent");
  });

  it("lists the rooms with the platform's candidates, the rooms waiting and the drop counts", async () => {
    const { deps } = setup();
    const answer = await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "list" });
    expect(answer).toMatchObject({
      rooms: [],
      candidates: [{ id: "-100", name: "Team" }],
      waiting: [{ conversationId: "-300", by: "9", how: "added" }],
      drops: { "not-addressed": 3 },
    });
    expect(answer.waiting[0]).not.toHaveProperty("connectionId");
  });

  it("keeps a room whose introduction was refused, listed with its introduction pending and the reason", async () => {
    const { deps } = setup({ outcome: "rejected" });
    const answer = await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    expect(answer.rooms[0]).toMatchObject({ label: "Room -100", introState: "pending" });
    expect(answer.notApplied).toBe("the introduction was not sent: forbidden");
  });

  it("introduces a refused room when its rooms are next listed with the connection open, under a new id; an uncertain one never again", async () => {
    const { deps, rooms, sent, key, clock, open, options } = setup({ outcome: "rejected" });
    clock.now = "2026-10-18T00:01:00.000Z";
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    expect(sent).toHaveLength(1);
    // Closed, nothing is tried.
    open.delete("g1");
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "list" });
    expect(sent).toHaveLength(1);
    open.add("g1");
    options.outcome = "accepted";
    clock.now = "2026-10-18T00:02:00.000Z";
    const listed = await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "list" });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.effectId).toBe("room-intro:g1:-100:2026-10-18T00:01:00.000Z:retry:2026-10-18T00:01:00.000Z");
    expect(listed.rooms[0]?.introState).toBe("sent");
    // A send that may have gone out is not repeated blind.
    await deps.repositories.channelRooms.setIntroState("g1", "-100", "uncertain", clock.now);
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "list" });
    expect(sent).toHaveLength(2);
    expect(rooms.get(key("g1", "-100"))?.introState).toBe("uncertain");
  });

  it("never sends an introduction twice: a send that failed without saying nothing went out, or one still on its way, is not tried again", async () => {
    // A transport failure may have reached the room: uncertain, and left so.
    const failed = setup({ throws: new Error("socket hang up") });
    await channelRooms(failed.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    expect(failed.rooms.get(failed.key("g1", "-100"))?.introState).toBe("uncertain");
    delete failed.options.throws;
    await channelRooms(failed.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "list" });
    expect(failed.sent).toHaveLength(1);
    // Refused before dispatch: nothing went out, so it is tried again.
    const refused = setup({ throws: new TaviError("UNAVAILABLE", "the connection is reopening") });
    await channelRooms(refused.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    expect(refused.rooms.get(refused.key("g1", "-100"))?.introState).toBe("pending");
    // While a send is on its way the room reads as uncertain, so a listing meanwhile sends nothing — nor would an owner that stopped mid-send.
    let release = (): void => undefined;
    const slow = setup({
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const adding = channelRooms(slow.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    await delay(0);
    expect(slow.rooms.get(slow.key("g1", "-100"))?.introState).toBe("uncertain");
    await channelRooms(slow.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "list" });
    release();
    await adding;
    expect(slow.sent).toHaveLength(1);
    expect(slow.rooms.get(slow.key("g1", "-100"))?.introState).toBe("sent");
  });

  it("refuses a trigger the connector does not report, a room another connection has, a closed connection and a channel without rooms", async () => {
    const { deps } = setup({ open: ["g1", "g2"] });
    await expect(
      channelRooms(deps, {
        action: "rooms",
        workspaceId: "w1",
        connectionId: "g1",
        op: "add",
        conversationId: "-100",
        trigger: ["picked"],
      }),
    ).rejects.toThrow(/does not report picked/);
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g2", op: "add", conversationId: "-100" });
    await expect(
      channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g2", op: "add", conversationId: "-100" }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    const closed = setup({ open: [] });
    await expect(
      channelRooms(closed.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(
      channelRooms(closed.deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "leave", conversationId: "-100" }),
    ).rejects.toThrow(/is not open/);
    await expect(channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "p1", op: "list" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(channelRooms(deps, { action: "rooms", workspaceId: "w2", connectionId: "g1", op: "list" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("sets a room's trigger and members, removes it, and leaves a room the agent was added to", async () => {
    const { deps, rooms, left, settled, key } = setup();
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    await channelRooms(deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g1",
      op: "set",
      conversationId: "-100",
      trigger: ["command"],
      members: "operator-only",
    });
    expect(rooms.get(key("g1", "-100"))).toMatchObject({ trigger: ["command"], members: "operator-only" });
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "remove", conversationId: "-100" });
    expect(rooms.size).toBe(0);
    await expect(
      channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "remove", conversationId: "-100" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "leave", conversationId: "-300" });
    expect(left).toEqual([{ chatId: "-300" }]);
    expect(settled).toContain("-300");
  });

  it("answers a room in threads only on a channel that can open them, and keeps the setting until it is turned off", async () => {
    const { deps, rooms, key } = setup();
    await expect(
      channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100", autoThread: true }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await channelRooms(deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g2",
      op: "add",
      conversationId: "-200",
      autoThread: true,
    });
    // It hears a message in the thread opened for a task, whatever the trigger asked.
    expect(rooms.get(key("g2", "-200"))).toMatchObject({ autoThread: true, trigger: ["mention", "reply", "thread"] });
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g2", op: "set", conversationId: "-200", label: "Team" });
    expect(rooms.get(key("g2", "-200"))).toMatchObject({ label: "Team", autoThread: true });
    await channelRooms(deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g2",
      op: "set",
      conversationId: "-200",
      autoThread: false,
    });
    expect(rooms.get(key("g2", "-200"))).not.toHaveProperty("autoThread");
    await channelRooms(deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g2",
      op: "set",
      conversationId: "-200",
      trigger: ["command"],
      autoThread: true,
    });
    expect(rooms.get(key("g2", "-200"))).toMatchObject({ autoThread: true, trigger: ["command", "thread"] });
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    await expect(
      channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "set", conversationId: "-100", autoThread: true }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("reads a room's recent messages only on a channel that can, telling the room once each time it starts to", async () => {
    const { deps, rooms, sent, key } = setup();
    const added = await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100" });
    // Only a listed room's refused send is shown: never a one-to-one chat's.
    expect(added.details).toEqual({ "-100": "the bot lacks a permission it needs in this room" });
    await expect(
      channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "set", conversationId: "-100", context: "recent" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(rooms.get(key("g1", "-100"))?.context).toBe("off");
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g2", op: "add", conversationId: "-200" });
    const before = sent.length;
    await channelRooms(deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g2",
      op: "set",
      conversationId: "-200",
      context: "recent",
    });
    expect(rooms.get(key("g2", "-200"))?.context).toBe("recent");
    expect(sent.slice(before).map((message) => (message.parts[0] as { content: string }).content)).toEqual([
      expect.stringContaining("I also read up to 20 of this room's messages before theirs"),
    ]);
    // Already reading: told nothing again; off and back on: told again.
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g2", op: "set", conversationId: "-200", label: "Team" });
    expect(sent).toHaveLength(before + 1);
    await channelRooms(deps, { action: "rooms", workspaceId: "w1", connectionId: "g2", op: "set", conversationId: "-200", context: "off" });
    expect(sent).toHaveLength(before + 1);
    expect(rooms.get(key("g2", "-200"))?.context).toBe("off");
  });

  it("keeps a room's context off when the room could not be told, and tells an operator-only room only its owner speaks to it", async () => {
    const refused = setup({ outcome: "rejected" });
    await refused.deps.repositories.channelRooms.upsert({
      connectionId: "g2",
      conversationId: "-200",
      workspaceId: "w1",
      label: "Team",
      trigger: ["mention"],
      members: "bound",
      context: "off",
      introState: "sent",
      createdAt: AT,
      updatedAt: AT,
    });
    const answer = await channelRooms(refused.deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g2",
      op: "set",
      conversationId: "-200",
      context: "recent",
      label: "Crew",
    });
    expect(answer.notApplied).toMatch(/^its context stays off: the room was not told/);
    expect(refused.rooms.get(refused.key("g2", "-200"))).toMatchObject({ context: "off", label: "Crew" });
    // A room whose messages cannot be read is not told, and its context stays off.
    const unreadable = setup({ unreadable: true });
    await unreadable.deps.repositories.channelRooms.upsert({
      connectionId: "g2",
      conversationId: "-200",
      workspaceId: "w1",
      label: "Team",
      trigger: ["mention"],
      members: "bound",
      context: "off",
      introState: "sent",
      createdAt: AT,
      updatedAt: AT,
    });
    const unread = await channelRooms(unreadable.deps, {
      action: "rooms",
      workspaceId: "w1",
      connectionId: "g2",
      op: "set",
      conversationId: "-200",
      context: "recent",
    });
    expect(unread.notApplied).toBe("its context stays off: its messages cannot be read: the bot lacks Read Message History in this room");
    expect(unreadable.sent).toHaveLength(0);
    expect(unreadable.rooms.get(unreadable.key("g2", "-200"))?.context).toBe("off");
    expect(roomContextIntroduction("Ada", { members: "operator-only" })).toContain("when Ada addresses me here");
    expect(roomContextIntroduction("Ada", { members: "bound" })).toContain("when someone Ada has told me about addresses me here");
  });

  it("says a trigger in words, and an operator-only room's introduction names only its owner", () => {
    expect(triggerInWords(["mention", "reply", "command"])).toBe("mention me, reply to one of my messages or use one of my commands");
    expect(roomIntroduction("Ada", { trigger: ["mention"], members: "operator-only" })).toContain(
      "I answer only Ada here, when they mention me",
    );
  });
});

describe("tavi channels rooms", () => {
  it("parses the room's action, id and settings", () => {
    expect(parseChannels(["rooms", "g1"])).toMatchObject({
      command: "channels",
      channels: { action: "rooms", target: "g1", roomOp: "list" },
    });
    expect(
      parseChannels(["rooms", "g1", "add", "-100", "--label", "Team", "--trigger", "mention,command", "--members", "operator-only"]),
    ).toMatchObject({
      channels: { roomOp: "add", conversationId: "-100", label: "Team", trigger: ["mention", "command"], members: "operator-only" },
    });
    expect(parseChannels(["rooms", "g1", "set", "-100", "--auto-thread", "on"])).toMatchObject({
      channels: { roomOp: "set", autoThread: true },
    });
    expect(parseChannels(["rooms", "g1", "set", "-100", "--auto-thread", "off"])).toMatchObject({ channels: { autoThread: false } });
    expect(() => parseChannels(["rooms", "g1", "set", "-100", "--auto-thread", "yes"])).toThrow(/--auto-thread takes on or off/);
    expect(parseChannels(["rooms", "g1", "set", "-100", "--context", "recent"])).toMatchObject({
      channels: { roomOp: "set", context: "recent" },
    });
    expect(() => parseChannels(["rooms", "g1", "set", "-100", "--context", "all"])).toThrow(/--context takes recent or off/);
    expect(() => parseChannels(["rooms", "g1", "add", "-100", "--context", "recent"])).toThrow(/--context is set on a room already added/);
    expect(parseChannels(["grant", "g1", "contact", "u-bob", "fs.write", "allow", "--expires", "2026-11-01T00:00:00Z"])).toMatchObject({
      channels: {
        action: "grant",
        target: "g1",
        grant: { scopeKind: "contact", scopeId: "u-bob", toolId: "fs.write", mode: "allow", expiresAt: "2026-11-01T00:00:00.000Z" },
      },
    });
    expect(() => parseChannels(["grant", "g1", "chat", "u-bob", "fs.write", "allow"])).toThrow(/names a room or a contact/);
    expect(() => parseChannels(["grant", "g1", "room", "-100", "fs.write", "maybe"])).toThrow(/allow or deny/);
    expect(() => parseChannels(["grant", "g1", "room", "-100"])).toThrow(/takes a connection, room or contact/);
    expect(parseChannels(["grants", "g1"])).toMatchObject({ channels: { action: "grants", target: "g1", grantsOp: "list" } });
    expect(parseChannels(["grants", "g1", "revoke", "grant-1"])).toMatchObject({ channels: { grantsOp: "revoke", grantId: "grant-1" } });
    expect(() => parseChannels(["grants", "g1", "revoke"])).toThrow(/takes one grant id/);
    expect(() => parseChannels(["rooms", "g1", "add"])).toThrow(/takes one room id/);
    expect(() => parseChannels(["rooms", "g1", "add", "-1", "--trigger", "any"])).toThrow(/--trigger takes/);
    expect(() => parseChannels(["rooms", "g1", "remove", "-1", "--label", "x"])).toThrow(/takes no room settings/);
    expect(() => parseChannels(["rooms", "g1", "list", "-1"])).toThrow(/takes no room/);
    expect(() => parseChannels(["rooms"])).toThrow(/names the connection/);
  });

  it("asks the owner for the room's op and prints each room and room waiting with the platform's text made printable", async () => {
    const asked: unknown[] = [];
    let stdout = "";
    let stderr = "";
    const answer = {
      rooms: [
        {
          connectionId: "g1",
          conversationId: "-100",
          workspaceId: "w1",
          label: "Team",
          trigger: ["mention"],
          members: "bound",
          context: "off",
          introState: "pending",
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      waiting: [{ conversationId: "-300", by: "9\u001b]0;owned\u0007", roomName: "Evil\nroom", how: "added", at: AT }],
      drops: { "not-addressed": 2 },
      details: { "-100": "the bot lacks a permission\nit needs" },
      notApplied: "the introduction was not sent: forbidden",
    };
    const ask = async <T>(payload: unknown): Promise<T> => {
      asked.push(payload);
      return answer as T;
    };
    await runChannelsCli(
      {
        action: "rooms",
        target: "g1",
        roomOp: "add",
        conversationId: "-100",
        trigger: ["mention"],
        settings: {},
        secretFiles: {},
        workspaceId: "w1",
        format: "text",
      },
      ask,
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    expect(asked).toEqual([
      { action: "rooms", workspaceId: "w1", connectionId: "g1", op: "add", conversationId: "-100", trigger: ["mention"] },
    ]);
    expect(stdout).toBe(
      "-100\tTeam\tmention me\tbound\tintroduction not sent\tlast send refused: the bot lacks a permission it needs\nwaiting\t-300\tadded by 9 (Evil room)\ndropped: not-addressed 2\n",
    );
    expect(stderr).toBe("note: the room is listed, but the introduction was not sent: forbidden\n");
  });
});
