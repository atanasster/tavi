import {
  CHAT_FOLDER_RESET_COMMAND,
  ChatFolderRowSchema,
  HOST_WRITE_MARKS_LISTED,
  HOST_WRITE_MARKS_PER_PATH,
  TaviError,
  type ChatFolderRow,
  type HostFileIdentity,
  type WriteChatFolderInput,
} from "@tavi/contracts";

import type { TaskFoldersRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";

interface Row {
  task_id: string;
  workspace_id: string;
  primary_kind: string;
  primary_path: string | null;
  attachments_json: string;
  revision: number;
  updated_at: string;
}

/**
 * A stored row as the contract reads it; one that no longer parses is refused,
 * never read as the defaults — `UNAVAILABLE`, as a folder that is gone is, so
 * `folder show` answers it with Reset as the remedy.
 */
const toFolder = (row: Row): ChatFolderRow => {
  let attachments: unknown;
  try {
    attachments = JSON.parse(row.attachments_json);
  } catch {
    attachments = undefined;
  }
  const parsed = ChatFolderRowSchema.safeParse({
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    primaryKind: row.primary_kind,
    ...(row.primary_path === null ? {} : { primaryPath: row.primary_path }),
    attachments,
    revision: row.revision,
    updatedAt: row.updated_at,
  });
  if (!parsed.success)
    throw new TaviError(
      "UNAVAILABLE",
      `The working folder stored for task ${row.task_id} cannot be read. Run ${CHAT_FOLDER_RESET_COMMAND} to go back to the chat's own folder.`,
      { details: { taskId: row.task_id } },
    );
  return parsed.data;
};

/**
 * Each chat's working folder. Reads are plain;
 * `write` is compare-and-set on the revision the writer read, in an immediate
 * transaction. The paths were validated by `ChatFolders.set`, which alone
 * writes here: this checks only the bounds a row is read back with.
 */
export class SqliteTaskFoldersRepository implements TaskFoldersRepositoryPort {
  readonly #db: () => Database;
  readonly #transaction: <T>(work: () => T) => T;

  constructor(db: () => Database, transaction: <T>(work: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  get(taskId: string): ChatFolderRow | undefined {
    // A taint-only row (revision 0, `markTainted`) is no stored folder: the chat keeps its origin's defaults.
    const row = this.#db().prepare("SELECT * FROM tavi_task_folders WHERE task_id = ? AND revision > 0").get(taskId) as Row | undefined;
    return row === undefined ? undefined : toFolder(row);
  }

  markTainted(input: { readonly taskId: string; readonly workspaceId: string; readonly now: string }): string {
    return this.#transaction(() => {
      const db = this.#db();
      const task = db.prepare("SELECT workspace_id FROM tavi_tasks WHERE task_id = ?").get(input.taskId) as
        | { workspace_id: string }
        | undefined;
      if (task === undefined || task.workspace_id !== input.workspaceId)
        throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
      db.prepare(`INSERT INTO tavi_task_folders (task_id, workspace_id, primary_kind, primary_path, attachments_json, revision, updated_at, tainted_at)
        VALUES (?, ?, 'managed', NULL, '[]', 0, ?, ?)
        ON CONFLICT (task_id) DO UPDATE SET tainted_at = COALESCE(tavi_task_folders.tainted_at, excluded.tainted_at)`).run(
        input.taskId,
        input.workspaceId,
        input.now,
        input.now,
      );
      return (db.prepare("SELECT tainted_at FROM tavi_task_folders WHERE task_id = ?").get(input.taskId) as { tainted_at: string })
        .tainted_at;
    });
  }

  taintedAt(taskId: string): string | undefined {
    return (
      (
        this.#db().prepare("SELECT tainted_at FROM tavi_task_folders WHERE task_id = ?").get(taskId) as
          | { tainted_at: string | null }
          | undefined
      )?.tainted_at ?? undefined
    );
  }

  recordTaintedWrite(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly sha256: string;
    readonly taskId?: string | undefined;
    readonly file?: HostFileIdentity | undefined;
    readonly now: string;
  }): void {
    this.#transaction(() => {
      const db = this.#db();
      db.prepare(`INSERT INTO tavi_tainted_host_writes (path, sha256, dev, ino, workspace_id, task_id, written_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (path, sha256) DO UPDATE SET dev = COALESCE(excluded.dev, dev), ino = COALESCE(excluded.ino, ino),
          workspace_id = excluded.workspace_id, task_id = excluded.task_id, written_at = excluded.written_at`).run(
        input.path,
        input.sha256,
        input.file?.dev ?? null,
        input.file?.ino ?? null,
        input.workspaceId,
        input.taskId ?? null,
        input.now,
      );
      db.prepare(`DELETE FROM tavi_tainted_host_writes WHERE path = @path AND rowid NOT IN (
          SELECT rowid FROM tavi_tainted_host_writes WHERE path = @path ORDER BY written_at DESC, rowid DESC LIMIT @keep)`).run({
        path: input.path,
        keep: HOST_WRITE_MARKS_PER_PATH,
      });
    });
  }

  taintedWriteOf(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly sha256: string;
    readonly file?: HostFileIdentity | undefined;
  }): { readonly taskId?: string } | undefined {
    const row = this.#db()
      .prepare(`SELECT workspace_id, task_id FROM tavi_tainted_host_writes
        WHERE sha256 = @sha256 AND (path = @path OR (dev = @dev AND ino = @ino)) ORDER BY written_at DESC, rowid DESC LIMIT 1`)
      .get({ sha256: input.sha256, path: input.path, dev: input.file?.dev ?? null, ino: input.file?.ino ?? null }) as
      | { workspace_id: string; task_id: string | null }
      | undefined;
    return row === undefined ? undefined : row.task_id === null || row.workspace_id !== input.workspaceId ? {} : { taskId: row.task_id };
  }

  taintedWritesUnder(input: {
    readonly workspaceId: string;
    readonly roots: readonly string[];
  }): readonly { readonly path: string; readonly sha256: string; readonly taskId?: string }[] {
    if (input.roots.length === 0) return [];
    const under = input.roots.map(() => "(path = ? OR substr(path, 1, length(?) + 1) = ? || '/')").join(" OR ");
    const rows = this.#db()
      .prepare(
        `SELECT path, sha256, workspace_id, task_id FROM tavi_tainted_host_writes WHERE ${under} ORDER BY written_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...input.roots.flatMap((root) => [root, root, root]), HOST_WRITE_MARKS_LISTED) as {
      path: string;
      sha256: string;
      workspace_id: string;
      task_id: string | null;
    }[];
    return rows.map((row) => ({
      path: row.path,
      sha256: row.sha256,
      ...(row.task_id === null || row.workspace_id !== input.workspaceId ? {} : { taskId: row.task_id }),
    }));
  }

  revision(taskId: string): number {
    return (
      (this.#db().prepare("SELECT revision FROM tavi_task_folders WHERE task_id = ?").get(taskId) as { revision: number } | undefined)
        ?.revision ?? 0
    );
  }

  write(input: WriteChatFolderInput): ChatFolderRow {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TaviError("INVALID_INPUT", "The revision a save expects is a non-negative integer");
    }
    const next = ChatFolderRowSchema.safeParse({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      primaryKind: input.primaryKind,
      ...(input.primaryPath === undefined ? {} : { primaryPath: input.primaryPath }),
      attachments: input.attachments,
      revision: input.expectedRevision + 1,
      updatedAt: input.now,
    });
    if (!next.success)
      throw new TaviError("INVALID_INPUT", "A chat's working folder is outside its bounds", {
        details: { issues: next.error.issues.slice(0, 5).map((issue) => issue.message) },
      });
    if ((input.primaryKind === "host") !== (input.primaryPath !== undefined)) {
      throw new TaviError("INVALID_INPUT", "A host primary folder names its path, and a managed one names none");
    }
    return this.#transaction(() => {
      const db = this.#db();
      const task = db.prepare("SELECT workspace_id FROM tavi_tasks WHERE task_id = ?").get(input.taskId) as
        | { workspace_id: string }
        | undefined;
      if (task === undefined || task.workspace_id !== input.workspaceId)
        throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
      const current =
        (db.prepare("SELECT revision FROM tavi_task_folders WHERE task_id = ?").get(input.taskId) as { revision: number } | undefined)
          ?.revision ?? 0;
      if (current !== input.expectedRevision) {
        throw new TaviError("CONFLICT", "The chat's working folder changed since it was read", {
          details: { taskId: input.taskId, expectedRevision: input.expectedRevision, currentRevision: current },
        });
      }
      db.prepare(`INSERT INTO tavi_task_folders (task_id, workspace_id, primary_kind, primary_path, attachments_json, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (task_id) DO UPDATE SET primary_kind = excluded.primary_kind, primary_path = excluded.primary_path,
          attachments_json = excluded.attachments_json, revision = excluded.revision, updated_at = excluded.updated_at`).run(
        input.taskId,
        input.workspaceId,
        input.primaryKind,
        input.primaryPath ?? null,
        JSON.stringify(next.data.attachments),
        next.data.revision,
        input.now,
      );
      return next.data;
    });
  }
}
