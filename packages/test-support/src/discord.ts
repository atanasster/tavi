import { fakeGateway, manualClock, type FakeSocket } from "./discord-gateway.js";
import { fakeRest, type FakeAnswer, type FakeRequest } from "./discord-rest.js";

export * from "./discord-gateway.js";
export * from "./discord-rest.js";

/**
 * A fake Discord for the connector's suites: the REST routes the connector calls and a Gateway that says Hello
 * and READY to each connection, with a guild of two text channels, DMs with
 * channels of their own, a user whose DMs are closed (50007), nonce dedupe,
 * and private follow-ups to a press. It records what reached each channel.
 */

export const BOT = "900000000000000001";
export const APP = "900000000000000002";
export const GUILD = "700000000000000001";
export const ROOM = "710000000000000001";
export const ROOM_2 = "710000000000000003";
export const OPEN_USER = "800000000000000001";
export const CLOSED_USER = "800000000000000003";
export const TOKEN = "OTAwMDAwMDAwMDAwMDAwMDAx.Gfake.s3cret-bot-token";

export interface Posted {
  readonly id: string;
  readonly channel: string;
  /** What it says now: an edit changes it. */
  content: string;
  readonly flags: number;
  readonly allowedMentions?: { readonly parse?: readonly string[] };
  components?: unknown;
  /** A follow-up to a press, seen by the presser only. */
  readonly ephemeral: boolean;
}

export interface FakeDiscordOptions {
  /** Every POST of a message answers so, instead of normally. */
  readonly sendMood?: "ok" | "hang" | "echo" | "garbled";
  readonly guilds?: readonly unknown[];
  /** The guild's text channels; two by default. */
  readonly rooms?: readonly string[];
  /** Refuse every token but this one, as Discord does a revoked one (401). */
  readonly onlyToken?: string;
  /** Messages `GET /channels/<c>/messages/<m>` answers, by `<c>/<m>`: their attachments as Discord has them now. */
  readonly messages?: Readonly<Record<string, { readonly attachments: readonly { readonly id: string; readonly url: string }[] }>>;
  /** Refuse the commands' overwrite (a 400), or hold the read of them until this resolves. */
  readonly commandsMood?: "refuse" | { readonly holdUntil: Promise<void> };
  /** How creating a scheduled event goes: made and answered, made but its answer lost, lost and not made, or refused (no Create Events). */
  readonly eventMood?: "ok" | "lost-made" | "lost-not-made" | "forbidden" | "dropped-not-listed" | "lost-unlisted" | "list-down";
  /** The bot's role's permissions in the guild, as Discord gave them at the invite. */
  readonly botPermissions?: string;
  /** What `GET /applications/@me` says of the application besides its id. */
  readonly application?: { readonly bot_public?: boolean; readonly flags?: number };
  /** Threads `GET /channels/<id>` answers, by id. */
  readonly threads?: Readonly<Record<string, { readonly parent_id: string; readonly owner_id?: string; readonly type?: number }>>;
}

export function fakeDiscord(options: FakeDiscordOptions = {}) {
  const gateway = fakeGateway();
  const clock = manualClock();
  const posted: Posted[] = [];
  const nonces = new Map<string, string>();
  const dmChannels = new Map<string, string>();
  const left: string[] = [];
  /** The application's commands as Discord has them, and how many times they were overwritten. */
  const commands = { current: [] as unknown[], overwrites: 0 };
  /** Polls posted, by their message's id: their answers, and each answer's voters. */
  const polls = new Map<
    string,
    { readonly question: string; readonly answers: readonly string[]; readonly votes: Map<number, Set<string>>; ended: boolean }
  >();
  /** The guild's scheduled events, as Discord lists them, with the audit reason each was made with. */
  const events: {
    readonly id: string;
    readonly name: string;
    readonly scheduled_start_time: string;
    readonly body: Record<string, unknown>;
    readonly reason?: string;
  }[] = [];
  /** Files on the CDN, by their link; a link not here is 404, as an expired one is. */
  const cdn = new Map<string, Uint8Array>();
  /** Threads opened from a message, by its id: the room they are in and their name. */
  const openedThreads = new Map<string, { readonly channel: string; readonly name: string }>();
  let ids = 0;
  let seq = 1;
  const pending: { readonly t: string; readonly d: unknown }[] = [];
  const rooms = options.rooms ?? [ROOM, ROOM_2];
  /** The application as `GET /applications/@me` answers it now: a test turns an intent on as an operator would. */
  const application: { bot_public?: boolean; flags?: number } = { ...options.application };
  /** How creating an event goes now: a test changes it mid-run. */
  const moods: { eventMood: FakeDiscordOptions["eventMood"] | undefined } = { eventMood: options.eventMood };
  /** Each channel's messages, oldest first: seeded for the first room, and every message dispatched since. */
  const history = new Map<string, Record<string, unknown>[]>([
    [
      rooms[0] ?? ROOM,
      [
        {
          id: "741900000000000001",
          channel_id: rooms[0] ?? ROOM,
          guild_id: GUILD,
          type: 0,
          author: { id: OPEN_USER, username: "operator" },
          content: "who's in for Friday?",
          timestamp: "2026-10-18T08:00:00.000000+00:00",
          mentions: [],
          mention_roles: [],
          attachments: [],
        },
        {
          id: "741900000000000002",
          channel_id: rooms[0] ?? ROOM,
          guild_id: GUILD,
          type: 7,
          author: { id: "800000000000000004", username: "newbie" },
          content: "",
          timestamp: "2026-10-18T08:01:00.000000+00:00",
          mentions: [],
          mention_roles: [],
          attachments: [],
        },
        {
          id: "741900000000000003",
          channel_id: rooms[0] ?? ROOM,
          guild_id: GUILD,
          type: 0,
          author: { id: "800000000000000099", username: "helper", bot: true },
          content: "beep",
          timestamp: "2026-10-18T08:02:00.000000+00:00",
          mentions: [],
          mention_roles: [],
          attachments: [],
        },
      ],
    ],
  ]);
  const guild = {
    id: GUILD,
    name: "Fixture Guild",
    system_channel_id: rooms[0],
    joined_at: "2026-10-01T00:00:00.000000+00:00",
    channels: rooms.map((id, position) => ({
      id,
      type: 0,
      name: position === 0 ? "general" : position === 1 ? "planning" : `room-${String(position + 1)}`,
      position,
    })),
    roles: [
      {
        id: "730000000000000001",
        ...(options.botPermissions === undefined ? {} : { permissions: options.botPermissions }),
        tags: { bot_id: BOT },
      },
    ],
  };
  const nextId = (): string => (BigInt("741000000000000000") + BigInt((ids += 1))).toString();

  const route = async (request: FakeRequest): Promise<FakeAnswer> => {
    const { method, path } = request;
    if (path.startsWith("https://cdn.discordapp.com/") || path.startsWith("https://media.discordapp.net/")) {
      const file = cdn.get(path);
      return file === undefined ? { status: 404, body: "gone" } : { bytes: file };
    }
    if (options.onlyToken !== undefined && request.headers["authorization"] !== `Bot ${options.onlyToken}`)
      return { status: 401, body: { message: "401: Unauthorized", code: 0 } };
    if (method === "GET" && path === "/users/@me") return { body: { id: BOT, bot: true, username: "tavi" } };
    if (method === "GET" && path === "/applications/@me") return { body: { id: APP, bot_public: false, ...application } };
    if (method === "GET" && path === "/gateway/bot")
      return {
        body: {
          url: "wss://gateway.discord.gg",
          shards: 1,
          session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 },
        },
      };
    if (method === "POST" && path === "/users/@me/channels") {
      const recipient = String((request.body as { readonly recipient_id?: unknown } | undefined)?.recipient_id ?? "");
      const channel = dmChannels.get(recipient) ?? (BigInt("720000000000000000") + BigInt(dmChannels.size + 1)).toString();
      dmChannels.set(recipient, channel);
      return { body: { id: channel, type: 1 } };
    }
    const voters = /^\/channels\/\d+\/polls\/(\d+)\/answers\/(\d+)\?limit=\d+$/.exec(path);
    if (method === "GET" && voters !== null) {
      const poll = polls.get(voters[1] ?? "");
      return poll === undefined
        ? { status: 404, body: { code: 10008, message: "Unknown Message" } }
        : { body: { users: [...(poll.votes.get(Number(voters[2])) ?? [])].map((id) => ({ id })) } };
    }
    const expiring = /^\/channels\/\d+\/polls\/(\d+)\/expire$/.exec(path);
    if (method === "POST" && expiring !== null) {
      const poll = polls.get(expiring[1] ?? "");
      if (poll === undefined) return { status: 404, body: { code: 10008, message: "Unknown Message" } };
      if (poll.ended) return { status: 400, body: { code: 520001, message: "Poll expired" } };
      poll.ended = true;
      return { body: { id: expiring[1] } };
    }
    if (path === `/guilds/${GUILD}/scheduled-events`) {
      // The list itself down: a 502 for it after the create's answer was lost.
      if (method === "GET" && moods.eventMood === "lost-unlisted" && events.length > 0)
        return { status: 502, body: "<html>bad gateway</html>" };
      if (method === "GET" && moods.eventMood === "list-down") return { status: 503, body: "<html>unavailable</html>" };
      if (method === "GET") return { body: events.map(({ body: _body, reason: _reason, ...listed }) => listed) };
      if (method === "POST") {
        if (moods.eventMood === "forbidden") return { status: 403, body: { code: 50013, message: "Missing Permissions" } };
        const body = request.body as { readonly name: string; readonly scheduled_start_time: string };
        // The connection dropped, the event not (yet) listed: Discord may still make it.
        if (moods.eventMood === "dropped-not-listed") throw new TypeError("fetch failed: socket hang up");
        if (moods.eventMood !== "lost-not-made")
          events.push({
            id: nextId(),
            name: body.name,
            scheduled_start_time: body.scheduled_start_time,
            body: request.body as Record<string, unknown>,
            ...(request.headers["x-audit-log-reason"] === undefined
              ? {}
              : { reason: decodeURIComponent(request.headers["x-audit-log-reason"]) }),
          });
        if (moods.eventMood === "lost-made" || moods.eventMood === "lost-not-made" || moods.eventMood === "lost-unlisted")
          return { status: 502, body: "<html>bad gateway</html>" };
        return { body: { id: events.at(-1)?.id } };
      }
    }
    const reading = /^\/channels\/(\d+)\/messages\?limit=(\d+)(?:&before=(\d+))?$/.exec(path);
    if (method === "GET" && reading !== null) {
      if (!history.has(reading[1] ?? "") && !rooms.includes(reading[1] ?? ""))
        return { status: 403, body: { code: 50001, message: "Missing Access" } };
      const all = history.get(reading[1] ?? "") ?? [];
      const upTo =
        reading[3] === undefined
          ? all
          : all.slice(
              0,
              Math.max(
                0,
                all.findIndex((message) => message["id"] === reading[3]),
              ),
            );
      // As Discord answers: newest first.
      return { body: upTo.slice(-Number(reading[2])).reverse() };
    }
    const messageRead = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (method === "GET" && messageRead !== null && polls.has(messageRead[2] ?? "")) {
      const poll = polls.get(messageRead[2] ?? "");
      return {
        body: {
          id: messageRead[2],
          channel_id: messageRead[1],
          poll: {
            question: { text: poll?.question },
            answers: poll?.answers.map((text, index) => ({ answer_id: index + 1, poll_media: { text } })),
            expiry: "2026-10-19T00:00:00.000000+00:00",
            results: {
              is_finalized: poll?.ended === true,
              answer_counts: poll?.answers.map((_text, index) => ({
                id: index + 1,
                count: poll.votes.get(index + 1)?.size ?? 0,
                me_voted: false,
              })),
            },
          },
        },
      };
    }
    if (method === "GET" && messageRead !== null) {
      const message = options.messages?.[`${messageRead[1] ?? ""}/${messageRead[2] ?? ""}`];
      return message === undefined
        ? { status: 404, body: { code: 10008, message: "Unknown Message" } }
        : { body: { id: messageRead[2], channel_id: messageRead[1], ...message } };
    }
    const channelRead = /^\/channels\/(\d+)$/.exec(path);
    if (method === "GET" && channelRead !== null) {
      const thread = options.threads?.[channelRead[1] ?? ""];
      return thread === undefined
        ? { status: 404, body: { code: 10003, message: "Unknown Channel" } }
        : { body: { id: channelRead[1], guild_id: GUILD, type: thread.type ?? 11, ...thread } };
    }
    const threading = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(path);
    if (method === "POST" && threading !== null) {
      const from = threading[2] ?? "";
      if (!rooms.includes(threading[1] ?? "")) return { status: 404, body: { code: 10008, message: "Unknown Message" } };
      if (openedThreads.has(from))
        return { status: 400, body: { code: 160004, message: "A thread has already been created for this message" } };
      openedThreads.set(from, {
        channel: threading[1] ?? "",
        name: String((request.body as { readonly name?: unknown } | undefined)?.name ?? ""),
      });
      return { status: 201, body: { id: from, type: 11, parent_id: threading[1], owner_id: BOT, guild_id: GUILD } };
    }
    const sending = /^\/channels\/(\d+)\/messages$/.exec(path);
    if (method === "POST" && sending !== null) {
      const channel = sending[1] ?? "";
      // Never answered: the request's own timeout ends it (fake-rest races the signal).
      if (options.sendMood === "hang") return new Promise<never>(() => undefined);
      if (options.sendMood === "garbled") return { status: 502, body: "<html>bad gateway</html>" };
      if (options.sendMood === "echo") throw new TypeError(`fetch failed with ${JSON.stringify(request.headers)}`);
      if (channel === dmChannels.get(CLOSED_USER))
        return { status: 403, body: { code: 50007, message: "Cannot send messages to this user" } };
      const body = request.body as {
        readonly content?: string;
        readonly flags?: number;
        readonly nonce?: string;
        readonly allowed_mentions?: { readonly parse?: readonly string[] };
        readonly components?: unknown;
      };
      const repeated = body.nonce === undefined ? undefined : nonces.get(body.nonce);
      if (repeated !== undefined) return { body: { id: repeated, channel_id: channel } };
      const id = nextId();
      if (body.nonce !== undefined) nonces.set(body.nonce, id);
      const poll = (
        request.body as {
          readonly poll?: {
            readonly question: { readonly text: string };
            readonly answers: readonly { readonly poll_media: { readonly text: string } }[];
          };
        }
      ).poll;
      if (poll !== undefined)
        polls.set(id, {
          question: poll.question.text,
          answers: poll.answers.map((answer) => answer.poll_media.text),
          votes: new Map(),
          ended: false,
        });
      posted.push({
        id,
        channel,
        content: body.content ?? "",
        flags: body.flags ?? 0,
        ...(body.allowed_mentions === undefined ? {} : { allowedMentions: body.allowed_mentions }),
        ...(body.components === undefined ? {} : { components: body.components }),
        ephemeral: false,
      });
      return { body: { id, channel_id: channel } };
    }
    if (method === "PATCH" && /^\/channels\/\d+\/messages\/\d+$/.test(path)) {
      const id = path.split("/").at(-1) ?? "";
      const edited = posted.find((post) => post.id === id);
      const body = request.body as { readonly content?: string; readonly components?: unknown } | undefined;
      if (edited !== undefined && body?.content !== undefined) edited.content = body.content;
      if (edited !== undefined && body?.components !== undefined) edited.components = body.components;
      return { body: { id } };
    }
    if (method === "POST" && /^\/interactions\/\d+\/[^/]+\/callback$/.test(path)) return { status: 204 };
    // Read with `?with_localizations=true`, as the connector does: routed by its path alone.
    if (path.split("?")[0] === `/applications/${APP}/commands`) {
      if (method === "GET")
        return { body: commands.current, ...(typeof options.commandsMood === "object" ? { hold: options.commandsMood.holdUntil } : {}) };
      if (method === "PUT" && options.commandsMood === "refuse")
        return { status: 400, body: { code: 50035, message: "Invalid Form Body" } };
      if (method === "PUT") {
        commands.overwrites += 1;
        // As Discord answers: each with its id and version, and the defaults it fills in.
        commands.current = (request.body as unknown[]).map((command, index) => ({
          id: `75000000000000000${String(index)}`,
          application_id: APP,
          version: "1",
          default_member_permissions: null,
          ...(command as object),
        }));
        return { body: commands.current };
      }
    }
    const original = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(path);
    if (method === "PATCH" && original !== null) {
      const content = String((request.body as { readonly content?: unknown } | undefined)?.content ?? "");
      const channel = `interaction:${original[2] ?? ""}`;
      // One answer per command, edited in place: its id is its token's.
      const id = `original:${original[2] ?? ""}`;
      const known = posted.find((post) => post.id === id);
      if (known !== undefined) known.content = content;
      else posted.push({ id, channel, content, flags: 64, ephemeral: true });
      return { body: { id } };
    }
    // Typing shows in the guild's rooms; anywhere else the bot may not post (50013).
    const typing = /^\/channels\/(\d+)\/typing$/.exec(path);
    if (method === "POST" && typing !== null)
      return rooms.includes(typing[1] ?? "") || [...dmChannels.values()].includes(typing[1] ?? "")
        ? { status: 204 }
        : { status: 403, body: { code: 50013, message: "Missing Permissions" } };
    const followUp = /^\/webhooks\/(\d+)\/([^/]+)$/.exec(path);
    if (method === "POST" && followUp !== null) {
      const body = request.body as { readonly content?: string; readonly flags?: number };
      posted.push({
        id: nextId(),
        channel: `interaction:${followUp[2] ?? ""}`,
        content: body.content ?? "",
        flags: body.flags ?? 0,
        ephemeral: ((body.flags ?? 0) & 64) !== 0,
      });
      return { body: { id: "follow-up" } };
    }
    const leaving = /^\/users\/@me\/guilds\/(\d+)$/.exec(path);
    if (method === "DELETE" && leaving !== null) {
      left.push(leaving[1] ?? "");
      return { status: 204 };
    }
    return { status: 404, body: { code: 10003, message: "Unknown route" } };
  };
  const rest = fakeRest(route);

  /** Each connection is greeted at once: Hello, READY listing the guild, its GUILD_CREATE, and what was queued meanwhile. */
  const webSocket = (url: string): FakeSocket => {
    const socket = gateway.webSocket(url);
    queueMicrotask(() => {
      socket.hello(1_000_000);
      socket.dispatch(
        "READY",
        {
          v: 10,
          session_id: "fake-session",
          resume_gateway_url: "wss://resume.discord.gg",
          user: { id: BOT, bot: true, username: "tavi" },
          application: { id: APP },
          guilds: [
            { id: GUILD, unavailable: true },
            ...(options.guilds ?? []).map((extra) => ({ id: (extra as { readonly id: string }).id, unavailable: true })),
          ],
        },
        (seq += 1),
      );
      socket.dispatch("GUILD_CREATE", guild, (seq += 1));
      for (const extra of options.guilds ?? []) socket.dispatch("GUILD_CREATE", extra, (seq += 1));
      for (const event of pending.splice(0)) socket.dispatch(event.t, event.d, (seq += 1));
    });
    return socket;
  };

  return {
    fetch: rest.fetch,
    requests: rest.requests,
    webSocket,
    clock,
    posted,
    dmChannels,
    left,
    openedThreads,
    cdn,
    commands,
    polls,
    events,
    history,
    application,
    moods,
    /** A person votes in a poll, for its answer at `index` (from 0). */
    vote(pollId: string, voter: string, index: number): void {
      const poll = polls.get(pollId);
      if (poll === undefined) throw new Error(`no poll ${pollId}`);
      const voters = poll.votes.get(index + 1) ?? new Set<string>();
      voters.add(voter);
      poll.votes.set(index + 1, voters);
    },
    /** A dispatch from Discord: now on the open connection, or as soon as one opens. */
    dispatch(t: string, d: unknown): void {
      if (t === "MESSAGE_CREATE") {
        const message = d as Record<string, unknown>;
        const channel = String(message["channel_id"] ?? "");
        history.set(channel, [...(history.get(channel) ?? []), message]);
      }
      const socket = gateway.sockets.at(-1);
      if (socket === undefined || socket.closedWith !== undefined) pending.push({ t, d });
      else socket.dispatch(t, d, (seq += 1));
    },
    /** A dispatch Discord sends again on the open connection, as a resume replays what was missed: its message is already in the history. */
    replay(t: string, d: unknown): void {
      const socket = gateway.sockets.at(-1);
      if (socket === undefined || socket.closedWith !== undefined) pending.push({ t, d });
      else socket.dispatch(t, d, (seq += 1));
    },
    sockets: gateway.sockets,
    nextId,
  };
}

/** Real turns for what the connector does over several (an acknowledgement, a handler, the next turn's release). */
export async function turns(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
