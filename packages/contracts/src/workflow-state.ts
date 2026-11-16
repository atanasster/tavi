import { IdSchema } from "./ids.js";
import { z } from "zod";

// Verified acyclic: agent-communication.ts imports only ./ids.js and
// ./services.js, neither of which imports this module (or ports.ts) back.
import { MAX_SHARED_MEMORY_RECORD_IDS } from "./agent-communication.js";
// Acyclic: tool-policy.ts imports only ./ids.js and ./tools.js.
import { GateVerdictSchema } from "./tool-policy.js";
import { KNOWN_URL_LIMITS, KnownUrlsSchema } from "./known-url.js";
import { ChatMemoryModeSchema, FrontEndSchema, TurnChannelSchema } from "./task-origins.js";
import { ChatFolderSchema } from "./chat-folders.js";
// Acyclic: content-label.ts imports only zod.
import { ContentLabelSchema, trustedLabel } from "./content-label.js";
// Acyclic: redaction.ts imports nothing.
import { TOOL_OUTPUT_REDACTION_KINDS } from "./redaction.js";
import { zodIssues } from "./zod-util.js";

/**
 * Application-owned workflow state ("Zod-derived workflow state").
 *
 * Zod is the source of truth: the workflow adapter in `@tavi/agent-host` composes
 * these same fields into LangGraph's `StateSchema` and derives its state/update
 * types from it rather than redeclaring matching interfaces.
 *
 * This module is deliberately platform-neutral: it must not import LangGraph.
 */

export const RUN_PHASES = ["queued", "running", "waiting", "completed", "failed"] as const;
export const RunPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const MAX_MESSAGE_TEXT_BYTES = 128 * 1024;

/**
 * A message in the checkpointed conversation. `id` is the stable input identity
 * that replay reuses instead of regenerating actions.
 */
export const WorkflowToolCallSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  input: z.unknown(),
});

/**
 * One block of a model's reasoning as its provider returned it, kept so a
 * later call can send it back: a native Anthropic connection requires the
 * current turn's thinking blocks with its tool results, and a provider's
 * cache treats a dropped one as a change. `providerMetadata` is the
 * provider's own (a signature, redacted data), passed back untouched. The
 * model's view only: never shown, never captured.
 */
export const ModelReasoningSchema = z.strictObject({
  text: z.string().max(MAX_MESSAGE_TEXT_BYTES),
  /** The model that wrote it: sent back only to that model, whose signature it carries. */
  model: z.string().min(1).max(256).optional(),
  providerMetadata: z.record(z.string().max(64), z.unknown()).optional(),
});
export type ModelReasoning = z.infer<typeof ModelReasoningSchema>;
/** The most reasoning blocks one model step keeps: a step with more keeps none (`ModelReasoningSchema`). */
export const MAX_REASONING_BLOCKS = 64;

export const WorkflowMessageSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.enum(["system", "user", "assistant", "tool"]),
  text: z.string().max(MAX_MESSAGE_TEXT_BYTES).default(""),
  /**
   * Set on `role: "assistant"` messages that requested tools. Required for a
   * provider to accept the matching `role: "tool"` result.
   */
  toolCalls: z.array(WorkflowToolCallSchema).max(64).optional(),
  /** Set on `role: "tool"` messages: the call this result answers. */
  toolCallId: z.string().min(1).max(128).optional(),
  toolName: z.string().min(1).max(128).optional(),
  /** Set on `role: "tool"` messages: the bounded result payload. */
  output: z.unknown().optional(),
  isError: z.boolean().optional(),
  /** Measured tool runtime, retained for trajectory views after a restart. */
  durationMs: z.number().nonnegative().optional(),
  /** Set on a `role: "assistant"` message: the reasoning its model step returned, sent back on later calls (`ModelReasoningSchema`). */
  reasoning: z.array(ModelReasoningSchema).max(MAX_REASONING_BLOCKS).optional(),
  /**
   * Under `models.promptLayout` `v2`, set on a turn's opening person message:
   * the context block its turn's model calls were sent before the person's
   * words — only what no earlier message of the epoch showed (records,
   * preferences, skills, epoch summaries) — framed as quoted data. Written
   * once, on the turn's first call, and never rewritten, so every later call
   * sends the same bytes and a provider's prompt cache keeps them. The
   * model's view only: it is never the person's words, so capture, flushes,
   * epoch anchors and every copy of the message to another place leave it out.
   * `""` when the turn had nothing new to show.
   */
  contextText: z.string().max(MAX_MESSAGE_TEXT_BYTES).optional(),
  /**
   * What `contextText` showed, as ids (`memory:<revisionId>`,
   * `preference:<key>=<value hash>`, `skill:<id>@<version>`, `epoch:<message id>`):
   * a later turn shows only what no surviving message of the epoch lists, so
   * a rewind or a fold that drops one brings what it showed back.
   */
  contextShown: z.array(z.string().min(1).max(256)).max(1024).optional(),
  /**
   * Set on a `role: "tool"` message when its originating tool declared
   * itself `sensitivity: "sensitive"` (`ToolDefinition`; in compaction
   * stage 2 a fold's summary inherits the strictest
   * applicable retention/data-release constraints). Absent means normal;
   * there is no explicit `"normal"` value so an ordinary message costs
   * nothing extra to serialize.
   */
  sensitivity: z.enum(["sensitive"]).optional(),
  /**
   * Set on a `role: "tool"` message whose real, already-computed `output`
   * references one or more artifacts created `pending` review
   * — a sandboxed command's archived stdout/stderr, a
   * browser screenshot, or a browser download. Populated by the dispatch
   * layer at the exact point the artifact record is created (by directly
   * reading `ArtifactRecord.reviewState`, never guessed from the tool's
   * name or output shape), so `reviewNode` (`@tavi/agent-host`) can find
   * every message needing a decision without parsing free-text `output`
   * content. Checkpointed like every other message field: `reviewNode`'s
   * replay-from-top re-entry on a resumed admission depends on this
   * surviving the round-trip intact, the same reason
   * `InvocationContext.messagingReplyTo` (`./ports.js`) has to.
   */
  pendingReviewArtifactIds: z.array(z.string().min(1).max(128)).max(16).optional(),
  /**
   * Set on a `role: "tool"` message whose result the handler marked untrusted
   * (`TOOL_UNTRUSTED_KEY`, `./tool-policy.js`) though its tool is not
   * `untrustedOutput`: it taints the conversation the same way (a read of
   * the chat's `downloads/`).
   */
  untrusted: z.literal(true).optional(),
  /**
   * The message's content label. On a `role:
   * "tool"` message: its result's (`toolResultLabel`), set as it entered. On
   * a summary (a stage-2 `foldsum-…`, an epoch summary, a fold's note): the
   * join of the labels of the span it folded, so a summary never lowers what
   * it replaced. On quoted data (`inbound-…`, `trigger-…`): who wrote it. Absent, a
   * message reads as its tool's declaration and `untrusted` say. A `context-…` block's is never read: it has none.
   */
  label: ContentLabelSchema.optional(),
  /**
   * Set on a `role: "tool"` message whose output had credential shapes
   * masked: how many of each kind, never the values.
   */
  redacted: z.partialRecord(z.enum(TOOL_OUTPUT_REDACTION_KINDS), z.number().int().positive()).optional(),
});
export type WorkflowMessage = z.infer<typeof WorkflowMessageSchema>;

/**
 * The user-role messages the runtime writes that are not the person's words,
 * told apart by the id the runtime gives them — never by their text,
 * which anyone could type: a turn's notices block (`notices-…`), a side
 * chat's quoted background (`seed-background-…`), and an
 * epoch summary written as data (`epoch-…` in the user role: a messaging
 * conversation's), a turn's agent-mailbox block (`mailbox-…`: a
 * worker's result or another agent's message), and a
 * stage-2 model summary (`foldsum-…`: it condenses tool output), and a
 * call's context block (`context-…`: the memory manifest and an
 * ordinary chat's epoch summaries, built per request and never stored). They
 * are quoted data: never a request of the person's, never the turn's prompt,
 * never read as the person's by a flush. An `inbound-…` block is a message a
 * channel admitted that is not the task's person's own words (another group
 * member's, a forward, an email's quoted part), with
 * its label on the message. A `trigger-…` block is what started a run from
 * outside (a webhook call's payload, an email), with its label on the message.
 */
export const QUOTED_DATA_MESSAGE_ID_PREFIXES = [
  "notices-",
  "seed-background-",
  "epoch-",
  "mailbox-",
  "plugin-context-",
  "foldsum-",
  "context-",
  "inbound-",
  "trigger-",
] as const;

/** The id prefix of an inbound quoted-data block: its `label` says whose words it holds. */
export const INBOUND_MESSAGE_PREFIX = "inbound-";
/** The id prefix of the block holding what started a run from outside (`AdmitInput.trigger`): its `label` says whose. */
export const TRIGGER_MESSAGE_PREFIX = "trigger-";
/** How many inbound blocks one admission carries: a message's quote, forward and the rest, with room to spare. */
export const MAX_INBOUND_BLOCKS = 8;

/**
 * The id prefix of a model call's context block: one user-role
 * quoted-data message, just before the newest person message, carrying what
 * used to follow the system prompt — the memory manifest and an ordinary
 * chat's system-role epoch summaries — so the system string stays the same
 * from one turn of a chat to the next. Built for each request, never stored.
 * At send time it is folded into the front of the person message after it,
 * so no request holds two user turns in a row.
 */
export const CONTEXT_MESSAGE_PREFIX = "context-";

/**
 * A context block's first line, written by the host. A request's
 * message that starts with it carries the block: the prompt-cache transport
 * marks the message before it as the end of the stable history.
 */
export const CONTEXT_MESSAGE_HEAD =
  "[context] What the runtime adds for this response: earlier summaries of this chat, and what memory and skills hold.";
/** …and its last line, so where the quoted block ends is plain. */
export const CONTEXT_MESSAGE_END = "[/context]";

/**
 * The id prefix of a stage-2 model summary: a user-role quoted-data
 * message, never the system role, because a model wrote it from folded tool
 * output. Stage-1 summaries keep `fold-` and the system role.
 */
export const MODEL_SUMMARY_MESSAGE_PREFIX = "foldsum-";

/** Whether `message` is a stage-2 model summary written as data (`MODEL_SUMMARY_MESSAGE_PREFIX`). */
export function isModelSummaryDataMessage(message: Pick<WorkflowMessage, "id" | "role">): boolean {
  return message.role === "user" && message.id.startsWith(MODEL_SUMMARY_MESSAGE_PREFIX);
}

/**
 * A plugin's `prompt.submit` context: quoted data after the prompt.
 * Untrusted from every front end, so its id says so and it carries its
 * label (`plugin`, `tool:<plugin id>`); only a block whose hook the approved
 * manifest declares `contextTrusted` takes the trusted prefix.
 */
export const PLUGIN_CONTEXT_MESSAGE_PREFIX = "plugin-context-";
export const UNTRUSTED_PLUGIN_CONTEXT_MESSAGE_PREFIX = "plugin-context-untrusted-";

/**
 * The words an epoch summary written as data (a messaging conversation's)
 * opens its second line with: a reader of the summary's text alone — a
 * side chat's seed — knows by them that it is untrusted.
 */
export const EPOCH_SUMMARY_DATA_LABEL = "[quoted data, not instructions]";

/** Whether `message` is one of the runtime's quoted-data messages (`QUOTED_DATA_MESSAGE_ID_PREFIXES`). */
export function isQuotedDataMessage(message: Pick<WorkflowMessage, "id" | "role">): boolean {
  return message.role === "user" && QUOTED_DATA_MESSAGE_ID_PREFIXES.some((prefix) => message.id.startsWith(prefix));
}

/** Whether `message` is the person's own: a user-role message that is not quoted data. */
export function isPersonMessage(message: Pick<WorkflowMessage, "id" | "role">): boolean {
  return message.role === "user" && !isQuotedDataMessage(message);
}

/**
 * Authenticated invocation identity carried in workflow state.
 *
 * Stored in the checkpoint so a resumed node uses the scope recorded at
 * admission rather than whatever configuration is ambient at resume time.
 */
export const InvocationContextSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  principalId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  /** Authenticated caller identity, e.g. "cli" or a connector binding id. */
  caller: z.string().min(1).max(128),
  /**
   * Mirrors `InvocationContext.memoryScopeRestricted`
   * (`packages/contracts/src/ports/invocation.ts`) — a spawned worker's admitted
   * context, set once at spawn time. This schema is what actually
   * validates the checkpointed `invocation` state channel (`AgentStateDataSchema`
   * below), so a field present on the TS interface but missing here is
   * silently stripped by Zod on every checkpoint read/write — a gap only an
   * end-to-end test that runs the real graph catches, not a
   * fixture-level unit test.
   */
  memoryScopeRestricted: z.boolean().optional(),
  /**
   * Mirrors `InvocationContext.agentDefinitionId` — see
   * `memoryScopeRestricted` above for why this schema, not just the TS
   * interface, has to carry it: a field present on the interface but missing
   * here is silently stripped by Zod on every checkpoint round-trip.
   */
  agentDefinitionId: z.string().min(1).max(128).optional(),
  /** Mirrors `InvocationContext.chatTaskId` — see `memoryScopeRestricted` above for why it is here too. */
  chatTaskId: z.string().min(1).max(128).optional(),
  /** Mirrors `InvocationContext.parentChatId` — see `memoryScopeRestricted` above for why it is here too. */
  parentChatId: z.string().min(1).max(128).optional(),
  /** Mirrors `InvocationContext.turnStartedAt` — see `memoryScopeRestricted` above for why it is here too. */
  turnStartedAt: z.string().min(1).max(64).optional(),
  /** Mirrors `InvocationContext.heldChannel` — see `memoryScopeRestricted` above for why it is here too. */
  heldChannel: TurnChannelSchema.optional(),
  /** Mirrors `InvocationContext.scheduleDelivery`: a schedule fire's own delivery target. */
  scheduleDelivery: z.object({ connectionId: z.string().min(1).max(128), destination: z.string().min(1).max(256) }).optional(),
  /** Mirrors `InvocationContext.scheduleNotify`: how a schedule fire tells its person. */
  scheduleNotify: z
    .object({
      mode: z.enum(["when-sent", "if-changed"]),
      lastDeliveredHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .optional(),
  /** Mirrors `InvocationContext.heldConnectionId` — see `memoryScopeRestricted` above for why it is here too. */
  heldConnectionId: z.string().min(1).max(128).optional(),
  /** Mirrors `InvocationContext.frontEnd` — see `memoryScopeRestricted` above for why it is here too. */
  frontEnd: FrontEndSchema.optional(),
  /** Mirrors `InvocationContext.memoryReach` — see `memoryScopeRestricted` above for why it is here too. */
  memoryReach: z.literal("chat-only").optional(),
  /** Mirrors `InvocationContext.chatMemoryMode` — see `memoryScopeRestricted` above for why it is here too. */
  chatMemoryMode: ChatMemoryModeSchema.optional(),
  /** Mirrors `InvocationContext.folder` — see `memoryScopeRestricted` above for why it is here too. */
  folder: ChatFolderSchema.optional(),
  /** Mirrors `InvocationContext.folderUnavailable` — see `memoryScopeRestricted` above for why it is here too. */
  folderUnavailable: z.string().min(1).max(1_000).optional(),
  /** Mirrors `InvocationContext.delegatedMemoryRecordIds` — see `memoryScopeRestricted` above for why this schema, not just the TS interface, has to carry it. */
  delegatedMemoryRecordIds: z.array(z.string().min(1).max(128)).max(MAX_SHARED_MEMORY_RECORD_IDS).optional(),
  /**
   * Mirrors `InvocationContext.messagingReplyTo` —
   * same reason as the two fields above: this schema, not the TS
   * interface, is what actually round-trips through a checkpoint.
   * See `externalSenderId`/`externalMessageId`'s own comments in
   * `ports/invocation.ts` for why they're not redundant with `externalConversationId`.
   */
  messagingReplyTo: z
    .object({
      connectionId: z.string().min(1).max(128),
      externalConversationId: z.string().min(1).max(256),
      externalSenderId: z.string().min(1).max(256),
      externalMessageId: z.string().min(1).max(256).optional(),
      /** The forum topic or thread the task's first message arrived in. */
      externalThreadId: z.string().min(1).max(256).optional(),
      /**
       * The inbound email's `References` header (RFC 5322), one entry per
       * ancestor message-id, oldest first — needed so a reply threads
       * correctly past the immediate parent (`externalMessageId`/
       * `In-Reply-To` alone only threads one level deep). Mirrors
       * `InvocationContext.messagingReplyTo` (`./ports.js`) — same
       * reason as the sibling fields above.
       */
      externalReferences: z.array(z.string().min(1).max(256)).max(50).optional(),
      /** The inbound message's subject (email), so a reply keeps it. */
      subject: z.string().min(1).max(998).optional(),
      /** Mirrors `InvocationContext.messagingReplyTo.audience`: who reads a reply, fixed at admission. */
      audience: z.literal("one-to-one").optional(),
    })
    .optional(),
});

/**
 * Bound on the checkpointed conversation. Declared once and reused by both the
 * state field and the graph's merge reducer, so the contract is the single
 * source of the limit.
 */
export const MAX_CONVERSATION_MESSAGES = 512;

/**
 * A compaction fold (stage 1: bulky old tool/binary payloads replaced with
 * deterministic bounded summaries and artifact references).
 *
 * The conversation channel's reducer normally only ever appends/overwrites
 * messages by id (`WorkflowMessage[]`, below). A fold is the one operation
 * that *removes* messages — `removeIds` names the folded messages' ids,
 * `summary` is the synthetic replacement, and `append` carries any new
 * messages produced in the same turn (e.g. the model's own response), so
 * one state update can express "fold these away, then add these" atomically
 * rather than needing two separate writes to the same channel.
 */
export const ConversationFoldSchema = z.object({
  removeIds: z.array(z.string().min(1).max(128)).min(1).max(MAX_CONVERSATION_MESSAGES),
  summary: WorkflowMessageSchema,
  append: z
    .array(WorkflowMessageSchema)
    .max(64)
    .default(() => []),
});
export type ConversationFold = z.infer<typeof ConversationFoldSchema>;

/**
 * The conversation channel's reducer input: either the ordinary additive
 * form every node but the compacting model-node call ever produces, or a
 * fold. A plain `WorkflowMessage[]` remains a valid `ConversationUpdate`,
 * so no existing node's `{ conversation: [...] }` return needs to change.
 */
export const ConversationUpdateSchema = z.union([z.array(WorkflowMessageSchema).max(MAX_CONVERSATION_MESSAGES), ConversationFoldSchema]);
export type ConversationUpdate = z.infer<typeof ConversationUpdateSchema>;

/** The most deferred tools a task keeps as found (`discoveredToolIds`) under `models.promptLayout` `v2`. */
export const DISCOVERED_TOOLS_MAX = 32;
/** The most a turn keeps under `models.promptLayout` `v1`. */
export const V1_DISCOVERED_TOOLS_MAX = 8;
/** The most routed tools an epoch keeps (`routedToolIds`): as many as one model call may offer (`MAX_MODEL_TOOLS`). */
export const ROUTED_TOOLS_MAX = 128;

/** How many typed-into browser pages a task keeps (`typedPages`), newest kept. */
export const TYPED_PAGES_MAX = 256;

export const AgentStateDataSchema = z.object({
  stateVersion: z.literal(1),
  runId: z.string().min(1).max(128),
  invocation: InvocationContextSchema,
  phase: RunPhaseSchema,
  /**
   * Checkpointed conversation. The graph owns the accumulated list; the adapter
   * composes this field's Zod schema into the graph state and attaches a
   * bounded append-merge reducer.
   */
  conversation: z
    .array(WorkflowMessageSchema)
    .max(MAX_CONVERSATION_MESSAGES)
    .default(() => []),
  /** Model generations requested so far ("bounded loop guards"). */
  steps: z.number().int().nonnegative().default(0),
  /** Tool calls dispatched so far, bounding tool loops independently of steps. */
  toolCallsDispatched: z.number().int().nonnegative().default(0),
  /** Model generations within the current turn — since the last user message — which the loop guard bounds. */
  turnSteps: z.number().int().nonnegative().default(0),
  /** Tool calls within the current turn, which the tool guard bounds. */
  turnToolCalls: z.number().int().nonnegative().default(0),
  /** The user message the current turn answers: a newer one starts a turn. */
  turnMessageId: z.string().min(1).max(256).optional(),
  /**
   * The steer messages merged into the current admission, by id: what
   * its model calls took from the chat's pending steers. A new admission starts
   * it empty; a resume keeps it. Checkpointed with the messages themselves, so
   * the admission's end knows which steers its turn durably holds, and bounded
   * by {@link STEERS_PER_TURN}.
   */
  turnSteers: z
    .array(z.string().min(1).max(128))
    .max(16)
    .default(() => []),
  /** Tool calls awaiting dispatch or an approval decision. */
  pendingToolCalls: z
    .array(z.unknown())
    .max(64)
    .default(() => []),
  pendingToolAttemptId: IdSchema.optional(),
  toolDisclosureRequired: z.boolean().default(false),
  /**
   * The deferred tools `tools.search` found, offered beside the rest. Under
   * `models.promptLayout` `v1` a turn's own, newest first and at most
   * `V1_DISCOVERED_TOOLS_MAX`; under `v2` the epoch's, in the order they were
   * found and appended to the offered tools in that order, so a discovery
   * leaves every earlier one where it was. A rollover clears them.
   */
  discoveredToolIds: z
    .array(z.string().min(1).max(128))
    .max(DISCOVERED_TOOLS_MAX)
    .default(() => []),
  /**
   * Under `models.promptLayout` `v2`, the tools a routed shortlist offered
   * this epoch, in the order first offered: each turn offers them again with
   * whatever it adds, so routing never takes a tool back out of the array. A
   * rollover clears them.
   */
  routedToolIds: z
    .array(z.string().min(1).max(128))
    .max(ROUTED_TOOLS_MAX)
    .default(() => []),
  /**
   * The model (`<connection>/<model>`) whose call of this task last reported prompt-cache reads: while the turn
   * runs on it, its history is served at a cache read's price, so stage 2 folds it later
   * (`compactionCachedMaxContextTokens`). A turn on another model folds at the plain cap.
   */
  promptCacheModel: z.string().min(1).max(512).optional(),
  /**
   * Approval denials for the current pending calls, keyed by call id.
   *
   * A denial is recorded as a tool error result rather than failing the task, so
   * the model can answer without the effect.
   */
  denials: z.record(z.string().max(128), z.string().max(500)).default(() => ({})),
  /**
   * Approval references for calls that were gated and granted, keyed by call id.
   *
   * The effect ledger binds to this, so a recorded effect names the approval that
   * authorized it ("Approval and cancellation").
   */
  approvals: z.record(z.string().max(128), z.string().max(200)).default(() => ({})),
  /**
   * The policy verdict for each pending call, keyed by call id, decided once
   * when the model emitted the calls. Checkpointed so a resumed
   * `approveNode` gates exactly the calls it gated before it suspended.
   * Absent on a checkpoint written before verdicts existed: the effect default
   * decides those calls, as it always did.
   */
  gateVerdicts: z.record(z.string().max(128), GateVerdictSchema).default(() => ({})),
  /**
   * The context label: the join of every label
   * this conversation has held, checkpointed with `joinLabels` as its reducer
   * so it is monotone — a fold, a rollover or *Fresh context* never lowers
   * it; only a fresh chat starts clean. Checkpointed rather than recomputed
   * from the messages, because compaction folds tool messages into a summary
   * that no longer names the tool — and a summary of a web page is as
   * untrusted as the page.
   */
  contextLabel: ContentLabelSchema.default(() => trustedLabel("public")),
  /**
   * The URLs this task has seen in a person's message or a tool result, and
   * those a person approved (the known-URL rule), in
   * normal form, newest kept: so a fold that summarizes a page away does not
   * make its links novel. Bounded (`KNOWN_URL_LIMITS`); absent on a checkpoint
   * from before it, which reads as none.
   */
  knownUrls: KnownUrlsSchema.default(() => []),
  /**
   * The URLs the model wrote while they were not known — in its answers and
   * its calls' inputs — kept so a tool result that echoes one (a finding, a
   * typed field, a file it wrote) never makes it known, even after a fold.
   * The same bounds as `knownUrls`; absent on an older checkpoint.
   */
  modelUrls: KnownUrlsSchema.default(() => []),
  /**
   * The browser pages the model typed into, as `<sessionId> <origin>` (the
   * origin `https://host/`, or `*` when the page was not known), newest kept:
   * a page there may show what was typed, so a later read of that session on
   * that origin never makes a URL known. Absent on an older checkpoint.
   */
  typedPages: z
    .array(z.string().max(KNOWN_URL_LIMITS.maxUrlLength + 256))
    .max(TYPED_PAGES_MAX)
    .default(() => []),
  finalText: z.string().max(MAX_MESSAGE_TEXT_BYTES).default(""),
});
export type AgentStateData = z.infer<typeof AgentStateDataSchema>;

export const MAX_WORKFLOW_STEPS = 24;
/** The most model steps a task's own budget may give one turn (an agent definition's, such as the browser worker's). */
export const MAX_TASK_STEPS = 64;
/**
 * How many steer messages one admission merges. Each starts the turn's
 * loop guards again, so the bound keeps a turn steered over and over
 * finite; past it, a steer waits for the turn to end and is its next turn.
 */
export const STEERS_PER_TURN = 5;
export const MAX_WORKFLOW_TOOL_CALLS = 64;

export const SUPPORTED_STATE_VERSIONS: readonly number[] = [1];

export class UnsupportedStateVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(`Unsupported workflow state version ${String(version)}; supported: ${SUPPORTED_STATE_VERSIONS.join(", ")}`);
    this.name = "UnsupportedStateVersionError";
    this.version = version;
  }
}

/**
 * Validate restored or externally supplied state before resuming work.
 * State version is checked first so an unsupported future
 * version fails with a precise error rather than a field-level message.
 */
export function parseAgentState(value: unknown): AgentStateData {
  if (typeof value !== "object" || value === null) {
    throw new UnsupportedStateVersionError(undefined);
  }
  const version = (value as { stateVersion?: unknown }).stateVersion;
  if (typeof version !== "number" || !SUPPORTED_STATE_VERSIONS.includes(version)) {
    throw new UnsupportedStateVersionError(version);
  }
  const result = AgentStateDataSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid workflow state: ${zodIssues(result.error, "<root>").join("; ")}`);
  }
  return result.data;
}
