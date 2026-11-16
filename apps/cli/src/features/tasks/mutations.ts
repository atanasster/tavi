import { TaviError, type CancellationRecord } from "@tavi/contracts";
import type { DatabaseClient } from "@tavi/runtime";

/**
 * Durable task mutations, implemented once.
 *
 * Cancellation and execution termination are application-owned decisions, so the
 * direct CLI path and the IPC handler both call the functions here. Neither the
 * transaction boundary nor the validation can drift between the two entry points.
 */

export interface CancellationRequest {
  readonly taskId: string;
  readonly reason: string;
  readonly operator: string;
}

export interface CancellationOutcome {
  readonly record: CancellationRecord;
  /** Pending approvals closed with the cancellation. */
  readonly cancelledApprovals: number;
}

/** Validate a cancellation request the same way from every entry point. */
function assertCancellationRequest(request: CancellationRequest): void {
  if (request.taskId.trim() === "") {
    throw new TaviError("INVALID_INPUT", "cancel requires a task id");
  }
  // The reason is recorded on the task and read by an operator later, so a blank
  // one is refused rather than stored.
  if (request.reason.trim() === "") {
    throw new TaviError("INVALID_INPUT", "cancel requires a reason that is not empty");
  }
}

/** Why Home is not cancelled: it is the chat that never ends. */
export const HOME_CANCEL_REFUSAL =
  "Home is never cancelled: stop its current turn instead, or erase its history with `tavi tasks history <id> forget --before <time>`";

/**
 * Record a cancellation and close its pending approvals atomically.
 *
 * Half-applying this — the record written but approvals still pending — could let
 * a late reply appear to grant one, so both happen in a single transaction.
 */
export async function recordCancellation(
  store: DatabaseClient,
  request: CancellationRequest,
  now: () => string,
): Promise<CancellationOutcome> {
  assertCancellationRequest(request);
  return await store.cancelTask({ ...request, now: { fixed: now() } });
}

export interface TerminationRequest {
  readonly taskId: string;
  readonly generation: number;
  readonly reason: string;
  readonly operator: string;
}

/** The document an operator receives after a confirmed termination. */
export interface TerminationDocument {
  readonly taskId: string;
  readonly generation: number;
  readonly terminatedBy: string;
  readonly reason: string;
  readonly next: string;
}

/**
 * Clear a dead execution slot.
 *
 * This is the only path to `terminate`: without it an invocation killed mid-run
 * would hold its task forever, because the ledger deliberately refuses to treat
 * an expired lease as permission to overlap. The requested generation must match
 * the holder, since terminating a generation that does not hold the slot would
 * report success while leaving the task stuck.
 */
export async function terminateExecution(
  store: DatabaseClient,
  request: TerminationRequest,
  now: () => string,
): Promise<TerminationDocument> {
  if (request.taskId.trim() === "") {
    throw new TaviError("INVALID_INPUT", "recover requires a task id");
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    throw new TaviError("INVALID_INPUT", "recover requires a positive generation");
  }
  if (request.reason.trim() === "") {
    throw new TaviError("INVALID_INPUT", "recover requires a reason that is not empty");
  }
  const executions = store.asPort().repositories.executions;
  const current = await executions.current(request.taskId);
  if (current === undefined) {
    throw new TaviError("NOT_FOUND", `No execution is recorded for task ${request.taskId}`);
  }
  if (current.generation !== request.generation) {
    throw new TaviError(
      "INVALID_INPUT",
      `Task ${request.taskId} is held by generation ${current.generation}, not ${request.generation}; ` +
        "re-run with the reported generation",
    );
  }
  if (current.state !== "active") {
    throw new TaviError(
      "INVALID_INPUT",
      `Generation ${request.generation} of task ${request.taskId} is already ${current.state}; ` + "nothing to recover",
    );
  }
  await executions.terminate({
    taskId: request.taskId,
    generation: request.generation,
    // The operator has stated the invocation is gone; this flag is the recorded
    // confirmation the repository demands.
    confirmedTerminated: true,
    reason: request.reason,
    terminatedBy: request.operator,
    now: { fixed: now() },
  });
  return {
    taskId: request.taskId,
    generation: request.generation,
    terminatedBy: request.operator,
    reason: request.reason,
    next: "re-admit the task; the replacement takes a new generation",
  };
}
