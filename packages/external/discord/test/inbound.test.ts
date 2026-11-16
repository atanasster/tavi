import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { discordSchemas, eventOf, membershipEvent, type InboundContext } from "../src/inbound.js";
import { DISCORD_CHANNEL_DESCRIPTOR } from "../src/descriptor.js";

/** Discord's dispatches as inbound events. */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")) as unknown;
const BOT = "900000000000000001";
const APP = "900000000000000002";
const ROOM = "710000000000000001";
const DM = "720000000000000001";
const OP = "800000000000000001";
const BOB = "800000000000000002";
const NOW = "2026-10-18T09:10:00.000Z";
const context: InboundContext = {
  connectionId: "discord-1",
  applicationId: APP,
  botUserId: BOT,
  botRoleOf: (guild) => (guild === "700000000000000001" ? "730000000000000001" : undefined),
  now: () => NOW,
};
const schemas = discordSchemas(z);
const mapped = (type: string, name: string) => {
  const result = eventOf(type, fixture(name), schemas, context);
  if (!("event" in result)) throw new Error(`${name}: ${result.dropped}`);
  return result.event;
};

const THREAD = "712000000000000001";
const BOT_THREAD = "712000000000000002";
const threaded: InboundContext = {
  ...context,
  threadOf: (channel) =>
    channel === THREAD ? { parentId: ROOM, ownerId: OP } : channel === BOT_THREAD ? { parentId: ROOM, ownerId: BOT } : undefined,
};

describe("Discord threads", () => {
  it("maps a thread's message to its room, with the thread as its topic", () => {
    const result = eventOf("MESSAGE_CREATE", fixture("message-thread"), schemas, threaded);
    if (!("event" in result)) throw new Error(result.dropped);
    expect(result.event).toMatchObject({
      externalConversationId: ROOM,
      externalThreadId: THREAD,
      threadIsTopic: true,
      conversationKind: "thread",
      addressed: ["mention"],
      content: "and in here?",
      providerEventId: `app:${APP}:msg:${THREAD}:740000000000000301`,
    });
  });

  it("addresses any message in a thread the bot started, and maps a press there to the room", () => {
    const plain = {
      ...(fixture("message-thread") as Record<string, unknown>),
      channel_id: BOT_THREAD,
      content: "what about Friday?",
      mentions: [],
    };
    const result = eventOf("MESSAGE_CREATE", plain, schemas, threaded);
    if (!("event" in result)) throw new Error(result.dropped);
    expect(result.event).toMatchObject({
      externalConversationId: ROOM,
      externalThreadId: BOT_THREAD,
      addressed: ["thread"],
      content: "what about Friday?",
    });
    const press = eventOf(
      "INTERACTION_CREATE",
      { ...(fixture("interaction-button-member") as Record<string, unknown>), channel_id: BOT_THREAD },
      schemas,
      threaded,
    );
    if (!("event" in press)) throw new Error(press.dropped);
    expect(press.event).toMatchObject({ externalConversationId: ROOM, externalThreadId: BOT_THREAD, conversationKind: "thread" });
  });

  it("reads a thread channel, and refuses a channel of another type as one", () => {
    expect(schemas.thread.safeParse(fixture("thread-create")).success).toBe(true);
    expect(schemas.thread.safeParse({ ...(fixture("thread-create") as Record<string, unknown>), type: 0 }).success).toBe(false);
    // A guild keeps its parseable threads, and is kept with an unparseable one.
    const guild = schemas.guild.safeParse({
      ...(fixture("guild-create") as Record<string, unknown>),
      threads: [fixture("thread-create"), { id: "x" }],
    });
    expect(guild.success && guild.data.threads?.map((thread) => thread.id)).toEqual([BOT_THREAD]);
  });
});

describe("Discord attachments", () => {
  it("names each file as a handle, and leaves out one that does not parse, never the message", () => {
    const file = {
      id: "743000000000000001",
      filename: "plan.pdf",
      size: 5,
      content_type: "application/pdf",
      url: "https://cdn.discordapp.com/attachments/1/2/plan.pdf",
    };
    const result = eventOf(
      "MESSAGE_CREATE",
      {
        ...(fixture("message-room-mention") as Record<string, unknown>),
        attachments: [file, { ...file, id: "743000000000000002", filename: "x".repeat(300) }],
      },
      schemas,
      context,
    );
    if (!("event" in result)) throw new Error(result.dropped);
    expect(result.event.media).toEqual([
      { ref: `${ROOM}/740000000000000002/743000000000000001`, filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 5 },
    ]);
    expect(result.event.content).toBe("what's on today?");
    expect(result.attachments).toEqual([{ ref: `${ROOM}/740000000000000002/743000000000000001`, url: file.url }]);
  });

  it("keeps a .mov from a phone, a type the channel takes", () => {
    const file = {
      id: "743000000000000003",
      filename: "IMG_0001.MOV",
      size: 2048,
      content_type: "video/quicktime",
      url: "https://cdn.discordapp.com/attachments/1/2/IMG_0001.MOV",
    };
    const result = eventOf(
      "MESSAGE_CREATE",
      { ...(fixture("message-room-mention") as Record<string, unknown>), attachments: [file] },
      schemas,
      context,
    );
    if (!("event" in result)) throw new Error(result.dropped);
    expect(result.event.media).toEqual([
      { ref: `${ROOM}/740000000000000002/743000000000000003`, filename: "IMG_0001.MOV", mimeType: "video/quicktime", sizeBytes: 2048 },
    ]);
    for (const type of ["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-matroska"])
      expect(DISCORD_CHANNEL_DESCRIPTOR.media?.mimeTypes).toContain(type);
  });
});

describe("Discord inbound mapping", () => {
  it("maps a DM to a direct conversation in its own channel, from its author", () => {
    expect(mapped("MESSAGE_CREATE", "message-dm")).toEqual({
      connectionId: "discord-1",
      providerEventId: `app:${APP}:msg:${DM}:740000000000000001`,
      kind: "message",
      externalSenderId: OP,
      externalConversationId: DM,
      conversationKind: "direct",
      externalMessageId: "740000000000000001",
      occurredAt: "2026-10-18T09:00:00.000Z",
      receivedAt: NOW,
      content: "hello there",
      authorKind: "person",
    });
  });

  it("reports a mention of the bot, or of its role, and takes the leading mention off the text", () => {
    expect(mapped("MESSAGE_CREATE", "message-room-mention")).toMatchObject({
      conversationKind: "group",
      externalConversationId: ROOM,
      addressed: ["mention"],
      content: "what's on today?",
      authorKind: "person",
    });
    expect(mapped("MESSAGE_CREATE", "message-room-role-mention")).toMatchObject({ addressed: ["mention"], content: "and you?" });
  });

  it("reports nothing addressed for a plain room message, whose withheld text is absent", () => {
    const plain = mapped("MESSAGE_CREATE", "message-room-plain");
    expect(plain).not.toHaveProperty("addressed");
    expect(plain).not.toHaveProperty("content");
    expect(plain).toMatchObject({ externalSenderId: BOB, authorKind: "person" });
  });

  it("reports a reply to the bot as addressed, and another member's message replied to as theirs, without its text", () => {
    expect(mapped("MESSAGE_CREATE", "message-reply-to-bot")).toMatchObject({
      addressed: ["mention", "reply"],
      externalReplyToId: "740000000000000100",
      content: "yes, do that",
    });
    const quoting = mapped("MESSAGE_CREATE", "message-reply-to-member");
    expect(quoting).toMatchObject({
      addressed: ["mention"],
      content: "what do you make of this?",
      referenced: { externalSenderId: BOB, externalMessageId: "740000000000000101", via: "reply" },
    });
    expect(quoting.referenced).not.toHaveProperty("content");
  });

  it("says a bot's, a webhook's and the platform's messages are theirs", () => {
    expect(mapped("MESSAGE_CREATE", "message-bot-author").authorKind).toBe("bot");
    expect(mapped("MESSAGE_CREATE", "message-webhook").authorKind).toBe("bot");
    expect(mapped("MESSAGE_CREATE", "message-system").authorKind).toBe("system");
  });

  it("names a press's sender as Discord's presser, whatever its data claims", () => {
    expect(mapped("INTERACTION_CREATE", "interaction-button-owner")).toMatchObject({
      kind: "interaction",
      externalSenderId: OP,
      conversationKind: "direct",
      providerEventId: `app:${APP}:ix:760000000000000001`,
      interaction: { data: "r:abcd1234:o", callbackId: "760000000000000001", messageId: "740000000000000200" },
    });
    expect(mapped("INTERACTION_CREATE", "interaction-button-member")).toMatchObject({ externalSenderId: BOB, conversationKind: "group" });
  });

  it("drops and counts a payload that does not parse, and ignores a dispatch it does not read", () => {
    expect(eventOf("MESSAGE_CREATE", { id: "nope" }, schemas, context)).toEqual({ dropped: "unparsed" });
    expect(
      eventOf("MESSAGE_CREATE", { ...(fixture("message-dm") as object), author: { id: "not-a-snowflake" } }, schemas, context),
    ).toEqual({ dropped: "unparsed" });
    expect(eventOf("INTERACTION_CREATE", { type: 2 }, schemas, context)).toEqual({ dropped: "unparsed" });
    // An autocomplete (4) or a modal (5): nothing Tavi uses.
    expect(eventOf("INTERACTION_CREATE", { type: 4 }, schemas, context)).toEqual({ dropped: "ignored" });
    expect(eventOf("TYPING_START", {}, schemas, context)).toEqual({ dropped: "ignored" });
  });

  it("names a joined server's system channel for the operator's pairing item", () => {
    const guild = schemas.guild.parse(fixture("guild-create"));
    expect(membershipEvent(guild, "added", context)).toMatchObject({
      kind: "membership",
      externalConversationId: ROOM,
      conversationKind: "group",
      membership: { change: "added", roomName: "Fixture Guild" },
    });
    expect(membershipEvent({ ...guild, system_channel_id: null }, "added", context)?.externalConversationId).toBe(ROOM);
    expect(membershipEvent({ id: "700000000000000009", channels: [] }, "added", context)).toBeUndefined();
  });

  it("strips a <@!id> mention, leaves one in mid-text, and takes a reply whose parent was deleted", () => {
    const base = fixture("message-room-mention") as Record<string, unknown>;
    expect(eventOf("MESSAGE_CREATE", { ...base, content: `<@!${BOT}> hi` }, schemas, context)).toMatchObject({
      event: { content: "hi", addressed: ["mention"] },
    });
    expect(eventOf("MESSAGE_CREATE", { ...base, content: `so <@${BOT}> says hi` }, schemas, context)).toMatchObject({
      event: { content: `so <@${BOT}> says hi`, addressed: ["mention"] },
    });
    const deleted = eventOf(
      "MESSAGE_CREATE",
      { ...(fixture("message-reply-to-member") as object), referenced_message: null },
      schemas,
      context,
    );
    expect(deleted).toMatchObject({ event: { externalReplyToId: "740000000000000101" } });
    expect("event" in deleted && deleted.event.referenced).toBeUndefined();
  });

  it("takes a forward for no reply", () => {
    const forward = eventOf(
      "MESSAGE_CREATE",
      {
        ...(fixture("message-reply-to-bot") as object),
        mentions: [],
        message_reference: { type: 1, message_id: "740000000000000100", channel_id: "710000000000000009" },
      },
      schemas,
      context,
    );
    expect("event" in forward && forward.event.addressed).toBeUndefined();
    expect("event" in forward && forward.event.externalReplyToId).toBeUndefined();
  });

  it("hands the connector a press's parsed id and token", () => {
    expect(eventOf("INTERACTION_CREATE", fixture("interaction-button-owner"), schemas, context)).toMatchObject({
      interaction: { id: "760000000000000001", token: "aW50ZXJhY3Rpb246NzYwMDAwMDAwMDAwMDAwMDAx" },
    });
  });

  it("falls back to the server's first text channel by position, keys a join by when it was, and maps a removal", () => {
    const guild = schemas.guild.parse({
      ...(fixture("guild-create") as object),
      system_channel_id: null,
      joined_at: "2026-10-18T08:00:00.000000+00:00",
      channels: [
        { id: "710000000000000003", type: 0, position: 5 },
        { id: "710000000000000002", type: 2, position: 0 },
        { id: "710000000000000004", type: 0, position: 1 },
      ],
    });
    const added = membershipEvent(guild, "added", context);
    expect(added?.externalConversationId).toBe("710000000000000004");
    expect(added?.providerEventId).toBe(`app:${APP}:guild:700000000000000001:added:2026-10-18T08:00:00.000000+00:00`);
    expect(membershipEvent(guild, "removed", context)?.membership).toEqual({ change: "removed", roomName: "Fixture Guild" });
  });
});
