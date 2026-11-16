import { TaviError } from "@tavi/contracts";
import type { InboundMediaHandle, MediaResponse } from "@tavi/contracts";

import type { DiscordRest } from "./rest.js";

/**
 * Attachments in: a
 * message's files are downloaded from Discord's CDN alone, through a link
 * Discord signs and lets expire, which is read again from the message once
 * when it has. The bot's token never goes to the CDN, and a file over the cap
 * is refused before anything is read. The host takes them in only for a
 * sender it allows.
 */

/** Where Discord serves attachments from (the descriptor's hosts). */
const CDN_HOSTS: ReadonlySet<string> = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Links remembered from messages, the oldest evicted first: one forgotten is read again from its message. */
const LINKS_MAX = 500;
const SNOWFLAKE = /^[1-9]\d{16,19}$/;

/** A link Discord signed, for its CDN only; anything else is refused. */
function cdnUrl(link: string): URL {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new TaviError("INVALID_INPUT", "a Discord attachment's link is not a URL");
  }
  if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname))
    throw new TaviError("INVALID_INPUT", `a Discord attachment is served from ${[...CDN_HOSTS].join(" or ")} over https, not ${url.host}`);
  return url;
}

/** Whether a signed link's expiry (`ex`, hex seconds) has passed. A link without one is taken as live. */
function expired(url: URL, nowMs: number): boolean {
  const ex = url.searchParams.get("ex");
  if (ex === null || !/^[0-9a-f]{1,12}$/i.test(ex)) return false;
  return Number.parseInt(ex, 16) * 1000 <= nowMs;
}

export interface MediaDependencies {
  readonly rest: DiscordRest;
  readonly fetch: (url: string, init: { readonly signal: AbortSignal; readonly redirect: "error" }) => Promise<MediaResponse>;
  readonly now: () => number;
}

/** The connector's attachments: the links its messages carried, and the download of one. */
export class DiscordMedia {
  readonly #deps: MediaDependencies;
  readonly #links = new Map<string, string>();

  constructor(deps: MediaDependencies) {
    this.#deps = deps;
  }

  /** Keeps a message's link for its handle. */
  remember(ref: string, link: string): void {
    this.#links.delete(ref);
    if (this.#links.size >= LINKS_MAX) {
      const oldest = this.#links.keys().next().value;
      if (oldest !== undefined) this.#links.delete(oldest);
    }
    this.#links.set(ref, link);
  }

  /** Downloads one attachment, the host reading the body up to `maxBytes`; an expired or refused link is read again once. */
  async fetch(handle: InboundMediaHandle, options: { readonly maxBytes: number; readonly signal: AbortSignal }): Promise<MediaResponse> {
    if (handle.sizeBytes !== undefined && handle.sizeBytes > options.maxBytes)
      throw new TaviError(
        "INVALID_INPUT",
        `the attachment is ${String(handle.sizeBytes)} bytes, over the ${String(options.maxBytes)} this channel takes`,
      );
    const [channelId, messageId, attachmentId, ...rest] = handle.ref.split("/");
    if (
      channelId === undefined ||
      messageId === undefined ||
      attachmentId === undefined ||
      rest.length > 0 ||
      ![channelId, messageId, attachmentId].every((id) => SNOWFLAKE.test(id))
    ) {
      throw new TaviError("INVALID_INPUT", "that is not a Discord attachment's handle");
    }
    const known = this.#links.get(handle.ref);
    // Read again from its message at most once: now, for a link not known or expired, or after a refusal.
    const stale = known === undefined || expired(cdnUrl(known), this.#deps.now());
    let url = stale ? await this.#refreshed(handle.ref, channelId, messageId, attachmentId, options.signal) : cdnUrl(known);
    let response = await this.#deps.fetch(url.href, { signal: options.signal, redirect: "error" });
    // A link that lapsed meanwhile: Discord answers it 403 or 404.
    if ((response.status === 403 || response.status === 404) && !stale) {
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      await response.body?.cancel().catch(() => undefined);
      url = await this.#refreshed(handle.ref, channelId, messageId, attachmentId, options.signal);
      response = await this.#deps.fetch(url.href, { signal: options.signal, redirect: "error" });
    }
    if (!response.ok) {
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      await response.body?.cancel().catch(() => undefined);
      throw new TaviError("UNAVAILABLE", `Discord's CDN answered ${String(response.status)} for the attachment`);
    }
    return response;
  }

  /** The attachment's link as its message has it now. */
  async #refreshed(ref: string, channelId: string, messageId: string, attachmentId: string, signal: AbortSignal): Promise<URL> {
    const message = await this.#deps.rest.request<{ readonly attachments?: unknown }>(
      "GET",
      `/channels/${channelId}/messages/${messageId}`,
      { signal },
    );
    if (!message.ok)
      throw new TaviError("UNAVAILABLE", `Discord would not read the attachment's message again (${String(message.status)})`);
    const attachments = Array.isArray(message.body?.attachments)
      ? (message.body.attachments as readonly { readonly id?: unknown; readonly url?: unknown }[])
      : [];
    const link = attachments.find((attachment) => attachment.id === attachmentId)?.url;
    if (typeof link !== "string") throw new TaviError("NOT_FOUND", "the attachment is no longer on its message");
    const url = cdnUrl(link);
    this.remember(ref, url.href);
    return url;
  }
}
