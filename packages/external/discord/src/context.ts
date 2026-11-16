import { TaviError } from "@tavi/contracts";
import type { RecentRoomMessage } from "@tavi/contracts";

import { authorKindOf, timeOf, type DiscordSchemas } from "./inbound.js";
import type { DiscordRest } from "./rest.js";

/**
 * A room's recent messages: what a triggered turn in a room whose context is `recent` reads
 * beside its message. Discord gives another person's words only to an
 * application whose Message Content intent is on; without it, reading a room
 * is refused, and the room stays trigger-only. Each message says who wrote
 * it; the host decides whose words it may read.
 */

/** Message Content, in full or limited form, among an application's flags. */
export const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
/** The most Tavi reads of a room at once, within Discord's 100. */
const RECENT_MAX = 20;

/** Reads the channel's messages before `before`, oldest first, at most `limit`; a message that does not parse is left out. */
export async function fetchRecent(
  rest: DiscordRest,
  schemas: DiscordSchemas,
  channelId: string,
  options: { readonly limit: number; readonly before?: string | undefined; readonly signal: AbortSignal },
): Promise<readonly RecentRoomMessage[]> {
  const limit = Math.max(1, Math.min(options.limit, RECENT_MAX));
  const before = options.before !== undefined && /^\d{16,20}$/.test(options.before) ? `&before=${options.before}` : "";
  const answer = await rest.request<readonly unknown[]>("GET", `/channels/${channelId}/messages?limit=${String(limit)}${before}`, {
    signal: options.signal,
  });
  if (!answer.ok) {
    // 50001 / 50013: the bot may not read this channel's history.
    if (answer.code === 50001 || answer.code === 50013)
      throw new TaviError("UNAVAILABLE", "the bot lacks Read Message History in this room");
    throw new TaviError("UNAVAILABLE", `Discord would not read the room (${String(answer.status)})`);
  }
  const messages = (Array.isArray(answer.body) ? answer.body : []).flatMap((candidate) => {
    const parsed = schemas.message.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  // Discord answers newest first; the host reads them as they were said.
  return messages
    .reverse()
    .slice(-limit)
    .map((message) => ({
      externalSenderId: message.author.id,
      externalMessageId: message.id,
      authorKind: authorKindOf(message),
      ...(message.content === "" ? {} : { content: message.content }),
      at: timeOf(message.timestamp, new Date(0).toISOString()),
    }));
}
