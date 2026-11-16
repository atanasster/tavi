import { assertPositiveLimit } from "../values.js";
import type { CancellationRepositoryPort } from "../internal-contracts.js";
import { TaviError, type CancellationRecord } from "@tavi/contracts";
import type { StoreContext } from "./context.js";

/**
 * Durable cancellations.
 *
 * Cancellation outlives the invocation that observed it, so a reply arriving
 * after restart still cannot revive the work.
 */
export class SqliteCancellationRepository implements CancellationRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  request(input: {
    readonly taskId: string;
    readonly requestedBy: string;
    readonly reason: string;
    readonly now: () => string;
  }): CancellationRecord {
    if (input.reason.trim() === "" || input.requestedBy.trim() === "") {
      throw new TaviError("INVALID_INPUT", "a cancellation requires a requester and a reason");
    }
    return this.#store.transaction(() => {
      const existing = this.get(input.taskId);
      // Cancellation is idempotent: the first request is authoritative.
      if (existing !== undefined) return existing;
      const record: CancellationRecord = {
        taskId: input.taskId,
        requestedBy: input.requestedBy,
        reason: input.reason,
        requestedAt: input.now(),
      };
      this.#store.handle
        .prepare("INSERT INTO tavi_cancellations (task_id, requested_by, reason, requested_at) VALUES (?, ?, ?, ?)")
        .run(record.taskId, record.requestedBy, record.reason, record.requestedAt);
      return record;
    });
  }

  get(taskId: string): CancellationRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_cancellations WHERE task_id = ?").get(taskId) as
      | { task_id: string; requested_by: string; reason: string; requested_at: string }
      | undefined;
    if (row === undefined) return undefined;
    return {
      taskId: row.task_id,
      requestedBy: row.requested_by,
      reason: row.reason,
      requestedAt: row.requested_at,
    };
  }

  list(limit: number): readonly CancellationRecord[] {
    assertPositiveLimit(limit, "list");
    const rows = this.#store.handle.prepare("SELECT * FROM tavi_cancellations ORDER BY requested_at LIMIT ?").all(limit) as {
      task_id: string;
      requested_by: string;
      reason: string;
      requested_at: string;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      requestedBy: row.requested_by,
      reason: row.reason,
      requestedAt: row.requested_at,
    }));
  }
}
