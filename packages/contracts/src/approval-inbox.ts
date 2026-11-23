import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import { DECIDED_NEED_KINDS } from "./need-kinds.js";
import { ApprovalScopeSchema, RiskLevelSchema } from "./tool-policy.js";
import { LabelSummarySchema } from "./content-label.js";
import { TaskOriginSchema } from "./task-origins.js";
import type { PendingWaitsAnswer, PendingWaitsInput } from "./needs.js";
import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";

/**
 * The approvals inbox and its history: every
 * pending approval of a workspace with what a card needs to be decided without
 * opening the task, and every decision made before — approvals, artifact
 * reviews and answered questions — newest first.
 *
 * Nothing here carries a call's full input, an artifact's body or a memory's
 * text: a call is named by its one-line headline (`tool-headline.ts`), and a
 * question and its answer are clipped.
 */

/** Who denies a round whose time ran out (`apps/cli/src/features/approvals/channel-approvals.ts`); history reports it as `expired`. */
export const APPROVAL_EXPIRED_DECIDER = "policy:expired";

/** The decided need kinds (`need-kinds.ts`). */
export const APPROVAL_HISTORY_KINDS = DECIDED_NEED_KINDS;
export const ApprovalHistoryKindSchema = z.enum(APPROVAL_HISTORY_KINDS);
export type ApprovalHistoryKind = (typeof APPROVAL_HISTORY_KINDS)[number];

/**
 * A decided item's outcome. An approval is `granted`, `denied`, `expired` or
 * `cancelled`; a review `approved` or `rejected`; a question `answered`, or
 * `expired`/`cancelled` when its wait ended without an answer.
 */
export const APPROVAL_HISTORY_STATES = [
  "granted",
  "denied",
  "expired",
  "cancelled",
  "approved",
  "rejected",
  "answered",
  "connected",
  "declined",
] as const;
export const ApprovalHistoryStateSchema = z.enum(APPROVAL_HISTORY_STATES);
export type ApprovalHistoryState = (typeof APPROVAL_HISTORY_STATES)[number];

const APPROVAL_OUTCOMES = ["granted", "denied", "expired", "cancelled"] as const;
const REVIEW_OUTCOMES = ["approved", "rejected"] as const;
const QUESTION_OUTCOMES = ["answered", "expired", "cancelled"] as const;
/** A connect need: connected, *Not now*, or its deadline passed (`expired`). */
const CONNECT_OUTCOMES = ["connected", "declined", "expired", "cancelled"] as const;
export const APPROVAL_HISTORY_STATES_BY_KIND: Readonly<Record<ApprovalHistoryKind, readonly ApprovalHistoryState[]>> = {
  approval: APPROVAL_OUTCOMES,
  review: REVIEW_OUTCOMES,
  question: QUESTION_OUTCOMES,
  connect: CONNECT_OUTCOMES,
};

export const APPROVAL_HISTORY_DEFAULT_LIMIT = 50;
export const APPROVAL_HISTORY_MAX_LIMIT = 100;
/** A question and its answer are clipped to this many characters. */
export const APPROVAL_HISTORY_TEXT_MAX_CHARS = 300;
export const APPROVAL_PENDING_MAX_LIMIT = 1000;

/** Opaque: only the owner interprets it. Base64url, like the task list's cursor. */
export const ApprovalInboxCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);

const ViaSchema = z.string().min(1).max(128);
const TitleSchema = z.string().max(120);
const SummarySchema = z.string().max(80);

/**
 * The name a person reads for the front end a decision came through. The
 * fixed front ends are named here; a messaging connection's id is named by
 * `connectionName` when the owner knows it (Telegram, email), and is shown as
 * the id otherwise.
 */
export function approvalChannelLabel(
  via: string,
  connectionName?: (connectionId: string) => string | undefined,
  t: CanvasCoreT = canvasCoreEnglish,
): string {
  switch (via) {
    case "cli":
    case "ipc":
      return t("approval.channel.terminal");
    case "bridge":
      return t("approval.channel.web");
    case "link":
      return t("approval.channel.emailLink");
    case "policy":
      return t("approval.channel.policy");
    case "standing-answer":
      return t("approval.channel.standingAnswer");
    default:
      return connectionName?.(via) ?? via;
  }
}

/** The chat a round was announced in. */
export const ApprovalAnnouncedInSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(256),
  /** `connectionId` as a person reads it (`approvalChannelLabel`); set by the owner, which knows its connections. */
  channel: z.string().min(1).max(128).optional(),
});

export const PendingApprovalsInputSchema = z.strictObject({
  workspaceId: IdSchema,
  /** One task's pending rows only. */
  taskId: IdSchema.optional(),
  /** The pending rows of this root chat's workers. */
  rootTaskId: IdSchema.optional(),
  limit: z.number().int().min(1).max(APPROVAL_PENDING_MAX_LIMIT),
  cursor: ApprovalInboxCursorSchema.optional(),
});
export type PendingApprovalsInput = z.infer<typeof PendingApprovalsInputSchema>;

/** One pending approval, as an inbox card shows it. */
export const PendingApprovalRowSchema = z.strictObject({
  approvalId: IdSchema,
  taskId: IdSchema,
  toolId: z.string().min(1).max(128),
  callId: IdSchema,
  steps: z.number().int().nonnegative(),
  createdAt: z.string().min(1).max(64),
  workspaceId: IdSchema,
  principalId: IdSchema,
  /** The task's stored status (`waiting`, …). */
  taskStatus: z.string().min(1).max(32),
  /** Who started the task, so a front end can tell a schedule's round from a chat's. */
  taskOrigin: TaskOriginSchema.optional(),
  /** A worker's round: the chat it belongs to, which is where the person decides it. */
  rootTaskId: IdSchema.optional(),
  /** The task's title as `tasks list` shows it: its generated title, else the first line of its first prompt; absent when it has neither. */
  taskTitle: TitleSchema.optional(),
  /** The call's one-line headline; absent when its tool family has none. */
  summary: SummarySchema.optional(),
  /** The round's highest call risk, recorded for every round whose calls were all assessed. */
  risk: RiskLevelSchema.optional(),
  /** When the round is denied if nobody decides it; only a round sent to a chat expires. */
  expiresAt: z.string().min(1).max(64).optional(),
  /**
   * The scopes a decision may carry: the ones the gate's verdict offered this
   * call, as its round recorded them (a tainted `askWhenTainted` call, a
   * once-only tool or subjects no rule can hold offer `once` alone; a call
   * with no subjects and no scope group never offers `always`). A round
   * recorded before those were stored falls back to its risk
   * (`scopesForRisk`), an upper bound the call may narrow. `["once"]` when no
   * round was recorded, as every front end reads a request without scopes.
   */
  allowedScopes: z.array(ApprovalScopeSchema).min(1).max(3),
  announcedIn: ApprovalAnnouncedInSchema.optional(),
  /**
   * Where the round's chat read content Tavi does not trust: its context
   * label's summary as the round recorded it, present
   * only when untrusted. A surface shows it as `approvalProvenanceLine`, with
   * `TAINTED_CALL_WORDS` as the why.
   */
  label: LabelSummarySchema.optional(),
});
export type PendingApprovalRow = z.infer<typeof PendingApprovalRowSchema>;

export const PendingApprovalsAnswerSchema = z.strictObject({
  rows: z.array(PendingApprovalRowSchema).max(APPROVAL_PENDING_MAX_LIMIT),
  truncated: z.boolean(),
  /** Present when `truncated`: the next page, oldest first. */
  nextCursor: ApprovalInboxCursorSchema.optional(),
});
export type PendingApprovalsAnswer = z.infer<typeof PendingApprovalsAnswerSchema>;

/** The history's filters; the IPC payload's with the workspace resolved and the limit defaulted. */
export const ApprovalHistoryInputSchema = z
  .strictObject({
    workspaceId: IdSchema,
    kinds: z.array(ApprovalHistoryKindSchema).min(1).max(APPROVAL_HISTORY_KINDS.length).optional(),
    states: z.array(ApprovalHistoryStateSchema).min(1).max(APPROVAL_HISTORY_STATES.length).optional(),
    /** Decided at or after. */
    since: TimestampSchema.transform((value) => new Date(value).toISOString()).optional(),
    /** Decided at or before. */
    until: TimestampSchema.transform((value) => new Date(value).toISOString()).optional(),
    /** Approvals of this tool only; the other kinds have no tool and are left out. */
    toolId: z.string().min(1).max(128).optional(),
    /** Approvals of the tools under these prefixes, each `<pluginId>.` (an app's Recent activity); the other kinds are left out. */
    toolPrefixes: z.array(z.string().min(2).max(129).regex(/\.$/, "a tool prefix ends in a dot")).min(1).max(16).optional(),
    /** Items of this person's tasks only. */
    principalId: IdSchema.optional(),
    /** Items of this task only: a chat's own record of what was decided in it. */
    taskId: IdSchema.optional(),
    cursor: ApprovalInboxCursorSchema.optional(),
    limit: z.number().int().min(1).max(APPROVAL_HISTORY_MAX_LIMIT),
  })
  .refine((value) => value.since === undefined || value.until === undefined || value.since <= value.until, "since must not follow until");
export type ApprovalHistoryInput = z.input<typeof ApprovalHistoryInputSchema>;

const DecidedAtSchema = z.string().min(1).max(64);

export const ApprovalHistoryItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("approval"),
    approvalId: IdSchema,
    taskId: IdSchema,
    taskTitle: TitleSchema.optional(),
    principalId: IdSchema,
    toolId: z.string().min(1).max(128),
    /** The call it decided, and its round: together unique within the task. Absent from an older owner. */
    callId: z.string().min(1).max(256).optional(),
    steps: z.number().int().nonnegative().optional(),
    summary: SummarySchema.optional(),
    state: z.enum(APPROVAL_OUTCOMES),
    /** Null for a request cancelled with its task. */
    decidedBy: z.string().max(128).nullable(),
    decidedAt: DecidedAtSchema,
    /** The front end the round was settled through (`telegram-main`, `cli`, `bridge`, `link`, `policy`), when its settlement was recorded. */
    via: ViaSchema.optional(),
    /** `via` as a person reads it (`approvalChannelLabel`); set by the owner, which knows its connections. */
    channel: z.string().min(1).max(128).optional(),
    /** How long a grant stands, from the settlement's decision for this call. */
    scope: ApprovalScopeSchema.optional(),
    risk: RiskLevelSchema.optional(),
    note: z.string().max(2000).nullable(),
    /** The standing rule an `always` grant created, to revoke it from Settings → Permissions. */
    ruleId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal("review"),
    artifactId: IdSchema,
    /** The task that produced the artifact; absent for one no task produced. */
    taskId: IdSchema.optional(),
    taskTitle: TitleSchema.optional(),
    principalId: IdSchema.optional(),
    state: z.enum(REVIEW_OUTCOMES),
    decidedBy: z.string().max(128).nullable(),
    decidedAt: DecidedAtSchema,
    note: z.string().max(2000).nullable(),
    contentType: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("question"),
    waitId: IdSchema,
    taskId: IdSchema,
    taskTitle: TitleSchema.optional(),
    principalId: IdSchema,
    state: z.enum(QUESTION_OUTCOMES),
    question: z.string().max(APPROVAL_HISTORY_TEXT_MAX_CHARS),
    /** The answer as stored on the wait; null when none was kept (or none was given). */
    answer: z.string().max(APPROVAL_HISTORY_TEXT_MAX_CHARS).nullable(),
    decidedAt: DecidedAtSchema,
    /** Who settled it (an operator, a peer agent, `policy`); absent for a wait settled before this was recorded. */
    decidedBy: z.string().min(1).max(128).optional(),
    /** The front end or channel it was settled through. */
    via: ViaSchema.optional(),
    /** `via` as a person reads it (`approvalChannelLabel`); set by the owner, which knows its connections. */
    channel: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal("connect"),
    waitId: IdSchema,
    taskId: IdSchema,
    taskTitle: TitleSchema.optional(),
    principalId: IdSchema,
    state: z.enum(CONNECT_OUTCOMES),
    appName: z.string().min(1).max(80),
    decidedAt: DecidedAtSchema,
    decidedBy: z.string().min(1).max(128).optional(),
  }),
]);
export type ApprovalHistoryItem = z.infer<typeof ApprovalHistoryItemSchema>;

/** `approvals history`: newest first by decision time; `nextCursor` while more remain. */
export const ApprovalsHistoryResultSchema = z.strictObject({
  items: z.array(ApprovalHistoryItemSchema).max(APPROVAL_HISTORY_MAX_LIMIT),
  nextCursor: ApprovalInboxCursorSchema.optional(),
});
export type ApprovalsHistoryResult = z.infer<typeof ApprovalsHistoryResultSchema>;

/**
 * How a round was settled, for a decision that arrives after it was: the
 * refusal carries it as `details.settled`, so a page can say "Already decided
 * in Telegram by Ana, 14:02" instead of showing an error.
 */
export const ApprovalSettlementSchema = z.strictObject({
  taskId: IdSchema,
  steps: z.number().int().nonnegative(),
  /** The round's outcome when every call has the same one; `mixed` when its calls were decided differently. */
  state: z.enum([...APPROVAL_OUTCOMES, "mixed"]),
  /** Who decided, and when: the round's most recently decided call. */
  decidedBy: z.string().max(128).nullable(),
  decidedAt: DecidedAtSchema,
  via: ViaSchema.optional(),
  channel: z.string().min(1).max(128).optional(),
});
export type ApprovalSettlement = z.infer<typeof ApprovalSettlementSchema>;

export const ApprovalSettlementInputSchema = z.strictObject({
  taskId: IdSchema,
  /** The round; absent: the task's most recently decided one. */
  steps: z.number().int().nonnegative().optional(),
});
export type ApprovalSettlementInput = z.infer<typeof ApprovalSettlementInputSchema>;

/**
 * The inbox's reads, scoped to a workspace in SQL (a task's workspace, or an
 * artifact's). Cursors are bound to the filters they were issued for; a
 * cursor from other filters is `INVALID_INPUT`.
 */
interface ApprovalInboxRepositoryPortDefinition {
  /** Pending approvals, oldest first. */
  pending(input: PendingApprovalsInput): PendingApprovalsAnswer;
  /** Decided approvals, reviews and questions, newest first. `channel` is left to the owner. */
  history(input: ApprovalHistoryInput): ApprovalsHistoryResult;
  /** How a round was decided, or `undefined` while any of its calls is pending (or it has none). */
  settlement(input: ApprovalSettlementInput): ApprovalSettlement | undefined;
  /** Open questions and pending reviews, for the needs queue. `channel` is left to the owner. */
  pendingWaits(input: PendingWaitsInput): PendingWaitsAnswer;
}

export type ApprovalInboxRepositoryPort = AsyncRepository<ApprovalInboxRepositoryPortDefinition>;
