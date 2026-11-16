import type { AsyncRepository } from "../persistence-types.js";
import type { ApprovalScope } from "../tool-policy.js";
import type { AdmissionRecord, TaskRepositoryPort } from "./tasks.js";
import type { WorkflowApprovalRequest, WorkflowResumeDecision } from "./workflow-interrupts.js";

/**
 * A durable approval request and its decision.
 *
 * The application owns the exact authorized action; the graph checkpoint only
 * records the resulting progress, so a resumed run must recheck this record
 * rather than trust the checkpoint.
 */
export const APPROVAL_STATES = ["pending", "granted", "denied", "expired", "cancelled"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/**
 * The durable approval row a suspended tool call is decided through.
 *
 * One definition, used both by the graph when it writes the row and by every
 * event built from that suspension: a client addresses a row by this id
 * (`approval.required.approvalId`), so two implementations of the format would
 * let a client name a row that does not exist. Deliberately *not* carried on the
 * workflow's interrupt payload, which must stay independent of the thread (see
 * `ApprovalRequestEntrySchema`'s determinism note) — the id embeds the task.
 *
 * The round (`steps`) is required: the row id and the unique index
 * `(task_id, steps, call_id)` agree.
 */
export function approvalRowId(taskId: string, callId: string, steps: number): string {
  // Length-prefixed components, the same discipline `deterministicWaitId` uses:
  // neither id is forbidden from containing the delimiter, so an unqualified
  // join would let `taskId="a:b", callId="c"` collide with `taskId="a",
  // callId="b:c"`. `steps` is an integer and needs no prefix.
  return `approval:${taskId.length}:${taskId}:${steps}:${callId.length}:${callId}`;
}

/**
 * The durable wait a graph-dispatched wait (`agents.wait`, `operator.ask_user`)
 * registers: derived from checkpointed state, so a replay of the same turn
 * finds the same row. Per turn (`steps`), so a later call reusing an earlier
 * call's id is a new wait. The task id is length-prefixed, as `approvalRowId`'s.
 */
export function waitRowId(taskId: string, steps: number, callId: string): string {
  return `wait:${taskId.length}:${taskId}:${steps}:${callId}`;
}

/**
 * The admission key every settled wait's resume is committed under: one wait,
 * one resume. A recovery sweep re-admitting a resume that already ran replays
 * that admission rather than resuming the task a second time.
 */
export function waitResumeOperationKey(waitId: string): string {
  return `answer-${waitId}`.slice(0, 256);
}

/**
 * The admission key a round's decision is committed under.
 *
 * One round, one decision: two front ends deciding the same round produce the
 * same key, so the second is a replay rather than a second admission.
 */
export function approvalRoundKey(taskId: string, steps: number): string {
  return `approval:${taskId.length}:${taskId}:${steps}`;
}

/**
 * The same, for an artifact-review suspension.
 *
 * Keyed on the waiting admission as well as the round, unlike an approval: the
 * review node deliberately suspends again under the **same** `steps` while any
 * artifact it flagged is still undecided, so `steps` alone names every
 * suspension of that turn — and a second acknowledgement would replay the first
 * instead of re-entering the node, leaving the task waiting for good.
 */
export function reviewRoundKey(taskId: string, steps: number, waitingAdmissionId: string): string {
  return `review:${taskId.length}:${taskId}:${steps}:${waitingAdmissionId.length}:${waitingAdmissionId}`;
}

/**
 * The round a task is suspended on, as its durable admission record says.
 *
 * Not a checkpoint — `CheckpointQueryPort` returns descriptors only — but the
 * outcome the waiting admission recorded, which carries the round's requests.
 */
export type PendingRound =
  | {
      readonly kind: "approval";
      readonly steps: number;
      /** The admission that suspended on this round. */
      readonly admissionId: string;
      /** Every call of the round: a resume must decide each one, and no other. */
      readonly callIds: readonly string[];
      readonly requests: readonly WorkflowApprovalRequest[];
    }
  | {
      readonly kind: "review";
      readonly steps: number;
      readonly admissionId: string;
      readonly artifactIds: readonly string[];
    };

/**
 * The admission whose outcome is the task's current state: the latest one with a
 * recorded outcome, in creation order.
 *
 * A `refused` admission recorded nothing about the task and is skipped, and one
 * with no outcome yet (running, or left `claimed` by an unclean stop) has not
 * moved the task anywhere. Creation order is `created_at` with the store's row
 * order breaking a tie — two admissions of one task can share a millisecond. (A
 * clock stepped backwards, or a `VACUUM` renumbering rows that tie, could reorder
 * two admissions; the sequence of events that produces a waiting round and then
 * its decision does not create them in the same instant.)
 */
export function latestSettledAdmission(admissions: readonly AdmissionRecord[]): AdmissionRecord | undefined {
  for (let index = admissions.length - 1; index >= 0; index -= 1) {
    const admission = admissions[index];
    if (admission !== undefined && admission.result !== null && admission.state !== "refused") return admission;
  }
  return undefined;
}

/** The round an admission suspended on, if its outcome is a suspension on one. */
export function pendingRoundFromAdmission(admission: AdmissionRecord | undefined): PendingRound | undefined {
  const outcome = admission?.result;
  if (admission === undefined || outcome === null || outcome === undefined || outcome.status !== "waiting") return undefined;
  const approval = outcome.interrupt?.requests[0];
  if (outcome.interrupt !== undefined && approval !== undefined) {
    return {
      kind: "approval",
      steps: approval.steps,
      admissionId: admission.admissionId,
      callIds: outcome.interrupt.requests.map((request) => request.callId),
      requests: outcome.interrupt.requests,
    };
  }
  const review = outcome.reviewInterrupt?.requests[0];
  if (outcome.reviewInterrupt !== undefined && review !== undefined) {
    return {
      kind: "review",
      steps: review.steps,
      admissionId: admission.admissionId,
      artifactIds: outcome.reviewInterrupt.requests.map((request) => request.artifactId),
    };
  }
  return undefined;
}

/** The round a task is waiting on, from its admissions in creation order. */
export function pendingRoundOf(admissions: readonly AdmissionRecord[]): PendingRound | undefined {
  return pendingRoundFromAdmission(latestSettledAdmission(admissions));
}

/** The `expectedSteps` precondition a round is decided under. */
export function expectedStepsOf(round: { readonly steps: number }): { readonly expectedSteps: number } {
  return { expectedSteps: round.steps };
}

/**
 * What an admission's identity hashes for a resume: what was decided,
 * never who decided it or how the request was phrased.
 *
 * - `decidedBy` is attribution: two operators sending the same verdict on one
 *   round are one decision, and the second replays rather than conflicting over
 *   whose name is on it. It is recorded on the approval rows.
 * - A rejection's `note` is **not** attribution — it is the tool result the model
 *   reads — so it stays in the identity of a rejection, and two rejections with
 *   different instructions conflict rather than one silently replaying the
 *   other. An approval's note reaches nobody and is left out.
 * - `expectedSteps` is a precondition, not content: under a round key the round
 *   is the key, and a retry of the same decision after the round moved on is
 *   recognised as the same request.
 * - Decisions are ordered by call, so two front ends listing one round's
 *   decisions in a different order are one decision.
 */
export function resumeIntentIdentity(resume: WorkflowResumeDecision): unknown {
  const {
    decidedBy: _decidedBy,
    via: _via,
    waitId: _waitId,
    note,
    expectedSteps: _expectedSteps,
    decisions,
    approved,
    scope,
    ...rest
  } = resume;
  // A grant's scope is content: approving once and approving for the session
  // are different decisions, and the second must conflict, not replay.
  const scoped = (granted: boolean | undefined, value: ApprovalScope | undefined) =>
    granted === true && value !== undefined && value !== "once" ? { scope: value } : {};
  return {
    ...rest,
    ...(approved === undefined ? {} : { approved }),
    ...scoped(approved, scope),
    ...(approved === false && note !== undefined ? { note } : {}),
    ...(decisions === undefined
      ? {}
      : {
          decisions: [...decisions]
            .sort((left, right) => (left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0))
            .map((decision) => ({
              callId: decision.callId,
              approved: decision.approved,
              ...scoped(decision.approved, decision.scope),
              ...(decision.approved === false && decision.note !== undefined ? { note: decision.note } : {}),
            })),
        }),
  };
}

/**
 * The admission key a round's decision is committed under: the round's
 * own key. One key per round, so every front end deciding it converges on one admission.
 *
 * A caller must validate a decision **before** admitting it under this key — a
 * complete call set, no duplicates — and refuse an incomplete one as
 * `INVALID_INPUT`: an admission refused by the in-queue precondition is
 * committed under the key, and every later decision of the round under it would
 * then conflict with that refusal.
 */
export function roundResumeKey(taskId: string, round: PendingRound): string {
  return round.kind === "approval" ? approvalRoundKey(taskId, round.steps) : reviewRoundKey(taskId, round.steps, round.admissionId);
}

/**
 * Whether a front end may decide a task's round now, and which round.
 *
 * - `not-waiting` / `cancelled`: the task is not suspended, or its cancellation
 *   is recorded. A cancellation writes no admission, so the round its waiting
 *   admission names still *looks* pending — deciding it would resume a
 *   cancelled task (and, before the store guarded it, overwrite `cancelled`).
 * - `no-round`: waiting, but on nothing a decision answers (a wait, or an
 *   outcome that recorded no round).
 * - `settled-uncommitted`: an approval round whose rows were already decided by
 *   a resume that never committed its outcome, under a key other than the one
 *   this front end would admit under — reported rather
 *   than re-admitted: the thread may already be past the interrupt, and a
 *   second decision would either conflict with the recorded one inside the node
 *   or be told it applied when it did not. A resume under the *same* key is the
 *   in-doubt path and is re-admitted normally.
 */
export type RoundDecidability =
  | { readonly decidable: true; readonly round: PendingRound }
  | { readonly decidable: false; readonly reason: "not-waiting"; readonly status: string }
  | { readonly decidable: false; readonly reason: "cancelled" | "no-round" }
  | { readonly decidable: false; readonly reason: "settled-uncommitted"; readonly round: PendingRound };

export async function decidableRound(
  repositories: {
    readonly tasks: TaskRepositoryPort;
    readonly approvals: ApprovalRepositoryPort;
    readonly cancellations: CancellationRepositoryPort;
  },
  task: { readonly taskId: string; readonly status: string },
  /** The key this front end will admit its decision under; the round key by default. */
  operationKeyFor: (round: PendingRound) => string = (round) => roundResumeKey(task.taskId, round),
): Promise<RoundDecidability> {
  if ((await repositories.cancellations.get(task.taskId)) !== undefined) return { decidable: false, reason: "cancelled" };
  if (task.status !== "waiting") return { decidable: false, reason: "not-waiting", status: task.status };
  const round = pendingRoundFromAdmission(await repositories.tasks.latestSettledAdmission(task.taskId));
  if (round === undefined) return { decidable: false, reason: "no-round" };
  if (round.kind === "approval") {
    const approvals = await Promise.all(round.callIds.map((callId) => repositories.approvals.getForCall(task.taskId, callId, round.steps)));
    const decided = approvals.some((approval) => {
      const state = approval?.state;
      return state === "granted" || state === "denied";
    });
    if (decided && (await repositories.tasks.getAdmission(task.taskId, operationKeyFor(round))) === undefined) {
      return { decidable: false, reason: "settled-uncommitted", round };
    }
  }
  return { decidable: true, round };
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly taskId: string;
  readonly admissionId: string;
  /** The exact action this authorizes: tool, call and normalized inputs. */
  readonly toolId: string;
  readonly callId: string;
  /**
   * The checkpointed per-turn generation counter this approval belongs to.
   */
  readonly steps: number;
  readonly inputs: unknown;
  readonly inputsHash: string;
  readonly state: ApprovalState;
  /** Who decided, and why. Null while pending. */
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ApprovalRepositoryPortDefinition {
  /**
   * Create the pending request; idempotent per `(task, steps, callId)`. It
   * probes **exactly**: the same `callId` in a later round is a different
   * authorization and gets its own row.
   */
  request(input: {
    readonly approvalId: string;
    readonly taskId: string;
    readonly admissionId: string;
    readonly toolId: string;
    readonly callId: string;
    /** The round this row authorizes. */
    readonly steps: number;
    readonly inputs: unknown;
    readonly now: () => string;
  }): ApprovalRecord;
  /**
   * Record a decision.
   *
   * Refuses when the request is already settled or has been cancelled, so a late
   * reply cannot revive settled work.
   */
  decide(input: {
    readonly approvalId: string;
    readonly state: "granted" | "denied";
    readonly decidedBy: string;
    readonly note?: string;
    readonly now: () => string;
  }): ApprovalRecord;
  get(approvalId: string): ApprovalRecord | undefined;
  /**
   * The row authorizing one call, resolved **by round**: with `steps`,
   * that round's row; without, the newest round's.
   */
  getForCall(taskId: string, callId: string, steps?: number): ApprovalRecord | undefined;
  listForTask(taskId: string): readonly ApprovalRecord[];
  listPending(limit: number): readonly ApprovalRecord[];
  /**
   * Close every pending approval for a task.
   *
   * Called when a task is cancelled: a request that can no longer be honored
   * must not sit pending where a late reply could appear to grant it.
   */
  cancelPendingForTask(taskId: string, now: () => string): number;
}

export type ApprovalRepositoryPort = AsyncRepository<ApprovalRepositoryPortDefinition>;

/**
 * A durable cancellation.
 *
 * Cancellation is authoritative in application storage and survives restart: a
 * reply that arrives after it can never revive the work.
 */
export interface CancellationRecord {
  readonly taskId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly requestedAt: string;
}

interface CancellationRepositoryPortDefinition {
  request(input: {
    readonly taskId: string;
    readonly requestedBy: string;
    readonly reason: string;
    readonly now: () => string;
  }): CancellationRecord;
  get(taskId: string): CancellationRecord | undefined;
  list(limit: number): readonly CancellationRecord[];
}

export type CancellationRepositoryPort = AsyncRepository<CancellationRepositoryPortDefinition>;
