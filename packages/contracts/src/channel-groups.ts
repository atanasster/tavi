import { z } from "zod";

/**
 * The group-chat seam: what a
 * channel that serves group chats reports and implements, so the host's room
 * policy, private approvals, group tools and data lifecycle are the same for
 * every such channel and name none. A connector reports
 * structure — how a message addressed the agent, who wrote it, what it quotes —
 * and the host decides everything that depends on who a sender is to Tavi.
 */

/**
 * How a message addressed the agent, as the platform says: it names
 * the agent (`mention`), replies to one of its messages (`reply`), is in a
 * thread the agent started for a task (`thread`), is a platform command
 * (`command`), or is another message the person chose for the agent
 * (`picked`: a context menu).
 */
export const ADDRESS_KINDS = ["mention", "reply", "thread", "command", "picked"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

/** A room's trigger: the address kinds that take a message in. */
export const RoomTriggerSchema = z.array(z.enum(ADDRESS_KINDS)).min(1).max(ADDRESS_KINDS.length);
export type RoomTrigger = z.infer<typeof RoomTriggerSchema>;

/** Who wrote a message, as the platform says. The host drops `bot` and `system` before anything is recorded. */
export const AUTHOR_KINDS = ["person", "bot", "system"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const PollCapabilitiesSchema = z.strictObject({
  maxQuestion: z.number().int().min(1).max(1000),
  maxAnswers: z.number().int().min(2).max(25),
  maxAnswerLength: z.number().int().min(1).max(200),
  maxHours: z.number().int().min(1).max(2000),
  multiSelect: z.boolean(),
  /** `fetch`: `readPoll` answers any time; `final`: results only once the poll ended. */
  results: z.enum(["fetch", "final"]),
});
export type PollCapabilities = z.infer<typeof PollCapabilitiesSchema>;

export const EventCapabilitiesSchema = z.strictObject({
  /** A place or a link; voice and stage events are non-goals. */
  kinds: z
    .array(z.enum(["external"]))
    .min(1)
    .max(1),
  maxTitle: z.number().int().min(1).max(200),
  maxDescription: z.number().int().min(0).max(4000),
});
export type EventCapabilities = z.infer<typeof EventCapabilitiesSchema>;

/** What a group channel can do (`MessagingCapabilities.groups`); each method on the instance exists only with its capability. */
export const GroupCapabilitiesSchema = z.strictObject({
  /** The address kinds this connector reports; a room's trigger may only use these. */
  addressing: z.array(z.enum(ADDRESS_KINDS)).min(1).max(ADDRESS_KINDS.length),
  /** `definition.directDestinationOf` reaches a sender one-to-one. */
  directToSender: z.boolean(),
  /** `instance.listRooms` exists. */
  listRooms: z.boolean(),
  /** The platform reports the agent being added to or removed from a room (`kind: "membership"`). */
  membershipEvents: z.boolean(),
  /** `instance.leaveRoom` exists. */
  leaveRoom: z.boolean(),
  /** `definition.autoThreadOf` exists: a room can answer in a thread opened from each message (`autoThread`). */
  autoThread: z.boolean().optional(),
  recentHistory: z.strictObject({ maxMessages: z.number().int().min(1).max(50) }).optional(),
  polls: PollCapabilitiesSchema.optional(),
  events: EventCapabilitiesSchema.optional(),
});
export type GroupCapabilities = z.infer<typeof GroupCapabilitiesSchema>;

/**
 * A channel's group policy, as its descriptor declares it: whether an
 * unbound sender's group message is held (Telegram today) or dropped before it
 * is stored, whether a message from a room nobody listed is admitted as today
 * or dropped, and the trigger a new room starts with.
 */
export const ChannelGroupPolicySchema = z.strictObject({
  unboundSenders: z.enum(["hold", "drop"]),
  unlistedRooms: z.enum(["admit", "drop"]),
  defaultTrigger: z.array(z.enum(ADDRESS_KINDS)).min(1).max(ADDRESS_KINDS.length),
});
export type ChannelGroupPolicy = z.infer<typeof ChannelGroupPolicySchema>;

/** What removing a connection does to what it brought in. Absent from a descriptor: `keep`. */
export const CHANNEL_RETENTIONS = ["keep", "purge-on-remove"] as const;
export type ChannelRetention = (typeof CHANNEL_RETENTIONS)[number];

/** A host a channel reaches: `host` or `*.domain`, lower case. */
export const ChannelHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a host or *.domain, in lower case");

/** One room a connector can list for the operator's picker. Its names are the platform's, display only and untrusted. */
export interface ChannelRoomListing {
  readonly id: string;
  readonly name: string;
  /** Where it is (a server's name), display only. */
  readonly place?: string;
}

/** One message of a room's recent history (`fetchRecent`), as the platform says; the host labels it. */
export interface RecentRoomMessage {
  readonly externalSenderId: string;
  readonly externalMessageId: string;
  readonly authorKind: AuthorKind;
  readonly content?: string;
  readonly at: string;
}

/** A poll as `readPoll` answers it; voters are sender ids, at most 100 per answer, which the host maps to people. */
export interface ChannelPollState {
  readonly finalized: boolean;
  readonly expiresAt?: string;
  readonly answers: readonly { readonly text: string; readonly count: number; readonly voters: readonly string[] }[];
}

export interface ChannelPollInput {
  readonly effectId: string;
  readonly destination: unknown;
  readonly question: string;
  readonly answers: readonly string[];
  readonly hours: number;
  readonly multiSelect: boolean;
}

export interface ChannelEventInput {
  readonly effectId: string;
  readonly destination: unknown;
  readonly title: string;
  readonly description?: string;
  readonly start: string;
  readonly end: string;
  readonly location: string;
}

/**
 * What the host gives every channel connector, builtin or a plugin's
 * (`ctx.channelHost`, ABI 2): the clock, the `fetch` it calls its
 * provider with, and an approved artifact of the sending workspace at most
 * `maxBytes` long — what a file part sends. `Fetch` is the runtime's `fetch`,
 * which this package does not type.
 */
export interface ChannelHostServices<Fetch = unknown> {
  readonly now: () => string;
  readonly fetch: Fetch;
  readonly readArtifact: (
    artifactId: string,
    workspaceId: string,
    maxBytes: number,
  ) => Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;
}

/**
 * Why the host's room policy dropped an inbound event before anything of it
 * was stored: its author is a bot or the platform, its room is not
 * listed or is paused, it did not address the agent as the room's trigger
 * asks, its sender is unknown, the room hears only the operator, or the room or
 * sender is flooding. `membership` is a report that the agent was added to or
 * removed from a room, which is never stored either.
 */
export const ROOM_DROP_REASONS = [
  "bot",
  "system",
  "unlisted-room",
  "room-disabled",
  "not-addressed",
  "unbound",
  "not-operator",
  "flood",
  "membership",
] as const;
export type RoomDropReason = (typeof ROOM_DROP_REASONS)[number];

/** What each address kind is, in a room's introduction's words. */
const TRIGGER_WORDS: Readonly<Record<AddressKind, string>> = {
  mention: "mention me",
  reply: "reply to one of my messages",
  thread: "write in a thread I started",
  command: "use one of my commands",
  picked: "pick a message for me",
};

/** A trigger in words: "mention me or reply to one of my messages". */
export function triggerInWords(trigger: RoomTrigger): string {
  const words = trigger.map((kind) => TRIGGER_WORDS[kind]);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1] ?? ""}`;
}

/** Whether a trigger takes in a message addressed in these ways: the kinds must meet. */
export function triggerAdmits(trigger: RoomTrigger, addressed: readonly AddressKind[] | undefined): boolean {
  return (addressed ?? []).some((kind) => trigger.includes(kind));
}
