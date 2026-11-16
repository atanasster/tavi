import { TASK_FINDINGS_MAX, TaviError, type TaskFinding } from "@tavi/contracts";

import type { TaskFindingRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";
import { assertPositiveLimit } from "./values.js";

interface FindingRow {
  readonly task_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly record_json: string;
  readonly source_url: string | null;
  readonly created_at: string;
}

function toFinding(row: FindingRow): TaskFinding {
  let record: unknown;
  try {
    record = JSON.parse(row.record_json) as unknown;
  } catch {
    throw new TaviError("INTERNAL", `Finding ${row.task_id}#${row.seq} is unreadable`);
  }
  return {
    taskId: row.task_id,
    seq: row.seq,
    kind: row.kind,
    record,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    createdAt: row.created_at,
  };
}

/** What the repository needs of the store: its handle, and its transactions. */
export interface TaskFindingStore {
  readonly handle: Database;
  transaction<T>(fn: () => T): T;
}

/**
 * A task's findings: one row per
 * record, numbered within its task, deleted with the task. Bounded per task:
 * past `TASK_FINDINGS_MAX` the oldest go.
 */
export class SqliteTaskFindingRepository implements TaskFindingRepositoryPort {
  readonly #store: TaskFindingStore;

  constructor(store: TaskFindingStore) {
    this.#store = store;
  }

  #db(): Database {
    return this.#store.handle;
  }

  add(input: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly kind: string;
    readonly records: readonly unknown[];
    readonly sourceUrl?: string | undefined;
    readonly createdAt: string;
  }): readonly TaskFinding[] {
    const db = this.#db();
    const owner = db.prepare("SELECT workspace_id FROM tavi_tasks WHERE task_id = ?").get(input.taskId) as
      | { workspace_id: string }
      | undefined;
    if (owner === undefined || owner.workspace_id !== input.workspaceId)
      throw new TaviError("NOT_FOUND", `No task ${input.taskId} in workspace ${input.workspaceId}`);
    return this.#store.transaction(() => {
      const last =
        (db.prepare("SELECT MAX(seq) AS seq FROM tavi_task_findings WHERE task_id = ?").get(input.taskId) as { seq: number | null }).seq ??
        0;
      const insert = db.prepare(
        "INSERT INTO tavi_task_findings (task_id, seq, workspace_id, kind, record_json, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const added: TaskFinding[] = [];
      input.records.forEach((record, index) => {
        const seq = last + index + 1;
        insert.run(input.taskId, seq, input.workspaceId, input.kind, JSON.stringify(record), input.sourceUrl ?? null, input.createdAt);
        added.push({
          taskId: input.taskId,
          seq,
          kind: input.kind,
          record,
          ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
          createdAt: input.createdAt,
        });
      });
      // Bounded per task: the oldest go first.
      db.prepare("DELETE FROM tavi_task_findings WHERE task_id = ? AND seq <= ?").run(
        input.taskId,
        last + input.records.length - TASK_FINDINGS_MAX,
      );
      return added;
    });
  }

  list(input: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly kind?: string | undefined;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  }): readonly TaskFinding[] {
    assertPositiveLimit(input.limit, "findings.list");
    const rows = this.#db()
      .prepare(`SELECT task_id, seq, kind, record_json, source_url, created_at FROM tavi_task_findings
        WHERE task_id = ? AND workspace_id = ? AND seq > ? ${input.kind === undefined ? "" : "AND kind = ?"} ORDER BY seq LIMIT ?`)
      .all(
        ...[input.taskId, input.workspaceId, input.afterSeq ?? 0, ...(input.kind === undefined ? [] : [input.kind]), input.limit],
      ) as FindingRow[];
    return rows.map(toFinding);
  }
}
