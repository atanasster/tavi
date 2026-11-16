import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import { ApprovalRowIdSchema, IPC_MAX_MESSAGE_CHARS, MAX_REVIEW_EVENT_REQUESTS } from "./ipc-limits.js";
import { ApprovalDisplaySchema } from "./approval-card.js";
import { ApprovalProvenanceSchema, ApprovalScopeSchema, GateVerdictSchema } from "./tool-policy.js";
import { AgentWaitOutcomeSchema, AskUserChoicesSchema } from "./agent-communication.js";
import { BrowserHandoffSchema, BrowserHandoffSettlementSchema } from "./browser-handoff.js";
import { ConnectRequestSchema, ConnectSettlementSchema } from "./app-connect.js";
import { TOOL_OUTPUT_REDACTION_KINDS } from "./redaction.js";
import { boundTurnKnownUrls, TurnKnownUrlsSchema } from "./known-url.js";
import { clip } from "./util.js";
// Acyclic: mods.ts imports only tool-policy.js, task-origins.js and types.
import { MAX_TURN_SUGGESTIONS, TURN_SUGGESTION_MAX_CHARS } from "./mods.js";

/**
 * Client event contract.
 *
 * Events are runtime-validated, versioned and strictly ordered within a stream
 * epoch. Raw graph state and provider reasoning never appear here; a streaming
 * test asserts private fields stay out.
 */

/** Client v3 adds task.spawned, v4 wait.settled, v5 browser.controlled, v6 turn.steered, v7 plugin.status, plugin.notice, plugin.state and turn.suggested, v8 task.stopped; older strict event consumers are refused at handshake. IPC frames version separately. */
export const CLIENT_PROTOCOL_VERSION = 8;

export const CLIENT_EVENT_KINDS = [
  "run.started",
  "text.delta",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.required",
  "approval.settled",
  "attempt.replaced",
  "task.spawned",
  "task.waiting",
  "wait.settled",
  "browser.controlled",
  "turn.steered",
  "plugin.status",
  "plugin.notice",
  "plugin.state",
  "turn.suggested",
  "task.review_required",
  "task.completed",
  "task.failed",
  "task.stopped",
  "resync.required",
] as const;

export const ClientEventKindSchema = z.enum(CLIENT_EVENT_KINDS);
export type ClientEventKind = z.infer<typeof ClientEventKindSchema>;

/**
 * The bound on every externally sourced text field of an event, named once.
 *
 * The schema below uses these and `boundEventPayloads` clamps to them, so a
 * bound changed in one place cannot turn clamping back into refusal. Their
 * content comes from outside the producer's control — a tool's error body, a
 * provider's failure message, a model's final text, a tool name the model made
 * up — so a producer cannot promise to stay inside them, and an event the
 * schema refuses used to throw out of the graph's own event handler and fail
 * the task it was only reporting on. Identity fields (`IdSchema`) are not here:
 * clamping an id would break the correlation it exists for.
 */
export const EVENT_TEXT_BOUNDS = {
  text: 64 * 1024,
  finalText: 128 * 1024,
  message: IPC_MAX_MESSAGE_CHARS,
  summary: IPC_MAX_MESSAGE_CHARS,
  reason: 500,
  on: 500,
  question: 4000,
  toolName: 128,
  errorCode: 64,
  effect: 64,
  decidedBy: 128,
  scopeGroup: 128,
  via: 128,
  replyText: 4000,
  context: 280,
  // A plugin's status line and notice.
  line: 200,
  notice: 2_000,
} as const;

/** A plugin's status line: at most this long; an empty or absent line clears it. */
export const PLUGIN_STATUS_MAX_CHARS = EVENT_TEXT_BOUNDS.line;
/** A plugin's notice: at most this long. */
export const PLUGIN_NOTICE_MAX_CHARS = EVENT_TEXT_BOUNDS.notice;
/** A value a plugin publishes for its canvas contribution: at most this much JSON. */
export const PLUGIN_STATE_MAX_CHARS = 16_384;

/**
 * A wait's id on an event. An identity, so never clamped (a clipped id no
 * longer names its wait); bounded above every id `waitRowId` builds.
 */
const WaitIdSchema = z.string().min(1).max(512);

/** Fields among `EVENT_TEXT_BOUNDS` whose schema also requires at least one character. */
const NON_EMPTY_TEXT_FIELDS: ReadonlySet<string> = new Set(["on", "toolName", "errorCode", "decidedBy", "via"]);

/** Provider-reported totals for the execution that emitted this outcome. */
export const ExecutionMetricsSchema = z.object({
  models: z.array(z.string().max(512)).max(64),
  totalTokens: z.number().int().nonnegative(),
  partial: z.boolean(),
  /** The input tokens providers reported reading from their prompt cache, when any did. */
  cacheReadTokens: z.number().int().nonnegative().optional(),
});
export type ExecutionMetrics = z.infer<typeof ExecutionMetricsSchema>;

const envelope = {
  protocolVersion: z.literal(CLIENT_PROTOCOL_VERSION),
  /** Stream epoch: a new epoch means cursors from the old one cannot be replayed gaplessly. */
  epoch: IdSchema,
  /** Monotonically ordered sequence within `epoch`. */
  sequence: z.number().int().nonnegative(),
  runId: IdSchema,
  attemptId: IdSchema,
  at: TimestampSchema,
};

/**
 * The run's owner stopped answering this round under the run's `--approval`
 * policy (`approve`/`deny`), and why: the round is left for a person. Carried
 * by the round's suspension events (`approval.required`, `task.review_required`)
 * when the owner publishes them again on giving up, so a client that left the
 * round to the owner stops waiting for it. Additive: an older client strips it
 * and sees the round announced twice, which every reducer folds into one.
 * `reason` is a short code (`not-own-artifact`, `decided-elsewhere`,
 * `unavailable`, `round-limit`), free text so a new one is never unreadable.
 */
export const PolicyStoppedSchema = z.object({
  reason: z.string().min(1).max(64),
  message: z.string().max(EVENT_TEXT_BOUNDS.reason),
});
export type PolicyStopped = z.infer<typeof PolicyStoppedSchema>;

/**
 * The turn read untrusted data, and the URLs its conversation already holds
 * (`boundTurnKnownUrls`): the canvas names the host of, and asks before
 * opening, a link in the answer that is none of them (`isKnownNavigation`). Carried by the first `text.delta` after a model call of a tainted
 * turn begins (`knownUrls` only when they changed since the last sent) and by
 * `task.completed`. Sticky for the stream: a later event without them keeps
 * what was sent. Additive: an older client strips them and draws plain links.
 */
const turnTaint = {
  tainted: z.literal(true).optional(),
  knownUrls: TurnKnownUrlsSchema.optional(),
};

export const ClientEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...envelope,
    kind: z.literal("task.spawned"),
    childRunId: IdSchema,
    workerAgentId: IdSchema,
    agentDefinitionId: IdSchema.optional(),
    depth: z.number().int().positive(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("run.started"),
    threadId: IdSchema,
    workspaceId: IdSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("text.delta"),
    blockId: IdSchema,
    text: z.string().max(EVENT_TEXT_BOUNDS.text),
    ...turnTaint,
  }),
  z.object({
    ...envelope,
    kind: z.literal("tool.started"),
    blockId: IdSchema,
    callId: IdSchema,
    toolName: z.string().min(1).max(EVENT_TEXT_BOUNDS.toolName),
    /** Safe, bounded argument preview; never a credential. */
    input: z.unknown(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("tool.completed"),
    callId: IdSchema,
    toolName: z.string().min(1).max(EVENT_TEXT_BOUNDS.toolName),
    output: z.unknown(),
    durationMs: z.number().nonnegative(),
    /** The credential shapes masked in `output`, by kind; an older reader drops it. */
    redacted: z.partialRecord(z.enum(TOOL_OUTPUT_REDACTION_KINDS), z.number().int().positive()).optional(),
  }),
  z.object({
    ...envelope,
    // A plugin's line in the task's status: the newest per plugin is shown; no text clears it.
    kind: z.literal("plugin.status"),
    pluginId: IdSchema,
    line: z.string().max(EVENT_TEXT_BOUNDS.line).optional(),
  }),
  z.object({
    ...envelope,
    // What plugins suggest the person does next, at a turn's end: sent as an ordinary prompt when picked.
    kind: z.literal("turn.suggested"),
    suggestions: z.array(z.string().min(1).max(TURN_SUGGESTION_MAX_CHARS)).min(1).max(MAX_TURN_SUGGESTIONS),
  }),
  z.object({
    ...envelope,
    // A value the plugin publishes for its canvas contribution's `mod.state` channel: the newest per key is kept.
    kind: z.literal("plugin.state"),
    pluginId: IdSchema,
    stateKey: IdSchema,
    value: z
      .unknown()
      .refine(
        (value) => JSON.stringify(value ?? null).length <= PLUGIN_STATE_MAX_CHARS,
        `a published value is at most ${PLUGIN_STATE_MAX_CHARS} characters of JSON`,
      ),
  }),
  z.object({
    ...envelope,
    kind: z.literal("plugin.notice"),
    pluginId: IdSchema,
    notice: z.string().min(1).max(EVENT_TEXT_BOUNDS.notice),
  }),
  z.object({
    ...envelope,
    kind: z.literal("tool.failed"),
    callId: IdSchema,
    toolName: z.string().min(1).max(EVENT_TEXT_BOUNDS.toolName),
    errorCode: z.string().min(1).max(EVENT_TEXT_BOUNDS.errorCode),
    message: z.string().max(EVENT_TEXT_BOUNDS.message),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("approval.required"),
    callId: IdSchema,
    toolName: z.string().min(1).max(EVENT_TEXT_BOUNDS.toolName),
    summary: z.string().max(EVENT_TEXT_BOUNDS.summary),
    input: z.unknown(),
    /**
     * The round this request belongs to.
     *
     * The checkpointed per-turn generation counter, and the identity an
     * approval key is built from. Required at every producer rather than
     * optional: a provider may reuse one `call.id` across turns, so `callId`
     * alone does not name a round. Rounds suspended before this field existed
     * are handled from the waiting admission's durable outcome instead.
     */
    steps: z.number().int().nonnegative(),
    /** The approval row this request addresses, so a client can name it directly. */
    approvalId: ApprovalRowIdSchema,
    /** Effect classification, so a client presents the risk honestly. */
    effect: z.string().max(EVENT_TEXT_BOUNDS.effect).optional(),
    /** The policy verdict's risk. Additive: an older owner omits it. */
    risk: GateVerdictSchema.shape.risk.optional(),
    /** What the person is shown about the call. */
    display: ApprovalDisplaySchema.optional(),
    /** The scopes a decision on this call may carry; absent means `once`. */
    allowedScopes: z.array(ApprovalScopeSchema).max(3).optional(),
    /**
     * The call's rule subjects: what a `session` or `always` decision matches
     * — each escaped to an exact glob — so a card shows the rule it saves
     * rather than its display fields. Empty or absent: the rule covers any
     * call of the tool. Additive: an older owner omits it.
     */
    subjects: GateVerdictSchema.shape.subjects,
    /** The tools a `session` or `always` decision covers as one permission (`browser.*`). Additive. */
    scopeGroup: GateVerdictSchema.shape.scopeGroup,
    /**
     * Why the call is asked, and from where: the taint
     * step's reason, the context's sources and newest refs, and where the
     * call's strings appear. Additive: a client that does not know it strips
     * it, and an older owner omits it.
     */
    provenance: ApprovalProvenanceSchema.optional(),
    /** Published again by an owner that stopped answering the round: it is a person's now. Additive. */
    policyStopped: PolicyStoppedSchema.optional(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("approval.settled"),
    /** The round that was decided. */
    steps: z.number().int().nonnegative(),
    /** Per-call outcomes of that round, so every attached client clears its cards. */
    decisions: z
      .array(
        z.object({
          callId: IdSchema,
          approved: z.boolean(),
        }),
      )
      .max(64),
    /** Who decided — an operator identity, a schedule's policy, or `cli`. */
    decidedBy: z.string().min(1).max(EVENT_TEXT_BOUNDS.decidedBy),
  }),
  z.object({
    ...envelope,
    kind: z.literal("attempt.replaced"),
    supersededAttemptId: IdSchema,
    reason: z.string().max(EVENT_TEXT_BOUNDS.reason),
    /**
     * The superseded attempt's output is discarded, not part of the task's
     * conversation: a model call failed over mid-turn. Absent for a
     * resume, whose superseded attempt's output stands.
     */
    discarded: z.literal(true).optional(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("task.waiting"),
    /**
     * What the wait resolves on, in operator-facing prose ("a reply correlated
     * to …", "worker task … completing", "its deadline"). Free text because the
     * three shapes it describes are structurally different.
     */
    on: z.string().min(1).max(EVENT_TEXT_BOUNDS.on),
    deadlineAt: TimestampSchema,
    /**
     * The question a human is answering, when the wait is the bare-deadline
     * shape `operator.ask_user` produces. Absent for a peer or worker
     * wait, which no attached operator can answer.
     */
    question: z.string().max(EVENT_TEXT_BOUNDS.question).optional(),
    /** The question's choices, so an attached client can offer them. Additive. */
    choices: AskUserChoicesSchema.optional(),
    /**
     * The worker task the wait resolves on, for a wait on a worker (`agents.wait`): the owner resumes the task when
     * the worker answers, so a following client keeps following rather than ending here. Additive.
     */
    workerTaskId: IdSchema.optional(),
    /** The wait's id, so a client can tell this question from the next and match its `wait.settled` (protocol v4). */
    waitId: WaitIdSchema,
    /** Why the question is asked. Additive. */
    context: z.string().max(EVENT_TEXT_BOUNDS.context).optional(),
    /** A browser handoff: the person is asked to act in the page, from the live view, not to answer. Additive. */
    handoff: BrowserHandoffSchema.optional(),
    /** A connect wait: an app's account to sign in again, from Connected apps, not an answer. Additive. */
    connect: ConnectRequestSchema.optional(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("browser.controlled"),
    /**
     * A person held the task's browser and handed it back while the task did
     * not wait for it: the transcript's
     * "You controlled the browser for 1 m 12 s — done · note". A handoff the
     * task waited on says the same through `wait.settled`. Nothing typed in the
     * page is here.
     */
    sessionId: IdSchema,
    outcome: z.enum(["done", "failed", "timeout", "cancelled"]),
    controlledMs: z.number().int().nonnegative(),
    /** The person's own note, clipped (named as `wait.settled` names it, so one bound clamps both). */
    replyText: z.string().max(EVENT_TEXT_BOUNDS.replyText).optional(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("turn.steered"),
    /**
     * A message the person sent into the running turn was merged
     * before its next model call: shown in the turn, where the model read it.
     * `messageId` is the reply's own `clientMessageId`, so the front end that
     * sent it knows its message.
     */
    messageId: z.string().min(1).max(256),
    text: z.string().max(EVENT_TEXT_BOUNDS.text),
  }),
  z.object({
    ...envelope,
    kind: z.literal("wait.settled"),
    /**
     * A question (or any wait) was settled and its task resumes: published when
     * the resume is claimed, whichever path settled it — a typed reply, a
     * button, an email link, a peer agent's reply, the deadline.
     * Every attached client turns its question card
     * into a receipt.
     */
    waitId: WaitIdSchema,
    outcome: AgentWaitOutcomeSchema.shape.kind,
    /** For a question with options: the options chosen, by label. */
    answers: z.array(z.string().min(1).max(60)).max(4).optional(),
    /** The person's own words, clipped. */
    replyText: z.string().max(EVENT_TEXT_BOUNDS.replyText).optional(),
    /** Who answered — an operator identity, a peer agent's id, or `policy` for a deadline. */
    decidedBy: z.string().min(1).max(EVENT_TEXT_BOUNDS.decidedBy).optional(),
    /** The front end or channel the answer came through (`approvalChannelLabel` names it). */
    via: z.string().min(1).max(EVENT_TEXT_BOUNDS.via).optional(),
    /** A browser handoff the person ended: how, and how long they had the page. Additive. */
    handoff: BrowserHandoffSettlementSchema.optional(),
    /** A connect wait ended by the sign-in or *Not now*. Additive. */
    connect: ConnectSettlementSchema.optional(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("task.review_required"),
    /** The round the pending review belongs to (its round identity). */
    steps: z.number().int().nonnegative(),
    requests: z
      .array(
        z.object({
          artifactId: IdSchema,
          toolName: z.string().min(1).max(EVENT_TEXT_BOUNDS.toolName),
          callId: IdSchema,
        }),
      )
      .max(MAX_REVIEW_EVENT_REQUESTS),
    /** Published again by an owner that stopped answering the round: it is a person's now. Additive. */
    policyStopped: PolicyStoppedSchema.optional(),
  }),
  z.object({
    ...envelope,
    kind: z.literal("task.completed"),
    metrics: ExecutionMetricsSchema.optional(),
    finalText: z.string().max(EVENT_TEXT_BOUNDS.finalText),
    ...turnTaint,
  }),
  z.object({
    ...envelope,
    kind: z.literal("task.failed"),
    metrics: ExecutionMetricsSchema.optional(),
    errorCode: z.string().min(1).max(EVENT_TEXT_BOUNDS.errorCode),
    message: z.string().max(EVENT_TEXT_BOUNDS.message),
  }),
  // The person stopped the turn: nothing failed, and a reply goes on in the same chat.
  z.object({
    ...envelope,
    kind: z.literal("task.stopped"),
    metrics: ExecutionMetricsSchema.optional(),
    message: z.string().max(EVENT_TEXT_BOUNDS.message),
  }),
  z.object({
    ...envelope,
    kind: z.literal("resync.required"),
    reason: z.string().max(EVENT_TEXT_BOUNDS.reason),
  }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/**
 * A client event before the sink assigns its envelope.
 *
 * Distributing over the union keeps each variant's own fields checked — a plain
 * `Omit<ClientEvent, …>` collapses the union and loses every discriminant. Shared
 * (rather than redeclared per producer) because the CLI's foreground sink, the
 * daemon's bus and the client reducers all name the same shape.
 */
export type UnsequencedClientEvent = ClientEvent extends infer T
  ? T extends ClientEvent
    ? Omit<T, "protocolVersion" | "epoch" | "sequence" | "at"> & { readonly at?: string }
    : never
  : never;

/**
 * Bound on a free-form event payload (`input`/`output`), matching the tool-output
 * bound.
 *
 * A model-supplied tool input or output is unbounded data and the schema types it
 * as `z.unknown()`, so publishing it verbatim would break the bounded streaming
 * contract. Defined here rather than in the CLI sink because the bound belongs to
 * the event contract: the daemon's bus and the foreground sink both apply it, and
 * two copies would let one path publish what the other refuses.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;

/** Replace any payload larger than the bound with a bounded, marked preview. */
export function boundEventPayload(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) return null;
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= MAX_EVENT_PAYLOAD_BYTES) return value ?? null;
  return {
    truncated: true,
    note: `payload exceeded ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
    preview: new TextDecoder("utf-8").decode(bytes.slice(0, MAX_EVENT_PAYLOAD_BYTES)),
  };
}

/**
 * Bound an event before it enters the stream: the free-form payloads (`input`,
 * `output`) to `MAX_EVENT_PAYLOAD_BYTES`, a turn's `knownUrls` to
 * `TURN_KNOWN_URLS_LIMITS`, and every externally sourced text
 * field to its `EVENT_TEXT_BOUNDS` — an empty one that must not be empty becomes
 * `"unknown"`. The foreground sink and the daemon's bus both apply it, so
 * neither can publish what the other would refuse.
 */
export function boundEventPayloads<T extends Record<string, unknown>>(event: T): T {
  const output: Record<string, unknown> = { ...event };
  for (const key of ["input", "output"]) {
    if (key in output) output[key] = boundEventPayload(output[key]);
  }
  if (Array.isArray(output["knownUrls"])) output["knownUrls"] = boundTurnKnownUrls(output["knownUrls"]);
  for (const [key, limit] of Object.entries(EVENT_TEXT_BOUNDS)) {
    const value = output[key];
    if (typeof value !== "string") continue;
    output[key] = value === "" && NON_EMPTY_TEXT_FIELDS.has(key) ? "unknown" : clip(value, limit);
  }
  return output as T;
}

/** Fields that must never appear in a serialized client event. */
export const PRIVATE_STATE_KEYS = ["privateState", "reasoning", "providerMetadata", "rawState"] as const;

export function encodeClientEvent(event: ClientEvent): string {
  return JSON.stringify(event);
}

export function parseClientEvent(line: string): ClientEvent {
  const parsed: unknown = JSON.parse(line);
  return ClientEventSchema.parse(parsed);
}
