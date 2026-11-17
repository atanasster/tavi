import { ChannelsPayloadSchema } from "./channels-ipc.js";
import { UiPreferencesPayloadSchema } from "./ui-preferences.js";
import { PluginsPayloadSchema } from "./plugin-registry.js";
import { McpPayloadSchema } from "./mcp-ipc.js";
import { AppsPayloadSchema } from "./connected-apps.js";
import { PluginCommandsPayloadSchema } from "./mods.js";
import { redactToolOutput } from "./redaction.js";
import { RoutinesPayloadSchema, unsupportedRoutinePolicy } from "./routines.js";
import { AGENT_TREE_LIMIT } from "./agent-tree.js";
import { ArtifactsCommandPayloadSchema } from "./artifact-list.js";
import { ReportsPayloadSchema } from "./reports.js";
import { BrowserPayloadSchema } from "./browser-ipc.js";
import { BrowserLiveMessageSchema, BrowserLivePayloadSchema } from "./browser-live.js";
import { ChatContextPayloadSchema, ChatInstructionsTextSchema } from "./chat-instructions.js";
import {
  BrowsePayloadSchema,
  CLIENT_CWD_MAX,
  ChatFolderChoiceSchema,
  FolderPayloadSchema,
  RunFolderAttachmentsSchema,
  type RunFolderResult,
} from "./folder-ipc.js";
import { z } from "zod";

import { TaviError } from "./errors.js";
import { CLIENT_PROTOCOL_VERSION, ClientEventSchema } from "./events.js";
import type { ArtifactRecord } from "./ports/artifacts.js";
import { type AdmissionOutcome, CHAT_MEMORY_MODES } from "./ports/tasks.js";
import type { ApprovalEventRecord, ApprovalRoundRecord } from "./approval-rounds.js";
import { LabelSummarySchema } from "./content-label.js";
import { ApprovalScopeSchema } from "./tool-policy.js";
import { ModelTargetSchema } from "./models-config.js";
import { SystemPromptPayloadSchema } from "./system-prompts.js";
import { WorkspaceSettingsPayloadSchema } from "./workspace-settings.js";
import { CenterPayloadSchema } from "./center.js";
import { MemoryPayloadSchema } from "./memory-ipc.js";
import { SkillsPayloadSchema } from "./skills-ipc.js";
import { RemindersPayloadSchema } from "./reminders-ipc.js";
import { HeartbeatPayloadSchema } from "./heartbeat-ipc.js";
import { IdeasPayloadSchema } from "./ideas-ipc.js";
import { OnboardingPayloadSchema } from "./onboarding-ipc.js";
import {
  APPROVAL_HISTORY_KINDS,
  APPROVAL_HISTORY_MAX_LIMIT,
  APPROVAL_HISTORY_STATES,
  ApprovalHistoryKindSchema,
  ApprovalHistoryStateSchema,
  ApprovalInboxCursorSchema,
  type PendingApprovalRow,
} from "./approval-inbox.js";
import type { AgentMailboxEnvelopeRecord } from "./agent-communication.js";
import type { AgentDefinition } from "./agents.js";
import {
  CredentialsPayloadSchema,
  ExpectTargetSchema,
  ModelsPayloadSchema,
  PermissionsPayloadSchema,
  ProjectsPayloadSchema,
  RouterPayloadSchema,
  SchedulesPayloadSchema,
  SearchPayloadSchema,
} from "./ipc-config.js";
import {
  APPROVAL_NOTE_MAX_CHARS,
  ARTIFACT_REVIEW_NOTE_MAX_CHARS,
  ApprovalRowIdSchema,
  IPC_MAX_MESSAGE_CHARS,
  IPC_MAX_PROMPT_CHARS,
  RESERVED_OPERATION_KEY_MESSAGE,
  isReservedOperationKey,
} from "./ipc-limits.js";
export {
  APPROVAL_NOTE_MAX_CHARS,
  ARTIFACT_REVIEW_NOTE_MAX_CHARS,
  ApprovalRowIdSchema,
  IPC_MAX_CONNECTION_BACKLOG_BYTES,
  IPC_MAX_FRAME_BYTES,
  IPC_MAX_MESSAGE_CHARS,
  IPC_MAX_PROMPT_CHARS,
  IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES,
  IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  IPC_RESERVED_OPERATION_KEY_PREFIX,
  MAX_REVIEW_EVENT_REQUESTS,
  type ApprovalRowId,
} from "./ipc-limits.js";
import { DisplayNameSchema, IdSchema } from "./ids.js";
import { TaskListFiltersSchema, TaskPromptsFiltersSchema } from "./task-list.js";
import { NoticeListFiltersSchema, TranscriptPageFiltersSchema } from "./transcript.js";

/**
 * Local IPC contract.
 *
 * The wire format is deliberately small and versioned: a client and an owner
 * negotiate a protocol version before any command is accepted, and every frame is
 * bounded so a peer cannot make the other side allocate without limit.
 *
 * v2 adds the orchestrator-UI surface: one server-initiated frame (`event`),
 * twelve commands, and a payload schema for every command — new and existing —
 * so no handler reads an unvalidated `unknown`. Commands added since
 * (`search`) are additive: an owner advertises what it implements in
 * `ready.features`, so they need no version.
 *
 * v7 gives `run` a `folder` and a `clientCwd`: an older owner would strip
 * both unread and start the chat in a folder
 * the person did not choose, so a client that sends them is refused by one
 * instead, and a protocol-6 client by this owner. The `folder` and `browse`
 * commands are additive and advertised in `ready.features`.
 *
 * v6 negotiates client event protocol 7 (`plugin.status`,
 * `plugin.notice`, `plugin.state`, `turn.suggested`): an older client would
 * meet a kind it cannot read and fail at its first plugin event, so it is
 * refused at the handshake instead, with the restart remedy.
 *
 * v5 gives `run` a `model` a client chooses: an older owner would
 * strip it unread and run its own default, so a CLI that sends it must be
 * refused by one rather than answered as if the choice had been kept.
 *
 * v4 negotiates the breaking client event v3 (task.spawned), since the
 * handshake has no separate event-version field.
 *
 * v3 gives existing payloads fields an older owner would strip unread — the
 * payload schemas drop unknown keys — rather than refuse: `expectTarget` on
 * `run`, `approvals`, `review` and `schedules run`, whose whole point is to be
 * refused on a mismatch; `review` addressed by artifact alone; `models`
 * fallbacks. A client asserting a target against an owner that cannot check it
 * must be refused with the restart remedy, not answered as if it had passed.
 */

/** Bumped whenever a frame's meaning changes; a mismatch is refused, not guessed. */
export const IPC_PROTOCOL_VERSION = 7;

/** The documented remedy for a pre-connect version mismatch. */
function protocolMismatchMessage(owner: number, client: number): string {
  return `the running \`tavi serve\` speaks protocol ${owner}; this CLI speaks ${client} — ` + "restart the service";
}

const PROTOCOL_MISMATCH_REASON = "protocol-mismatch";

/**
 * The typed error for an owner that speaks another protocol.
 *
 * Raised before connecting when discovery already says so, and after the
 * handshake when the owner's `ready` frame does — one shape for both, and for
 * every client (the runtime's and `@tavi/client`), so a caller reports the
 * remedy the same way whichever check caught it. `UNAVAILABLE` rather than a
 * transport fault: the owner is healthy, it is only the wrong version, so a
 * retry would only present the cookie to an owner that will refuse it.
 */
export function protocolMismatchError(owner: number): TaviError {
  return new TaviError("UNAVAILABLE", protocolMismatchMessage(owner, IPC_PROTOCOL_VERSION), {
    details: { reason: PROTOCOL_MISMATCH_REASON, owner, client: IPC_PROTOCOL_VERSION },
  });
}

/**
 * The typed error for an owner that sent, after an agreed handshake, a frame
 * this client cannot read (`reason`, the codec's): the IPC protocols matched,
 * so it is the events' own version (`CLIENT_PROTOCOL_VERSION`, versioned
 * separately), or a frame past this build's bounds. Reported like a mismatch:
 * reconnecting would replay the same frame and fail the same way.
 */
export function unreadableFrameError(reason: string): TaviError {
  return new TaviError(
    "UNAVAILABLE",
    `the running \`tavi serve\` sent a frame this client cannot read (${reason}); it may be another build ` +
      `(this client reads events of protocol ${CLIENT_PROTOCOL_VERSION}) — restart the service, or upgrade this client`,
    { details: { reason: PROTOCOL_MISMATCH_REASON, frame: reason } },
  );
}

/**
 * The typed error for an authenticated owner that sent a frame out of the
 * protocol's order (`detail`) — a broken owner, not another version, so not
 * a mismatch. Final all the same: it would recur on a reconnect.
 */
export function protocolViolationError(detail: string): TaviError {
  return new TaviError("UNAVAILABLE", `the running \`tavi serve\` broke the IPC protocol (${detail}); restart it`, {
    details: { reason: "protocol-violation", frame: detail },
  });
}

/** Whether `error` is the protocol mismatch `protocolMismatchError` or `unreadableFrameError` builds. */
export function isProtocolMismatch(error: unknown): error is TaviError {
  return error instanceof TaviError && error.details?.["reason"] === PROTOCOL_MISMATCH_REASON;
}

/**
 * The owner's publication directory under its data directory: the
 * backup protocol skips it. Named here, with the files in it, so the owner and
 * every client (`@tavi/client/node`) read the same files.
 */
export const IPC_RUNTIME_DIRECTORY = "runtime";
/** The discovery record (`IpcDiscoverySchema`); a client reads its `endpoint`, never derives one. */
export const IPC_DISCOVERY_FILE = "ipc.json";
/** The bearer cookie, mode `0600`. */
export const IPC_TOKEN_FILE = "ipc.token";
/** Where a Unix owner binds its socket; published to clients as the discovery record's `endpoint`. */
export const IPC_SOCKET_FILE = "ipc.sock";

/**
 * Authentication must complete within this window.
 *
 * A connection that has not authenticated is closed, so an unauthenticated peer
 * cannot hold a slot indefinitely.
 */
export const IPC_AUTH_DEADLINE_MS = 2_000;

/** Concurrent connections one owner serves; beyond this, new connections are refused. */
export const IPC_MAX_CONNECTIONS = 16;

/**
 * Of `IPC_MAX_CONNECTIONS`, how many may be waiting to authenticate at once:
 * peers that never send a cookie cannot hold the slots of clients that do.
 */
export const IPC_MAX_UNAUTHENTICATED_CONNECTIONS = 4;

/**
 * Total connection attempts a client makes, including the first, before it
 * reports failure. So this bound permits two reconnects, not three.
 */
export const IPC_MAX_RECONNECT_ATTEMPTS = 3;

export const IpcHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  /** The bearer cookie, base64 of 32 random bytes. */
  token: z.string().min(1).max(256),
  /** Echoed back so a client can detect an endpoint substitution. */
  sessionId: z.string().min(1).max(128),
  /**
   * `"bridge"` from `tavi ui`'s bridge: what it forwards is a browser page's,
   * which the owner trusts less than a local client. Optional and
   * additive: an owner that does not know it ignores it.
   */
  client: z.literal("bridge").optional(),
});
export type IpcHello = z.infer<typeof IpcHelloSchema>;

export const IpcReadySchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.number().int().positive(),
  /**
   * Echo of the session the client named, so a client can detect that it reached
   * a different endpoint than its discovery record pointed at.
   */
  sessionId: z.string().min(1).max(128),
  /**
   * Command names the owner implements — a **subset** of `IPC_COMMANDS`, supplied
   * by the runtime rather than copied from the constant.
   *
   * The invariant is one-directional: the handshake must never advertise a
   * command the owner cannot serve, but a contract may land before its
   * implementation (`reply` is declared in v2 and implemented once the local
   * connector exists), so advertising less than the constant is correct.
   */
  features: z.array(z.string().max(64)).max(64),
});
export type IpcReady = z.infer<typeof IpcReadySchema>;

export const IpcRequestSchema = z.object({
  type: z.literal("request"),
  /** Client-generated, used to correlate the reply; never a credential. */
  requestId: z.string().min(1).max(128),
  command: z.string().min(1).max(64),
  /** Validated by the command handler against `IpcCommandPayloadSchemas`. */
  payload: z.unknown(),
});
export type IpcRequest = z.infer<typeof IpcRequestSchema>;

export const IpcResponseSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1).max(128),
  ok: z.boolean(),
  /** Present when `ok` is false. */
  error: z
    .object({
      code: z.string().min(1).max(64),
      message: z.string().max(IPC_MAX_MESSAGE_CHARS),
      /**
       * Facts a client acts on beside the code, when a command has them: a
       * decision refused because the round was already settled carries
       * `settled` (`ApprovalSettlementSchema`). A client that does not read it
       * loses nothing.
       */
      details: z.record(z.string().max(64), z.unknown()).optional(),
    })
    .optional(),
  result: z.unknown().optional(),
});
export type IpcResponse = z.infer<typeof IpcResponseSchema>;

/**
 * The only server-initiated frame.
 *
 * A subscription is addressed by id rather than by task so one connection can
 * carry several cursors, and `event` is the already-versioned `ClientEvent` —
 * nothing is added to it for transport.
 */
export const IpcEventSchema = z.object({
  type: z.literal("event"),
  subscriptionId: IdSchema,
  event: ClientEventSchema,
});
export type IpcEvent = z.infer<typeof IpcEventSchema>;

/**
 * A live browser-view message, on a
 * subscription only `browser-live watch` opens. Kept apart from `event` so a
 * frame never enters a task's event ring nor the 8 KiB event cap; and additive,
 * with no protocol bump: only a client that knows it can open such a
 * subscription, and the owner advertises the command in `ready.features`.
 * `seq` counts the subscription's messages; a frame is acknowledged by it.
 */
export const IpcLiveSchema = z.object({
  type: z.literal("live"),
  subscriptionId: IdSchema,
  seq: z.number().int().nonnegative(),
  message: BrowserLiveMessageSchema,
});
export type IpcLive = z.infer<typeof IpcLiveSchema>;

export const IpcFrameSchema = z.discriminatedUnion("type", [
  IpcHelloSchema,
  IpcReadySchema,
  IpcRequestSchema,
  IpcResponseSchema,
  IpcEventSchema,
  IpcLiveSchema,
]);
export type IpcFrame = z.infer<typeof IpcFrameSchema>;

/**
 * Commands an authenticated client may invoke; parity with the CLI surface.
 *
 * Twelve were new in v2 (`run`, `subscribe`, `unsubscribe`, `approve`, `review`,
 * `reply`, `abort`, `agents`, and the `models`/`credentials`/`projects`/
 * `schedules` families), and `search` joined them later.
 * `IPC_COMMANDS` is the *contract's* list; what an owner
 * implements is narrower and travels in `ready.features`.
 */
export const IPC_COMMANDS = [
  "routines",
  "artifacts",
  "tasks",
  "cancel",
  "recover",
  "doctor",
  "approvals",
  "shutdown",
  "run",
  "subscribe",
  "unsubscribe",
  "approve",
  "review",
  "reply",
  "abort",
  "agents",
  "models",
  "router",
  "credentials",
  "channels",
  "ui-preferences",
  "projects",
  "reports",
  "schedules",
  "search",
  "system-prompt",
  "plugins",
  "mcp",
  "apps",
  "permissions",
  "workspace-settings",
  "center",
  "memory",
  "skills",
  "reminders",
  "heartbeat",
  "ideas",
  "onboarding",
  "browser",
  "chat-context",
  "browser-live",
  "reset-instance",
  "plugin-commands",
  "folder",
  "browse",
] as const;
export type IpcCommand = (typeof IPC_COMMANDS)[number];

/**
 * A resume cursor into one task's event stream.
 *
 * `epoch` names the owner session that produced the events, so a reconnecting
 * client can tell "the events I hold are from a dead epoch" from "I asked for a
 * sequence that has been evicted" — the two get the same answer (`resync`), but
 * only the first is unavoidable.
 */
export const IpcCursorSchema = z.object({
  epoch: IdSchema,
  sequence: z.number().int().nonnegative(),
});
export type IpcCursor = z.infer<typeof IpcCursorSchema>;

// ---------------------------------------------------------------------------
// Payload schemas — one per command.
//
// Every payload is parsed at the boundary (`parseCommandPayload`, before the
// owner dispatches), so a handler sees a validated value. The
// record at the bottom is exhaustive over `IpcCommand`: a command with no schema
// fails to typecheck.
// ---------------------------------------------------------------------------

const TaskDocumentPayloadSchema = z.object({
  taskId: IdSchema.optional(),
});
export const TasksPayloadSchema = z.union([
  TaskDocumentPayloadSchema.strict(),
  TaskListFiltersSchema.safeExtend({ action: z.literal("list") }),
  // A task's follow-up prompts, for Activity's expandable line.
  TaskPromptsFiltersSchema.safeExtend({ action: z.literal("prompts") }),
  // A chat's saved history, a page at a time.
  TranscriptPageFiltersSchema.safeExtend({ action: z.literal("transcript") }),
  // A chat's newest notices.
  NoticeListFiltersSchema.safeExtend({ action: z.literal("notices") }),
  // A chat's context label: the header's taint chip. Answers `TaskLabelAnswer`.
  z.strictObject({ action: z.literal("label"), taskId: IdSchema, workspaceId: IdSchema.optional() }),
  // Stop from the browser takeover for a Home, which is never cancelled:
  // the browser handoffs it waits on are withdrawn and it resumes.
  // Answers `{ taskId, withdrawn }`.
  z.strictObject({ action: z.literal("stop-handoff"), taskId: IdSchema, workspaceId: IdSchema.optional() }),
]);
export type TasksPayload = z.infer<typeof TasksPayloadSchema>;

/**
 * `tasks { action: "label" }`'s answer: the chat's
 * context label as the gate reads it now, summarized (`labelSummary`), or
 * `null` when its state cannot be read. The narrowest read a header's taint
 * chip needs, read after each turn.
 */
export const TaskLabelAnswerSchema = z.strictObject({ taskId: IdSchema, contextLabel: LabelSummarySchema.nullable() });
export type TaskLabelAnswer = z.infer<typeof TaskLabelAnswerSchema>;

export const CancelPayloadSchema = z.object({
  taskId: IdSchema,
  reason: z.string().min(1).max(2000),
  operator: z.string().min(1).max(128).optional(),
});

export const RecoverPayloadSchema = z.object({
  taskId: IdSchema,
  /** A number, validated rather than cast: `recover` never checked this before. */
  generation: z.number().int().nonnegative(),
  reason: z.string().max(2000).optional(),
  operator: z.string().min(1).max(128).optional(),
});

export const DoctorPayloadSchema = z.object({}).passthrough();

export const APPROVAL_ACTIONS = ["list", "approve", "reject", "show", "history", "needs", "answer"] as const;

export const ApprovalsPayloadSchema = z
  .object({
    action: z.enum(APPROVAL_ACTIONS),
    /** The task `approve`/`reject` decide; `list` narrows to its pending rows, `history` to its decisions. */
    taskId: IdSchema.optional(),
    /** Address a row directly; `list` reports it, `approve`/`reject` accept it. */
    approvalId: ApprovalRowIdSchema.optional(),
    /** Assert that this is the only pending call, never narrow a multi-call round. */
    callId: IdSchema.optional(),
    workspaceId: IdSchema.optional(),
    limit: z.number().int().positive().max(1000).optional(),
    decidedBy: z.string().min(1).max(128).optional(),
    note: z.string().max(APPROVAL_NOTE_MAX_CHARS).optional(),
    /** `approve`: how long the approval stands. */
    scope: ApprovalScopeSchema.optional(),
    /** `approve`/`reject`: the target the resumed turn is expected to run on. */
    expectTarget: ExpectTargetSchema.optional(),
    /** `list` and `history`: the page after the one that returned it. */
    cursor: ApprovalInboxCursorSchema.optional(),
    /** `history`: which kinds of decision; all three when absent. */
    kinds: z.array(ApprovalHistoryKindSchema).min(1).max(APPROVAL_HISTORY_KINDS.length).optional(),
    /** `history`: which outcomes; every one when absent. */
    states: z.array(ApprovalHistoryStateSchema).min(1).max(APPROVAL_HISTORY_STATES.length).optional(),
    /** `history`: decided at or after. */
    since: z.iso.datetime().optional(),
    /** `history`: decided at or before. */
    until: z.iso.datetime().optional(),
    /** `history`: approvals of this tool only. */
    toolId: z.string().min(1).max(128).optional(),
    /** `history`: items of this person's tasks only. */
    principalId: IdSchema.optional(),
    /** `answer`: the answer to the task's open question — an option's number or label, several for a multi-select, or the person's own words. */
    answer: z
      .string()
      .min(1)
      .max(IPC_MAX_PROMPT_CHARS)
      .refine((text) => text.trim() !== "", { message: "an answer needs text" })
      .optional(),
    /** `answer`: the question's wait, asserting it is still the one open. */
    waitId: z.string().min(1).max(512).optional(),
    /** `needs`: the open questions and browser handoffs of this root chat's delegated workers, at any depth. */
    rootTaskId: IdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.rootTaskId !== undefined && value.action !== "needs")
      context.addIssue({ code: "custom", path: ["rootTaskId"], message: "rootTaskId applies to approvals needs only" });
    if (value.rootTaskId !== undefined && value.taskId !== undefined)
      context.addIssue({ code: "custom", path: ["rootTaskId"], message: "approvals needs takes a taskId or a rootTaskId, not both" });
    if (value.action === "answer") {
      if (value.taskId === undefined)
        context.addIssue({ code: "custom", path: ["taskId"], message: "approvals answer needs the task whose question it answers" });
      if (value.answer === undefined) context.addIssue({ code: "custom", path: ["answer"], message: "approvals answer needs an answer" });
    } else {
      for (const field of ["answer", "waitId"] as const) {
        if (value[field] !== undefined)
          context.addIssue({ code: "custom", path: [field], message: `${field} applies to approvals answer only` });
      }
    }
    // History-only filters are refused elsewhere rather than ignored: a `list`
    // narrowed by a `toolId` it never applied would answer the wrong question.
    if (value.action !== "history") {
      for (const field of ["kinds", "states", "since", "until", "toolId", "principalId"] as const) {
        if (value[field] !== undefined)
          context.addIssue({ code: "custom", path: [field], message: `${field} applies to approvals history only` });
      }
      if (value.cursor !== undefined && value.action !== "list")
        context.addIssue({ code: "custom", path: ["cursor"], message: "cursor applies to approvals list and history only" });
      return;
    }
    if (value.limit !== undefined && value.limit > APPROVAL_HISTORY_MAX_LIMIT) {
      context.addIssue({
        code: "custom",
        path: ["limit"],
        message: `approvals history returns at most ${APPROVAL_HISTORY_MAX_LIMIT} items a page`,
      });
    }
  });

export type ApprovalsPayload = z.infer<typeof ApprovalsPayloadSchema>;

export const ShutdownPayloadSchema = z.object({ reason: z.string().max(500).optional() });

/**
 * `reset-instance`: delete the data directory's state and start again
 * as if just installed. The owner stops, deletes, and starts on the empty
 * directory. `confirm` is the word the person typed, so no stray or partial
 * payload can wipe an instance.
 */
export const RESET_INSTANCE_CONFIRMATION = "reset";
export const ResetInstancePayloadSchema = z.strictObject({ confirm: z.literal(RESET_INSTANCE_CONFIRMATION) });
/** `reset-instance`'s answer, sent before the owner stops. */
export interface ResetInstanceResult {
  readonly resetting: true;
  /** The memory providers other than the built-in a workspace selected: an index one keeps of its own is the plugin's to clear. Absent when none. */
  readonly memoryProviders?: readonly string[];
}

export const RUN_APPROVAL_POLICIES = ["client", "approve", "deny"] as const;

/**
 * Where a `run` goes: `home` into the person's
 * Home — created with the message as its first turn when there is none yet —
 * and `run` a standalone run (`chatKind: "run"`, `tavi run`). Absent: a chat of
 * its own, as before Home.
 */
export const RUN_TARGETS = ["home", "run"] as const;
export type RunTarget = (typeof RUN_TARGETS)[number];

/** A Home's conversation on its workspace's local connection: one per person, never an operation key. */
export const HOME_CONVERSATION_PREFIX = "home:";
export const homeConversationId = (principalId: string): string => `${HOME_CONVERSATION_PREFIX}${principalId}`;

/** Uploaded files one message may name (`artifacts upload`). */
export const MAX_PROMPT_ATTACHMENTS = 5;
/** The attachments a message names: files `artifacts upload` kept, each listed in the prompt as a channel attachment is. */
const PromptAttachmentsSchema = z.array(IdSchema).min(1).max(MAX_PROMPT_ATTACHMENTS);

export const RunPayloadSchema = z
  .object({
    /** Not blank: a run with nothing to say is refused here, as `tavi run` refuses it, not admitted to call a model with nothing. */
    prompt: z
      .string()
      .max(IPC_MAX_PROMPT_CHARS)
      .refine((prompt) => prompt.trim() !== "", { message: "a run needs a prompt" }),
    workspaceId: IdSchema,
    principal: z.string().min(1).max(128),
    /**
     * Required: the client mints it, so a retry after a timeout or a
     * disconnect resolves to the same admission instead of starting a second run.
     * The `schedule:` prefix is reserved for schedule-fired work.
     */
    operationKey: z
      .string()
      .min(1)
      .max(256)
      .refine((key) => !isReservedOperationKey(key), { message: RESERVED_OPERATION_KEY_MESSAGE }),
    /** See `RUN_APPROVAL_POLICIES`; `"client"` leaves each round for the client. */
    approval: z.enum(RUN_APPROVAL_POLICIES),
    /** Refused: provider reasoning is never streamed to clients. */
    includeReasoning: z.boolean().optional(),
    /** Uploaded files the message carries: quoted after the prompt, as a channel attachment is. */
    attachments: PromptAttachmentsSchema.optional(),
    /** The target the client was told to run (`tavi run --connection/--model`); see `ExpectTargetSchema`. */
    expectTarget: ExpectTargetSchema.optional(),
    /**
     * The chat's model, chosen by the person: saved as the chat's own once it
     * is admitted, and run by this turn and every later one, whatever the
     * default. Refused `NOT_CONFIGURED`, before anything is admitted,
     * when no configured connection offers it. Absent, the chat keeps its own,
     * else runs the default. Refused `INVALID_INPUT` with `target: "home"`: Home's
     * model is set with `models set-chat`. An owner that predates it speaks
     * protocol 4 and refuses this client's connection.
     */
    model: ModelTargetSchema.optional(),
    /**
     * The new chat's instructions, drafted before its first message: saved as
     * revision 1 with the task, so the first turn runs under them.
     * Blank is none.
     */
    chatInstructions: ChatInstructionsTextSchema.optional(),
    target: z.enum(RUN_TARGETS).optional(),
    /**
     * A side chat's parent: the run
     * starts a chat opened from this one (`chatKind: "side"`), which begins with
     * background from it and reads its chat notes. Not with `target`: a side
     * chat is neither Home nor a run.
     */
    parentChatId: IdSchema.optional(),
    /**
     * A reply to a notice: with `parentChatId` — the chat the notice was
     * posted into — the side chat's seed also quotes the output of the run the
     * notice is about, as background, never as the person's message.
     */
    fromNoticeId: IdSchema.optional(),
    /**
     * Where the new chat works: its own folder, a host folder under
     * an `--fs-root` by path (a terminal client only: the web bridge never names
     * a path), or a folder `browse` offered on this connection (`pick`).
     * Honoured only when the run creates its task, like `chatInstructions`;
     * refused with `target: "home"`, whose folder is changed with `folder`.
     * Refused before anything is admitted when it cannot be used.
     */
    folder: ChatFolderChoiceSchema.optional(),
    /**
     * Folders the new chat starts with attached, picked before its first
     * message (the canvas's folder chip on an empty chat): each by path from a
     * terminal, or by a token `browse` offered on this connection from the web
     * bridge. Attached by the admission that creates the chat — Home's too,
     * when this message begins it — before its first turn resolves its folder;
     * ignored, with `RunResult.folder.note` saying so, when the chat exists.
     * A path from the web bridge or a token not offered here is refused before
     * anything is admitted.
     */
    folderAttachments: RunFolderAttachmentsSchema.optional(),
    /**
     * The terminal's working directory (`tavi run`, `/side` in `tavi chat`):
     * the new chat's primary folder when it lies under an
     * `--fs-root` and is not the owner's home itself, else the chat works in its
     * own folder and `RunResult.folder.note` says why. Honoured on a
     * task-creating admission from a local client only — refused from the web
     * bridge — and never for Home. `folder` wins over it.
     */
    clientCwd: z.string().min(1).max(CLIENT_CWD_MAX).optional(),
    /**
     * A turn about a heartbeat item: *Do it* (`heartbeatAction: "do"`,
     * the default) seeds it with the item's proposal, *Chat about this*
     * (`"chat"`) with the item quoted — both built by the owner from its own
     * ledger (the prompt sent is not used), and both tainted, since an item
     * carries what the heartbeat saw: the gate asks before anything runs. Into
     * Home (`target: "home"`), or a new chat; never a side chat.
     */
    fromHeartbeatItemId: IdSchema.optional(),
    heartbeatAction: z.enum(["do", "chat"]).optional(),
    /**
     * The idea whose *Try it* this message sends: the new chat is linked to
     * it, an edit of its prompt is kept as an
     * example, and a turn of the chat finishing without failure marks it done. The prompt is
     * what the person sent; nothing else changes about the run. Ignored when the
     * message joins a chat that exists.
     */
    fromIdeaId: IdSchema.optional(),
    /**
     * The new chat's memory: `off`
     * (`tavi chat --no-memory`), or `private` (*New private chat*, `tavi chat
     * --private`), which is set here or never. Honoured only when the run
     * creates its chat; refused with `target`: Home's memory is turned off with
     * `chat-context`, and a standalone run has no memory mode.
     */
    memory: z.enum(CHAT_MEMORY_MODES).optional(),
  })
  .superRefine((value, context) => {
    if (value.memory !== undefined && value.target !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["memory"],
        message:
          value.target === "home"
            ? "a message to Home cannot set its memory; turn it off with /memory off in Home"
            : "a standalone run has no memory mode",
      });
    }
    if (value.heartbeatAction !== undefined && value.fromHeartbeatItemId === undefined) {
      context.addIssue({ code: "custom", path: ["heartbeatAction"], message: "heartbeatAction goes with fromHeartbeatItemId" });
    }
    if (value.fromIdeaId !== undefined && value.target !== undefined) {
      context.addIssue({ code: "custom", path: ["fromIdeaId"], message: "an idea is tried in a new chat, not Home or a standalone run" });
    }
    if (value.fromHeartbeatItemId !== undefined && (value.parentChatId !== undefined || value.target === "run")) {
      context.addIssue({
        code: "custom",
        path: ["fromHeartbeatItemId"],
        message: "Do it runs in Home or a new chat, never a side chat or a standalone run",
      });
    }
    if (value.parentChatId !== undefined && value.target !== undefined) {
      context.addIssue({ code: "custom", path: ["parentChatId"], message: "parentChatId starts a side chat, which takes no target" });
    }
    if (value.fromNoticeId !== undefined && value.parentChatId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["fromNoticeId"],
        message: "fromNoticeId replies in a side chat of the notice's chat: it needs parentChatId",
      });
    }
  });
export type RunPayload = z.infer<typeof RunPayloadSchema>;

/**
 * What `run` answers, once the run can no longer be refused — its
 * task durable — rather than when the turn ends: the turn's events arrive on
 * `subscriptionId`, which `run` opens on the requesting connection from the
 * task's beginning.
 *
 * - `created`: a new run; the subscription carries it from `run.started`.
 * - neither: the same key's run, still in flight; the subscription carries what
 *   this owner still holds of it, then its end.
 * - `replay`: a retry under a committed key; nothing runs again, and the
 *   subscription carries the recorded outcome — only that, after an owner
 *   restart.
 *
 * `replayed` counts the events the subscription replays before it goes live: a
 * client decides the run's outcome on the last of them, or on a live event,
 * never on a suspension an earlier admission ended with. `truncated` says the
 * subscription joined a stream whose start this owner no longer holds (a late
 * attach).
 */
export interface RunResult {
  readonly taskId: string;
  readonly subscriptionId: string;
  readonly created: boolean;
  readonly replay: boolean;
  readonly replayed: number;
  readonly truncated?: boolean;
  /**
   * The run's conversation on its workspace's local connection:
   * what `reply` names to answer a question the task asks. Absent when the
   * workspace has no local connection open, or when the conversation could not
   * be recorded — the run goes on, and its questions cannot be answered by
   * `reply`.
   */
  readonly conversationId?: string;
  /**
   * `false` when the run's `model` could not be saved as the chat's own: the
   * turn runs the chat's earlier model, else the default. Absent otherwise.
   */
  readonly modelSaved?: false;
  /**
   * The new chat's folder, when the run named one or sent `clientCwd`:
   * where it works, and a line to print when the client's directory was not
   * used. Absent for a follow-up and for a run that named neither.
   */
  readonly folder?: RunFolderResult;
}

/**
 * Who answers a task's approval rounds while it runs here: the
 * owner — an IPC run's `"approve"`/`"deny"` loop, or a schedule's fire, in
 * flight — or a client, which asks an operator.
 */
export const ROUND_ANSWERERS = ["owner", "client"] as const;
export type RoundAnswerer = (typeof ROUND_ANSWERERS)[number];

/** A schedule, as a client names the fire of it that answers a task's rounds. */
export interface ScheduleFire {
  readonly scheduleId: string;
  readonly name: string;
}

/**
 * What `subscribe` answers: `replayed` events are replayed before the stream
 * goes live, then a `resync.required` marker when `resync`. `roundsAnsweredBy`
 * is read when the subscription opens; a client asks an operator only for a
 * round the owner leaves to it.
 */
export interface SubscribeResult {
  readonly subscriptionId: string;
  readonly replayed: number;
  readonly resync: boolean;
  readonly truncated: boolean;
  readonly roundsAnsweredBy: RoundAnswerer;
  /**
   * The schedule whose fire answers the task's rounds while it runs, when
   * that is why `roundsAnsweredBy` is `owner`: a client names it on a round it
   * shows read-only, and asks again once the fire has ended.
   */
  readonly schedule?: ScheduleFire;
  /**
   * For a subscription from now (`from` absent): the task's stream position
   * when it opened, so a client that reconnects before any event arrives
   * resubscribes from it and misses nothing. Absent when the subscription named
   * its own `from`, or when the owner held nothing of the task's stream — its
   * beginning is then exactly what the subscription would have received.
   */
  readonly cursor?: IpcCursor;
}

/** One pending approval row of `approvals list`: the row, and its task's projection. */
export interface ApprovalListRow {
  readonly record: {
    readonly approvalId: string;
    readonly taskId: string;
    readonly toolId: string;
    readonly callId: string;
    readonly steps: number;
    readonly createdAt: string;
  };
  /** Absent when the task could not be read; such a row is never listed. */
  readonly task: {
    readonly workspaceId?: string | undefined;
    readonly principalId?: string | undefined;
    readonly status?: string | undefined;
    /** Who started it (`schedule`, `messaging`, …). */
    readonly origin?: string | undefined;
  };
  /**
   * What an inbox card shows, from an owner that
   * has them: the task's title, the call's headline, the round's risk, expiry
   * and chat, and the scopes a decision may carry. Never the call's input.
   */
  readonly taskTitle?: PendingApprovalRow["taskTitle"];
  readonly rootTaskId?: PendingApprovalRow["rootTaskId"];
  readonly principalId?: PendingApprovalRow["principalId"];
  readonly summary?: PendingApprovalRow["summary"];
  readonly risk?: PendingApprovalRow["risk"];
  readonly expiresAt?: PendingApprovalRow["expiresAt"];
  readonly allowedScopes?: PendingApprovalRow["allowedScopes"];
  readonly announcedIn?: PendingApprovalRow["announcedIn"];
  /** Where the round's chat read untrusted content: its label summary, and the line a person reads (`approvalProvenanceLine`). */
  readonly label?: PendingApprovalRow["label"];
  readonly provenance?: string;
  /**
   * The task's chat never ends — a Home, or a messaging conversation's chat
   * — so a `session` grant there lasts a day: the card says "Allow
   * until tomorrow". Absent from an older owner, and where it is false.
   */
  readonly lastingChat?: true;
}

/**
 * What `approvals list` answers. With `taskId`, every pending row of that task
 * (its round is never crowded out by older rows); otherwise the oldest pending
 * rows of the workspace, `truncated` when more remain.
 */
export interface ApprovalsListResult {
  readonly rows: readonly ApprovalListRow[];
  readonly truncated: boolean;
  /** Present when `truncated`, from an owner that pages: pass it back as `cursor` for the next rows. */
  readonly nextCursor?: string;
}

/** `approvals show <task-id>`: the rounds announced to a chat and the audit trail. */
export interface ApprovalsShowResult {
  readonly taskId: string;
  readonly rounds: readonly ApprovalRoundRecord[];
  readonly events: readonly ApprovalEventRecord[];
  /**
   * Every call the task's rounds put to a person, with its full input: a chat
   * announcement is clipped to fit the channel, and this is where the rest is read.
   */
  readonly calls?: readonly {
    readonly steps: number;
    readonly callId: string;
    readonly toolId: string;
    readonly inputs: unknown;
    readonly state: string;
    readonly decidedBy: string | null;
    readonly note: string | null;
  }[];
}

/** The calls of a task's rounds as `tavi approvals show` lists them. */
export function approvalCallsOf(
  records: readonly {
    readonly steps: number;
    readonly callId: string;
    readonly toolId: string;
    readonly inputs: unknown;
    readonly state: string;
    readonly decidedBy: string | null;
    readonly note: string | null;
  }[],
  mask = false,
): NonNullable<ApprovalsShowResult["calls"]> {
  // `tools.redactResults` on: a call's stored inputs are shown masked, as `approval.required` shows them.
  return records.map((record) => ({
    steps: record.steps,
    callId: record.callId,
    toolId: record.toolId,
    inputs: mask ? redactToolOutput(record.inputs).value : record.inputs,
    state: record.state,
    decidedBy: record.decidedBy,
    note: record.note,
  }));
}

export const SubscribePayloadSchema = z.object({
  taskId: IdSchema,
  /**
   * Where to start.
   *
   * Absent means "from now". `"beginning"` replays everything still retained — a
   * fresh client has no cursor to send, and a cursor cannot express "the start"
   * because `IpcCursorSchema.sequence` is non-negative. A cursor that has been
   * evicted yields `resync`.
   */
  from: z.union([IpcCursorSchema, z.literal("beginning")]).optional(),
});
export type SubscribePayload = z.infer<typeof SubscribePayloadSchema>;

export const UnsubscribePayloadSchema = z.object({ subscriptionId: IdSchema });

/** The verdict a round is decided with, when it is not decided per call. */
export const APPROVAL_VERDICTS = ["approve", "reject"] as const;

/**
 * `approve` — a whole round, addressed by task and expected round.
 *
 * `verdict` and `decisions` are alternatives: a simple round is one verdict, a
 * mixed round is the complete call set. `expectedSteps` is the round the client
 * read off its `approval.required` event; the workflow refuses a mismatch rather
 * than deciding a stale round.
 */
export const ApprovePayloadSchema = z
  .object({
    taskId: IdSchema,
    workspaceId: IdSchema,
    expectedSteps: z.number().int().nonnegative().optional(),
    verdict: z.enum(APPROVAL_VERDICTS).optional(),
    decisions: z
      .array(
        z.object({
          callId: IdSchema,
          approved: z.boolean(),
          note: z.string().max(APPROVAL_NOTE_MAX_CHARS).optional(),
          /** How long this call's approval stands; applied only where the call's verdict offered it. */
          scope: ApprovalScopeSchema.optional(),
        }),
      )
      .min(1)
      .max(64)
      .optional(),
    decidedBy: z.string().min(1).max(128).optional(),
    note: z.string().max(APPROVAL_NOTE_MAX_CHARS).optional(),
    /** With `verdict: "approve"`: the scope for every call of the round. */
    scope: ApprovalScopeSchema.optional(),
  })
  .refine((payload) => (payload.verdict === undefined) !== (payload.decisions === undefined), {
    message: "approve needs exactly one of `verdict` or `decisions`",
  });
export type ApprovePayload = z.infer<typeof ApprovePayloadSchema>;

/**
 * What `approve` (and `approvals approve|reject`) answers.
 *
 * The response is settled when the decision is **claimed** — the round
 * precondition passed and the resumed turn holds the task's execution slot — not
 * when the turn ends: the turn's own events follow on the task's stream. A
 * decision identical to one already committed for the round is answered from
 * the record (`replayed`), and nothing runs again.
 */
export interface ApproveResult {
  readonly taskId: string;
  /** The round decided. */
  readonly steps: number;
  /** The key the decision was admitted under: the round's own. */
  readonly operationKey: string;
  readonly decisions: readonly { readonly callId: string; readonly approved: boolean }[];
  /**
   * True when this request ran nothing: an identical decision was already
   * committed for the round (`status` is its recorded outcome), or is running
   * right now under the round's key (no `status`; its end is on the stream).
   */
  readonly replayed: boolean;
  /** For a committed replay, the recorded outcome's status; absent while a turn runs. */
  readonly status?: AdmissionOutcome["status"];
  /**
   * The task's stream position just before this decision's resume was
   * admitted: a subscription `from` it carries exactly the resumed turn. Absent
   * when the owner held nothing of the task's stream — then its beginning is
   * the resumed turn.
   */
  readonly cursor?: IpcCursor;
}

/**
 * Response error codes beyond `TaviErrorCode`: outcomes a
 * client acts on differently from a failure, so each has its own code rather
 * than a message to parse.
 *
 * - `NOT_RUNNING` — `abort` found no running admission for the task.
 * - `NOT_PENDING` — `approve`/`review` found nothing to decide: no such task,
 *   or it is not waiting, is cancelled, is waiting on something else, or its
 *   round was already decided by a resume that never committed. The CLI maps it
 *   to exit 8 (`resumeNotApplicable`), as the offline command does.
 */
export const IPC_NOT_RUNNING = "NOT_RUNNING";
export const IPC_NOT_PENDING = "NOT_PENDING";
/**
 * `approve`/`review`: the task's execution slot is held, so the decision could
 * not run. The round is **still pending** — unlike `CONFLICT`, which means the
 * round was decided (differently) or is no longer the one pending. When the
 * holder is an owner that no longer exists, `tavi recover` frees the slot and the
 * same decision can be sent again.
 */
export const IPC_EXECUTION_BUSY = "EXECUTION_BUSY";

/**
 * `review` — the artifact-review counterpart of `approve`.
 *
 * `resume` decides whether the task is re-admitted once the artifact records are
 * decided: `tavi artifacts approve|reject` alone only records, and `--resume`
 * also re-admits, so the flag is the difference between two documented commands.
 * A rejection's `note` is recorded on the artifact and is what the model reads
 * in place of the content, as an approval denial's is.
 */
export const ReviewPayloadSchema = z.object({
  /**
   * The task the artifacts belong to. Absent, it is the named artifacts' own
   * task — they must share one — which is how a client holding only an
   * artifact id (`tavi artifacts approve <artifact-id>`) addresses it.
   */
  taskId: IdSchema.optional(),
  workspaceId: IdSchema,
  expectedSteps: z.number().int().nonnegative().optional(),
  decisions: z
    .array(
      z.object({
        artifactId: IdSchema,
        approved: z.boolean(),
        note: z.string().min(1).max(ARTIFACT_REVIEW_NOTE_MAX_CHARS).optional(),
      }),
    )
    .min(1)
    .max(384),
  reviewedBy: z.string().min(1).max(128).optional(),
  resume: z.boolean().optional(),
  /** With `resume`: the target the resumed turn is expected to run on. */
  expectTarget: ExpectTargetSchema.optional(),
});
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

/**
 * What `review` answers.
 *
 * `decisions` is each named artifact's state after the request: decided by it,
 * or already decided the same way (`alreadyDecided`, nothing written). With
 * `resume`, `resumed` describes the acknowledgement, answered — as `approve` is —
 * once it is claimed, or from the record when an identical one was committed or
 * is running under the suspension's key.
 *
 * `taskId` is `null` for artifacts no task produced (named without a `taskId`):
 * they are decided, and there is nothing to resume, so `resumed` is absent even
 * when `resume` was asked for.
 */
export interface ReviewResult {
  readonly taskId: string | null;
  readonly decisions: readonly {
    readonly artifactId: string;
    readonly reviewState: "approved" | "rejected";
    readonly alreadyDecided: boolean;
  }[];
  /** Each named artifact's record after the request — what `tavi artifacts approve|reject` prints. */
  readonly records: readonly ArtifactRecord[];
  readonly resumed?: {
    /** The review round. */
    readonly steps: number;
    readonly operationKey: string;
    readonly replayed: boolean;
    readonly status?: AdmissionOutcome["status"];
    /** As `ApproveResult.cursor`: where the acknowledgement's resumed turn starts. */
    readonly cursor?: IpcCursor;
  };
}

/**
 * `reply`: the local connection's inbound transport — a message
 * into one of its conversations, handed to the messaging service as any chat
 * message is, so it answers a question the conversation's task is waiting on
 * through the one settle point, or is a follow-up turn.
 */
/** What a reply is to a running turn: queued behind it, or merged into it. */
export const REPLY_INTENTS = ["queue", "steer"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const ReplyPayloadSchema = z
  .object({
    workspaceId: IdSchema,
    /** The conversation: the operation key of the IPC run that opened it (`RunResult.conversationId`). */
    conversationId: z.string().min(1).max(256).optional(),
    /**
     * Or the task itself: its conversation on the local connection, opened
     * for it when it has none — a chat from Telegram, a schedule's run, a
     * `tavi run` — so any chat can be continued from a front end.
     */
    taskId: IdSchema.optional(),
    /**
     * A reply's text is the same order of magnitude as a prompt, so it shares the
     * prompt's named bound rather than repeating the literal.
     */
    text: z
      .string()
      .min(1)
      .max(IPC_MAX_PROMPT_CHARS)
      // Blank, it would answer nothing, yet start a turn on whitespace — past a question it waits on.
      .refine((text) => text.trim() !== "", { message: "a reply needs text" }),
    /**
     * The client-minted id of this message: the provider event id the inbox
     * deduplicates on, so a retried `reply` is recorded once (and resent safely).
     */
    clientMessageId: z.string().min(1).max(256),
    /**
     * What the message is to a turn still running: `queue` (the default,
     * when absent) — the chat's next turn, as any message; `steer` — merged into
     * the running turn before its next model call. Only this, the local
     * connection's `reply`, may steer: a messaging conversation's message always
     * queues. A task with no turn running takes a steer as it takes a queued
     * reply (a follow-up, or the answer to its question); one waiting on an
     * approval or review round refuses it as it refuses any reply.
     */
    intent: z.enum(REPLY_INTENTS).optional(),
    /** Uploaded files the message carries: quoted after its text, as a channel attachment is. Never a steer. */
    attachments: PromptAttachmentsSchema.optional(),
  })
  .refine((payload) => (payload.conversationId === undefined) !== (payload.taskId === undefined), {
    message: "a reply names its conversation or its task, not both",
  });
export type ReplyPayload = z.infer<typeof ReplyPayloadSchema>;
/** A reply's intent, `queue` when it names none. */
export const replyIntentOf = (payload: Pick<ReplyPayload, "intent">): ReplyIntent => payload.intent ?? "queue";

/** What `reply` answers, once the message is recorded — its turn goes on after the answer. */
export interface ReplyResult {
  /** The conversation's task. */
  readonly taskId: string;
  readonly conversationId: string;
  /** This `clientMessageId` was recorded before: nothing was admitted again. */
  readonly duplicate: boolean;
  /**
   * The message steers the running turn: it is merged before that
   * turn's next model call — the stream's `turn.steered` says when — or, should
   * the turn end first, the owner sends it as the chat's next turn. Absent (or
   * false) when it was delivered as any reply is.
   */
  readonly steered?: boolean;
}

export const AbortPayloadSchema = z.object({ taskId: IdSchema });

export const AgentsPayloadSchema = z.object({
  workspaceId: IdSchema.optional(),
  action: z.enum(["list", "show", "tree", "add", "update", "enable", "disable", "remove"]).optional(),
  name: DisplayNameSchema.optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  description: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(AGENT_TREE_LIMIT).optional(),
  /**
   * `tree` only: `false` leaves out each node's `activity` and `finalText`,
   * for a list that names workers and their status only. An
   * owner from before it ignores the key and sends them.
   */
  detail: z.boolean().optional(),
  agentId: IdSchema.optional(),
  /**
   * `update`, `enable` and `disable` only: the definition's `updatedAt` as the
   * client read it (`agents list`/`show`), making the write a compare-and-set —
   * a definition changed since is refused with `CONFLICT` rather than
   * overwritten (the persona editor's Reload / Copy draft). Omitted, the write
   * is unconditional, as before.
   */
  expectedUpdatedAt: z.string().datetime().optional(),
  /**
   * `list` only (`show` refuses it): also report this task's mailbox — the
   * envelopes other agents sent it that it has not received yet (the agents
   * pane).
   */
  taskId: IdSchema.optional(),
});
export type AgentsPayload = z.infer<typeof AgentsPayloadSchema>;

/** The most mailbox envelopes `agents list` reports for a task; `truncated` says when more wait. */
export const AGENTS_MAILBOX_LIMIT = 20;

/**
 * A task's mailbox as `agents list` reports it: each pending envelope's
 * addressing, never its content, which may be up to the inline cap each.
 * Oldest first; an envelope past its `expiresAt` is still pending until swept.
 */
export interface AgentsMailbox {
  readonly taskId: string;
  readonly pending: readonly Pick<
    AgentMailboxEnvelopeRecord,
    "messageId" | "kind" | "senderAgentId" | "senderTaskId" | "createdAt" | "expiresAt"
  >[];
  readonly truncated: boolean;
}

/**
 * What `agents list` answers: each definition without its `systemPrompt`, but
 * with its length in UTF-16 code units (the persona picker's size), and its
 * `updatedAt` — the version `agents update`'s `expectedUpdatedAt` asserts.
 */
export interface AgentsListResult {
  readonly agents: readonly (Omit<AgentDefinition, "systemPrompt"> & {
    readonly systemPromptLength: number;
    /**
     * The routines that run this agent under the instructions pinned in their
     * revision: a persona edit does not reach them. Absent when none does
     * (and from an older owner).
     */
    readonly pinnedBy?: readonly { readonly routineId: string; readonly name: string }[];
  })[];
  readonly truncated: boolean;
  /** `workspace/agent` keys of rows that did not validate. */
  readonly unreadable?: readonly string[];
  /** Present when the request named a `taskId`. */
  readonly mailbox?: AgentsMailbox;
}

/**
 * Every command's payload schema, exhaustive over `IpcCommand`.
 *
 * `satisfies Record<IpcCommand, …>` is what makes "every command is validated"
 * a compile-time property rather than a convention: adding a command to
 * `IPC_COMMANDS` without a schema stops the build.
 */
export const IpcCommandPayloadSchemas = {
  artifacts: ArtifactsCommandPayloadSchema,
  tasks: TasksPayloadSchema,
  cancel: CancelPayloadSchema,
  recover: RecoverPayloadSchema,
  doctor: DoctorPayloadSchema,
  approvals: ApprovalsPayloadSchema,
  shutdown: ShutdownPayloadSchema,
  run: RunPayloadSchema,
  subscribe: SubscribePayloadSchema,
  unsubscribe: UnsubscribePayloadSchema,
  approve: ApprovePayloadSchema,
  review: ReviewPayloadSchema,
  reply: ReplyPayloadSchema,
  abort: AbortPayloadSchema,
  agents: AgentsPayloadSchema,
  routines: RoutinesPayloadSchema,
  models: ModelsPayloadSchema,
  router: RouterPayloadSchema,
  credentials: CredentialsPayloadSchema,
  channels: ChannelsPayloadSchema,
  "ui-preferences": UiPreferencesPayloadSchema,
  projects: ProjectsPayloadSchema,
  reports: ReportsPayloadSchema,
  schedules: SchedulesPayloadSchema,
  search: SearchPayloadSchema,
  plugins: PluginsPayloadSchema,
  mcp: McpPayloadSchema,
  apps: AppsPayloadSchema,
  "system-prompt": SystemPromptPayloadSchema,
  permissions: PermissionsPayloadSchema,
  "workspace-settings": WorkspaceSettingsPayloadSchema,
  center: CenterPayloadSchema,
  memory: MemoryPayloadSchema,
  skills: SkillsPayloadSchema,
  reminders: RemindersPayloadSchema,
  heartbeat: HeartbeatPayloadSchema,
  ideas: IdeasPayloadSchema,
  onboarding: OnboardingPayloadSchema,
  browser: BrowserPayloadSchema,
  "chat-context": ChatContextPayloadSchema,
  "browser-live": BrowserLivePayloadSchema,
  "reset-instance": ResetInstancePayloadSchema,
  "plugin-commands": PluginCommandsPayloadSchema,
  folder: FolderPayloadSchema,
  browse: BrowsePayloadSchema,
} as const satisfies Record<IpcCommand, z.ZodType>;

/** A payload as a sender may hold it: arrays it only reads may be `readonly`. */
type Sendable<T> = T extends readonly (infer U)[] ? readonly Sendable<U>[] : T extends object ? { [K in keyof T]: Sendable<T[K]> } : T;
/** What a client sends as `command`'s payload: its schema's input, before defaults are applied. */
export type IpcPayload<C extends IpcCommand> = Sendable<z.input<(typeof IpcCommandPayloadSchemas)[C]>>;
/** Every command's payload, by command name. */
export type IpcPayloadMap = { readonly [C in IpcCommand]: IpcPayload<C> };
/** What an owner's handler for `command` receives: its payload as the schema parsed it. */
export type IpcParsedPayload<C extends IpcCommand> = z.infer<(typeof IpcCommandPayloadSchemas)[C]>;

/**
 * Parse a command payload, or report why it was refused.
 *
 * The message names the command and the first failing path, never the payload's
 * values: a `credentials set` payload carries a secret, and an error string
 * travels into logs.
 */
export type ParsedCommandPayload<C extends IpcCommand> =
  | { readonly ok: true; readonly value: IpcParsedPayload<C> }
  | { readonly ok: false; readonly message: string; readonly code?: "UNSUPPORTED" };

export function parseCommandPayload<C extends IpcCommand>(command: C, payload: unknown): ParsedCommandPayload<C> {
  // The wire's `command` is a string, not `IpcCommand`: a peer can name a
  // command this build does not know, and that must be a refusal rather than a
  // dereference of `undefined`. An *own*-property check, because a plain index
  // resolves `constructor` or `__proto__` to a prototype member and then calls
  // `safeParse` on it.
  const schema = Object.hasOwn(IpcCommandPayloadSchemas, command) ? (IpcCommandPayloadSchemas[command] as z.ZodType) : undefined;
  if (schema === undefined) {
    return { ok: false, message: `unknown command ${String(command)}` };
  }
  const unsupported = command === "routines" ? unsupportedRoutinePolicy(payload) : undefined;
  if (unsupported !== undefined) return { ok: false, code: "UNSUPPORTED", message: unsupported };
  const parsed = schema.safeParse(payload ?? {});
  if (parsed.success) return { ok: true, value: parsed.data as IpcParsedPayload<C> };
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  return {
    ok: false,
    message: `${command} payload is invalid${path}: ${issue?.message ?? "unknown problem"}`,
  };
}

/**
 * Discovery metadata published by an owner.
 *
 * Written only after exclusive ownership and endpoint binding. It carries no
 * credential: the token lives in its own file with its own permissions.
 */
export const IpcDiscoverySchema = z.object({
  protocolVersion: z.number().int().positive(),
  sessionId: z.string().min(1).max(128),
  /** Unix socket path, or a named pipe on Windows. */
  endpoint: z.string().min(1).max(512),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
});
export type IpcDiscovery = z.infer<typeof IpcDiscoverySchema>;
