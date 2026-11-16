import {
  TaviError,
  type TaskRecord,
  TaskPromptSnapshotRecordSchema,
  BoundTaskPromptSnapshotSchema,
  type BoundTaskPromptSnapshot,
  type TaskPromptSnapshotRecord,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { StoreContext } from "./context.js";
import { parseStoredRow } from "./stored-values.js";
import { assertHashMatchesText } from "./system-prompts.js";

interface TaskPromptSnapshotRow {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly source: string;
  readonly text: string | null;
  readonly hash: string | null;
  readonly settings_revision: number | null;
  readonly template_version: string | null;
  readonly bound_at: string;
}

/**
 * Read and validate one task's prompt snapshot.
 *
 * Two outcomes, and the caller must not conflate them: a bound record, and
 * `undefined` for a task with no row at all — which is corruption, never a
 * fallback to the shipped default.
 *
 * Two failures are deliberately loud: a row that does not parse, and a bound row
 * whose hash is not the hash of its own text. Running a task on a base it did
 * not select is worse than failing the turn.
 */
export function readTaskPromptSnapshot(store: StoreContext, taskId: string): TaskPromptSnapshotRecord | undefined {
  const row = store.handle.prepare("SELECT * FROM tavi_task_prompt_snapshots WHERE task_id = ?").get(taskId) as
    | TaskPromptSnapshotRow
    | undefined;
  if (row === undefined) return undefined;
  const record = parseStoredRow(
    TaskPromptSnapshotRecordSchema,
    {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      source: row.source,
      text: row.text,
      hash: row.hash,
      revision: row.settings_revision,
      templateVersion: row.template_version,
      boundAt: row.bound_at,
    },
    `task prompt snapshot for task ${taskId}`,
  );
  assertHashMatchesText(record.text, record.hash, `Stored task prompt snapshot for task ${taskId}`);
  return record;
}

/** The bases a task re-pins per turn; see `#pinnedPrompt`. */
export const REPINNED_PROMPT_SOURCES: ReadonlySet<string> = new Set(["workspace", "builtin"]);

interface TaskPromptPinRow {
  readonly pin: number;
  readonly source: string;
  readonly text: string;
  readonly hash: string;
  readonly settings_revision: number | null;
  readonly template_version: string | null;
  readonly bound_at: string;
}

/** A pin row as the snapshot it is, validated as `readTaskPromptSnapshot` validates the task's own. */
function promptPinSnapshot(row: TaskPromptPinRow, taskId: string, workspaceId: string): TaskPromptSnapshotRecord {
  const record = parseStoredRow(
    TaskPromptSnapshotRecordSchema,
    {
      taskId,
      workspaceId,
      source: row.source,
      text: row.text,
      hash: row.hash,
      revision: row.settings_revision,
      templateVersion: row.template_version,
      boundAt: row.bound_at,
    },
    `prompt pin ${row.pin} of task ${taskId}`,
  );
  assertHashMatchesText(record.text, record.hash, `Stored prompt pin ${row.pin} of task ${taskId}`);
  return record;
}

/** The task's newest pin, if it has one. */
export function latestTaskPromptPin(
  store: StoreContext,
  task: TaskRecord,
): { readonly pin: number; readonly snapshot: TaskPromptSnapshotRecord } | undefined {
  const row = store.handle.prepare("SELECT * FROM tavi_task_prompt_pins WHERE task_id = ? ORDER BY pin DESC LIMIT 1").get(task.taskId) as
    | TaskPromptPinRow
    | undefined;
  return row === undefined ? undefined : { pin: row.pin, snapshot: promptPinSnapshot(row, task.taskId, task.workspaceId) };
}

/** The base an admission pinned, or undefined when it pinned none. */
export function readAdmissionPromptPin(store: StoreContext, taskId: string, admissionId: string): TaskPromptSnapshotRecord | undefined {
  const row = store.handle
    .prepare(`SELECT p.*, t.workspace_id FROM tavi_admissions a
      JOIN tavi_task_prompt_pins p ON p.task_id = a.task_id AND p.pin = a.prompt_pin
      JOIN tavi_tasks t ON t.task_id = a.task_id
      WHERE a.admission_id = ? AND a.task_id = ?`)
    .get(admissionId, taskId) as (TaskPromptPinRow & { readonly workspace_id: string }) | undefined;
  return row === undefined ? undefined : promptPinSnapshot(row, taskId, row.workspace_id);
}

/**
 * Validate a candidate snapshot and that it is bound to the task and workspace
 * it claims, without echoing the text.
 */
export function assertBoundTaskPromptSnapshot(value: unknown, taskId: string, workspaceId: string): BoundTaskPromptSnapshot {
  const parsed = BoundTaskPromptSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "The task prompt snapshot is not valid and was not written", {
      details: {
        taskId,
        source: (value as { readonly source?: unknown } | null)?.source ?? null,
        reason: parsed.error.issues[0]?.message ?? "invalid",
      },
    });
  }
  const bound = parsed.data;
  if (bound.taskId !== taskId || bound.workspaceId !== workspaceId) {
    throw new TaviError("INVALID_INPUT", "The task prompt snapshot is bound to another task or workspace and was not written", {
      details: { taskId, workspaceId, returnedTaskId: bound.taskId, returnedWorkspaceId: bound.workspaceId },
    });
  }
  if (sha256Hex(bound.text) !== bound.hash) {
    throw new TaviError("INVALID_INPUT", "The task prompt snapshot hash does not match its text and was not written", {
      details: { taskId: bound.taskId, source: bound.source },
    });
  }
  return bound;
}

/** Whether two bound snapshots describe the same selection, for idempotent re-insertion. */
export function sameBoundSnapshot(left: TaskPromptSnapshotRecord, right: BoundTaskPromptSnapshot): boolean {
  return (
    left.source === right.source &&
    left.text === right.text &&
    left.hash === right.hash &&
    left.revision === right.revision &&
    left.templateVersion === right.templateVersion
  );
}

/**
 * Insert one task's prompt snapshot, returning the persisted record.
 *
 * Validated before the INSERT, without echoing the text (see
 * `assertSystemPromptText`), and against the task it names: a snapshot whose task
 * does not exist, or exists in another workspace, is a caller error rather than
 * a raw foreign-key `SqliteError` out of the store.
 *
 * Re-inserting the identical snapshot is an idempotent retry
 * (the initializer can be replayed); a *different* snapshot for a task that
 * already has one is a typed `CONFLICT`, because the snapshot is immutable.
 */
export function writeTaskPromptSnapshot(store: StoreContext, record: BoundTaskPromptSnapshot): BoundTaskPromptSnapshot {
  const bound = assertBoundTaskPromptSnapshot(record, record.taskId, record.workspaceId);
  const task = store.handle.prepare("SELECT workspace_id FROM tavi_tasks WHERE task_id = ?").get(bound.taskId) as
    | { readonly workspace_id: string }
    | undefined;
  if (task === undefined) {
    throw new TaviError("INVALID_INPUT", "A task prompt snapshot needs its task to exist and was not written", {
      details: { taskId: bound.taskId },
    });
  }
  if (task.workspace_id !== bound.workspaceId) {
    throw new TaviError("INVALID_INPUT", "A task prompt snapshot must be in its task's workspace and was not written", {
      details: { taskId: bound.taskId, workspaceId: bound.workspaceId, taskWorkspaceId: task.workspace_id },
    });
  }
  const inserted = store.handle
    .prepare(
      `INSERT INTO tavi_task_prompt_snapshots
         (task_id, workspace_id, source, text, hash, settings_revision, template_version, bound_at)
       VALUES (@taskId, @workspaceId, @source, @text, @hash, @revision, @templateVersion, @boundAt)
       ON CONFLICT (task_id) DO NOTHING`,
    )
    .run({
      taskId: bound.taskId,
      workspaceId: bound.workspaceId,
      source: bound.source,
      text: bound.text,
      hash: bound.hash,
      revision: bound.revision,
      templateVersion: bound.templateVersion,
      boundAt: bound.boundAt,
    });
  if (inserted.changes > 0) return bound;
  const existing = readTaskPromptSnapshot(store, bound.taskId);
  if (existing === undefined) {
    throw new TaviError("INTERNAL", `Task ${bound.taskId} lost its prompt snapshot immediately after the insert`, {
      details: { taskId: bound.taskId },
    });
  }
  if (!sameBoundSnapshot(existing, bound)) {
    throw new TaviError("CONFLICT", `Task ${bound.taskId} already selected a different prompt base`, {
      details: { taskId: bound.taskId, existingSource: existing.source, attemptedSource: bound.source },
    });
  }
  // Idempotent re-insert: the persisted row is authoritative, including its
  // original `boundAt`, so a retry is indistinguishable from the first write.
  return existing;
}
