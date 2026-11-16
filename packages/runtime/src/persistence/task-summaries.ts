import {
  RecordTaskSummaryInputSchema,
  TASK_SUMMARY_ANSWER_CLIP,
  TASK_SUMMARY_ERROR_CLIP,
  TASK_SUMMARY_FOLLOW_UP_CLIP,
  TASK_SUMMARY_FOLLOW_UP_LIMIT,
  TASK_SUMMARY_PROMPT_CLIP,
  TASK_TITLE_MAX,
  TaviError,
  type RecordTaskSummaryInput,
  type TaskSummaryWork,
  parseOrThrow,
} from "@tavi/contracts";

import type { TaskSummaryRepositoryPort } from "./internal-contracts.js";
import { IS_PLUMBING_TASK } from "./task-list.js";
import type { Database } from "./sqlite-loader.js";

/** A task that is finished: terminal, and (unless cancelled) no admission still running. */
const FINISHED = (t: string) => `${t}.status IN ('completed', 'failed', 'stopped', 'cancelled') AND (${t}.status = 'cancelled'
  OR NOT EXISTS (SELECT 1 FROM tavi_admissions live WHERE live.task_id = ${t}.task_id AND live.state IN ('pending', 'claimed')))`;

interface PendingRow {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly status: "completed" | "failed" | "stopped" | "cancelled";
  readonly updated_at: string;
  readonly final_text: string | null;
  readonly delegated: number;
  readonly heartbeat: number;
  readonly prompt: string | null;
  readonly error: string | null;
  readonly last_text: string | null;
  readonly title: string | null;
  readonly summary_input_hash: string | null;
}

/**
 * Generated task titles and summaries.
 *
 * The queue is `summary_state` itself, kept by two schema triggers
 * (`tavi_tasks_summary_finished`, `tavi_admissions_summary_continued`) so no
 * write path that finishes or continues a task can forget it: a task whose
 * status becomes terminal is `pending`, and a new `start` or `reply` admission
 * on a task that is not cancelled sets it `pending` again. A follow-up turn on a
 * completed task leaves its status `completed` while it runs, so "finished" also
 * means no admission is still `pending` or `claimed` (a cancelled task is
 * finished whatever its admissions say: cancellation is authoritative).
 */
export class SqliteTaskSummaryRepository implements TaskSummaryRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  pending(limit: number, exclude: readonly string[] = []): readonly TaskSummaryWork[] {
    assertLimit(limit);
    const db = this.#db();
    const rows = db
      .prepare(`SELECT t.task_id, t.workspace_id, t.principal_id, t.status, t.updated_at, t.title, t.summary_input_hash,
        substr(t.final_text, 1, ${TASK_SUMMARY_ANSWER_CLIP}) AS final_text,
        EXISTS (SELECT 1 FROM tavi_agent_delegation_admissions d WHERE d.worker_task_id = t.task_id) AS delegated,
        ${IS_PLUMBING_TASK} AS heartbeat,
        (SELECT substr(json_extract(a.intent, '$.prompt'), 1, ${TASK_SUMMARY_PROMPT_CLIP}) FROM tavi_admissions a
          WHERE a.task_id = t.task_id AND a.kind = 'start' ORDER BY a.created_at, a.rowid LIMIT 1) AS prompt,
        (SELECT substr(json_extract(a.result, '$.error.message'), 1, ${TASK_SUMMARY_ERROR_CLIP}) FROM tavi_admissions a
          WHERE a.task_id = t.task_id AND a.result IS NOT NULL ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS error,
        (SELECT substr(json_extract(a.result, '$.finalText'), 1, ${TASK_SUMMARY_ANSWER_CLIP}) FROM tavi_admissions a
          WHERE a.task_id = t.task_id AND a.result IS NOT NULL ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS last_text
      FROM tavi_tasks t
      WHERE t.summary_state = 'pending' AND ${FINISHED("t")} AND t.task_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY t.updated_at, t.task_id LIMIT ?`)
      .all(JSON.stringify(exclude), limit) as PendingRow[];
    const followUps = db.prepare(`SELECT prompt FROM (
        SELECT substr(json_extract(a.intent, '$.prompt'), 1, ${TASK_SUMMARY_FOLLOW_UP_CLIP}) AS prompt, a.created_at, a.rowid AS position
        FROM tavi_admissions a
        WHERE a.task_id = ? AND a.kind = 'reply' AND length(trim(COALESCE(json_extract(a.intent, '$.prompt'), ''))) > 0
        ORDER BY a.created_at DESC, a.rowid DESC LIMIT ${TASK_SUMMARY_FOLLOW_UP_LIMIT}
      ) ORDER BY created_at, position`);
    // The latest generation attempt whatever its state: the connection that
    // saw the task's latest turn. Every connection used is returned as well,
    // so the summarizer can keep a task that touched a local one local.
    const target = db.prepare(`SELECT json_extract(data, '$.connectionId') AS connection_id, json_extract(data, '$.model') AS model
      FROM tavi_provider_attempts WHERE run_id = ? AND purpose = 'generation'
      ORDER BY started_at DESC, call_id DESC LIMIT 1`);
    const used = db.prepare(`SELECT DISTINCT json_extract(data, '$.connectionId') AS connection_id
      FROM tavi_provider_attempts WHERE run_id = ? AND purpose = 'generation'`);
    return rows.map((row) => {
      const latest = target.get(row.task_id) as { connection_id: unknown; model: unknown } | undefined;
      const finalText = row.final_text ?? row.last_text;
      return {
        taskId: row.task_id,
        workspaceId: row.workspace_id,
        principalId: row.principal_id,
        status: row.status,
        updatedAt: row.updated_at,
        delegated: row.delegated === 1,
        ...(row.heartbeat === 1 ? { heartbeat: true } : {}),
        prompt: typeof row.prompt === "string" ? row.prompt : null,
        followUps: (followUps.all(row.task_id) as { prompt: unknown }[]).flatMap((entry) =>
          typeof entry.prompt === "string" ? [entry.prompt] : [],
        ),
        finalText: typeof finalText === "string" && finalText.length > 0 ? finalText : null,
        error: row.status === "completed" || typeof row.error !== "string" ? null : row.error,
        ...(latest !== undefined && typeof latest.connection_id === "string" && typeof latest.model === "string"
          ? { target: { connectionId: latest.connection_id, model: latest.model } }
          : {}),
        usedConnections: (used.all(row.task_id) as { connection_id: unknown }[]).flatMap((entry) =>
          typeof entry.connection_id === "string" ? [entry.connection_id] : [],
        ),
        ...(row.title === null ? {} : { title: row.title }),
        ...(row.summary_input_hash === null ? {} : { inputHash: row.summary_input_hash }),
      };
    });
  }

  rename(input: { readonly taskId: string; readonly title: string | null }): void {
    const title = input.title === null ? null : input.title.trim();
    if (title !== null && (title === "" || title.length > TASK_TITLE_MAX)) {
      throw new TaviError("INVALID_INPUT", `A chat's name is 1 to ${TASK_TITLE_MAX} characters; clear it to use the generated one`);
    }
    if (this.#db().prepare("UPDATE tavi_tasks SET title_override = ? WHERE task_id = ?").run(title, input.taskId).changes === 0) {
      throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
    }
  }

  record(input: RecordTaskSummaryInput): boolean {
    const { taskId, expectedUpdatedAt, state, title, summary, inputHash, unchanged, now } = parseOrThrow(
      RecordTaskSummaryInputSchema,
      input,
      "The task summary is not valid and was not recorded",
    );
    // Only `done` replaces the text; a failed or skipped pass keeps whatever
    // an earlier turn's summary said, and the list falls back to the prompt
    // when there is none. The first title a pass wrote is kept: a chat keeps
    // its name as it goes on, and only its summary follows it. A pass over
    // unchanged words keeps both.
    const written = state === "done" && unchanged !== true;
    const text = written ? ", title = COALESCE(title, @title), summary = @summary, summary_input_hash = @inputHash" : "";
    return (
      this.#db()
        .prepare(`UPDATE tavi_tasks SET summary_state = @state, summarized_at = @now${text}
      WHERE task_id = @taskId AND summary_state = 'pending' AND updated_at = @expectedUpdatedAt AND ${FINISHED("tavi_tasks")}`)
        .run({
          taskId,
          expectedUpdatedAt,
          state,
          now,
          ...(written ? { title: title ?? null, summary: summary ?? null, inputHash: inputHash ?? null } : {}),
        }).changes === 1
    );
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TaviError("INVALID_INPUT", "A task summary batch takes between 1 and 100 tasks");
  }
}
