import { createHash } from "node:crypto";

import { redactedError } from "@tavi/channel-kit";
import { TaviError } from "@tavi/contracts";
import type { OutboundButton, SendOutcome, SendOutcomePartReceipt } from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";

import { DISCORD_MAX_FILE_BYTES as MAX_FILE_BYTES, DISCORD_MAX_TEXT } from "./descriptor.js";
import type { DiscordReply, DiscordRest } from "./rest.js";

export { MAX_FILE_BYTES };

/**
 * Delivery to Discord:
 * every send and edit without a link preview (SUPPRESS_EMBEDS) or a ping
 * (`allowed_mentions` parsing nothing), idempotent by a nonce from the
 * effect id, a reply that still goes when its parent is gone, buttons in rows
 * of five, and a DM reached by its user's id through a channel resolved once
 * and kept for the run.
 */

/**
 * Where a send goes: a channel, or a user's DM, which is resolved to its
 * channel. `openFrom`: the channel is a thread not yet opened, from that
 * room message (a room's `autoThread`); the first send opens it.
 */
export type DiscordDestination =
  | {
      readonly channelId: string;
      readonly replyTo?: string;
      readonly openFrom?: { readonly channelId: string; readonly messageId: string };
    }
  | { readonly dmUserId: string; readonly replyTo?: string };

/** 160004: a thread was already opened from that message, as an earlier send of the same task did. */
const THREAD_ALREADY_OPEN = 160004;
const THREAD_NAME_MAX = 100;

/** A thread's name: the first line of what opens it, as Discord shows it in the room. */
export function threadNameOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "") ?? "";
  const name = clip(line, THREAD_NAME_MAX);
  return name === "" ? "Tavi" : name;
}

/** Opens the thread a send goes into from its room message; answers Discord's refusal, or nothing once it is open. */
export async function openThread(
  rest: DiscordRest,
  from: { readonly channelId: string; readonly messageId: string },
  name: string,
): Promise<DiscordReply | undefined> {
  const opened = await rest.request("POST", `/channels/${from.channelId}/messages/${from.messageId}/threads`, {
    body: { name, auto_archive_duration: 1440 },
  });
  return opened.ok || opened.code === THREAD_ALREADY_OPEN ? undefined : opened;
}

/** SUPPRESS_EMBEDS: Discord fetches no preview of a link in the text. */
export const SUPPRESS_EMBEDS = 1 << 2;
const NO_PINGS = { parse: [] as string[] };

/**
 * An edit's text within Discord's most. The host edits a sent piece by adding
 * an outcome after it (`…\n\n✅ …`): what is cut is the piece's own text,
 * so the outcome is still shown.
 */
export function editableText(text: string): string {
  if (text.length <= DISCORD_MAX_TEXT) return text;
  const at = text.lastIndexOf("\n\n");
  const tail = at >= 0 && text.length - at <= DISCORD_MAX_TEXT / 2 ? text.slice(at) : "";
  const head = text.slice(0, DISCORD_MAX_TEXT - tail.length - 1);
  // Never half a character: a cut through a surrogate pair drops its first half.
  return `${/[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head}…${tail}`;
}
const ROW_MAX = 5;
const ROWS_MAX = 5;

/** A nonce for an effect id: the same id is always the same 25 characters, so Discord sends it once (`enforce_nonce`). */
export function nonceOf(effectId: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = createHash("sha256").update(effectId).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  return out.slice(0, 25);
}

/** Buttons as Discord's action rows: secondary, and danger for a refusal (❌). */
function componentsOf(buttons: readonly (readonly OutboundButton[])[] | undefined): readonly unknown[] {
  if (buttons === undefined) return [];
  const flat = buttons.flat();
  const rows: unknown[] = [];
  for (let index = 0; index < flat.length && rows.length < ROWS_MAX; index += ROW_MAX) {
    rows.push({
      type: 1,
      components: flat.slice(index, index + ROW_MAX).map((button) => ({
        type: 2,
        style: button.label.trimStart().startsWith("❌") ? 4 : 2,
        label: button.label.slice(0, 80),
        custom_id: button.data.slice(0, 100),
      })),
    });
  }
  return rows;
}

/** A user's DM channel, resolved once a run (in sends and edits alike, so a settlement after a restart still finds it). */
export class DirectChannels {
  readonly #rest: DiscordRest;
  readonly #channels = new Map<string, string>();

  constructor(rest: DiscordRest) {
    this.#rest = rest;
  }

  /** The channel, or the refusal that says why there is none. */
  async channelOf(destination: DiscordDestination): Promise<{ readonly channelId: string } | { readonly refused: DiscordReply }> {
    if ("channelId" in destination) return { channelId: destination.channelId };
    const known = this.#channels.get(destination.dmUserId);
    if (known !== undefined) return { channelId: known };
    const opened = await this.#rest.request<{ readonly id?: unknown }>("POST", "/users/@me/channels", {
      body: { recipient_id: destination.dmUserId },
    });
    if (!opened.ok || typeof opened.body?.id !== "string") return { refused: opened };
    // A bounded cache: a long run meets many people.
    if (this.#channels.size >= 1000) {
      const oldest = this.#channels.keys().next().value;
      if (oldest !== undefined) this.#channels.delete(oldest);
    }
    this.#channels.set(destination.dmUserId, opened.body.id);
    return { channelId: opened.body.id };
  }
}

/** A refused request as a part's receipt: a DM Discord will not open is `unreachable`; a missing permission says so. */
export function refusedReceipt(
  index: number,
  reply: DiscordReply,
  room: boolean,
): SendOutcomePartReceipt & { readonly retryAfterMs?: number } {
  if (reply.status === 429)
    return {
      index,
      status: "rejected",
      error: "Discord asked to slow down",
      ...(reply.retryAfterMs === undefined ? {} : { retryAfterMs: reply.retryAfterMs }),
    };
  // 50007: Cannot send messages to this user (DMs closed, or no server in common).
  if (reply.code === 50007) return { index, status: "rejected", error: "Discord will not open a DM with this user", unreachable: true };
  // 50013: Missing Permissions — in a room, the bot was not given what it needs there.
  if (reply.code === 50013)
    return {
      index,
      status: "rejected",
      error: room
        ? "the bot lacks a permission it needs in this room (View Channel, Send Messages, Read Message History)"
        : "the bot lacks a permission it needs",
    };
  const detail = `Discord answered ${String(reply.status)}${reply.code === undefined ? "" : ` (${String(reply.code)})`}${reply.message === undefined ? "" : `: ${reply.message}`}`;
  return { index, status: reply.status >= 500 ? "uncertain" : "rejected", error: detail };
}

export interface SendInput {
  readonly effectId: string;
  readonly destination: DiscordDestination;
  readonly text: string;
  readonly buttons?: readonly (readonly OutboundButton[])[] | undefined;
  /** A file it carries, `text` its caption: sent as multipart, `payload_json` and `files[0]`. */
  readonly file?: { readonly bytes: Uint8Array; readonly filename: string; readonly contentType: string } | undefined;
}

/** Sends one part: text, or a file with its caption. A transport failure or a timeout is `uncertain`: it may have gone out. */
export async function sendText(
  rest: DiscordRest,
  directs: DirectChannels,
  input: SendInput,
  token: string | undefined,
): Promise<SendOutcome> {
  let receipt: SendOutcomePartReceipt & { readonly retryAfterMs?: number };
  /** Retryable though Discord named no wait: nothing was posted. */
  let retry = false;
  // Nothing was posted until the message's own request goes out: a DM that cannot be opened is a refusal, never unknown.
  let channel: Awaited<ReturnType<DirectChannels["channelOf"]>>;
  try {
    channel = await directs.channelOf(input.destination);
  } catch (error) {
    return {
      status: "rejected",
      retryable: false,
      parts: [{ index: 0, status: "rejected", error: `the DM could not be opened: ${redactedError(error, [token])}` }],
    };
  }
  try {
    // A DM Discord failed to open (5xx) posted nothing: a refusal to try again, never an unknown.
    if ("refused" in channel && channel.refused.status >= 500) {
      receipt = { index: 0, status: "rejected", error: `Discord could not open the DM (${String(channel.refused.status)})` };
      retry = true;
    } else if ("refused" in channel) receipt = refusedReceipt(0, channel.refused, false);
    else {
      const components = componentsOf(input.buttons);
      const form = input.file === undefined ? undefined : new FormData();
      if (input.file !== undefined)
        // Copied into a fresh `ArrayBuffer`: `Blob` takes no shared memory, and a pooled `Buffer` slice would carry the whole pool.
        form?.set("files[0]", new Blob([new Uint8Array(input.file.bytes)], { type: input.file.contentType }), input.file.filename);
      const sent = await rest.request<{ readonly id?: unknown }>("POST", `/channels/${channel.channelId}/messages`, {
        body: {
          content: input.text,
          flags: SUPPRESS_EMBEDS,
          allowed_mentions: NO_PINGS,
          nonce: nonceOf(input.effectId),
          enforce_nonce: true,
          ...(input.destination.replyTo === undefined
            ? {}
            : { message_reference: { message_id: input.destination.replyTo, fail_if_not_exists: false } }),
          ...(components.length === 0 ? {} : { components }),
          ...(input.file === undefined ? {} : { attachments: [{ id: 0, filename: input.file.filename }] }),
        },
        ...(form === undefined ? {} : { form }),
      });
      receipt =
        sent.ok && typeof sent.body?.id === "string"
          ? { index: 0, status: "accepted", providerMessageId: sent.body.id }
          : refusedReceipt(0, sent, "channelId" in input.destination);
    }
  } catch (error) {
    // The client's own refusal (its breaker, no token) sent nothing; a transport failure or a timeout may have.
    receipt =
      error instanceof TaviError
        ? { index: 0, status: "rejected", error: error.message }
        : { index: 0, status: "uncertain", error: redactedError(error, [token]) };
  }
  const { retryAfterMs, ...part } = receipt;
  return {
    status: part.status,
    // A throttled send is retried by the host after the wait Discord named; an uncertain one is never resent blind.
    retryable: retry || retryAfterMs !== undefined,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    parts: [part],
  };
}

/** A file's name as Discord shows it: its own, without a path, a control character or a name too long. */
export function fileNameOf(given: string | undefined, artifactId: string, contentType: string): string {
  const base =
    (given ?? "")
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() ?? "";
  if (base !== "" && base !== "." && base !== "..") return base.slice(0, 120);
  const extension =
    contentType === "application/pdf"
      ? ".pdf"
      : contentType.startsWith("image/")
        ? `.${contentType.slice(6).replace(/[^a-z0-9]/gi, "") || "img"}`
        : contentType === "text/plain"
          ? ".txt"
          : "";
  return `${artifactId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "file"}${extension}`;
}

/** Edits a sent message's text and buttons (none: they are removed). */
export async function editText(
  rest: DiscordRest,
  directs: DirectChannels,
  input: {
    readonly destination: DiscordDestination;
    readonly messageId: string;
    readonly text: string;
    readonly buttons?: readonly (readonly OutboundButton[])[] | undefined;
  },
): Promise<DiscordReply> {
  const channel = await directs.channelOf(input.destination);
  if ("refused" in channel) return channel.refused;
  return rest.request("PATCH", `/channels/${channel.channelId}/messages/${input.messageId}`, {
    body: {
      content: editableText(input.text),
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: NO_PINGS,
      components: componentsOf(input.buttons),
    },
  });
}
