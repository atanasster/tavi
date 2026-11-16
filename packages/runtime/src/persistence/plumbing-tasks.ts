import { deleteHookEventsForTasks } from "./plugin-repository.js";
import type { Database } from "./sqlite-loader.js";

/**
 * Delete plumbing tasks — a heartbeat tick's, an idea's prepared step
 * — and what hangs off them without a cascade:
 * their checkpoints and checkpoint values (by thread), provider attempts, operations and requests,
 * and hook rows. Their other rows cascade from the task. Such tasks have no
 * folder and write no memory or artifact, so nothing is orphaned.
 */
export function purgePlumbingTasks(db: Database, taskIds: readonly string[]): number {
  if (taskIds.length === 0) return 0;
  const ids = JSON.stringify(taskIds);
  const saverTables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkpoints', 'writes')").all() as { name: string }[]
    ).map((row) => row.name),
  );
  // A thread's per-channel checkpoint values (`tavi_checkpoint_blobs`) go with its checkpoints.
  for (const table of [...saverTables, "tavi_checkpoint_blobs"])
    db.prepare(
      `DELETE FROM ${table} WHERE thread_id IN (SELECT thread_id FROM tavi_tasks WHERE task_id IN (SELECT value FROM json_each(?)))`,
    ).run(ids);
  for (const table of ["tavi_provider_attempt_requests", "tavi_provider_operations", "tavi_provider_attempts"])
    db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?))`).run(ids);
  deleteHookEventsForTasks(db, taskIds);
  return db.prepare("DELETE FROM tavi_tasks WHERE task_id IN (SELECT value FROM json_each(?))").run(ids).changes;
}
