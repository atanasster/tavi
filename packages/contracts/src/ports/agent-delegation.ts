import type {
  AgentDelegationAdmissionRecord,
  AgentDeliveryState,
  AgentMailboxEnvelopeRecord,
  AgentRetentionState,
  AgentWaitIntentRecord,
  AgentWaitOutcome,
  AskUserChoices,
} from "../agent-communication.js";
import type { ConnectRequest } from "../app-connect.js";
import type { BrowserHandoff } from "../browser-handoff.js";
import type { AsyncRepository } from "../persistence-types.js";

interface AgentDelegationRepositoryPortDefinition {
  /** Direct children in a workspace, stable worker-id order, clamped to 1..201 rows. */
  listChildren(workspaceId: string, parentTaskId: string, limit: number): readonly AgentDelegationAdmissionRecord[];
  recordSpawn(record: AgentDelegationAdmissionRecord): void;
  /**
   * How many workers of the tree under `rootTaskId` have not ended — at any
   * depth, read by the row's root — for the concurrency limit.
   */
  countRunningInTree(workspaceId: string, rootTaskId: string): number;
  getByOperationKey(workspaceId: string, principalId: string, operationKey: string): AgentDelegationAdmissionRecord | undefined;
  /**
   * Reverse lookup by the worker task the spawn created — the only way to
   * ask "is this task a delegated worker, and if so what memory grant did
   * it get" on a turn after the one that spawned it. `InvocationContext` is
   * rebuilt (not persisted verbatim) on every admission that touches a
   * task, so the worker's `memoryScopeRestricted`/`delegatedMemoryRecordIds`
   * pair has to be re-derived from here each time rather than assumed
   * carried over.
   */
  getByWorkerTaskId(workerTaskId: string): AgentDelegationAdmissionRecord | undefined;
  /**
   * The workers `countRunningInTree` counts, at most `limit`, oldest first,
   * with their status: a refused spawn names them.
   */
  listRunningInTree(
    workspaceId: string,
    rootTaskId: string,
    limit: number,
  ): readonly { readonly workerTaskId: string; readonly agentDefinitionId?: string; readonly status: string }[];
  /**
   * Workers whose task ended completed or failed at or after `since` (its last
   * update) and whose parent was never sent the result envelope of their last
   * admission (`worker-result-<admissionId>`) — an announce an owner restart
   * lost. At most `limit` worker task ids, oldest first.
   */
  listUnannouncedEnded(since: string, limit: number): readonly string[];
}

export type AgentDelegationRepositoryPort = AsyncRepository<AgentDelegationRepositoryPortDefinition>;

/**
 * Durable mailbox storage. Envelopes are written `pending` in
 * the same transaction as their wake intent; `claim`/`acknowledge`
 * implement the lease-based batch claim
 * the `receive`/`ack` operations need.
 */
interface AgentMailboxRepositoryPortDefinition {
  insertEnvelope(envelope: AgentMailboxEnvelopeRecord): void;
  getEnvelope(messageId: string): AgentMailboxEnvelopeRecord | undefined;
  /** Envelopes addressed to this task still pending delivery, oldest first (ties in insertion order). */
  listPending(taskId: string, limit: number): readonly AgentMailboxEnvelopeRecord[];
  /**
   * Envelopes matching a correlation id regardless of delivery state — used
   * to "recheck durable mail when registering the wait to avoid missing an
   * early reply".
   */
  listByCorrelation(correlationId: string): readonly AgentMailboxEnvelopeRecord[];
  /** Atomically claims up to `limit` pending envelopes under one lease. */
  claim(input: {
    readonly taskId: string;
    readonly limit: number;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
  }): readonly AgentMailboxEnvelopeRecord[];
  /** Only envelopes still under this exact lease transition to `acknowledged`. */
  acknowledge(input: { readonly taskId: string; readonly leaseId: string; readonly messageIds: readonly string[] }): void;
  setDeliveryState(messageId: string, state: AgentDeliveryState): void;
  setRetentionState(messageId: string, state: AgentRetentionState): void;
  /**
   * The envelopes a turn reads, marked `delivered` under
   * `leaseId` (`mailbox-<admissionId>`). A re-run of the same admission gets
   * back exactly what that lease holds and nothing newer, so it rebuilds the
   * block it may already have committed. Otherwise: first, rows another
   * `mailbox-…` lease of the task still holds — a turn that died between its
   * claim and its settle; a task's turns are serialized, so none is live —
   * are settled: acknowledged when that lease is in `readLeases` (its block
   * reached the chat's conversation), handed back to `pending` otherwise;
   * then up to `limit` pending ones, newest first. `more` counts the pending
   * ones left behind.
   */
  claimForTurn(input: {
    readonly taskId: string;
    readonly leaseId: string;
    readonly limit: number;
    readonly readLeases?: readonly string[];
  }): {
    readonly envelopes: readonly AgentMailboxEnvelopeRecord[];
    readonly more: number;
  };
  /** Hands what `leaseId` holds back to `pending` — all of it, or only `messageIds`: a turn that never read them. */
  releaseClaim(input: { readonly taskId: string; readonly leaseId: string; readonly messageIds?: readonly string[] }): void;
  /**
   * Acknowledges the task's envelopes not yet acknowledged (pending, or held
   * by a turn) created before `before`, so none is read again (a chat's
   * `forget`). Answers how many.
   */
  acknowledgeBefore(taskId: string, before: string): number;
  /** The envelopes of `kind` that `senderTaskId` sent `recipientTaskId` at or after `since`, oldest first. */
  listSent(input: {
    readonly senderTaskId: string;
    readonly recipientTaskId: string;
    readonly kind: AgentMailboxEnvelopeRecord["kind"];
    readonly since: string;
  }): readonly AgentMailboxEnvelopeRecord[];
}

export type AgentMailboxRepositoryPort = AsyncRepository<AgentMailboxRepositoryPortDefinition>;

/**
 * `settle` is a conditional transition (only an `active` row settles), the
 * durable-storage half of "a reply/deadline race settles once through a
 * conditional application transition keyed by wait ID".
 * `AgentWaitIntentRecord` itself is Zod-derived in `agent-communication.ts`.
 */
interface AgentWaitRepositoryPortDefinition {
  prepare(input: {
    readonly waitId: string;
    readonly taskId: string;
    readonly correlationId?: string;
    readonly waitingOnWorkerTaskId?: string;
    readonly deadlineAt: string;
    /** A question's choices, read back when its answer arrives. */
    readonly choices?: AskUserChoices;
    /** A question's text, kept on its row so one never suspended on (a standing answer's) is still named. */
    readonly question?: string;
    /** A browser handoff's. */
    readonly handoff?: BrowserHandoff;
    /** A connect wait's. */
    readonly connect?: ConnectRequest;
  }): void;
  activate(waitId: string): void;
  get(waitId: string): AgentWaitIntentRecord | undefined;
  /**
   * False when the wait was not `active` (already settled, or never activated) — never a silent no-op success.
   *
   * `resume: true` is the settler's promise to admit the task's resume under
   * `waitResumeOperationKey`: the row stays "resume pending" until
   * `markResumed`, so a crash or a failed admit between the two is found by
   * `listPendingResumes` and re-admitted.
   */
  settle(input: {
    readonly waitId: string;
    readonly outcome: AgentWaitOutcome;
    readonly resume?: boolean;
    /** Who settled it — an operator, a peer agent, `policy` — for the history. */
    readonly by?: string;
    /** The front end or channel it was settled through (`approvalChannelLabel` names it). */
    readonly via?: string;
  }): boolean;
  /** The resume a `settle({ resume: true })` promised has been admitted. */
  markResumed(waitId: string): void;
  /** Settled waits whose promised resume has not been admitted, settled at or before `settledBefore`. */
  listPendingResumes(settledBefore: string): readonly AgentWaitIntentRecord[];
  /** Active waits whose deadline has passed, for the scheduler's expiry sweep. */
  listActivePastDeadline(now: string): readonly AgentWaitIntentRecord[];
  /**
   * An active wait on this task, keyed by correlation id, for `send()` to
   * settle directly (rather than the generic `wake()` path, which carries
   * no resume value a wait needs) when a reply arrives for it. `undefined`
   * when no such wait is registered or it is no longer `active`.
   */
  getActiveByCorrelation(taskId: string, correlationId: string): AgentWaitIntentRecord | undefined;
  /**
   * The active wait a task is currently suspended on, if any — for
   * `agents.cancel` to settle it (`kind: "cancelled"`) rather than leave it
   * dangling `active` forever once the task itself is cancelled. A task can
   * have at most one active wait at a time (`agents.wait` must be the sole
   * pending tool call in its generation), so this never needs to choose
   * among several.
   */
  getActiveByTask(taskId: string): AgentWaitIntentRecord | undefined;
  /**
   * The task's most recently settled wait, if it settled at or after
   * `settledSince` — for a repeat of an answer the question already took.
   */
  getRecentlySettledByTask(taskId: string, settledSince: string): AgentWaitIntentRecord | undefined;
  /** Every active browser-handoff wait: an owner starting finds those whose session its restart closed. */
  listActiveHandoffs(): readonly AgentWaitIntentRecord[];
  /** Every active connect wait: an account signed in settles each that waits on it. */
  listActiveConnects(): readonly AgentWaitIntentRecord[];
}

export type AgentWaitRepositoryPort = AsyncRepository<AgentWaitRepositoryPortDefinition>;
