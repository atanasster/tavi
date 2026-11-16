import type { AdmitRequest } from "../internal-contracts.js";
import { assertBoundedPayload, assertPositiveLimit } from "../values.js";
import { z } from "zod";
import {
  TaviError,
  type AdmissionRecord,
  type AdmissionState,
  type AdmissionKind,
  type AdmissionOutcome,
  type ExecutionState,
  ADMISSION_STATES,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import type { StoreContext } from "./context.js";
import { parseRequiredEnum } from "./stored-values.js";
import { updateTaskStatus } from "./tasks.js";
import { stmt } from "../statement-cache.js";

interface AdmissionRow {
  admission_id: string;
  task_id: string;
  operation_key: string;
  kind: string;
  intent: string;
  intent_hash: string;
  state: string;
  result: string | null;
  created_at: string;
  updated_at: string;
  instructions_revision: number | null;
}

/**
 * Owns database opening, pragmas and final close.
 *
 * The qualified handle is injected into the workflow adapter and the saver; this
 * class is the only place that opens or closes the file.
 */
/** An admission left `claimed` with no outcome, and its task's latest execution (`StoreContext.listClaimedAdmissions`). */
export interface ClaimedAdmission {
  readonly admissionId: string;
  readonly taskId: string;
  readonly operationKey: string;
  readonly kind: AdmissionKind;
  readonly createdAt: string;
  /** When it was claimed: its last state change. */
  readonly claimedAt: string;
  /** The task's latest execution — the one holding its slot, when `active`. */
  readonly execution: {
    readonly generation: number;
    readonly ownerSession: string;
    readonly admissionId: string;
    readonly state: ExecutionState;
    readonly leaseExpiresAt: string;
  } | null;
}

function toAdmissionRecord(row: AdmissionRow): AdmissionRecord {
  return {
    admissionId: row.admission_id,
    taskId: row.task_id,
    operationKey: row.operation_key,
    kind: row.kind as AdmissionRecord["kind"],
    intent: JSON.parse(row.intent) as unknown,
    intentHash: row.intent_hash,
    state: parseRequiredEnum(z.enum(ADMISSION_STATES), row.state, "admission state"),
    result: row.result === null ? null : (JSON.parse(row.result) as AdmissionOutcome),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.instructions_revision === null ? {} : { instructionsRevision: row.instructions_revision }),
  };
}

/**
 * Reject a retry that reuses an operation key for a different request.
 *
 * Both the kind and the content are compared, so a `cancel` cannot silently
 * resolve a `start`'s stored outcome.
 */
export function assertSameAdmission(existing: AdmissionRecord, request: AdmitRequest, intentHash: string): void {
  if (existing.kind !== request.kind) {
    throw new TaviError("CONFLICT", `Operation key ${request.operationKey} was admitted as "${existing.kind}", not "${request.kind}"`, {
      details: { taskId: existing.taskId, admissionId: existing.admissionId },
    });
  }
  if (existing.intentHash !== intentHash) {
    throw new TaviError("CONFLICT", `Operation key ${request.operationKey} was already admitted with different content`, {
      details: { taskId: existing.taskId, admissionId: existing.admissionId },
    });
  }
}

/** Persist an admission outcome and the task projection in one transaction. */
export function commitAdmission(
  store: StoreContext,
  input: {
    readonly admissionId: string;
    readonly taskId: string;
    readonly state: AdmissionState;
    readonly result: AdmissionOutcome;
    readonly checkpointNamespace?: string;
  },
): void {
  assertBoundedPayload(input.result, "admission result");
  store.transaction(() => {
    if (input.checkpointNamespace !== undefined)
      stmt(store.handle, "UPDATE tavi_tasks SET checkpoint_namespace = ?, updated_at = ? WHERE task_id = ?").run(
        input.checkpointNamespace,
        nowTimestamp(),
        input.taskId,
      );
    stmt(store.handle, "UPDATE tavi_admissions SET result = ?, state = ?, updated_at = ? WHERE admission_id = ?").run(
      JSON.stringify(input.result),
      input.state,
      nowTimestamp(),
      input.admissionId,
    );
    // A refusal decided nothing about the task, so it must not project a
    // status onto it — `ports/tasks.ts`'s `refused` state promises exactly that, and
    // a merely suspended task marked `failed` is destructive (the same defect
    // `reportAdmitFailure` was fixed for). Nor is a cancelled task's status
    // overwritten: cancellation is authoritative, and the admission refused on
    // a cancelled task (its `failed`/`CANCELLED` outcome) must not turn it into
    // a failure.
    const current = stmt(store.handle, "SELECT status FROM tavi_tasks WHERE task_id = ?").get(input.taskId) as
      | { status: string }
      | undefined;
    if (input.state !== "refused" && current?.status !== "cancelled") {
      updateTaskStatus(
        store,
        input.taskId,
        input.result.status === "waiting" ? "waiting" : input.result.status,
        input.result.status === "completed" ? input.result.finalText : null,
      );
    }
  });
}

export function listAdmissions(store: StoreContext, taskId: string): readonly AdmissionRecord[] {
  // Creation order, with the rowid breaking a tie: two admissions of one task
  // can share a millisecond, and "the latest admission with an outcome" is how
  // the pending approval round is found (`pendingRoundOf`).
  const rows = stmt(store.handle, "SELECT * FROM tavi_admissions WHERE task_id = ? ORDER BY created_at, rowid").all(
    taskId,
  ) as AdmissionRow[];
  return rows.map(toAdmissionRecord);
}

/**
 * Admissions left `claimed` with no outcome, across every task, newest first
 * — at most `limit` — each with its task's latest execution. The projection
 * `doctor` reports stranded turns from: no admission payload is read, and it
 * is served by `tavi_admissions_state_idx` and the executions' primary key.
 */
export function listClaimedAdmissions(store: StoreContext, limit: number): readonly ClaimedAdmission[] {
  assertPositiveLimit(limit, "listClaimedAdmissions");
  const rows = stmt(
    store.handle,
    `SELECT a.admission_id, a.task_id, a.operation_key, a.kind, a.created_at, a.updated_at,
              e.generation, e.owner_session, e.admission_id AS execution_admission_id,
              e.state AS execution_state, e.lease_expires_at
         FROM tavi_admissions a
         LEFT JOIN tavi_executions e
           ON e.task_id = a.task_id
          AND e.generation = (SELECT MAX(generation) FROM tavi_executions WHERE task_id = a.task_id)
        WHERE a.state = 'claimed' AND a.result IS NULL
        ORDER BY a.created_at DESC, a.rowid DESC
        LIMIT ?`,
  ).all(limit) as {
    admission_id: string;
    task_id: string;
    operation_key: string;
    kind: string;
    created_at: string;
    updated_at: string;
    generation: number | null;
    owner_session: string | null;
    execution_admission_id: string | null;
    execution_state: string | null;
    lease_expires_at: string | null;
  }[];
  return rows.map((row) => ({
    admissionId: row.admission_id,
    taskId: row.task_id,
    operationKey: row.operation_key,
    kind: row.kind as AdmissionKind,
    createdAt: row.created_at,
    claimedAt: row.updated_at,
    execution:
      row.generation === null ||
      row.owner_session === null ||
      row.execution_admission_id === null ||
      row.execution_state === null ||
      row.lease_expires_at === null
        ? null
        : {
            generation: row.generation,
            ownerSession: row.owner_session,
            admissionId: row.execution_admission_id,
            state: row.execution_state as ExecutionState,
            leaseExpiresAt: row.lease_expires_at,
          },
  }));
}

/** Whether an admission of the task is claimed with no result yet: a turn runs now — one indexed read. */
export function hasRunningAdmission(store: StoreContext, taskId: string): boolean {
  return (
    stmt(store.handle, "SELECT 1 FROM tavi_admissions WHERE task_id = ? AND state = 'claimed' AND result IS NULL LIMIT 1").get(taskId) !==
    undefined
  );
}

/** The newest admission in `listAdmissions` order, whatever its state — one row. */
export function latestAdmission(store: StoreContext, taskId: string): AdmissionRecord | undefined {
  const row = stmt(store.handle, "SELECT * FROM tavi_admissions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(
    taskId,
  ) as AdmissionRow | undefined;
  return row === undefined ? undefined : toAdmissionRecord(row);
}

/** The latest admission with an outcome, not refused, in creation order — one row. */
export function latestSettledAdmission(store: StoreContext, taskId: string): AdmissionRecord | undefined {
  const row = stmt(
    store.handle,
    "SELECT * FROM tavi_admissions WHERE task_id = ? AND result IS NOT NULL AND state <> 'refused' " +
      "ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(taskId) as AdmissionRow | undefined;
  return row === undefined ? undefined : toAdmissionRecord(row);
}

export function getAdmission(store: StoreContext, taskId: string, operationKey: string): AdmissionRecord | undefined {
  const row = stmt(store.handle, "SELECT * FROM tavi_admissions WHERE task_id = ? AND operation_key = ?").get(taskId, operationKey) as
    | AdmissionRow
    | undefined;
  return row === undefined ? undefined : toAdmissionRecord(row);
}
