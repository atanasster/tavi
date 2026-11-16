import type { AsyncRepository } from "../persistence-types.js";

/**
 * State of one execution attempt for a task.
 *
 * `active` holds the invocation slot; `released` ended cleanly; `terminated`
 * records a known-dead invocation. Only an explicit termination permits a
 * replacement, because an expired lease alone cannot distinguish a dead process
 * from a slow one.
 */
export const EXECUTION_STATES = ["active", "released", "terminated"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface ExecutionRecord {
  readonly taskId: string;
  /** Monotonic per task; a stale generation may never write. */
  readonly generation: number;
  readonly ownerSession: string;
  readonly admissionId: string;
  readonly state: ExecutionState;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  /** When the owner last claimed liveness; an expired lease is a symptom. */
  readonly leaseExpiresAt: string;
  readonly endedAt: string | null;
  /** Why and by whom the generation was terminated, when it was. */
  readonly terminatedReason: string | null;
  readonly terminatedBy: string | null;
}

export interface ExecutionLease {
  readonly taskId: string;
  readonly generation: number;
  readonly ownerSession: string;
  readonly leaseExpiresAt: string;
}

/**
 * `details.reason` of the `CONFLICT` a fenced execution raises: its generation
 * was superseded (or ended) while it ran. Distinct from a refusal before an
 * admission ran anything — work may have happened, and another execution now
 * owns the task — so a front end reports the two differently.
 */
export const EXECUTION_SUPERSEDED = "execution-superseded";

/**
 * `details.reason` of the `CONFLICT` an admission meets when its task's
 * execution slot is held by another generation (`acquire`): nothing ran, and
 * the admission can be retried once the holder ends — or, for a holder that no
 * longer exists, once an operator terminates it (`tavi recover`).
 */
export const EXECUTION_BUSY = "execution-busy";

/**
 * `details.index` of the `CONFLICT` an admission meets when it would make a
 * second Home for its person: the unique index that holds one, named
 * so a caller matches the code and this, never SQLite's message.
 */
export const HOME_CHAT_INDEX = "tavi_tasks_home_idx";

/**
 * `details.reason` of the `CONFLICT` an admission is refused with by the round
 * precondition (`expectedSteps`): the round it decides is no longer the
 * one pending — another front end decided it first. Nothing ran and the task is
 * as it was; a retry under the same key is refused the same way.
 */
export const ROUND_REFUSED = "round-refused";

interface ExecutionRepositoryPortDefinition {
  /**
   * Take the invocation slot for a task.
   *
   * Succeeds when the task is idle, when this session already holds the slot, or
   * after a confirmed termination. A live slot held by another session, and an
   * expired slot that has *not* been confirmed terminated, both refuse —
   * overlapping writers must be impossible, not merely unlikely.
   */
  acquire(input: {
    readonly taskId: string;
    readonly ownerSession: string;
    readonly admissionId: string;
    readonly leaseMs: number;
    readonly now: () => string;
  }): ExecutionLease;
  /** Record a heartbeat while work is in progress. */
  heartbeat(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly ownerSession: string;
    readonly leaseMs: number;
    readonly now: () => string;
  }): void;
  /** Release the slot after clean completion. */
  release(input: { readonly taskId: string; readonly generation: number; readonly ownerSession: string; readonly now: () => string }): void;
  /**
   * Record that a specific generation is known dead, permitting replacement.
   *
   * This is the only path that clears a slot, and it demands explicit evidence:
   * the operator must confirm the invocation and its process have terminated.
   * Without that, a crashed invocation would either wedge the task forever or —
   * worse — be silently overlapped.
   */
  terminate(input: {
    readonly taskId: string;
    readonly generation: number;
    /** Must be `true`; the parameter exists so the confirmation is deliberate. */
    readonly confirmedTerminated: boolean;
    readonly reason: string;
    readonly terminatedBy: string;
    readonly now: () => string;
  }): void;
  /** Executions that hold a slot but whose lease has expired. */
  listExpiredLeases(now: string, limit: number): readonly ExecutionRecord[];
  current(taskId: string): ExecutionRecord | undefined;
  list(taskId: string): readonly ExecutionRecord[];
  /**
   * Refuse a callback from a superseded execution.
   *
   * Throws when the generation is no longer the task's current owner, so a
   * delayed invocation cannot write after a replacement started.
   */
  assertCurrentGeneration(taskId: string, generation: number, ownerSession: string): void;
}

export type ExecutionRepositoryPort = AsyncRepository<ExecutionRepositoryPortDefinition>;

/**
 * An application receipt for a durable checkpoint.
 *
 * The checkpoint is the workflow's authority for progress; this record is the
 * application's acknowledgement that it observed that checkpoint, so a restart
 * can reconcile the two without replaying input.
 */
export interface CheckpointReceipt {
  readonly taskId: string;
  readonly threadId: string;
  readonly checkpointNamespace: string;
  readonly checkpointId: string;
  /** Which admission observed it, or `null` when reconciliation recorded it. */
  readonly admissionId: string | null;
  /** How the receipt came to exist, so a reconciled one is not mistaken for a live one. */
  readonly source: "admission" | "reconcile";
  readonly recordedAt: string;
}

interface CheckpointReceiptRepositoryPortDefinition {
  /** Record a receipt; idempotent per (thread, namespace, checkpoint). */
  record(input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly checkpointNamespace: string;
    readonly checkpointId: string;
    readonly admissionId: string | null;
    readonly source: "admission" | "reconcile";
    readonly now: () => string;
  }): CheckpointReceipt;
  latestForTask(taskId: string): CheckpointReceipt | undefined;
  listForTask(taskId: string): readonly CheckpointReceipt[];
  list(limit: number): readonly CheckpointReceipt[];
}

export type CheckpointReceiptRepositoryPort = AsyncRepository<CheckpointReceiptRepositoryPortDefinition>;
