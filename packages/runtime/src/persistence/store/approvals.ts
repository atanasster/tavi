import { assertPositiveLimit, hashEffectInputs } from "../values.js";
import type { ApprovalRepositoryPort } from "../internal-contracts.js";
import { z } from "zod";
import { TaviError, type ApprovalRecord, APPROVAL_STATES } from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseRequiredEnum } from "./stored-values.js";

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  admission_id: string;
  tool_id: string;
  call_id: string;
  steps: number;
  inputs: string;
  inputs_hash: string;
  state: string;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Durable approvals.
 *
 * The application owns the exact authorized action. A resumed graph rechecks
 * this record before dispatch, so a checkpoint alone never authorizes an effect,
 * and a settled or cancelled request cannot be revived by a late reply.
 */
export class SqliteApprovalRepository implements ApprovalRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

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
  }): ApprovalRecord {
    return this.#store.transaction(() => {
      // An **exact** probe: the same `callId` in another round is another authorization.
      const existing = getRoundApprovalRow(this.#store, input.taskId, input.callId, input.steps);
      if (existing !== undefined) {
        if (existing.inputsHash !== hashEffectInputs(input.inputs)) {
          throw new TaviError("CONFLICT", `Approval for call ${input.callId} already exists with different inputs`);
        }
        return existing;
      }
      const now = input.now();
      const record: ApprovalRecord = {
        approvalId: input.approvalId,
        taskId: input.taskId,
        admissionId: input.admissionId,
        toolId: input.toolId,
        callId: input.callId,
        inputs: input.inputs ?? null,
        steps: input.steps,
        inputsHash: hashEffectInputs(input.inputs),
        state: "pending",
        decidedBy: null,
        decidedAt: null,
        note: null,
        createdAt: now,
        updatedAt: now,
      };
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_approvals
             (approval_id, task_id, admission_id, tool_id, call_id, steps, inputs, inputs_hash, state, decided_by, decided_at, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          record.approvalId,
          record.taskId,
          record.admissionId,
          record.toolId,
          record.callId,
          record.steps,
          JSON.stringify(record.inputs),
          record.inputsHash,
          record.state,
          record.createdAt,
          record.updatedAt,
        );
      return record;
    });
  }

  decide(input: {
    readonly approvalId: string;
    readonly state: "granted" | "denied";
    readonly decidedBy: string;
    readonly note?: string;
    readonly now: () => string;
  }): ApprovalRecord {
    if (input.decidedBy.trim() === "") {
      throw new TaviError("INVALID_INPUT", "an approval decision requires a deciding identity");
    }
    return this.#store.transaction(() => {
      const existing = this.get(input.approvalId);
      if (existing === undefined) {
        throw new TaviError("NOT_FOUND", `Approval ${input.approvalId} does not exist`);
      }
      if (existing.state === "cancelled") {
        // A cancelled request can never be granted, however the reply arrived.
        throw new TaviError("CONFLICT", `Approval ${input.approvalId} was cancelled`);
      }
      if (existing.state !== "pending") {
        // Settled decisions are immutable; a duplicate reply must not flip one.
        if (existing.state !== input.state) {
          throw new TaviError("CONFLICT", `Approval ${input.approvalId} is already ${existing.state}`);
        }
        return existing;
      }
      this.#store.handle
        .prepare("UPDATE tavi_approvals SET state = ?, decided_by = ?, decided_at = ?, note = ?, updated_at = ? WHERE approval_id = ?")
        .run(input.state, input.decidedBy, input.now(), input.note ?? null, input.now(), input.approvalId);
      const updated = this.get(input.approvalId);
      if (updated === undefined) throw new TaviError("INTERNAL", "approval vanished after update");
      return updated;
    });
  }

  /** Cancel every pending approval for a task, without deleting the history. */
  cancelPendingForTask(taskId: string, now: () => string): number {
    return this.#store.transaction(() => {
      const result = this.#store.handle
        .prepare("UPDATE tavi_approvals SET state = 'cancelled', decided_at = ?, updated_at = ? WHERE task_id = ? AND state = 'pending'")
        .run(now(), now(), taskId);
      return result.changes;
    });
  }

  get(approvalId: string): ApprovalRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_approvals WHERE approval_id = ?").get(approvalId) as ApprovalRow | undefined;
    return row === undefined ? undefined : toApprovalRecord(row);
  }

  getForCall(taskId: string, callId: string, steps?: number): ApprovalRecord | undefined {
    // By round: with one, that round's row; without one, the newest.
    if (steps !== undefined) return getRoundApprovalRow(this.#store, taskId, callId, steps);
    const newest = this.#store.handle
      .prepare("SELECT * FROM tavi_approvals WHERE task_id = ? AND call_id = ? ORDER BY steps DESC LIMIT 1")
      .get(taskId, callId) as ApprovalRow | undefined;
    return newest === undefined ? undefined : toApprovalRecord(newest);
  }

  listForTask(taskId: string): readonly ApprovalRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_approvals WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as ApprovalRow[];
    return rows.map(toApprovalRecord);
  }

  listPending(limit: number): readonly ApprovalRecord[] {
    assertPositiveLimit(limit, "listPending");
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_approvals WHERE state = 'pending' ORDER BY created_at LIMIT ?")
      .all(limit) as ApprovalRow[];
    return rows.map(toApprovalRecord);
  }
}

/** The row for exactly this round, or `undefined`. */
function getRoundApprovalRow(store: StoreContext, taskId: string, callId: string, steps: number): ApprovalRecord | undefined {
  const row = store.handle
    .prepare("SELECT * FROM tavi_approvals WHERE task_id = ? AND call_id = ? AND steps = ?")
    .get(taskId, callId, steps) as ApprovalRow | undefined;
  return row === undefined ? undefined : toApprovalRecord(row);
}

function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    admissionId: row.admission_id,
    toolId: row.tool_id,
    callId: row.call_id,
    steps: row.steps,
    inputs: JSON.parse(row.inputs) as unknown,
    inputsHash: row.inputs_hash,
    state: parseRequiredEnum(z.enum(APPROVAL_STATES), row.state, "approval state"),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
