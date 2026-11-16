import type { ContentLabel } from "../content-label.js";
import { TaviError } from "../errors.js";
import type { TaskExecutionPolicy } from "../execution-policy.js";
import type { ModelError, ModelEvent } from "../model.js";
import type { ModelTarget } from "../models-config.js";
import type { ToolOutputRedactionKind } from "../redaction.js";
import type { ChatMemoryMode, TaskOrigin, TurnChannel } from "../task-origins.js";
import type { CheckpointQueryPort } from "./checkpoint-query.js";
import type { InvocationContext } from "./invocation.js";
import type { AdmissionKind, AdmissionOutcome, ChatKind } from "./tasks.js";
import type { WorkflowInterrupt, WorkflowResumeDecision, WorkflowReviewInterrupt, WorkflowWaitInterrupt } from "./workflow-interrupts.js";

/**
 * One durable admission request.
 *
 * `taskId` targets an existing task for a follow-up transition; absent means the
 * admission creates the task.
 */
export interface AdmitInput {
  /** Explicit connection or model intent, captured before defaults are filled. */
  readonly explicitModelSelection?: boolean;
  /** A task-creating admission's chat instructions (`AdmitRequest.chatInstructions`); ignored on a follow-up. */
  readonly chatInstructions?: { readonly text: string; readonly author: string };
  readonly context: InvocationContext;
  readonly operationKey: string;
  readonly kind: AdmissionKind;
  readonly prompt?: string;
  /** A wake of a chat its person stopped: the turn reports what arrived, and leaves what was stopped alone. */
  readonly afterStop?: boolean;
  readonly resume?: WorkflowResumeDecision;
  readonly taskId?: string;
  /**
   * A **task-creating** admission's task id, reserved by the caller beforehand: a routine's root, whose research
   * worker is spawned beneath it before it exists. Ignored on a follow-up; absent, the adapter mints one.
   */
  readonly newTaskId?: string;
  /** Called once the task identity is durable and before any node runs. */
  readonly onAdmitted?: (admitted: AdmittedTask) => void | Promise<void>;
  /**
   * Called once the admission holds the task's execution slot **and** its
   * preconditions have passed, but before any node runs.
   *
   * `onAdmitted` fires before the serialized region, so it cannot report a
   * precondition: a caller answering an approval needs to know that its round
   * claim was accepted rather than merely that a task row exists. A refusal
   * after this point is a node failure, not a claim failure.
   *
   * Never called for an admission that replays a recorded outcome, or for one
   * short-circuited by a cancellation: nothing is claimed in either case. An
   * observer — a throw is reported by the adapter and does not abandon the claim.
   */
  readonly onClaimed?: (claimed: AdmittedTask) => void;
  /**
   * Who is admitting this work, recorded on a newly created task.
   *
   * Read back by the approval path to decide whether a round is an operator's
   * to answer or belongs to a schedule fire that is still in flight.
   */
  readonly origin?: TaskOrigin;
  /** Present exactly when `origin` is `"schedule"`; a mismatch is refused. */
  readonly originScheduleId?: string;
  /** What chat a **task-creating** admission makes; ignored on a follow-up. */
  readonly chatKind?: ChatKind;
  /** A side chat's parent, with `chatKind: "side"`. */
  readonly parentChatId?: string;
  /** A **task-creating** admission's memory mode: `private` is set here or never. */
  readonly memoryMode?: ChatMemoryMode;
  /**
   * A **task-creating** admission's background (a side chat's seed), put in
   * the conversation ahead of the prompt — context the model
   * reads, never the person's prompt nor a transcript entry. Ignored on a
   * follow-up; blank parts are none.
   */
  readonly seed?: ChatSeed;
  /**
   * The notices posted into the chat since its last turn, as the one
   * bounded, labelled data block `noticeContextNote` builds: put in the
   * conversation as a user-role message ahead of this admission's prompt.
   * Only an admission with a prompt carries it — a notice never starts a turn.
   */
  readonly notices?: string;
  /**
   * What the run output `notices` quotes carries: the join of its source
   * runs' context labels (a schedule's result posted into Home). Set on the
   * notices block, so it stays in the chat's label after this turn (sticky),
   * as a worker's result does. Absent, the block taints only its own turn.
   */
  readonly noticesLabel?: ContentLabel;
  /**
   * What a channel admitted that is not the task's person's own words:
   * another group member's message, a
   * forward, an email's quoted or forwarded part, an email the provider could
   * not verify. Each is put in the conversation after the prompt as an
   * `inbound-…` quoted-data block carrying its `label`, so it taints (sticky)
   * and is never the prompt, the retrieval query or an epoch summary's
   * request. An admission with these and no prompt still runs a turn (a group
   * member spoke). Ignored on a resume; blank texts are none.
   */
  readonly inbound?: readonly InboundBlock[];
  /**
   * What started a **task-creating** admission from outside: a webhook
   * call's payload, an email. Put in the conversation after the prompt as a
   * `trigger-…` quoted-data block carrying its `label`, so it taints (sticky),
   * is never the prompt, and — unlike an inbound block — makes none of its
   * URLs known. Ignored on a resume; a blank text is none.
   */
  readonly trigger?: InboundBlock;
  /**
   * The execution policy for a **task-creating** admission; ignored on a
   * follow-up, which reads the durable row.
   */
  readonly executionPolicy?: TaskExecutionPolicy;
}

/** One `AdmitInput.inbound` block: whose words they are (`label`), and a short line saying so, written by the host. */
export interface InboundBlock {
  readonly text: string;
  readonly label: ContentLabel;
  /** What the block is, in the runtime's words (`A message from another member of this chat`); never the sender's. */
  readonly heading: string;
}

/**
 * A new chat's background. `system` is a `role: "system"`
 * message — the model adapter lifts it into the leading instructions, so it
 * holds only text the runtime wrote and the person's own requests (a fixed
 * preamble, an epoch summary). `background` is a user-role message of its
 * own, labelled as quoted background: what other text reaches the new chat
 * (a parent's replies) goes there, never into the instructions.
 */
export interface ChatSeed {
  readonly system: string;
  readonly background?: string;
  /**
   * What `background` quotes carries: the parent's
   * checkpointed context label, and a replied-to notice's run's. Joined with
   * `agent` on the background message; absent, it reads as `agent` alone.
   */
  readonly label?: ContentLabel;
}

/** Refuse a parent chat on anything but a side chat: a side chat names the chat it was opened from. */
export function assertChatPairing(input: { readonly chatKind?: ChatKind; readonly parentChatId?: string }): void {
  if (input.parentChatId !== undefined && input.chatKind !== "side")
    throw new TaviError("INVALID_INPUT", 'parentChatId is only valid when chatKind is "side"');
  if (input.chatKind === "side" && input.parentChatId === undefined)
    throw new TaviError("INVALID_INPUT", 'chatKind "side" needs the parentChatId of the chat it was opened from');
}

/**
 * Refuse an origin and schedule id that do not pair.
 *
 * The pairing is stated as an invariant on both `AdmitRequest` and `TaskRecord` —
 * the schedule id is present *exactly* when the origin is `"schedule"` — and the
 * approval path reads `origin === "schedule"` plus the id to decide whether a
 * round belongs to a fire still in flight. Both directions are refused: a
 * schedule id under another origin is a well-typed lie, and a schedule origin
 * with no id names no fire, so its rounds could never be attributed.
 */
export function assertOriginPairing(input: { readonly origin?: TaskOrigin; readonly originScheduleId?: string }): void {
  if (input.originScheduleId !== undefined && input.origin !== "schedule") {
    throw new TaviError("INVALID_INPUT", 'originScheduleId is only valid when origin is "schedule"');
  }
  if (input.origin === "schedule" && input.originScheduleId === undefined) {
    throw new TaviError("INVALID_INPUT", 'origin "schedule" needs the originScheduleId of the schedule that fired');
  }
}

export interface AdmittedTask {
  readonly taskId: string;
  readonly threadId: string;
  readonly admissionId: string;
  readonly created: boolean;
  /** The first turn of a task that had none, so it begins the task's stream. */
  readonly firstTurn?: true;
}

export interface AdmissionResult {
  readonly taskId: string;
  readonly threadId: string;
  readonly outcome: AdmissionOutcome;
  /** False when the retry resolved an existing task and admission. */
  readonly created: boolean;
  /** True when the outcome came from the durable record rather than a fresh run. */
  readonly replay: boolean;
}

export type WorkflowPort = {
  /**
   * The single admission path for starts, replies, approvals, deadlines and
   * cancellation.
   *
   * Task creation and the admission intent commit together under the caller's
   * operation key; an admission that already has a durable outcome is answered
   * from that record instead of being re-run.
   */
  admit(input: AdmitInput, options?: WorkflowInvokeOptions): Promise<AdmissionResult>;
  /**
   * A person's Home, started with no turn in it: something is on its way there and they have never
   * written in one. Its task, the same one for a repeated call.
   */
  openHome?(input: { readonly workspaceId: string; readonly principalId: string }): Promise<string>;
  /**
   * The single admission path is `admit`.
   *
   * There is deliberately no separate "invoke this thread" operation: a caller
   * able to advance a task without taking its execution slot would make the
   * serialization guarantee unenforceable.
   */
  readonly checkpoints: CheckpointQueryPort;
};

/** A tool dispatch transition observed by the caller of an admission. */
export interface ToolDispatchEvent {
  /** The checkpointed model attempt that requested this call, including after approval resume. */
  readonly attemptId?: string;
  readonly phase: "started" | "completed" | "failed";
  readonly callId: string;
  readonly toolName: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly message?: string;
  readonly durationMs?: number;
  /** On `completed`: the credential shapes masked in `output`, by kind. */
  readonly redacted?: Readonly<Partial<Record<ToolOutputRedactionKind, number>>>;
}

/** The model errors a call fails over on: a rate limit, a provider fault. */
export type FailoverCode = Extract<ModelError["code"], "rate_limit" | "provider" | "model_retired" | "model_unavailable">;

/**
 * A model call's failover to the next target of its chain, or its
 * retry on the same target after a context-overflow refusal.
 */
export interface ModelFailoverEvent {
  readonly attemptId: string;
  readonly supersededAttemptId: string;
  readonly from: ModelTarget;
  readonly to: ModelTarget;
  /** The superseded attempt's error: a `FailoverCode`, or `invalid_request` for a context-overflow retry. */
  readonly errorCode: ModelError["code"];
  /** Operator-facing: what failed and where the call went. */
  readonly reason: string;
}

export interface WorkflowInvokeOptions {
  /**
   * Observe model transport events for this admission.
   *
   * Deltas are advisory and may be coalesced or dropped; the caller must not
   * treat them as a durable record.
   */
  readonly onModelEvent?: (event: ModelEvent) => void;
  /**
   * Observe governed tool dispatch.
   *
   * Only the graph knows whether a requested call was actually dispatched or
   * denied, so tool client events originate here rather than from the transport.
   */
  readonly onToolEvent?: (event: ToolDispatchEvent) => void | Promise<void>;
  /**
   * A model call failed over to the next target of its chain, as a
   * new attempt: `attemptId` replaces `supersededAttemptId`, whose partial
   * output is discarded. Called before the new attempt's first event.
   */
  readonly onFailover?: (event: ModelFailoverEvent) => void;
  /**
   * A message the person sent into this running turn was merged
   * before the model call about to be made: `messageId` is the reply's own
   * `clientMessageId`. A model call retried after a crash may report it again.
   */
  readonly onSteer?: (event: { readonly messageId: string; readonly text: string }) => void;
  /** Plugins' suggestions for what to do next, at the turn's end: at most 3. */
  readonly onSuggestions?: (suggestions: readonly string[]) => void;
  /**
   * A model call of this admission answered with memory in its context:
   * the evidence revisions it was given,
   * and how many preferences applied. Once per answered call; never for a
   * delegated worker's, which records no memory use of its own.
   */
  readonly onMemoryUsed?: (event: {
    readonly records: readonly { readonly recordId: string; readonly revisionId: string }[];
    readonly preferences: number;
  }) => void;
  /**
   * A model call of this admission ran in a tainted conversation: the
   * sticky taint — a tool's untrusted output, a side chat's background, an
   * agent mailbox or a plugin's untrusted context, read in this turn or any
   * before it — or this turn's notices block. The saved turn is then marked
   * `tainted`, and automatic capture and auto-approve leave it out. Called
   * before each such call streams, and after a tool round that taints the
   * turn, with the conversation's known URLs (the `knownUrls` channel, as it
   * stands then): the canvas disarms a novel link in the turn's answer.
   */
  readonly onUntrustedInput?: (knownUrls: readonly string[]) => void;
  /**
   * This admission's turn is held to a channel: `messaging` when it
   * came in from a messaging conversation, or resumes one that did. The saved
   * turn records it, and automatic capture leaves it out (invariant 6).
   * Called once, before the turn runs.
   */
  readonly onHeldChannel?: (channel: TurnChannel) => void;
  readonly signal?: AbortSignal;
  /**
   * Execution lease for this admission.
   *
   * Nodes re-check it before a side effect, so a delayed invocation that lost
   * ownership cannot dispatch against a task a replacement now owns (stale
   * callbacks are refused).
   */
  readonly executionLease?: {
    readonly taskId: string;
    readonly generation: number;
    readonly admissionId: string;
  };
}

export type WorkflowInvocationResult = {
  readonly status: "completed" | "waiting" | "failed" | "stopped";
  readonly finalText: string;
  readonly interrupt?: WorkflowInterrupt;
  /** See `AdmissionOutcome.waitInterrupt` — set instead of `interrupt` for a wait suspension. */
  readonly waitInterrupt?: WorkflowWaitInterrupt;
  /** See `AdmissionOutcome.reviewInterrupt` — set instead of `interrupt`/`waitInterrupt` for an artifact-review suspension. */
  readonly reviewInterrupt?: WorkflowReviewInterrupt;
  readonly error?: { readonly code: string; readonly message: string };
  /** See `AdmissionOutcome.channelReply`. */
  readonly channelReply?: AdmissionOutcome["channelReply"];
  readonly checkpointId?: string;
};
