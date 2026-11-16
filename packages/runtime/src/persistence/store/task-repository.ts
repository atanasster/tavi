import type { AdmitRequest, TaskRepositoryPort } from "../internal-contracts.js";
import { assertBoundedPayload, assertPositiveLimit } from "../values.js";
import { assertChatInstructionsBound, currentChatInstructionsRevision, insertChatInstructions } from "../chat-instructions.js";
import { TASK_PROMPT_SQL, displayTitleOf } from "../task-list.js";
import {
  TaviError,
  HOME_CHAT_INDEX,
  admissionIdentity,
  type AdmissionRecord,
  type AdmissionState,
  type AdmissionOutcome,
  type AdmitResult,
  type ToolCallActivity,
  type ToolCallActivityQuery,
  assertOriginPairing,
  assertChatPairing,
  type TaskStatus,
  type TaskRecord,
  TaskExecutionPolicySchema,
  DEFAULT_TASK_POLICY,
  type BoundTaskPromptSnapshot,
  type TaskPromptSnapshotRecord,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { deleteIdeasCiting } from "../ideas-repository.js";
import {
  assertSameAdmission,
  commitAdmission,
  getAdmission,
  hasRunningAdmission,
  latestAdmission,
  latestSettledAdmission,
  listAdmissions,
} from "./admissions.js";
import type { StoreContext } from "./context.js";
import { assertWritable } from "./stored-values.js";
import {
  REPINNED_PROMPT_SOURCES,
  assertBoundTaskPromptSnapshot,
  latestTaskPromptPin,
  readAdmissionPromptPin,
  readTaskPromptSnapshot,
  sameBoundSnapshot,
  writeTaskPromptSnapshot,
} from "./task-prompt-snapshots.js";
import { getTask, listTasks, toTaskRecord, updateTaskStatus, type TaskRow } from "./tasks.js";
import { stmt } from "../statement-cache.js";

/**
 * Durable task and admission records.
 *
 * Creation and its admission intent commit together, and the caller operation
 * key makes the pair idempotent: a retry resolves the same task and the same
 * admission rather than creating a second thread. A retry that reuses a key with
 * different content is a conflict — silently re-running it is how a duplicate
 * effect happens.
 */
export class SqliteTaskRepository implements TaskRepositoryPort {
  recordToolCall(taskId: string, steps: number, callId: string, toolId?: string, at?: string): void {
    this.#store.transaction(() => {
      const inserted = stmt(
        this.#store.handle,
        "INSERT OR IGNORE INTO tavi_task_tool_calls(task_id, steps, call_id, tool_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(taskId, steps, callId, toolId ?? null, at ?? null);
      if (inserted.changes > 0) stmt(this.#store.handle, "UPDATE tavi_tasks SET tool_count=tool_count+1 WHERE task_id=?").run(taskId);
    });
  }

  listCallsForTools(input: ToolCallActivityQuery): readonly ToolCallActivity[] {
    assertPositiveLimit(input.limit, "listCallsForTools");
    if (input.toolIds.length === 0) return [];
    // As effects' listForTools: each tool a range on `tavi_task_tool_calls_tool_idx`, the calls the outer loop.
    const params: (string | number)[] = [input.workspaceId, ...input.toolIds];
    const key = "c.task_id || ':' || c.steps || ':' || c.call_id";
    let after = "";
    if (input.before !== undefined) {
      after = ` AND (c.created_at < ? OR (c.created_at = ? AND ${key} < ?))`;
      params.push(input.before.at, input.before.at, input.before.callKey);
    }
    const rows = this.#store.handle
      .prepare(`SELECT ${key} AS call_key, c.task_id, c.tool_id, c.created_at, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt
        FROM tavi_task_tool_calls c CROSS JOIN tavi_tasks t ON t.task_id = c.task_id
        WHERE t.workspace_id = ? AND c.created_at IS NOT NULL AND c.tool_id IN (${input.toolIds.map(() => "?").join(", ")})${after}
        ORDER BY c.created_at DESC, call_key DESC LIMIT ?`)
      .all(...params, input.limit) as {
      call_key: string;
      task_id: string;
      tool_id: string;
      created_at: string;
      generated_title: string | null;
      prompt: string | null;
    }[];
    return rows.map((row) => {
      const taskTitle = displayTitleOf(row.generated_title, row.prompt);
      return {
        callKey: row.call_key,
        taskId: row.task_id,
        toolId: row.tool_id,
        at: row.created_at,
        ...(taskTitle === undefined ? {} : { taskTitle }),
      };
    });
  }
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  admit(request: AdmitRequest): AdmitResult {
    assertOriginPairing(request);
    assertChatPairing(request);
    // `transactionImmediate`, not the deferred default: this method is a
    // read-then-conditionally-write sequence (find the task by operation key,
    // then insert), and it may also read the workspace setting and insert the
    // prompt snapshot. A deferred transaction takes only a read lock on its
    // first `SELECT`, so under WAL a concurrent writer's commit between the read
    // and the write surfaces as a raw snapshot conflict instead of the typed
    // result this method promises (`transactionImmediate`'s own rationale).
    //
    // This applies to *every* admission, not only snapshot-bearing ones: the
    // write lock is taken before the first statement.
    //
    // **Caller obligation:** the immediate lock is taken only while
    // `admit` is the outermost transaction. Nested inside one, the store
    // degrades to a savepoint (one write lock per connection) and the WAL
    // guarantee is the outermost caller's. Every current call site admits at
    // the top level, but nothing enforces that, so a future caller that wraps
    // `admit` in a *deferred* transaction silently gives up the protection
    // rather than receiving an error.
    return this.#store.transactionImmediate(() => {
      assertBoundedPayload(request.intent, "admission intent");
      // The kind is part of the identity, so a `cancel` can never resolve a
      // `start`'s stored outcome.
      const intentHash = admissionIdentity(request.kind, request.intent);

      // A follow-up admission targets an existing task and never creates one.
      if (request.taskId !== undefined) {
        const target = getTask(this.#store, request.taskId);
        // Ownership is derived from the caller's context, never from a supplied
        // id: a follow-up admission may not target another principal's task
        // The two cases are indistinguishable to the caller so an
        // unauthorized id does not confirm the task exists.
        if (target === undefined || target.workspaceId !== request.workspaceId || target.principalId !== request.principalId) {
          throw new TaviError("NOT_FOUND", `Task ${request.taskId} does not exist`);
        }
        const existing = this.getAdmission(target.taskId, request.operationKey);
        if (existing !== undefined) {
          assertSameAdmission(existing, request, intentHash);
          return { task: target, admission: existing, created: false };
        }
        return {
          task: target,
          admission: this.#insertAdmission(request, target, intentHash, this.#pinnedPrompt(target, request)),
          created: true,
        };
      }

      const existingTask = this.#findTaskByOperationKey(request.workspaceId, request.principalId, request.operationKey);

      if (existingTask !== undefined) {
        const existingAdmission = this.getAdmission(existingTask.taskId, request.operationKey);
        if (existingAdmission === undefined) {
          throw new TaviError(
            "CONFLICT",
            `Task ${existingTask.taskId} exists for operation key ${request.operationKey} but its admission intent is missing`,
          );
        }
        assertSameAdmission(existingAdmission, request, intentHash);
        return { task: existingTask, admission: existingAdmission, created: false };
      }

      const now = request.now();
      let task: TaskRecord = {
        taskId: request.newTaskId(),
        workspaceId: request.workspaceId,
        principalId: request.principalId,
        threadId: request.newThreadId(),
        checkpointNamespace: request.checkpointNamespace,
        status: "admitted",
        finalText: null,
        // Supplied only by a creating admission; a follow-up never reaches this
        // branch, so a later turn cannot upgrade the policy.
        // Validated before the INSERT, like every other caller-supplied value: a
        // malformed policy would otherwise commit a row no supported read can
        // parse, and the failure would surface later at every follow-up.
        executionPolicy: assertWritable(
          TaskExecutionPolicySchema,
          request.executionPolicy ?? DEFAULT_TASK_POLICY,
          `The execution policy of task ${request.operationKey}`,
        ),
        creationOperationKey: request.operationKey,
        // Recorded at creation by the admitting caller. A follow-up
        // admission keeps the origin the task was created with: a resume does
        // not change who owns a round.
        origin: request.origin ?? null,
        originScheduleId: request.originScheduleId ?? null,
        createdAt: now,
        updatedAt: now,
        ...(request.chatKind === undefined ? {} : { chatKind: request.chatKind }),
        ...(request.parentChatId === undefined ? {} : { parentChatId: request.parentChatId }),
      };
      // The chat's memory mode: what the admission asked for, and a side chat takes its
      // parent's when that is stricter — a side chat of a private chat is private too.
      const parentMode =
        request.parentChatId === undefined
          ? undefined
          : ((
              stmt(this.#store.handle, "SELECT memory_mode FROM tavi_tasks WHERE task_id = ?").get(request.parentChatId) as
                | { memory_mode: string | null }
                | undefined
            )?.memory_mode ?? undefined);
      const memoryMode =
        request.memoryMode === "private" || parentMode === "private"
          ? "private"
          : request.memoryMode === "off" || parentMode === "off"
            ? "off"
            : undefined;
      if (memoryMode !== undefined) task = { ...task, memoryMode };
      // One Home per person: a second is refused as a typed conflict,
      // read under this transaction's write lock — never by the unique index's
      // SQLite message, which a caller would have to match as text.
      if (task.chatKind === "home") {
        const existing = stmt(
          this.#store.handle,
          "SELECT task_id FROM tavi_tasks WHERE workspace_id = ? AND principal_id = ? AND chat_kind = 'home' LIMIT 1",
        ).get(task.workspaceId, task.principalId) as { task_id: string } | undefined;
        if (existing !== undefined) {
          throw new TaviError("CONFLICT", "This person already has a Home in this workspace", { details: { index: HOME_CHAT_INDEX } });
        }
      }
      stmt(
        this.#store.handle,
        `INSERT INTO tavi_tasks
             (task_id, workspace_id, principal_id, thread_id, checkpoint_namespace, status,
              final_text, operation_key, origin, origin_schedule_id, created_at, updated_at, tool_count,
              execution_policy_json, chat_kind, parent_chat_id, memory_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        task.taskId,
        task.workspaceId,
        task.principalId,
        task.threadId,
        task.checkpointNamespace,
        task.status,
        task.finalText,
        task.creationOperationKey,
        task.origin,
        task.originScheduleId,
        task.createdAt,
        task.updatedAt,
        JSON.stringify(task.executionPolicy),
        task.chatKind ?? null,
        task.parentChatId ?? null,
        task.memoryMode ?? null,
      );

      // The initializer runs here and nowhere else: this is the branch that
      // actually inserted a task, and `AdmitResult.created` is deliberately not
      // the test — it is true for a *new admission* against an existing task
      // too, so keying off it would replace an existing task's base on every
      // turn. A throw rolls the task, the admission and the snapshot
      // back together, including a throw from a durable read the initializer
      // performs (an unreadable workspace settings row aborts creation rather
      // than producing a task with no base).
      if (request.initializeSnapshot !== undefined) {
        const snapshot = request.initializeSnapshot(task);
        // The initializer is handed the task it must describe, so a snapshot that
        // names another task or workspace is a caller error rather than a write to
        // perform: `putTaskSnapshot` checks the record against the ids the record
        // itself claims, and writing a *different* task's row would leave this new
        // task with no base — the corruption state its next turn refuses.
        if (snapshot.taskId !== task.taskId || snapshot.workspaceId !== task.workspaceId) {
          throw new TaviError("INVALID_INPUT", "The task prompt snapshot is bound to another task or workspace and was not written", {
            details: {
              taskId: task.taskId,
              workspaceId: task.workspaceId,
              returnedTaskId: snapshot.taskId,
              returnedWorkspaceId: snapshot.workspaceId,
            },
          });
        }
        this.putTaskSnapshot(snapshot);
      }
      // A chat started with instructions has them from its first turn:
      // saved with the task, so the admission below pins revision 1.
      const instructions = request.chatInstructions;
      if (instructions !== undefined && instructions.text.trim() !== "") {
        assertChatInstructionsBound(instructions.text, instructions.author);
        insertChatInstructions(this.#store.handle, {
          taskId: task.taskId,
          revision: 1,
          text: instructions.text,
          author: instructions.author,
          now: task.createdAt,
        });
      }

      return { task, admission: this.#insertAdmission(request, task, intentHash), created: true };
    });
  }

  getPromptSnapshot(taskId: string, admissionId?: string): TaskPromptSnapshotRecord | undefined {
    if (admissionId !== undefined) {
      // A pin answers only for a task whose own snapshot is bound and of a
      // source that re-pins: a task with no row still refuses.
      const own = stmt(this.#store.handle, "SELECT source FROM tavi_task_prompt_snapshots WHERE task_id = ?").get(taskId) as
        | { source: string }
        | undefined;
      if (own !== undefined && REPINNED_PROMPT_SOURCES.has(own.source)) {
        const pinned = readAdmissionPromptPin(this.#store, taskId, admissionId);
        if (pinned !== undefined) return pinned;
      }
    }
    return readTaskPromptSnapshot(this.#store, taskId);
  }

  putTaskSnapshot(record: BoundTaskPromptSnapshot): BoundTaskPromptSnapshot {
    return writeTaskPromptSnapshot(this.#store, record);
  }

  /**
   * The base prompt pin a follow-up admission runs under, like its
   * chat instructions' revision (`#pinnedInstructions`): a prompt (`start`,
   * `reply`) re-resolves the workspace's base through the admission's own
   * initializer — the selection a new task makes — and pins it when it
   * differs from the task's latest (an unchanged base reuses the latest pin,
   * so nothing is written and the prompt's bytes, and a provider's cache of
   * them, stay the same); an approval, a deadline or a cancel resumes the
   * turn that suspended and keeps that turn's pin. Undefined: the task's own
   * snapshot.
   *
   * Only a task whose own base is `workspace` or `builtin` re-pins, and only
   * to one of those: an `explicit` base is its adapter's configuration (a
   * routine's pinned instructions), and a task with no row keeps refusing.
   */
  #pinnedPrompt(task: TaskRecord, request: AdmitRequest): number | undefined {
    const db = this.#store.handle;
    if (request.kind !== "start" && request.kind !== "reply") {
      const row = stmt(
        db,
        "SELECT prompt_pin FROM tavi_admissions WHERE task_id = ? AND state = 'committed' AND json_extract(result, '$.status') = 'waiting' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      ).get(task.taskId) as { prompt_pin: number | null } | undefined;
      return row?.prompt_pin ?? undefined;
    }
    // An unreadable own row pins nothing: the turn reads it and refuses there,
    // as it did before pins, rather than the admission failing in its place.
    let own: TaskPromptSnapshotRecord | undefined;
    try {
      own = readTaskPromptSnapshot(this.#store, task.taskId);
    } catch {
      return undefined;
    }
    if (own === undefined || !REPINNED_PROMPT_SOURCES.has(own.source)) return undefined;
    const latest = latestTaskPromptPin(this.#store, task);
    const fresh = request.initializeSnapshot?.(task);
    if (fresh === undefined || !REPINNED_PROMPT_SOURCES.has(fresh.source)) return latest?.pin;
    if (sameBoundSnapshot(latest?.snapshot ?? own, fresh)) return latest?.pin;
    // A chat on a shipped template keeps it when a release ships a newer one: its system text, and a provider's
    // cache of it, stay as they were. A new chat starts on the new one; a workspace base still moves every chat.
    if (keepsShippedTemplate(latest?.snapshot ?? own, fresh)) return latest?.pin;
    const bound = assertBoundTaskPromptSnapshot(fresh, task.taskId, task.workspaceId);
    const pin = (latest?.pin ?? 0) + 1;
    stmt(
      db,
      `INSERT INTO tavi_task_prompt_pins (task_id, pin, source, text, hash, settings_revision, template_version, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(task.taskId, pin, bound.source, bound.text, bound.hash, bound.revision, bound.templateVersion, bound.boundAt);
    return pin;
  }

  #insertAdmission(request: AdmitRequest, task: TaskRecord, intentHash: string, promptPin?: number): AdmissionRecord {
    const now = request.now();
    const admission: AdmissionRecord = {
      admissionId: request.newAdmissionId(),
      taskId: task.taskId,
      operationKey: request.operationKey,
      kind: request.kind,
      intent: request.intent ?? null,
      intentHash,
      state: "pending",
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    const instructionsRevision = this.#pinnedInstructions(task.taskId, request.kind);
    stmt(
      this.#store.handle,
      `INSERT INTO tavi_admissions
           (admission_id, task_id, operation_key, kind, intent, intent_hash, state, result, created_at, updated_at, instructions_revision, prompt_pin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      admission.admissionId,
      admission.taskId,
      admission.operationKey,
      admission.kind,
      JSON.stringify(admission.intent ?? null),
      admission.intentHash,
      admission.state,
      null,
      admission.createdAt,
      admission.updatedAt,
      instructionsRevision ?? null,
      promptPin ?? null,
    );
    return instructionsRevision === undefined ? admission : { ...admission, instructionsRevision };
  }

  /**
   * The chat instructions' revision an admission runs under: a prompt
   * (`start`, `reply`) starts a turn under the chat's current revision; an
   * approval, a deadline or a cancel resumes the turn that suspended, so it
   * keeps the revision of the latest admission that settled waiting — not
   * the newest prompt's, which may be queued behind the paused turn under a
   * newer revision. Undefined: none.
   */
  #pinnedInstructions(taskId: string, kind: AdmissionRecord["kind"]): number | undefined {
    const db = this.#store.handle;
    if (kind === "start" || kind === "reply") {
      const current = currentChatInstructionsRevision(db, taskId);
      return current === 0 ? undefined : current;
    }
    const row = stmt(
      db,
      "SELECT instructions_revision FROM tavi_admissions WHERE task_id = ? AND state = 'committed' AND json_extract(result, '$.status') = 'waiting' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    ).get(taskId) as { instructions_revision: number | null } | undefined;
    return row?.instructions_revision ?? undefined;
  }

  get(taskId: string): TaskRecord | undefined {
    return getTask(this.#store, taskId);
  }

  getByOperationKey(workspaceId: string, principalId: string, operationKey: string): TaskRecord | undefined {
    return this.#findTaskByOperationKey(workspaceId, principalId, operationKey);
  }

  openHome(request: AdmitRequest): string {
    return this.#store.transactionImmediate(() => {
      const existing = this.homeOf(request.workspaceId, request.principalId);
      if (existing !== undefined) return existing;
      const { task, admission } = this.admit(request);
      // The task and its snapshot stay; the admission would read as a turn nobody took.
      stmt(this.#store.handle, "DELETE FROM tavi_admissions WHERE admission_id = ?").run(admission.admissionId);
      stmt(this.#store.handle, "UPDATE tavi_tasks SET status = 'completed' WHERE task_id = ?").run(task.taskId);
      return task.taskId;
    });
  }

  homeOf(workspaceId: string, principalId: string): string | undefined {
    const row = stmt(
      this.#store.handle,
      "SELECT task_id FROM tavi_tasks WHERE workspace_id = ? AND principal_id = ? AND chat_kind = 'home' LIMIT 1",
    ).get(workspaceId, principalId) as { task_id: string } | undefined;
    return row?.task_id;
  }

  getAdmission(taskId: string, operationKey: string): AdmissionRecord | undefined {
    return getAdmission(this.#store, taskId, operationKey);
  }

  listAdmissions(taskId: string): readonly AdmissionRecord[] {
    return listAdmissions(this.#store, taskId);
  }

  latestAdmission(taskId: string): AdmissionRecord | undefined {
    return latestAdmission(this.#store, taskId);
  }

  latestSettledAdmission(taskId: string): AdmissionRecord | undefined {
    return latestSettledAdmission(this.#store, taskId);
  }

  hasRunningAdmission(taskId: string): boolean {
    return hasRunningAdmission(this.#store, taskId);
  }

  setAdmissionState(admissionId: string, state: AdmissionState): void {
    stmt(this.#store.handle, "UPDATE tavi_admissions SET state = ?, updated_at = ? WHERE admission_id = ?").run(
      state,
      nowTimestamp(),
      admissionId,
    );
  }

  setAdmissionResult(admissionId: string, result: AdmissionOutcome | null): void {
    if (result !== null) assertBoundedPayload(result, "admission result");
    stmt(this.#store.handle, "UPDATE tavi_admissions SET result = ?, updated_at = ? WHERE admission_id = ?").run(
      result === null ? null : JSON.stringify(result),
      nowTimestamp(),
      admissionId,
    );
  }

  commitAdmission(input: {
    readonly admissionId: string;
    readonly taskId: string;
    readonly state: AdmissionState;
    readonly result: AdmissionOutcome;
    readonly checkpointNamespace?: string;
  }): void {
    commitAdmission(this.#store, input);
  }

  updateStatus(taskId: string, status: TaskStatus, finalText: string | null): void {
    this.#store.transaction(() => updateTaskStatus(this.#store, taskId, status, finalText));
  }

  setCheckpointNamespace(taskId: string, checkpointNamespace: string): void {
    stmt(this.#store.handle, "UPDATE tavi_tasks SET checkpoint_namespace = ?, updated_at = ? WHERE task_id = ?").run(
      checkpointNamespace,
      nowTimestamp(),
      taskId,
    );
  }

  list(limit: number): readonly TaskRecord[] {
    return listTasks(this.#store, limit);
  }

  setMemoryMode(input: { readonly taskId: string; readonly mode: "on" | "off"; readonly now: string }): TaskRecord {
    const db = this.#store.handle;
    return this.#store.transactionImmediate((): TaskRecord => {
      const row = stmt(db, "SELECT memory_mode FROM tavi_tasks WHERE task_id = ?").get(input.taskId) as
        | { memory_mode: string | null }
        | undefined;
      if (row === undefined) throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
      // Private is set when a chat is created and never lifted.
      if (row.memory_mode === "private")
        throw new TaviError("CONFLICT", "This is a private chat: its memory stays off. Start a new chat to use memory.");
      if (input.mode === "off" && row.memory_mode !== "off") {
        stmt(db, "UPDATE tavi_tasks SET memory_mode = 'off' WHERE task_id = ?").run(input.taskId);
        // Its memory off, its words are not read: ideas quoting it, and the words sent there from an idea, go.
        deleteIdeasCiting(db, input.taskId);
      } else if (input.mode === "on" && row.memory_mode === "off") {
        // From now on: what was said before is never captured.
        stmt(db, "UPDATE tavi_tasks SET memory_mode = NULL, memory_on_at = ? WHERE task_id = ?").run(input.now, input.taskId);
      }
      const task = getTask(this.#store, input.taskId);
      if (task === undefined) throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
      return task;
    });
  }

  #findTaskByOperationKey(workspaceId: string, principalId: string, operationKey: string): TaskRecord | undefined {
    const row = stmt(this.#store.handle, "SELECT * FROM tavi_tasks WHERE workspace_id = ? AND principal_id = ? AND operation_key = ?").get(
      workspaceId,
      principalId,
      operationKey,
    ) as TaskRow | undefined;
    return row === undefined ? undefined : toTaskRecord(row);
  }
}

/** Whether a chat pinned to one shipped template keeps it rather than moving to another (`#pinnedPrompt`). */
function keepsShippedTemplate(
  current: { readonly source: string; readonly templateVersion: string | null },
  fresh: { readonly source: string; readonly templateVersion: string | null },
): boolean {
  return current.source === "builtin" && fresh.source === "builtin" && current.templateVersion !== fresh.templateVersion;
}
