import { randomBytes } from "node:crypto";
/**
 * OpenAI-compatible transport compatibility shim.
 *
 * Two provider quirks of the same family — both observed live against Gemini's
 * `v1beta/openai/` endpoint, and both fatal rather than cosmetic — are handled
 * here, at the one seam this adapter already injects for tests.
 *
 * **Inbound: a missing `tool_calls[].index`.** Described in full below.
 *
 * **Outbound: a `thought_signature` that must be echoed back.** Gemini returns a
 * signature inside every tool call it streams
 * (`tool_calls[].extra_content.google.thought_signature`) and *rejects the next
 * request* unless the assistant tool-call message carries it back:
 *
 * ```
 * 400 INVALID_ARGUMENT — Function call is missing a thought_signature in
 * functionCall parts. This is required for tools to work correctly…
 * ```
 *
 * The AI SDK reconstructs the assistant message from its own state and drops
 * the non-standard `extra_content` field, so every tool-using conversation died
 * on its second turn — which made the whole unattended scenario impossible
 * rather than degraded. The shim captures each signature as it
 * streams past, keyed by the provider's tool-call id, and re-attaches it to the
 * matching `tool_calls[]` entry of a later request.
 *
 * Doing this at the transport boundary is deliberate. The alternative — carrying
 * the signature through Tavi's own transcript — would mean persisting a
 * provider-specific field in checkpointed state that every other provider
 * ignores, and changing it back when the provider changes. Here it stays a
 * property of the connection, which is what it is.
 *
 * Because the state is per-connection rather than per-request, the returned
 * `fetch` must be created **once per adapter**, not once per call; see
 * `createAiSdkModelAdapter`.
 *
 * The OpenAI Chat Completions streaming format gives every `tool_calls`
 * fragment an `index` field — it is how a client reassembles several tool calls
 * (and several fragments of one call) that arrive across successive chunks. The
 * AI SDK's OpenAI provider validates that shape and **requires** `index`, but
 * some OpenAI-compatible servers omit it for a tool call delivered whole in a
 * single delta. Gemini's `v1beta/openai/` endpoint does exactly that, and the
 * result is not a degraded call but a hard failure before Tavi sees anything:
 *
 * ```
 * Type validation failed: ... path: ["choices", 0, "delta", "tool_calls", 0, "index"]
 *   → Invalid input: expected number, received undefined
 * ```
 *
 * Observed live against `gemini-3.6-flash`: every scheduled
 * run failed on its first tool call, so this is a blocker for the whole
 * unattended scenario rather than a cosmetic difference.
 *
 * The shim is applied at the transport boundary — the one seam this adapter
 * already injects for tests — and it only ever **adds a missing `index`**. A
 * conformant provider is passed through byte-for-byte, so there is no
 * per-provider switch to keep in sync and nothing to get wrong for OpenAI
 * itself.
 *
 * On the value chosen: `index` is the position of the fragment within the
 * current delta. That is exactly right for a provider that sends a whole tool
 * call in one delta, which is the shape this exists for. A provider that split
 * one call across deltas *and* omitted `index` would be genuinely
 * unreconstructable — no client could tell "second fragment of call 0" from
 * "first fragment of call 1" — so no guess is attempted beyond the position,
 * and that limitation is stated rather than hidden.
 *
 * **Outbound: prompt-cache breakpoints** for the models on OpenRouter that
 * cache only what is marked (Anthropic's, and Gemini's last), as each call's
 * policy says, and the `session_id` that keeps a chat's calls on one provider
 * — see `prompt-cache.ts`.
 */

import {
  fetchUrl,
  hasPartBreakpoints,
  usageReportsCache,
  wirePrefixHash,
  withPromptCacheBreakpoints,
  withReasoningEffort,
  withSessionId,
  type CallCachePolicy,
} from "./prompt-cache.js";

/**
 * One call's exchange with the transport. In: how its prompt is to be cached
 * (`cache`) and the session that keeps a chat's calls on one provider
 * (`sessionId`, sent to a provider that takes one). Out, for its usage
 * record: the cacheable prefix it sent (`wirePrefixHash`) and whether the
 * provider's streamed usage spoke of its cache at all, filled in as the
 * request goes out and its stream is read.
 */
export interface WireObservation {
  readonly cache?: CallCachePolicy;
  /** Whether the call's preset takes `cache_control` breakpoints (`promptCache.breakpoints`). */
  readonly breakpoints?: boolean;
  /** Sent as `session_id`: set only for a preset that takes one (`promptCache.sessionId`). */
  readonly sessionId?: string;
  /** Sent as OpenRouter's `reasoning.effort`: set only on OpenRouter. */
  readonly reasoningEffort?: string;
  prefixHash?: string;
  cacheUsageReported?: boolean;
  /**
   * When the stream last carried a `data:` line (not a keep-alive comment): what the call's deadlines count, since
   * the SDK reads a line of reasoning in a field it does not know, such as Ollama's `reasoning`, as no output at all.
   */
  lastDataAt?: number;
  /** The prompt's text as sent, in characters: its messages' words and the tool definitions, never an image's bytes. */
  promptChars?: number;
}

/**
 * The key a call's `RequestInit` carries its `WireObservation` under. The
 * transport is shared by every call on a connection, so the observation rides
 * on the call's own request rather than on the transport.
 */
export const WIRE_OBSERVATION = Symbol("tavi.wireObservation");

/** `fetch` for one call: the connection's transport, told where to record what it sees. */
export function observedFetch(transport: typeof globalThis.fetch, observation: WireObservation): typeof globalThis.fetch {
  return (input, init) => transport(input, { ...init, [WIRE_OBSERVATION]: observation } as RequestInit);
}

/** A Chat Completions body's prompt text in characters: each message's text and the tools as sent, no images. */
export function promptTextChars(body: unknown): number | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { messages, tools } = parsed as { readonly messages?: unknown; readonly tools?: unknown };
  if (!Array.isArray(messages)) return undefined;
  let chars = Array.isArray(tools) ? JSON.stringify(tools).length : 0;
  for (const message of messages as unknown[]) {
    const content = (message as { readonly content?: unknown } | null)?.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content))
      for (const part of content as unknown[]) {
        const text = (part as { readonly text?: unknown } | null)?.text;
        if (typeof text === "string") chars += text.length;
      }
    const calls = (message as { readonly tool_calls?: unknown } | null)?.tool_calls;
    if (Array.isArray(calls)) chars += JSON.stringify(calls).length;
  }
  return chars;
}

/**
 * Why a reply cannot be trusted when the server read far less of the prompt than was sent: fewer than one token per
 * eight characters, where text runs three to four. A local server does this silently when its context is smaller than
 * the prompt (Ollama's default is 4,096 tokens), and its reply then answers whatever end of the prompt it kept.
 */
export function truncatedPromptReason(promptTokens: number | undefined, promptChars: number | undefined): string | undefined {
  // Under 16,000 characters a prompt fits the smallest context a server runs (4,096 tokens), and a short count is noise.
  if (promptTokens === undefined || promptTokens === 0 || promptChars === undefined || promptChars < 16_000) return undefined;
  if (promptTokens * 8 >= promptChars) return undefined;
  const sent = Math.round(promptChars / 4 / 1000);
  // Room for the prompt and a reply, at a size servers offer.
  const needed = Math.max(8, 2 ** Math.ceil(Math.log2(((promptChars / 4) * 1.25) / 1000)));
  return (
    `The model server read only ${promptTokens.toLocaleString("en-US")} tokens of a prompt of about ${String(sent)}K: ` +
    "its context is smaller than the prompt, so it cut the request and its reply would not answer it. " +
    `Raise the server's context length to ${String(needed)}K or more — on Ollama, in its Settings (Context length) or with OLLAMA_CONTEXT_LENGTH.`
  );
}

/** The usage object a streamed `data:` line carries, if any. */
function streamedUsage(line: string): unknown {
  if (!line.startsWith("data:") || !line.includes('"usage"') || line.includes('"usage":null')) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(5).trim());
    return parsed !== null && typeof parsed === "object" ? (parsed as { readonly usage?: unknown }).usage : undefined;
  } catch {
    return undefined;
  }
}

/** Only a streaming response is rewritten; anything else must pass through untouched. */
function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * Remembers provider-specific per-tool-call extras that must be sent back on a
 * later request, keyed by the provider's tool-call id.
 *
 * **Scope matters more than the data structure here.** Provider tool-call ids
 * are counter-like (`call_142633`), so they are not globally unique: matching on
 * the id alone can attach one conversation's signature to an unrelated tool
 * call, and the provider then rejects the request with "thought signature is not
 * valid" — a failure indistinguishable from the one this shim fixes. It is
 * therefore scoped to a single connection (one store per `fetch`, and the
 * adapter builds one `fetch` per connection) with an age bound and a tool-name
 * check on every read, so the window in which a wrong match is possible is a
 * fraction of a live conversation rather than the life of the process.
 *
 * Bounded in size as well: entries are evicted least-recently-*used* once the
 * cap is reached. The cap is far above what one task can produce (the workflow
 * allows 8 model steps and 24 tool calls per turn), so eviction only ever
 * affects abandoned conversations.
 */
class ToolCallExtraStore {
  readonly #entries = new Map<string, { readonly extra: unknown; readonly name: string | undefined; readonly capturedAt: number }>();
  readonly #max: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(max: number, maxAgeMs: number, now: () => number) {
    this.#max = max;
    this.#maxAgeMs = maxAgeMs;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * The signature for `id`, when it is still usable.
   *
   * Three guards, each closing a way a signature could be attached to the wrong
   * tool call — which produces a provider rejection indistinguishable from the
   * bug this shim exists to fix:
   *
   *  - **age**: a finished conversation's signature must not resurface in a
   *    later, unrelated one. Entries older than `maxAgeMs` are refused and
   *    dropped;
   *  - **name**: the stored tool name must match the request's, so a recycled id
   *    for a *different* tool cannot pick up the wrong signature;
   *  - **refresh on use**: a live conversation re-sends its earlier tool calls
   *    on every later turn, so a successful read is what keeps an entry alive.
   *    Eviction is therefore least-recently-*used*, not least-recently-captured
   *    (which would evict a long conversation's first tool call while it was
   *    still in progress).
   */
  get(id: string, name: string | undefined, now: number): unknown {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (now - entry.capturedAt > this.#maxAgeMs) {
      this.#entries.delete(id);
      return undefined;
    }
    if (entry.name !== undefined && name !== undefined && entry.name !== name) return undefined;
    // Refresh recency: this entry is demonstrably still in use.
    this.#entries.delete(id);
    this.#entries.set(id, { ...entry, capturedAt: now });
    return entry.extra;
  }

  set(id: string, extra: unknown, name: string | undefined): void {
    this.#entries.delete(id);
    this.#entries.set(id, { extra, name, capturedAt: this.#now() });
    this.#prune();
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of [...this.#entries]) {
      if (now - entry.capturedAt > this.#maxAgeMs) this.#entries.delete(id);
    }
  }
}

/**
 * Adds a missing `index` to every `choices[].delta.tool_calls[]` entry in one
 * SSE `data:` payload, and captures any `extra_content` it carries.
 *
 * Returns `undefined` when the line needs no change, so the caller can forward
 * the original bytes rather than re-serializing and risking a difference in
 * key order or number formatting for a line it did not need to touch. Capture
 * is a separate side effect and happens whether or not the line was rewritten.
 */
function patchToolCallIndexes(
  line: string,
  extras: ToolCallExtraStore,
  pending: Map<number, { id?: string; name?: string; extra?: unknown }>,
): string | undefined {
  const prefix = "data:";
  if (!line.startsWith(prefix)) return undefined;
  const payload = line.slice(prefix.length).trim();
  // `[DONE]` and any other non-JSON keepalive/comment is not ours to interpret.
  if (payload === "" || payload === "[DONE]" || !payload.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A malformed payload is the provider's problem to report; rewriting is not
    // this shim's job, and swallowing it here would hide the real error.
    return undefined;
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;

  let changed = false;
  for (const choice of choices) {
    const toolCalls = (choice as { delta?: { tool_calls?: unknown } }).delta?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    toolCalls.forEach((call, position) => {
      if (call === null || typeof call !== "object") return;
      const record = call as Record<string, unknown>;
      if (record["index"] === undefined) {
        record["index"] = position;
        changed = true;
      }
      // Captured before any rewrite: the signature is the provider's, and this
      // shim only ever relays it.
      //
      // A provider may put the id and the signature on *different* fragments of
      // one tool call — the same splitting that makes the `index` fix necessary.
      // So the two are merged per index within this one stream, in whichever
      // order they arrive, and stored only once both are known. (The first
      // version assumed the id came first and silently lost the other order;
      // a test with the fragments reversed is what caught it.)
      const index = typeof record["index"] === "number" ? record["index"] : position;
      const id = typeof record["id"] === "string" && record["id"] !== "" ? record["id"] : undefined;
      const name = (record["function"] as { readonly name?: unknown } | undefined)?.name;
      const extra = record["extra_content"];
      if (id === undefined && name === undefined && extra === undefined) return;

      const held = pending.get(index) ?? {};
      if (id !== undefined) held.id = id;
      if (typeof name === "string") held.name = name;
      if (extra !== undefined) held.extra = extra;
      if (held.id !== undefined && held.extra !== undefined) {
        extras.set(held.id, held.extra, held.name);
        pending.delete(index);
      } else {
        pending.set(index, held);
      }
    });
  }
  return changed ? `${prefix} ${JSON.stringify(parsed)}` : undefined;
}

/**
 * Wraps a `fetch` so streamed tool-call deltas always carry an `index`.
 *
 * Line-buffered rather than chunk-wise: a `data:` line routinely arrives split
 * across two network reads, and patching half a JSON object would corrupt the
 * stream it is meant to repair.
 */
/** Far above one task's ceiling (8 model steps, 24 tool calls per turn), so only abandoned conversations are ever evicted. */
const DEFAULT_MAX_RETAINED_EXTRAS = 500;

/**
 * How long a captured signature stays usable; 30 minutes.
 *
 * Sized to a live conversation, not to a session: the signature must survive
 * from the tool call that produced it until the turns that re-send it, and those
 * are minutes apart at most. Expiring it is what keeps a finished conversation's
 * signature from resurfacing in a later, unrelated one whose provider-assigned
 * tool-call id happens to match.
 */
const DEFAULT_TOOL_CALL_EXTRA_MAX_AGE_MS = 30 * 60 * 1000;

export interface OpenAiCompatibleTransportOptions {
  /** How many tool-call signatures to retain; defaults to 500. A non-positive or non-integer value falls back to the default rather than silently disabling the fix. */
  readonly maxRetainedToolCallExtras?: number;
  /** How long a captured signature stays usable; defaults to 30 minutes. */
  readonly toolCallExtraMaxAgeMs?: number;
  /** Injectable clock, for tests that need to age an entry out. */
  readonly now?: () => number;
  /**
   * OpenRouter's `file-parser` engine: a request
   * carrying a PDF file part asks for it through OpenRouter's `plugins` field.
   */
  readonly pdfEngine?: "pdf-text" | "mistral-ocr" | "native";
  /**
   * The video a sentinel stands for: the
   * adapter's own registry, read when a request carries one. Absent, any
   * sentinel fails the request.
   */
  readonly videoOf?: (sentinel: string) => { readonly mediaType: string; readonly data: Uint8Array } | undefined;
}

/** A video's place in an outgoing request: a text part the adapter wrote, never a model's or a tool's words. */
const SENTINEL_MARK = "⟦tavi-video:";
const EXACT_SENTINEL = /^⟦tavi-video:[0-9a-f]{32}⟧$/;

/** A fresh sentinel: 128 random bits, so no text can name one it did not see. */
export function newVideoSentinel(): string {
  return `${SENTINEL_MARK}${randomBytes(16).toString("hex")}⟧`;
}

/**
 * `text` with any sentinel mark in it made inert (`⟦tavi-video (quoted):`):
 * what a page, a file, a message or a model wrote is never mistaken for the
 * adapter's own part, and never fails the request for being there.
 */
export function defangVideoSentinels(text: string): string {
  return text.includes(SENTINEL_MARK) ? text.replaceAll(SENTINEL_MARK, "⟦tavi-video (quoted):") : text;
}

/** Why a request carrying a video sentinel is not sent. */
export class VideoSentinelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoSentinelError";
  }
}

/**
 * `body` with each video sentinel the adapter put in a person's message
 * replaced by the video itself, as OpenRouter and vLLM take it (`{ type:
 * "video_url", video_url: { url: "data:…" } }`). A sentinel is matched as a
 * whole text part (or a whole string content) of a `user` message only; one
 * anywhere else — inside other text, a tool result, an assistant turn, or
 * with no registry entry — fails the request (`VideoSentinelError`), so a
 * model or a page can neither forge one nor leave one behind. `undefined`
 * when the body carries none.
 */
export function withVideoParts(body: unknown, videoOf: OpenAiCompatibleTransportOptions["videoOf"]): string | undefined {
  if (typeof body !== "string" || !body.includes(SENTINEL_MARK)) return undefined;
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body) as { messages?: unknown };
  } catch {
    throw new VideoSentinelError("a request naming a video could not be read");
  }
  if (!Array.isArray(parsed.messages)) throw new VideoSentinelError("a video sentinel outside the messages");
  const part = (sentinel: string): Record<string, unknown> => {
    const video = videoOf?.(sentinel);
    if (video === undefined) throw new VideoSentinelError("a video sentinel with no video behind it");
    return { type: "video_url", video_url: { url: `data:${video.mediaType};base64,${Buffer.from(video.data).toString("base64")}` } };
  };
  const exact = (text: unknown): text is string => typeof text === "string" && EXACT_SENTINEL.test(text);
  const messages = parsed.messages.map((message: unknown) => {
    if (message === null || typeof message !== "object") return message;
    const { role, content } = message as { readonly role?: unknown; readonly content?: unknown };
    if (role !== "user") return message;
    if (exact(content)) return { ...message, content: [part(content)] };
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      content: content.map((item: unknown) =>
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        exact((item as { text?: unknown }).text)
          ? part((item as { text: string }).text)
          : item,
      ),
    };
  });
  const rewritten = JSON.stringify({ ...parsed, messages });
  // Whatever is left was not the adapter's own part: refused, never sent as text.
  if (rewritten.includes(SENTINEL_MARK)) throw new VideoSentinelError("a video sentinel where only the adapter's own part may be");
  return rewritten;
}

/**
 * `body` asking OpenRouter's `file-parser` plugin for `engine`, when it is a
 * Chat Completions request that carries a PDF file part and names no
 * `plugins` of its own; `undefined` when nothing changes.
 */
export function withPdfFileParser(body: unknown, engine: "pdf-text" | "mistral-ocr" | "native" | undefined): string | undefined {
  if (engine === undefined || typeof body !== "string" || !body.includes("data:application/pdf;base64,")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || "plugins" in parsed) return undefined;
  return JSON.stringify({ ...parsed, plugins: [{ id: "file-parser", pdf: { engine } }] });
}

/**
 * Re-attaches captured `extra_content` to the assistant tool-call messages of an
 * outgoing request.
 *
 * Only ever *adds* a field that is absent, and only when at least one signature
 * has actually been captured — so a provider that needs none (or a test whose
 * fake `fetch` never streams) sends a byte-identical body. Returns `undefined`
 * when nothing changed, which keeps the caller from re-serializing a request it
 * had no business touching.
 */
function patchOutgoingToolCallExtras(body: unknown, extras: ToolCallExtraStore, now: () => number): string | undefined {
  if (typeof body !== "string" || extras.size === 0 || !body.includes("tool_calls")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON (a multipart upload, a pre-serialized stream): not ours to touch.
    return undefined;
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;

  let changed = false;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record["role"] !== "assistant" || !Array.isArray(record["tool_calls"])) continue;
    for (const call of record["tool_calls"] as unknown[]) {
      if (call === null || typeof call !== "object") continue;
      const entry = call as Record<string, unknown>;
      // The provider's own field wins: if a future SDK version starts
      // round-tripping it, this shim must not second-guess the value.
      if (entry["extra_content"] !== undefined) continue;
      // Symmetric with capture, which requires a non-empty string id:
      // `String(undefined)` would be the literal `"undefined"` and could match a
      // junk entry, and a numeric id can never match one either.
      const id = entry["id"];
      if (typeof id !== "string" || id === "") continue;
      const name = (entry["function"] as { readonly name?: unknown } | undefined)?.name;
      const extra = extras.get(id, typeof name === "string" ? name : undefined, now());
      if (extra === undefined) continue;
      entry["extra_content"] = extra;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : undefined;
}

/**
 * Wrap a `fetch` with both compatibility fixes.
 *
 * Create this **once per adapter**, not per request: the signature store is the
 * memory that makes the outbound half possible, and a per-request instance
 * would forget every signature before it could be used.
 */
export function createOpenAiCompatibleTransport(
  inner: typeof globalThis.fetch,
  options: OpenAiCompatibleTransportOptions = {},
): typeof globalThis.fetch {
  // A non-positive or non-integer cap would silently disable the fix (0) or
  // never evict (NaN), so it is validated rather than trusted.
  const configuredMax = options.maxRetainedToolCallExtras ?? DEFAULT_MAX_RETAINED_EXTRAS;
  const max = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_RETAINED_EXTRAS;
  const maxAgeMs = options.toolCallExtraMaxAgeMs ?? DEFAULT_TOOL_CALL_EXTRA_MAX_AGE_MS;
  const now = options.now ?? ((): number => Date.now());
  const extras = new ToolCallExtraStore(max, maxAgeMs, now);
  return async function compatibleFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const observation = (init as { readonly [WIRE_OBSERVATION]?: WireObservation } | undefined)?.[WIRE_OBSERVATION];
    const patchedBody = patchOutgoingToolCallExtras(init?.body, extras, now);
    // Then the prompt-cache breakpoints an Anthropic model on OpenRouter needs
    // to cache anything (`prompt-cache.ts`); any other request is untouched.
    // The videos first: the cache breakpoints mark a message's last text part, which could be a sentinel.
    const body = withVideoParts(patchedBody ?? init?.body, options.videoOf) ?? patchedBody ?? init?.body;
    const url = fetchUrl(input);
    const markedBody = withPromptCacheBreakpoints(url, body, observation?.cache, observation?.breakpoints);
    // OpenRouter's sticky routing keeps a chat's calls on the provider whose cache holds its prefix.
    const cachedBody =
      observation?.sessionId === undefined ? markedBody : (withSessionId(markedBody ?? body, observation.sessionId) ?? markedBody);
    const effortBody =
      observation?.reasoningEffort === undefined
        ? cachedBody
        : (withReasoningEffort(cachedBody ?? body, observation.reasoningEffort) ?? cachedBody);
    const parserBody = withPdfFileParser(effortBody ?? body, options.pdfEngine);
    const finalBody = parserBody ?? effortBody ?? (body === init?.body ? undefined : body);
    if (observation !== undefined) {
      // Before the markers are turned into a provider's own or dropped: the loop's choice of where the prefix ends.
      const prefixHash = wirePrefixHash(hasPartBreakpoints(body) ? body : (cachedBody ?? body));
      if (prefixHash !== undefined) observation.prefixHash = prefixHash;
      const promptChars = promptTextChars(finalBody ?? init?.body);
      if (promptChars !== undefined) observation.promptChars = promptChars;
    }
    const { [WIRE_OBSERVATION]: _observation, ...plainInit } = (init ?? {}) as RequestInit & {
      readonly [WIRE_OBSERVATION]?: WireObservation;
    };
    const outgoing = finalBody === undefined ? (init === undefined ? undefined : plainInit) : { ...plainInit, body: finalBody };
    const response = await inner(input, outgoing);
    if (!isEventStream(response) || response.body === null) return response;
    /** Notes whether a streamed usage object reports the provider's cache. */
    const observeUsage = (line: string): void => {
      if (observation === undefined) return;
      const usage = streamedUsage(line);
      if (usage !== undefined && usage !== null) observation.cacheUsageReported = usageReportsCache(usage);
    };

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffered = "";
    // Scoped to this one response stream: id and signature may arrive on
    // different fragments of the same tool call, in either order.
    const pending = new Map<number, { id?: string; name?: string; extra?: unknown }>();

    const patched = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffered += decoder.decode(chunk, { stream: true });
          // Split on newlines but keep the final partial line buffered.
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          const out: string[] = [];
          for (const line of lines) {
            // The line's own trailing `\r` (CRLF streams) is re-added below.
            const hasCr = line.endsWith("\r");
            const body = hasCr ? line.slice(0, -1) : line;
            if (observation !== undefined && body.startsWith("data:")) observation.lastDataAt = Date.now();
            observeUsage(body);
            const replaced = patchToolCallIndexes(body, extras, pending);
            out.push(`${replaced ?? body}${hasCr ? "\r" : ""}`);
          }
          if (out.length > 0) controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
        },
        flush(controller) {
          if (buffered === "") return;
          observeUsage(buffered);
          const replaced = patchToolCallIndexes(buffered, extras, pending);
          controller.enqueue(encoder.encode(replaced ?? buffered));
          buffered = "";
        },
      }),
    );

    // Status and headers are preserved: the caller's own error handling and
    // content-type checks must see what the provider sent. `content-length` is
    // the exception and must be dropped — patching lengthens the body (adding
    // `,"index":0` per tool call), and a stale length either truncates the
    // stream or is rejected outright. The body is a stream, so its length is
    // genuinely unknown and belongs to the runtime's chunked encoding.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(patched, { status: response.status, statusText: response.statusText, headers });
  };
}
