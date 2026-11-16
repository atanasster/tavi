import { assertPositiveLimit } from "../values.js";
import type { CheckpointReceiptRepositoryPort } from "../internal-contracts.js";
import type { CheckpointReceipt } from "@tavi/contracts";
import type { StoreContext } from "./context.js";

interface ReceiptRow {
  receipt_id: string;
  task_id: string;
  thread_id: string;
  checkpoint_namespace: string;
  checkpoint_id: string;
  admission_id: string | null;
  source: string;
  recorded_at: string;
}

/**
 * Checkpoint receipts.
 *
 * The saver owns progress; the application records that it observed a specific
 * checkpoint. The unique key makes recording idempotent, which is what lets a
 * restart reconcile a checkpoint the application never saw without duplicating a
 * receipt or reinjecting input.
 */
export class SqliteCheckpointReceiptRepository implements CheckpointReceiptRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  record(input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly checkpointNamespace: string;
    readonly checkpointId: string;
    readonly admissionId: string | null;
    readonly source: "admission" | "reconcile";
    readonly now: () => string;
  }): CheckpointReceipt {
    return this.#store.transaction(() => {
      const existing = this.#byCheckpoint(input.threadId, input.checkpointNamespace, input.checkpointId);
      if (existing !== undefined) return existing;

      const record: CheckpointReceipt = {
        taskId: input.taskId,
        threadId: input.threadId,
        checkpointNamespace: input.checkpointNamespace,
        checkpointId: input.checkpointId,
        admissionId: input.admissionId,
        source: input.source,
        recordedAt: input.now(),
      };
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_checkpoint_receipts
             (receipt_id, task_id, thread_id, checkpoint_namespace, checkpoint_id, admission_id, source, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${input.threadId}:${input.checkpointNamespace}:${input.checkpointId}`,
          record.taskId,
          record.threadId,
          record.checkpointNamespace,
          record.checkpointId,
          record.admissionId,
          record.source,
          record.recordedAt,
        );
      return record;
    });
  }

  latestForTask(taskId: string): CheckpointReceipt | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_checkpoint_receipts WHERE task_id = ? ORDER BY recorded_at DESC LIMIT 1")
      .get(taskId) as ReceiptRow | undefined;
    return row === undefined ? undefined : toReceipt(row);
  }

  listForTask(taskId: string): readonly CheckpointReceipt[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_checkpoint_receipts WHERE task_id = ? ORDER BY recorded_at")
      .all(taskId) as ReceiptRow[];
    return rows.map(toReceipt);
  }

  list(limit: number): readonly CheckpointReceipt[] {
    assertPositiveLimit(limit, "list");
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_checkpoint_receipts ORDER BY recorded_at DESC LIMIT ?")
      .all(limit) as ReceiptRow[];
    return rows.map(toReceipt);
  }

  #byCheckpoint(threadId: string, checkpointNamespace: string, checkpointId: string): CheckpointReceipt | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_checkpoint_receipts WHERE thread_id = ? AND checkpoint_namespace = ? AND checkpoint_id = ?")
      .get(threadId, checkpointNamespace, checkpointId) as ReceiptRow | undefined;
    return row === undefined ? undefined : toReceipt(row);
  }
}

function toReceipt(row: ReceiptRow): CheckpointReceipt {
  return {
    taskId: row.task_id,
    threadId: row.thread_id,
    checkpointNamespace: row.checkpoint_namespace,
    checkpointId: row.checkpoint_id,
    admissionId: row.admission_id,
    source: row.source as "admission" | "reconcile",
    recordedAt: row.recorded_at,
  };
}
