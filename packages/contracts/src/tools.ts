import { z } from "zod";

// Acyclic: content-label.ts imports only zod.
import { ConfidentialitySchema, SourceKindSchema } from "./content-label.js";
import { IdeaPluginCapabilitySchema } from "./ideas.js";

/**
 * Tool contracts.
 *
 * `ToolDefinition` is the application-owned description of a capability. The
 * canonical Zod argument schema is passed through to the AI SDK by the model
 * adapter, so the model-facing JSON Schema and local validation cannot drift.
 */

export const ToolEffectSchema = z.enum(["read-only", "mutating", "external"]);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

/**
 * What leaves the chat, or outlives it, when a call of the tool runs. The
 * taint step decides by it; a call's assessment may narrow it per input.
 */
export const ToolSinkSchema = z.enum([
  /** Nothing leaves the chat or outlives it, or the untrusted label travels with it. */
  "none",
  /** Text to the conversation the task came from, or to a destination fixed by the person's configuration. */
  "reply",
  /** A request: with `urlOnly`, its only model-chosen payload is the URL; without, the model chose the URL, host or payload. */
  "network",
  /** A query to the operator's chosen search provider. */
  "search",
  /** Text or a delivery to a destination other than the origin. */
  "message",
  /** A request that uses a stored credential the model chose to apply. */
  "credential",
  /** Anything that outlives the chat or runs later. */
  "persist",
]);
export type ToolSink = z.infer<typeof ToolSinkSchema>;

/** The sink an external plugin or MCP tool takes when it states none: a request with a model-chosen payload. */
export const DEFAULT_EXTERNAL_TOOL_SINK = { sink: "network", urlOnly: false } as const satisfies { sink: ToolSink; urlOnly: boolean };

/** The output source an external plugin or MCP tool takes when it states none. */
export const DEFAULT_EXTERNAL_OUTPUT_SOURCE = "plugin" as const satisfies z.infer<typeof SourceKindSchema>;

export const ToolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:web_search|web_fetch|[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+)$/, 'tool ids look like "fixture.echo"');

/** How long a tool call may run when its definition names no `timeoutMs`: two minutes. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export const ToolDefinitionSchema = z.object({
  id: ToolIdSchema,
  version: z.string().min(1).max(32),
  description: z.string().min(1).max(2000),
  /** Effect classification drives approval policy; it is not cosmetic. */
  effect: ToolEffectSchema,
  /** Required permission scopes; an empty list still means "authenticated caller". */
  requiredPermissions: z.array(z.string().min(1).max(128)).max(32),
  /**
   * Declares this tool's output sensitive, reusing `MemoryRecord.sensitivity`'s
   * `"sensitive"` label — but unlike `MemoryRecord`, there is no explicit
   * `"normal"` value here; absence means normal. A result the workflow
   * adapter folds into a compaction summary tags that summary sensitive too
   * (compaction stage 2). Optional and absent by default: most
   * tools have nothing to declare.
   */
  sensitivity: z.enum(["sensitive"]).optional(),
  /**
   * Declares this tool must dispatch through a `SandboxPort`
   * (`./sandbox.js`) — "no unsandboxed
   * fallback": a tool declaring this is refused with a typed
   * capability error when no sandbox is configured, never run directly.
   * Optional and absent by default; most tools declare nothing here.
   */
  requiresSandbox: z.boolean().optional(),
  /**
   * How long one call may run before it is answered `TIMEOUT`, in
   * milliseconds: `DEFAULT_TOOL_TIMEOUT_MS` when absent, none at `0`. A tool
   * that runs a loop of model steps (`browser.vision_act`), a long media job,
   * or holds its own deadline (an MCP server's call) declares its own, so a
   * handler that hangs cannot hold a chat until its whole turn is stopped.
   */
  timeoutMs: z.number().int().min(0).optional(),
  /**
   * One line the system prompt adds while the tool is offered: when to reach
   * for it before anything else (a flight search before browsing). A built-in
   * tool's only: a plugin's tool is described by its manifest, which never
   * reaches the system prompt.
   */
  promptGuidance: z.string().min(1).max(1_000).optional(),
  /**
   * Declares this tool's output untrusted: web pages, search results, a
   * browser's view, a remote API's body. A conversation holding such output is
   * *tainted*, which raises every later call to at least high risk and removes
   * the `always` scope from its approval. Absent means trusted.
   */
  untrustedOutput: z.boolean().optional(),
  /**
   * Where the tool's output comes from: the source an untrusted result's
   * label names (`web` for a page,
   * `search` for a provider's results, `past-chat` for `sessions.search`).
   * Every built-in whose output is untrusted states it; an external plugin or
   * MCP tool that omits it takes `DEFAULT_EXTERNAL_OUTPUT_SOURCE`. A result's
   * per-call label (`TOOL_LABEL_KEY`) may name another.
   */
  outputSource: SourceKindSchema.optional(),
  /**
   * What would leak if the tool's output went out: `personal` for
   * `memory.get`, host-folder files, business collectors and every browser
   * read. Absent means `public`. A result's per-call label may raise it (a
   * credentialed `http.request`, a `memory.search`, `memory.list` or `sessions.search` that
   * read a record, which read nothing otherwise), never lower it; a result
   * that held a redaction placeholder before scrubbing is `secret`.
   */
  outputConfidentiality: ConfidentialitySchema.optional(),
  /**
   * The result's label is the one its content was stored with: the
   * handler always gives it (`stored` under `TOOL_LABEL_KEY`), so a result
   * message without a label is from before labels and reads as untrusted from
   * `outputSource`. `agents.read_payload`, `artifacts.view_image`.
   */
  labelledByStore: z.boolean().optional(),
  /**
   * The tool's static sink. Every built-in registration states it, and
   * the registry refuses one that does not; an external plugin or MCP tool
   * that omits it takes `DEFAULT_EXTERNAL_TOOL_SINK`. Every registered tool
   * therefore has one.
   */
  sink: ToolSinkSchema.optional(),
  /** With `sink: "network"` only: the URL is the request's only model-chosen payload. */
  urlOnly: z.boolean().optional(),
  /**
   * Offered but left out of a turn's first tool list:
   * `tools.search` finds it, and it is offered from the next generation. Search
   * and the gate see it like any other offered tool. Absent means listed.
   */
  deferred: z.boolean().optional(),
  /**
   * What the tool does to the world, as MCP's hints say it: read-only,
   * destructive (it deletes or overwrites what cannot be had back),
   * idempotent (a repeat changes nothing more), open-world (it reaches beyond
   * this machine). Absent fields are derived from `effect` (`toolAnnotationsOf`).
   * Metadata only: no approval rule reads it to allow anything.
   */
  annotations: z
    .strictObject({
      readOnly: z.boolean().optional(),
      destructive: z.boolean().optional(),
      idempotent: z.boolean().optional(),
      openWorld: z.boolean().optional(),
    })
    .optional(),
  /**
   * Who said an untrusted result: `tool:<server>`
   * for an MCP server's tool. Set by the registration, never by a handler;
   * `toolResultLabel` adds it to the result's principals.
   */
  outputPrincipal: z
    .string()
    .regex(/^tool:[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
  /**
   * What Ideas may offer because this tool is here (`places`, `travel`, …): a plugin's own declaration, read by
   * the ideas census while the tool is registered. The host's own tools prove what they do without it.
   */
  proves: z.array(IdeaPluginCapabilitySchema).max(4).optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/** A tool's annotations, each stated or derived from its effect. */
export interface ToolAnnotations {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
}

/**
 * `definition`'s annotations: what it states, else read-only exactly when its
 * effect is, destructive only when stated (and never for a read-only tool),
 * idempotent when read-only, open-world when its effect is `external`.
 */
export function toolAnnotationsOf(definition: Pick<ToolDefinition, "effect" | "annotations">): ToolAnnotations {
  const stated = definition.annotations ?? {};
  const readOnly = definition.effect === "read-only" && stated.readOnly !== false;
  return {
    readOnly,
    destructive: !readOnly && stated.destructive === true,
    idempotent: stated.idempotent ?? readOnly,
    openWorld: stated.openWorld ?? definition.effect === "external",
  };
}

/** A tool definition as registered: its sink is always present, stated by a built-in or defaulted for an external tool. */
export type DeclaredToolDefinition = ToolDefinition & { readonly sink: ToolSink };

/** A complete, validated tool call. Partial/interleaved arguments never exist here. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export const ToolResultSchema = z.object({
  toolCallId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  /** Bounded, JSON-serializable result payload. */
  output: z.unknown(),
  isError: z.boolean(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

/** Bound tool results before they enter model context. */
export function boundToolOutput(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  if (json === undefined) return null;
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= MAX_TOOL_RESULT_BYTES) return output ?? null;
  // Decode a byte-bounded slice: slicing the string by character count could
  // return up to four times the stated bound for non-ASCII content.
  const preview = new TextDecoder().decode(bytes.slice(0, MAX_TOOL_RESULT_BYTES));
  return {
    truncated: true,
    note: `tool output exceeded ${MAX_TOOL_RESULT_BYTES} bytes and was truncated`,
    preview,
  };
}

/**
 * Tool-name constraint for the model-facing surface.
 *
 * OpenAI-compatible endpoints accept only `[a-zA-Z0-9_-]` in a function name and
 * cap it at 64 characters. Tavi's canonical tool ids are dotted and namespaced
 * (`fixture.echo`), so the two names cannot be the same string.
 */
export const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Derive the provider-safe function name for a canonical tool id.
 *
 * Deterministic but not injective: `a.b` and `a_b` both map to `a_b`. The
 * registry therefore rejects a collision at registration rather than letting two
 * tools share one wire name (unsupported conversions fail at
 * registration instead of being silently resolved).
 */
export function providerToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
