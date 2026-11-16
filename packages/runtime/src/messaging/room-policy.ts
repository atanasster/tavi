import {
  ROOM_DROP_REASONS,
  triggerAdmits,
  type ChannelGroupPolicy,
  type InboundEvent,
  type PersistencePort,
  type RoomDropReason,
} from "@tavi/contracts";

/**
 * The host's room policy: whether a group channel's inbound event is taken in at all, decided
 * before its media is fetched or anything of it is recorded. A connector only
 * reports structure — how a message addressed the agent, who wrote it — and
 * this decides everything that depends on who the sender is to Tavi, so every
 * group channel gets the same rules and none can get them wrong.
 *
 * In order, for a channel whose descriptor declares `groups`:
 * 1. a bot's or the platform's message is dropped, and a membership report is
 *    never stored (the host is told of it);
 * 2. a message from a room nobody listed is dropped on an `unlistedRooms:
 *    "drop"` channel (the host is told, once a day per room), and admitted as
 *    before the seam on an `admit` one, which skips the rest;
 * 3. a paused room's message is dropped, and so is one that does not address
 *    the agent as the room's trigger asks;
 * 4. an unbound sender is dropped on an `unboundSenders: "drop"` channel (held
 *    otherwise, as before), and an `operator-only` room hears its operator alone;
 * 5. an event already recorded (a redelivery) is decided by 1–4 alone: a
 *    replay must never be dropped as a flood once its first delivery was kept;
 * 6. flood buckets, per room and per sender, drop the excess (the host is told
 *    on the first drop of a window, at most once an hour per room).
 *
 * A press goes through 1 only: it resolves its round by token, and the round's
 * own check decides who may decide it. A one-to-one chat goes through 6 only,
 * for a sender nobody bound yet, which bounds pairing spam.
 */

export interface FloodLimits {
  /** Messages a room may bring in a minute, and an hour. */
  readonly roomPerMinute: number;
  readonly roomPerHour: number;
  /** Messages one sender may bring in a minute, in a room or as an unknown one-to-one sender. */
  readonly senderPerMinute: number;
}

export const DEFAULT_FLOOD_LIMITS: FloodLimits = { roomPerMinute: 6, roomPerHour: 20, senderPerMinute: 3 };

/** The most keys each bounded map keeps; the oldest goes first. */
const MAX_KEYS = 2000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Something the host is told about, beside the drop itself. */
export type RoomNotice = "membership" | "unlisted" | "flood";

export type RoomVerdict =
  /** `autoThread`: a message in a room that answers in threads, not yet in one: the host opens its thread. */
  | { readonly admit: true; readonly autoThread?: true }
  | { readonly admit: false; readonly reason: RoomDropReason; readonly notice?: RoomNotice };

export interface RoomPolicyDependencies {
  readonly repositories: {
    readonly channelRooms: Pick<PersistencePort["repositories"]["channelRooms"], "get">;
    readonly messagingIdentityBindings: Pick<PersistencePort["repositories"]["messagingIdentityBindings"], "get">;
    readonly messagingInbox: Pick<PersistencePort["repositories"]["messagingInbox"], "get">;
  };
  /** The channel's group policy, from its descriptor; undefined for a channel without the seam. */
  readonly groupPolicyOf: (connectionId: string) => ChannelGroupPolicy | undefined;
  /** The workspace's operator, for an `operator-only` room. */
  readonly operatorOf?: (workspaceId: string) => string | undefined;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly limits?: FloodLimits;
}

export interface RoomPolicy {
  decide(event: InboundEvent): Promise<RoomVerdict>;
  /** How many events this run dropped on a connection, by reason. */
  drops(connectionId: string): Readonly<Partial<Record<RoomDropReason, number>>>;
}

/** A map that keeps its newest `MAX_KEYS` entries, by last use. */
class Bounded<V> {
  readonly #entries = new Map<string, V>();

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > MAX_KEYS) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }
}

export function createRoomPolicy(deps: RoomPolicyDependencies): RoomPolicy {
  const limits = deps.limits ?? DEFAULT_FLOOD_LIMITS;
  const { channelRooms, messagingIdentityBindings, messagingInbox } = deps.repositories;
  /** When each key's admitted messages came, newest last, within the longest window that key needs. */
  const arrivals = new Bounded<number[]>();
  /** When the host was last told of something, per room and notice. */
  const told = new Bounded<number>();
  const dropped = new Map<string, Partial<Record<RoomDropReason, number>>>();

  const drop = (event: InboundEvent, reason: RoomDropReason, notice?: RoomNotice): RoomVerdict => {
    const counts = dropped.get(event.connectionId) ?? {};
    counts[reason] = (counts[reason] ?? 0) + 1;
    dropped.set(event.connectionId, counts);
    return notice === undefined ? { admit: false, reason } : { admit: false, reason, notice };
  };

  /** Whether the host should be told now: at most once per `everyMs` for this key. */
  const tellOnce = (key: string, everyMs: number): boolean => {
    const at = deps.now();
    const last = told.get(key);
    if (last !== undefined && at - last < everyMs) return false;
    told.set(key, at);
    return true;
  };

  const recent = (key: string, windowMs: number): number[] => {
    const at = deps.now();
    return (arrivals.get(key) ?? []).filter((time) => at - time < windowMs);
  };

  /** Whether each key has room for one more message within its limits; when every key has, the message counts against them. */
  const within = (buckets: readonly { readonly key: string; readonly perMinute: number; readonly perHour?: number }[]): boolean => {
    const windows = buckets.map((bucket) => ({ bucket, times: recent(bucket.key, bucket.perHour === undefined ? MINUTE_MS : HOUR_MS) }));
    const at = deps.now();
    const full = windows.some(
      ({ bucket, times }) =>
        times.filter((time) => at - time < MINUTE_MS).length >= bucket.perMinute ||
        (bucket.perHour !== undefined && times.length >= bucket.perHour),
    );
    if (full) return false;
    for (const { bucket, times } of windows) arrivals.set(bucket.key, [...times, at]);
    return true;
  };

  async function decide(event: InboundEvent): Promise<RoomVerdict> {
    const policy = deps.groupPolicyOf(event.connectionId);
    if (policy === undefined) return { admit: true };
    if (event.kind === "membership") {
      // Added to a room already listed is nothing to ask about; a removal always is (it settles a waiting room).
      const listed =
        event.membership?.change === "added" && (await channelRooms.get(event.connectionId, event.externalConversationId)) !== undefined;
      return drop(event, "membership", listed ? undefined : "membership");
    }
    if (event.authorKind === "bot") return drop(event, "bot");
    if (event.authorKind === "system") return drop(event, "system");
    if (event.kind !== "message") return { admit: true };
    const sender = `${event.connectionId}\u0000${event.externalSenderId}`;
    if (event.conversationKind !== "group" && event.conversationKind !== "thread") {
      // A one-to-one chat: only an unknown sender is bounded, which keeps pairing spam in check.
      if (event.conversationKind !== "direct") return { admit: true };
      if ((await messagingIdentityBindings.get(event.connectionId, event.externalSenderId)) !== undefined) return { admit: true };
      if ((await messagingInbox.get(event.connectionId, event.providerEventId)) !== undefined) return { admit: true };
      return within([{ key: sender, perMinute: limits.senderPerMinute }]) ? { admit: true } : drop(event, "flood");
    }
    const roomKey = `${event.connectionId}\u0000${event.externalConversationId}`;
    const room = await channelRooms.get(event.connectionId, event.externalConversationId);
    if (room === undefined) {
      if (policy.unlistedRooms === "admit") return { admit: true };
      return drop(event, "unlisted-room", tellOnce(`unlisted\u0000${roomKey}`, DAY_MS) ? "unlisted" : undefined);
    }
    if (room.disabledAt !== undefined) return drop(event, "room-disabled");
    if (!triggerAdmits(room.trigger, event.addressed)) return drop(event, "not-addressed");
    const binding = await messagingIdentityBindings.get(event.connectionId, event.externalSenderId);
    if (room.members === "operator-only") {
      if (binding === undefined || binding.principalId !== deps.operatorOf?.(room.workspaceId)) return drop(event, "not-operator");
    } else if (binding === undefined && policy.unboundSenders === "drop") {
      return drop(event, "unbound");
    }
    const admitted: RoomVerdict =
      room.autoThread === true && event.conversationKind === "group" && event.externalThreadId === undefined
        ? { admit: true, autoThread: true }
        : { admit: true };
    if ((await messagingInbox.get(event.connectionId, event.providerEventId)) !== undefined) return admitted;
    if (
      within([
        { key: roomKey, perMinute: limits.roomPerMinute, perHour: limits.roomPerHour },
        { key: sender, perMinute: limits.senderPerMinute },
      ])
    )
      return admitted;
    return drop(event, "flood", tellOnce(`flood\u0000${roomKey}`, HOUR_MS) ? "flood" : undefined);
  }

  return {
    decide,
    drops: (connectionId) => {
      const counts = dropped.get(connectionId) ?? {};
      return Object.fromEntries(
        ROOM_DROP_REASONS.filter((reason) => counts[reason] !== undefined).map((reason) => [reason, counts[reason]]),
      );
    },
  };
}
