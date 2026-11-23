import { checkPartCount, notRunning, redactedError } from "@tavi/channel-kit";
import {
  TaviError,
  type ChannelHostServices,
  type ChannelRoomListing,
  type InboundEvent,
  type MessagingIngestHooks,
  type MessagingIngestReceipt,
  type MessagingConnection,
  type MessagingConnectionStatus,
  type MessagingConnectorDefinition,
  type MessagingConnectorInstance,
  type MessagingCredentials,
  type MessagingInboundHandler,
  type OutboundFilePart,
  type OutboundMessage,
  type OutboundMessagePart,
  type SendOutcome,
} from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import type { z as Zod } from "zod";

import { DISCORD_CAPABILITIES } from "./descriptor.js";
import {
  DISCORD_INTENTS,
  Gateway,
  MESSAGE_CONTENT_INTENT,
  type GatewayClock,
  type GatewayDispatch,
  type WebSocketFactory,
} from "./gateway.js";
import {
  discordSchemas,
  eventOf,
  membershipEvent,
  ROOM_CHANNEL_TYPES,
  type DiscordGuild,
  type DiscordThread,
  type InboundContext,
} from "./inbound.js";
import { commandAnswer, commandMessage, registerCommands } from "./commands.js";
import { fetchRecent, MESSAGE_CONTENT_FLAGS } from "./context.js";
import { createEvent, createPoll, endPoll, readPoll } from "./groups.js";
import { DiscordMedia } from "./media.js";
import { DiscordRest } from "./rest.js";
import type { RateLimitClock } from "./buckets.js";
import {
  DirectChannels,
  editText,
  fileNameOf,
  MAX_FILE_BYTES,
  openThread,
  refusedReceipt,
  sendText,
  SUPPRESS_EMBEDS,
  threadNameOf,
  type DiscordDestination,
  type SendInput,
} from "./send.js";

/**
 * Discord as a channel connector: REST for what it sends, the Gateway for what it hears. DMs and the
 * server channels the operator lists as rooms; a mention or a reply addresses
 * the agent; buttons, edits and a private answer to a press; a sender's DM
 * reached by their id. It reports and never decides: the host's room policy
 * drops what nobody addressed, and whoever Tavi does not know, before
 * anything is stored.
 */

/**
 * Permissions the invite asks for: view, send, read history, embed links,
 * attach files, send in threads (274878024704), and for polls and events
 * Create Events (1 << 44) and Send Polls (1 << 49).
 */
const INVITE_PERMISSIONS = "580817017490432";

/** What a room's polls and events need of the bot's role in its server, by name. */
const GROUP_PERMISSIONS: readonly { readonly name: string; readonly bit: bigint }[] = [
  { name: "Send Polls", bit: 1n << 49n },
  { name: "Create Events", bit: 1n << 44n },
];
/** Administrator: every permission. */
const ADMINISTRATOR = 1n << 3n;

export interface DiscordConnectorOptions {
  readonly z: typeof Zod;
  readonly version: string;
  readonly now?: () => string;
  readonly fetch?: typeof globalThis.fetch;
  /** The WebSocket the Gateway runs on: the global one, or a test's fake. */
  readonly webSocket?: WebSocketFactory;
  readonly gatewayClock?: GatewayClock;
  readonly restClock?: RateLimitClock;
  readonly requestTimeoutMs?: number;
  readonly apiBaseUrl?: string;
  /** An approved artifact of the sending workspace, at most `maxBytes` long: what a file part sends (`ctx.channelHost`). */
  readonly readArtifact?: ChannelHostServices["readArtifact"];
  /** The workspace's language, read as each command is answered: its private answers speak it (`bg`), English otherwise. */
  readonly locale?: () => string | undefined;
  /**
   * The plugin's own messages (`ctx.t`, its `locales/<lang>.json`): the status and setup words Settings → Channels
   * shows, in the workspace's language when it is not English. Absent, or a key with no message, the English.
   */
  readonly t?: (key: string, params?: Readonly<Record<string, string | number>>) => string;
}

const realGatewayClock: GatewayClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

/** A message's flag: seen by its presser alone. */
const EPHEMERAL = 1 << 6;

/** A press's answer token lives 15 minutes, and the map keeps at most 500. */
const INTERACTION_TTL_MS = 15 * 60 * 1000;
const INTERACTIONS_MAX = 500;
/** Threads remembered, the least recently seen evicted first: a thread forgotten is looked up again. */
const THREADS_MAX = 2000;
/** The application's privileged intents, by their flag bits (each in full or limited form). */
const PRIVILEGED_INTENTS: readonly { readonly name: string; readonly flags: number }[] = [
  { name: "Presence", flags: (1 << 12) | (1 << 13) },
  { name: "Server Members", flags: (1 << 14) | (1 << 15) },
];

const sentenceCase = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The privileged intents an application's flags turn on that Tavi does not use (Message Content, which a room's context needs, is said apart). */
function privilegedIntentsOf(flags: number): readonly string[] {
  return PRIVILEGED_INTENTS.filter((intent) => (flags & intent.flags) !== 0).map((intent) => `the ${intent.name} intent`);
}

/** A file part, as contracts' `isFilePart` tells it (a value the bundle cannot import: only `TaviError` is the host's). */
const isFilePart = (part: OutboundMessagePart): part is OutboundFilePart => part.kind === "file";

/**
 * Discord shows a bot typing for 10 s, and the host asks again every 4 s (for
 * Telegram's 5 s): a call within 5 s of the last is a repeat, so one in two is sent. A channel that refused it (no
 * permission there) is not asked again for 10 minutes.
 */
const TYPING_REPEAT_MS = 5000;
const TYPING_REFUSED_MS = 10 * 60 * 1000;
/** A channel read and found no thread (a voice channel's chat), or not read, is not read again for this long. */
const LOOKUP_AGAIN_MS = 10 * 60 * 1000;

export function createDiscordConnectorDefinition(options: DiscordConnectorOptions): MessagingConnectorDefinition {
  // One receiver per application across this owner: two connections of one bot would each take the other's events.
  const activeApplications = new Set<string>();
  // Each application's identifies in the last day, kept across its connections' stops and starts.
  const identifyLogs = new Map<string, number[]>();
  const schemas = discordSchemas(options.z);
  const DestinationSchema = options.z.union([
    options.z.object({
      channelId: options.z.string().regex(/^\d{16,20}$/),
      replyTo: options.z.string().optional(),
      openFrom: options.z
        .object({ channelId: options.z.string().regex(/^\d{16,20}$/), messageId: options.z.string().regex(/^\d{16,20}$/) })
        .optional(),
    }),
    options.z.object({ dmUserId: options.z.string().regex(/^\d{16,20}$/), replyTo: options.z.string().optional() }),
  ]);
  const parseDestination = (destination: unknown, what: string): DiscordDestination => {
    const parsed = DestinationSchema.safeParse(destination);
    if (!parsed.success) throw new TaviError("INVALID_INPUT", `Discord ${what} destination is invalid: it names a channelId or a dmUserId`);
    return parsed.data as DiscordDestination;
  };
  return {
    providerId: "discord",
    version: options.version,
    configSchema: options.z.object({}).passthrough(),
    capabilities: DISCORD_CAPABILITIES,
    createConnection: ({ connection, credentials }) =>
      createInstance({ connection, credentials }, options, activeApplications, schemas, parseDestination, identifyLogs),
    // A reply goes back to the channel the message came in, a DM's own channel included.
    // In a thread, the thread itself: in Discord a thread is a channel of its own. A reply to the very
    // message a thread was opened from (a room's `autoThread`), or one naming no message, may be the
    // first send into a thread not open yet: it opens it from that message, which shares the thread's id.
    destinationFromInbound: (replyTo) =>
      replyTo.externalThreadId !== undefined &&
      (replyTo.externalMessageId === undefined || replyTo.externalThreadId === replyTo.externalMessageId)
        ? {
            channelId: replyTo.externalThreadId,
            openFrom: { channelId: replyTo.externalConversationId, messageId: replyTo.externalThreadId },
          }
        : {
            channelId: replyTo.externalThreadId ?? replyTo.externalConversationId,
            ...(replyTo.externalMessageId === undefined ? {} : { replyTo: replyTo.externalMessageId }),
          },
    // A thread opened from a room message takes that message's id.
    autoThreadOf: (event) =>
      event.kind === "message" && event.conversationKind === "group" && event.externalThreadId === undefined
        ? event.externalMessageId
        : undefined,
    // A sender's one-to-one chat, by their id: resolved to its DM channel when sent to.
    directDestinationOf: (externalSenderId) => ({ dmUserId: externalSenderId }),
    destinationFor: (target) =>
      target.to.startsWith("dm:")
        ? { dmUserId: target.to.slice(3) }
        : { channelId: target.threadId ?? target.to, ...(target.replyToId === undefined ? {} : { replyTo: target.replyToId }) },
    paceTargetOf: (destination) => {
      const value = destination as { readonly channelId?: unknown; readonly dmUserId?: unknown } | undefined;
      return typeof value?.channelId === "string"
        ? value.channelId
        : typeof value?.dmUserId === "string"
          ? `dm:${value.dmUserId}`
          : undefined;
    },
  };
}

interface GuildState {
  readonly name?: string | undefined;
  readonly channels: Map<string, string>;
  readonly botRole?: string | undefined;
  /**
   * What the bot's own role and everyone's (`@everyone`, the server's id) grant, by role: what the bot
   * lacks is said in its probe. A role a server's admin gave the bot besides is not seen (no member list
   * without a privileged intent), so the probe may warn of a permission granted that way.
   */
  readonly grants: ReadonlyMap<string, bigint>;
}

/** What a server grants the bot through its own role and everyone's; undefined before its own role is known. */
function botPermissionsOf(guildId: string, guild: GuildState): bigint | undefined {
  const own = guild.botRole === undefined ? undefined : guild.grants.get(guild.botRole);
  return own === undefined ? undefined : own | (guild.grants.get(guildId) ?? 0n);
}

function createInstance(
  input: {
    readonly connection: MessagingConnection;
    readonly credentials: MessagingCredentials;
  },
  options: DiscordConnectorOptions,
  activeApplications: Set<string>,
  schemas: ReturnType<typeof discordSchemas>,
  parseDestination: (destination: unknown, what: string) => DiscordDestination,
  identifyLogs: Map<string, number[]>,
): MessagingConnectorInstance {
  const { connection } = input;
  const now = options.now ?? nowTimestamp;
  const fetchImpl = options.fetch ?? ((url: string | URL | Request, init?: RequestInit) => globalThis.fetch(url, init));
  let token: string | undefined;
  let status: MessagingConnectionStatus = { state: "stopped", since: now() };
  let gateway: Gateway | undefined;
  let handler: MessagingInboundHandler | undefined;
  let applicationId = "";
  let botUserId = "";
  let ownedApplication: string | undefined;
  /** Set once start() has returned: nothing is handed to the host before (CHANNEL-PLUGINS.md). */
  let accepting: Promise<void> = new Promise(() => undefined);
  let readyAt = false;
  const guilds = new Map<string, GuildState>();
  /** Guilds the session's READY listed: their GUILD_CREATE is the bot coming back online, not joining. */
  const known = new Set<string>();
  const interactions = new Map<string, { readonly token: string; readonly at: number }>();
  /** Each interaction's acknowledgement as it arrived, by its id: awaited before the host answers it, and never sent twice. */
  const acknowledgements = new Map<string, Promise<boolean>>();
  /** Each known thread's room and who started it. */
  const threads = new Map<string, { readonly parentId: string; readonly ownerId?: string | undefined }>();
  /** When the bot last showed itself typing in each channel. */
  const typedAt = new Map<string, { readonly at: number; readonly refused: boolean }>();
  /** When each channel was last read and found no thread, bounded as `threads` is. */
  const notThreads = new Map<string, number>();
  let dropped = 0;
  /** The running connection's own background work, aborted by `stop`. */
  let run: AbortController | undefined;
  /** Whether the application's Message Content intent is on: without it, Discord gives no room's history. */
  let messageContent = false;
  /** Whether Discord has the bot's commands. */
  let commands: "unregistered" | "registering" | "registered" | "refused" = "unregistered";
  const rest = new DiscordRest({
    fetch: fetchImpl,
    token: () => token,
    version: options.version,
    onTripped: () => tripped(),
    onUnauthorized: () => unauthorized(),
    ...definedOnly({ clock: options.restClock, requestTimeoutMs: options.requestTimeoutMs, baseUrl: options.apiBaseUrl }),
  });
  const directs = new DirectChannels(rest);
  // The CDN is reached without the bot's token: its links are signed.
  const media = new DiscordMedia({ rest, fetch: (url, init) => fetchImpl(url, init), now: () => Date.parse(now()) });
  const context: InboundContext = {
    connectionId: connection.connectionId,
    get applicationId() {
      return applicationId;
    },
    get botUserId() {
      return botUserId;
    },
    botRoleOf: (guild) => guilds.get(guild)?.botRole,
    threadOf: (channel) => threads.get(channel),
    now,
  };

  /**
   * Discord refused over 1,000 requests in ten minutes: the connection
   * stops, failed, before Discord bans the bot's address; it takes nothing in
   * and sends nothing until it is opened again.
   */
  const tripped = (): void => {
    gateway?.stop();
    gateway = undefined;
    setStatus({
      state: "failed",
      detail: say(
        "status.tripped",
        "Discord refused too many requests in ten minutes: the connection stopped so the bot is not banned; open it again once the cause is fixed",
      ),
    });
  };

  /**
   * Discord refused the bot's token while it ran (a 401 on its own routes):
   * it was reset or revoked, and nothing more is asked with it. The
   * connection stops, failed, for its operator to paste a new one.
   */
  const unauthorized = (): void => {
    // While it starts, start() answers for itself, its own refusal naming the repair.
    if (status.state !== "running") return;
    gateway?.stop();
    gateway = undefined;
    setStatus({
      state: "failed",
      detail: say("status.revoked", "Discord no longer accepts the bot token: it was reset or revoked"),
      repair: "credentials",
    });
  };

  /**
   * Words a person reads in Settings → Channels (a status, a setup line): `key`'s message in the workspace's language,
   * or `english` when the language is English, or the pack has no message for it.
   */
  const say = (key: string, english: string, params?: Readonly<Record<string, string | number>>): string => {
    const locale = options.locale?.();
    if (options.t === undefined || locale === undefined || locale.toLowerCase().split(/[-_]/)[0] === "en") return english;
    const said = options.t(key, params);
    return said === key ? english : said;
  };

  const setStatus = (next: Omit<MessagingConnectionStatus, "since">): void => {
    status = { ...next, since: now() } as MessagingConnectionStatus;
  };

  const rememberThread = (thread: DiscordThread): void => {
    notThreads.delete(thread.id);
    threads.delete(thread.id);
    if (threads.size >= THREADS_MAX) {
      const oldest = threads.keys().next().value;
      if (oldest !== undefined) threads.delete(oldest);
    }
    threads.set(thread.id, { parentId: thread.parent_id, ownerId: thread.owner_id });
  };

  const remember = (guild: DiscordGuild): void => {
    const channels = new Map(
      (guild.channels ?? [])
        .filter((channel) => ROOM_CHANNEL_TYPES.has(channel.type))
        .map((channel) => [channel.id, channel.name ?? channel.id] as const),
    );
    const role = guild.roles?.find((candidate) => candidate.tags?.bot_id === botUserId);
    const grants = new Map(
      (guild.roles ?? [])
        .filter((candidate) => (candidate.id === role?.id || candidate.id === guild.id) && candidate.permissions !== undefined)
        .map((candidate) => [candidate.id, BigInt(candidate.permissions ?? "0")] as const),
    );
    guilds.set(guild.id, { name: guild.name, channels, botRole: role?.id, grants });
    for (const thread of guild.threads ?? []) rememberThread(thread);
  };

  /**
   * A guild channel the connector has not seen as a room or a thread: a
   * thread from before this session, looked up once so its message is the
   * room's. One that is not a thread, or cannot be read, stays a channel of its own.
   */
  const learnChannel = async (data: unknown): Promise<void> => {
    const fields = data as { readonly channel_id?: unknown; readonly guild_id?: unknown } | null;
    const channelId = fields?.channel_id;
    const guild = typeof fields?.guild_id === "string" ? guilds.get(fields.guild_id) : undefined;
    if (typeof channelId !== "string" || guild === undefined || guild.channels.has(channelId) || threads.has(channelId)) return;
    await lookUp(channelId);
  };

  /** Reads a channel once in a while: a thread is remembered, anything else (or no answer) not read again for a time. */
  const lookUp = async (channelId: string): Promise<boolean> => {
    const at = Date.parse(now());
    const last = notThreads.get(channelId);
    if (last !== undefined && at - last < LOOKUP_AGAIN_MS) return false;
    // Unread, the channel is not taken as a thread: the event's own fields decide.
    const answer = await rest.request<unknown>("GET", `/channels/${channelId}`).catch(() => undefined);
    const parsed = answer?.ok === true ? schemas.thread.safeParse(answer.body) : undefined;
    if (parsed?.success === true) {
      rememberThread(parsed.data);
      return true;
    }
    notThreads.delete(channelId);
    if (notThreads.size >= THREADS_MAX) {
      const oldest = notThreads.keys().next().value;
      if (oldest !== undefined) notThreads.delete(oldest);
    }
    notThreads.set(channelId, at);
    return false;
  };

  /** A file part's bytes, from the host, within what the bot sends; a refusal says why without the store's own words. */
  const readFile = async (
    artifactId: string,
    workspaceId: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | { readonly refused: string }> => {
    if (typeof artifactId !== "string" || artifactId === "") return { refused: "the file part names no artifact" };
    if (options.readArtifact === undefined) return { refused: "this Tavi gives the Discord channel no files to send" };
    // The host answers nothing for an artifact it will not release: refused below, as one it cannot read.
    const read = await options.readArtifact(artifactId, workspaceId, MAX_FILE_BYTES).catch(() => undefined);
    // The host answers nothing for an artifact it will not release, cannot read, or that is over the cap.
    if (read === undefined)
      return {
        refused: `artifact ${artifactId} is not available to send (unknown, not released, or over ${String(MAX_FILE_BYTES / 1024 / 1024)} MiB)`,
      };
    if (read.bytes.byteLength === 0) return { refused: `artifact ${artifactId} has no bytes` };
    if (read.bytes.byteLength > MAX_FILE_BYTES)
      return {
        refused: `artifact ${artifactId} is ${String(read.bytes.byteLength)} bytes, over the ${String(MAX_FILE_BYTES)} Discord takes from the bot`,
      };
    return read;
  };

  /**
   * The servers whose bot role lacks what polls and events need, in one probe
   * line of at most 200 characters, whatever their count: the account shows at
   * most six (the setup field). Names that do not fit are counted.
   */
  const lackingInServers = (): string[] => {
    const lacks = [...guilds.entries()].flatMap(([guildId, guild]) => {
      const granted = botPermissionsOf(guildId, guild);
      if (granted === undefined || (granted & ADMINISTRATOR) !== 0n) return [];
      const lacking = GROUP_PERMISSIONS.filter((permission) => (granted & permission.bit) === 0n).map((permission) => permission.name);
      return lacking.length === 0 ? [] : [`${(guild.name ?? say("setup.aServer", "a server")).slice(0, 40)} (${lacking.join(", ")})`];
    });
    if (lacks.length === 0) return [];
    const line = (shown: number): string => {
      const named = lacks.slice(0, shown).join("; ");
      const servers =
        lacks.length > shown
          ? say("setup.lacksMore", `${named} and ${String(lacks.length - shown)} more`, { servers: named, count: lacks.length - shown })
          : named;
      return say(
        "setup.lacks",
        `The bot lacks what polls and events need in ${named}${lacks.length > shown ? ` and ${String(lacks.length - shown)} more` : ""}: invite it again with the link below.`,
        { servers },
      );
    };
    let shown = Math.min(3, lacks.length);
    while (shown > 1 && line(shown).length > 200) shown -= 1;
    return [line(shown)];
  };

  /**
   * Opens the thread a destination names from its room message, when it is
   * not open yet (a room's `autoThread`); answers the refusal of what was to
   * go into it, or nothing once it is open. A thread already open (one this
   * run has not seen: after a restart, or a person's) is taken as it is.
   */
  const threadOpened = async (destination: DiscordDestination, name: string): Promise<SendOutcome | undefined> => {
    if (
      !("channelId" in destination) ||
      destination.openFrom === undefined ||
      threads.has(destination.channelId) ||
      (await lookUp(destination.channelId))
    )
      return undefined;
    // Nothing goes until its thread is open. Opening again is safe (Discord's 160004 is taken as open), so a failure that may pass is retried.
    const refused = await openThread(rest, destination.openFrom, name).catch((error: unknown) => redactedError(error, [token]));
    if (typeof refused === "string")
      return {
        status: "rejected",
        retryable: true,
        parts: [{ index: 0, status: "rejected", error: `the thread could not be opened: ${refused}` }],
      };
    if (refused !== undefined) {
      const { retryAfterMs, ...receipt } = refusedReceipt(0, refused, true);
      return {
        status: "rejected",
        retryable: retryAfterMs !== undefined || refused.status >= 500,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        parts: [{ ...receipt, status: "rejected" }],
      };
    }
    rememberThread({ id: destination.channelId, type: 11, parent_id: destination.openFrom.channelId, owner_id: botUserId });
    return undefined;
  };

  /** The server a room is in (a thread's, its room's): where its events are made. */
  const guildOfChannel = (channelId: string): string | undefined => {
    const room = threads.get(channelId)?.parentId ?? channelId;
    return [...guilds.entries()].find(([, guild]) => guild.channels.has(room))?.[0];
  };

  /** A Discord poll's message id, or the refusal of anything else. */
  const pollId = (messageId: string): string => {
    if (!/^\d{16,20}$/.test(messageId)) throw new TaviError("INVALID_INPUT", "a Discord poll is named by its message's id");
    return messageId;
  };

  /** A poll's or an event's room channel: a DM's is resolved as a send's is. */
  const roomChannelOf = async (destination: unknown, what: string): Promise<string> => {
    const channel = await directs.channelOf(parseDestination(destination, what));
    if ("refused" in channel)
      throw new TaviError("UNAVAILABLE", refusedReceipt(0, channel.refused, false).error ?? "Discord would not open that DM");
    return channel.channelId;
  };

  const hand = async (event: InboundEvent, hooks?: MessagingIngestHooks): Promise<MessagingIngestReceipt | void> => {
    await accepting;
    if (handler === undefined) throw new Error("no inbound handler is registered");
    return handler(event, hooks);
  };

  /**
   * An interaction's acknowledgement, within Discord's 3 s and before the host
   * decides anything: a press with a deferred update that changes nothing
   * shown, a command with a deferred answer its user alone sees (type 5, flags 64).
   */
  const callback = async (id: string, interactionToken: string, command: boolean): Promise<void> => {
    // Best effort: an unacknowledged interaction shows Discord's own failure; the turn still runs.
    await rest
      .request("POST", `/interactions/${id}/${interactionToken}/callback`, {
        body: command ? { type: 5, data: { flags: EPHEMERAL } } : { type: 6 },
      })
      .catch(() => undefined);
  };

  /** Acknowledges an interaction from its raw dispatch, before the connector reads anything more of Discord; false for one it does not take. */
  const acknowledge = async (data: unknown): Promise<boolean> => {
    const type = (data as { readonly type?: unknown } | null)?.type;
    if (type === 3) {
      const press = schemas.componentInteraction.safeParse(data);
      if (!press.success) return false;
      await callback(press.data.id, press.data.token, false);
      return true;
    }
    if (type !== 2) return false;
    const command = schemas.command.safeParse(data);
    // Only a command that is handed over is answered later: one with nothing to ask is left to Discord to fail.
    if (!command.success || commandMessage(command.data) === undefined) return false;
    await callback(command.data.id, command.data.token, true);
    return true;
  };

  /** Edits a command's private acknowledgement: what its user alone is told. Presentation only. */
  const answerCommand = async (interactionToken: string, text: string): Promise<void> => {
    // Best effort: an expired interaction cannot be edited.
    await rest
      .request("PATCH", `/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
        body: { content: text, flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } },
      })
      .catch(() => undefined);
  };

  const onDispatch = async (dispatch: GatewayDispatch): Promise<void> => {
    if (dispatch.t === "GUILD_CREATE") {
      const parsed = schemas.guild.safeParse(dispatch.d);
      if (!parsed.success) {
        dropped += 1;
        return;
      }
      remember(parsed.data);
      // A server the READY did not list, while it runs: the bot was just added. Known only once the host
      // has it, so a replay after a failed hand-over names the join again.
      if (readyAt && !known.has(parsed.data.id)) {
        const event = membershipEvent(parsed.data, "added", context);
        if (event !== undefined) await hand(event);
      }
      known.add(parsed.data.id);
      return;
    }
    if (dispatch.t === "GUILD_DELETE") {
      const parsed = schemas.guild.safeParse(dispatch.d);
      // `unavailable` is an outage; without it, the bot was removed.
      if (!parsed.success || parsed.data.unavailable === true) return;
      const event = membershipEvent(
        {
          ...parsed.data,
          channels: [...(guilds.get(parsed.data.id)?.channels.keys() ?? [])].map((id) => ({ id, type: 0 })),
          name: guilds.get(parsed.data.id)?.name,
        },
        "removed",
        context,
      );
      // Forgotten only once the host has it: a replay still knows its name and channels.
      if (event !== undefined) await hand(event);
      guilds.delete(parsed.data.id);
      known.delete(parsed.data.id);
      return;
    }
    if (dispatch.t === "GUILD_ROLE_CREATE" || dispatch.t === "GUILD_ROLE_UPDATE") {
      // A role's grant changed (an operator re-invited the bot, or gave everyone a permission): the probe says so now.
      const changed = dispatch.d as {
        readonly guild_id?: unknown;
        readonly role?: { readonly id?: unknown; readonly permissions?: unknown; readonly tags?: { readonly bot_id?: unknown } };
      } | null;
      const guild = typeof changed?.guild_id === "string" ? guilds.get(changed.guild_id) : undefined;
      const role = changed?.role;
      if (
        guild === undefined ||
        typeof changed?.guild_id !== "string" ||
        typeof role?.id !== "string" ||
        typeof role.permissions !== "string" ||
        !/^\d{1,20}$/.test(role.permissions)
      )
        return;
      const botRole = role.tags?.bot_id === botUserId ? role.id : guild.botRole;
      if (role.id !== botRole && role.id !== changed.guild_id) return;
      guilds.set(changed.guild_id, { ...guild, botRole, grants: new Map([...guild.grants, [role.id, BigInt(role.permissions)]]) });
      return;
    }
    if (dispatch.t === "THREAD_CREATE" || dispatch.t === "THREAD_UPDATE") {
      const parsed = schemas.thread.safeParse(dispatch.d);
      if (parsed.success) rememberThread(parsed.data);
      return;
    }
    if (dispatch.t === "THREAD_DELETE") {
      const id = (dispatch.d as { readonly id?: unknown } | null)?.id;
      if (typeof id === "string") threads.delete(id);
      return;
    }
    if (dispatch.t === "THREAD_LIST_SYNC") {
      const listed = (dispatch.d as { readonly threads?: unknown } | null)?.threads;
      for (const candidate of Array.isArray(listed) ? listed : []) {
        const parsed = schemas.thread.safeParse(candidate);
        if (parsed.success) rememberThread(parsed.data);
      }
      return;
    }
    if (dispatch.t === "CHANNEL_CREATE" || dispatch.t === "CHANNEL_UPDATE") {
      const channel = dispatch.d as
        | { readonly id?: unknown; readonly guild_id?: unknown; readonly type?: unknown; readonly name?: unknown }
        | undefined;
      const guild = typeof channel?.guild_id === "string" ? guilds.get(channel.guild_id) : undefined;
      if (
        guild !== undefined &&
        typeof channel?.id === "string" &&
        typeof channel.type === "number" &&
        ROOM_CHANNEL_TYPES.has(channel.type)
      )
        guild.channels.set(channel.id, typeof channel.name === "string" ? channel.name : channel.id);
      return;
    }
    // Its acknowledgement went as it arrived: it lands before anything answers it, or Discord has no message to edit.
    if (dispatch.t === "INTERACTION_CREATE") {
      const id = (dispatch.d as { readonly id?: unknown } | null)?.id;
      await (typeof id === "string" ? acknowledgements.get(id) : undefined);
    }
    if (dispatch.t === "MESSAGE_CREATE" || dispatch.t === "INTERACTION_CREATE") await learnChannel(dispatch.d);
    const mapped = eventOf(dispatch.t, dispatch.d, schemas, context);
    if ("dropped" in mapped) {
      if (mapped.dropped === "unparsed") dropped += 1;
      return;
    }
    for (const attachment of mapped.attachments ?? []) media.remember(attachment.ref, attachment.url);
    if (mapped.interaction !== undefined) {
      // A press's token is kept to answer it later (`answerInteraction`); a command's is answered here, below.
      if (mapped.interaction.command !== true) {
        const at = Date.parse(now());
        // Oldest first: expired ones go, and the oldest past the bound.
        for (const [id, entry] of interactions)
          if (at - entry.at > INTERACTION_TTL_MS || interactions.size >= INTERACTIONS_MAX) interactions.delete(id);
        interactions.set(mapped.interaction.id, { token: mapped.interaction.token, at });
      }
    }
    if (mapped.interaction?.command === true) {
      // Its user is told privately once the host has it, or why not: a dropped command is never recorded.
      const commandToken = mapped.interaction.token;
      let told = false;
      const receipt = await hand(mapped.event, {
        onRecorded: async (recorded) => {
          told = true;
          await answerCommand(commandToken, commandAnswer(recorded, options.locale?.()));
        },
      });
      if (!told) await answerCommand(commandToken, commandAnswer(receipt, options.locale?.()));
      return;
    }
    await hand(mapped.event);
  };

  const readToken = (): Promise<string | null> => input.credentials.get("token");

  return {
    async start(): Promise<void> {
      setStatus({ state: "starting" });
      const read = await readToken();
      if (read === null || read === "") {
        setStatus({ state: "failed", detail: say("status.noToken", "the bot token is absent"), repair: "credentials" });
        throw new TaviError("NOT_CONFIGURED", `Discord connection ${connection.connectionId} has no bot token`, {
          details: { connectionId: connection.connectionId, repair: "credentials" },
        });
      }
      token = read;
      const me = await rest.request<{ readonly id?: unknown; readonly bot?: unknown }>("GET", "/users/@me");
      if (!me.ok || me.body?.bot !== true || typeof me.body.id !== "string") {
        const repair = me.status === 401 || (me.ok && me.body?.bot !== true) ? ("credentials" as const) : undefined;
        const detail = me.ok ? "the token is not a bot's" : `Discord refused the token (${String(me.status)})`;
        const shown = me.ok ? say("status.notBot", detail) : say("status.refused", detail, { status: String(me.status) });
        setStatus({ state: "failed", detail: shown, ...(repair === undefined ? {} : { repair }) });
        throw new TaviError("UNAVAILABLE", `Discord connection ${connection.connectionId}: ${detail}`, {
          details: { connectionId: connection.connectionId, ...(repair === undefined ? {} : { repair }) },
        });
      }
      botUserId = me.body.id;
      const app = await rest.request<{ readonly id?: unknown; readonly flags?: unknown }>("GET", "/applications/@me");
      applicationId = app.ok && typeof app.body?.id === "string" ? app.body.id : botUserId;
      messageContent = app.ok && typeof app.body?.flags === "number" && (app.body.flags & MESSAGE_CONTENT_FLAGS) !== 0;
      if (activeApplications.has(applicationId)) {
        setStatus({
          state: "failed",
          detail: say("status.taken", `application ${applicationId} is already running under another connection`, {
            application: applicationId,
          }),
        });
        throw new TaviError(
          "CONFLICT",
          `Discord connection ${connection.connectionId} is application ${applicationId}, which is already running under another connection in this owner`,
          { details: { connectionId: connection.connectionId } },
        );
      }
      activeApplications.add(applicationId);
      ownedApplication = applicationId;
      let release = (): void => {};
      accepting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const identifies = identifyLogs.get(applicationId) ?? [];
      identifyLogs.set(applicationId, identifies);
      gateway = new Gateway({
        token,
        // Message Content, when the application has it: a room's addressed message keeps its words however it named the bot.
        intents: messageContent ? DISCORD_INTENTS | MESSAGE_CONTENT_INTENT : DISCORD_INTENTS,
        identifies,
        gatewayBot: async () => {
          const answer = await rest.request<{ readonly url?: unknown; readonly session_start_limit?: { readonly remaining?: unknown } }>(
            "GET",
            "/gateway/bot",
          );
          if (answer.status === 401)
            throw Object.assign(new Error("Discord no longer accepts the bot token: it was reset or revoked"), {
              repair: "credentials" as const,
            });
          if (!answer.ok || typeof answer.body?.url !== "string")
            throw new Error(`Discord did not say where its Gateway is (${String(answer.status)})`);
          const remaining = answer.body.session_start_limit?.remaining;
          return { url: answer.body.url, sessionStartsRemaining: typeof remaining === "number" ? remaining : 1000 };
        },
        webSocket: options.webSocket ?? ((url) => new globalThis.WebSocket(url)),
        clock: options.gatewayClock ?? realGatewayClock,
        onDispatch,
        // A press or a command is acknowledged within Discord's 3 s as it arrives, whatever turn is still running.
        onArrival: (dispatch) => {
          const id = (dispatch.d as { readonly id?: unknown } | null)?.id;
          if (dispatch.t !== "INTERACTION_CREATE" || typeof id !== "string" || acknowledgements.has(id)) return;
          // Bounded as the presses kept: the oldest first.
          if (acknowledgements.size >= INTERACTIONS_MAX) acknowledgements.delete(acknowledgements.keys().next().value as string);
          acknowledgements.set(
            id,
            acknowledge(dispatch.d).catch(() => false),
          );
        },
        onState: (state) => {
          if (state.state === "ready") {
            // A fresh session lists every server the bot is in: one it no longer lists was left while disconnected.
            if (!state.resumed) {
              for (const id of [...guilds.keys()]) if (!state.guildIds.includes(id)) guilds.delete(id);
              known.clear();
            }
            for (const id of state.guildIds) known.add(id);
            setStatus({ state: "running" });
            return;
          }
          if (state.state === "reconnecting")
            setStatus({ state: "running", detail: say("status.reconnecting", `reconnecting: ${state.detail}`, { detail: state.detail }) });
          if (state.state === "failed")
            setStatus({ state: "failed", detail: state.detail, ...(state.repair === undefined ? {} : { repair: state.repair }) });
        },
      });
      try {
        await gateway.start();
      } catch (error) {
        activeApplications.delete(applicationId);
        ownedApplication = undefined;
        gateway.stop();
        const repair = (error as { readonly repair?: unknown }).repair;
        throw new TaviError(
          "UNAVAILABLE",
          `Discord connection ${connection.connectionId} could not connect: ${redactedError(error, [token])}`,
          {
            details: {
              connectionId: connection.connectionId,
              ...(repair === "credentials" || repair === "provider-settings" ? { repair } : {}),
            },
          },
        );
      }
      readyAt = true;
      // Handed over from the next turn on: start() has returned by then.
      setTimeout(release, 0);
      // Not awaited: a connection whose commands Discord would not take still chats; `probe` says so.
      commands = "registering";
      run = new AbortController();
      registerCommands(rest, applicationId, run.signal).then(
        (registered) => {
          commands = registered ? "registered" : "refused";
        },
        () => {
          commands = "refused";
        },
      );
    },

    async stop(): Promise<void> {
      // What this run still had in flight of its own (the commands' registration) stops with it.
      run?.abort();
      run = undefined;
      gateway?.stop();
      gateway = undefined;
      if (ownedApplication !== undefined) activeApplications.delete(ownedApplication);
      ownedApplication = undefined;
      readyAt = false;
      guilds.clear();
      known.clear();
      interactions.clear();
      setStatus({ state: "stopped" });
    },

    status(): MessagingConnectionStatus {
      // The payloads dropped so far, counted as they happen and said whenever the status is read.
      const counted =
        dropped === 0
          ? status
          : {
              ...status,
              detail: `${status.detail === undefined ? "" : `${status.detail}; `}${String(dropped)} Gateway payloads did not parse and were dropped`,
            };
      return applicationId === "" ? counted : { ...counted, accountRef: applicationId };
    },

    async probe() {
      if (token === undefined) return { ok: false, detail: say("probe.state", `connection is ${status.state}`, { state: status.state }) };
      const me = await rest.request<{ readonly username?: unknown }>("GET", "/users/@me");
      const app = await rest.request<{ readonly id?: unknown; readonly bot_public?: unknown; readonly flags?: unknown }>(
        "GET",
        "/applications/@me",
      );
      if (!me.ok || !app.ok) {
        const answered = String(me.ok ? app.status : me.status);
        return { ok: false, detail: say("probe.answered", `Discord answered ${answered}`, { status: answered }) };
      }
      const invite = `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}&integration_type=0`;
      const flags = typeof app.body?.flags === "number" ? app.body.flags : 0;
      // What the operator turned on in the Developer Portal since the connection started counts from now.
      messageContent = (flags & MESSAGE_CONTENT_FLAGS) !== 0;
      const privileged = privilegedIntentsOf(flags);
      // The intents by name, in the workspace's words: "the Presence intent", „интентът Presence“.
      const intents = PRIVILEGED_INTENTS.filter((intent) => (flags & intent.flags) !== 0).map((intent) =>
        say("setup.intent", `the ${intent.name} intent`, { name: intent.name }),
      );
      const user = typeof me.body?.username === "string" ? me.body.username : botUserId;
      const lines = [
        say("setup.bot", `Bot ${user}.`, { name: user }),
        ...(app.body?.bot_public === true
          ? [
              say(
                "setup.publicBot",
                "Public Bot is on: anyone with the invite can add it to a server. Turn it off in the Developer Portal.",
              ),
            ]
          : []),
        ...(privileged.length === 0
          ? []
          : [
              say(
                "setup.privileged",
                `${sentenceCase(privileged.join(" and "))} ${privileged.length === 1 ? "is" : "are"} on for the bot: Tavi does not use ${privileged.length === 1 ? "it" : "them"}, and you can turn ${privileged.length === 1 ? "it" : "them"} off.`,
                {
                  count: intents.length,
                  intents: sentenceCase(
                    intents.length === 2
                      ? say("setup.intents", intents.join(" and "), { first: intents[0] ?? "", second: intents[1] ?? "" })
                      : (intents[0] ?? ""),
                  ),
                },
              ),
            ]),
        messageContent
          ? say("setup.contentOn", "The Message Content intent is on: a room set to read its recent messages reads them.")
          : say(
              "setup.contentOff",
              "The Message Content intent is off: a room set to read its recent messages reads only the message that addresses the bot. Turn it on in the Developer Portal for that.",
            ),
        ...(commands === "refused"
          ? [
              say(
                "setup.commandsRefused",
                "Discord would not take the bot's commands (/tavi, Ask Tavi about this): they register again at the next start.",
              ),
            ]
          : []),
        ...lackingInServers(),
      ];
      return {
        ok: status.state === "running",
        detail: [...lines, say("setup.invite", `Invite it: ${invite}`, { url: invite })].join(" "),
        setup: { lines, link: { label: say("setup.inviteLink", "Invite the bot to a server"), url: invite } },
      };
    },

    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (gateway === undefined || token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      checkPartCount(message, DISCORD_CAPABILITIES.maxPartsPerMessage, "Discord");
      const destination = parseDestination(message.destination, `effect ${message.effectId}`);
      const part = message.parts[0];
      if (part === undefined)
        return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "the message has no part" }] };
      const text = isFilePart(part) ? (part.caption ?? "") : part.content;
      let file: SendInput["file"];
      if (isFilePart(part)) {
        const read = await readFile(part.artifactId, message.workspaceId ?? connection.workspaceId);
        if ("refused" in read)
          return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: read.refused }] };
        const contentType = part.mimeType ?? read.contentType;
        file = { bytes: read.bytes, filename: fileNameOf(part.filename, part.artifactId, contentType), contentType };
      }
      const unopened = await threadOpened(destination, threadNameOf(text));
      if (unopened !== undefined) return unopened;
      return sendText(rest, directs, { effectId: message.effectId, destination, text, buttons: message.buttons, file }, token);
    },

    async fetchRecent(destination, options) {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      if (!messageContent)
        throw new TaviError(
          "UNSUPPORTED",
          "the bot's Message Content intent is off, so Discord gives it no room's history: turn it on in the Developer Portal",
        );
      const parsed = parseDestination(destination, "recent messages");
      // A thread not open yet has no history of its own: its room's is what came before.
      const target =
        "channelId" in parsed && parsed.openFrom !== undefined && !threads.has(parsed.channelId)
          ? { channelId: parsed.openFrom.channelId }
          : parsed;
      return fetchRecent(rest, schemas, await roomChannelOf(target, "recent messages"), options);
    },

    async createPoll(input) {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      // A thread not open yet (a room's `autoThread`) is opened for it, as for a message.
      const unopened = await threadOpened(parseDestination(input.destination, `effect ${input.effectId}`), threadNameOf(input.question));
      if (unopened !== undefined) return unopened;
      return createPoll(rest, await roomChannelOf(input.destination, `effect ${input.effectId}`), input, token);
    },

    async readPoll(destination, messageId) {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      return readPoll(rest, await roomChannelOf(destination, "poll"), pollId(messageId));
    },

    async endPoll(input) {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      return endPoll(rest, await roomChannelOf(input.destination, `effect ${input.effectId}`), pollId(input.messageId), token);
    },

    async createEvent(input) {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      const parsed = parseDestination(input.destination, `effect ${input.effectId}`);
      // A thread's server is its room's, whether or not the thread is open yet.
      const guild = "channelId" in parsed ? guildOfChannel(parsed.openFrom?.channelId ?? parsed.channelId) : undefined;
      // An event is a server's: a DM has none.
      if (guild === undefined)
        return {
          status: "rejected",
          retryable: false,
          parts: [
            {
              index: 0,
              status: "rejected",
              error: "a Discord event is made in a server's room, and this is no room of a server the bot is in",
            },
          ],
        };
      return createEvent(rest, guild, input, token);
    },

    async typing(destination: unknown): Promise<void> {
      if (token === undefined) return;
      const parsed = parseDestination(destination, "typing");
      // A thread not open yet: the room it opens from shows it.
      const target =
        "channelId" in parsed && parsed.openFrom !== undefined && !threads.has(parsed.channelId)
          ? { channelId: parsed.openFrom.channelId }
          : parsed;
      // Timed as asked, before a DM's channel is opened: a slow open must not make the next ask look early.
      const at = Date.parse(now());
      // No direct channel: the typing indicator is skipped.
      const channel = await directs.channelOf(target).catch(() => undefined);
      if (channel === undefined || "refused" in channel) return;
      const last = typedAt.get(channel.channelId);
      if (last !== undefined && at - last.at < (last.refused ? TYPING_REFUSED_MS : TYPING_REPEAT_MS)) return;
      typedAt.delete(channel.channelId);
      if (typedAt.size >= THREADS_MAX) typedAt.delete(typedAt.keys().next().value ?? "");
      typedAt.set(channel.channelId, { at, refused: false });
      // Presentation only: a failure shows nothing and changes nothing. A refusal is not asked again for a while,
      // so a room without the permission does not count against the client's refused requests all turn long.
      const answer = await rest.request("POST", `/channels/${channel.channelId}/typing`).catch(() => undefined);
      if (answer !== undefined && (answer.status === 401 || answer.status === 403)) typedAt.set(channel.channelId, { at, refused: true });
    },

    async fetchMedia(handle, fetchOptions) {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      return media.fetch(handle, fetchOptions);
    },

    async answerInteraction(callbackId: string, text: string): Promise<void> {
      // Seen by the presser only (ephemeral, flags 64), or not at all: never posted where the room can see it.
      const entry = interactions.get(callbackId);
      if (entry === undefined || Date.parse(now()) - entry.at > INTERACTION_TTL_MS || text.trim() === "") return;
      // Best effort: a follow-up to an expired interaction cannot be delivered.
      await rest
        .request("POST", `/webhooks/${applicationId}/${entry.token}`, {
          body: { content: text.slice(0, 2000), flags: EPHEMERAL | SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } },
        })
        .catch(() => undefined);
    },

    async editMessage(edit): Promise<void> {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      const answer = await editText(rest, directs, {
        destination: parseDestination(edit.destination, "edit"),
        messageId: edit.messageId,
        text: edit.text,
        buttons: edit.buttons,
      });
      if (!answer.ok)
        throw new TaviError("UNAVAILABLE", `Discord refused the edit: ${refusedReceipt(0, answer, false).error ?? String(answer.status)}`);
    },

    onInboundEvent(next) {
      handler = next;
    },

    async listRooms(): Promise<readonly ChannelRoomListing[]> {
      return [...guilds.values()].flatMap((guild) =>
        [...guild.channels.entries()].map(([id, name]) => ({
          id,
          name: name.slice(0, 120),
          ...(guild.name === undefined ? {} : { place: guild.name.slice(0, 120) }),
        })),
      );
    },

    async leaveRoom(destination: unknown): Promise<void> {
      if (token === undefined) throw notRunning("Discord", connection.connectionId, status.state);
      const parsed = parseDestination(destination, "leave");
      const channelId = "channelId" in parsed ? parsed.channelId : undefined;
      const guild = [...guilds.entries()].find(([, state]) => channelId !== undefined && state.channels.has(channelId))?.[0];
      if (guild === undefined) throw new TaviError("NOT_FOUND", "that channel is in no server the bot is in");
      // Discord leaves a whole server, never one channel of it.
      const answer = await rest.request("DELETE", `/users/@me/guilds/${guild}`);
      if (!answer.ok) throw new TaviError("UNAVAILABLE", `Discord refused to leave the server (${String(answer.status)})`);
    },
  };
}
