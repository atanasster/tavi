import { z } from "zod";

import { TaviError } from "./errors.js";
import { IdSchema, TimestampSchema } from "./ids.js";
import { ToolResultSchema } from "./tools.js";
import { UntrustedEnvelopeSchema } from "./untrusted-envelope.js";
import { MAX_MESSAGE_TEXT_BYTES, MAX_REASONING_BLOCKS, ModelReasoningSchema } from "./workflow-state.js";

/**
 * Model transport contracts.
 *
 * The AI SDK is the transport. SDK objects stay inside the adapter; everything
 * that crosses a node boundary is one of these application-owned DTOs.
 */

export const MessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * A tool call requested by the assistant.
 *
 * Carried on the assistant message that requested it: a provider rejects a
 * `tool` result whose id is not introduced by a preceding assistant tool call,
 * so the identity has to survive the DTO.
 */
export const AssistantToolCallSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  input: z.unknown(),
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type AssistantToolCall = z.infer<typeof AssistantToolCallSchema>;

/**
 * A tool result as a model request carries it: the result, and — for an
 * untrusted one — the envelope a provider conversion fences its text in
 * (`toolResultText`). Set when the request is built,
 * never stored: the checkpoint keeps the raw result.
 */
export const ModelToolResultSchema = ToolResultSchema.extend({
  envelope: UntrustedEnvelopeSchema.optional(),
});
export type ModelToolResult = z.infer<typeof ModelToolResultSchema>;

export const ModelMessageSchema = z.object({
  role: MessageRoleSchema,
  /** Stable id so replay can reuse a persisted response instead of regenerating it. */
  id: IdSchema,
  text: z.string().max(MAX_MESSAGE_TEXT_BYTES).default(""),
  /** Present on `role: "assistant"` messages that requested tools. */
  toolCalls: z.array(AssistantToolCallSchema).max(64).optional(),
  /** Present on `role: "tool"` messages: the call this result answers. */
  toolCallId: z.string().min(1).max(128).optional(),
  toolName: z.string().min(1).max(128).optional(),
  toolResults: z.array(ModelToolResultSchema).max(64).optional(),
  /**
   * A user message's context block (`WorkflowMessage.contextText`), sent as a
   * content part of its own before `text`. Set when the request is built.
   */
  contextText: z.string().max(MAX_MESSAGE_TEXT_BYTES).optional(),
  /**
   * The call's own step facts on a user message, sent as a content part of
   * their own after `text`, so the next call, which no longer carries them,
   * shares every byte before. Set when the request is built, never stored.
   */
  trailer: z.string().max(MAX_MESSAGE_TEXT_BYTES).optional(),
  /**
   * Where a prompt-cache breakpoint ends: on a user message its `text` part
   * (before any `trailer`), on an assistant message its text, on a tool message
   * its last result. Set by the agent loop under `models.promptLayout` `v2`;
   * the transport turns it into the provider's own marker or drops it.
   */
  cacheBreakpoint: z.boolean().optional(),
  /** On an assistant message, the reasoning its step returned, sent back to a provider that takes it. */
  reasoning: z.array(ModelReasoningSchema).max(MAX_REASONING_BLOCKS).optional(),
  createdAt: TimestampSchema,
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

/**
 * A request's system text: its system messages trimmed, blanks dropped, joined
 * by a blank line. The model adapters lift it into the leading instructions, and
 * the ledger hashes it as `ProviderAttempt.systemHash`.
 */
export function systemText(messages: readonly { readonly role: string; readonly text: string }[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * A model-facing tool descriptor: both identities plus the JSON Schema derived
 * from the canonical Zod argument schema at the adapter boundary.
 *
 * `id` is the canonical Tavi identity; `name` is the provider-safe function name
 * that is the only form allowed to cross the wire. Keeping both here is what lets
 * provider naming stay entirely inside the adapter.
 */
export const ModelToolDescriptorSchema = z.object({
  /** Canonical tool id: what policy, checkpoints and client events use. */
  id: z.string().min(1).max(128),
  /** Provider-safe function name, matching `MODEL_TOOL_NAME_PATTERN`. */
  name: z.string().min(1).max(64),
  description: z.string().max(2000),
  /**
   * JSON Schema produced from the Zod schema. `unknown` here because the
   * contracts package is platform-neutral and does not depend on a converter.
   */
  inputJsonSchema: z.unknown(),
});
export type ModelToolDescriptor = z.infer<typeof ModelToolDescriptorSchema>;

/** The most tools one model call may offer: the most OpenAI's API takes in a request. */
export const MAX_MODEL_TOOLS = 128;

export const ModelRequestSchema = z.object({
  /** Authorized connection/model revision. The adapter resolves credentials itself. */
  connectionId: IdSchema,
  model: z.string().min(1).max(256),
  runId: IdSchema,
  attemptId: IdSchema,
  messages: z.array(ModelMessageSchema).min(1).max(512),
  tools: z
    .array(ModelToolDescriptorSchema)
    .max(MAX_MODEL_TOOLS)
    .default(() => []),
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Monotonic across the run so a replaced attempt can supersede the previous one. */
  attemptNumber: z.number().int().positive(),
  /**
   * Which model call of the turn this is (1 = the turn's first; a retry or a
   * fallback of a call keeps its number). Set by the agent loop only; the
   * ledger records it beside the system prompt's hash for the cache-hit
   * measurement. Absent on calls outside a turn's loop.
   */
  step: z.number().int().positive().optional(),
  purpose: z.enum(["generation", "summary", "evaluation", "extraction", "vision"]).optional(),
  /**
   * `v2`: the agent loop's `models.promptLayout`, under which the transport keeps media stable for the prompt
   * cache — images shown in strides, and a result's words about its image, document or video the same whether
   * the file is attached or not. Absent: the layout every release before sent.
   */
  promptLayout: z.literal("v2").optional(),
  /**
   * How hard a reasoning model thinks before it answers: `low` for the background sites whose answer is short
   * (a find, an extraction, a summary, a classification, a heartbeat check, a compaction). Sent as the preset
   * takes it — OpenAI's `reasoning_effort` to a reasoning model, and OpenRouter's `reasoning.effort` to an
   * OpenAI reasoning model there (to another, a `reasoning` object can switch thinking on) — and to no other
   * endpoint or wire. Absent: the provider's default. Constant within a chat turn: a change re-writes
   * Anthropic's message cache. No `minimal`: OpenAI's o-series and GPT-5.1 and later refuse it.
   */
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  /**
   * Whether the model may call the offered tools: `none` keeps them listed (so the cached prefix holds) while
   * asking for an answer. Sent only with tools. Absent: the provider's default, `auto`. On Anthropic a change
   * re-writes the message cache, so keep it the same across a turn's calls where it can be.
   */
  toolChoice: z.enum(["auto", "none"]).optional(),
  /**
   * Native vendor computer-use tool configuration for vision sub-loops (`anthropic` or `openai`).
   * Mapped to the vendor's built-in computer tool only on a connection that supports it.
   */
  nativeComputer: z
    .object({
      vendor: z.enum(["anthropic", "openai"]),
      displayWidth: z.number().int().positive().max(16_384),
      displayHeight: z.number().int().positive().max(16_384),
      enableZoom: z.boolean().optional(),
    })
    .optional(),
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

/**
 * Streaming events emitted by the transport. Each carries the attempt it belongs
 * to so the client event layer can drop output from a superseded attempt.
 */
export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  inputNoCacheTokens: z.number().int().nonnegative().optional(),
  inputCacheReadTokens: z.number().int().nonnegative().optional(),
  inputCacheWriteTokens: z.number().int().nonnegative().optional(),
  outputReasoningTokens: z.number().int().nonnegative().optional(),
  /**
   * Whether the provider's usage said anything about its prompt cache (an
   * OpenAI-style `prompt_tokens_details`, or Anthropic's cache counts). False
   * means it reported none, so a cache read of 0 is unknown rather than a miss.
   * Set by the transport; absent where it cannot tell.
   */
  cacheUsageReported: z.boolean().optional(),
  /**
   * The first 16 hex digits of the SHA-256 of the request's cacheable prefix
   * as sent: its tools, system text and messages through the last cache
   * breakpoint, or through every message but the newest when none is marked.
   * Two calls with the same hash sent the same prefix. Set by the transport.
   */
  wirePrefixHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/**
 * Which caller made a model call, for `tavi doctor`'s per-site token report.
 * Recorded beside the attempt, never inside the request, so the request's
 * digest does not depend on it.
 */
export const MODEL_CALL_SITES = [
  "chat-step1",
  "chat-stepN",
  "final-step",
  "heartbeat",
  "ideas",
  "routine-research",
  "routine-synthesis",
  "worker",
  "compaction",
  "epoch-flush",
  "memory-review",
  "consolidation",
  "summarizer",
  "extract",
  "extract-repair",
  "find",
  "vision",
  "evaluation",
  "classifier",
] as const;
export const ModelCallSiteSchema = z.enum(MODEL_CALL_SITES);
export type ModelCallSite = (typeof MODEL_CALL_SITES)[number];

export const ModelEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("model.result"),
    attemptId: IdSchema,
    connectionId: IdSchema,
    model: z.string().min(1).max(256),
    usage: ModelUsageSchema,
  }),
  z.object({
    type: z.literal("text.delta"),
    attemptId: IdSchema,
    blockId: IdSchema,
    text: z.string().max(64 * 1024),
  }),
  z.object({
    type: z.literal("tool.input.started"),
    attemptId: IdSchema,
    /** SDK-side block identity for the streaming call. */
    blockId: IdSchema,
    toolName: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal("tool.completed"),
    attemptId: IdSchema,
    blockId: IdSchema,
    toolName: z.string().min(1).max(128),
    callId: IdSchema,
    input: z.unknown(),
  }),
]);
export type ModelEvent = z.infer<typeof ModelEventSchema>;

export const ModelErrorSchema = z.object({
  code: z.enum([
    "aborted",
    "auth",
    "rate_limit",
    // Billing/quota exhaustion: an HTTP 429 that will never succeed on retry.
    // Separated from `rate_limit` so a shared attempt budget cannot retry it
    // and turn a billing problem into a retry storm.
    "quota_exceeded",
    "invalid_request",
    "model_retired",
    "model_unavailable",
    "provider",
    "unknown",
  ]),
  message: z.string().max(2000),
  /** `true` only when the transport declares the failure retryable. */
  retryable: z.boolean(),
  /** Provider request id when the provider reported one. */
  providerRequestId: z.string().max(256).optional(),
  /**
   * How long the provider asked to be left alone (`Retry-After`), in
   * milliseconds, when it said: failover does not return to a target
   * before it has passed. Bounded to a day.
   */
  retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /**
   * The provider refused the request as longer than the model's context
   * window: the turn compacts its conversation and tries once more.
   */
  contextOverflow: z.boolean().optional(),
  /**
   * The provider refused the call because the key can afford only this many
   * output tokens (OpenRouter's "can only afford N"): the call is tried once
   * more, asking for no more than that.
   */
  affordableTokens: z.number().int().positive().optional(),
});
export type ModelError = z.infer<typeof ModelErrorSchema>;

/** A provider's words for a key that can pay for only so many output tokens: the number it names. */
export const AFFORDABLE_TOKENS_PATTERN = /can only afford (\d+)/i;

/** A provider's words for a request longer than the model's context window. */
export const CONTEXT_OVERFLOW_PATTERN =
  /context[ _-]?(?:window|length)|maximum context|prompt is too long|too many (?:input )?tokens|input is too long/i;

export const ModelToolCallSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(128),
  input: z.unknown(),
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;

/** Exactly one terminal outcome per local attempt. */
export const ModelOutcomeSchema = z.object({
  status: z.enum(["completed", "failed", "aborted"]),
  attemptId: IdSchema,
  text: z.string().max(MAX_MESSAGE_TEXT_BYTES),
  toolCalls: z.array(ModelToolCallSchema).max(64),
  finishReason: z.string().max(64).optional(),
  providerRequestId: z.string().max(256).optional(),
  usage: ModelUsageSchema,
  error: ModelErrorSchema.optional(),
  /** The reasoning the provider returned, when the connection keeps it to send back (a native Anthropic one). */
  reasoning: z.array(ModelReasoningSchema).max(MAX_REASONING_BLOCKS).optional(),
});
export type ModelOutcome = z.infer<typeof ModelOutcomeSchema>;

/** The most texts one embedding call carries: a backfill batch. */
export const MAX_EMBED_TEXTS = 64;
/** The most characters of one embedded text: a memory record's title and body, or a turn's query (≤ 1,200), with room to spare. */
export const MAX_EMBED_TEXT_CHARS = 8_000;
/** The most dimensions an embedding vector may have; 1,536 and 3,072 are the common sizes. */
export const MAX_EMBED_DIMENSIONS = 8_192;

/**
 * One embedding call: `texts` to vectors on an authorized
 * connection/model revision. `runId` and `attemptId` place it in the ledger
 * as `ModelRequest`'s do; the ledger keeps its usage and never its texts.
 */
export const ModelEmbedRequestSchema = z.strictObject({
  connectionId: IdSchema,
  model: z.string().min(1).max(256),
  runId: IdSchema,
  attemptId: IdSchema,
  texts: z.array(z.string().min(1).max(MAX_EMBED_TEXT_CHARS)).min(1).max(MAX_EMBED_TEXTS),
});
export type ModelEmbedRequest = z.infer<typeof ModelEmbedRequestSchema>;

/**
 * Exactly one terminal outcome per embedding call, as `ModelOutcome` is for a
 * generation. `vectors` holds one vector per text, in the texts' order, all of
 * one dimension, when `completed`; it is empty otherwise. The vectors are as
 * the provider answered them, not normalised.
 */
export interface ModelEmbedOutcome {
  readonly status: "completed" | "failed" | "aborted";
  readonly attemptId: string;
  readonly vectors: readonly Float32Array[];
  readonly usage: ModelUsage;
  readonly providerRequestId?: string;
  readonly error?: ModelError;
}

/**
 * A provider's embeddings as the port returns them, or a `MODEL_FAILED`
 * refusal: exactly `count` vectors, one dimension between 1 and
 * `MAX_EMBED_DIMENSIONS`, every value finite.
 */
export function embedVectorsOf(count: number, raw: readonly (readonly number[])[]): Float32Array[] {
  if (raw.length !== count) throw new TaviError("MODEL_FAILED", `The embedding model answered ${raw.length} vectors for ${count} texts`);
  const dimensions = raw[0]?.length ?? 0;
  if (dimensions < 1 || dimensions > MAX_EMBED_DIMENSIONS)
    throw new TaviError("MODEL_FAILED", `The embedding model answered vectors of ${dimensions} dimensions`);
  return raw.map((values) => {
    if (values.length !== dimensions) throw new TaviError("MODEL_FAILED", "The embedding model answered vectors of different dimensions");
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value)))
      throw new TaviError("MODEL_FAILED", "The embedding model answered a value that is not a finite number");
    return Float32Array.from(values);
  });
}

/** An embedding call's usage in the ledger's terms: input tokens, none cached, no output, so a price sheet prices it. */
export function embedUsageOf(tokens: number | undefined): ModelUsage {
  if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0) return {};
  return {
    inputTokens: tokens,
    inputNoCacheTokens: tokens,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: tokens,
  };
}

const modelRequestSnapshots = new WeakSet<ModelRequest>();

/** Canonical JSON snapshot before an authorization or credential await; an existing snapshot is returned as is. */
export function snapshotModelRequest(value: ModelRequest): ModelRequest {
  if (modelRequestSnapshots.has(value)) return value;
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw new TaviError("INVALID_INPUT", "Model request must contain plain JSON values");
    return item;
  });
  if (new TextEncoder().encode(encoded).byteLength > 2 * 1024 * 1024)
    throw new TaviError("INVALID_INPUT", "Model request exceeds the 2 MiB history limit");
  const snapshot = freezeModelValue(ModelRequestSchema.parse(JSON.parse(encoded)));
  modelRequestSnapshots.add(snapshot);
  return snapshot;
}

/** Freeze a JSON value without following host objects such as AbortSignal. */
export function freezeModelValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeModelValue(child);
    Object.freeze(value);
  }
  return value;
}
