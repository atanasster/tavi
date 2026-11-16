import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

import {
  createOpenAiCompatibleTransport,
  defangVideoSentinels,
  newVideoSentinel,
  observedFetch,
  type WireObservation,
} from "./openai-stream-compat.js";
import { openaiExplicitCacheModel, type CallCachePolicy } from "./prompt-cache.js";
import { APICallError, type JSONSchema7 } from "@ai-sdk/provider";
import {
  embedMany,
  jsonSchema,
  RetryError,
  StreamProviderError,
  streamText,
  tool,
  type AssistantModelMessage,
  type ModelMessage as SdkModelMessage,
  type ToolModelMessage,
  type ToolSet,
} from "ai";

/**
 * The library's own warnings (a JSON Schema feature it sends in a compatibility mode) go to the process's stderr, so
 * every terminal command that runs a model printed them between its own lines (QA 1836). They are about the library's
 * schema translation, not about anything the person can act on: switched off, as the library itself suggests.
 */
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = false;

import {
  AFFORDABLE_TOKENS_PATTERN,
  CONTEXT_OVERFLOW_PATTERN,
  embedUsageOf,
  embedVectorsOf,
  type ModelConnection,
  type ModelEmbedOutcome,
  type ModelEmbedRequest,
  type ModelError,
  type ModelMessage,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type ModelUsage,
  TaviError,
  TOOL_MEDIA_KEY,
  scrubCredentialText,
  systemText,
  providerToolName,
  TOOL_DOCUMENT_KEY,
  TOOL_VIDEO_KEY,
  presetOf,
  promptCacheOf,
  CONTEXT_MESSAGE_HEAD,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_REASONING_BLOCKS,
  type ModelReasoning,
  type ModelCallSite,
  TOOL_MEDIA_MAX,
  hasToolMedia,
  toolDocumentOf,
  toolVideoOf,
  toolMediaListOf,
  type ModelToolResult,
  toolResultText,
  compactObservationForModel,
  STREAM_FIRST_BYTE_SECONDS,
  STREAM_IDLE_SECONDS,
  STREAM_REASONING_FIRST_BYTE_SECONDS,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/** The one tool whose result may put an image in front of the model. */
const VIEW_IMAGE_TOOL_ID = "artifacts.view_image";
/**
 * The built-in tools whose results may show an image: an approved artifact, and the agent's own browser — a capture, or
 * the screenshot a blocked or near-empty observation carries. Any other tool's
 * output is data, whatever keys it happens to carry.
 */
const IMAGE_TOOL_IDS: ReadonlySet<string> = new Set([
  VIEW_IMAGE_TOOL_ID,
  "browser.capture",
  "browser.create_session",
  "browser.navigate",
  "browser.observe",
  "browser.vision_act",
  "computer",
  "pdf.render",
  "pdf.fill",
  "pdf.overlay",
  "pdf.view",
  "video.frames",
  "video.view",
  "video.pose",
]);
/**
 * The tools whose result may name a whole document to send as a file:
 * `pdf.view`, on a connection whose
 * `pdfInput` takes one. Its page images stand for it anywhere else.
 */
const DOCUMENT_TOOL_IDS: ReadonlySet<string> = new Set(["pdf.view"]);
/** The tools whose result names a whole video (`TOOL_VIDEO_KEY`). */
const VIDEO_TOOL_IDS: ReadonlySet<string> = new Set(["video.view"]);
/**
 * Whether `toolName`'s result may show an image: a built-in image tool's, or
 * an MCP tool's (`mcp.<server>.<tool>`), whose bridge
 * stores the server's image as an approved artifact and strips any media
 * reference of the server's own.
 */
const showsImage = (toolName: string): boolean => IMAGE_TOOL_IDS.has(toolName) || toolName.startsWith("mcp.");
/** The most images a request shows: the latest; an older one is described, not sent again (each costs as much as a page of text). */
export const MAX_SHOWN_IMAGES = TOOL_MEDIA_MAX;
/**
 * `models.promptLayout` `v2`'s image window: up to this many of the latest images, the oldest
 * `SHOWN_IMAGES_STRIDE` dropped at once when it overflows — so which images a request shows changes once
 * every few new images, not with each, and a provider's prompt cache keeps what came before. Its own
 * number: `TOOL_MEDIA_MAX` bounds the media of one result.
 */
export const MAX_SHOWN_IMAGES_STABLE = 6;
export const SHOWN_IMAGES_STRIDE = 3;

/** Where the shown images begin among `count`: the latest `MAX_SHOWN_IMAGES`, or under `v2` a window that moves in strides. */
export function firstShownImage(count: number, stable: boolean): number {
  if (!stable) return Math.max(0, count - MAX_SHOWN_IMAGES);
  if (count <= MAX_SHOWN_IMAGES_STABLE) return 0;
  return SHOWN_IMAGES_STRIDE * Math.ceil((count - MAX_SHOWN_IMAGES_STABLE) / SHOWN_IMAGES_STRIDE);
}

/** The SDK's tool-result output, as its message type declares it. */
type ToolResultOutput = Extract<ToolModelMessage["content"][number], { readonly type: "tool-result" }>["output"];

/**
 * The connection facts the transport needs.
 *
 * Derived from the stored `ModelConnection` rather than declared again, so the
 * adapter and the configuration store cannot drift apart: `connectionId` is the
 * single vocabulary for a connection in this codebase. The model to
 * use is not part of this record — role resolution owns that decision.
 */
export const PROVIDER_CONNECTION_FIELDS = [
  "connectionId",
  "kind",
  "baseUrl",
  "credentialRef",
  "pdfInput",
  "pdfEngine",
  "videoModels",
  "wireApi",
  "streamFirstByteSeconds",
  "streamIdleSeconds",
] as const satisfies readonly (keyof ModelConnection)[];

export type ProviderConnection = Pick<ModelConnection, (typeof PROVIDER_CONNECTION_FIELDS)[number]> & {
  /** Optional non-credential headers, e.g. an organization id. */
  readonly headers?: Readonly<Record<string, string>>;
};

/** A stored connection as the transport takes it: every field it reads, and none of the store's own metadata. */
export function providerConnectionOf(connection: ModelConnection): ProviderConnection {
  const fields = Object.fromEntries(
    PROVIDER_CONNECTION_FIELDS.flatMap((field) => (connection[field] === undefined ? [] : [[field, connection[field]]])),
  ) as Omit<ProviderConnection, "headers">;
  return { ...fields, ...(connection.headers === undefined ? {} : { headers: connection.headers }) };
}

export interface AiSdkModelAdapterOptions {
  readonly connections: readonly ProviderConnection[];
  /**
   * A connection as configured now, read at every call so a connection added
   * or changed while the process runs is served without a restart. Absent,
   * `connections` is the whole of what this adapter serves.
   */
  readonly connection?: (connectionId: string) => Promise<ProviderConnection | undefined>;
  /**
   * Resolve a credential reference. Injected so the adapter never reads the
   * environment or a file itself.
   */
  readonly readSecret: (credentialRef: string) => Promise<string | null>;
  /** Transport retries are disabled by default and configured under the shared attempt budget. */
  readonly maxRetries?: number;
  /**
   * Custom fetch implementation.
   *
   * The application supplies this for an explicitly configured egress proxy or
   * transport policy; tests supply it to exercise the adapter without network
   * access. It is never an ambient global override.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The clock a `Retry-After` given as a date is read against, in
   * milliseconds: the workflow's, so the wait it keeps is measured on the
   * same clock it was computed on. The real one by default.
   */
  readonly now?: () => number;
  /**
   * The bytes of an image a tool result names (`showsImage`: `artifacts.view_image`, the agent's own browser, and an MCP tool),
   * for a vision-capable model. Absent, or answering `undefined`, the model
   * sees the result's text alone.
   */
  readonly resolveMedia?: (
    artifactId: string,
  ) =>
    | { readonly mediaType: string; readonly data: Uint8Array }
    | undefined
    | Promise<{ readonly mediaType: string; readonly data: Uint8Array } | undefined>;
  /**
   * Whether a model reads images, so `resolveMedia` is consulted only for one
   * that does: a text-only model sent an image part fails the whole request.
   * The catalog records no image capability, so the default is
   * `modelReadsImages`'s list of known vision families — conservative: a
   * model it does not recognise is sent the result's text.
   */
  readonly supportsImages?: (modelId: string, connectionId: string) => boolean;
  /**
   * The bytes of a PDF a `pdf.view` result names, for a connection whose
   * `pdfInput` takes one: an approved document within the owner's
   * caps. Absent, or answering `undefined`, its page images stand for it.
   */
  readonly resolveDocument?: (
    artifactId: string,
  ) =>
    | { readonly mediaType: string; readonly data: Uint8Array }
    | undefined
    | Promise<{ readonly mediaType: string; readonly data: Uint8Array } | undefined>;
  /**
   * The bytes of a video a `video.view` result names, for a model its
   * connection has native video on for (`videoModels`), in the run `runId`: the owner answers only for an attended task,
   * failing closed. Absent, or answering `undefined`, the result's fallback
   * images stand for it.
   */
  readonly resolveVideo?: (
    artifactId: string,
    runId: string,
  ) =>
    | { readonly mediaType: string; readonly data: Uint8Array }
    | undefined
    | Promise<{ readonly mediaType: string; readonly data: Uint8Array } | undefined>;
}

/** What `toSdkMessages` needs to send a video: its bytes, and a place to put them the SDK will not refuse. */
export interface VideoSending {
  readonly resolve: (
    artifactId: string,
  ) =>
    | { readonly mediaType: string; readonly data: Uint8Array }
    | undefined
    | Promise<{ readonly mediaType: string; readonly data: Uint8Array } | undefined>;
  /** The sentinel text part that stands for `video` until the transport puts it in its place. */
  readonly register: (video: { readonly mediaType: string; readonly data: Uint8Array }) => string;
}

/**
 * Whether `modelId` names a model family known to read images: Claude 3 and
 * later, GPT-4o, GPT-4.1, GPT-4 Turbo, GPT-5 and GPT-6, OpenAI's o1, o3 and
 * o4-mini (not their text-only minis), Gemini 1.5 and later, Gemma 3 and 4
 * but their text-only 1B and 270M sizes, Llama 4 Scout and Maverick, Qwen
 * 3.5 and later, Amazon Nova Lite, Pro and Premier (not Micro), Kimi K2.5 and
 * later, GLM's vision models, Grok 4, Mistral Small 3.1 and later, Medium 3
 * and Large 2512/4, Phi-4 multimodal, and the open models that say so in their
 * name (`-vl`, `vision`, LLaVA, Pixtral, InternVL, MiniCPM-V). A provider
 * prefix (`anthropic/…`, `openai/…`) is ignored. Unknown is false: a missed
 * image costs the model a look, a wrong guess fails the request.
 */
export function modelReadsImages(modelId: string): boolean {
  const name = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
  if (/^claude-/.test(name)) return !/^claude-(2|instant)/.test(name);
  if (/^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|gpt-6)/.test(name)) return true;
  if (/^(o1|o3)(-|$)/.test(name)) return !/^(o1|o3)-(mini|preview)/.test(name);
  if (/^o4-mini/.test(name)) return true;
  if (/^gemini-/.test(name)) return !/^gemini-(pro$|1\.0)/.test(name);
  // Ollama names sizes after a colon (`gemma3:1b`).
  if (/^gemma-?[34]/.test(name)) return !/(^|[-_:])(1b|270m)([-_.:]|$)/.test(name);
  if (/^(meta-)?llama-4-(scout|maverick)/.test(name)) return true;
  if (/^qwen3\.[5-9]/.test(name)) return true;
  if (/^(amazon\.)?nova-(2-)?(lite|pro|premier)/.test(name)) return true;
  if (/^kimi-(k2\.[5-9]|k3)/.test(name)) return true;
  if (/^glm-(4\.[156]v|5v)/.test(name)) return true;
  if (/^grok-4/.test(name)) return true;
  if (/^mistral-small-(3\.[1-9]|2603|4)/.test(name) || /^mistral-medium-3/.test(name) || /^mistral-large-(2512|4)/.test(name)) return true;
  if (/^phi-4-multimodal/.test(name)) return true;
  return /(^|[-_.])vl([-_.]|$)|vision|llava|pixtral|internvl|minicpm-v/.test(name);
}

const DEFAULT_MAX_RETRIES = 0;

/**
 * The language-model specification this adapter is written against (AI SDK
 * 7's). It is tavi's own statement, not one `ai` reads: it holds only with the
 * gate that keeps one `@ai-sdk/provider` in the lockfile and the SDK pinned
 * exactly (`tests/boundaries.test.ts`), and moves with those pins.
 */
export const MODEL_SPECIFICATION_VERSION = "v4";

/**
 * Refuse, at composition, a provider package that speaks another model
 * specification than the adapter reads. The pins move together, and a
 * gate holds one `@ai-sdk/provider` in the lockfile; this is what catches a
 * drift that gets past both — before an owner starts, not on its first call.
 * The version belongs to the provider's code, not to a connection, so a probe
 * model with no credential and no network is enough (`createOpenAI` and
 * `.chat` read no environment and make no request), and it holds whether or
 * not a connection is configured: an install that fails it is broken for every
 * model.
 */
export function assertModelSpecification(
  model: { readonly specificationVersion: string } = createOpenAI({ apiKey: "probe", baseURL: "http://127.0.0.1/v1" }).chat("probe"),
): void {
  if (model.specificationVersion !== MODEL_SPECIFICATION_VERSION) {
    throw new TaviError(
      "UNAVAILABLE",
      `The installed AI SDK provider speaks model specification ${model.specificationVersion}; tavi's model adapter is written for ${MODEL_SPECIFICATION_VERSION}. Reinstall tavi's pinned dependencies.`,
      { details: { specificationVersion: model.specificationVersion } },
    );
  }
}

export interface ModelAdapter extends ModelPort {
  /** Connections this adapter can serve; used to validate configuration before dispatch. */
  readonly connections: readonly ProviderConnection[];
  /**
   * The adapter, sending every call on exactly `connection`: a binding's own,
   * so a change saved after it was resolved cannot redirect the call. A request
   * naming another connection fails as unknown.
   */
  pinned(connection: ProviderConnection): ModelPort;
  /** How many videos are held for calls in flight: none once every call has ended. */
  videosInFlight(): number;
}

export function createAiSdkModelAdapter(options: AiSdkModelAdapterOptions): ModelAdapter {
  const byId = new Map(options.connections.map((connection) => [connection.connectionId, connection]));
  if (byId.size !== options.connections.length) {
    throw new TaviError("DUPLICATE", "Duplicate provider connection id");
  }
  assertModelSpecification();
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const clock = options.now ?? Date.now;
  // One transport per **connection**, not per request and not per adapter.
  //
  // Per request would be useless: the transport retains the tool-call signatures
  // a provider requires echoed back on a later turn, so it must outlive a single
  // call (see `openai-stream-compat.ts`).
  //
  // Per adapter would be worse than useless. One adapter serves every configured
  // connection and every conversation for the life of the process, and provider
  // tool-call ids are counter-like rather than globally unique — so a single
  // shared store could hand one conversation's signature to an unrelated tool
  // call, and the provider rejects that with "thought signature is not valid",
  // which looks exactly like the bug the shim exists to fix. Scoping the store
  // to one connection makes that window a fraction of a live conversation.
  //
  // Created lazily so a connection that is configured but never used costs
  // nothing.
  //
  // Keyed by the endpoint too: a connection pointed somewhere else is another
  // provider, whose signatures the old one's store must not hand out.
  const transports = new Map<string, typeof globalThis.fetch>();
  /** Recent calls per prompt-cache key, to spread a busy chat over shards (`promptCacheKeyFor`). */
  const keyedCalls = new Map<string, number[]>();
  /**
   * The `prompt_cache_key` a chat's calls are sent with: a digest of its run, so its calls reach the same cache,
   * and a shard of it once more than `PROMPT_CACHE_KEY_RPM` calls went under one key in the last minute (past
   * that, OpenAI spreads a key's calls anyway).
   */
  const promptCacheKeyFor = (key: string): string => {
    const base = cacheKeyDigest(key);
    const now = Date.now();
    // Keys no call used in the last minute go: the map holds only what a shard needs to count.
    for (const [known, calls] of keyedCalls) if (known !== base && now - (calls.at(-1) ?? 0) >= 60_000) keyedCalls.delete(known);
    const recent = (keyedCalls.get(base) ?? []).filter((at) => now - at < 60_000);
    recent.push(now);
    keyedCalls.set(base, recent);
    const shard = Math.floor((recent.length - 1) / PROMPT_CACHE_KEY_RPM);
    return shard === 0 ? base : `${base}-${shard}`;
  };
  /**
   * The videos in flight, by the sentinel that stands for each in a request:
   * written by a call's `toSdkMessages`, read by its transport, and
   * cleared when the call ends, so no video outlives the request it was for.
   */
  const videos = new Map<string, { readonly mediaType: string; readonly data: Uint8Array }>();
  const transportFor = (connection: ProviderConnection): typeof globalThis.fetch => {
    // OpenRouter's file parser is OpenRouter's: another endpoint is never sent its `plugins` field.
    const pdfEngine = presetOf(connection.baseUrl)?.id === "openrouter" ? connection.pdfEngine : undefined;
    const key = `${connection.connectionId}\u0000${connection.baseUrl}\u0000${pdfEngine ?? ""}`;
    const existing = transports.get(key);
    if (existing !== undefined) return existing;
    const created = createOpenAiCompatibleTransport(options.fetch ?? globalThis.fetch, {
      ...(pdfEngine === undefined ? {} : { pdfEngine }),
      videoOf: (sentinel) => videos.get(sentinel),
    });
    transports.set(key, created);
    return created;
  };

  /**
   * The connection a call is sent on — `pinned` when given, the connection a
   * binding was resolved from, else the one configured now — and its
   * credential, or why the call is not sent. Shared by `stream` and `embed`.
   */
  const connectionFor = async (
    pinned: ProviderConnection | undefined,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<{ readonly connection: ProviderConnection; readonly credential: string } | { readonly error: ModelError } | "aborted"> => {
    const connection =
      pinned !== undefined
        ? pinned.connectionId === connectionId
          ? pinned
          : undefined
        : options.connection === undefined
          ? byId.get(connectionId)
          : await options.connection(connectionId);
    if (connection === undefined) {
      return { error: { code: "model_unavailable", message: `Unknown model connection ${connectionId}`, retryable: false } };
    }
    if (signal.aborted) return "aborted";
    let credential: string | null;
    try {
      credential = await options.readSecret(connection.credentialRef);
    } catch (error) {
      // A bound-but-unusable credential (missing file, empty file, denied
      // storage) is a configuration defect the operator must see, not a
      // provider fault.
      return { error: { code: "invalid_request", message: errorMessage(error), retryable: false } };
    }
    if (credential === null || credential.trim() === "") {
      // Missing configuration is a local defect, reported before any request is
      // attempted, not a provider authentication failure.
      return {
        error: {
          code: "invalid_request",
          message:
            `Credential reference ${connection.credentialRef} is not configured: store it with ` +
            `\`tavi credentials set ${connection.credentialRef} --file <path>\` (an offline \`tavi run\` may pass ` +
            "--api-key-file <path> or set TAVI_API_KEY_FILE instead); ambient provider environment variables are deliberately not used.",
          retryable: false,
        },
      };
    }
    return { connection, credential };
  };

  /** One call, on `pinned` when given — the connection a binding was resolved from — else the one configured now. */
  const streamOn = async (
    pinned: ProviderConnection | undefined,
    request: ModelRequest,
    streamOptions: Pick<Parameters<ModelPort["stream"]>[1], "signal" | "onEvent" | "site" | "cacheTtl" | "cacheKey">,
  ): Promise<ModelOutcome> => {
    // `request.attemptNumber` is deliberately never read below (only
    // `attemptId` is, for event correlation). `workflow/model-summary.ts`'s
    // `COMPACTION_SUMMARY_ATTEMPT_NUMBER` sentinel depends on this
    // adapter treating `attemptNumber` as inert transport metadata — if
    // a future change here starts giving it semantic meaning (retry or
    // backoff heuristics, for example), that sentinel stops being safe.
    //
    // Cancellation is checked before any provider work so an already-aborted
    // admission neither spends a request nor fabricates a completion.
    const ready = await connectionFor(pinned, request.connectionId, streamOptions.signal);
    if (ready === "aborted") return abortedOutcome(request);
    if ("error" in ready) return failure(request, ready.error);
    const { connection, credential } = ready;

    // What this call's transport sees of its prefix and of the provider's cache usage, for its usage record.
    const cachePolicy = cachePolicyOf(streamOptions.site, streamOptions.cacheTtl);
    const capabilities = promptCacheOf(connection.baseUrl);
    // What ties the calls that share a prefix: the caller's own key (a heartbeat's, the same from tick to tick), else the run.
    const cacheKey = streamOptions.cacheKey ?? request.runId;
    const wire: WireObservation = {
      ...(cachePolicy === undefined ? {} : { cache: cachePolicy }),
      breakpoints: capabilities.breakpoints === true,
      // The chat's calls stay on one provider, so the cache it wrote is the one read.
      ...(capabilities.sessionId === true ? { sessionId: cacheKeyDigest(cacheKey) } : {}),
      // On OpenRouter only an OpenAI reasoning model's effort is set: for another model a `reasoning` object can
      // switch thinking on (Claude's extended thinking, at 1,024 tokens or more), which a short-capped call cannot afford.
      ...(request.reasoningEffort !== undefined &&
      presetOf(connection.baseUrl)?.id === "openrouter" &&
      request.model.startsWith("openai/") &&
      openaiReasoningModel(request.model.slice("openai/".length))
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
    };
    // Sign in with ChatGPT's connection speaks the Responses API, and so does OpenAI's native computer tool.
    const responses =
      connection.wireApi === "responses" || (request.nativeComputer?.vendor === "openai" && presetOf(connection.baseUrl)?.id === "openai");
    // OpenAI's own endpoint takes `reasoning_effort` only from a reasoning model, and the SDK sends it to any.
    // Not on Sign in with ChatGPT's Responses wire (the same base URL), which takes no such setting.
    const openaiEffort =
      request.reasoningEffort !== undefined &&
      !responses &&
      presetOf(connection.baseUrl)?.id === "openai" &&
      openaiReasoningModel(request.model)
        ? request.reasoningEffort
        : undefined;
    const promptCacheKey = capabilities.promptCacheKey === true && cachePolicy !== "none" ? promptCacheKeyFor(cacheKey) : undefined;
    // A caller that wants its prefix kept longer (a heartbeat's next check within the hour): GPT-5.6 and later on
    // OpenAI's endpoint keep a prefix 30 minutes when asked, the longest they offer.
    const openaiCacheOptions =
      cachePolicy === "1h" && !responses && presetOf(connection.baseUrl)?.id === "openai" && openaiExplicitCacheModel(request.model)
        ? { ttl: "30m" as const }
        : undefined;
    // Anthropic's own API: thinking cannot be turned off on Claude 5.5 models, and effort is how deep it goes.
    const anthropicEffort =
      connection.kind === "anthropic-messages" && request.reasoningEffort !== undefined && anthropicTakesEffort(request.model)
        ? request.reasoningEffort
        : undefined;
    // Anthropic's own Messages API: breakpoints and thinking blocks travel as the SDK's own provider options.
    const native = connection.kind === "anthropic-messages";
    /** Reasoning blocks as they stream, by block id: kept to send back on a native connection's later calls. */
    const reasoning = new Map<string, { text: string; model: string; providerMetadata?: Record<string, unknown> }>();
    const provider = createOpenAI({
      name: connection.connectionId,
      baseURL: connection.baseUrl,
      apiKey: credential,
      ...(connection.headers === undefined ? {} : { headers: { ...connection.headers } }),
      // The injected transport goes through the compatibility shim (see its
      // module comment): an OpenAI-compatible server that omits
      // `tool_calls[].index`, or that requires its own `thought_signature`
      // echoed back, otherwise fails every tool-using conversation outright —
      // a hard blocker for an unattended run rather than a degraded one. The
      // shim only adds missing fields, so a conformant provider (and a test's
      // fake `fetch`, whose responses are not event streams) is unaffected.
      //
      // Scoped per connection; see `transportFor` above for why neither
      // per-request nor per-adapter is right.
      // The shim repairs Chat Completions streams; the Responses API's are its own, and go untouched.
      fetch: responses ? (options.fetch ?? globalThis.fetch) : observedFetch(transportFor(connection), wire),
    });
    const anthropicProvider = native
      ? createAnthropic({
          baseURL: connection.baseUrl,
          apiKey: credential,
          ...(connection.headers === undefined ? {} : { headers: { ...connection.headers } }),
          fetch: options.fetch ?? globalThis.fetch,
        })
      : undefined;

    // A native Anthropic connection caches its tools and system text on their own too, as the OpenRouter transport
    // marks them: another chat's instructions over the same tools still read the tools back.
    const prefixCache = native ? nativePrefixCache(cachePolicy) : undefined;
    const tools = buildSdkTools(request, prefixCache, {
      native,
      responses,
      anthropicProvider,
      openaiProvider: provider,
    });
    const text = new Map<string, string>();
    const toolCalls: { id: string; name: string; input: unknown; providerMetadata?: Record<string, unknown> }[] = [];
    let finishReason: string | undefined;
    let usage: ModelUsage = {};
    let providerRequestId: string | undefined;
    let streamError: ModelError | undefined;
    // A provider that goes quiet — before its first output, or between chunks — fails this call over instead of
    // holding it on the transport's own five-minute defaults. The stall's abort reaches the SDK with the caller's.
    const deadlines = streamDeadlinesOf(connection, request);
    const stall = new AbortController();
    const signal = AbortSignal.any([streamOptions.signal, stall.signal]);
    let stallError: ModelError | undefined;

    // AI SDK 7 accepts system instructions only through `system`; a system
    // message inside `messages` makes every real call fail before fetch.
    const instructions = defangVideoSentinels(systemInstructions(request.messages));
    // Native video, for a model its owner turned it on for: a model that reads video reads images.
    const videoOn = options.resolveVideo !== undefined && (connection.videoModels ?? []).includes(request.model);
    const readsImages = videoOn || (options.supportsImages ?? modelReadsImages)(request.model, request.connectionId);
    const sentinels: string[] = [];
    const resolveVideo = videoOn ? options.resolveVideo : undefined;
    const videoSending: VideoSending | undefined =
      resolveVideo === undefined
        ? undefined
        : {
            resolve: (artifactId) => resolveVideo(artifactId, request.runId),
            register: (video) => {
              const sentinel = newVideoSentinel();
              videos.set(sentinel, video);
              sentinels.push(sentinel);
              return sentinel;
            },
          };
    // Provider naming is confined to this adapter: the workflow and every
    // checkpoint only ever see canonical ids.
    const idToProviderName = new Map(request.tools.map((entry) => [entry.id, entry.name]));
    const providerNameToId = new Map(request.tools.map((entry) => [entry.name, entry.id]));
    // History survives changes to the offered catalog. Its names need wire
    // encoding too, without admitting those tools to the current call set.
    for (const message of request.messages) {
      for (const call of message.toolCalls ?? []) {
        if (!idToProviderName.has(call.name)) idToProviderName.set(call.name, providerToolName(call.name));
      }
      for (const result of message.toolResults ?? []) {
        if (!idToProviderName.has(result.toolName)) idToProviderName.set(result.toolName, providerToolName(result.toolName));
      }
    }

    // The SDK's default error handler prints the raw provider error (including
    // request internals) to the console. Tavi reports one bounded typed
    // outcome instead, so the raw dump is captured here and never printed.
    let reportedError: unknown;
    try {
      const result = streamText({
        // `.chat(...)` targets the Chat Completions API, which is what an
        // OpenAI-compatible endpoint (including a local server) implements.
        // The default Responses API is OpenAI-specific.
        model: (native
          ? (
              anthropicProvider ??
              createAnthropic({
                baseURL: connection.baseUrl,
                apiKey: credential,
                ...(connection.headers === undefined ? {} : { headers: { ...connection.headers } }),
                fetch: options.fetch ?? globalThis.fetch,
              })
            )(request.model)
          : responses
            ? provider.responses(request.model)
            : provider.chat(request.model)) as unknown as Parameters<typeof streamText>[0]["model"],
        ...(instructions === "" || responses
          ? {}
          : {
              system:
                prefixCache === undefined ? instructions : { role: "system" as const, content: instructions, providerOptions: prefixCache },
            }),
        ...(responses || promptCacheKey !== undefined || openaiEffort !== undefined || openaiCacheOptions !== undefined
          ? {
              providerOptions: {
                openai: {
                  ...(responses ? { store: false, ...(instructions === "" ? {} : { instructions }) } : {}),
                  ...definedOnly({ promptCacheKey, reasoningEffort: openaiEffort, promptCacheOptions: openaiCacheOptions }),
                },
              },
            }
          : anthropicEffort !== undefined
            ? { providerOptions: { anthropic: { effort: anthropicEffort } } }
            : {}),
        // An image only for a model that reads one; any other sees the result's text.
        // A document only on a connection that takes one, and only to a model that can read it: OpenAI
        // reads a PDF with its vision models alone, while OpenRouter parses one for any model. Its page images anywhere else.
        messages: await toSdkMessages(
          native ? nativeBreakpoints(request.messages, cachePolicy) : request.messages,
          idToProviderName,
          readsImages ? options.resolveMedia : undefined,
          connection.pdfInput === "openai-file" && (readsImages || presetOf(connection.baseUrl)?.id === "openrouter")
            ? options.resolveDocument
            : undefined,
          videoSending,
          // The Responses wire is sent no part markers: the Chat Completions transport is what turns them into a provider's own.
          native ? "anthropic" : !responses,
          request.model,
          request.promptLayout === "v2",
        ),
        onError: ({ error }) => {
          reportedError = error;
        },
        tools,
        ...(request.toolChoice === undefined || Object.keys(tools).length === 0 ? {} : { toolChoice: request.toolChoice }),
        // Exactly one generation per call: Tavi's dispatcher routes complete
        // tool calls and LangGraph owns the loop.
        stopWhen: ({ steps }) => steps.length >= 1,
        maxRetries,
        abortSignal: signal,
        // The ChatGPT sign-in wire takes neither; OpenAI's own API, on the Responses wire for a computer call, takes both.
        ...(request.maxOutputTokens === undefined || connection.wireApi === "responses"
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined || connection.wireApi === "responses" ? {} : { temperature: request.temperature }),
      });

      const parts = result.fullStream[Symbol.asyncIterator]();
      let started = false;
      let callerAborted = false;
      // One first-output deadline for the whole call: the SDK's own parts before the reply do not restart it.
      const firstByteBy = Date.now() + deadlines.firstByteMs;
      for (;;) {
        const waitMs = started ? deadlines.idleMs : Math.max(0, firstByteBy - Date.now());
        const next = await nextWithin(parts, waitMs, streamOptions.signal, () => {
          stallError = {
            code: "provider",
            message: started
              ? `The provider sent nothing for ${deadlines.idleMs / 1000} s mid-reply`
              : `The provider sent no output within ${deadlines.firstByteMs / 1000} s`,
            retryable: true,
          };
          stall.abort();
        });
        if (next === "stalled" || next === "aborted") {
          // Settled here even when the SDK ignores the abort: the iterator is let go, never awaited again.
          parts.return?.().catch(() => {});
          callerAborted = next === "aborted";
          break;
        }
        if (next.done === true) break;
        const part = next.value;
        // The SDK's own bookkeeping comes before any byte of the reply, so only the reply's own parts start it.
        if (part.type !== "start" && part.type !== "start-step") started = true;
        switch (part.type) {
          case "text-delta": {
            const previous = text.get(part.id) ?? "";
            text.set(part.id, previous + part.text);
            streamOptions.onEvent({
              type: "text.delta",
              attemptId: request.attemptId,
              blockId: part.id,
              text: part.text,
            });
            break;
          }
          case "tool-input-start": {
            streamOptions.onEvent({
              type: "tool.input.started",
              attemptId: request.attemptId,
              blockId: part.id,
              toolName: part.toolName,
            });
            break;
          }
          case "tool-call": {
            // Report the canonical id: an unrecognized provider name is passed
            // through unchanged so the workflow can reject it as unknown.
            const canonicalName = providerNameToId.get(part.toolName) ?? part.toolName;
            const providerMetadata = (part as { readonly providerMetadata?: Record<string, unknown> }).providerMetadata;
            toolCalls.push({
              id: part.toolCallId,
              name: canonicalName,
              input: part.input,
              ...(providerMetadata === undefined ? {} : { providerMetadata }),
            });
            streamOptions.onEvent({
              type: "tool.completed",
              attemptId: request.attemptId,
              blockId: part.toolCallId,
              toolName: canonicalName,
              callId: part.toolCallId,
              input: part.input,
            });
            break;
          }
          // A native connection's thinking, kept whole with its signature to send back.
          case "reasoning-start":
          case "reasoning-delta": {
            if (!native) break;
            const block = reasoning.get(part.id) ?? { text: "", model: request.model };
            if (part.type === "reasoning-delta") block.text += part.text;
            if (part.providerMetadata !== undefined) block.providerMetadata = { ...block.providerMetadata, ...part.providerMetadata };
            reasoning.set(part.id, block);
            break;
          }
          case "finish": {
            finishReason = part.finishReason;
            usage = toUsage(part.totalUsage);
            break;
          }
          case "error": {
            reportedError = part.error;
            streamError = toModelError(part.error, clock);
            break;
          }
          default:
            break;
        }
      }

      // Ahead of the abort below, which a stall's own abort would otherwise read as the caller's.
      if (stallError !== undefined) return failure(request, stallError, joinText(text), toolCalls, usage);
      if (callerAborted) return { ...abortedOutcome(request), text: joinText(text), toolCalls, usage };
      providerRequestId = await readProviderRequestId(result);
      usage = native
        ? { ...usage, cacheUsageReported: usage.inputCacheReadTokens !== undefined || usage.inputCacheWriteTokens !== undefined }
        : withWireObservation(usage, wire);
    } catch (error) {
      // A stall aborts the stream, and the SDK may throw that abort: it is the stall's, retryable, not the caller's.
      if (stallError !== undefined) return failure(request, stallError, joinText(text), toolCalls, usage);
      if (streamOptions.signal.aborted) {
        return {
          status: "aborted",
          attemptId: request.attemptId,
          text: joinText(text),
          toolCalls,
          usage,
          error: { code: "aborted", message: "Generation was aborted", retryable: false },
        };
      }
      return failure(request, toModelError(error, clock), joinText(text), toolCalls, usage);
    } finally {
      // This call's videos go with it; an SDK retry happened inside it, and a workflow retry makes new ones.
      for (const sentinel of sentinels) videos.delete(sentinel);
    }

    if (streamError === undefined && reportedError !== undefined) {
      streamError = toModelError(reportedError, clock);
    }
    if (streamError !== undefined) {
      return failure(request, streamError, joinText(text), toolCalls, usage);
    }

    // An abort that lands while the stream is draining must not be reported as
    // a successful generation.
    if (streamOptions.signal.aborted) {
      return {
        ...abortedOutcome(request),
        text: joinText(text),
        toolCalls,
        usage,
      };
    }

    return {
      status: "completed",
      attemptId: request.attemptId,
      text: joinText(text),
      toolCalls,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      usage,
      ...(() => {
        const kept = keptReasoning([...reasoning.values()]);
        return kept === undefined ? {} : { reasoning: kept };
      })(),
    };
  };

  /**
   * Texts to vectors through the connection's `/embeddings` endpoint:
   * one request, no SDK retries (the caller's budget decides), every vector
   * checked before it is returned.
   */
  const embedOn = async (
    pinned: ProviderConnection | undefined,
    request: ModelEmbedRequest,
    embedOptions: { readonly signal: AbortSignal },
  ): Promise<ModelEmbedOutcome> => {
    const aborted: ModelEmbedOutcome = {
      status: "aborted",
      attemptId: request.attemptId,
      vectors: [],
      usage: {},
      error: { code: "aborted", message: "Embedding was aborted", retryable: false },
    };
    const failed = (error: ModelError, usage: ModelUsage = {}): ModelEmbedOutcome => ({
      status: error.code === "aborted" ? "aborted" : "failed",
      attemptId: request.attemptId,
      vectors: [],
      usage,
      error,
    });
    const ready = await connectionFor(pinned, request.connectionId, embedOptions.signal);
    if (ready === "aborted") return aborted;
    if ("error" in ready) return failed(ready.error);
    const { connection, credential } = ready;
    const provider = createOpenAI({
      name: connection.connectionId,
      baseURL: connection.baseUrl,
      apiKey: credential,
      ...(connection.headers === undefined ? {} : { headers: { ...connection.headers } }),
      // No compatibility shim: it repairs streamed tool calls, and an embedding is neither.
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    let result: Awaited<ReturnType<typeof embedMany>>;
    try {
      result = await embedMany({
        model: provider.embedding(request.model),
        values: [...request.texts],
        maxRetries,
        maxParallelCalls: 1,
        abortSignal: embedOptions.signal,
      });
    } catch (error) {
      if (embedOptions.signal.aborted) return aborted;
      return failed(toModelError(error, clock));
    }
    if (embedOptions.signal.aborted) return aborted;
    const usage = embedUsageOf(result.usage.tokens);
    let vectors: Float32Array[];
    try {
      vectors = embedVectorsOf(request.texts.length, result.embeddings);
    } catch (error) {
      return failed({ code: "provider", message: errorMessage(error), retryable: false }, usage);
    }
    const header = result.responses?.find((response) => response?.headers?.["x-request-id"] !== undefined)?.headers?.["x-request-id"];
    return {
      status: "completed",
      attemptId: request.attemptId,
      vectors,
      usage,
      ...(header === undefined || header === "" ? {} : { providerRequestId: header }),
    };
  };

  return {
    connections: options.connections,
    videosInFlight: (): number => videos.size,
    stream: (request, streamOptions) => streamOn(undefined, request, streamOptions),
    embed: (request, embedOptions) => embedOn(undefined, request, embedOptions),
    pinned: (connection) => ({
      stream: (request, streamOptions) => streamOn(connection, request, streamOptions),
      embed: (request, embedOptions) => embedOn(connection, request, embedOptions),
    }),
  };
}

/**
 * A Claude model id's family, major and minor version. A minor version is one or two digits, so a date that
 * follows the major (`claude-sonnet-4-20250514`) is no minor.
 */
const CLAUDE_VERSION = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?=-|$))?/;

/** Which Anthropic native computer tool version `model` uses on the Claude Messages API. */
export function anthropicComputerToolKind(model: string): "toolset_20260801" | "computer_20250124" | "computer_20251124" {
  const claude = CLAUDE_VERSION.exec(model);
  if (claude !== null) {
    const family = claude[1];
    const major = Number(claude[2]);
    const minor = Number(claude[3] ?? "0");
    if (major > 5 || (major === 5 && minor >= 5)) return "toolset_20260801";
    if (major === 4 && (family === "sonnet" || family === "haiku") && minor <= 5) return "computer_20250124";
  }
  return "computer_20251124";
}

/** Model-facing schema derived from the canonical Zod schema. */
export function buildSdkTools(
  request: ModelRequest,
  /** Provider options for the last tool: a native Anthropic connection's breakpoint, which caches the tools on their own. */
  lastToolOptions?: NativeCacheOptions,
  nativeOptions?: {
    readonly native?: boolean | undefined;
    readonly responses?: boolean | undefined;
    readonly anthropicProvider?: ReturnType<typeof createAnthropic> | undefined;
    readonly openaiProvider?: ReturnType<typeof createOpenAI> | undefined;
  },
): ToolSet {
  const tools: Record<string, unknown> = {};
  if (request.nativeComputer !== undefined) {
    // Only on a connection that speaks the vendor's own wire: a request elsewhere carries no computer tool.
    if (request.nativeComputer.vendor === "anthropic" && nativeOptions?.native === true) {
      const anth = nativeOptions?.anthropicProvider ?? createAnthropic({ apiKey: "x" });
      const kind = anthropicComputerToolKind(request.model);
      const computerTool =
        kind === "toolset_20260801"
          ? anth.tools.computerToolset_20260801(
              request.nativeComputer.enableZoom === false ? { configs: { zoom: { enabled: false } } } : {},
            )
          : kind === "computer_20250124"
            ? anth.tools.computer_20250124({
                displayWidthPx: request.nativeComputer.displayWidth,
                displayHeightPx: request.nativeComputer.displayHeight,
              })
            : anth.tools.computer_20251124({
                displayWidthPx: request.nativeComputer.displayWidth,
                displayHeightPx: request.nativeComputer.displayHeight,
                ...(request.nativeComputer.enableZoom === undefined ? {} : { enableZoom: request.nativeComputer.enableZoom }),
              });
      Object.assign(tools, {
        computer:
          lastToolOptions !== undefined && request.tools.length === 0
            ? { ...computerTool, providerOptions: lastToolOptions }
            : computerTool,
      });
    } else if (request.nativeComputer.vendor === "openai" && nativeOptions?.responses === true) {
      const oai = nativeOptions?.openaiProvider ?? createOpenAI({ apiKey: "x" });
      Object.assign(tools, { computer: oai.tools.computer() });
    }
  }
  request.tools.forEach((descriptor, index) => {
    // The provider-facing name is the key the model sees and echoes back.
    tools[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputJsonSchema as JSONSchema7),
      ...(lastToolOptions !== undefined && index === request.tools.length - 1 ? { providerOptions: lastToolOptions } : {}),
    });
  });
  return tools as ToolSet;
}

/**
 * Join system messages into the AI SDK `system` option.
 *
 * The SDK rejects a `system` role inside `messages`, so the instruction text is
 * lifted out rather than converted.
 */
export function systemInstructions(messages: readonly ModelMessage[]): string {
  return systemText(messages);
}

/**
 * Convert application message DTOs to AI SDK messages. SDK types stay in this module.
 *
 * `aliases` maps a canonical tool id to its provider-safe function name. A
 * provider rejects a `tool` result whose id is unknown, and it matches call and
 * result by the name *it* was given, so the translation must happen here rather
 * than in the workflow.
 */
export async function toSdkMessages(
  messages: readonly ModelMessage[],
  aliases: ReadonlyMap<string, string> = new Map(),
  resolveMedia?: AiSdkModelAdapterOptions["resolveMedia"],
  resolveDocument?: AiSdkModelAdapterOptions["resolveDocument"],
  video?: VideoSending,
  /**
   * Whether a message's `cacheBreakpoint` reaches the wire as a part marker: the Chat Completions
   * transport turns one into the provider's own marker or drops it; another wire never sees one.
   * `anthropic`: a native Anthropic connection, which takes the marker as its own `cacheControl`, and
   * an assistant message's reasoning sent back as thinking blocks.
   */
  breakpoints: boolean | "anthropic" = true,
  /** The model a native Anthropic call goes to: only reasoning it wrote is sent back. */
  reasoningModel?: string,
  /** `models.promptLayout` `v2`: images in strides, and media words the same whether a file is attached or not. */
  stableMedia = false,
): Promise<SdkModelMessage[]> {
  /** The SDK's part-level marker for a message that carries a breakpoint, when the wire takes one. */
  const markerOf = (message: ModelMessage) => {
    if (message.cacheBreakpoint !== true || breakpoints === false) return {};
    if (breakpoints === "anthropic") return { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } };
    return { providerOptions: { openai: { promptCacheBreakpoint: {} } } };
  };
  // The newest document of this turn only (after the person's last message): a PDF costs as much as its
  // pages, and one from an earlier turn was read then.
  const lastPerson = lastPersonIndex(messages);
  const newestDocument =
    resolveDocument === undefined
      ? undefined
      : messages
          .slice(lastPerson + 1)
          .flatMap((message) => (message.role === "tool" ? (message.toolResults ?? []) : []))
          .filter((result) => DOCUMENT_TOOL_IDS.has(result.toolName) && toolDocumentOf(result.output) !== undefined)
          .at(-1);
  const documents = new Map<ModelToolResult, { readonly mediaType: string; readonly data: Uint8Array }>();
  if (newestDocument !== undefined && resolveDocument !== undefined) {
    const reference = toolDocumentOf(newestDocument.output);
    const resolved = reference === undefined ? undefined : await resolveDocument(reference.artifactId);
    if (resolved !== undefined) documents.set(newestDocument, resolved);
  }
  // The newest video of this turn only, chosen apart from the document: a whole clip costs as much as its frames
  // and its sound, and one from an earlier turn was seen then.
  const newestVideo =
    video === undefined
      ? undefined
      : messages
          .slice(lastPerson + 1)
          .flatMap((message) => (message.role === "tool" ? (message.toolResults ?? []) : []))
          .filter((result) => VIDEO_TOOL_IDS.has(result.toolName) && toolVideoOf(result.output) !== undefined)
          .at(-1);
  const videoFiles = new Map<ModelToolResult, { readonly mediaType: string; readonly data: Uint8Array }>();
  if (newestVideo !== undefined && video !== undefined) {
    const reference = toolVideoOf(newestVideo.output);
    const resolved = reference === undefined ? undefined : await video.resolve(reference.artifactId);
    // The bytes are a video of a type the reference named, or nothing is sent.
    if (resolved !== undefined && resolved.mediaType === reference?.mediaType) videoFiles.set(newestVideo, resolved);
  }
  // The latest `MAX_SHOWN_IMAGES` images are shown, counted image by image: one render of three pages is
  // shown whole, and older images go first, a result's earlier images before its later ones.
  const imageRefs = messages
    .flatMap((message) => (message.role === "tool" ? (message.toolResults ?? []) : []))
    // A result whose document or video is sent shows no images: the document holds its pages, the video its frames.
    .filter((result) => showsImage(result.toolName) && !documents.has(result) && !videoFiles.has(result))
    .flatMap((result) => toolMediaListOf(result.output).map((_, index) => ({ result, index })));
  const shown = new Map<ModelToolResult, Set<number>>();
  // Under `v2` the window never starts inside a result: its images all read alike, so one shown in part would
  // leave the model unable to tell which of its pages it sees.
  let firstShown = firstShownImage(imageRefs.length, stableMedia);
  while (stableMedia && firstShown > 0 && imageRefs[firstShown]?.result === imageRefs[firstShown - 1]?.result) firstShown -= 1;
  for (const { result, index } of imageRefs.slice(firstShown)) {
    const indices = shown.get(result) ?? new Set<number>();
    indices.add(index);
    shown.set(result, indices);
  }
  // The images the tool results of each message show, sent after them as the person's message: Chat Completions
  // takes a tool result as text only, and serialises any other content into it — a screenshot as base64 text.
  const images = new Map<ModelMessage, { readonly mediaType: string; readonly data: Uint8Array }[]>();
  const notes = new Map<ModelMessage, string[]>();
  const converted = await Promise.all(
    messages
      .filter((message) => message.role !== "system")
      .map(async (message) => {
        switch (message.role) {
          case "system":
            // Unreachable: filtered above. Kept so the switch stays exhaustive.
            return { role: "user", content: [{ type: "text", text: message.text }] } satisfies SdkModelMessage;
          // No text the adapter did not write carries a live video sentinel: a page or a person quoting one is inert.
          // A context block and the call's step facts are parts of their own around the words, so the
          // words' part ends where the next call's copy of the message ends.
          case "user": {
            const refs = (message.toolResults ?? []).flatMap((res) => toolMediaListOf(res.output));
            const resolvedList =
              resolveMedia === undefined || refs.length === 0 ? [] : await Promise.all(refs.map((ref) => resolveMedia(ref.artifactId)));
            const userMedia = resolvedList.filter(
              (item): item is { readonly mediaType: string; readonly data: Uint8Array } => item !== undefined,
            );
            return {
              role: "user",
              content: [
                ...(message.contextText === undefined || message.contextText === ""
                  ? []
                  : [{ type: "text" as const, text: defangVideoSentinels(message.contextText) }]),
                { type: "text", text: defangVideoSentinels(message.text), ...markerOf(message) },
                ...(message.trailer === undefined ? [] : [{ type: "text" as const, text: message.trailer }]),
                ...userMedia.map((item) => ({
                  type: "file" as const,
                  mediaType: item.mediaType,
                  data: { type: "data" as const, data: item.data },
                })),
              ],
            } satisfies SdkModelMessage;
          }
          case "assistant": {
            const parts: AssistantModelMessage["content"] = [];
            // A native Anthropic connection is sent the step's thinking back, signature and all, ahead of its words.
            // Only the thinking the same model wrote: another model's signature is not one it can check.
            if (breakpoints === "anthropic")
              for (const block of (message.reasoning ?? []).filter(
                (entry) => reasoningModel === undefined || entry.model === reasoningModel,
              ))
                parts.push({
                  type: "reasoning",
                  text: block.text,
                  ...(block.providerMetadata === undefined ? {} : { providerOptions: reasoningProviderOptions(block.providerMetadata) }),
                });
            if (message.text !== "") parts.push({ type: "text", text: defangVideoSentinels(message.text), ...markerOf(message) });
            for (const call of message.toolCalls ?? []) {
              // A `tool` result is rejected by a provider unless the matching
              // assistant tool call precedes it ("preserve identity").
              parts.push({
                type: "tool-call",
                toolCallId: call.id,
                toolName: aliases.get(call.name) ?? call.name,
                input: defangValue(call.input),
                ...(call.providerMetadata === undefined ? {} : { providerOptions: reasoningProviderOptions(call.providerMetadata) }),
              });
            }
            if (parts.length === 0) parts.push({ type: "text", text: "" });
            const assistant: AssistantModelMessage = { role: "assistant", content: parts };
            return assistant satisfies SdkModelMessage;
          }
          case "tool": {
            const results = message.toolResults ?? [];
            const attached: { readonly mediaType: string; readonly data: Uint8Array }[] = [];
            const toolNotes: string[] = [];
            const toolMessage: ToolModelMessage = {
              role: "tool",
              content: await Promise.all(
                results.map(async (result) => {
                  const wireToolName = aliases.get(result.toolName) ?? result.toolName;
                  // A document tool's result names its document: sent after the results, or said not sent.
                  const document = documents.get(result);
                  const clip = videoFiles.get(result);
                  const base = DOCUMENT_TOOL_IDS.has(result.toolName)
                    ? documentOutput(result.output, document !== undefined, stableMedia)
                    : VIDEO_TOOL_IDS.has(result.toolName)
                      ? videoOutput(result.output, clip !== undefined, stableMedia)
                      : // An observation's elements go as a line each: the words a model reads, not what is stored.
                        result.toolName.startsWith("browser.")
                        ? compactObservationForModel(result.output)
                        : result.output;
                  if (document !== undefined) attached.push(document);
                  if (clip !== undefined) attached.push(clip);
                  // Only the image tools' results show an image (`showsImage`): any other tool's output is
                  // data, whatever keys it happens to carry.
                  // Under `v2` a result whose document or video is sent still says its images' words, none shown:
                  // the same words as when the file is not sent, so the result reads the same either way.
                  const media =
                    showsImage(result.toolName) && ((document === undefined && clip === undefined) || stableMedia)
                      ? await mediaOutput(base, resolveMedia, shown.get(result) ?? new Set(), stableMedia)
                      : undefined;
                  if (wireToolName === "computer" && breakpoints === "anthropic") {
                    const stripped = withoutMedia(base);
                    const text =
                      stripped !== null && typeof stripped === "object" && Object.keys(stripped).length > 0
                        ? JSON.stringify(defangValue(stripped))
                        : typeof stripped === "string" && stripped !== ""
                          ? defangVideoSentinels(stripped)
                          : undefined;
                    const anthropicOutput: ToolResultOutput =
                      media !== undefined && media.images.length > 0
                        ? {
                            type: "content" as const,
                            value: [
                              ...(text !== undefined ? [{ type: "text" as const, text }] : []),
                              ...media.images.map((item) => ({
                                type: "file" as const,
                                mediaType: item.mediaType,
                                data: { type: "data" as const, data: item.data },
                              })),
                            ],
                          }
                        : { type: "text" as const, value: text ?? "ok" };
                    return {
                      type: "tool-result" as const,
                      toolCallId: result.toolCallId,
                      toolName: wireToolName,
                      ...(result === results.at(-1) ? markerOf(message) : {}),
                      output: anthropicOutput,
                    };
                  }
                  if (wireToolName === "computer" && breakpoints === false && media !== undefined && media.images.length > 0) {
                    const firstImg = media.images[0]!;
                    const dataUrl = `data:${firstImg.mediaType};base64,${Buffer.from(firstImg.data).toString("base64")}`;
                    const stripped = withoutMedia(base) as { readonly error?: unknown } | undefined;
                    if (typeof stripped?.error === "string" && stripped.error !== "") {
                      toolNotes.push(defangVideoSentinels(stripped.error));
                    }
                    return {
                      type: "tool-result" as const,
                      toolCallId: result.toolCallId,
                      toolName: wireToolName,
                      output: {
                        type: "json" as const,
                        value: {
                          output: {
                            type: "computer_screenshot",
                            imageUrl: dataUrl,
                            detail: "original",
                          },
                        } as never,
                      },
                    };
                  }
                  if (media !== undefined) attached.push(...media.images);
                  // A sent file's own images are never referenced in the words, whatever tool sent it.
                  const words =
                    media === undefined && stableMedia && (document !== undefined || clip !== undefined) ? withoutMedia(base) : base;
                  const output: ToolResultOutput = defangOutput(
                    media?.output ?? { type: "json" as const, value: (words ?? null) as never },
                  );
                  return {
                    type: "tool-result" as const,
                    toolCallId: result.toolCallId,
                    toolName: wireToolName,
                    // The breakpoint goes on the message's last result: the SDK marks that tool message's text.
                    ...(result === results.at(-1) ? markerOf(message) : {}),
                    // An untrusted result goes as text, fenced in its envelope: the JSON
                    // the provider would have been sent, between the envelope's lines. The checkpoint keeps it raw.
                    output:
                      result.envelope === undefined || output.type !== "json"
                        ? output
                        : { type: "text" as const, value: toolResultText(output.value, result.envelope) },
                  };
                }),
              ),
            };
            if (attached.length > 0) images.set(message, attached);
            if (toolNotes.length > 0) notes.set(message, toolNotes);
            return toolMessage satisfies SdkModelMessage;
          }
          default:
            return { role: "user", content: [{ type: "text", text: message.text }] } satisfies SdkModelMessage;
        }
      }),
  );
  // A run of tool results answers one assistant turn and must follow it unbroken: its images come after the run.
  const kept = messages.filter((message) => message.role !== "system");
  const out: SdkModelMessage[] = [];
  let pending: { readonly mediaType: string; readonly data: Uint8Array }[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const kind = (item: { readonly mediaType: string }): "a document" | "a video" | "an image" =>
      item.mediaType === "application/pdf" ? "a document" : item.mediaType.startsWith("video/") ? "a video" : "an image";
    const kinds = pending.map(kind);
    const said = kinds.every((value) => value === "an image")
      ? pending.length === 1
        ? "The image the tool result above shows:"
        : `The ${pending.length} images the tool results above show, in order:`
      : pending.length === 1
        ? kinds[0] === "a video"
          ? "The video the tool result above names:"
          : "The document the tool result above names:"
        : `What the tool results above name, in order: ${kinds.join(", ")}.`;
    out.push({
      role: "user",
      content: [
        { type: "text", text: said },
        // A video goes as the sentinel the transport replaces: the SDK refuses a `video/*` file part.
        ...pending.map((item) =>
          item.mediaType.startsWith("video/") && video !== undefined
            ? { type: "text" as const, text: video.register(item) }
            : { type: "file" as const, mediaType: item.mediaType, data: { type: "data" as const, data: item.data } },
        ),
      ],
    });
    pending = [];
  };
  kept.forEach((message, index) => {
    if (message.role !== "tool") flush();
    const sdk = converted[index];
    if (sdk !== undefined) out.push(sdk);
    pending.push(...(images.get(message) ?? []));
    const msgNotes = notes.get(message);
    if (msgNotes !== undefined && msgNotes.length > 0) {
      out.push({
        role: "user",
        content: [{ type: "text", text: msgNotes.join("\n") }],
      });
    }
  });
  flush();
  return out;
}

/**
 * A document tool's result as the model reads it: its fields without the
 * internal reference, saying whether the document was sent. Sent, its page
 * images are dropped too: the document holds the pages.
 */
function documentOutput(output: unknown, sent: boolean, stable = false): unknown {
  if (typeof output !== "object" || output === null || !(TOOL_DOCUMENT_KEY in output)) return output;
  const { [TOOL_DOCUMENT_KEY]: _reference, ...rest } = output as Record<string, unknown>;
  // `v2`: the same words sent or not, its pages left for `mediaOutput` to word as it words every image.
  if (stable) return { ...rest, documentFile: STABLE_DOCUMENT_FILE };
  if (!sent)
    return {
      ...rest,
      documentFile:
        "not sent as a file: this connection or model does not take PDFs, or it was read in an earlier turn; its text and pages stand for it",
    };
  const { [TOOL_MEDIA_KEY]: _pages, ...withoutPages } = rest;
  return { ...withoutPages, documentFile: "sent as a file in the next message" };
}

/**
 * The person's last message: the last `user` one, but for the step facts the
 * workflow appends after a run of tool results (`withStepFacts`), which
 * follow those results and are not the person's. This turn's documents and
 * videos are the ones after it.
 */
function lastPersonIndex(messages: readonly ModelMessage[]): number {
  const last = messages.findLastIndex((message) => message.role === "user");
  if (last > 0 && last === messages.length - 1 && messages[last - 1]?.role === "tool")
    return messages.slice(0, last).findLastIndex((message) => message.role === "user");
  return last;
}

/** Every string in `value` with its video sentinel marks made inert. */
function defangValue(value: unknown): unknown {
  if (typeof value === "string") return defangVideoSentinels(value);
  if (Array.isArray(value)) return value.map(defangValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [defangVideoSentinels(key), defangValue(entry)]));
  return value;
}

/** A tool result's output with its text and values' sentinel marks made inert; its images untouched. */
function defangOutput(output: ToolResultOutput): ToolResultOutput {
  if (output.type === "json") return { ...output, value: defangValue(output.value) as never };
  if (output.type === "text") return { ...output, value: defangVideoSentinels(output.value) };
  if (output.type === "content")
    return {
      ...output,
      value: output.value.map((part) => (part.type === "text" ? { ...part, text: defangVideoSentinels(part.text) } : part)),
    };
  return output;
}

/**
 * A video tool's result as the model reads it: its fields without the
 * internal reference, saying whether the video was sent. Sent, its fallback
 * images are dropped too: the video holds its frames.
 */
function videoOutput(output: unknown, sent: boolean, stable = false): unknown {
  if (typeof output !== "object" || output === null || !(TOOL_VIDEO_KEY in output)) return output;
  const { [TOOL_VIDEO_KEY]: _reference, ...rest } = output as Record<string, unknown>;
  if (stable) return { ...rest, videoFile: STABLE_VIDEO_FILE };
  if (!sent)
    return {
      ...rest,
      videoFile: "not sent whole: this model does not take video, or it was viewed in an earlier turn; its frames stand for it",
    };
  const { [TOOL_MEDIA_KEY]: _frames, ...withoutFrames } = rest;
  return { ...withoutFrames, videoFile: "sent whole in the next message" };
}

/**
 * What an image older than the latest `MAX_SHOWN_IMAGES` says in its place. */
const OLDER_IMAGE = "an earlier image, not shown again: later ones show the page as it is now";

/**
 * Whether Anthropic's API takes `output_config.effort` from `model`: Claude 5 and later, and Opus 4.5 to 4.8 and
 * Sonnet 4.6 among the 4.x models. Sonnet 4.5, Haiku 4.5 and older refuse it.
 */
export function anthropicTakesEffort(model: string): boolean {
  const claude = CLAUDE_VERSION.exec(model);
  if (claude === null) return false;
  const major = Number(claude[2]);
  const minor = Number(claude[3] ?? "0");
  if (major >= 5) return true;
  if (major !== 4) return false;
  return (claude[1] === "opus" && minor >= 5 && minor <= 9) || (claude[1] === "sonnet" && minor === 6);
}

/**
 * Whether OpenAI's endpoint takes a reasoning effort from `model`, as the SDK judges a reasoning model: the
 * o-series, and GPT-5 and later but for their `-chat` variants.
 */
export function openaiReasoningModel(model: string): boolean {
  if (/^o\d+(?:-|$)/.test(model)) return true;
  const gpt = /^gpt-(\d+)(\.\d+)?(?:-(.*))?$/.exec(model);
  // As the SDK reads it: a `-chat` variant with no minor version (`gpt-5-chat-latest`) does not reason.
  return gpt !== null && Number(gpt[1]) >= 5 && !(gpt[2] === undefined && (gpt[3] ?? "").startsWith("chat"));
}

/** `output` without its media reference, when it has one. */
function withoutMedia(output: unknown): unknown {
  if (typeof output !== "object" || output === null || !(TOOL_MEDIA_KEY in output)) return output;
  const { [TOOL_MEDIA_KEY]: _media, ...rest } = output as Record<string, unknown>;
  return rest;
}

/** What an image says in its place when the model does not read images, or the image is gone. */
const NOT_SHOWN = "not shown: this model does not read images, or the image is no longer available";

/**
 * `models.promptLayout` `v2`'s words for every image, shown or not: a result's words never change as its image
 * leaves the window, so the cached prefix keeps it. Whether it was shown is what follows the results.
 */
const STABLE_IMAGE = "an image: when shown, it follows these results in a message of its own; an earlier one is not sent again";
/** `v2`'s words for a document, sent as a file or not. */
const STABLE_DOCUMENT_FILE =
  "sent as a file after these results when it is this turn's newest document and this connection takes PDFs; otherwise its text and pages stand for it";
/** `v2`'s words for a video, sent whole or not. */
const STABLE_VIDEO_FILE =
  "sent whole after these results when it is this turn's newest video and this model takes video; otherwise its frames stand for it";

/**
 * An image result (`showsImage`), as the content a vision model reads: the
 * result's own fields as text, then its images that are `shown` (by index).
 * With no resolver (a model that does not read images) or an image the
 * resolver no longer has, the result's fields alone, as JSON, saying the
 * image was not shown — never the internal media reference. A single image
 * reads as before (`image`); several read as `images`, one status each.
 */
async function mediaOutput(
  output: unknown,
  resolveMedia: AiSdkModelAdapterOptions["resolveMedia"],
  shown: ReadonlySet<number>,
  /** `v2`: every image worded `STABLE_IMAGE`, shown or not. */
  stable = false,
): Promise<{ readonly output: ToolResultOutput; readonly images: readonly { readonly mediaType: string; readonly data: Uint8Array }[] }> {
  const media = toolMediaListOf(output);
  if (!hasToolMedia(output)) return { output: { type: "json", value: (output ?? null) as never }, images: [] };
  const { [TOOL_MEDIA_KEY]: _reference, ...rest } = output as Record<string, unknown>;
  // A media key that reads as no image (over the cap, not an image) is removed all the same.
  if (media.length === 0) return { output: { type: "json", value: rest as never }, images: [] };
  const images: { readonly mediaType: string; readonly data: Uint8Array }[] = [];
  const statuses: string[] = [];
  // Resolved together, then read in order: the images and their statuses keep the result's order.
  const resolvedAll = await Promise.all(
    media.map(async (reference, index) => (shown.has(index) ? await resolveMedia?.(reference.artifactId) : undefined)),
  );
  for (const [index, resolved] of resolvedAll.entries()) {
    if (resolved !== undefined) images.push(resolved);
    // A model that reads no images is told so under `v2` too: that is fixed per model, so it moves no prefix.
    statuses.push(
      stable
        ? resolveMedia === undefined
          ? NOT_SHOWN
          : STABLE_IMAGE
        : resolved !== undefined
          ? "shown in the next message"
          : shown.has(index)
            ? NOT_SHOWN
            : OLDER_IMAGE,
    );
  }
  const value = media.length === 1 ? { ...rest, image: statuses[0] } : { ...rest, images: statuses };
  return { output: { type: "json", value: value as never }, images };
}

function joinText(blocks: ReadonlyMap<string, string>): string {
  return [...blocks.values()].join("");
}

/** Retains provider token subsets without filling absent billing details with zero. */
export function toUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokenDetails?: { noCacheTokens?: number | undefined; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined };
  outputTokenDetails?: { reasoningTokens?: number | undefined };
}): ModelUsage {
  const result: ModelUsage = {};
  // A count the provider could not have meant is left out, never a failed turn: the SDK derives
  // `noCacheTokens` as input minus cache reads, and a provider that reports more cache reads than
  // input (Gemini through OpenRouter) makes it negative.
  const count = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const totalTokens = count(usage.totalTokens);
  const noCacheTokens = count(usage.inputTokenDetails?.noCacheTokens);
  const cacheReadTokens = count(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens = count(usage.inputTokenDetails?.cacheWriteTokens);
  const reasoningTokens = count(usage.outputTokenDetails?.reasoningTokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (noCacheTokens !== undefined) result.inputNoCacheTokens = noCacheTokens;
  if (cacheReadTokens !== undefined) result.inputCacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) result.inputCacheWriteTokens = cacheWriteTokens;
  if (reasoningTokens !== undefined) result.outputReasoningTokens = reasoningTokens;
  return result;
}

/** A request message as a native Anthropic connection is sent it: `hourBreakpoint` keeps its breakpoint's entry an hour. */
/** The provider options of a native Anthropic breakpoint. */
type NativeCacheOptions = { readonly anthropic: { readonly cacheControl: { readonly type: "ephemeral"; readonly ttl?: "1h" } } };

/**
 * The breakpoint a native Anthropic connection puts on its last tool and its
 * system text, by the call's policy: none for a call whose prompt no later
 * call reads, an hour-long one under `1h` (ahead of any five-minute one).
 */
function nativePrefixCache(policy: CallCachePolicy | undefined): NativeCacheOptions | undefined {
  if (policy === "none") return undefined;
  return { anthropic: { cacheControl: policy === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } } };
}

/** Whether a request message can carry a breakpoint on a native Anthropic connection: words of its own, or a tool result. */
function nativeCarries(message: ModelMessage): boolean {
  if (message.role === "user") return message.text !== "";
  if (message.role === "tool") return (message.toolResults?.length ?? 0) > 0;
  return message.role === "assistant" && message.text !== "";
}

/**
 * `messages` with the breakpoints a native Anthropic connection is sent. The
 * agent loop's own (`models.promptLayout` `v2`) when it placed any; else the
 * places the OpenRouter transport marks under `v1`: the message before the
 * context block, and the newest message the next call still carries (the
 * one before a trailing step note). A breakpoint there caches the tools and
 * system text before it too, which carry breakpoints of their own (`nativePrefixCache`). `none` sends none.
 */
function nativeBreakpoints(messages: readonly ModelMessage[], policy: CallCachePolicy | undefined): ModelMessage[] {
  if (policy === "none") return messages.map(({ cacheBreakpoint: _mark, ...message }) => message);
  const marked = new Set<number>();
  messages.forEach((message, index) => {
    if (message.cacheBreakpoint === true) marked.add(index);
  });
  if (marked.size === 0) {
    const nearestBefore = (from: number) => messages.findLastIndex((message, index) => index <= from && nativeCarries(message));
    const block = messages.findLastIndex((message) => message.role === "user" && message.text.startsWith(CONTEXT_MESSAGE_HEAD));
    const last = messages.length - 1;
    for (const at of [block > 0 ? nearestBefore(block - 1) : -1, nearestBefore(messages[last]?.role === "user" ? last - 1 : last)])
      if (at !== -1) marked.add(at);
  }
  // An hour-long entry must come before any five-minute one: under `1h` the tools and system text carry it
  // (`nativePrefixCache`), and the messages' stay five minutes.
  return messages.map((message, index) => (marked.has(index) ? { ...message, cacheBreakpoint: true } : message));
}

/** A reasoning part's provider options, as the SDK takes them on an assistant message. */
type ReasoningProviderOptions = NonNullable<
  Extract<Exclude<AssistantModelMessage["content"], string>[number], { type: "reasoning" }>["providerOptions"]
>;

/**
 * A reasoning block's stored provider metadata as the provider options it is
 * sent back with: each provider's own object, copied as JSON (a signature, redacted data).
 */
function reasoningProviderOptions(metadata: Record<string, unknown>): ReasoningProviderOptions {
  const options: ReasoningProviderOptions = {};
  for (const [provider, value] of Object.entries(metadata))
    if (value !== null && typeof value === "object" && !Array.isArray(value)) options[provider] = JSON.parse(JSON.stringify(value));
  return options;
}

/**
 * The reasoning blocks an outcome keeps: all of them, each whole, or none —
 * a cut block fails its signature, and a step sent back with some of its
 * thinking missing is refused, while one sent back with none is answered
 * afresh. `undefined` for none.
 */
function keptReasoning(
  blocks: readonly { readonly text: string; readonly model: string; readonly providerMetadata?: Record<string, unknown> }[],
): ModelReasoning[] | undefined {
  if (blocks.length === 0 || blocks.length > MAX_REASONING_BLOCKS || blocks.some((block) => block.text.length > MAX_MESSAGE_TEXT_BYTES))
    return undefined;
  return blocks.map((block) => ({
    text: block.text,
    model: block.model,
    ...(block.providerMetadata === undefined ? {} : { providerMetadata: block.providerMetadata }),
  }));
}

/** How many calls a minute one `prompt_cache_key` takes before a chat's calls spread over shards: OpenAI's guidance. */
const PROMPT_CACHE_KEY_RPM = 15;

/** What a provider is told of a cache key: a digest, which ties calls together and says nothing else. */
function cacheKeyDigest(key: string): string {
  return `tavi-${sha256Hex(key).slice(0, 24)}`;
}

/** The callers whose prompt no later call reads: a breakpoint would only bill to write it. */
// A routine evaluation is not among them: its up to 40 calls send one role's system prompt each, which the
// default marks keep (below a provider's cache minimum, a mark is simply not cached and costs nothing).
const UNCACHED_SITES: ReadonlySet<string> = new Set(["compaction", "summarizer", "classifier"]);

/** How a call's prompt is to be cached, by its site and the caller's `cacheTtl`; `undefined` for the default marks. */
function cachePolicyOf(site: ModelCallSite | undefined, cacheTtl: "1h" | undefined): CallCachePolicy | undefined {
  if (site !== undefined && UNCACHED_SITES.has(site)) return "none";
  return cacheTtl;
}

/** `usage` with what the call's transport saw: its prefix hash, and whether the provider reported its cache. */
function withWireObservation(usage: ModelUsage, wire: WireObservation): ModelUsage {
  return {
    ...usage,
    ...(wire.prefixHash === undefined ? {} : { wirePrefixHash: wire.prefixHash }),
    ...(wire.cacheUsageReported === undefined ? {} : { cacheUsageReported: wire.cacheUsageReported }),
  };
}

/**
 * Best-effort provider request id.
 *
 * The SDK surfaces an error response body as a rejection, so this is a
 * diagnostic convenience only; its absence is never treated as a failure.
 */
async function readProviderRequestId(result: {
  readonly response: PromiseLike<{ id?: string; headers?: Record<string, string> }>;
}): Promise<string | undefined> {
  try {
    const response = await result.response;
    const headerId = response.headers?.["x-request-id"];
    if (typeof headerId === "string" && headerId !== "") return headerId;
    return typeof response.id === "string" && response.id !== "" ? response.id : undefined;
  } catch {
    return undefined;
  }
}

function abortedOutcome(request: ModelRequest): ModelOutcome {
  return {
    status: "aborted",
    attemptId: request.attemptId,
    text: "",
    toolCalls: [],
    usage: {},
    error: { code: "aborted", message: "Generation was aborted", retryable: false },
  };
}

/** A stream's deadlines in milliseconds: the connection's own, else the defaults — a reasoning call's first longer. */
export function streamDeadlinesOf(
  connection: Pick<ProviderConnection, "streamFirstByteSeconds" | "streamIdleSeconds">,
  request: Pick<ModelRequest, "model" | "reasoningEffort">,
): { readonly firstByteMs: number; readonly idleMs: number } {
  const bare = request.model.slice(request.model.lastIndexOf("/") + 1);
  const reasons = request.reasoningEffort !== undefined || openaiReasoningModel(bare) || anthropicTakesEffort(bare);
  const firstByte = connection.streamFirstByteSeconds ?? (reasons ? STREAM_REASONING_FIRST_BYTE_SECONDS : STREAM_FIRST_BYTE_SECONDS);
  return { firstByteMs: firstByte * 1000, idleMs: (connection.streamIdleSeconds ?? STREAM_IDLE_SECONDS) * 1000 };
}

/**
 * The iterator's next part, or `stalled` once `timeoutMs` passes without one (`onStall` runs first), or `aborted`
 * once `signal` aborts: a hung provider settles the call either way, whatever its transport does with the abort.
 */
function nextWithin<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal: AbortSignal,
  onStall: () => void,
): Promise<IteratorResult<T> | "stalled" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = (): void => {
      settle();
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      settle();
      resolve("stalled");
      onStall();
    }, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    iterator.next().then(
      (result) => {
        settle();
        resolve(result);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

function failure(
  request: ModelRequest,
  error: ModelError,
  text = "",
  toolCalls: { id: string; name: string; input: unknown }[] = [],
  usage: ModelUsage = {},
): ModelOutcome {
  return {
    status: error.code === "aborted" ? "aborted" : "failed",
    attemptId: request.attemptId,
    text,
    toolCalls,
    usage,
    error,
  };
}

/**
 * Map a transport error to a typed outcome.
 *
 * Unknown usage stays unknown; a provider failure is never reported as a
 * successful empty completion.
 */
/** The `error.code` a ChatGPT plan's refusal carries (OpenAI's SIWC list), in the error or what it wraps. */
function planErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    const item = current as { responseBody?: unknown; data?: unknown; cause?: unknown };
    for (const body of [item.responseBody, item.data]) {
      let parsed: unknown = body;
      if (typeof body === "string") {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
      }
      const code = (parsed as { error?: { code?: unknown } } | undefined)?.error?.code;
      if (typeof code === "string" && (code.startsWith("subscription_sharing_") || code.startsWith("chatpass_v2_"))) return code;
    }
    current = item.cause;
  }
  return undefined;
}

/**
 * What a plan refusal means (OpenAI's recovery table): the usage limit is a
 * quota, never retried; unavailability is the provider's, retried with
 * backoff; an invalid subscriber is the sign-in's; everything else (not
 * eligible, an unsupported capability or route, a permission context) is the
 * request's, never retried and never read as a wrong key.
 */
function planError(code: string, message: string): ModelError {
  if (code === "subscription_sharing_usage_limit_exceeded") return { code: "quota_exceeded", message, retryable: false };
  if (code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable")
    return { code: "provider", message, retryable: true };
  if (code === "subscription_sharing_invalid_user") return { code: "auth", message, retryable: false };
  return { code: "invalid_request", message, retryable: false };
}

export function toModelError(error: unknown, now: () => number = Date.now): ModelError {
  // With the SDK's retries on (`maxRetries` above 0), its last attempt's error
  // arrives wrapped: classified as that error, not as the wrapper.
  if (RetryError.isInstance(error)) return toModelError(error.lastError, now);
  const classified = classifyModelError(error, now);
  // A key that can pay for fewer output tokens than were asked for: the turn asks once more for what it can afford.
  const affordable = Number(AFFORDABLE_TOKENS_PATTERN.exec(classified.message)?.[1] ?? 0);
  return affordable > 0 ? { ...classified, affordableTokens: affordable } : classified;
}

function classifyModelError(error: unknown, now: () => number): ModelError {
  // Scrubbed at the source, because this message goes everywhere: `finalText` on a
  // durable task row, `tavi tasks`, and (for a tool failure) the model's own
  // context. A misbehaving or compromised OpenAI-compatible endpoint can echo the
  // request — including the `Authorization` header — in its error body.
  const message = scrubCredentialText(errorMessage(error));
  const name = error instanceof Error ? error.name : "";
  const status = readStatusCode(error);

  if (name === "AbortError" || name === "TimeoutError") {
    return { code: "aborted", message, retryable: false };
  }
  const retryAfterMs = readRetryAfterMs(error, now);
  const later = retryAfterMs === undefined ? {} : { retryAfterMs };
  // A ChatGPT plan's own refusals (OpenAI's SIWC codes), whatever their status says.
  const planCode = planErrorCode(error);
  if (planCode !== undefined)
    return {
      ...planError(planCode, message),
      ...(planCode === "subscription_sharing_usage_unavailable" || planCode === "subscription_sharing_user_unavailable" ? later : {}),
    };
  // Billing arrives on more than a 429: 402 Payment Required is always one, and
  // OpenRouter reports a key's spending cap ("Key limit exceeded") on a 403
  // that is otherwise an auth failure.
  if (status === 402 || (status === 403 && isQuotaExhaustion(error, message))) {
    return { code: "quota_exceeded", message, retryable: false };
  }
  if (status === 401 || status === 403) return { code: "auth", message, retryable: false };
  if (status === 429) {
    // A 429 covers both "slow down" and "you are out of credit". Only the first
    // is retryable; retrying a billing failure burns the attempt budget for a
    // request that cannot succeed until the operator intervenes.
    return isQuotaExhaustion(error, message)
      ? { code: "quota_exceeded", message, retryable: false }
      : { code: "rate_limit", message, retryable: true, ...later };
  }
  // A request timeout and a conflict are the provider's to retry: the SDK's own
  // `APICallError.isRetryable` says so, and failover follows the SDK.
  if (status === 408 || status === 409) return { code: "provider", message, retryable: true, ...later };
  if ([400, 404, 410].includes(status ?? 0)) {
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
      const item = current as { responseBody?: unknown; cause?: unknown };
      if (typeof item.responseBody === "string") {
        try {
          const body = JSON.parse(item.responseBody) as { error?: { code?: unknown } };
          if (["model_retired", "model_decommissioned"].includes(String(body.error?.code)))
            return { code: "model_retired", message, retryable: false };
        } catch {
          /* Unstructured failures do not establish retirement. */
        }
      }
      current = item.cause;
    }
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      code: "invalid_request",
      message,
      retryable: false,
      ...(CONTEXT_OVERFLOW_PATTERN.test(message) ? { contextOverflow: true } : {}),
    };
  }
  if (status !== undefined && status >= 500) return { code: "provider", message, retryable: true, ...later };
  // A provider error inside the stream, after its first part, with no status
  // to read: AI SDK 7's own classification decides (`StreamProviderError`).
  if (StreamProviderError.isInstance(error)) {
    return error.isRetryable ? { code: "provider", message, retryable: true, ...later } : { code: "unknown", message, retryable: false };
  }
  // A call that reached no status — the endpoint refused the connection, or
  // the network dropped it. The SDK calls it retryable; tavi does not fail it
  // over: the same outage usually reaches the fallback too, and the
  // run says what happened instead of spending the chain on it.
  if (APICallError.isInstance(error)) return { code: "unknown", message, retryable: false };
  // AI SDK local-validation failures (`InvalidPromptError`,
  // `TypeValidationError`, `InvalidArgumentError`, …) are deterministic
  // configuration defects, not provider faults; they carry no HTTP status.
  if (name.startsWith("AI_") || name.startsWith("AI")) {
    return { code: "invalid_request", message, retryable: false };
  }
  return { code: "unknown", message, retryable: false };
}

/**
 * Detect a billing/quota failure carried on an HTTP 429 or 403.
 *
 * Providers signal this in the body rather than the status: OpenAI reports
 * `type: "insufficient_quota"` and `code: "credit_balance_exhausted"`, and
 * OpenRouter says "Key limit exceeded" or "insufficient credits". The message
 * is checked as a last resort because not every compatible server populates
 * the structured fields.
 */
export function isQuotaExhaustion(error: unknown, message: string): boolean {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const record = current as { data?: unknown; type?: unknown; code?: unknown; cause?: unknown };
    if (record.type === "insufficient_quota" || record.code === "credit_balance_exhausted") return true;
    const data = record.data;
    if (typeof data === "object" && data !== null) {
      const detail = data as { type?: unknown; code?: unknown };
      if (detail.type === "insufficient_quota" || detail.code === "credit_balance_exhausted") return true;
    }
    current = record.cause;
  }
  return /insufficient_quota|credit_balance_exhausted|no credits remaining|exceeded your current quota|insufficient credits|key limit exceeded/i.test(
    message,
  );
}

/**
 * Read `Retry-After` from a transport error's response headers, through the
 * `cause` chain as the status is: seconds, or an HTTP date. `undefined` when
 * absent or unreadable; bounded to a day.
 */
export function readRetryAfterMs(error: unknown, now: () => number = Date.now): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const candidate = current as { responseHeaders?: unknown; cause?: unknown };
    const headers = candidate.responseHeaders;
    if (typeof headers === "object" && headers !== null) {
      const entry = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
      if (typeof entry === "string" && entry.trim() !== "") {
        const seconds = Number(entry.trim());
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(entry) - now();
        if (!Number.isFinite(ms)) return undefined;
        return Math.min(Math.max(0, Math.round(ms)), 86_400_000);
      }
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Read an HTTP status from a transport error.
 *
 * The SDK nests provider failures (for example an `APICallError` inside a retry
 * wrapper), so the status is looked up through the `cause` chain rather than
 * only on the outermost object — otherwise a 401 is reported as an unknown
 * failure and a caller cannot distinguish it from a network fault.
 */
export function readStatusCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const candidate = current as { statusCode?: unknown; status?: unknown; cause?: unknown };
    if (typeof candidate.statusCode === "number") return candidate.statusCode;
    if (typeof candidate.status === "number") return candidate.status;
    current = candidate.cause;
  }
  return undefined;
}
