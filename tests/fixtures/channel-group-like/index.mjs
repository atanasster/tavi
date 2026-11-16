/**
 * A test-only group channel plugin (docs/CHANNEL-PLUGINS.md), built for
 * channel ABI 2, and the fake platform it talks to. The platform has what the group seam must carry: rooms, mentions, replies,
 * commands, picked messages, button presses, one-to-one chats with their own
 * ids (as Discord's DM channels are), polls whose results can be read any
 * time, events, recent history, a user who cannot be written to one-to-one,
 * the bot added to and removed from rooms, and leaving one.
 *
 * The connector reaches the platform over `fetch` (the host's `channelHost.fetch`,
 * a test's fake), at `<apiBaseUrl>/<method>`, with a bearer token; it long-polls
 * `updates` for what happened. Plain JavaScript with Node builtins only, as an
 * external plugin's entry must be. Never point it at anything real.
 */

const DEFAULT_API = "https://group-like.test/api";
const BOT_ID = "bot-1";
const MASS_MENTION = /@(everyone|here)\b/;

/**
 * The fake platform: `fetch` is what the connector calls, the rest is the
 * test's side — what people do on the platform, and what the bot put there.
 */
export function createGroupLikePlatform(options = {}) {
  const token = options.token ?? "group-like-s3cret";
  /** People who never opened a chat with the bot. */
  const closed = new Set(options.closed ?? ["closed-1"]);
  const rooms = new Map((options.rooms ?? [{ id: "room-1", name: "General", place: "Fixture HQ" }]).map((room) => [room.id, { ...room, history: [] }]));
  const updates = [];
  const waiting = new Set();
  const sent = [];
  const polls = new Map();
  const pollsByNonce = new Map();
  const events = [];
  const left = [];
  const nonces = new Map();
  let seq = 0;
  let ids = 0;
  /** Resolvers waiting for the connector to take updates past a sequence number. */
  const taken = [];

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const nextId = (prefix) => `${prefix}-${(ids += 1)}`;
  const push = (update) => {
    seq += 1;
    const entry = { seq, ...update };
    updates.push(entry);
    for (const wake of [...waiting]) wake();
    return entry;
  };
  const record = (room, message) => {
    rooms.get(room)?.history.push(message);
  };

  const methods = {
    me: () => ({ id: BOT_ID, name: "Tavi" }),
    async updates(body, signal) {
      const after = Number(body.after ?? 0);
      for (const waiter of taken.filter((entry) => entry.seq <= after)) {
        taken.splice(taken.indexOf(waiter), 1);
        waiter.resolve();
      }
      while (!updates.some((update) => update.seq > after)) {
        await new Promise((resolve, reject) => {
          const wake = () => {
            waiting.delete(wake);
            resolve();
          };
          waiting.add(wake);
          signal?.addEventListener("abort", () => {
            waiting.delete(wake);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return { updates: updates.filter((update) => update.seq > after).slice(0, 20) };
    },
    send(body) {
      // A repeated nonce is the same message: the platform answers what it answered before.
      if (typeof body.nonce === "string" && nonces.has(body.nonce)) return nonces.get(body.nonce);
      const channel = String(body.channel ?? "");
      if (channel.startsWith("dm:") && closed.has(channel.slice(3))) return { status: 403, body: { error: "cannot send messages to this user", code: "unreachable" } };
      if (!channel.startsWith("dm:") && !rooms.has(channel)) return { status: 404, body: { error: "unknown channel" } };
      const id = nextId("msg");
      const text = String(body.text ?? "");
      sent.push({
        id,
        conversation: channel,
        visibleInRoom: !channel.startsWith("dm:"),
        text,
        buttons: body.buttons ?? [],
        replyTo: body.replyTo,
        linkPreview: body.suppressEmbeds !== true && /https?:\/\//.test(text),
        massMention: MASS_MENTION.test(text) && (body.allowedMentions ?? ["everyone"]).includes("everyone"),
      });
      if (!channel.startsWith("dm:")) record(channel, { id, author: { id: BOT_ID, bot: true }, text, at: new Date().toISOString() });
      const answer = { status: 200, body: { id } };
      if (typeof body.nonce === "string") nonces.set(body.nonce, answer);
      return answer;
    },
    edit(body) {
      const target = sent.find((entry) => entry.id === body.id);
      if (target !== undefined) target.text = String(body.text ?? "");
      return {};
    },
    /** A press's answer is shown to the presser alone. */
    answer(body) {
      sent.push({ conversation: `press:${body.pressId}`, visibleInRoom: false, text: String(body.text ?? ""), linkPreview: false, massMention: false });
      return {};
    },
    rooms: () => ({ rooms: [...rooms.values()].map(({ id, name, place }) => ({ id, name, ...(place === undefined ? {} : { place }) })) }),
    recent(body) {
      const room = rooms.get(String(body.channel ?? ""));
      if (room === undefined) return { status: 404, body: { error: "unknown channel" } };
      const before = typeof body.before === "string" ? room.history.findIndex((message) => message.id === body.before) : -1;
      const upTo = before >= 0 ? room.history.slice(0, before) : room.history;
      return { messages: upTo.slice(-Math.max(1, Math.min(50, Number(body.limit ?? 20)))) };
    },
    leave(body) {
      left.push(String(body.room ?? ""));
      return {};
    },
    "poll-create"(body) {
      if (pollsByNonce.has(body.nonce)) return { id: pollsByNonce.get(body.nonce) };
      const id = nextId("poll");
      polls.set(id, { channel: body.channel, question: body.question, answers: body.answers.map((text) => ({ text, voters: [] })), multi: body.multiSelect === true, ended: false, expiresAt: new Date(Date.now() + Number(body.hours) * 3_600_000).toISOString() });
      pollsByNonce.set(body.nonce, id);
      return { id };
    },
    "poll-read"(body) {
      const poll = polls.get(body.id);
      if (poll === undefined) return { status: 404, body: { error: "unknown poll" } };
      return { ended: poll.ended, expiresAt: poll.expiresAt, answers: poll.answers.map((answer) => ({ text: answer.text, count: answer.voters.length, voters: answer.voters.slice(0, 100) })) };
    },
    "poll-end"(body) {
      const poll = polls.get(body.id);
      if (poll === undefined) return { status: 404, body: { error: "unknown poll" } };
      poll.ended = true;
      return { id: body.id };
    },
    "event-create"(body) {
      const existing = events.find((event) => event.nonce === body.nonce);
      if (existing !== undefined) return { id: existing.id, url: existing.url };
      const id = nextId("event");
      const event = { id, url: `https://group-like.test/events/${id}`, ...body };
      events.push(event);
      return { id, url: event.url };
    },
  };

  const fetchImpl = async (url, init = {}) => {
    const method = String(url).split("/").pop() ?? "";
    if (init.headers?.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
    const handler = methods[method];
    if (handler === undefined) return json(404, { error: "no such method" });
    let body;
    try {
      body = JSON.parse(String(init.body ?? "{}"));
    } catch {
      return json(400, { error: "bad body" });
    }
    const answer = await handler(body, init.signal);
    return answer?.status !== undefined && answer.body !== undefined ? json(answer.status, answer.body) : json(200, answer);
  };

  /** A message a person writes, marked up as the platform names the bot in it; `past` is room history only. */
  const say = (input) => {
    const id = input.id ?? nextId("msg");
    const author = { id: input.author, ...(input.bot === true ? { bot: true } : {}), ...(input.system === true ? { system: true } : {}) };
    const message = {
      id,
      ...(input.room === undefined ? { channel: `dm:${input.author}`, direct: true } : { channel: input.room }),
      author,
      text: input.mention === true ? `<@${BOT_ID}> ${input.text ?? ""}`.trim() : (input.text ?? ""),
      mentions: input.mention === true ? [BOT_ID] : [],
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.command === undefined ? {} : { command: input.command }),
      ...(input.picked === undefined ? {} : { picked: input.picked }),
      ...(input.thread === undefined ? {} : { thread: input.thread }),
      at: new Date().toISOString(),
    };
    if (input.room !== undefined) record(input.room, { id, author, text: message.text, at: message.at });
    // A message from before the bot was listening is history only: it never arrives as an update.
    return input.past === true ? { seq, type: "message" } : push({ type: "message", message });
  };

  return {
    fetch: fetchImpl,
    token,
    botId: BOT_ID,
    say,
    press: (input) => push({ type: "press", press: { id: nextId("press"), presser: input.presser, data: input.data, messageId: input.messageId ?? "msg-0", channel: input.room ?? "room-1" } }),
    member: (input) => push({ type: "member", member: { room: input.room, by: input.by, change: input.change, name: input.name } }),
    /** Resolves once the connector has taken every update so far. */
    settled() {
      const target = seq;
      return new Promise((resolve) => taken.push({ seq: target, resolve }));
    },
    vote(pollId, voter, answer) {
      polls.get(pollId)?.answers[answer]?.voters.push(voter);
    },
    sent: () => sent,
    polls: () => polls,
    events: () => events,
    left: () => left,
    rooms,
  };
}

/** The connector, over `fetch` (the fake platform). */
export function createGroupLikeDefinition({ z, TaviError, fetch: fetchImpl = globalThis.fetch, now = () => new Date().toISOString() }) {
  const capabilities = {
    receiveMode: "poll", send: true, editOrProgress: true, formats: ["plain"], attachments: false, maxAttachmentBytes: 0,
    maxPartsPerMessage: 1, threads: true, interactions: true, deliveryReceipts: false, maxTextLength: 2000, approvals: "buttons",
    groups: {
      addressing: ["mention", "reply", "thread", "command", "picked"],
      directToSender: true,
      listRooms: true,
      membershipEvents: true,
      leaveRoom: true,
      recentHistory: { maxMessages: 50 },
      polls: { maxQuestion: 300, maxAnswers: 10, maxAnswerLength: 55, maxHours: 768, multiSelect: true, results: "fetch" },
      events: { kinds: ["external"], maxTitle: 100, maxDescription: 1000 },
    },
  };
  const channelOf = (destination) => {
    const channel = destination?.channel;
    if (typeof channel !== "string" || channel === "") throw new TaviError("INVALID_INPUT", "a group-like destination names its channel");
    return channel;
  };
  return {
    providerId: "group-like",
    version: "1.0.0",
    configSchema: z.object({ apiBaseUrl: z.string().url().optional(), requestTimeoutMs: z.number().int().positive().optional() }).passthrough(),
    capabilities,
    createConnection: ({ connection, config, credentials }) => {
      const base = config.apiBaseUrl ?? DEFAULT_API;
      let state = "stopped";
      let since = now();
      let repair;
      let token;
      let loop;
      let controller;
      let handler;
      let after = 0;
      let accountRef;
      const status = () => ({ state, since, ...(repair === undefined ? {} : { repair }), ...(accountRef === undefined ? {} : { accountRef }) });
      /** One platform call; its error never carries the token. */
      const call = async (method, body, signal) => {
        const timeout = AbortSignal.timeout(method === "updates" ? 60 * 60 * 1000 : (config.requestTimeoutMs ?? 5000));
        const response = await fetchImpl(`${base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
        const answer = await response.json().catch(() => undefined);
        return { ok: response.ok, status: response.status, answer };
      };
      const redacted = (error) => String(error?.message ?? error).split(token ?? "\u0000").join("[redacted]");
      const toEvent = (update) => {
        const at = now();
        if (update.type === "press") {
          const press = update.press;
          return { connectionId: connection.connectionId, providerEventId: `press:${press.id}`, kind: "interaction", externalSenderId: String(press.presser), externalConversationId: String(press.channel), externalMessageId: String(press.messageId), occurredAt: at, receivedAt: at, interaction: { data: String(press.data), callbackId: String(press.id), messageId: String(press.messageId) } };
        }
        if (update.type === "member") {
          const member = update.member;
          return { connectionId: connection.connectionId, providerEventId: `member:${update.seq}`, kind: "membership", externalSenderId: String(member.by), externalConversationId: String(member.room), conversationKind: "group", occurredAt: at, receivedAt: at, membership: { change: member.change, ...(member.name === undefined ? {} : { roomName: String(member.name).slice(0, 120) }) } };
        }
        const message = update.message;
        if (message === undefined) return undefined;
        const addressed = [];
        if ((message.mentions ?? []).includes(BOT_ID)) addressed.push("mention");
        if (message.replyTo?.author === BOT_ID) addressed.push("reply");
        if (message.thread?.startedByBot === true) addressed.push("thread");
        if (message.command !== undefined) addressed.push("command");
        if (message.picked !== undefined) addressed.push("picked");
        // The leading mention is the address, not the person's words.
        const text = String(message.text ?? "").replace(new RegExp(`^<@${BOT_ID}>\\s*`), "");
        const authorKind = message.author?.system === true ? "system" : message.author?.bot === true ? "bot" : "person";
        const quoted = message.picked ?? (message.replyTo !== undefined && message.replyTo.author !== BOT_ID ? message.replyTo : undefined);
        return {
          connectionId: connection.connectionId,
          providerEventId: `msg:${message.id}`,
          kind: "message",
          externalSenderId: String(message.author?.id ?? ""),
          externalConversationId: String(message.channel),
          conversationKind: message.direct === true ? "direct" : message.thread !== undefined ? "thread" : "group",
          ...(message.thread === undefined ? {} : { externalThreadId: String(message.thread.id) }),
          externalMessageId: String(message.id),
          ...(message.replyTo === undefined ? {} : { externalReplyToId: String(message.replyTo.id) }),
          occurredAt: String(message.at ?? at),
          receivedAt: at,
          ...(text === "" ? {} : { content: message.command !== undefined ? `/${message.command} ${text}`.trim() : text }),
          ...(addressed.length === 0 ? {} : { addressed }),
          authorKind,
          ...(quoted === undefined ? {} : { referenced: { externalSenderId: String(quoted.author), externalMessageId: String(quoted.id), ...(quoted.text === undefined ? {} : { content: String(quoted.text) }), via: message.picked !== undefined ? "picked" : "reply" } }),
        };
      };
      const poll = async (signal) => {
        while (!signal.aborted) {
          let result;
          try {
            result = await call("updates", { after }, signal);
          } catch (error) {
            if (signal.aborted) return;
            // Running again only once a poll succeeds.
            state = "failed";
            since = now();
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
          if (!result.ok) {
            state = "failed";
            since = now();
            if (result.status === 401) repair = "credentials";
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
          repair = undefined;
          state = "running";
          for (const update of result.answer?.updates ?? []) {
            const event = toEvent(update);
            try {
              if (event !== undefined) {
                if (handler === undefined) throw new Error("no inbound handler is registered");
                await handler(event);
              }
              after = update.seq;
            } catch {
              // Not taken: asked for again after a pause, never in a tight loop.
              await new Promise((resolve) => setTimeout(resolve, 10));
              break;
            }
          }
        }
      };
      const posted = (result, effectId) => {
        if (result.ok && typeof result.answer?.id === "string") return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: result.answer.id }] };
        return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: `group-like refused ${effectId}: ${String(result.answer?.error ?? `HTTP ${result.status}`)}`, ...(result.answer?.code === "unreachable" ? { unreachable: true } : {}) }] };
      };
      /** A call whose refusal is the caller's error, never a quiet success. */
      const required = async (method, body, signal) => {
        const result = await call(method, body, signal);
        if (!result.ok) throw new TaviError("UNAVAILABLE", `group-like refused ${method}: ${String(result.answer?.error ?? `HTTP ${result.status}`)}`);
        return result;
      };
      const running = () => {
        if (state !== "running" && state !== "failed") throw new TaviError("UNAVAILABLE", `group-like connection ${connection.connectionId} is not running`);
      };
      return {
        async start() {
          token = await credentials.get("token");
          if (token === null) throw new TaviError("NOT_CONFIGURED", `group-like connection ${connection.connectionId} has no token`);
          const me = await call("me", {});
          if (!me.ok) {
            state = "failed";
            if (me.status === 401) repair = "credentials";
            throw new TaviError("UNAVAILABLE", `group-like refused the token for ${connection.connectionId}`, { details: { connectionId: connection.connectionId, ...(repair === undefined ? {} : { repair }) } });
          }
          state = "running";
          since = now();
          accountRef = typeof me.answer?.id === "string" ? me.answer.id : undefined;
          controller = new AbortController();
          const signal = controller.signal;
          // Nothing is handed over before start() returns (CHANNEL-PLUGINS.md): the loop begins on the next turn.
          loop = new Promise((resolve) => setTimeout(resolve, 0)).then(() => poll(signal));
        },
        async stop() {
          controller?.abort();
          await loop?.catch(() => undefined);
          state = "stopped";
          since = now();
        },
        status,
        probe: async () => ({ ok: state === "running" }),
        onInboundEvent(next) {
          handler = next;
        },
        async send(message) {
          running();
          const part = message.parts[0];
          if (part === undefined || "artifactId" in part) return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "group-like does not carry files" }] };
          const channel = channelOf(message.destination);
          try {
            return posted(await call("send", {
              channel,
              text: part.content,
              nonce: message.effectId,
              // No link previews, no mass mentions.
              suppressEmbeds: true,
              allowedMentions: [],
              ...(message.destination?.replyTo === undefined ? {} : { replyTo: message.destination.replyTo }),
              ...(message.buttons === undefined ? {} : { buttons: message.buttons }),
            }), message.effectId);
          } catch (error) {
            return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error: redacted(error) }] };
          }
        },
        async answerInteraction(callbackId, text) {
          if (token === undefined) return;
          await required("answer", { pressId: callbackId, text: text.slice(0, 200) });
        },
        async editMessage(input) {
          await required("edit", { channel: channelOf(input.destination), id: input.messageId, text: input.text });
        },
        async listRooms() {
          running();
          const result = await required("rooms", {});
          return (result.answer?.rooms ?? []).map((room) => ({ id: String(room.id), name: String(room.name).slice(0, 120), ...(room.place === undefined ? {} : { place: String(room.place).slice(0, 120) }) }));
        },
        async fetchRecent(destination, { limit, before, signal }) {
          running();
          const result = await call("recent", { channel: channelOf(destination), limit, ...(before === undefined ? {} : { before }) }, signal);
          return (result.answer?.messages ?? []).slice(-limit).map((message) => ({
            externalSenderId: String(message.author?.id ?? ""),
            externalMessageId: String(message.id),
            authorKind: message.author?.system === true ? "system" : message.author?.bot === true ? "bot" : "person",
            ...(message.text === undefined ? {} : { content: String(message.text) }),
            at: String(message.at),
          }));
        },
        async createPoll(input) {
          running();
          return posted(await call("poll-create", { channel: channelOf(input.destination), question: input.question, answers: input.answers, hours: input.hours, multiSelect: input.multiSelect, nonce: input.effectId }), input.effectId);
        },
        async readPoll(_destination, messageId) {
          running();
          const result = await call("poll-read", { id: messageId });
          if (!result.ok) throw new TaviError("NOT_FOUND", `no group-like poll ${messageId}`);
          return { finalized: result.answer.ended === true, ...(result.answer.expiresAt === undefined ? {} : { expiresAt: result.answer.expiresAt }), answers: result.answer.answers };
        },
        async endPoll(input) {
          running();
          return posted(await call("poll-end", { id: input.messageId, nonce: input.effectId }), input.effectId);
        },
        async createEvent(input) {
          running();
          const result = await call("event-create", { channel: channelOf(input.destination), title: input.title, ...(input.description === undefined ? {} : { description: input.description }), start: input.start, end: input.end, location: input.location, nonce: input.effectId });
          const outcome = posted(result, input.effectId);
          return typeof result.answer?.url === "string" ? { ...outcome, url: result.answer.url } : outcome;
        },
        async leaveRoom(destination) {
          running();
          await required("leave", { room: channelOf(destination) });
        },
      };
    },
    // A room's reply stays in the room (and its thread); a direct message's goes back to its own chat.
    destinationFromInbound: (replyTo) => ({ channel: replyTo.externalConversationId, ...(replyTo.externalMessageId === undefined ? {} : { replyTo: replyTo.externalMessageId }) }),
    destinationFor: (target) => ({ channel: target.to }),
    // A sender's one-to-one chat has its own id, not theirs (as a Discord DM channel does).
    directDestinationOf: (externalSenderId) => ({ channel: `dm:${externalSenderId}` }),
    paceTargetOf: (destination) => (typeof destination?.channel === "string" ? destination.channel : undefined),
  };
}

export function register({ registerChannel, z, TaviError, channelHost }) {
  registerChannel(createGroupLikeDefinition({ z, TaviError, ...(channelHost === undefined ? {} : { fetch: channelHost.fetch, now: channelHost.now }) }));
}
