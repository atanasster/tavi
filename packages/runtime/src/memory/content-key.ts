import { normaliseMemoryText, type MemoryKind } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

/** The prefix of the topic key *Replace* assigns an untagged fact it updates. */
const AUTO_TOPIC_KEY_PREFIX = "auto.";

/**
 * A record's content key: the
 * SHA-256 hex of its normalised content — kind, scope key, preference or
 * topic key, the case- and space-folded body, and a preference's value — so
 * the same proposal filed twice is found by an index, never by its text.
 * A record with no body (an artifact reference only) has no key. A fact's
 * automatic topic key (`auto.`, assigned by *Replace*) is no part of it: the
 * same words said again without one are the same fact.
 *
 * Computed here, not in SQL, because SQLite's `lower` folds ASCII only. The
 * store's start-up backfill and the service share this one function, so a key
 * written by either matches the other's.
 */
export function memoryContentKey(input: {
  readonly kind: MemoryKind;
  readonly scopeKey: string;
  readonly preferenceKey?: string | undefined;
  readonly topicKey?: string | undefined;
  readonly body?: string | undefined;
  /** A preference's value: the same words with another value are another proposal. */
  readonly preferenceValue?: unknown;
}): string | undefined {
  if (input.body === undefined) return undefined;
  const value =
    input.preferenceValue === undefined
      ? ""
      : normaliseMemoryText(typeof input.preferenceValue === "string" ? input.preferenceValue : JSON.stringify(input.preferenceValue));
  const topicKey = input.kind === "fact" && input.topicKey?.startsWith(AUTO_TOPIC_KEY_PREFIX) === true ? "" : (input.topicKey ?? "");
  const tuple = [input.kind, input.scopeKey, input.preferenceKey ?? "", topicKey, normaliseMemoryText(input.body), value];
  return sha256Hex(JSON.stringify(tuple));
}
