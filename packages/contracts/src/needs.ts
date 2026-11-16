import { z } from "zod";

import { ASK_USER_CONTEXT_MAX_CHARS, AskUserChoicesSchema } from "./agent-communication.js";
import { PendingApprovalRowSchema } from "./approval-inbox.js";
import { BrowserHandoffSchema } from "./browser-handoff.js";
import { APP_HEALTH } from "./connected-apps.js";
import { IdSchema } from "./ids.js";
import { DECIDED_NEED_KINDS } from "./need-kinds.js";
import { TaskOriginSchema } from "./task-origins.js";

/**
 * What waits on a person, as one queue: a question a
 * task asked, a pending approval, an artifact awaiting review. Each kind keeps
 * its own details; the frame — which task, from where, since when, until when —
 * is shared, so every surface can sort and render them alike.
 *
 * A read model over the rows that already hold each kind (wait intents,
 * approvals and their rounds, artifacts): nothing here is a new source of truth.
 */

/** The decided need kinds (`need-kinds.ts`); a browser handoff is listed apart. */
export const NEED_KINDS = DECIDED_NEED_KINDS;
export const NeedKindSchema = z.enum(NEED_KINDS);
export type NeedKind = (typeof NEED_KINDS)[number];

/** How many needs one listing returns at most. */
export const NEEDS_MAX_LIMIT = 500;

const TitleSchema = z.string().max(120);

/** A chat a question was delivered to. */
export const NeedDeliverySchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  /** `connectionId` as a person reads it; set by the owner, which knows its connections. */
  channel: z.string().min(1).max(128).optional(),
});
export type NeedDelivery = z.infer<typeof NeedDeliverySchema>;

/** Which task waits, and where it came from. */
const NeedTaskSchema = {
  taskId: IdSchema,
  workspaceId: IdSchema,
  principalId: IdSchema,
  /** The task's title as `tasks list` shows it. */
  taskTitle: TitleSchema.optional(),
  /** Who started the task; absent for a task recorded before origins were. */
  origin: TaskOriginSchema.optional(),
  /** The schedule that fired it, by name, for a scheduled task. */
  originLabel: TitleSchema.optional(),
  /**
   * Set when the task is a delegated worker: its agent as a person
   * reads it — the agent definition's name, else the worker's agent id.
   */
  workerLabel: TitleSchema.optional(),
};

/** An open question a task asked a person (`operator.ask_user`). */
export const PendingQuestionRowSchema = z.strictObject({
  ...NeedTaskSchema,
  waitId: IdSchema,
  question: z.string().min(1).max(2_000),
  /** Why it is asked. */
  context: z.string().min(1).max(ASK_USER_CONTEXT_MAX_CHARS).optional(),
  choices: AskUserChoicesSchema.optional(),
  /** When the task stops waiting for the answer. */
  deadlineAt: z.string().min(1).max(64),
  /** When the question was asked. */
  askedAt: z.string().min(1).max(64),
  /** The chats the question was sent to; empty when it was only shown to an attached client. */
  deliveries: z.array(NeedDeliverySchema).max(8),
});
export type PendingQuestionRow = z.infer<typeof PendingQuestionRowSchema>;

/** A task's artifacts awaiting review: decided in the task, where its diff is. */
export const PendingReviewRowSchema = z.strictObject({
  ...NeedTaskSchema,
  artifactCount: z.number().int().positive(),
  /** When the oldest of them was produced. */
  askedAt: z.string().min(1).max(64),
});
export type PendingReviewRow = z.infer<typeof PendingReviewRowSchema>;

/**
 * A browser handoff a delegated worker waits on: acted on in
 * the live view, never answered. Listed only for a root's workers.
 */
export const PendingHandoffRowSchema = z.strictObject({
  ...NeedTaskSchema,
  waitId: IdSchema,
  handoff: BrowserHandoffSchema,
  deadlineAt: z.string().min(1).max(64),
  askedAt: z.string().min(1).max(64),
});
export type PendingHandoffRow = z.infer<typeof PendingHandoffRowSchema>;

/**
 * A task waiting for an app's account to be signed in again: decided by
 * connecting or by *Not now*, never by an answer.
 */
export const PendingConnectRowSchema = z.strictObject({
  ...NeedTaskSchema,
  waitId: IdSchema,
  appId: z.string().min(1).max(128).optional(),
  appName: z.string().min(1).max(80),
  accountId: z.string().min(1).max(256),
  reason: z.string().max(300),
  health: z.enum(APP_HEALTH),
  askedAt: z.string().min(1).max(64),
  deadlineAt: z.string().min(1).max(64),
});
export type PendingConnectRow = z.infer<typeof PendingConnectRowSchema>;

export const PendingWaitsInputSchema = z
  .strictObject({
    workspaceId: IdSchema,
    /** One task's needs only. */
    taskId: IdSchema.optional(),
    /**
     * The needs of this root chat's delegated workers, at any depth:
     * not the root's own, which its stream carries. Lists their handoffs too.
     */
    rootTaskId: IdSchema.optional(),
    limit: z.number().int().min(1).max(NEEDS_MAX_LIMIT),
  })
  .refine((value) => value.taskId === undefined || value.rootTaskId === undefined, "taskId and rootTaskId cannot be combined");
export type PendingWaitsInput = z.infer<typeof PendingWaitsInputSchema>;

/** Open questions (soonest deadline first) and reviews (oldest first) of a workspace. */
export const PendingWaitsAnswerSchema = z.strictObject({
  questions: z.array(PendingQuestionRowSchema).max(NEEDS_MAX_LIMIT),
  reviews: z.array(PendingReviewRowSchema).max(NEEDS_MAX_LIMIT),
  /** A root's workers' browser handoffs (soonest deadline first); only with `rootTaskId`. */
  handoffs: z.array(PendingHandoffRowSchema).max(NEEDS_MAX_LIMIT).optional(),
  /** Tasks waiting for an app to be connected (soonest deadline first); optional, for an owner from before them. */
  connects: z.array(PendingConnectRowSchema).max(NEEDS_MAX_LIMIT).optional(),
  truncated: z.boolean(),
});
export type PendingWaitsAnswer = z.infer<typeof PendingWaitsAnswerSchema>;

const NeedFrame = {
  /** Stable across listings: `question:<waitId>`, `approval:<approvalId>`, `review:<taskId>`, `connect:<waitId>`. */
  needId: z.string().min(1).max(512),
  taskId: IdSchema,
  askedAt: z.string().min(1).max(64),
  /** When it resolves without the person: a question's deadline, a round's expiry. */
  deadlineAt: z.string().min(1).max(64).optional(),
};

export const NeedRowSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...NeedFrame, kind: z.literal("question"), question: PendingQuestionRowSchema }),
  z.strictObject({ ...NeedFrame, kind: z.literal("approval"), approval: PendingApprovalRowSchema }),
  z.strictObject({ ...NeedFrame, kind: z.literal("review"), review: PendingReviewRowSchema }),
  z.strictObject({ ...NeedFrame, kind: z.literal("connect"), connect: PendingConnectRowSchema }),
]);
export type NeedRow = z.infer<typeof NeedRowSchema>;

export const NeedsAnswerSchema = z.strictObject({
  needs: z.array(NeedRowSchema).max(NEEDS_MAX_LIMIT * NEED_KINDS.length),
  /** A root's workers' browser handoffs, when the listing was for a root (`rootTaskId`). */
  handoffs: z.array(PendingHandoffRowSchema).max(NEEDS_MAX_LIMIT).optional(),
  /** Some kind had more than the limit: questions are cut by soonest deadline, approvals and reviews by age. */
  truncated: z.boolean(),
});
export type NeedsAnswer = z.infer<typeof NeedsAnswerSchema>;

/** What `approvals answer` reports: the question it answered, and the answer as the task reads it. */
export const NeedAnsweredSchema = z.strictObject({
  taskId: z.string().min(1),
  waitId: z.string().min(1),
  answers: z.array(z.string()),
  other: z.string().optional(),
});
export type NeedAnswered = z.infer<typeof NeedAnsweredSchema>;

/**
 * One queue from each kind's rows, in the order a person should take them: the
 * soonest deadline first, then the oldest; a need with no deadline after every
 * one that has one.
 */
export function needsOf(input: {
  readonly approvals: readonly z.infer<typeof PendingApprovalRowSchema>[];
  readonly questions: readonly PendingQuestionRow[];
  readonly reviews: readonly PendingReviewRow[];
  readonly connects?: readonly PendingConnectRow[];
}): NeedRow[] {
  const needs: NeedRow[] = [
    ...input.questions.map(
      (question): NeedRow => ({
        kind: "question",
        needId: `question:${question.waitId}`,
        taskId: question.taskId,
        askedAt: question.askedAt,
        deadlineAt: question.deadlineAt,
        question,
      }),
    ),
    ...input.approvals.map(
      (approval): NeedRow => ({
        kind: "approval",
        needId: `approval:${approval.approvalId}`,
        taskId: approval.taskId,
        askedAt: approval.createdAt,
        ...(approval.expiresAt === undefined ? {} : { deadlineAt: approval.expiresAt }),
        approval,
      }),
    ),
    ...input.reviews.map(
      (review): NeedRow => ({ kind: "review", needId: `review:${review.taskId}`, taskId: review.taskId, askedAt: review.askedAt, review }),
    ),
    ...(input.connects ?? []).map(
      (connect): NeedRow => ({
        kind: "connect",
        needId: `connect:${connect.waitId}`,
        taskId: connect.taskId,
        askedAt: connect.askedAt,
        deadlineAt: connect.deadlineAt,
        connect,
      }),
    ),
  ];
  return needs.sort(compareNeeds);
}

function compareNeeds(a: NeedRow, b: NeedRow): number {
  if (a.deadlineAt !== b.deadlineAt) {
    if (a.deadlineAt === undefined) return 1;
    if (b.deadlineAt === undefined) return -1;
    return Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt);
  }
  return Date.parse(a.askedAt) - Date.parse(b.askedAt) || a.needId.localeCompare(b.needId);
}
