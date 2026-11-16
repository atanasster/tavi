import { assertPositiveLimit } from "../values.js";
import { z } from "zod";
import {
  TaskOriginSchema,
  TASK_SUMMARY_STATES,
  TASK_STATUSES,
  CHAT_KINDS,
  CHAT_MEMORY_MODES,
  type TaskStatus,
  type TaskRecord,
  TaskExecutionPolicySchema,
  DEFAULT_TASK_POLICY,
  type TaskExecutionPolicy,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import type { StoreContext } from "./context.js";
import { parseOptionalEnum, parseRequiredEnum } from "./stored-values.js";
import { stmt } from "../statement-cache.js";

export interface TaskRow {
  task_id: string;
  workspace_id: string;
  principal_id: string;
  thread_id: string;
  checkpoint_namespace: string;
  status: string;
  final_text: string | null;
  operation_key: string | null;
  created_at: string;
  updated_at: string;
  origin: string | null;
  origin_schedule_id: string | null;
  execution_policy_json: string | null;
  /** What chat this task is; one Home per person. */
  chat_kind: string | null;
  parent_chat_id: string | null;
  /** Whether the chat's memory is off or private. */
  memory_mode: string | null;
  memory_on_at: string | null;
  /** Generated titles and summaries. */
  title: string | null;
  /** The reader's rename, shown before the generated title. */
  title_override: string | null;
  summary: string | null;
  summary_state: string | null;
}

export function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    threadId: row.thread_id,
    checkpointNamespace: row.checkpoint_namespace,
    // Validated, not cast: the column has no CHECK constraint.
    status: parseRequiredEnum(z.enum(TASK_STATUSES), row.status, "task status"),
    finalText: row.final_text,
    creationOperationKey: row.operation_key,
    // Validated, not cast: a restored or hand-edited row with an unknown origin
    // would otherwise become a well-typed lie that slips past every
    // `=== "schedule"` check the approval path makes.
    origin: parseOptionalEnum(TaskOriginSchema, row.origin, "task origin"),
    originScheduleId: row.origin_schedule_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The reader's rename first; blank is "none yet", as `tasks list` reads it.
    // A Home is called Home unless the reader renamed it.
    title:
      typeof row.title_override === "string" && row.title_override.trim() !== ""
        ? row.title_override
        : row.chat_kind === "home"
          ? "Home"
          : typeof row.title === "string" && row.title.trim() !== ""
            ? row.title
            : null,
    ...(typeof row.title_override === "string" && row.title_override.trim() !== "" ? { titleRenamed: true } : {}),
    summary: typeof row.summary === "string" && row.summary.trim() !== "" ? row.summary : null,
    summaryState: parseOptionalEnum(z.enum(TASK_SUMMARY_STATES), row.summary_state, "task summary state"),
    // Validated on the way out, never cast: an unknown mode or a malformed
    // policy would become a well-typed lie that decides whether a question is
    // delivered. A row with no column value reads as the conservative
    // unattended policy.
    executionPolicy: readExecutionPolicy(row),
    ...(row.chat_kind === null ? {} : { chatKind: parseRequiredEnum(z.enum(CHAT_KINDS), row.chat_kind, "task chat kind") }),
    ...(row.parent_chat_id === null ? {} : { parentChatId: row.parent_chat_id }),
    ...(row.memory_mode === null ? {} : { memoryMode: parseRequiredEnum(z.enum(CHAT_MEMORY_MODES), row.memory_mode, "task memory mode") }),
    ...(row.memory_on_at === null ? {} : { memoryOnAt: row.memory_on_at }),
  };
}

/**
 * A task's policy, resolved fail-closed.
 *
 * A row that is absent, unparseable or self-contradictory becomes the
 * conservative unattended policy rather than an error. That is deliberate and
 * bounded: `listTasks` maps *every* row through this mapper and is used by
 * startup reconciliation and the report surfaces, so throwing here would let one
 * hand-edited or restored row take down every task listing — the blast radius
 * `partitionReadable` exists to prevent elsewhere. The resolution is also the
 * safe one: the worst outcome of reading a corrupt policy as unattended is a
 * question that is not asked, while the worst outcome of reading it as attended
 * is a message delivered to nobody.
 *
 * Corruption cannot arrive through a supported write: `admit` validates the
 * policy it stores (see there), so only a hand-edit or a restored backup reaches
 * this branch. Nothing reports it either: this function is the row's only
 * reader and it degrades rather than throwing, so a corrupt policy is
 * indistinguishable from a stored unattended one and the symptom is a task that
 * stops asking questions. `tavi tasks` still answers — with the conservative
 * policy.
 */
function readExecutionPolicy(row: TaskRow): TaskExecutionPolicy {
  if (row.execution_policy_json === null) return DEFAULT_TASK_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.execution_policy_json) as unknown;
  } catch {
    return DEFAULT_TASK_POLICY;
  }
  const policy = TaskExecutionPolicySchema.safeParse(parsed);
  return policy.success ? policy.data : DEFAULT_TASK_POLICY;
}

export function listTasks(store: StoreContext, limit: number): readonly TaskRecord[] {
  assertPositiveLimit(limit, "listTasks");
  const rows = stmt(store.handle, "SELECT * FROM tavi_tasks ORDER BY created_at DESC LIMIT ?").all(limit) as TaskRow[];
  return rows.map(toTaskRecord);
}

export function getTask(store: StoreContext, taskId: string): TaskRecord | undefined {
  const row = stmt(store.handle, "SELECT * FROM tavi_tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
  return row === undefined ? undefined : toTaskRecord(row);
}

export function updateTaskStatus(store: StoreContext, taskId: string, status: TaskStatus, finalText: string | null): void {
  stmt(store.handle, "UPDATE tavi_tasks SET status = ?, final_text = ?, updated_at = ? WHERE task_id = ?").run(
    status,
    finalText,
    nowTimestamp(),
    taskId,
  );
}
