import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { Database } from "better-sqlite3";

import {
  MAX_ADMISSION_PAYLOAD_BYTES,
  EXECUTION_BUSY,
  EXECUTION_SUPERSEDED,
  TaviError,
  admissionIdentity,
  assertOriginPairing,
  assertChatPairing,
  latestSettledAdmission,
  canonicalizeAdmission,
  type AdmissionOutcome,
  type AdmissionRecord,
  type AgentDelegationAdmissionRecord,
  type AgentDelegationRepositoryPort,
  type AgentMailboxEnvelopeRecord,
  type AgentMailboxRepositoryPort,
  type AgentWaitIntentRecord,
  type AgentWaitRepositoryPort,
  type ApprovalRecord,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type CheckpointReceipt,
  type CheckpointReceiptRepositoryPort,
  type ApprovalRepositoryPort,
  type CancellationRecord,
  type CancellationRepositoryPort,
  type EffectRecord,
  type EffectRepositoryPort,
  type ExecutionLease,
  type ExecutionRecord,
  type ExecutionRepositoryPort,
  type AdmissionState,
  type SerializableAdmitRequest,
  type DatabaseTime,
  type PromptSelectionPolicy,
  type WorkspaceSystemPromptRecord,
  absentWorkspaceSystemPrompt,
  type AdmitResult,
  type ModelError,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type TaskRecord,
  type TaskRepositoryPort,
  type TaskStatus,
  type TaskPromptSnapshotRecord,
  type BoundTaskPromptSnapshot,
  BoundTaskPromptSnapshotSchema,
  TaskPromptSnapshotRecordSchema,
  TaskExecutionPolicySchema,
  DEFAULT_TASK_POLICY,
  type TaskExecutionPolicy,
  CONTEXT_MESSAGE_END,
  CONTEXT_MESSAGE_HEAD,
  CONTEXT_MESSAGE_PREFIX,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

/**
 * Fixture transports, in-memory repositories and helpers for adapter-level tests.
 *
 * A prompt selection policy naming the shipped default lives with the tests
 * that use it: this package cannot depend on `@tavi/agent-host`, whose own tests
 * import it.
 */

const require = createRequire(import.meta.url);

/** In-memory database handle suitable for a disposable spike run. */
export function createInMemoryDatabase(): Database {
  const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new BetterSqlite3(":memory:");
  db.pragma("journal_mode = MEMORY");
  return db;
}

/** Saver bound to a fresh in-memory database. */
export function createInMemorySaver(): { readonly saver: SqliteSaver; readonly db: Database } {
  const db = createInMemoryDatabase();
  return { saver: new SqliteSaver(db), db };
}

/** A scripted response for one model attempt. */
export type ScriptedTurn =
  | { readonly text: string }
  | {
      readonly toolCall: { readonly id: string; readonly name: string; readonly input: unknown };
      readonly text?: string;
    }
  /**
   * **Parallel** calls in one response, which a real model emits and the
   * transport contract allows (up to 64). The singular form above cannot express
   * it, and a batch is exactly the shape the per-response tool budget and the
   * transcript's well-formedness are about — a live evaluation found an
   * over-budget batch leaving calls unanswered.
   */
  | {
      readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[];
      readonly text?: string;
    };

export interface FixtureModelOptions {
  /** Turns returned in order; the last turn repeats once the script is exhausted. */
  readonly turns: readonly ScriptedTurn[];
  readonly usagePerTurn?: { readonly inputTokens: number; readonly outputTokens: number };
  /**
   * Fail this call instead — a provider's 429, say — after streaming
   * `partialText` if given: how a test drives failover. Consulted
   * before the turn; `undefined` answers the turn as scripted.
   */
  readonly failWith?: (request: ModelRequest) => { readonly error: ModelError; readonly partialText?: string } | undefined;
}

/**
 * Deterministic model transport implementing the same contract as the AI SDK
 * adapter ("A fixture transport passes the same service contract").
 */
export function createFixtureModel(options: FixtureModelOptions): ModelPort & { readonly calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const fallback = options.turns.at(-1) ?? { text: "(no fixture turn)" };

  return {
    calls,
    async stream(
      request: ModelRequest,
      streamOptions: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
    ): Promise<ModelOutcome> {
      calls.push(request);
      const index = Math.min(request.attemptNumber - 1, options.turns.length - 1);
      const turn = options.turns[index] ?? fallback;
      const emit = streamOptions.onEvent;
      const blockId = `block-${request.attemptId}`;

      const failure = options.failWith?.(request);
      if (failure !== undefined && !streamOptions.signal.aborted) {
        if (failure.partialText !== undefined)
          emit({ type: "text.delta", attemptId: request.attemptId, blockId, text: failure.partialText });
        return {
          status: "failed",
          attemptId: request.attemptId,
          text: failure.partialText ?? "",
          toolCalls: [],
          usage: {},
          error: failure.error,
        };
      }

      if (streamOptions.signal.aborted) {
        return {
          status: "aborted",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "aborted", message: "aborted before generation", retryable: false },
        };
      }

      if ("toolCalls" in turn) {
        for (const toolCall of turn.toolCalls) {
          // One block per call, as the real adapter does (`models.ts` uses the
          // provider's tool-call id as the block id): a fixture that shared one
          // block across a batch could not expose a consumer that keys on it.
          const callBlockId = `block-${toolCall.id}`;
          emit({ type: "tool.input.started", attemptId: request.attemptId, blockId: callBlockId, toolName: toolCall.name });
          emit({
            type: "tool.completed",
            attemptId: request.attemptId,
            blockId: callBlockId,
            toolName: toolCall.name,
            callId: toolCall.id,
            input: toolCall.input,
          });
        }
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: turn.text ?? "",
          toolCalls: turn.toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name, input: toolCall.input })),
          finishReason: "tool-calls",
          usage: usage(options),
        };
      }

      if ("toolCall" in turn) {
        emit({
          type: "tool.input.started",
          attemptId: request.attemptId,
          blockId,
          toolName: turn.toolCall.name,
        });
        emit({
          type: "tool.completed",
          attemptId: request.attemptId,
          blockId,
          toolName: turn.toolCall.name,
          callId: turn.toolCall.id,
          input: turn.toolCall.input,
        });
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: turn.text ?? "",
          toolCalls: [{ id: turn.toolCall.id, name: turn.toolCall.name, input: turn.toolCall.input }],
          finishReason: "tool-calls",
          usage: usage(options),
        };
      }

      // Emit text in two deltas so streaming behavior is exercised, not assumed.
      const midpoint = Math.max(1, Math.floor(turn.text.length / 2));
      for (const chunk of [turn.text.slice(0, midpoint), turn.text.slice(midpoint)]) {
        if (chunk === "") continue;
        emit({ type: "text.delta", attemptId: request.attemptId, blockId, text: chunk });
      }
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: turn.text,
        toolCalls: [],
        finishReason: "stop",
        usage: usage(options),
      };
    },
  };
}

function usage(options: FixtureModelOptions): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const per = options.usagePerTurn;
  if (per === undefined) return {};
  return {
    inputTokens: per.inputTokens,
    outputTokens: per.outputTokens,
    totalTokens: per.inputTokens + per.outputTokens,
  };
}

/**
 * In-memory `TaskRepositoryPort` for adapter tests.
 *
 * Mirrors the durable repository's contract, including operation-key idempotency
 * and the same-key/different-intent conflict, so an adapter test exercises the
 * real admission semantics without a database.
 *
 * "Mirrors" is load-bearing for the prompt snapshot: a double that accepted a
 * shape or a failure mode the store refuses would let an adapter test pass
 * against behavior production does not have, so admission is atomic around the
 * initializer and reads are validated here exactly as they are in SQLite.
 */
export type InMemoryTaskRepository = TaskRepositoryPort & {
  /**
   * Test-only seam: insert a snapshot row directly.
   *
   * The durable equivalent is a hand-written SQL `INSERT`, which is how the
   * corruption tests reach states the ports cannot produce — a row whose hash
   * disagrees with its text.
   */
  readonly seedPromptSnapshot: (record: TaskPromptSnapshotRecord) => void;
};

export function createInMemoryTaskRepository(
  settings?: (workspaceId: string) => WorkspaceSystemPromptRecord | Promise<WorkspaceSystemPromptRecord>,
): InMemoryTaskRepository {
  let admissionTail = Promise.resolve();
  const tasks = new Map<string, TaskRecord>();
  const admissions = new Map<string, AdmissionRecord>();
  /** The base each task selected at admission, mirroring `tavi_task_prompt_snapshots`. */
  const snapshots = new Map<string, TaskPromptSnapshotRecord>();
  const keyOf = (taskId: string, operationKey: string): string => `${taskId}::${operationKey}`;
  /** Each task's per-turn base pins, mirroring `tavi_task_prompt_pins`: pin `n` is entry `n - 1`. */
  const pins = new Map<string, BoundTaskPromptSnapshot[]>();
  /** The pin each admission runs under, mirroring `tavi_admissions.prompt_pin`. */
  const admissionPins = new Map<string, number>();
  const repinned = (source: string): boolean => source === "workspace" || source === "builtin";

  /** Validate a stored row the way `readTaskPromptSnapshot` does, so a corrupt row is loud on this path too. */
  const readSnapshot = (taskId: string): TaskPromptSnapshotRecord | undefined => {
    const record = snapshots.get(taskId);
    if (record === undefined) return undefined;
    const parsed = TaskPromptSnapshotRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new TaviError("INTERNAL", `Task ${taskId} has an unreadable prompt snapshot; repair it or restore a backup`, {
        details: { taskId },
      });
    }
    if (promptHash(parsed.data.text) !== parsed.data.hash) {
      throw new TaviError(
        "INTERNAL",
        `Task ${taskId} has a prompt snapshot that does not hash to its own text; repair it or restore a backup`,
        { details: { taskId } },
      );
    }
    return parsed.data;
  };

  /**
   * The one writer for a task's base, shared by the port method and `admit`'s
   * initializer.
   *
   * Shared rather than duplicated so the two paths cannot drift, and ordered the
   * way the durable `writeTaskPromptSnapshot` is: the *record* is validated first
   * (`boundSnapshotOrThrow`, which checks the schema, the task/workspace binding it
   * claims and the hash), then the task row it names. A double that reported a
   * different refusal for a record that is both malformed and orphaned would let
   * an adapter test pass against an error shape the store never produces.
   */
  const writeSnapshot = (record: BoundTaskPromptSnapshot): BoundTaskPromptSnapshot => {
    const bound = boundSnapshotOrThrow(record, record.taskId, record.workspaceId);
    const task = tasks.get(bound.taskId);
    if (task === undefined) {
      throw new TaviError("INVALID_INPUT", "A task prompt snapshot needs its task to exist and was not written", {
        details: { taskId: bound.taskId },
      });
    }
    if (task.workspaceId !== bound.workspaceId) {
      throw new TaviError("INVALID_INPUT", "A task prompt snapshot must be in its task's workspace and was not written", {
        details: { taskId: bound.taskId, workspaceId: bound.workspaceId, taskWorkspaceId: task.workspaceId },
      });
    }
    const existing = readSnapshot(bound.taskId);
    if (existing === undefined) {
      snapshots.set(bound.taskId, bound);
      return bound;
    }
    // Immutable per task: an identical re-insert is a replay and yields the
    // persisted row, a different base is the same CONFLICT the store raises.
    if (
      existing.source === bound.source &&
      existing.text === bound.text &&
      existing.hash === bound.hash &&
      existing.revision === bound.revision &&
      existing.templateVersion === bound.templateVersion
    ) {
      return existing;
    }
    throw new TaviError("CONFLICT", `Task ${bound.taskId} already selected a different prompt base`, {
      details: { taskId: bound.taskId, existingSource: existing.source, attemptedSource: bound.source },
    });
  };

  /** The pin a follow-up admission runs under, exactly as the durable `#pinnedPrompt` chooses it. */
  const pinFor = async (task: TaskRecord, request: SerializableAdmitRequest): Promise<number | undefined> => {
    if (request.kind !== "start" && request.kind !== "reply") {
      const waiting = [...admissions.values()]
        .filter(
          (admission) => admission.taskId === task.taskId && admission.state === "committed" && admission.result?.status === "waiting",
        )
        .at(-1);
      return waiting === undefined ? undefined : admissionPins.get(waiting.admissionId);
    }
    // An unreadable own row pins nothing; the turn refuses on reading it, as the store does.
    let own: TaskPromptSnapshotRecord | undefined;
    try {
      own = readSnapshot(task.taskId);
    } catch {
      return undefined;
    }
    if (own === undefined || !repinned(own.source)) return undefined;
    const list = pins.get(task.taskId) ?? [];
    const latest = list.at(-1);
    const fresh = fixturePrompt(
      task,
      request.prompt,
      request.now,
      request.prompt.explicitPrompt === undefined
        ? ((await settings?.(task.workspaceId)) ?? absentWorkspaceSystemPrompt(task.workspaceId))
        : undefined,
    );
    if (!repinned(fresh.source)) return latest === undefined ? undefined : list.length;
    const current = latest ?? own;
    if (
      current.source === fresh.source &&
      current.text === fresh.text &&
      current.hash === fresh.hash &&
      current.revision === fresh.revision &&
      current.templateVersion === fresh.templateVersion
    ) {
      return latest === undefined ? undefined : list.length;
    }
    // As the store does: a chat on a shipped template keeps it when another is shipped.
    if (current.source === "builtin" && fresh.source === "builtin" && current.templateVersion !== fresh.templateVersion)
      return latest === undefined ? undefined : list.length;
    pins.set(task.taskId, [...list, boundSnapshotOrThrow(fresh, task.taskId, task.workspaceId)]);
    return list.length + 1;
  };

  return {
    recordToolCall: async () => undefined,
    listCallsForTools: async () => [],
    seedPromptSnapshot: (record) => {
      snapshots.set(record.taskId, record);
    },
    getPromptSnapshot: async (taskId, admissionId) => {
      const own = readSnapshot(taskId);
      if (admissionId === undefined || own === undefined || !repinned(own.source)) return own;
      const pin = admissionPins.get(admissionId);
      const pinned = pin === undefined ? undefined : pins.get(taskId)?.[pin - 1];
      return pinned ?? own;
    },
    putTaskSnapshot: async (...args) => writeSnapshot(...args),
    async openHome(request: SerializableAdmitRequest): Promise<string> {
      const existing = [...tasks.values()].find(
        (task) => task.chatKind === "home" && task.workspaceId === request.workspaceId && task.principalId === request.principalId,
      );
      if (existing !== undefined) return existing.taskId;
      const { task, admission } = await this.admit(request);
      admissions.delete(keyOf(task.taskId, admission.operationKey));
      tasks.set(task.taskId, { ...task, status: "completed" });
      return task.taskId;
    },
    async admit(request: SerializableAdmitRequest): Promise<AdmitResult> {
      const previousAdmission = admissionTail;
      let releaseAdmission = () => {};
      admissionTail = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      await previousAdmission;
      try {
        // The same pairing rule the store enforces, so an adapter test cannot pass
        // an origin the real store would refuse.
        assertOriginPairing(request);
        assertChatPairing(request);
        // Bounded before the follow-up branch, as the durable repository does: an
        // oversized intent is refused on *every* admission, not only a creating one.
        assertBounded(request.intent, "admission intent");
        if (request.taskId !== undefined) {
          const target = tasks.get(request.taskId);
          if (target === undefined || target.workspaceId !== request.workspaceId || target.principalId !== request.principalId) {
            throw new TaviError("NOT_FOUND", `Task ${request.taskId} does not exist`);
          }
          const existing = admissions.get(keyOf(target.taskId, request.operationKey));
          if (existing !== undefined) {
            assertSameAdmission(existing, request);
            return { task: target, admission: existing, created: false };
          }
          const promptPin = await pinFor(target, request);
          const now = request.now;
          const admission: AdmissionRecord = {
            admissionId: request.newAdmissionId,
            taskId: target.taskId,
            operationKey: request.operationKey,
            kind: request.kind,
            intent: request.intent ?? null,
            intentHash: admissionIdentity(request.kind, request.intent),
            state: "pending",
            result: null,
            createdAt: now,
            updatedAt: now,
          };
          admissions.set(keyOf(target.taskId, admission.operationKey), admission);
          if (promptPin !== undefined) admissionPins.set(admission.admissionId, promptPin);
          return { task: target, admission, created: true };
        }

        const existingTask = [...tasks.values()].find(
          (task) =>
            task.workspaceId === request.workspaceId &&
            task.principalId === request.principalId &&
            task.creationOperationKey === request.operationKey,
        );
        if (existingTask !== undefined) {
          const existingAdmission = admissions.get(keyOf(existingTask.taskId, request.operationKey));
          if (existingAdmission === undefined) {
            throw new TaviError("CONFLICT", "task exists without its admission intent");
          }
          assertSameAdmission(existingAdmission, request);
          return { task: existingTask, admission: existingAdmission, created: false };
        }

        const now = request.now;
        const task: TaskRecord = {
          taskId: request.newTaskId,
          workspaceId: request.workspaceId,
          principalId: request.principalId,
          threadId: request.newThreadId,
          checkpointNamespace: request.checkpointNamespace,
          status: "admitted",
          finalText: null,
          // As the durable repository: only a creating admission supplies a policy
          // (this is the creation branch), an absent one is the unattended default,
          // and a malformed one is refused rather than stored.
          executionPolicy: taskExecutionPolicyOrThrow(request.executionPolicy ?? DEFAULT_TASK_POLICY),
          creationOperationKey: request.operationKey,
          // Forwarded, as the real store persists it: the
          // schedule-owned-round rule has no other source, so a fixture that
          // discarded it would make the forwarding untestable through the adapter.
          origin: request.origin ?? null,
          originScheduleId: request.originScheduleId ?? null,
          ...(request.chatKind === undefined ? {} : { chatKind: request.chatKind }),
          ...(request.parentChatId === undefined ? {} : { parentChatId: request.parentChatId }),
          // As the store: the stricter of the admission's mode and a side chat's parent's.
          ...((): { memoryMode?: "off" | "private" } => {
            const parent = request.parentChatId === undefined ? undefined : tasks.get(request.parentChatId)?.memoryMode;
            const mode =
              request.memoryMode === "private" || parent === "private"
                ? "private"
                : request.memoryMode === "off" || parent === "off"
                  ? "off"
                  : undefined;
            return mode === undefined ? {} : { memoryMode: mode };
          })(),
          createdAt: now,
          updatedAt: now,
        };
        const admission: AdmissionRecord = {
          admissionId: request.newAdmissionId,
          taskId: task.taskId,
          operationKey: request.operationKey,
          kind: request.kind,
          intent: request.intent ?? null,
          intentHash: admissionIdentity(request.kind, request.intent),
          state: "pending",
          result: null,
          createdAt: now,
          updatedAt: now,
        };
        // Resolved and validated *before* anything is published, through the same
        // writer the port exposes. The durable repository runs the initializer
        // inside `transactionImmediate`, so a failure leaves no task, no admission
        // and no snapshot; publishing first would leave a task with no snapshot —
        // exactly the corruption state the adapter refuses — and let a test exercise
        // a shape production cannot produce. The writer needs the task row to
        // exist, so the task and admission are published first and rolled back if the
        // initializer refuses, mirroring the transaction it stands in for.
        // Validated against **this** admission's task before anything is published,
        // then written through the shared writer: `boundSnapshotOrThrow` catches a
        // candidate that names another task or workspace, which `writeSnapshot`
        // alone cannot (it checks the record against the ids the record itself
        // claims, exactly as the durable `putTaskSnapshot` does).
        const initialized = boundSnapshotOrThrow(
          fixturePrompt(
            task,
            request.prompt,
            request.now,
            request.prompt.explicitPrompt === undefined
              ? ((await settings?.(task.workspaceId)) ?? absentWorkspaceSystemPrompt(task.workspaceId))
              : undefined,
          ),
          task.taskId,
          task.workspaceId,
        );
        const previous = { task: tasks.get(task.taskId), admission: admissions.get(keyOf(task.taskId, admission.operationKey)) };
        tasks.set(task.taskId, task);
        admissions.set(keyOf(task.taskId, admission.operationKey), admission);
        if (initialized !== undefined) {
          try {
            writeSnapshot(initialized);
          } catch (error) {
            if (previous.task === undefined) tasks.delete(task.taskId);
            else tasks.set(task.taskId, previous.task);
            if (previous.admission === undefined) admissions.delete(keyOf(task.taskId, admission.operationKey));
            else admissions.set(keyOf(task.taskId, admission.operationKey), previous.admission);
            throw error;
          }
        }
        return { task, admission, created: true };
      } finally {
        releaseAdmission();
      }
    },

    get: async (taskId) => tasks.get(taskId),

    homeOf: async (workspaceId, principalId) =>
      [...tasks.values()].find((task) => task.workspaceId === workspaceId && task.principalId === principalId && task.chatKind === "home")
        ?.taskId,

    getByOperationKey: async (workspaceId, principalId, operationKey) =>
      [...tasks.values()].find(
        (task) => task.workspaceId === workspaceId && task.principalId === principalId && task.creationOperationKey === operationKey,
      ),

    getAdmission: async (taskId, operationKey) => admissions.get(keyOf(taskId, operationKey)),

    listAdmissions: async (taskId) => [...admissions.values()].filter((admission) => admission.taskId === taskId),

    latestAdmission: async (taskId) => [...admissions.values()].filter((admission) => admission.taskId === taskId).at(-1),

    latestSettledAdmission: async (taskId) =>
      latestSettledAdmission([...admissions.values()].filter((admission) => admission.taskId === taskId)),

    hasRunningAdmission: async (taskId) =>
      [...admissions.values()].some(
        (admission) => admission.taskId === taskId && admission.state === "claimed" && admission.result === null,
      ),

    async setAdmissionState(admissionId: string, state: AdmissionState): Promise<void> {
      for (const [key, admission] of admissions) {
        if (admission.admissionId === admissionId) admissions.set(key, { ...admission, state });
      }
    },

    async setAdmissionResult(admissionId: string, result: AdmissionOutcome | null): Promise<void> {
      if (result !== null) assertBounded(result, "admission result");
      for (const [key, admission] of admissions) {
        if (admission.admissionId === admissionId) admissions.set(key, { ...admission, result });
      }
    },

    async commitAdmission(input): Promise<void> {
      assertBounded(input.result, "admission result");
      for (const [key, admission] of admissions) {
        if (admission.admissionId === input.admissionId) {
          admissions.set(key, { ...admission, state: input.state, result: input.result });
        }
      }
      if (input.checkpointNamespace !== undefined) {
        const recorded = tasks.get(input.taskId);
        if (recorded !== undefined) tasks.set(input.taskId, { ...recorded, checkpointNamespace: input.checkpointNamespace });
      }
      const task = tasks.get(input.taskId);
      // A refused admission never projects task status, and nothing
      // overwrites a cancelled task's — mirroring the store: a stale decision
      // leaves a waiting task waiting, and cancellation is authoritative.
      if (task !== undefined && input.state !== "refused" && task.status !== "cancelled") {
        tasks.set(input.taskId, {
          ...task,
          status: input.result.status === "waiting" ? "waiting" : input.result.status,
          finalText: input.result.status === "completed" ? input.result.finalText : null,
        });
      }
    },

    async updateStatus(taskId: string, status: TaskStatus, finalText: string | null): Promise<void> {
      const task = tasks.get(taskId);
      if (task !== undefined) tasks.set(taskId, { ...task, status, finalText });
    },

    async setCheckpointNamespace(taskId: string, checkpointNamespace: string): Promise<void> {
      const task = tasks.get(taskId);
      if (task !== undefined) tasks.set(taskId, { ...task, checkpointNamespace });
    },

    async list(limit: number): Promise<readonly TaskRecord[]> {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TaviError("INVALID_INPUT", "list requires a positive integer limit");
      }
      return [...tasks.values()].slice(0, limit);
    },

    async setMemoryMode(input): Promise<TaskRecord> {
      const task = tasks.get(input.taskId);
      if (task === undefined) throw new TaviError("NOT_FOUND", `Task ${input.taskId} does not exist`);
      if (task.memoryMode === "private") throw new TaviError("CONFLICT", "This is a private chat: its memory stays off.");
      if (input.mode === "off" && task.memoryMode !== "off") tasks.set(task.taskId, { ...task, memoryMode: "off" });
      if (input.mode === "on" && task.memoryMode === "off") {
        const { memoryMode: _mode, ...rest } = task;
        tasks.set(task.taskId, { ...rest, memoryOnAt: input.now });
      }
      return tasks.get(task.taskId) as TaskRecord;
    },
  };
}

/**
 * Validate a snapshot an initializer returned, mirroring the durable
 * repository's checks: a bound source, the right task and workspace, and a hash
 * that matches the text. A fixture that accepted a shape production refuses
 * would make an adapter test pass against behavior the store does not have.
 */
function boundSnapshotOrThrow(value: unknown, taskId: string, workspaceId: string): BoundTaskPromptSnapshot {
  const parsed = BoundTaskPromptSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "The task prompt snapshot is not valid and was not written", {
      details: { taskId, reason: parsed.error.issues[0]?.message ?? "invalid" },
    });
  }
  const bound = parsed.data;
  if (bound.taskId !== taskId || bound.workspaceId !== workspaceId) {
    throw new TaviError("INVALID_INPUT", "The task prompt snapshot is bound to another task or workspace and was not written", {
      details: { taskId, workspaceId, returnedTaskId: bound.taskId, returnedWorkspaceId: bound.workspaceId },
    });
  }
  if (promptHash(bound.text) !== bound.hash) {
    throw new TaviError("INVALID_INPUT", "The task prompt snapshot hash does not match its text and was not written", {
      details: { taskId: bound.taskId, source: bound.source },
    });
  }
  return bound;
}

/** Validate a creating admission's policy exactly as `SqliteTaskRepository.admit` does. */
function taskExecutionPolicyOrThrow(value: unknown): TaskExecutionPolicy {
  const parsed = TaskExecutionPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "The execution policy is not valid and was not written", {
      details: { reason: parsed.error.issues[0]?.message ?? "invalid" },
    });
  }
  return parsed.data;
}

function assertBounded(value: unknown, label: string): void {
  const bytes = new TextEncoder().encode(canonicalizeAdmission(value ?? null)).byteLength;
  if (bytes > MAX_ADMISSION_PAYLOAD_BYTES) {
    throw new TaviError("BUDGET_EXCEEDED", `${label} exceeded ${MAX_ADMISSION_PAYLOAD_BYTES} bytes`, {
      details: { bytes },
    });
  }
}

/** Same rule as the durable repository: kind and canonical content must match. */
function assertSameAdmission(existing: AdmissionRecord, request: SerializableAdmitRequest): void {
  if (existing.kind !== request.kind) {
    throw new TaviError("CONFLICT", `Operation key ${request.operationKey} was admitted as "${existing.kind}", not "${request.kind}"`);
  }
  if (existing.intentHash !== admissionIdentity(request.kind, request.intent)) {
    throw new TaviError("CONFLICT", "Operation key was already admitted with different content");
  }
}

/**
 * In-memory `EffectRepositoryPort` for adapter tests.
 *
 * Mirrors the durable ledger's replay rule: a second `begin` on a known key
 * resolves the existing row instead of creating a second logical effect.
 */
export function createInMemoryEffectRepository(): EffectRepositoryPort {
  const rows = new Map<string, EffectRecord>();
  return {
    async begin(input) {
      const existing = rows.get(input.effectKey);
      if (existing !== undefined) {
        // Same canonical comparison as the durable repository: a key-order
        // difference is not a different effect.
        if (existing.inputsHash !== canonicalizeAdmission(input.inputs ?? null)) {
          throw new TaviError("CONFLICT", "effect already exists with different inputs");
        }
        return { effect: existing, created: false };
      }
      const now = fixtureTime(input.now);
      const record: EffectRecord = {
        effectKey: input.effectKey,
        taskId: input.taskId,
        admissionId: input.admissionId,
        toolId: input.toolId,
        inputs: input.inputs ?? null,
        inputsHash: canonicalizeAdmission(input.inputs ?? null),
        approvalId: input.approvalId ?? null,
        state: "pending",
        receipt: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(input.effectKey, record);
      return { effect: record, created: true };
    },
    async abandon(effectKey) {
      if (rows.get(effectKey)?.state !== "pending") return false;
      return rows.delete(effectKey);
    },
    async resolve(input) {
      const existing = rows.get(input.effectKey);
      if (existing === undefined) throw new TaviError("NOT_FOUND", "effect was never begun");
      // A settled effect cannot be re-resolved, matching the durable ledger.
      if (existing.state !== "pending" && existing.state !== "uncertain") {
        throw new TaviError("CONFLICT", `effect is already ${existing.state}`);
      }
      rows.set(input.effectKey, {
        ...existing,
        state: input.state,
        receipt: input.receipt ?? null,
        ...(input.label === undefined ? {} : { label: input.label }),
        error: input.error ?? null,
        updatedAt: fixtureTime(input.now),
      });
    },
    get: async (effectKey) => rows.get(effectKey),
    listForTask: async (taskId) => [...rows.values()].filter((row) => row.taskId === taskId),
    // The fake holds no tasks, so it has no workspaces: every effect under the prefixes is listed.
    listForTools: async (input) =>
      [...rows.values()]
        .filter((row) => input.prefixes.some((prefix) => row.toolId.startsWith(prefix)))
        .filter(
          (row) =>
            input.before === undefined ||
            row.createdAt < input.before.at ||
            (row.createdAt === input.before.at && row.effectKey < input.before.effectKey),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.effectKey.localeCompare(a.effectKey))
        .slice(0, input.limit)
        .map((row) => ({ effectKey: row.effectKey, taskId: row.taskId, toolId: row.toolId, state: row.state, createdAt: row.createdAt })),
    async listUnresolved(limit: number): Promise<readonly EffectRecord[]> {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TaviError("INVALID_INPUT", "listUnresolved requires a positive integer limit");
      }
      return [...rows.values()].filter((row) => row.state === "pending" || row.state === "uncertain").slice(0, limit);
    },
  };
}

/**
 * In-memory `ExecutionRepositoryPort` for adapter tests.
 *
 * Enforces the same ownership rules as the durable repository, including the one
 * that matters most: an expired lease does **not** authorize a takeover.
 */
export function createInMemoryExecutionRepository(): ExecutionRepositoryPort {
  const rows = new Map<string, ExecutionRecord>();
  const key = (taskId: string, generation: number): string => `${taskId}::${generation}`;

  const highest = (taskId: string): number =>
    Math.max(0, ...[...rows.values()].filter((row) => row.taskId === taskId).map((row) => row.generation));

  const active = (taskId: string): ExecutionRecord | undefined =>
    [...rows.values()]
      .filter((row) => row.taskId === taskId && row.state === "active")
      .sort((left, right) => right.generation - left.generation)[0];

  return {
    async acquire(input): Promise<ExecutionLease> {
      const existing = active(input.taskId);
      if (existing !== undefined) {
        if (existing.ownerSession === input.ownerSession) {
          const leaseExpiresAt = addMs(fixtureTime(input.now), input.leaseMs);
          rows.set(key(input.taskId, existing.generation), {
            ...existing,
            admissionId: input.admissionId,
            heartbeatAt: fixtureTime(input.now),
            leaseExpiresAt,
          });
          return {
            taskId: input.taskId,
            generation: existing.generation,
            ownerSession: input.ownerSession,
            leaseExpiresAt,
          };
        }
        const expired = Date.parse(existing.leaseExpiresAt) <= Date.parse(fixtureTime(input.now));
        throw new TaviError(
          "CONFLICT",
          expired
            ? `Task ${input.taskId} has an expired execution lease; an expired lease signals investigation, not permission to overlap`
            : `Task ${input.taskId} is already executing under ${existing.ownerSession}`,
          { details: { reason: EXECUTION_BUSY, generation: existing.generation } },
        );
      }
      const generation = highest(input.taskId) + 1;
      const now = fixtureTime(input.now);
      const leaseExpiresAt = addMs(now, input.leaseMs);
      rows.set(key(input.taskId, generation), {
        taskId: input.taskId,
        generation,
        ownerSession: input.ownerSession,
        admissionId: input.admissionId,
        state: "active",
        startedAt: now,
        heartbeatAt: now,
        leaseExpiresAt,
        endedAt: null,
        terminatedReason: null,
        terminatedBy: null,
      });
      return { taskId: input.taskId, generation, ownerSession: input.ownerSession, leaseExpiresAt };
    },

    async heartbeat(input): Promise<void> {
      this.assertCurrentGeneration(input.taskId, input.generation, input.ownerSession);
      const row = rows.get(key(input.taskId, input.generation));
      if (row !== undefined) {
        rows.set(key(input.taskId, input.generation), {
          ...row,
          heartbeatAt: fixtureTime(input.now),
          leaseExpiresAt: addMs(fixtureTime(input.now), input.leaseMs),
        });
      }
    },

    async release(input): Promise<void> {
      const row = rows.get(key(input.taskId, input.generation));
      if (row !== undefined && row.ownerSession === input.ownerSession && row.state === "active") {
        rows.set(key(input.taskId, input.generation), { ...row, state: "released", endedAt: fixtureTime(input.now) });
      }
    },

    async terminate(input): Promise<void> {
      if (input.confirmedTerminated !== true) {
        throw new TaviError("INVALID_INPUT", "terminate requires confirmedTerminated: true");
      }
      if (input.reason.trim() === "" || input.terminatedBy.trim() === "") {
        throw new TaviError("INVALID_INPUT", "terminate requires a reason and an operator identity");
      }
      const row = rows.get(key(input.taskId, input.generation));
      if (row === undefined) throw new TaviError("NOT_FOUND", "no such execution generation");
      rows.set(key(input.taskId, input.generation), {
        ...row,
        state: "terminated",
        endedAt: fixtureTime(input.now),
        terminatedReason: input.reason,
        terminatedBy: input.terminatedBy,
      });
    },

    listExpiredLeases: async (now, limit) =>
      [...rows.values()].filter((row) => row.state === "active" && Date.parse(row.leaseExpiresAt) <= Date.parse(now)).slice(0, limit),

    current: async (taskId) => active(taskId) ?? [...rows.values()].filter((row) => row.taskId === taskId).at(-1),

    list: async (taskId) =>
      [...rows.values()].filter((row) => row.taskId === taskId).sort((left, right) => left.generation - right.generation),

    async assertCurrentGeneration(taskId: string, generation: number, ownerSession: string): Promise<void> {
      const row = rows.get(key(taskId, generation));
      if (row === undefined)
        throw new TaviError("CONFLICT", "execution generation does not exist", { details: { reason: EXECUTION_SUPERSEDED } });
      if (row.ownerSession !== ownerSession) {
        throw new TaviError("CONFLICT", "execution is owned by another session", { details: { reason: EXECUTION_SUPERSEDED } });
      }
      if (row.state !== "active") {
        throw new TaviError("CONFLICT", `execution is ${row.state}; a superseded generation may not write`, {
          details: { reason: EXECUTION_SUPERSEDED },
        });
      }
      if (generation !== highest(taskId)) {
        throw new TaviError("CONFLICT", "execution was superseded by a newer generation", { details: { reason: EXECUTION_SUPERSEDED } });
      }
    },
  };
}

function addMs(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/** In-memory `ApprovalRepositoryPort` mirroring the durable rules. */
export function createInMemoryApprovalRepository(): ApprovalRepositoryPort {
  const rows = new Map<string, ApprovalRecord>();
  /** The read resolver, as `getForCall`: that round's row, or without one the newest round's. */
  const findForCall = (taskId: string, callId: string, steps?: number): ApprovalRecord | undefined => {
    const forCall = [...rows.values()].filter((row) => row.taskId === taskId && row.callId === callId);
    if (steps !== undefined) return forCall.find((row) => row.steps === steps);
    return forCall.sort((left, right) => right.steps - left.steps)[0];
  };

  return {
    async request(input) {
      // An **exact** probe, mirroring the store: the same `callId` in another round is another authorization.
      const existing = [...rows.values()].find(
        (row) => row.taskId === input.taskId && row.callId === input.callId && row.steps === input.steps,
      );
      if (existing !== undefined) {
        if (existing.inputsHash !== canonicalizeAdmission(input.inputs ?? null)) {
          throw new TaviError("CONFLICT", "approval already exists with different inputs");
        }
        return existing;
      }
      const now = fixtureTime(input.now);
      const record: ApprovalRecord = {
        approvalId: input.approvalId,
        taskId: input.taskId,
        admissionId: input.admissionId,
        toolId: input.toolId,
        callId: input.callId,
        steps: input.steps,
        inputs: input.inputs ?? null,
        inputsHash: canonicalizeAdmission(input.inputs ?? null),
        state: "pending",
        decidedBy: null,
        decidedAt: null,
        note: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(record.approvalId, record);
      return record;
    },
    async decide(input) {
      const existing = rows.get(input.approvalId);
      if (existing === undefined) throw new TaviError("NOT_FOUND", "approval does not exist");
      // A cancelled request can never be granted, and a settled one is immutable.
      if (existing.state === "cancelled") {
        throw new TaviError("CONFLICT", "approval was cancelled");
      }
      if (existing.state !== "pending") {
        if (existing.state !== input.state) {
          throw new TaviError("CONFLICT", `approval is already ${existing.state}`);
        }
        return existing;
      }
      const updated: ApprovalRecord = {
        ...existing,
        state: input.state,
        decidedBy: input.decidedBy,
        decidedAt: fixtureTime(input.now),
        note: input.note ?? null,
        updatedAt: fixtureTime(input.now),
      };
      rows.set(input.approvalId, updated);
      return updated;
    },
    async cancelPendingForTask(taskId: string, now: DatabaseTime): Promise<number> {
      let changes = 0;
      for (const [key, row] of rows) {
        if (row.taskId === taskId && row.state === "pending") {
          rows.set(key, { ...row, state: "cancelled", decidedAt: fixtureTime(now), updatedAt: fixtureTime(now) });
          changes += 1;
        }
      }
      return changes;
    },
    get: async (approvalId) => rows.get(approvalId),
    getForCall: async (...args) => findForCall(...args),
    listForTask: async (taskId) => [...rows.values()].filter((row) => row.taskId === taskId),
    listPending: async (limit) => [...rows.values()].filter((row) => row.state === "pending").slice(0, limit),
  };
}

/** In-memory `CancellationRepositoryPort` mirroring the durable rules. */
export function createInMemoryCancellationRepository(): CancellationRepositoryPort {
  const rows = new Map<string, CancellationRecord>();
  return {
    async request(input) {
      // Cancellation is idempotent: the first request is authoritative.
      const existing = rows.get(input.taskId);
      if (existing !== undefined) return existing;
      const record: CancellationRecord = {
        taskId: input.taskId,
        requestedBy: input.requestedBy,
        reason: input.reason,
        requestedAt: fixtureTime(input.now),
      };
      rows.set(input.taskId, record);
      return record;
    },
    get: async (taskId) => rows.get(taskId),
    list: async (limit) => [...rows.values()].slice(0, limit),
  };
}

/** In-memory `CheckpointReceiptRepositoryPort` for adapter tests. */
export function createInMemoryReceiptRepository(): CheckpointReceiptRepositoryPort {
  const rows = new Map<string, CheckpointReceipt>();
  const key = (threadId: string, ns: string, checkpointId: string): string => `${threadId}::${ns}::${checkpointId}`;
  return {
    async record(input) {
      const existing = rows.get(key(input.threadId, input.checkpointNamespace, input.checkpointId));
      if (existing !== undefined) return existing;
      const record: CheckpointReceipt = {
        taskId: input.taskId,
        threadId: input.threadId,
        checkpointNamespace: input.checkpointNamespace,
        checkpointId: input.checkpointId,
        admissionId: input.admissionId,
        source: input.source,
        recordedAt: fixtureTime(input.now),
      };
      rows.set(key(input.threadId, input.checkpointNamespace, input.checkpointId), record);
      return record;
    },
    latestForTask: async (taskId) => [...rows.values()].filter((row) => row.taskId === taskId).at(-1),
    listForTask: async (taskId) => [...rows.values()].filter((row) => row.taskId === taskId),
    list: async (limit) => [...rows.values()].slice(0, limit),
  };
}

/**
 * In-memory `ArtifactRepositoryPort` for adapter tests.
 *
 * Mirrors the durable repository's shape (a fresh, random `artifactId` per
 * `putArtifact` call, never content-deduplicated) without touching disk.
 */
export function createInMemoryArtifactRepository(
  options: {
    /**
     * Simulate the real store's one failure mode: `putArtifact` throws
     * `TaviError("UNSUPPORTED", ...)`, matching a store with no configured
     * artifacts directory (as `--in-memory` CLI mode is). Lets a caller
     * exercise "archiving is configured but unavailable" without a real
     * `SqliteStore`.
     */
    readonly unsupported?: boolean;
  } = {},
): ArtifactRepositoryPort {
  const records = new Map<string, ArtifactRecord>();
  const bodies = new Map<string, Uint8Array>();
  return {
    async putArtifact(input) {
      if (options.unsupported === true) {
        throw new TaviError("UNSUPPORTED", "No artifacts directory is configured for this store");
      }
      const bytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
      const artifactId = `art-${randomUUID()}`;
      const record: ArtifactRecord = {
        artifactId,
        workspaceId: input.workspaceId,
        runId: input.runId ?? null,
        relativePath: `${input.workspaceId}/${artifactId}.${(input.extension ?? "bin").replace(/[^a-z0-9]/gi, "")}`,
        contentType: input.contentType,
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        reviewState: input.reviewState ?? "approved",
        reviewedBy: input.reviewedBy ?? null,
        reviewedAt: input.reviewedBy === undefined ? null : new Date().toISOString(),
        ...definedOnly({
          fileName: input.fileName,
          folderCopy: input.folderCopy,
          fold: input.fold,
          preview: input.preview,
          derivedFrom: input.derivedFrom,
          purpose: input.purpose,
        }),
        ...(input.untrusted === true ? { untrusted: true as const } : {}),
        ...(input.label === undefined ? {} : { label: input.label }),
      };
      records.set(artifactId, record);
      bodies.set(artifactId, bytes);
      return record;
    },
    getArtifact: async (artifactId) => records.get(artifactId),
    readArtifactBody: async (artifactId) => bodies.get(artifactId),
    listPendingReview: async (workspaceId, limit) =>
      [...records.values()].filter((record) => record.workspaceId === workspaceId && record.reviewState === "pending").slice(0, limit),
    derivedPreviewExists: async (workspaceId, source) =>
      [...records.values()].some(
        (record) => record.workspaceId === workspaceId && record.derivedFrom === source && record.preview !== undefined,
      ),
    async setReviewState(input) {
      const record = records.get(input.artifactId);
      if (record === undefined) {
        throw new TaviError("NOT_FOUND", `No artifact ${input.artifactId}`);
      }
      if (record.reviewState !== "pending") {
        throw new TaviError("CONFLICT", `Artifact ${input.artifactId} already has a terminal review state (${record.reviewState})`);
      }
      records.set(input.artifactId, {
        ...record,
        reviewState: input.reviewState,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        ...(input.note === undefined ? {} : { reviewNote: input.note }),
      });
    },
  };
}

/**
 * In-memory `AgentMailboxRepositoryPort` for `agent-communication`/
 * `workflow` adapter tests. `claim`/`acknowledge` are stubs that throw —
 * every current test drives delivery through `insertEnvelope`/
 * `listByCorrelation` directly; extend here (not in a test file) if a test
 * needs real lease semantics.
 */
export function createInMemoryAgentMailboxRepository(): AgentMailboxRepositoryPort {
  const rows = new Map<string, AgentMailboxEnvelopeRecord>();
  return {
    insertEnvelope: async (envelope) => {
      if (rows.has(envelope.messageId)) throw new TaviError("CONFLICT", `duplicate message id ${envelope.messageId}`);
      rows.set(envelope.messageId, envelope);
    },
    getEnvelope: async (messageId) => rows.get(messageId),
    // Oldest first, as the store lists them; insertion order breaks a tie.
    listPending: async (taskId, limit) =>
      [...rows.values()]
        .filter((r) => r.recipientTaskId === taskId && r.deliveryState === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit),
    listByCorrelation: async (correlationId) => [...rows.values()].filter((r) => r.correlationId === correlationId),
    // Oldest first, as the store's `claim`; insertion order breaks a tie.
    claim: async ({ taskId, limit, leaseId, leaseExpiresAt }) => {
      const taken = [...rows.values()]
        .filter((r) => r.recipientTaskId === taskId && r.deliveryState === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
      return taken.map((r) => {
        const next = { ...r, deliveryState: "delivered" as const, leaseId, leaseExpiresAt };
        rows.set(r.messageId, next);
        return next;
      });
    },
    acknowledge: async ({ taskId, leaseId, messageIds }) => {
      for (const id of messageIds) {
        const r = rows.get(id);
        if (r === undefined || r.recipientTaskId !== taskId || r.leaseId !== leaseId || r.deliveryState !== "delivered") continue;
        const { leaseId: _lease, leaseExpiresAt: _expiry, ...rest } = r;
        rows.set(id, { ...rest, deliveryState: "acknowledged" });
      }
    },
    // Insertion order stands in for the store's creation order, newest last.
    claimForTurn: async ({ taskId, leaseId, limit, readLeases }) => {
      const mine = (): AgentMailboxEnvelopeRecord[] => [...rows.values()].filter((r) => r.recipientTaskId === taskId);
      const countPending = (): number => mine().filter((r) => r.deliveryState === "pending").length;
      const held = mine()
        .filter((r) => r.deliveryState === "delivered" && r.leaseId === leaseId)
        .reverse();
      // A re-run of this admission: exactly what it held, nothing newer.
      if (held.length > 0) return { envelopes: held, more: countPending() };
      // What a turn that died between its claim and its settle still holds.
      const read = new Set(readLeases ?? []);
      for (const r of mine()) {
        if (r.deliveryState !== "delivered" || r.leaseId === undefined || !r.leaseId.startsWith("mailbox-")) continue;
        const { leaseId: stale, leaseExpiresAt: _expiry, ...rest } = r;
        rows.set(r.messageId, { ...rest, deliveryState: read.has(stale) ? "acknowledged" : "pending" });
      }
      const pending = mine()
        .filter((r) => r.deliveryState === "pending")
        .reverse();
      const fresh = pending.slice(0, Math.max(0, limit));
      const claimed = fresh.map((r) => {
        const { leaseExpiresAt: _expiry, ...rest } = r;
        const next = { ...rest, deliveryState: "delivered" as const, leaseId };
        rows.set(r.messageId, next);
        return next;
      });
      return { envelopes: claimed, more: pending.length - fresh.length };
    },
    releaseClaim: async ({ taskId, leaseId, messageIds }) => {
      for (const r of [...rows.values()]) {
        if (r.recipientTaskId !== taskId || r.leaseId !== leaseId || r.deliveryState !== "delivered") continue;
        if (messageIds !== undefined && !messageIds.includes(r.messageId)) continue;
        const { leaseId: _lease, leaseExpiresAt: _expiry, ...rest } = r;
        rows.set(r.messageId, { ...rest, deliveryState: "pending" });
      }
    },
    acknowledgeBefore: async (taskId, before) => {
      let count = 0;
      for (const r of [...rows.values()]) {
        if (r.recipientTaskId !== taskId || (r.deliveryState !== "pending" && r.deliveryState !== "delivered") || r.createdAt >= before)
          continue;
        const { leaseId: _lease, leaseExpiresAt: _expiry, ...rest } = r;
        rows.set(r.messageId, { ...rest, deliveryState: "acknowledged" });
        count += 1;
      }
      return count;
    },
    listSent: async ({ senderTaskId, recipientTaskId, kind, since }) =>
      [...rows.values()].filter(
        (r) => r.senderTaskId === senderTaskId && r.recipientTaskId === recipientTaskId && r.kind === kind && r.createdAt >= since,
      ),
    setDeliveryState: async (messageId, state) => {
      const r = rows.get(messageId);
      if (r !== undefined) rows.set(messageId, { ...r, deliveryState: state });
    },
    setRetentionState: async (messageId, state) => {
      const r = rows.get(messageId);
      if (r !== undefined) rows.set(messageId, { ...r, retentionState: state });
    },
  };
}

/**
 * In-memory `AgentWaitRepositoryPort`, matching the real SQLite
 * repository's documented semantics exactly — in particular `prepare`'s
 * `ON CONFLICT ... DO NOTHING` idempotency (a replayed LangGraph node can
 * call `prepare` more than once for the same deterministic `waitId`) and
 * "at most one active wait per task" (migration `0016`, enforced here only
 * in the sense that `getActiveByTask` picks the first match — a caller
 * relying on the DB-level uniqueness constraint should test against the
 * real `SqliteStore` instead, see `packages/runtime/test/agent-mailbox-store.test.ts`).
 */
export function createInMemoryAgentWaitRepository(options: { readonly now?: () => string } = {}): AgentWaitRepositoryPort {
  const rows = new Map<string, AgentWaitIntentRecord>();
  /** Settled waits whose resume is pending, by wait id, with when they settled. */
  const pendingResumes = new Map<string, string>();
  /** When each wait settled, in settle order. */
  const settledAt = new Map<string, string>();
  return {
    prepare: async (input) => {
      if (rows.has(input.waitId)) return;
      rows.set(input.waitId, {
        waitId: input.waitId,
        taskId: input.taskId,
        deadlineAt: input.deadlineAt,
        state: "prepared",
        ...definedOnly({
          correlationId: input.correlationId,
          waitingOnWorkerTaskId: input.waitingOnWorkerTaskId,
          choices: input.choices,
          handoff: input.handoff,
        }),
      });
    },
    activate: async (waitId) => {
      const r = rows.get(waitId);
      if (r?.state === "prepared") rows.set(waitId, { ...r, state: "active" });
    },
    get: async (waitId) => rows.get(waitId),
    settle: async ({ waitId, outcome, resume }) => {
      const r = rows.get(waitId);
      if (r === undefined || r.state !== "active") return false;
      rows.set(waitId, { ...r, state: "settled", settledOutcome: outcome });
      // Without a clock, settled at the epoch: past any cutoff a test passes.
      const at = options.now?.() ?? "1970-01-01T00:00:00.000Z";
      settledAt.set(waitId, at);
      if (resume === true) pendingResumes.set(waitId, at);
      return true;
    },
    markResumed: async (waitId) => {
      pendingResumes.delete(waitId);
    },
    listPendingResumes: async (settledBefore) =>
      [...pendingResumes].filter(([, at]) => at <= settledBefore).flatMap(([waitId]) => rows.get(waitId) ?? []),
    listActivePastDeadline: async (now) => [...rows.values()].filter((r) => r.state === "active" && r.deadlineAt <= now),
    getActiveByCorrelation: async (taskId, correlationId) =>
      [...rows.values()].find((r) => r.taskId === taskId && r.correlationId === correlationId && r.state === "active"),
    getActiveByTask: async (taskId) => [...rows.values()].find((r) => r.taskId === taskId && r.state === "active"),
    listActiveHandoffs: async () => [...rows.values()].filter((row) => row.state === "active" && row.handoff !== undefined),
    listActiveConnects: async () => [...rows.values()].filter((row) => row.state === "active" && row.connect !== undefined),
    getRecentlySettledByTask: async (taskId, settledSince) =>
      [...settledAt]
        .filter(([waitId, at]) => at >= settledSince && rows.get(waitId)?.taskId === taskId)
        .flatMap(([waitId]) => rows.get(waitId) ?? [])
        .at(-1),
  };
}

/**
 * In-memory `AgentDelegationRepositoryPort` for `agents.spawn` idempotency
 * tests. Given `tasks`, a tree's running workers are read from their status;
 * without, every recorded worker counts as running.
 */
export function createInMemoryAgentDelegationRepository(
  tasks?: TaskRepositoryPort,
  mailbox?: Pick<AgentMailboxRepositoryPort, "getEnvelope">,
): AgentDelegationRepositoryPort {
  const rows = new Map<string, AgentDelegationAdmissionRecord>();
  const key = (workspaceId: string, principalId: string, operationKey: string): string => `${workspaceId}::${principalId}::${operationKey}`;
  return {
    listChildren: async (workspaceId, parentTaskId, limit) =>
      [...rows.values()]
        .filter((row) => row.workspaceId === workspaceId && row.parentTaskId === parentTaskId)
        .sort((a, b) => a.workerTaskId.localeCompare(b.workerTaskId))
        .slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(201, Math.floor(limit))) : 201),
    recordSpawn: async (record) => {
      rows.set(key(record.workspaceId, record.principalId, record.operationKey), record);
    },
    countRunningInTree: async (workspaceId, rootTaskId) => {
      let running = 0;
      for (const row of rows.values()) {
        if (row.workspaceId !== workspaceId || (row.rootTaskId ?? row.parentTaskId) !== rootTaskId) continue;
        const status = tasks === undefined ? undefined : (await tasks.get(row.workerTaskId))?.status;
        if (status === undefined ? tasks === undefined : !["completed", "failed", "stopped", "cancelled"].includes(status)) running += 1;
      }
      return running;
    },
    getByOperationKey: async (workspaceId, principalId, operationKey) => rows.get(key(workspaceId, principalId, operationKey)),
    getByWorkerTaskId: async (workerTaskId) => [...rows.values()].find((r) => r.workerTaskId === workerTaskId),
    listRunningInTree: async (workspaceId, rootTaskId, limit) => {
      const running: { workerTaskId: string; agentDefinitionId?: string; status: string }[] = [];
      for (const row of rows.values()) {
        if (row.workspaceId !== workspaceId || (row.rootTaskId ?? row.parentTaskId) !== rootTaskId) continue;
        const status = tasks === undefined ? "running" : (await tasks.get(row.workerTaskId))?.status;
        if (status === undefined || ["completed", "failed", "stopped", "cancelled"].includes(status)) continue;
        running.push({
          workerTaskId: row.workerTaskId,
          ...(row.agentDefinitionId === undefined ? {} : { agentDefinitionId: row.agentDefinitionId }),
          status,
        });
      }
      return running.slice(0, Math.max(1, limit));
    },
    // Reads the task's status, not its last update: an in-memory task keeps none to compare with `since`.
    listUnannouncedEnded: async (_since, limit) => {
      if (tasks === undefined || mailbox === undefined) return [];
      const ended: string[] = [];
      for (const row of rows.values()) {
        if (row.parentTaskId === undefined) continue;
        const status = (await tasks.get(row.workerTaskId))?.status;
        if (status !== "completed" && status !== "failed") continue;
        const last = (await tasks.listAdmissions(row.workerTaskId)).at(-1)?.admissionId ?? row.workerTaskId;
        if ((await mailbox.getEnvelope(`worker-result-${last}`)) === undefined) ended.push(row.workerTaskId);
      }
      return ended.slice(0, Math.max(1, limit));
    },
  };
}

/**
 * Admits a task with a fixed id directly against a `TaskRepositoryPort`,
 * for agent-communication/peer-messaging tests that need two or more
 * independent sibling tasks to already exist rather than being created
 * through a scripted model turn. Shared here rather than
 * duplicated (and, for the sibling `createAccess` fixture, inconsistent)
 * across `agent-communication.test.ts` and `agent-communication-peer.test.ts`.
 * `prompt` is the selection policy the task is bound under.
 */
export async function admitFixtureTask(
  tasks: TaskRepositoryPort,
  taskId: string,
  prompt: PromptSelectionPolicy,
  options: { readonly workspaceId?: string; readonly principalId?: string; readonly now?: () => string } = {},
): Promise<void> {
  const now = options.now ?? (() => "2026-01-01T00:00:00.000Z");
  await tasks.admit({
    workspaceId: options.workspaceId ?? "w1",
    principalId: options.principalId ?? "alice",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: null,
    checkpointNamespace: "",
    newTaskId: taskId,
    newAdmissionId: `adm-${taskId}`,
    newThreadId: `thread-${taskId}`,
    now: now(),
    prompt,
  });
}

/** A prompt's SHA-256, hex: the computation `systemPromptHash` (`@tavi/agent-host/system-prompt`) and the store make. */
function promptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixtureTime(time: DatabaseTime): string {
  return "fixed" in time ? time.fixed : new Date().toISOString();
}

/** Invoked inside admission/binding transactions with authoritative workspace settings. */
function fixturePrompt(
  task: TaskRecord,
  policy: PromptSelectionPolicy,
  boundAt: string,
  settings: WorkspaceSystemPromptRecord | undefined,
): BoundTaskPromptSnapshot {
  const base = { taskId: task.taskId, workspaceId: task.workspaceId, boundAt };
  const hash = promptHash;
  if (policy.explicitPrompt !== undefined)
    return {
      ...base,
      source: "explicit",
      text: policy.explicitPrompt,
      hash: hash(policy.explicitPrompt),
      revision: null,
      templateVersion: null,
    };
  if (settings === undefined || (settings.text === null) !== (settings.hash === null)) {
    throw new TaviError("INTERNAL", "The stored workspace prompt is inconsistent");
  }
  if (settings.text !== null) {
    const digest = hash(settings.text);
    if (settings.hash !== digest) throw new TaviError("INTERNAL", "The stored workspace prompt does not hash to its text");
    return { ...base, source: "workspace", text: settings.text, hash: digest, revision: settings.revision, templateVersion: null };
  }
  const template = policy.builtin;
  return { ...base, source: "builtin", text: template.text, hash: hash(template.text), revision: null, templateVersion: template.version };
}

/** An epoch summary's first line, wherever it sits in a message (an ordinary chat's is inside the context block); group 1 is the epoch. */
export const EPOCH_LINE_PATTERN = /^\[compaction:epoch(?: lossy)?\] epoch (\d+):/m;

/**
 * Whether a message carries a call's context block: the person
 * message it is folded into at send time (it starts with the block),
 * or the user-role `context-…` quoted-data message when it stands alone.
 */
export function isContextBlock(message: { readonly id: string; readonly role: string; readonly text?: string }): boolean {
  return (
    message.role === "user" && (message.id.startsWith(CONTEXT_MESSAGE_PREFIX) || (message.text ?? "").startsWith(CONTEXT_MESSAGE_HEAD))
  );
}

/** The context block's own text in `text` (from its first line to its `[/context]` line), or "". */
function contextBlockIn(text: string): string {
  if (!text.startsWith(CONTEXT_MESSAGE_HEAD)) return "";
  const end = text.indexOf(`\n${CONTEXT_MESSAGE_END}`);
  return end === -1 ? text : text.slice(0, end + 1 + CONTEXT_MESSAGE_END.length);
}

/** A message's text without the context block folded into its front: the person's own words. */
export function withoutContextBlock(text: string): string {
  const block = contextBlockIn(text);
  return block === "" ? text : text.slice(block.length).replace(/^\n\n/, "");
}

/**
 * A request's context block text, or "" when it has none. Under
 * `models.promptLayout` `v2` each turn's block rides on its person message
 * (`contextText`), each showing only what no earlier one did: their blocks
 * joined, oldest first.
 */
export function contextBlockOf(request: ModelRequest | undefined): string {
  const message = request?.messages.find(isContextBlock);
  if (message !== undefined) return contextBlockIn(message.text);
  return (request?.messages ?? [])
    .flatMap((entry) => (entry.role === "user" && entry.contextText !== undefined && entry.contextText !== "" ? [entry.contextText] : []))
    .join("\n\n");
}

/** A request's system text and its context block, joined: what it gave the model besides the conversation. */
export function instructionsAndContextOf(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === "system" || isContextBlock(message) || (message.contextText ?? "") !== "")
    .map((message) =>
      message.role === "system" ? message.text : isContextBlock(message) ? contextBlockIn(message.text) : (message.contextText ?? ""),
    )
    .join("\n");
}
