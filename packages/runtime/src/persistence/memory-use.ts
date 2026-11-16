import { TASK_MEMORY_USE_MAX, TaviError, type TaskMemoryUse } from "@tavi/contracts";

import type { TaskMemoryUseRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";

interface Row {
  task_id: string;
  record_id: string;
  first_used_at: string;
  last_used_at: string;
  last_admission_id: string;
}

/**
 * The memories each chat's turns were given: one row per chat and record, its
 * first and last use. Written best-effort after a model call; a task's rows go
 * with it.
 */
export class SqliteTaskMemoryUseRepository implements TaskMemoryUseRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  record(input: {
    readonly taskId: string;
    readonly admissionId: string;
    readonly recordIds: readonly string[];
    readonly at: string;
  }): void {
    if (input.recordIds.length === 0) return;
    const db = this.#db();
    const upsert = db.prepare(`INSERT INTO tavi_task_memory_use (task_id, record_id, first_used_at, last_used_at, last_admission_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id, record_id) DO UPDATE SET last_used_at = excluded.last_used_at, last_admission_id = excluded.last_admission_id`);
    db.transaction(() => {
      for (const recordId of new Set(input.recordIds)) upsert.run(input.taskId, recordId, input.at, input.at, input.admissionId);
    })();
  }

  list(taskId: string, limit: number): readonly TaskMemoryUse[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TaviError("INVALID_INPUT", "A memory use limit is a positive integer");
    const rows = this.#db()
      .prepare("SELECT * FROM tavi_task_memory_use WHERE task_id = ? ORDER BY last_used_at DESC, record_id LIMIT ?")
      .all(taskId, Math.min(limit, TASK_MEMORY_USE_MAX)) as Row[];
    return rows.map((row) => ({
      taskId: row.task_id,
      recordId: row.record_id,
      firstUsedAt: row.first_used_at,
      lastUsedAt: row.last_used_at,
      lastAdmissionId: row.last_admission_id,
    }));
  }
}
