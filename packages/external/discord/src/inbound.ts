import type { AddressKind, InboundEvent } from "@tavi/contracts";
import type { z as Zod } from "zod";

import { commandMessage, commandSchema, type DiscordCommandInteraction } from "./commands.js";

/**
 * What a Discord dispatch says, as Tavi's inbound events. Every payload is read
 * with `safeParse` against the slices below, built from the host's own `z`
 * (`ctx.z`), so the bundle carries no schema library; one that fails is
 * dropped and counted. The connector reports how a message addressed the
 * agent, who wrote it and what it quotes; it decides nothing about who the
 * sender is to Tavi.
 */

export interface DiscordSchemas {
  readonly message: Zod.ZodType<DiscordMessage>;
  readonly componentInteraction: Zod.ZodType<DiscordComponentInteraction>;
  readonly guild: Zod.ZodType<DiscordGuild>;
  readonly thread: Zod.ZodType<DiscordThread>;
  readonly command: Zod.ZodType<DiscordCommandInteraction>;
}

/** A thread (a channel of type 10, 11 or 12): the room it is a thread of, and who started it. */
export interface DiscordThread {
  readonly id: string;
  readonly type: number;
  readonly guild_id?: string | undefined;
  readonly parent_id: string;
  readonly owner_id?: string | undefined;
}

interface DiscordUser {
  readonly id: string;
  readonly bot?: boolean | undefined;
  readonly username?: string | undefined;
  readonly global_name?: string | null | undefined;
}

export interface DiscordMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string | undefined;
  readonly type: number;
  readonly author: DiscordUser;
  readonly content: string;
  readonly timestamp?: string | undefined;
  readonly webhook_id?: string | undefined;
  readonly mentions: readonly DiscordUser[];
  readonly mention_roles: readonly string[];
  /** `type` 0 (or absent) is a reply; 1 is a forward, which replies to nothing. */
  readonly message_reference?:
    | { readonly type?: number | undefined; readonly message_id?: string | undefined; readonly channel_id?: string | undefined }
    | undefined;
  readonly referenced_message?: { readonly id: string; readonly author: DiscordUser } | null | undefined;
  /** Its files, each with a signed link on Discord's CDN that expires. */
  readonly attachments?: readonly DiscordAttachment[] | undefined;
}

interface DiscordAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly content_type?: string | undefined;
  readonly url: string;
}

interface DiscordComponentInteraction {
  readonly id: string;
  readonly application_id: string;
  readonly type: 3;
  readonly token: string;
  readonly channel_id: string;
  readonly guild_id?: string | undefined;
  readonly member?: { readonly user: DiscordUser } | undefined;
  readonly user?: DiscordUser | undefined;
  readonly message: { readonly id: string };
  readonly data: { readonly custom_id: string; readonly component_type: number };
}

export interface DiscordGuild {
  readonly id: string;
  readonly name?: string | undefined;
  /** When the bot joined: the same server's membership redelivered keeps one key. */
  readonly joined_at?: string | undefined;
  readonly system_channel_id?: string | null | undefined;
  readonly unavailable?: boolean | undefined;
  readonly channels?:
    | readonly { readonly id: string; readonly type: number; readonly name?: string | undefined; readonly position?: number | undefined }[]
    | undefined;
  readonly roles?:
    | readonly {
        readonly id: string;
        readonly permissions?: string | undefined;
        readonly tags?: { readonly bot_id?: string | undefined } | undefined;
      }[]
    | undefined;
  /** The guild's active threads, which GUILD_CREATE lists. */
  readonly threads?: readonly DiscordThread[] | undefined;
}

/** The Gateway payload slices, from the host's `z`. */
export function discordSchemas(z: typeof Zod): DiscordSchemas {
  const Snowflake = z.string().regex(/^[1-9]\d{16,19}$/);
  // A webhook's name, which a message's author carries, is up to 80 characters.
  const DiscordUser = z.object({
    id: Snowflake,
    bot: z.boolean().optional(),
    username: z.string().max(80).optional(),
    global_name: z.string().max(80).nullable().optional(),
  });
  const attachment = z
    .object({
      id: Snowflake,
      filename: z.string().min(1).max(255),
      size: z.number().int().nonnegative(),
      content_type: z.string().max(255).optional(),
      url: z.string().url().max(2048),
    })
    .passthrough();
  const message = z
    .object({
      id: Snowflake,
      channel_id: Snowflake,
      guild_id: Snowflake.optional(),
      type: z.number().int(),
      author: DiscordUser,
      content: z.string().max(4000),
      timestamp: z.string().max(64).optional(),
      webhook_id: Snowflake.optional(),
      mentions: z.array(DiscordUser).max(100),
      mention_roles: z.array(Snowflake).max(250),
      message_reference: z
        .object({ type: z.number().int().optional(), message_id: Snowflake.optional(), channel_id: Snowflake.optional() })
        .optional(),
      referenced_message: z.object({ id: Snowflake, author: DiscordUser }).passthrough().nullable().optional(),
      // An attachment that does not parse is left out, never the message with it.
      attachments: z
        .array(z.unknown())
        .max(10)
        .optional()
        .transform((attachments) =>
          attachments?.flatMap((candidate) => {
            const parsed = attachment.safeParse(candidate);
            return parsed.success ? [parsed.data] : [];
          }),
        ),
    })
    .passthrough();
  const componentInteraction = z
    .object({
      id: Snowflake,
      application_id: Snowflake,
      type: z.literal(3),
      token: z.string().min(1).max(500),
      channel_id: Snowflake,
      guild_id: Snowflake.optional(),
      member: z.object({ user: DiscordUser }).optional(),
      user: DiscordUser.optional(),
      message: z.object({ id: Snowflake }),
      data: z.object({ custom_id: z.string().max(100), component_type: z.number().int() }),
    })
    .refine((interaction) => (interaction.member?.user ?? interaction.user) !== undefined, "an interaction names its user");
  const thread = z
    .object({
      id: Snowflake,
      type: z
        .number()
        .int()
        .refine((type) => THREAD_CHANNEL_TYPES.has(type), "a thread's type"),
      guild_id: Snowflake.optional(),
      parent_id: Snowflake,
      owner_id: Snowflake.optional(),
    })
    .passthrough();
  const guild = z
    .object({
      id: Snowflake,
      name: z.string().max(100).optional(),
      joined_at: z.string().max(64).optional(),
      system_channel_id: Snowflake.nullable().optional(),
      unavailable: z.boolean().optional(),
      channels: z
        .array(
          z
            .object({ id: Snowflake, type: z.number().int(), name: z.string().max(100).optional(), position: z.number().int().optional() })
            .passthrough(),
        )
        .max(500)
        .optional(),
      roles: z
        .array(
          z
            .object({
              id: Snowflake,
              permissions: z
                .string()
                .regex(/^\d{1,20}$/)
                .optional(),
              tags: z.object({ bot_id: Snowflake.optional() }).passthrough().optional(),
            })
            .passthrough(),
        )
        .max(250)
        .optional(),
      // A thread that does not parse is left out, never the guild with it.
      threads: z
        .array(z.unknown())
        .max(1000)
        .optional()
        .transform((threads) =>
          threads?.flatMap((candidate) => {
            const parsed = thread.safeParse(candidate);
            return parsed.success ? [parsed.data] : [];
          }),
        ),
    })
    .passthrough();
  return { message, componentInteraction, guild, thread, command: commandSchema(z) };
}

/** What the connector knows when it maps an event: who the bot is, and each guild's role that names it. */
export interface InboundContext {
  readonly connectionId: string;
  readonly applicationId: string;
  readonly botUserId: string;
  /** Each guild's managed role for the bot, which a role mention of it names. */
  readonly botRoleOf: (guildId: string) => string | undefined;
  /** The thread a channel is, when it is one the connector knows. */
  readonly threadOf?: (channelId: string) => { readonly parentId: string; readonly ownerId?: string | undefined } | undefined;
  readonly now: () => string;
}

/** Message types a person writes: a message and a reply. Any other is the platform's (a join, a pin, a boost). */
const PERSON_TYPES = new Set([0, 19]);

/** A text channel and an announcement channel: what a room can be. */
export const ROOM_CHANNEL_TYPES = new Set([0, 5]);

/** An announcement thread, a public thread and a private thread: each a thread of a room. */
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

/**
 * Where a channel's message is: a room or DM channel itself, or a thread of a
 * room, which is the room's conversation with the thread as its topic,
 * so it inherits the room's policy.
 */
function placeOf(
  channelId: string,
  guildId: string | undefined,
  context: InboundContext,
): {
  readonly place: Pick<InboundEvent, "externalConversationId" | "externalThreadId" | "threadIsTopic" | "conversationKind">;
  readonly botThread: boolean;
} {
  const thread = guildId === undefined ? undefined : context.threadOf?.(channelId);
  if (thread === undefined)
    return { place: { externalConversationId: channelId, conversationKind: guildId === undefined ? "direct" : "group" }, botThread: false };
  return {
    place: { externalConversationId: thread.parentId, externalThreadId: channelId, threadIsTopic: true, conversationKind: "thread" },
    botThread: thread.ownerId !== undefined && thread.ownerId === context.botUserId,
  };
}

/** The leading mention of the bot (`<@id>`, `<@!id>`) or its role (`<@&role>`), taken off the text: the host never parses markup. */
function withoutLeadingMention(content: string, botUserId: string, botRole: string | undefined): string {
  const forms = [`<@${botUserId}>`, `<@!${botUserId}>`, ...(botRole === undefined ? [] : [`<@&${botRole}>`])];
  const trimmed = content.trimStart();
  const leading = forms.find((form) => trimmed.startsWith(form));
  return leading === undefined ? content : trimmed.slice(leading.length).trimStart();
}

/** An attachment's handle: where it is, so its link can be read again once it expires. */
function attachmentRef(channelId: string, messageId: string, attachmentId: string): string {
  return `${channelId}/${messageId}/${attachmentId}`;
}

/** Who wrote a message, as Discord says: a webhook's or a bot's, a person's (a message or a reply), or the platform's. */
export function authorKindOf(message: Pick<DiscordMessage, "webhook_id" | "author" | "type">): "bot" | "person" | "system" {
  return message.webhook_id !== undefined || message.author.bot === true ? "bot" : PERSON_TYPES.has(message.type) ? "person" : "system";
}

/** A message's time as ISO, or `fallback` when Discord gave none that reads. */
export function timeOf(timestamp: string | undefined, fallback: string): string {
  return timestamp !== undefined && !Number.isNaN(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : fallback;
}

function messageEvent(message: DiscordMessage, context: InboundContext): InboundEvent {
  const now = context.now();
  const botRole = message.guild_id === undefined ? undefined : context.botRoleOf(message.guild_id);
  const authorKind = authorKindOf(message);
  const addressed: AddressKind[] = [];
  if (message.mentions.some((user) => user.id === context.botUserId) || (botRole !== undefined && message.mention_roles.includes(botRole)))
    addressed.push("mention");
  // A reply only: a forward (reference type 1) points at a message elsewhere and replies to nothing.
  const reply = (message.message_reference?.type ?? 0) === 0;
  const parent = reply ? (message.referenced_message ?? undefined) : undefined;
  if (parent !== undefined && parent.author.id === context.botUserId) addressed.push("reply");
  const { place, botThread } = placeOf(message.channel_id, message.guild_id, context);
  // Any message in a thread the bot started for a task is addressed to it there.
  if (botThread) addressed.push("thread");
  const content = addressed.includes("mention") ? withoutLeadingMention(message.content, context.botUserId, botRole) : message.content;
  const replyTo = reply ? (message.message_reference?.message_id ?? parent?.id) : undefined;
  return {
    connectionId: context.connectionId,
    providerEventId: `app:${context.applicationId}:msg:${message.channel_id}:${message.id}`,
    kind: "message",
    externalSenderId: message.author.id,
    ...place,
    externalMessageId: message.id,
    ...(replyTo === undefined ? {} : { externalReplyToId: replyTo }),
    occurredAt: timeOf(message.timestamp, now),
    receivedAt: now,
    ...(content === "" ? {} : { content }),
    // Handles the host takes in, for an allowed sender only; the link itself stays with the connector.
    ...(message.attachments === undefined || message.attachments.length === 0
      ? {}
      : {
          media: message.attachments.map((attachment) => ({
            ref: attachmentRef(message.channel_id, message.id, attachment.id),
            filename: attachment.filename,
            ...(attachment.content_type === undefined ? {} : { mimeType: attachment.content_type }),
            sizeBytes: attachment.size,
          })),
        }),
    ...(addressed.length === 0 ? {} : { addressed }),
    authorKind,
    // Someone else's message this one replies to: its author's, and without Message Content Discord withholds its text.
    ...(parent !== undefined && parent.author.id !== context.botUserId
      ? { referenced: { externalSenderId: parent.author.id, externalMessageId: parent.id, via: "reply" as const } }
      : {}),
  };
}

/** A command: a message of its user's, addressed as a command or picking another message, in the channel it was used in. */
function commandEvent(
  interaction: DiscordCommandInteraction,
  message: Pick<InboundEvent, "content" | "addressed" | "referenced">,
  context: InboundContext,
): InboundEvent {
  const now = context.now();
  return {
    connectionId: context.connectionId,
    providerEventId: `app:${context.applicationId}:ix:${interaction.id}`,
    kind: "message",
    // Discord's own account of who used it.
    externalSenderId: (interaction.member?.user ?? interaction.user)?.id ?? "",
    ...placeOf(interaction.channel_id, interaction.guild_id, context).place,
    occurredAt: now,
    receivedAt: now,
    ...message,
    authorKind: "person",
  };
}

function componentEvent(interaction: DiscordComponentInteraction, context: InboundContext): InboundEvent {
  const now = context.now();
  // Discord's own account of who pressed: the data says nothing of who.
  const presser = (interaction.member?.user ?? interaction.user)?.id ?? "";
  return {
    connectionId: context.connectionId,
    providerEventId: `app:${context.applicationId}:ix:${interaction.id}`,
    kind: "interaction",
    externalSenderId: presser,
    ...placeOf(interaction.channel_id, interaction.guild_id, context).place,
    externalMessageId: interaction.message.id,
    occurredAt: now,
    receivedAt: now,
    interaction: { data: interaction.data.custom_id, callbackId: interaction.id, messageId: interaction.message.id },
  };
}

/**
 * The bot added to a server: a membership event whose room is the
 * server's system channel, or its first text channel, for the operator's
 * pairing item to offer. `by` is unknown to the Gateway, so the bot names itself.
 */
export function membershipEvent(guild: DiscordGuild, change: "added" | "removed", context: InboundContext): InboundEvent | undefined {
  const textChannels = (guild.channels ?? [])
    .filter((channel) => ROOM_CHANNEL_TYPES.has(channel.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const room = guild.system_channel_id ?? textChannels[0]?.id;
  if (room === undefined) return undefined;
  const now = context.now();
  return {
    connectionId: context.connectionId,
    // Keyed by when it joined, so a redelivered join is the same event; a removal by when it was seen.
    providerEventId: `app:${context.applicationId}:guild:${guild.id}:${change}:${change === "added" ? (guild.joined_at ?? now) : now}`,
    kind: "membership",
    externalSenderId: context.botUserId,
    externalConversationId: room,
    conversationKind: "group",
    occurredAt: now,
    receivedAt: now,
    membership: { change, ...(guild.name === undefined ? {} : { roomName: guild.name.slice(0, 120) }) },
  };
}

/** What one dispatch gives the host: an event, or why nothing (a shape that does not parse is counted, not logged). */
export type Mapped =
  | {
      readonly event: InboundEvent;
      readonly interaction?: { readonly id: string; readonly token: string; readonly command?: true };
      readonly attachments?: readonly { readonly ref: string; readonly url: string }[];
    }
  | { readonly dropped: "unparsed" | "ignored" };

/** A `MESSAGE_CREATE` or `INTERACTION_CREATE` dispatch as an event; every other type is the connector's own to read. */
export function eventOf(type: string, data: unknown, schemas: DiscordSchemas, context: InboundContext): Mapped {
  if (type === "MESSAGE_CREATE") {
    const parsed = schemas.message.safeParse(data);
    if (!parsed.success) return { dropped: "unparsed" };
    const links = (parsed.data.attachments ?? []).map((attachment) => ({
      ref: attachmentRef(parsed.data.channel_id, parsed.data.id, attachment.id),
      url: attachment.url,
    }));
    return { event: messageEvent(parsed.data, context), ...(links.length === 0 ? {} : { attachments: links }) };
  }
  if (type === "INTERACTION_CREATE") {
    const type = (data as { readonly type?: unknown } | null)?.type;
    if (type === 2) {
      const parsed = schemas.command.safeParse(data);
      if (!parsed.success) return { dropped: "unparsed" };
      const message = commandMessage(parsed.data);
      // A command with nothing to ask (a menu use whose message Discord did not deliver, an empty question): nothing for the host.
      return message === undefined
        ? { dropped: "ignored" }
        : {
            event: commandEvent(parsed.data, message, context),
            interaction: { id: parsed.data.id, token: parsed.data.token, command: true },
          };
    }
    // A button press (a component, type 3); anything else (an autocomplete, a modal) Tavi does not use.
    if (type !== 3) return { dropped: "ignored" };
    const parsed = schemas.componentInteraction.safeParse(data);
    // Its id and token, as parsed: what the connector acknowledges the press with, and answers it privately through.
    return parsed.success
      ? { event: componentEvent(parsed.data, context), interaction: { id: parsed.data.id, token: parsed.data.token } }
      : { dropped: "unparsed" };
  }
  return { dropped: "ignored" };
}
