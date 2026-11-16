import { assertPositiveLimit } from "../values.js";
import type { ExecutionRepositoryPort } from "../internal-contracts.js";
import {
  EXECUTION_BUSY,
  EXECUTION_SUPERSEDED,
  TaviError,
  type ExecutionLease,
  type ExecutionRecord,
  type ExecutionState,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";

interface ExecutionRow {
  task_id: string;
  generation: number;
  owner_session: string;
  admission_id: string;
  state: string;
  started_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  ended_at: string | null;
  terminated_reason: string | null;
  terminated_by: string | null;
}

/**
 * Execution ownership.
 *
 * One invocation slot per task, expressed as a monotonically increasing
 * generation. The rules encoded here are deliberately conservative:
 *
 *  - a live slot held by another session refuses acquisition;
 *  - an **expired** slot also refuses, because an expired lease cannot tell a
 *    dead process from a slow one — it signals investigation, not permission to
 *    overlap;
 *  - only an explicit `terminate` clears a slot, and it records who was
 *    terminated so the decision is auditable;
 *  - a callback from a superseded generation is refused at the boundary.
 */
export class SqliteExecutionRepository implements ExecutionRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  acquire(input: {
    readonly taskId: string;
    readonly ownerSession: string;
    readonly admissionId: string;
    readonly leaseMs: number;
    readonly now: () => string;
  }): ExecutionLease {
    return this.#store.transaction(() => {
      const existing = this.#active(input.taskId);
      if (existing !== undefined) {
        if (existing.ownerSession === input.ownerSession) {
          // Re-entrant for the same owner: refresh the lease rather than
          // starting a second generation.
          const expiresAt = addMs(input.now(), input.leaseMs);
          this.#store.handle
            .prepare(
              "UPDATE tavi_executions SET heartbeat_at = ?, lease_expires_at = ?, admission_id = ? WHERE task_id = ? AND generation = ?",
            )
            .run(input.now(), expiresAt, input.admissionId, input.taskId, existing.generation);
          return {
            taskId: input.taskId,
            generation: existing.generation,
            ownerSession: input.ownerSession,
            leaseExpiresAt: expiresAt,
          };
        }
        const expired = Date.parse(existing.leaseExpiresAt) <= Date.parse(input.now());
        throw new TaviError(
          "CONFLICT",
          expired
            ? `Task ${input.taskId} has an expired execution lease held by ${existing.ownerSession} ` +
                "(generation " +
                existing.generation +
                "). An expired lease signals investigation, not permission to overlap: confirm the " +
                "invocation and its process have terminated, then terminate the generation explicitly."
            : `Task ${input.taskId} is already executing under ${existing.ownerSession} ` +
                `(generation ${existing.generation}, lease until ${existing.leaseExpiresAt})`,
          {
            details: {
              reason: EXECUTION_BUSY,
              taskId: input.taskId,
              generation: existing.generation,
              ownerSession: existing.ownerSession,
              leaseExpiresAt: existing.leaseExpiresAt,
              expired,
            },
          },
        );
      }

      const generation = this.#highestGeneration(input.taskId) + 1;
      const now = input.now();
      const expiresAt = addMs(now, input.leaseMs);
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_executions
             (task_id, generation, owner_session, admission_id, state, started_at, heartbeat_at, lease_expires_at, ended_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
        )
        .run(input.taskId, generation, input.ownerSession, input.admissionId, now, now, expiresAt);
      return {
        taskId: input.taskId,
        generation,
        ownerSession: input.ownerSession,
        leaseExpiresAt: expiresAt,
      };
    });
  }

  heartbeat(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly ownerSession: string;
    readonly leaseMs: number;
    readonly now: () => string;
  }): void {
    this.assertCurrentGeneration(input.taskId, input.generation, input.ownerSession);
    this.#store.handle
      .prepare("UPDATE tavi_executions SET heartbeat_at = ?, lease_expires_at = ? WHERE task_id = ? AND generation = ?")
      .run(input.now(), addMs(input.now(), input.leaseMs), input.taskId, input.generation);
  }

  release(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly ownerSession: string;
    readonly now: () => string;
  }): void {
    this.#store.handle
      .prepare(
        "UPDATE tavi_executions SET state = 'released', ended_at = ? WHERE task_id = ? AND generation = ? AND owner_session = ? AND state = 'active'",
      )
      .run(input.now(), input.taskId, input.generation, input.ownerSession);
  }

  terminate(input: {
    readonly taskId: string;
    readonly generation: number;
    readonly confirmedTerminated: boolean;
    readonly reason: string;
    readonly terminatedBy: string;
    readonly now: () => string;
  }): void {
    if (input.confirmedTerminated !== true) {
      throw new TaviError(
        "INVALID_INPUT",
        "terminate requires confirmedTerminated: true — an expired lease is not evidence that the invocation stopped",
      );
    }
    if (input.reason.trim() === "" || input.terminatedBy.trim() === "") {
      throw new TaviError("INVALID_INPUT", "terminate requires a reason and an operator identity");
    }
    this.#store.transaction(() => {
      const row = this.#byGeneration(input.taskId, input.generation);
      if (row === undefined) {
        throw new TaviError("NOT_FOUND", `No execution ${input.generation} for task ${input.taskId}`);
      }
      this.#store.handle
        .prepare(
          `UPDATE tavi_executions
             SET state = 'terminated', ended_at = ?, terminated_reason = ?, terminated_by = ?
           WHERE task_id = ? AND generation = ?`,
        )
        .run(input.now(), input.reason, input.terminatedBy, input.taskId, input.generation);
    });
  }

  /**
   * Slots whose lease has expired.
   *
   * Reported so an operator can investigate and decide; listing is deliberately
   * not the same as reclaiming.
   */
  listExpiredLeases(now: string, limit: number): readonly ExecutionRecord[] {
    assertPositiveLimit(limit, "listExpiredLeases");
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_executions WHERE state = 'active' AND lease_expires_at <= ? ORDER BY lease_expires_at LIMIT ?")
      .all(now, limit) as ExecutionRow[];
    return rows.map(toExecutionRecord);
  }

  current(taskId: string): ExecutionRecord | undefined {
    const record = this.#active(taskId);
    if (record !== undefined) return record;
    const rows = this.list(taskId);
    return rows.at(-1);
  }

  list(taskId: string): readonly ExecutionRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_executions WHERE task_id = ? ORDER BY generation")
      .all(taskId) as ExecutionRow[];
    return rows.map(toExecutionRecord);
  }

  assertCurrentGeneration(taskId: string, generation: number, ownerSession: string): void {
    const row = this.#byGeneration(taskId, generation);
    if (row === undefined) {
      throw new TaviError("CONFLICT", `Execution ${generation} for task ${taskId} does not exist`, {
        details: { reason: EXECUTION_SUPERSEDED },
      });
    }
    if (row.owner_session !== ownerSession) {
      throw new TaviError("CONFLICT", `Execution ${generation} for task ${taskId} is owned by ${row.owner_session}, not ${ownerSession}`, {
        details: { reason: EXECUTION_SUPERSEDED },
      });
    }
    if (row.state !== "active") {
      throw new TaviError("CONFLICT", `Execution ${generation} for task ${taskId} is ${row.state}; a superseded generation may not write`, {
        details: { reason: EXECUTION_SUPERSEDED },
      });
    }
    const highest = this.#highestGeneration(taskId);
    if (generation !== highest) {
      throw new TaviError("CONFLICT", `Execution ${generation} for task ${taskId} was superseded by generation ${highest}`, {
        details: { reason: EXECUTION_SUPERSEDED },
      });
    }
  }

  #active(taskId: string): ExecutionRecord | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_executions WHERE task_id = ? AND state = 'active' ORDER BY generation DESC LIMIT 1")
      .get(taskId) as ExecutionRow | undefined;
    return row === undefined ? undefined : toExecutionRecord(row);
  }

  #byGeneration(taskId: string, generation: number): ExecutionRow | undefined {
    return this.#store.handle.prepare("SELECT * FROM tavi_executions WHERE task_id = ? AND generation = ?").get(taskId, generation) as
      | ExecutionRow
      | undefined;
  }

  #highestGeneration(taskId: string): number {
    const row = this.#store.handle.prepare("SELECT MAX(generation) AS generation FROM tavi_executions WHERE task_id = ?").get(taskId) as
      | { generation: number | null }
      | undefined;
    return row?.generation ?? 0;
  }
}

function toExecutionRecord(row: ExecutionRow): ExecutionRecord {
  return {
    taskId: row.task_id,
    generation: row.generation,
    ownerSession: row.owner_session,
    admissionId: row.admission_id,
    state: row.state as ExecutionState,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    endedAt: row.ended_at,
    terminatedReason: row.terminated_reason,
    terminatedBy: row.terminated_by,
  };
}

/** Add milliseconds to an ISO instant, used for lease deadlines. */
function addMs(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}
