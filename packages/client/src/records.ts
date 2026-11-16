import {
  homeConversationId,
  isIpcOrigin,
  latestSettledAdmission,
  type AdmissionOutcome,
  type ApprovalScope,
  maxRisk,
  type RiskLevel,
  type AdmissionRecord,
  type ExecutionMetrics,
  type LabelSummary,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import type { ApprovalRequest, PendingRound, RunState, ToolCard } from "./reduce-run.js";

/**
 * A task's recorded state, as an attached front end reads it when the owner
 * holds no stream for it (it ended before this owner started, or its stream
 * was evicted) or after a restart erased what the stream said. `tavi run
 * --attach`, `tavi chat` and the web canvas read it the same way, so they say
 * the same thing.
 */

/** How a followed task ended — from its stream, or from its recorded outcome. */
/** A call of a round as the task's admission recorded it: its display, risk, input and provenance, as it was announced. */
export interface RecordedRequest {
  readonly toolName: string;
  readonly callId: string;
  readonly input?: unknown;
  readonly display?: ApprovalRequest["display"] | undefined;
  readonly risk?: ApprovalRequest["risk"] | undefined;
  readonly provenance?: ApprovalRequest["provenance"] | undefined;
  readonly summary?: string | undefined;
}

export type Ending =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly reason?: string }
  /** The person stopped it, and `message` says so in their words: no failure, and a reply goes on. */
  | { readonly kind: "stopped"; readonly message: string }
  | { readonly kind: "approval"; readonly requests: readonly RecordedRequest[] }
  | {
      readonly kind: "review";
      /** The round the review suspends. */
      readonly steps: number;
      readonly requests: readonly { readonly artifactId: string; readonly toolName: string; readonly callId: string }[];
    }
  | ({ readonly kind: "waiting" } & NonNullable<RunState["waiting"]>);

/** What `tasks { taskId }` answers, as far as an attached front end reads it. */
export interface RecordedTask {
  readonly task?: {
    readonly status?: string;
    readonly origin?: string;
    readonly chatKind?: string;
    readonly principalId?: string;
    readonly memoryMode?: string | null;
  } | null;
  readonly admissions?: readonly AdmissionRecord[];
  /** Whole-task totals and checkpointed calls, independent of the live event ring. */
  readonly history?: {
    readonly metrics?: ExecutionMetrics;
    readonly startedAt?: string;
    readonly lastAt?: string;
    /** The sum of the task's ended executions' spans: working time, without the waits between them. */
    readonly activeMs?: number;
    readonly tools: readonly ToolCard[];
    readonly partial: boolean;
  };
  /**
   * The chat's context label as its checkpoint records it: what the header's taint chip shows. `null` when the checkpoint cannot
   * be read; absent from an older owner.
   */
  readonly contextLabel?: LabelSummary | null;
}

/** The record's context label when it says the chat read untrusted content: what a taint chip shows. */
export function taintOfRecorded(recorded: Pick<RecordedTask, "contextLabel"> | undefined): LabelSummary | undefined {
  const label = recorded?.contextLabel;
  return label !== undefined && label !== null && label.integrity === "untrusted" ? label : undefined;
}

/**
 * The local conversation a front end replies into for a task an attached
 * client started: a Home's is one fixed id per person, any other
 * run's its start's operation key. Undefined when it has none.
 */
export function conversationOfRecorded(recorded: RecordedTask): string | undefined {
  if (!isIpcOrigin(recorded.task?.origin)) return undefined;
  if (recorded.task?.chatKind === "home" && recorded.task.principalId !== undefined) return homeConversationId(recorded.task.principalId);
  return recorded.admissions?.find((admission) => admission.kind === "start")?.operationKey;
}

/** What a task's record says a front end should do: follow it, or report how it stands. */
export type RecordedState =
  | { readonly kind: "cancelled" }
  /** An admission is queued or running, or nothing has settled yet: follow it live. */
  | { readonly kind: "live" }
  | { readonly kind: "settled"; readonly ending: Ending };

export function recordedStateOf(recorded: RecordedTask): RecordedState {
  if (recorded.task?.status === "cancelled") return { kind: "cancelled" };
  const admissions = recorded.admissions ?? [];
  // A chat with no turn yet (a Home a schedule started) is settled, not about to run.
  if (admissions.length === 0 && recorded.task?.status === "completed") return { kind: "settled", ending: { kind: "completed" } };
  const inFlight = admissions.some(
    (admission) => admission.result === null && (admission.state === "pending" || admission.state === "claimed"),
  );
  const outcome = latestSettledAdmission(admissions)?.result ?? undefined;
  if (inFlight || outcome === undefined) return { kind: "live" };
  return { kind: "settled", ending: endingOfOutcome(outcome) };
}

/** The ending a recorded admission outcome describes. */
export function endingOfOutcome(outcome: AdmissionOutcome): Ending {
  if (outcome.status === "completed") return { kind: "completed" };
  // A round names at least one call, as contracts' `pendingRoundFromAdmission` reads it: an empty one is none.
  if (outcome.status === "waiting" && outcome.interrupt !== undefined && outcome.interrupt.requests.length > 0) {
    return { kind: "approval", requests: outcome.interrupt.requests };
  }
  const review = outcome.status === "waiting" ? outcome.reviewInterrupt?.requests[0] : undefined;
  if (outcome.status === "waiting" && outcome.reviewInterrupt !== undefined && review !== undefined) {
    return { kind: "review", steps: review.steps, requests: outcome.reviewInterrupt.requests };
  }
  if (outcome.status === "waiting" && outcome.waitInterrupt !== undefined) {
    const wait = outcome.waitInterrupt.wait;
    const on =
      wait.correlationId !== undefined
        ? `a reply correlated to ${wait.correlationId}`
        : wait.waitingOnWorkerTaskId !== undefined
          ? `worker task ${wait.waitingOnWorkerTaskId} completing`
          : "its deadline";
    return {
      kind: "waiting",
      on,
      deadlineAt: wait.deadlineAt,
      ...definedOnly({
        question: outcome.waitInterrupt.question,
        choices: outcome.waitInterrupt.choices,
        context: outcome.waitInterrupt.context,
        handoff: outcome.waitInterrupt.handoff,
        connect: outcome.waitInterrupt.connect,
      }),
      // The wait itself, so an answer names it and its settlement clears it.
      waitId: wait.waitId,
    };
  }
  if (outcome.status === "stopped") return { kind: "stopped", message: outcome.finalText };
  return { kind: "failed", ...(outcome.error === undefined ? {} : { reason: `${outcome.error.code}: ${outcome.error.message}` }) };
}

/**
 * The calls of round `steps`, from the owner's pending approval rows for the
 * task (`approvals list`). The owner announces a round one call at a time
 * (`approval.required` each), so a front end asks for a round only once every
 * call listed here has arrived: a round decided whole must be seen whole.
 * Empty when the rows are gone — the round was decided before it was listed.
 */
export function roundCallIds(
  rows: readonly { readonly record: { readonly callId: string; readonly steps: number } }[],
  steps: number,
): ReadonlySet<string> {
  return new Set(rows.filter((row) => row.record.steps === steps).map((row) => row.record.callId));
}

/**
 * The pending rounds an `approvals list` answer describes, as `seed` takes
 * them (`rounds`). The listing carries no inputs. It does carry the call's headline, the scopes
 * a decision may carry and the round's risk, which a seeded round keeps: a
 * request without a risk reads as unassessed, and a card asks a second
 * "Confirm actions" step of every unassessed call that changes anything.
 */
export function pendingRoundsOf(
  taskId: string,
  rows: readonly {
    readonly record: { readonly approvalId: string; readonly callId: string; readonly toolId: string; readonly steps: number };
    readonly summary?: string | undefined;
    readonly risk?: RiskLevel | undefined;
    readonly allowedScopes?: readonly ApprovalScope[] | undefined;
    /** Present only when the round's chat read untrusted content. */
    readonly label?: LabelSummary | undefined;
  }[],
  /**
   * The round's calls as the task's admission recorded them (`Ending`'s): what the listing leaves out to stay
   * small — each call's title, diff and reasons, its input and provenance — so a round reopened reads as it did live.
   */
  recorded: readonly RecordedRequest[] = [],
): { readonly rounds: PendingRound[] } {
  const rounds = new Map<number, PendingRound["requests"][number][]>();
  for (const { record, summary, risk, allowedScopes, label } of rows) {
    const steps = record.steps;
    const requests = rounds.get(steps) ?? [];
    requests.push({
      callId: record.callId,
      toolName: record.toolId,
      summary: summary ?? "",
      input: null,
      approvalId: record.approvalId,
      // The round's highest risk, not this call's own: it errs toward asking more.
      ...(risk === undefined
        ? {}
        : { risk: { level: risk, reasons: [], tainted: label !== undefined, ...(label === undefined ? {} : { label }) } }),
      ...(allowedScopes === undefined ? {} : { allowedScopes }),
      ...(label === undefined
        ? {}
        : { provenance: { sources: label.sources, principals: label.principals, refs: label.refs, argOrigins: [] } }),
    });
    rounds.set(steps, requests);
  }
  const byCall = new Map(recorded.map((request) => [request.callId, request]));
  /** A listed call with what its record says of it; the round's risk kept where it is higher, as the listing errs that way. */
  const filled = (request: ApprovalRequest): ApprovalRequest => {
    const own = byCall.get(request.callId);
    if (own === undefined) return request;
    const risk =
      own.risk === undefined
        ? request.risk
        : { ...own.risk, level: request.risk === undefined ? own.risk.level : maxRisk(own.risk.level, request.risk.level) };
    return {
      ...request,
      ...definedOnly({ input: own.input, display: own.display, provenance: own.provenance, risk }),
      summary: request.summary === "" ? (own.summary ?? "") : request.summary,
    };
  };
  return { rounds: [...rounds].map(([steps, requests]) => ({ taskId, steps, requests: requests.map(filled) })) };
}
