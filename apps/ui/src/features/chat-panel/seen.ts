/**
 * The instructions' revision the reader last looked at, per chat, in this
 * browser: a revision past it — saved in
 * another tab, from the terminal or by someone else — is "changed since you
 * last looked". Optional storage: without it, nothing is ever marked changed.
 */
import { readStoredJson, writeStoredJson } from "../../lib/storage.js";

export const CHAT_SEEN_KEY = "tavi.chatpanel.seen";

/** The most chats remembered; the oldest looked-at are forgotten first. */
const SEEN_MAX = 200;

type Seen = Readonly<Record<string, number>>;

function read(storage?: Pick<Storage, "getItem">): Seen {
  const parsed = readStoredJson(CHAT_SEEN_KEY, storage);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) >= 0),
  );
}

/** The revision the reader last looked at for `taskId`; undefined when never. */
export function seenRevision(taskId: string, storage?: Pick<Storage, "getItem">): number | undefined {
  return read(storage)[taskId];
}

/** Note that the reader has looked at `revision` of the chat's instructions. */
export function markSeen(taskId: string, revision: number, storage?: Pick<Storage, "getItem" | "setItem">): void {
  const { [taskId]: _old, ...rest } = read(storage);
  // Re-inserted last, so the oldest looked-at chats are the first entries dropped.
  const next = Object.entries({ ...rest, [taskId]: revision }).slice(-SEEN_MAX);
  writeStoredJson(CHAT_SEEN_KEY, Object.fromEntries(next), storage);
}
