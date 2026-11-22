import {
  NEEDS_MAX_LIMIT,
  NeedsAnswerSchema,
  type NeedsAnswer,
  APPROVAL_PENDING_MAX_LIMIT,
  ApprovalAnnouncedInSchema,
  ApprovalScopeSchema,
  ApprovalSettlementSchema,
  ApprovalsHistoryResultSchema,
  RiskLevelSchema,
  type ApprovalHistoryKind,
  type ApprovalHistoryState,
  type ApprovalScope,
  type ApprovalSettlement,
  type ApprovalsHistoryResult,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { z } from "zod";

import { ask, mapOutcome, read, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import { approvePayload } from "../chat/tasks-api.js";
import { translateNow } from "../../lib/i18n.js";

/** History items per page: the owner's default. */
const HISTORY_PAGE_SIZE = 50;

/**
 * One row of `approvals list` as the inbox reads it: the row's `record`, and
 * the card's fields beside it. An older owner sends only `record` and `task`;
 * its rows still read, as cards with no risk and `once` only.
 */
const PendingListRowSchema = z.object({
  record: z.object({
    approvalId: z.string().min(1),
    taskId: z.string().min(1),
    toolId: z.string().min(1),
    callId: z.string().min(1),
    steps: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  }),
  task: z.object({ principalId: z.string().optional(), origin: z.string().optional() }).optional(),
  taskTitle: z.string().optional(),
  rootTaskId: z.string().optional(),
  principalId: z.string().optional(),
  summary: z.string().optional(),
  risk: RiskLevelSchema.optional(),
  expiresAt: z.string().optional(),
  allowedScopes: z.array(ApprovalScopeSchema).min(1).optional(),
  announcedIn: ApprovalAnnouncedInSchema.optional(),
  /** A Home's or a messaging chat's round: its chat grant lasts a day. */
  lastingChat: z.literal(true).optional(),
  /** Where the round's chat read untrusted content, as the owner words it (`approvalProvenanceLine`). */
  provenance: z.string().optional(),
});
export type PendingListRow = z.infer<typeof PendingListRowSchema>;

const PendingListSchema = z.object({ rows: z.array(PendingListRowSchema), truncated: z.boolean() });
export type PendingList = z.infer<typeof PendingListSchema>;

/** The workspace's pending approvals, oldest first: every card the inbox shows. */
export function listPendingApprovals(client: SettingsClient, workspaceId: string): Promise<Outcome<PendingList>> {
  return read(client, "approvals", { action: "list", workspaceId, limit: APPROVAL_PENDING_MAX_LIMIT }, PendingListSchema);
}

const RoundCallsSchema = z.object({
  calls: z
    .array(z.object({ steps: z.number(), callId: z.string(), toolId: z.string(), inputs: z.unknown(), state: z.string() }))
    .optional(),
});

/** A task's approval calls with their full input, read only when a card's details are opened. */
export async function loadRoundCalls(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
): Promise<
  Outcome<
    readonly {
      readonly steps: number;
      readonly callId: string;
      readonly toolId: string;
      readonly inputs: unknown;
      readonly state: string;
    }[]
  >
> {
  const shown = await read(client, "approvals", { action: "show", workspaceId, taskId }, RoundCallsSchema);
  return mapOutcome(shown, (value) => value.calls ?? []);
}

/** Open questions and pending reviews, as one queue with the approvals. */
export function listNeeds(client: SettingsClient, workspaceId: string, taskId?: string): Promise<Outcome<NeedsAnswer>> {
  return read(
    client,
    "approvals",
    { action: "needs", workspaceId, limit: NEEDS_MAX_LIMIT, ...(taskId === undefined ? {} : { taskId }) },
    NeedsAnswerSchema,
  );
}

/**
 * Answer a task's open question from here. `CONFLICT` means it was
 * answered elsewhere, or closed, before this answer reached it.
 */
export function answerNeed(
  client: SettingsClient,
  answer: { readonly workspaceId: string; readonly taskId: string; readonly waitId: string; readonly answer: string },
): Promise<Outcome<unknown>> {
  return ask(client, "approvals", { action: "answer", ...answer });
}

/** The history's filters, as the page offers them. */
export interface HistoryFilters {
  readonly kinds?: readonly ApprovalHistoryKind[] | undefined;
  readonly states?: readonly ApprovalHistoryState[] | undefined;
  readonly principalId?: string | undefined;
  /** Approvals of this tool only. */
  readonly toolId?: string | undefined;
  /** Decisions made in this chat only. */
  readonly taskId?: string | undefined;
  /** Items a page; the history's own page size when absent. */
  readonly limit?: number | undefined;
}

/** One page of decisions made before, newest first. */
export function listHistory(
  client: SettingsClient,
  workspaceId: string,
  filters: HistoryFilters,
  cursor?: string,
): Promise<Outcome<ApprovalsHistoryResult>> {
  return read(
    client,
    "approvals",
    {
      action: "history",
      workspaceId,
      limit: filters.limit ?? HISTORY_PAGE_SIZE,
      ...definedOnly({
        kinds: filters.kinds,
        states: filters.states,
        principalId: filters.principalId,
        toolId: filters.toolId,
        taskId: filters.taskId,
        cursor,
      }),
    },
    ApprovalsHistoryResultSchema,
  );
}

/** A decision's outcome: done, refused because the round was settled elsewhere, or refused. */
export type DecisionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly settled?: ApprovalSettlement | undefined };

/**
 * Decide one round the way the task's own card does (`store.ts` `decide`):
 * the `approve` command with the payload `approvePayload` builds (the card's
 * `decide` sends the same), with `expectedSteps` so a round that moved on is
 * refused rather than decided blind. A refusal for a
 * round already settled — in a chat, by an email link, by expiry — carries
 * how it was (`details.settled`), which the card shows instead of an error.
 */
export async function decideRound(
  client: SettingsClient,
  decision: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly steps: number;
    readonly approved: boolean;
    readonly scope: ApprovalScope;
    readonly decidedBy?: string | undefined;
    /** Per call, when the round is not decided whole: those not approved are rejected. */
    readonly decisions?: readonly { readonly callId: string; readonly approved: boolean }[] | undefined;
    /** A rejection's reason, which the task reads. */
    readonly note?: string | undefined;
  },
): Promise<DecisionOutcome> {
  const answer = await ask<unknown>(
    client,
    "approve",
    approvePayload(
      { taskId: decision.taskId, workspaceId: decision.workspaceId, expectedSteps: decision.steps, decidedBy: decision.decidedBy },
      decision.decisions ?? decision.approved,
      { scope: decision.scope, note: decision.note },
    ),
    { timeoutMs: null, refused: translateNow("center.approvalsApi.refused") },
  );
  if (answer.ok) return { ok: true };
  const settled = ApprovalSettlementSchema.safeParse(answer.details?.["settled"]);
  return { ok: false, message: answer.message, ...(settled.success ? { settled: settled.data } : {}) };
}
