import { TaviError, isLocalConnectionId } from "@tavi/contracts";

/**
 * The `--messaging-allow-destination` grammar, in one place.
 *
 * A destination entry is either:
 *
 * - `chatId` — the conversation on *any* connection,
 * - `connectionId:chatId` — that conversation on exactly one connection,
 * - `*:chatId` — that conversation on any connection, said explicitly, so it
 *   holds however many connections are open, and
 * - `providerId:*` — any conversation on that channel's connections: the one
 *   wildcard, for an operator who means it (a support inbox anyone may be
 *   written to from), named per channel so it never reaches another's.
 *
 * The bare form is the pre-existing spelling and the only one every deployed
 * configuration uses. It is also a hazard: an id allowlisted for one
 * provider was addressable through any *other* connection the runtime had
 * open, so a Telegram chat id could be reached over Mailgun and a Mailgun
 * recipient over Telegram. Qualifying an entry closes that — and because a
 * bare entry is only ambiguous when more than one connection can carry the
 * send, it keeps working while exactly one connection is configured
 * (`destinationAllowed`'s `knownConnectionIds` argument).
 *
 * Deliberately not `hostAllowed`/`normalizeHostEntry` from the HTTP tool:
 * those normalize DNS names and support `*.suffix` wildcards, and neither
 * concept transfers to a chat id or a mailbox address — a wildcard there would
 * mean "any conversation on the account". A destination is named exactly or
 * not at all. `String(...)` because the schema accepts a numeric Telegram chat
 * id and an operator naturally writes one.
 *
 * This lives in its own module because it has two callers — `messaging.send_to`
 * (`features/channels/tools.ts`) and `operator.ask_user`'s no-inbound-conversation
 * branch (`runtime/asking.ts`) — and both address a *model-authored* destination.
 * Two copies of a security predicate is how the two paths drift apart: the
 * earlier `ask_user` implementation knew only the bare form, so an operator who
 * qualified their entries (exactly what the flag's help recommends) had that
 * destination refused by `ask_user`.
 */

export interface DestinationEntry {
  /** Absent for the bare `chatId` form — the conversation on any connection. */
  readonly connectionId?: string;
  readonly chatId: string;
}

/**
 * Split one operator-authored entry, or `undefined` when it is not a
 * destination at all (an empty half, or whitespace around the colon).
 *
 * The **first** colon separates. That is only correct because a connection id
 * is assumed to contain none: the runtime builds its ids as
 * `telegram-${workspaceId}` / `mailgun-${workspaceId}` and a workspace id may
 * contain a colon, so this assumption is documented rather than enforced — and
 * `assertDestinationEntries` refuses an entry whose prefix is not a
 * configured connection id, which turns the one reachable ambiguity into a
 * startup error instead of a destination that can never be allowlisted.
 * A chat id *may* contain a colon (a Mailgun `sender` is used verbatim as a
 * destination, `packages/builtin/mailgun/src/connector.ts`), so everything
 * after the first colon is the chat id — never `lastIndexOf`.
 */
export function parseDestinationEntry(entry: string): DestinationEntry | undefined {
  const separator = entry.indexOf(":");
  if (separator === -1) return entry.trim() === "" || entry !== entry.trim() ? undefined : { chatId: entry };
  const connectionId = entry.slice(0, separator);
  const chatId = entry.slice(separator + 1);
  if (connectionId === "" || chatId === "") return undefined;
  if (connectionId !== connectionId.trim() || chatId !== chatId.trim()) return undefined;
  return { connectionId, chatId };
}

/** The `*` in `*:chatId` and `providerId:*`. */
export const ANY_DESTINATION = "*";

/**
 * What the two wildcard-bearing forms need to know of a connection: its
 * channel, for `providerId:*`, and a target in that channel's own form, for
 * `*:chatId` — which names a target on every channel, so it is matched in each
 * one's form, and on a channel it is no target of, not at all.
 */
export interface DestinationChannels {
  readonly providerOf: (connectionId: string) => string | undefined;
  /** The target in the connection's channel's form, or `undefined` when it is none there. */
  readonly targetOf: (connectionId: string, to: string) => string | undefined;
}

/**
 * Validate the operator's allowlist once, at composition, and return it.
 *
 * `--http-allow-host` is checked the same way and for the same reason
 * (`assertHostEntries`): an entry the matcher can never accept would otherwise
 * fail *closed and silently* — every destination refused, with nothing saying
 * why, and the operator reading the refusal as a policy decision.
 *
 * A colon-bearing entry that names no configured connection is refused rather
 * than reinterpreted: it may well be a legacy literal destination (a Mailgun
 * `to:` of `Ops: Alerts <alerts@example.com>` is a valid address *and* a valid
 * entry under the old bare-only grammar), and silently turning it into
 * "connection `Ops`, chat `Alerts <alerts@example.com>`" would both break a
 * working destination and widen what the entry authorizes.
 */
export function assertDestinationEntries(
  entries: readonly string[],
  knownConnectionIds: readonly string[],
  flag: string,
  knownProviderIds: readonly string[] = [],
): readonly string[] {
  for (const entry of entries) {
    const parsed = parseDestinationEntry(entry);
    if (parsed === undefined) {
      throw new TaviError(
        "INVALID_INPUT",
        `${flag} entry ${JSON.stringify(entry)} is malformed: write \`chatId\`, or \`connectionId:chatId\` with a ` +
          "non-empty connection id and chat id and no surrounding whitespace",
      );
    }
    if (parsed.chatId === ANY_DESTINATION) {
      if (parsed.connectionId !== undefined && knownProviderIds.includes(parsed.connectionId)) continue;
      throw new TaviError(
        "INVALID_INPUT",
        `${flag} entry ${JSON.stringify(entry)} is a wildcard: \`*\` names every conversation only as \`providerId:*\`, for an installed channel (${knownProviderIds.length === 0 ? "none is installed" : knownProviderIds.join(", ")})`,
      );
    }
    if (parsed.connectionId === ANY_DESTINATION) continue;
    if (parsed.connectionId !== undefined && !knownConnectionIds.includes(parsed.connectionId)) {
      throw new TaviError(
        "INVALID_INPUT",
        `${flag} entry ${JSON.stringify(entry)} names connection ${JSON.stringify(parsed.connectionId)}, which is not ` +
          `configured (${knownConnectionIds.length === 0 ? "no messaging connection is configured" : `configured: ${knownConnectionIds.join(", ")}`}). ` +
          "If the colon is part of the destination itself, it cannot be allowlisted on a connection that is configured " +
          "— remove the entry, or configure the connection it names.",
      );
    }
  }
  return entries;
}

/**
 * Exact-match destination check, optionally bound to one connection.
 *
 * `knownConnectionIds` is the set of connections this runtime can send
 * through. A bare entry authorizes its conversation on *any* connection, which
 * is unambiguous only while at most one connection exists; with two or more
 * configured, a bare entry would again make a Telegram chat id reachable
 * over Mailgun, so it stops matching and the refusal explains
 * how to qualify it.
 */
export function destinationAllowed(
  connectionId: string,
  chatId: string | number,
  allowedDestinations: readonly string[],
  knownConnectionIds: readonly string[],
  /** Absent: no `providerId:*` entry matches, and a `*:chatId` one is compared as written. */
  channels?: DestinationChannels,
): boolean {
  // Never the local connection, whatever the entry: it is reachable only by replying into one of its own
  // conversations. A bare entry names no connection, so without this a model
  // could route an allowlisted chat id through it.
  if (isLocalConnectionId(connectionId)) return false;
  const wanted = String(chatId);
  const bareIsUnambiguous = knownConnectionIds.length <= 1;
  return allowedDestinations.some((entry) => {
    const parsed = parseDestinationEntry(entry);
    if (parsed === undefined) return false;
    if (parsed.connectionId === undefined) return bareIsUnambiguous && parsed.chatId === wanted;
    if (parsed.chatId === ANY_DESTINATION) return channels !== undefined && parsed.connectionId === channels.providerOf(connectionId);
    if (parsed.connectionId === ANY_DESTINATION) return anywhereTarget(connectionId, parsed.chatId, channels) === wanted;
    return parsed.connectionId === connectionId && parsed.chatId === wanted;
  });
}

/**
 * The targets `destinationAllowed` accepts on one connection, as the agent is
 * told of them: each exact one, or just `*` when its channel's wildcard is
 * allowed. Never another connection's.
 */
export function allowedTargetsOf(
  connectionId: string,
  allowedDestinations: readonly string[],
  knownConnectionIds: readonly string[],
  channels: DestinationChannels,
): readonly string[] {
  if (isLocalConnectionId(connectionId)) return [];
  const targets = new Set<string>();
  for (const entry of allowedDestinations) {
    const parsed = parseDestinationEntry(entry);
    if (parsed === undefined) continue;
    if (parsed.chatId === ANY_DESTINATION) {
      if (parsed.connectionId === channels.providerOf(connectionId)) return [ANY_DESTINATION];
      continue;
    }
    const target = parsed.connectionId === ANY_DESTINATION ? anywhereTarget(connectionId, parsed.chatId, channels) : parsed.chatId;
    if (target !== undefined && destinationAllowed(connectionId, target, [entry], knownConnectionIds, channels)) targets.add(target);
  }
  return [...targets];
}

/** A `*:chatId` entry's target on one connection: in its channel's form, or `undefined` where it is none. */
function anywhereTarget(connectionId: string, chatId: string, channels: DestinationChannels | undefined): string | undefined {
  return channels === undefined ? chatId : channels.targetOf(connectionId, chatId);
}

/** The one refusal wording, so both model-authored destination paths explain the same syntax. */
export function destinationRefusal(connectionId: string, chatId: string | number, knownConnectionIds: readonly string[]): string {
  // No entry can allow it, so none is suggested.
  if (isLocalConnectionId(connectionId)) {
    return `${connectionId} is a local connection, which is no destination: it is reached only by replying into one of its own conversations`;
  }
  const advice =
    knownConnectionIds.length <= 1
      ? "an entry may be `chatId` for any connection, `connectionId:chatId` for exactly one, or `providerId:*` for anyone on a channel"
      : "more than one connection is configured, so the entry must be written `connectionId:chatId` (or `*:chatId` to mean every connection); " +
        "a bare `chatId` would authorize that conversation through every connection";
  return `destination ${String(chatId)} on connection ${connectionId} is not in the operator's allowlist (${advice})`;
}
