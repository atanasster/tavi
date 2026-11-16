import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema } from "./ids.js";
import { InvocationContextSchema } from "./workflow-state.js";

/**
 * Where a question went, durably.
 *
 * A question's channel message is pressed, edited and answered long after it
 * was sent — often after the owner restarted. Everything that has to outlive
 * the process is recorded here, per wait and connection: the destination and
 * provider message id the message can be edited through, the text it was sent
 * with, the token its buttons carry, and a multi-select question's toggles.
 */
export const NeedDeliveryRecordSchema = z.strictObject({
  waitId: IdSchema,
  taskId: IdSchema,
  connectionId: z.string().min(1),
  /** The connector's own `OutboundMessage.destination`, as sent. */
  destination: z.unknown(),
  /** The provider's id for the sent message, when the connector reported one. */
  providerMessageId: z.string().min(1).optional(),
  /**
   * The chat it was sent to, as an inbound event names it
   * (`externalConversationId`): a provider's message ids are unique within a
   * chat only, so a reply is matched by both. Absent for a delivery
   * recorded before chats were.
   */
  chatId: z.string().min(1).max(256).optional(),
  /**
   * The forum topic or reply thread it was sent into (`externalThreadId`),
   * when it went to one: a typed answer is matched by chat and thread, so one
   * topic's message never answers another's question. Absent for the chat itself, or a delivery recorded before.
   */
  threadId: z.string().min(1).max(256).optional(),
  /** The question as rendered in the message, so an edit keeps what it said. */
  text: z.string(),
  /** The token the message's buttons carry (`questionToken(waitId)`). */
  token: z.string().min(1),
  /** A multi-select question's toggled options, 1-based, as the buttons show them. */
  selected: z.array(z.number().int().positive()),
  createdAt: z.string(),
});
export type NeedDeliveryRecord = z.infer<typeof NeedDeliveryRecordSchema>;

/**
 * A ❌ press waiting for the reason its presser was asked for, durably, so a
 * restart neither loses the reason nor leaves the round undecided past the
 * window: the channel sweep rejects an expired one without a reason.
 */
export const PendingReasonRecordSchema = z.strictObject({
  /** The conversation and presser, as `reasonKey` builds it. */
  key: z.string().min(1),
  /** The round's token. */
  token: z.string().min(1),
  workspaceId: z.string().min(1),
  principalId: z.string().min(1),
  caller: z.string().min(1),
  /** The conversation the press came from, as a messaging task's reply target names it. */
  replyTarget: InvocationContextSchema.shape.messagingReplyTo.unwrap(),
  expiresAt: z.string(),
});
export type PendingReasonRecord = z.infer<typeof PendingReasonRecordSchema>;

interface NeedDeliveryRepositoryPortDefinition {
  /** Record a delivery; a repeat for the same wait and connection keeps the first and fills in a missing message id. */
  record(delivery: Omit<NeedDeliveryRecord, "selected">): void;
  /** Every connection a wait's question was delivered to, oldest first. */
  listForWait(waitId: string): readonly NeedDeliveryRecord[];
  /** The delivery a button's token names. */
  getByToken(token: string): NeedDeliveryRecord | undefined;
  /** The delivery a provider message in this chat is, for a typed reply to it. */
  getByMessage(connectionId: string, chatId: string, providerMessageId: string): NeedDeliveryRecord | undefined;
  /**
   * The deliveries to this chat and thread whose question is still open,
   * newest first, at most `limit` — one a delegated worker asked there, say.
   * With `threadId` (a forum topic), only deliveries into that
   * thread; without, any of the chat's — the caller picks the first its
   * chat's own tree asked.
   */
  listOpenInChat(connectionId: string, chatId: string, threadId: string | undefined, limit: number): readonly NeedDeliveryRecord[];
  /** Replace a multi-select question's toggles on one connection. */
  setSelected(waitId: string, connectionId: string, selected: readonly number[]): void;
  /** Hold a ❌ press's reason prompt, replacing any earlier one for the same conversation and presser. */
  putReason(reason: PendingReasonRecord): void;
  /** The pending reason for this conversation and presser, if any, left in place. */
  getReason(key: string): PendingReasonRecord | undefined;
  /** Take (and remove) the pending reason for this conversation and presser — only the one for `token`, when given. */
  takeReason(key: string, token?: string): PendingReasonRecord | undefined;
  /** Take (and remove) every pending reason whose window ended at or before `now`. */
  takeExpiredReasons(now: string): readonly PendingReasonRecord[];
}

export type NeedDeliveryRepositoryPort = AsyncRepository<NeedDeliveryRepositoryPortDefinition>;
