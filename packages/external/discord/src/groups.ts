import { redactedError } from "@tavi/channel-kit";
import { TaviError } from "@tavi/contracts";
import type { ChannelEventInput, ChannelPollInput, ChannelPollState, SendOutcome } from "@tavi/contracts";

import type { DiscordReply, DiscordRest } from "./rest.js";
import { nonceOf, refusedReceipt, SUPPRESS_EMBEDS } from "./send.js";

/**
 * Polls and events: a poll
 * is a message, idempotent by the effect's nonce as any send; a scheduled
 * event has no nonce, so one is looked for in the server's events (by its
 * name and start) before it is created, and an unknown outcome is settled
 * by the same look. Voters are Discord's user ids, which the host maps to
 * people.
 */

/** Each answer's voters Discord lists at most in one read: the host's bound (`ChannelPollState`). */
const VOTERS_MAX = 100;

interface PollMessage {
  readonly poll?: {
    readonly answers?: readonly { readonly answer_id?: unknown; readonly poll_media?: { readonly text?: unknown } }[];
    readonly expiry?: unknown;
    readonly results?: {
      readonly is_finalized?: unknown;
      readonly answer_counts?: readonly { readonly id?: unknown; readonly count?: unknown }[];
    } | null;
  } | null;
}

/** One part refused: nothing was made. */
function rejected(error: string, retryable = false): SendOutcome {
  return { status: "rejected", retryable, parts: [{ index: 0, status: "rejected", error }] };
}

/** A send's outcome from one part's answer: Discord's refusal as a receipt, a transport failure `uncertain`. */
function outcomeOf(reply: DiscordReply<{ readonly id?: unknown }> | { readonly failed: string }, room: boolean): SendOutcome {
  if ("failed" in reply) return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error: reply.failed }] };
  if (reply.ok && typeof reply.body?.id === "string")
    return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: reply.body.id }] };
  const { retryAfterMs, ...part } = refusedReceipt(0, reply, room);
  return {
    status: part.status,
    retryable: retryAfterMs !== undefined,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    parts: [part],
  };
}

/** A request's answer, or why it may or may not have reached Discord: the client's own refusal sent nothing. */
async function attempt<T>(
  run: () => Promise<DiscordReply<T>>,
  token: string | undefined,
): Promise<DiscordReply<T> | { readonly failed: string } | { readonly refused: string }> {
  try {
    return await run();
  } catch (error) {
    return error instanceof TaviError ? { refused: error.message } : { failed: redactedError(error, [token]) };
  }
}

export async function createPoll(
  rest: DiscordRest,
  channelId: string,
  input: ChannelPollInput,
  token: string | undefined,
): Promise<SendOutcome> {
  const reply = await attempt(
    () =>
      rest.request<{ readonly id?: unknown }>("POST", `/channels/${channelId}/messages`, {
        body: {
          poll: {
            question: { text: input.question },
            answers: input.answers.map((text) => ({ poll_media: { text } })),
            duration: input.hours,
            allow_multiselect: input.multiSelect,
            layout_type: 1,
          },
          nonce: nonceOf(input.effectId),
          enforce_nonce: true,
          flags: SUPPRESS_EMBEDS,
          allowed_mentions: { parse: [] },
        },
      }),
    token,
  );
  if ("refused" in reply) return rejected(reply.refused);
  // 50013 on a poll is a permission a poll needs: Send Polls, or Send Messages itself; the room's detail names them.
  if (!("failed" in reply) && !reply.ok && reply.code === 50013)
    return rejected("the bot lacks Send Polls (or Send Messages) in this room");
  return outcomeOf(reply, true);
}

export async function endPoll(rest: DiscordRest, channelId: string, messageId: string, token: string | undefined): Promise<SendOutcome> {
  const reply = await attempt(
    () => rest.request<{ readonly id?: unknown }>("POST", `/channels/${channelId}/polls/${messageId}/expire`),
    token,
  );
  if ("refused" in reply) return rejected(reply.refused);
  // A poll already over (520001) is ended: the effect stands.
  if (!("failed" in reply) && !reply.ok && reply.code === 520001)
    return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: messageId }] };
  return outcomeOf(reply, true);
}

/** A poll's question, its answers and their counts, and who voted for each (at most 100 per answer). */
export async function readPoll(rest: DiscordRest, channelId: string, messageId: string): Promise<ChannelPollState> {
  const message = await rest.request<PollMessage>("GET", `/channels/${channelId}/messages/${messageId}`);
  if (!message.ok)
    throw new TaviError(
      message.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
      `Discord would not read the poll (${String(message.status)})`,
    );
  const poll = message.body?.poll;
  if (poll === undefined || poll === null) throw new TaviError("NOT_FOUND", "that message is not a poll");
  const counts = new Map((poll.results?.answer_counts ?? []).map((entry) => [entry.id, typeof entry.count === "number" ? entry.count : 0]));
  const answers: { text: string; count: number; voters: string[] }[] = [];
  for (const answer of poll.answers ?? []) {
    const id = answer.answer_id;
    if (typeof id !== "number") continue;
    const voters = await rest.request<{ readonly users?: readonly { readonly id?: unknown }[] }>(
      "GET",
      `/channels/${channelId}/polls/${messageId}/answers/${String(id)}?limit=${String(VOTERS_MAX)}`,
    );
    answers.push({
      text: typeof answer.poll_media?.text === "string" ? answer.poll_media.text : "",
      count: counts.get(id) ?? 0,
      voters: voters.ok
        ? (voters.body?.users ?? []).flatMap((user) => (typeof user.id === "string" ? [user.id] : [])).slice(0, VOTERS_MAX)
        : [],
    });
  }
  return {
    finalized: poll.results?.is_finalized === true,
    ...(typeof poll.expiry === "string" ? { expiresAt: poll.expiry } : {}),
    answers,
  };
}

interface ScheduledEvent {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly scheduled_start_time?: unknown;
}

/** The server's event of this name that starts then, when there is one: what an earlier attempt of the same effect made. */
async function existingEvent(
  rest: DiscordRest,
  guildId: string,
  input: ChannelEventInput,
): Promise<{ readonly id: string } | "none" | "unknown"> {
  // Unread, the answer is "unknown" (below), never a guess.
  const listed = await rest.request<readonly ScheduledEvent[]>("GET", `/guilds/${guildId}/scheduled-events`).catch(() => undefined);
  if (listed === undefined || !listed.ok || !Array.isArray(listed.body)) return "unknown";
  const start = Date.parse(input.start);
  const found = listed.body.find(
    (event) =>
      event.name === input.title.slice(0, 100) &&
      typeof event.scheduled_start_time === "string" &&
      Date.parse(event.scheduled_start_time) === start,
  );
  return typeof found?.id === "string" ? { id: found.id } : "none";
}

/**
 * Creates an external event in the room's server (entity type 3), once: an
 * earlier attempt's is found first, and one whose answer was lost is looked
 * for before the outcome is told. Unknown until a listing proves it either way.
 */
export async function createEvent(
  rest: DiscordRest,
  guildId: string,
  input: ChannelEventInput,
  token: string | undefined,
): Promise<SendOutcome & { readonly url?: string }> {
  const accepted = (id: string): SendOutcome & { readonly url: string } => ({
    status: "accepted",
    retryable: false,
    parts: [{ index: 0, status: "accepted", providerMessageId: id }],
    url: `https://discord.com/events/${guildId}/${id}`,
  });
  const before = await existingEvent(rest, guildId, input);
  if (typeof before === "object") return accepted(before.id);
  // Without the list, an earlier attempt's event cannot be ruled out: nothing is made until it can (no nonce here).
  if (before === "unknown") return rejected("the server's events could not be read to check this one is not made already", true);
  const reply = await attempt(
    () =>
      rest.request<{ readonly id?: unknown }>("POST", `/guilds/${guildId}/scheduled-events`, {
        body: {
          name: input.title.slice(0, 100),
          ...(input.description === undefined ? {} : { description: input.description.slice(0, 1000) }),
          scheduled_start_time: new Date(input.start).toISOString(),
          scheduled_end_time: new Date(input.end).toISOString(),
          privacy_level: 2,
          entity_type: 3,
          entity_metadata: { location: input.location.slice(0, 100) },
        },
        reason: `tavi effect ${input.effectId}`,
      }),
    token,
  );
  if ("refused" in reply) return rejected(reply.refused);
  if ("failed" in reply || reply.status >= 500) {
    // Its answer was lost: the server's events say whether it was made. Found, it was.
    const after = await existingEvent(rest, guildId, input);
    if (typeof after === "object") return accepted(after.id);
    // Not found after Discord answered 5xx: it refused the request, so nothing was made. After a timeout
    // or a dropped connection Discord may still be making it, so it stays unknown until a listing finds it.
    if ("failed" in reply)
      return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error: reply.failed }] };
    const error = `Discord answered ${String(reply.status)}`;
    if (after === "none") return rejected(`${error}; the server has no such event, so it was not made`, true);
    return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error }] };
  }
  if (reply.ok && typeof reply.body?.id === "string") return accepted(reply.body.id);
  // 50013 here is Create Events missing: a room detail names what the bot needs.
  if (reply.code === 50013) return rejected("the bot lacks Create Events in this server");
  return outcomeOf(reply, true);
}
