import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { nowTimestamp } from "@tavi/contracts/util";
import { vi } from "vitest";

import { APP, BOT, CLOSED_USER, GUILD, TOKEN, fakeDiscord, turns } from "@tavi/test-support/discord";
import { createGroupLikePlatform } from "../../../../tests/fixtures/channel-group-like/index.mjs";

/**
 * The channel fixtures the group scenario suite runs over: each plugin, its fake
 * platform, and the suite's neutral steps as that platform's events. People
 * are named (`op`, `bob`, `stranger`…); each fixture gives them, their DMs and
 * the suite's rooms the ids its platform uses.
 */

/** What the suite reads of a message the agent put on the platform. */
export interface SeamSent {
  readonly conversation: string;
  readonly visibleInRoom: boolean;
  /** What it says now: an edit changes it. */
  readonly text: string;
  readonly buttons?: readonly (readonly { readonly label: string; readonly data: string }[])[];
}

/** A platform event the suite caused: the inbox key its message is stored under, when it is one. */
export interface SeamUpdate {
  readonly storedKey?: string;
  /** The platform's id for the message, when it is one. */
  readonly messageId?: string;
}

/** `gateway`: a platform connection the suite can close with the platform's own code, and an application whose intents it can turn off. */
type SeamFeature = "picked" | "polls" | "events" | "threads" | "files" | "commands" | "setup" | "context" | "gateway";

export interface SeamChannel {
  readonly name: string;
  readonly pluginDirectory: string;
  readonly pluginId: string;
  readonly version: string;
  readonly providerId: string;
  /** Approval asks to run it in the owner's process (`--in-process`). */
  readonly inProcess: boolean;
  readonly features: ReadonlySet<SeamFeature>;
  readonly token: string;
  /** A token the platform refuses. */
  readonly badToken: string;
  /** The account a purge of the connection names. */
  readonly accountRef: string;
  readonly fetch: typeof globalThis.fetch;
  /** Who the platform says added the agent to a room, when `name` did. */
  readonly addedBy: (name: string) => string;
  /** Sets up what the plugin reaches outside `fetch` (a WebSocket); answers the undo. */
  readonly install: () => () => void;
  user(name: string): string;
  /** The conversation id of a person's DM with the agent. */
  dmOf(name: string): string;
  roomId(index: number): string;
  dm(from: string, text: string): SeamUpdate;
  say(room: string, from: string, text: string, how?: { readonly addressed?: "mention" | "reply"; readonly bot?: boolean }): SeamUpdate;
  press(from: string, data: string, where: string): SeamUpdate;
  pick(room: string, from: string, picked: { readonly id: string; readonly author: string; readonly text: string }): SeamUpdate;
  member(room: string, by: string, change: "added" | "removed", name?: string): SeamUpdate;
  /** A person opens a thread in a room; answers its id. */
  thread(room: string, by: string): string;
  /** A message in a thread of a room: one a person opened, or one the agent did. */
  sayInThread(room: string, thread: string, from: string, text: string, how?: { readonly addressed?: "mention" }): SeamUpdate;
  /** A message carrying a file, in a room addressing the agent (unless `plain`), or in the sender's DM (`room` absent). */
  sayWithFile(
    room: string | undefined,
    from: string,
    text: string,
    file: { readonly filename: string; readonly bytes: Uint8Array },
    how?: { readonly plain?: boolean; readonly bot?: boolean },
  ): SeamUpdate;
  /** The platform delivers a message it delivered before again, the same event (a resume's replay). */
  redeliver(update: SeamUpdate): void;
  /** Whether the platform loses its answer to creating an event, having made it. */
  loseEventAnswers(lost: boolean): void;
  /** Turns the application's Message Content intent on or off, as an operator does in the platform's portal (`gateway`). */
  messageContent(on: boolean): void;
  /** The platform closes the connection with its own close code (`gateway`). */
  closeConnection(code: number): void;
  /** How many files the connector downloaded from the platform. */
  downloads(): number;
  /** How many times the connector read a room's recent messages from the platform. */
  recentReads(): number;
  /** A platform command asking the agent something, in a room or the sender's DM (`room` absent). */
  command(room: string | undefined, from: string, question: string): SeamUpdate;
  /** Resolves once the connector took in what the steps so far sent it. */
  settled(): Promise<void>;
  sent(): readonly SeamSent[];
  /** Private answers to presses, seen by their pressers alone. */
  answers(): readonly SeamSent[];
  /** Rooms the agent left. */
  left(): readonly string[];
  polls(): ReadonlyMap<string, { readonly question: string; readonly ended: boolean }>;
  events(): readonly { readonly title: string; readonly start: string; readonly end: string }[];
  vote(pollId: string, voter: string, answer: number): void;
}

/** The suite's rooms: the cases take 1 onward; 38 and 39 are the ones the agent is added to, 40 nobody lists. */
const ROOMS = 40;

/** The person whose DMs are closed to the agent. */
export const CLOSED = "closed-op";

export function groupLikeChannel(): SeamChannel {
  const platform = createGroupLikePlatform({
    closed: [CLOSED],
    rooms: Array.from({ length: ROOMS }, (_, index) => ({ id: `room-${String(index + 1)}`, name: `Room ${String(index + 1)}` })),
  });
  const keyed = (update: { readonly message?: { readonly id: string }; readonly press?: { readonly id: string } }): SeamUpdate =>
    update.message !== undefined
      ? { storedKey: `msg:${update.message.id}`, messageId: update.message.id }
      : update.press !== undefined
        ? { storedKey: `press:${update.press.id}` }
        : {};
  /** What each message was said with, by its id: a redelivery says it again under the same id. */
  const said = new Map<string, Parameters<typeof platform.say>[0]>();
  const saying = (input: Parameters<typeof platform.say>[0]): SeamUpdate => {
    const update = keyed(platform.say(input));
    if (update.messageId !== undefined) said.set(update.messageId, input);
    return update;
  };
  let reads = 0;
  let eventsLost = false;
  // The platform's own fetch, counting the connector's reads of a room's history; an event made, its answer lost.
  const counted: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/recent")) reads += 1;
    const answer = await platform.fetch(input, init);
    if (eventsLost && url.endsWith("/event-create")) throw new TypeError("fetch failed: socket hang up");
    return answer;
  };
  return {
    name: "group-like",
    pluginDirectory: join(import.meta.dirname, "..", "..", "..", "..", "tests", "fixtures", "channel-group-like"),
    pluginId: "fixture.grouplike",
    version: "1.0.0",
    providerId: "group-like",
    inProcess: false,
    features: new Set(["picked", "polls", "events", "context"]),
    token: platform.token,
    badToken: "revoked-token",
    accountRef: platform.botId,
    fetch: counted,
    addedBy: (name) => name,
    install: () => () => undefined,
    user: (name) => name,
    dmOf: (name) => `dm:${name}`,
    roomId: (index) => `room-${String(index)}`,
    dm: (from, text) => saying({ author: from, text }),
    say: (room, from, text, how = {}) =>
      saying({
        author: from,
        room,
        text,
        ...(how.addressed === "mention" ? { mention: true } : {}),
        ...(how.addressed === "reply" ? { replyTo: { id: "msg-bot", author: platform.botId } } : {}),
        ...(how.bot === true ? { bot: true } : {}),
      }),
    press: (from, data, where) => keyed(platform.press({ presser: from, data, room: where })),
    pick: (room, from, picked) => saying({ author: from, room, picked }),
    member: (room, by, change, name) => keyed(platform.member({ room, by, change, ...(name === undefined ? {} : { name }) })),
    thread: () => {
      throw new Error("the group-like fixture has no threads");
    },
    sayInThread: () => {
      throw new Error("the group-like fixture has no threads");
    },
    sayWithFile: () => {
      throw new Error("the group-like fixture carries no files");
    },
    redeliver: (update) => {
      const id = update.messageId ?? "";
      const input = said.get(id);
      if (input === undefined) throw new Error(`no message ${id} to deliver again`);
      platform.say({ ...input, id });
    },
    loseEventAnswers: (lost) => {
      eventsLost = lost;
    },
    messageContent: () => {
      throw new Error("the group-like fixture has no intents");
    },
    closeConnection: () => {
      throw new Error("the group-like fixture's connection is a poll, with no close codes");
    },
    downloads: () => 0,
    recentReads: () => reads,
    command: () => {
      throw new Error('the group-like fixture\'s commands are its own (`command: "ask"`)');
    },
    settled: () => platform.settled(),
    sent: () => platform.sent().filter((sent) => !sent.conversation.startsWith("press:")),
    answers: () => platform.sent().filter((sent) => sent.conversation.startsWith("press:")),
    left: () => platform.left(),
    polls: () => new Map([...platform.polls().entries()].map(([id, poll]) => [id, { question: poll.question, ended: poll.ended }])),
    events: () => platform.events().map((event) => ({ title: event.title, start: event.start, end: event.end })),
    vote: (pollId, voter, answer) => platform.vote(pollId, voter, answer),
  };
}

/** A name's id: the same name is always the same snowflake. */
function snowflakes(prefix: string, known: Readonly<Record<string, string>> = {}): (name: string) => string {
  const ids = new Map<string, string>(Object.entries(known));
  return (name) => {
    const known = ids.get(name);
    if (known !== undefined) return known;
    const id = `${prefix}${String(ids.size + 1).padStart(18 - prefix.length, "0")}`;
    ids.set(name, id);
    return id;
  };
}

/** Discord's built bundle, as an operator installs it. */
export const DISCORD_BUNDLE = join(import.meta.dirname, "..", "..", "..", "..", "packages", "external", "discord", "dist-plugin");

/** Refuses to go on without the bundle, naming the build that makes it. */
export function assertDiscordBuilt(): void {
  if (!existsSync(join(DISCORD_BUNDLE, "tavi-plugin.json")))
    throw new Error(`${DISCORD_BUNDLE} is not built: run \`pnpm --filter @tavi/plugin-discord build\``);
}

/** The rooms the agent is added to during the suite: each is a server of its own, not yet joined. */
const JOINED_LATER = new Set([38, 39]);

export function discordChannel(): SeamChannel {
  const userOf = snowflakes("81", { [CLOSED]: CLOSED_USER });
  const dmChannel = snowflakes("72");
  const roomId = (index: number): string => `711${String(index).padStart(15, "0")}`;
  const discord = fakeDiscord({
    rooms: Array.from({ length: ROOMS }, (_, index) => index + 1)
      .filter((index) => !JOINED_LATER.has(index))
      .map(roomId),
    onlyToken: TOKEN,
    application: { flags: 1 << 18 },
  });
  /** A person's id; the DM Discord opens with them is a channel of the suite's naming. */
  const user = (name: string): string => {
    const id = userOf(name);
    if (!discord.dmChannels.has(id)) discord.dmChannels.set(id, dmChannel(name));
    return id;
  };
  let messages = 0;
  const nextMessage = (): string => `743${String((messages += 1)).padStart(15, "0")}`;
  /** Each message dispatched, by its id: a resume replays it as it was. */
  const dispatched = new Map<string, Record<string, unknown>>();
  /** Guilds the suite made for rooms the agent is added to, by room. */
  const guildOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const dmOf = (name: string): string => discord.dmChannels.get(user(name)) ?? "";
  const views = new Map<string, SeamSent>();
  const view = (post: (typeof discord.posted)[number]): SeamSent => {
    const known = views.get(post.id);
    if (known !== undefined) return known;
    const components = post.components as
      | readonly { readonly components: readonly { readonly label: string; readonly custom_id: string }[] }[]
      | undefined;
    const made: SeamSent = {
      conversation: post.channel,
      visibleInRoom: !post.ephemeral && !post.channel.startsWith("interaction:"),
      get text() {
        return post.content;
      },
      ...(components === undefined || components.length === 0
        ? {}
        : { buttons: components.map((row) => row.components.map((button) => ({ label: button.label, data: button.custom_id }))) }),
    };
    views.set(post.id, made);
    return made;
  };
  const message = (channel: string, from: string, fields: Record<string, unknown>, guild?: string): SeamUpdate => {
    const id = nextMessage();
    const payload = {
      id,
      channel_id: channel,
      ...(guild === undefined ? {} : { guild_id: guild }),
      type: 0,
      author: { id: user(from), username: from },
      content: "",
      timestamp: nowTimestamp(),
      mentions: [],
      mention_roles: [],
      attachments: [],
      ...fields,
    };
    dispatched.set(id, payload);
    discord.dispatch("MESSAGE_CREATE", payload);
    return { storedKey: `app:${APP}:msg:${channel}:${id}`, messageId: id };
  };
  let threads = 0;
  const pickedId = snowflakes("745");
  /** A command used in a channel: its interaction id is the stored event's key. */
  const interaction = (channel: string, from: string, data: Record<string, unknown>, inDm = false): SeamUpdate => {
    const id = `764${String((messages += 1)).padStart(15, "0")}`;
    discord.dispatch("INTERACTION_CREATE", {
      id,
      application_id: APP,
      type: 2,
      token: `command-${id}`,
      channel_id: channel,
      ...(inDm ? { user: { id: user(from) } } : { guild_id: guildOf.get(channel) ?? GUILD, member: { user: { id: user(from) } } }),
      data,
    });
    return { storedKey: `app:${APP}:ix:${id}` };
  };
  const mentioning = (text: string, addressed: "mention" | "reply" | undefined) => ({
    content: addressed === "mention" ? `<@${BOT}> ${text}` : text,
    ...(addressed === "mention" ? { mentions: [{ id: BOT, bot: true }] } : {}),
  });
  return {
    name: "discord",
    pluginDirectory: DISCORD_BUNDLE,
    pluginId: "discord.channel",
    // The bundle's own version, never a copy of it: a bumped manifest installs as itself.
    version: (JSON.parse(readFileSync(join(DISCORD_BUNDLE, "tavi-plugin.json"), "utf8")) as { readonly version: string }).version,
    providerId: "discord",
    inProcess: true,
    features: new Set(["picked", "polls", "events", "threads", "files", "commands", "setup", "context", "gateway"]),
    token: TOKEN,
    badToken: "OTAwMDAwMDAwMDAwMDAwMDAx.Gfake.revoked",
    accountRef: APP,
    fetch: discord.fetch,
    // The Gateway does not say who added the bot; the connector names the bot itself.
    addedBy: () => BOT,
    install: () => {
      assertDiscordBuilt();
      // The plugin opens its Gateway on the global WebSocket: here, the fake's.
      vi.stubGlobal("WebSocket", function FakeWebSocket(url: string) {
        return discord.webSocket(url);
      });
      return () => vi.unstubAllGlobals();
    },
    user,
    dmOf,
    roomId,
    dm: (from, text) => message(dmOf(from), from, { content: text }),
    say: (room, from, text, how = {}) =>
      message(
        room,
        from,
        {
          ...mentioning(text, how.addressed === "mention" ? "mention" : undefined),
          ...(how.addressed === "reply"
            ? {
                type: 19,
                message_reference: { message_id: "743999999999999999" },
                referenced_message: { id: "743999999999999999", author: { id: BOT, bot: true } },
              }
            : {}),
          ...(how.bot === true ? { author: { id: user(from), username: from, bot: true } } : {}),
        },
        guildOf.get(room) ?? GUILD,
      ),
    press: (from, data, where) => {
      const id = `764${String((messages += 1)).padStart(15, "0")}`;
      const inDm = !where.startsWith("711");
      discord.dispatch("INTERACTION_CREATE", {
        id,
        application_id: APP,
        type: 3,
        token: `press-${id}`,
        channel_id: where,
        ...(inDm ? { user: { id: user(from) } } : { guild_id: guildOf.get(where) ?? GUILD, member: { user: { id: user(from) } } }),
        message: { id: "743999999999999998" },
        data: { custom_id: data, component_type: 2 },
      });
      return { storedKey: `app:${APP}:ix:${id}` };
    },
    // "Ask Tavi about this" on a message: Discord delivers the target with the command.
    pick: (room, from, picked) =>
      interaction(room, from, {
        name: "Ask Tavi about this",
        type: 3,
        target_id: pickedId(picked.id),
        resolved: {
          messages: {
            [pickedId(picked.id)]: {
              id: pickedId(picked.id),
              author: { id: user(picked.author), username: picked.author },
              content: picked.text,
            },
          },
        },
      }),
    member: (room, _by, change, name) => {
      const guild = guildOf.get(room) ?? `701${String(guildOf.size + 1).padStart(15, "0")}`;
      guildOf.set(room, guild);
      if (name !== undefined) nameOf.set(room, name);
      if (change === "added")
        discord.dispatch("GUILD_CREATE", {
          id: guild,
          name: nameOf.get(room) ?? "A server",
          joined_at: nowTimestamp(),
          system_channel_id: room,
          channels: [{ id: room, type: 0, name: "general", position: 0 }],
          roles: [],
        });
      else discord.dispatch("GUILD_DELETE", { id: guild });
      return {};
    },
    thread: (room, by) => {
      const id = `712${String((threads += 1)).padStart(15, "0")}`;
      discord.dispatch("THREAD_CREATE", {
        id,
        guild_id: guildOf.get(room) ?? GUILD,
        parent_id: room,
        owner_id: user(by),
        type: 11,
        name: "A thread",
      });
      return id;
    },
    sayInThread: (room, thread, from, text, how = {}) => message(thread, from, mentioning(text, how.addressed), guildOf.get(room) ?? GUILD),
    sayWithFile: (room, from, text, file, how = {}) => {
      const channel = room ?? dmOf(from);
      const attachment = `744${String((messages += 1)).padStart(15, "0")}`;
      const url = `https://cdn.discordapp.com/attachments/${channel}/${attachment}/${encodeURIComponent(file.filename)}?ex=7fffffff&is=1&hm=00`;
      discord.cdn.set(url, file.bytes);
      return message(
        channel,
        from,
        {
          ...mentioning(text, room === undefined || how.plain === true ? undefined : "mention"),
          attachments: [{ id: attachment, filename: file.filename, size: file.bytes.byteLength, url }],
          ...(how.bot === true ? { author: { id: user(from), username: from, bot: true } } : {}),
        },
        room === undefined ? undefined : (guildOf.get(room) ?? GUILD),
      );
    },
    redeliver: (update) => {
      const payload = dispatched.get(update.messageId ?? "");
      if (payload === undefined) throw new Error(`no message ${update.messageId ?? "(none)"} to deliver again`);
      discord.replay("MESSAGE_CREATE", payload);
    },
    loseEventAnswers: (lost) => {
      discord.moods.eventMood = lost ? "lost-made" : undefined;
    },
    messageContent: (on) => {
      discord.application.flags = on ? 1 << 18 : 0;
    },
    closeConnection: (code) => {
      discord.sockets.at(-1)?.drop(code);
    },
    downloads: () => discord.requests.filter((request) => request.path.startsWith("https://cdn.discordapp.com/")).length,
    recentReads: () =>
      discord.requests.filter((request) => request.method === "GET" && /^\/channels\/\d+\/messages\?/.test(request.path)).length,
    command: (room, from, question) =>
      interaction(
        room ?? dmOf(from),
        from,
        { name: "tavi", type: 1, options: [{ type: 1, name: "ask", options: [{ type: 3, name: "question", value: question }] }] },
        room === undefined,
      ),
    // The connector hands each dispatch over in order; a few turns let it, and the host's ingest, finish.
    settled: () => turns(250),
    sent: () => discord.posted.filter((post) => !post.channel.startsWith("interaction:")).map(view),
    answers: () => discord.posted.filter((post) => post.channel.startsWith("interaction:")).map(view),
    left: () => discord.left.map((guild) => [...guildOf.entries()].find(([, id]) => id === guild)?.[0] ?? guild),
    polls: () => new Map([...discord.polls.entries()].map(([id, poll]) => [id, { question: poll.question, ended: poll.ended }])),
    events: () =>
      discord.events.map((event) => ({
        title: event.name,
        start: event.scheduled_start_time,
        end: String(event.body["scheduled_end_time"] ?? ""),
      })),
    vote: (pollId, voter, answer) => discord.vote(pollId, user(voter), answer),
  };
}
