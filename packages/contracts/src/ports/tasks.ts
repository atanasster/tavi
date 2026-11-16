import { z } from "zod";
import type { PromptSelectionPolicy, SerializableAdmitRequest } from "../async-persistence.js";
import type { TaskExecutionPolicy } from "../execution-policy.js";
import type { AsyncRepository } from "../persistence-types.js";
import type { BoundTaskPromptSnapshot, TaskPromptSnapshotRecord } from "../system-prompts.js";
import type { ChatMemoryMode, TaskOrigin } from "../task-origins.js";
import type { TaskSummaryState } from "../task-summaries.js";
import type { ToolCallActivity, ToolCallActivityQuery } from "./effects.js";
import type { InvocationContext } from "./invocation.js";
import type { WorkflowInterrupt, WorkflowReviewInterrupt, WorkflowWaitInterrupt } from "./workflow-interrupts.js";

/**
 * Canonical JSON for an admission identity.
 *
 * Keys are sorted and `undefined` dropped, so two spellings of the same request
 * compare equal. Admission identity depends on this being stable, and both the
 * durable and the in-memory repositories must agree on it, so it lives here
 * rather than in either implementation.
 */
export function canonicalizeAdmission(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalizeAdmission).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeAdmission(entry)}`).join(",")}}`;
}

/**
 * The exact identity of an admission.
 *
 * The kind is part of the identity, not a label on it: the same operation key
 * used for a `cancel` and a `start` are different requests, and resolving one to
 * the other's outcome would let a cancellation silently inherit a start's result.
 */
export function admissionIdentity(kind: AdmissionKind, intent: unknown): string {
  return canonicalizeAdmission({ kind, intent: intent ?? null });
}

/** Bound on a stored admission intent or result, in UTF-8 bytes. */
export const MAX_ADMISSION_PAYLOAD_BYTES = 256 * 1024;
/**
 * Durable task identity.
 *
 * The task maps a stable id to a persisted graph thread and namespace. It is the
 * record a retry resolves to, so a replay can never invent a replacement thread.
 */
export {
  TASK_ORIGINS,
  TaskOriginSchema,
  PLUMBING_ORIGINS,
  PLUMBING_ORIGINS_SQL,
  isPlumbingOrigin,
  isAttendedOrigin,
  isIpcOrigin,
  originCovers,
  TURN_CHANNELS,
  TurnChannelSchema,
  type TaskOrigin,
  type TurnChannel,
  FRONT_ENDS,
  FrontEndSchema,
  type FrontEnd,
  CHAT_MEMORY_MODES,
  ChatMemoryModeSchema,
  type ChatMemoryMode,
} from "../task-origins.js";

/**
 * What a chat is: a workspace's `home`, a
 * `side` chat opened from another, a delegated `worker` (never shown as a
 * chat), or a `run` — a fire of a schedule, routine or reminder, or a
 * standalone `tavi run`. A task recorded before kinds existed has none and is
 * read as an ordinary chat.
 */
export const CHAT_KINDS = ["home", "side", "worker", "run"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/** How long a private chat's saved turns are kept after its last turn. */
export const PRIVATE_CHAT_KEEP_MS = 24 * 60 * 60 * 1_000;

/**
 * The statuses a task row holds (`tavi_tasks.status`). `stopped`: the person stopped its turn (Stop, `Esc`,
 * `tavi abort`). No turn runs and nothing is broken; unlike `cancelled`, which is final, a reply goes on in the same
 * chat, and nothing takes a turn in it until one does.
 */
export const TASK_STATUSES = ["admitted", "running", "waiting", "completed", "failed", "stopped", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly checkpointNamespace: string;
  readonly status: TaskStatus;
  readonly finalText: string | null;
  /** The caller operation key that created this task, when one was supplied. */
  readonly creationOperationKey: string | null;
  /** Who admitted this task, and (for a schedule) which schedule fired it. */
  readonly origin: TaskOrigin | null;
  readonly originScheduleId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The title — the reader's rename (`titleRenamed`), else the generated one —
   * and the generated one-line summary, null
   * before one exists, and where the summary stands. Optional: a record built
   * anywhere but the store has none.
   */
  readonly title?: string | null;
  /** The title is the reader's rename (`0080`), not the generated one. */
  readonly titleRenamed?: boolean;
  readonly summary?: string | null;
  readonly summaryState?: TaskSummaryState | null;
  /**
   * The trusted execution policy this task was created with.
   *
   * Always present: a row that predates the column reads as the conservative
   * unattended policy rather than as "unknown", because "unknown" would have to
   * be resolved somewhere and the safe resolution has to be chosen anyway.
   */
  readonly executionPolicy: TaskExecutionPolicy;
  /** What chat this task is; absent for a task recorded before kinds, read as an ordinary chat. */
  readonly chatKind?: ChatKind;
  /** The chat a side chat was opened from. */
  readonly parentChatId?: string;
  /** The chat's own memory mode; absent, memory is on. A worker's is its chat's, read through its delegation. */
  readonly memoryMode?: ChatMemoryMode;
  /** When memory was last turned back on for the chat (`0132`): nothing said before it is captured. */
  readonly memoryOnAt?: string;
}

/**
 * What an admission requests. Only the workflow service admits work, so this
 * enumerates every transition a task can take.
 */
export const ADMISSION_KINDS = ["start", "reply", "approval", "deadline", "cancel"] as const;
export type AdmissionKind = (typeof ADMISSION_KINDS)[number];
export const AdmissionKindSchema = z.enum(ADMISSION_KINDS);

/**
 * `pending` is written with the task in one transaction; `committed` means the
 * admitted step reached a durable result and a replay must not re-run it.
 *
 * `refused` means the admission was claimed but a
 * precondition failed before any node ran — a stale `expectedSteps`, a round
 * already settled, or another front end winning the race. Task status is *not*
 * projected from a refused admission, so a refusal cannot mark a merely
 * suspended task as failed. `tavi_admissions.state` carries no CHECK
 * constraint, so this is a contract change only.
 */
export const ADMISSION_STATES = ["pending", "claimed", "committed", "failed", "refused"] as const;
export type AdmissionState = (typeof ADMISSION_STATES)[number];

export interface AdmissionRecord {
  readonly admissionId: string;
  readonly taskId: string;
  readonly operationKey: string;
  readonly kind: AdmissionKind;
  /** The exact normalized input this admission was created for. */
  readonly intent: unknown;
  /** Hash of `intent`; a same-key/different-intent retry is a conflict. */
  readonly intentHash: string;
  readonly state: AdmissionState;
  /** Durable outcome of this admission, once it has one. */
  readonly result: AdmissionOutcome | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The chat instructions' revision this admission runs under: the chat's current one for a prompt, the turn's
   * own for an approval, a deadline or a cancel. Absent when the chat had none.
   */
  readonly instructionsRevision?: number;
}

/**
 * The durable outcome of one admission.
 *
 * Persisted so that replaying an admission returns a known receipt instead of
 * re-running work whose effects may already exist.
 */
export interface AdmissionOutcome {
  readonly status: "completed" | "waiting" | "failed" | "stopped";
  readonly finalText: string;
  /**
   * A plugin's `prompt.submit` hook dropped the prompt: no turn ran,
   * and `finalText` says why. Set on the admission that ran, never on a
   * replay of it, so a front end that has to tell the person (a channel,
   * where only the model replies) does so once.
   */
  readonly dropped?: true;
  /**
   * No turn ran: its prompt was dropped, or cancelled while its prompt
   * hooks ran. What the turn would have read — a chat's notices — is not
   * spent. Set as `dropped` is: on the admission that ran, never a replay.
   */
  readonly notRun?: true;
  /**
   * A one-to-one channel chat's answer, to be sent for a completed turn that
   * tried no `messaging.send` or `messaging.send_to` of its own (the channel
   * reply relay): disarmed when the turn read untrusted content, and set only
   * where the gate would let a `messaging.send` of it go without a round.
   * `replyTo` is this turn's own target.
   */
  readonly channelReply?: { readonly content: string; readonly replyTo: NonNullable<InvocationContext["messagingReplyTo"]> };
  readonly interrupt?: WorkflowInterrupt;
  /**
   * Set instead of `interrupt` when the suspension is a wait, not a
   * pending approval — a sibling field rather than a
   * variant of `interrupt`, so existing `interrupt.requests` readers are
   * never handed a wait-shaped payload to misinterpret. Exactly one of
   * `interrupt`/`waitInterrupt`/`reviewInterrupt` is ever set on a
   * `"waiting"` outcome.
   */
  readonly waitInterrupt?: WorkflowWaitInterrupt;
  /**
   * Set instead of `interrupt`/`waitInterrupt` when the suspension is an
   * artifact review — a turn produced one or more
   * `pending`-review artifacts (a sandboxed command's archived output, a
   * browser screenshot/download) and is blocked until an operator decides.
   * Unlike `interrupt` (deciding whether a call may run at all, before it
   * runs), this decides whether an already-produced result may be trusted
   * — a sibling suspension kind, not a variant of either existing one.
   */
  readonly reviewInterrupt?: WorkflowReviewInterrupt;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AdmitRequest {
  readonly workspaceId: string;
  readonly principalId: string;
  /**
   * Who is admitting this work, recorded on a newly created task.
   *
   * Absent on a follow-up transition, which keeps the origin the task was
   * created with: a resume does not change who owns a round.
   */
  readonly origin?: TaskOrigin;
  /** Present exactly when `origin` is `"schedule"`. */
  readonly originScheduleId?: string;
  /** What chat a **task-creating** admission makes; ignored on a follow-up. */
  readonly chatKind?: ChatKind;
  /** A side chat's parent, with `chatKind: "side"`; ignored on a follow-up. */
  readonly parentChatId?: string;
  /**
   * A **task-creating** admission's memory mode; ignored on a
   * follow-up. A side chat takes the stricter of this and its parent's.
   */
  readonly memoryMode?: ChatMemoryMode;
  /**
   * Target an existing task (a reply, approval, deadline or cancellation).
   *
   * Absent means "create the task"; present means "admit another transition for
   * this task", which is how a suspended approval resumes the same thread.
   */
  readonly taskId?: string;
  /**
   * Caller-supplied idempotency key.
   *
   * A retry with the same key resolves the same task and admission; a retry with
   * the same key but different content is a conflict, never a silent re-run.
   */
  readonly operationKey: string;
  readonly kind: AdmissionKind;
  readonly intent: unknown;
  /**
   * The execution policy for a **task-creating** admission.
   *
   * Ignored on a follow-up (`taskId` present): every later turn reads the
   * durable row, so a reply, wake or approval cannot upgrade what the task was
   * created with. Absent on a creating admission means
   * `DEFAULT_TASK_POLICY` — see that constant for why it is the unattended one.
   */
  readonly executionPolicy?: TaskExecutionPolicy;
  /**
   * Checkpoint namespace the graph will write under.
   *
   * Recorded on the task so the "thread id and namespace" mapping is a real
   * persisted value rather than a constant with no writer.
   */
  readonly checkpointNamespace: string;
  readonly newTaskId: string;
  readonly newAdmissionId: string;
  readonly newThreadId: string;
  readonly now: string;
  /** Static prompt policy; the worker reads authoritative workspace settings in the transaction. */
  readonly prompt: PromptSelectionPolicy;
  /**
   * A **task-creating** admission's chat instructions, saved as the chat's
   * first revision with the task so its first turn runs under them. Ignored on a follow-up; blank is none.
   */
  readonly chatInstructions?: { readonly text: string; readonly author: string };
}

export interface AdmitResult {
  readonly task: TaskRecord;
  readonly admission: AdmissionRecord;
  /** False when an existing task and admission were resolved by the retry. */
  readonly created: boolean;
}

interface TaskRepositoryPortDefinition {
  /**
   * Count an actually dispatched call once per durable round, including read-only tools.
   * `toolId` and `at` are optional: an app's Recent activity lists its reads
   * by them, and a call recorded without them stays without.
   */
  recordToolCall(taskId: string, steps: number, callId: string, toolId?: string, at?: string): void;
  /** A workspace's recorded calls of these tools, newest first: an app's reads. Never the inputs. */
  listCallsForTools(input: ToolCallActivityQuery): readonly ToolCallActivity[];
  /** Create the task and its admission intent in one transaction, or resolve a retry. */
  admit(request: AdmitRequest): AdmitResult;
  /** A person's Home with no turn in it: its task and prompt snapshot, and no admission. The Home they have, if they have one. */
  openHome(request: AdmitRequest): string;
  /**
   * The base this task selected at admission — or, with `admissionId`, the
   * base that admission's turn runs under.
   *
   * A `start` or `reply` admission of an existing task re-resolves the base
   * from the workspace as a new task would and pins it when it differs from
   * the task's latest; an approval, a deadline or a cancel keeps the pin of
   * the turn it resumes. An admission with no pin of its own (the creating
   * one, one of a task whose base is `explicit`) answers the task's own
   * snapshot, as without `admissionId`.
   *
   * `undefined` means the task has **no** snapshot row, which is corruption:
   * the caller must refuse rather than substitute the shipped default.
   *
   * Keyed by task id. `InvocationContext` has no `taskId` field, but
   * `runInvocation` rewrites the context as `{ ...input.context, runId:
   * admitted.task.taskId }`, which is the aliasing the model node already relies
   * on.
   */
  getPromptSnapshot(taskId: string, admissionId?: string): TaskPromptSnapshotRecord | undefined;
  /**
   * Insert one task's selected base, and return the persisted snapshot.
   *
   * Validated before the write, including that the hash
   * matches the text and that the task exists in the same workspace. Immutable
   * per task: re-inserting the identical snapshot is an idempotent retry (the
   * initializer can be replayed inside a retried write transaction), while a
   * *different* snapshot for a task that already has one raises a typed
   * `CONFLICT`.
   *
   * `admit` calls this from inside task creation's transaction so the task, its
   * admission and its snapshot commit together; it opens no transaction of its
   * own.
   */
  putTaskSnapshot(record: BoundTaskPromptSnapshot): BoundTaskPromptSnapshot;
  get(taskId: string): TaskRecord | undefined;
  /**
   * Resolve a task by its creation key.
   *
   * The principal is part of the lookup: a caller operation key is scoped to the
   * identity that supplied it, so one principal can never resolve another
   * principal's task, thread or durable outcome.
   */
  getByOperationKey(workspaceId: string, principalId: string, operationKey: string): TaskRecord | undefined;
  /** The person's Home in a workspace (`chat_kind = 'home'`, one at most): one indexed read. */
  homeOf(workspaceId: string, principalId: string): string | undefined;
  getAdmission(taskId: string, operationKey: string): AdmissionRecord | undefined;
  listAdmissions(taskId: string): readonly AdmissionRecord[];
  /**
   * `listAdmissions(taskId).at(-1)` as one indexed read: the newest admission
   * in creation order, whatever its state or outcome (unlike
   * `latestSettledAdmission`). A worker's result envelope is keyed by it.
   */
  latestAdmission(taskId: string): AdmissionRecord | undefined;
  /**
   * `latestSettledAdmission(listAdmissions(taskId))` as one indexed read: what a
   * decision, a precondition check and a replay need, without loading and
   * parsing a long conversation's whole history.
   */
  latestSettledAdmission(taskId: string): AdmissionRecord | undefined;
  /**
   * Whether a turn of the task runs now — an admission claimed, its result not
   * yet written — as one indexed read, in place of scanning `listAdmissions`.
   */
  hasRunningAdmission(taskId: string): boolean;
  setAdmissionState(admissionId: string, state: AdmissionState): void;
  /** Record the durable outcome; a committed admission is never re-run. */
  setAdmissionResult(admissionId: string, result: AdmissionOutcome | null): void;
  /**
   * Record the outcome, the admission state and the task projection atomically.
   *
   * A crash between the three writes would otherwise leave a committed result
   * with a permanently stale task status, and the replay path returns before it
   * could correct it. `checkpointNamespace`, when given, is recorded with them
   * (`setCheckpointNamespace`).
   */
  commitAdmission(input: {
    readonly admissionId: string;
    readonly taskId: string;
    readonly state: AdmissionState;
    readonly result: AdmissionOutcome;
    readonly checkpointNamespace?: string;
  }): void;
  updateStatus(taskId: string, status: TaskStatus, finalText: string | null): void;
  /** Record the checkpoint namespace the graph actually wrote under. */
  setCheckpointNamespace(taskId: string, checkpointNamespace: string): void;
  list(limit: number): readonly TaskRecord[];
  /**
   * Turn a chat's memory off or back on. Back on records
   * `memoryOnAt`, so nothing said while it was off is captured later. A
   * private chat is refused `CONFLICT` (it stays private); an unknown task is
   * `NOT_FOUND`. Answers the task as it is after the call.
   */
  setMemoryMode(input: { readonly taskId: string; readonly mode: "on" | "off"; readonly now: string }): TaskRecord;
}

export type TaskRepositoryPort = Omit<AsyncRepository<TaskRepositoryPortDefinition>, "admit" | "openHome"> & {
  admit(input: SerializableAdmitRequest): Promise<AdmitResult>;
  openHome(input: SerializableAdmitRequest): Promise<string>;
};

/**
 * Deliberately its own small port rather than folded into
 * `TaskRepositoryPort`: the key is scoped to the spawning actor, not to the
 * worker task itself, the same distinction `TaskRepositoryPort.getByOperationKey`
 * already draws for ordinary task creation. `AgentDelegationAdmissionRecord`
 * itself is Zod-derived in `agent-communication.ts`.
 */
