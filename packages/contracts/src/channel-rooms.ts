import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { RoomTriggerSchema } from "./channel-groups.js";

/**
 * The host's records for group chats: the rooms an operator listed, where a
 * room's approval
 * round was delivered, and connections waiting to be purged.
 */

/** Who may speak to the agent in a room: any bound member, or the operator alone. */
export const ROOM_MEMBERS = ["bound", "operator-only"] as const;
/** Whether a triggered turn reads the room's recent messages; `off` until the operator opts in. */
export const ROOM_CONTEXTS = ["off", "recent"] as const;
/** The room's introduction: waiting to be sent, sent, or sent with an unknown outcome. */
export const ROOM_INTRO_STATES = ["pending", "sent", "uncertain"] as const;

/** One room an operator listed on a connection: a group conversation the agent listens to. */
export const ChannelRoomRecordSchema = z.strictObject({
  connectionId: z.string().min(1).max(256),
  /** The group's `externalConversationId`. */
  conversationId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(128),
  /** The operator's name for it; a platform's names are untrusted. */
  label: z.string().min(1).max(120),
  trigger: RoomTriggerSchema,
  members: z.enum(ROOM_MEMBERS),
  context: z.enum(ROOM_CONTEXTS),
  introState: z.enum(ROOM_INTRO_STATES),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set while the room is paused: its messages are dropped as an unlisted room's are. */
  disabledAt: z.string().optional(),
  /**
   * The agent answers a message that addresses it in a thread opened from
   * that message, on a channel whose connector can (`autoThreadOf`):
   * the task's chat is the thread. Absent: off.
   */
  autoThread: z.boolean().optional(),
});
export type ChannelRoomRecord = z.infer<typeof ChannelRoomRecordSchema>;

interface ChannelRoomRepositoryPortDefinition {
  get(connectionId: string, conversationId: string): ChannelRoomRecord | undefined;
  /** A connection's rooms, oldest first. */
  listForConnection(connectionId: string): readonly ChannelRoomRecord[];
  /** Adds the room, or replaces what an operator changed in it (its `createdAt` stays). */
  upsert(room: ChannelRoomRecord): void;
  setIntroState(connectionId: string, conversationId: string, state: ChannelRoomRecord["introState"], at: string): boolean;
  remove(connectionId: string, conversationId: string): boolean;
  /** Every room of a connection, for its purge; answers how many went. */
  removeForConnection(connectionId: string): number;
}
export type ChannelRoomRepositoryPort = AsyncRepository<ChannelRoomRepositoryPortDefinition>;

/**
 * Where an approval round was delivered: its card, and, for a room's
 * round, the notice in the room. Each is edited on settlement through its own
 * destination. A round announced before these were recorded has none, and is
 * edited where it was announced.
 */
export const ROUND_DELIVERY_ROLES = ["card", "notice"] as const;
export const ApprovalRoundDeliveryRecordSchema = z.strictObject({
  taskId: z.string().min(1),
  steps: z.number().int().nonnegative(),
  connectionId: z.string().min(1).max(256),
  role: z.enum(ROUND_DELIVERY_ROLES),
  /** The connector's own `OutboundMessage.destination`, as sent. */
  destination: z.unknown(),
  messageIds: z.array(z.string().min(1)).max(16),
  /** What each message is edited back to once the round is decided. */
  text: z.string(),
  createdAt: z.string(),
});
export type ApprovalRoundDeliveryRecord = z.infer<typeof ApprovalRoundDeliveryRecordSchema>;

interface ApprovalRoundDeliveryRepositoryPortDefinition {
  /** Records a delivery; a repeat for the same round, connection and role replaces it. */
  record(delivery: ApprovalRoundDeliveryRecord): void;
  listForRound(taskId: string, steps: number): readonly ApprovalRoundDeliveryRecord[];
  removeForConnection(connectionId: string): number;
}
export type ApprovalRoundDeliveryRepositoryPort = AsyncRepository<ApprovalRoundDeliveryRepositoryPortDefinition>;

/** Counts of what a purge erased, by kind; content-free. */
export const ChannelPurgeCountsSchema = z.record(z.string().min(1).max(64), z.number().int().nonnegative());
export type ChannelPurgeCounts = z.infer<typeof ChannelPurgeCountsSchema>;

export const CHANNEL_PURGE_STATES = ["scheduled", "cancelled", "running", "done"] as const;

/**
 * A removed connection whose channel purges on removal: scheduled for
 * `purgeAfter`, cancelled when the same platform account is added again
 * before then, and kept as a counts-only row once done.
 */
export const ChannelPurgeRecordSchema = z.strictObject({
  connectionId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(128),
  providerId: z.string().min(1).max(48),
  /**
   * The platform account it was, by the platform's own id for it (a bot's or
   * an application's id, as its connector reports it), never a display name
   * or the descriptor's label: adding that same account again cancels the
   * purge, and another account of the provider must not.
   */
  accountRef: z.string().min(1).max(256),
  requestedAt: z.string(),
  purgeAfter: z.string(),
  state: z.enum(CHANNEL_PURGE_STATES),
  counts: ChannelPurgeCountsSchema.optional(),
  finishedAt: z.string().optional(),
});
export type ChannelPurgeRecord = z.infer<typeof ChannelPurgeRecordSchema>;

/** What a connection brought in, read before its purge: content-free. */
export interface ChannelPurgeInventory {
  /** Every task its conversations were mapped to, in every epoch. */
  readonly taskIds: readonly string[];
  /** The media artifacts its inbound messages carried. */
  readonly artifactIds: readonly string[];
  readonly conversations: number;
  readonly messages: number;
  /** The routine delivery targets on it, which the purge removes. */
  readonly routineTargets: readonly string[];
  /** The heartbeats with a target on it, which lose that target. */
  readonly heartbeats: readonly { readonly workspaceId: string; readonly principalId: string }[];
}

interface ChannelPurgeRepositoryPortDefinition {
  /** What the connection brought in: its conversations' tasks, its messages, the files they carried. */
  inventory(connectionId: string): ChannelPurgeInventory;
  /**
   * Erases, in one transaction, every row naming the connection:
   * inbox, outbox, deliveries, inbound activity, need deliveries, identity
   * bindings, conversation mappings of every epoch, rooms, round deliveries,
   * routine delivery targets and heartbeat targets on it, and its approval
   * rounds' channel; and, by `taskIds`, their memory card prompts, session
   * grants and admissions' words. Answers the counts per kind, and the routines and heartbeats that
   * lost a target. With `finished`, the purge is also marked done with these
   * counts and those, in the same transaction. Idempotent.
   */
  erase(
    connectionId: string,
    taskIds: readonly string[],
    finished?: ChannelPurgeCounts,
    at?: string,
  ): {
    readonly counts: ChannelPurgeCounts;
    readonly routineTargets: readonly string[];
    readonly heartbeats: readonly { readonly workspaceId: string; readonly principalId: string }[];
  };
  /** Schedules a purge, replacing one cancelled or done for the same connection. */
  schedule(purge: Omit<ChannelPurgeRecord, "state" | "counts" | "finishedAt">): void;
  get(connectionId: string): ChannelPurgeRecord | undefined;
  /** Cancels every scheduled purge of this provider's account, answering their connection ids. */
  /**
   * `opener`: the connection whose opening asks. Only a purge still within its
   * grace at `at` is cancelled, and only for the removed connection itself
   * (its plugin reinstalled) or one added since its removal — never by
   * another connection of the account that was there all along.
   */
  cancelForAccount(
    providerId: string,
    accountRef: string,
    at: string,
    opener?: { readonly connectionId: string; readonly createdAt?: string | undefined },
  ): readonly string[];
  /** Purges whose time has come, or that a stopped owner left running: oldest first. */
  listDue(now: string): readonly ChannelPurgeRecord[];
  markRunning(connectionId: string): boolean;
  /** A running purge's counts so far (its files erased), kept so a purge resumed after a stop still counts what went before. */
  recordProgress(connectionId: string, counts: ChannelPurgeCounts): boolean;
  finish(connectionId: string, counts: ChannelPurgeCounts, at: string): boolean;
  /**
   * A third party's deletion request (`forget-sender`), read before
   * anything goes: the sender's inbound messages on the connection (admitted
   * and held alike), the media they carried, the principal they are bound to,
   * and each conversation they spoke in, or another's message there quoted
   * them (`referenced`, a reply's parent or a picked message), with its tasks
   * in every epoch.
   */
  senderFootprint(connectionId: string, externalSenderId: string): ChannelSenderForgetting;
  /**
   * Then, last: erases those messages and the binding, and their words from
   * the messages of others that quote them (the quoting message stays),
   * answering how many messages went and how many quotes.
   */
  forgetSender(
    connectionId: string,
    externalSenderId: string,
  ): { readonly messages: number; readonly quoted: number; readonly bindingRemoved: boolean };
}

/** A sender's footprint on a connection, and where their words may still be. */
export interface ChannelSenderForgetting {
  readonly messages: number;
  readonly artifactIds: readonly string[];
  readonly principalId?: string;
  readonly conversations: readonly { readonly conversationId: string; readonly taskIds: readonly string[] }[];
}
export type ChannelPurgeRepositoryPort = AsyncRepository<ChannelPurgeRepositoryPortDefinition>;
