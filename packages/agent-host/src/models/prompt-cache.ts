import { CONTEXT_MESSAGE_HEAD } from "@tavi/contracts";
import { isRecord } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * Prompt-cache breakpoints for the models behind OpenRouter that cache only
 * what is marked: Anthropic's (up to four breakpoints) and Gemini's (the last
 * one alone), as the preset's `promptCache.breakpoints` says.
 *
 * An OpenAI model on OpenRouter caches a stable request prefix by itself; an
 * Anthropic model caches nothing unless the request marks where a cached
 * prefix ends, with `cache_control` on a message's content part. The AI SDK's
 * OpenAI-compatible provider sends no such field, so every call of a long tool
 * loop paid for its whole prompt again — the system prompt and tool schemas
 * alone are some 23,000 tokens a call.
 *
 * The outgoing body is marked here, at the transport seam the adapter already
 * owns (`openai-stream-compat.ts`), and only for a request to openrouter.ai
 * whose model is `anthropic/…`: any other provider is sent a byte-identical
 * body. Four breakpoints, all Anthropic allows. Anthropic caches a prefix in
 * the order tools, system, messages; a breakpoint writes the prefix that ends
 * at it, and a later request reads the longest written prefix it shares,
 * looking back some 20 blocks from each of its own breakpoints:
 *  - the last tool schema: the schemas stay cached on their
 *    own when the system string differs — another chat's instructions or
 *    persona over the same tools;
 *  - the system message, which caches the tool schemas before it as well. It
 *    holds no memory, and its runtime facts follow the turn's tool set,
 *    so it is the same on every call of a turn and from one turn of
 *    a chat to the next;
 *  - the end of the stable history: the message before the one the
 *    call's context block rides in (it starts with `CONTEXT_MESSAGE_HEAD`).
 *    The block is rebuilt for each turn and sits at the front of the newest
 *    person message, so nothing after that point is the same next turn; the
 *    history before it is, and is read back instead of written again;
 *  - the newest message the next call still carries: the one before the last
 *    when the last is a user message — a workflow request always ends with
 *    the per-call step note (`renderStepFacts`), on the person's message or
 *    one of its own, which the next call no longer carries — and the last
 *    otherwise. Marking that note itself would write a prefix no later call
 *    shares; this is the step's tool loop, read back by the next step.
 * On a turn's first call the last two are the same message, so three are
 * sent. A message whose content is empty (an assistant turn that only calls
 * tools) cannot carry a breakpoint, so the one before it is marked instead.
 *
 * Under `models.promptLayout` `v2` the agent loop marks the content parts
 * itself (`ModelMessage.cacheBreakpoint`, written by the AI SDK as
 * `prompt_cache_breakpoint`): the turn's opening person message, whose
 * context block is kept on it and never rewritten, and on a later call the
 * newest message before the step facts. Only those marks count then
 * (`withPartBreakpoints`): each becomes a `cache_control` for an Anthropic
 * model on OpenRouter, beside the last tool schema's and the system
 * message's, and every other provider is sent the body without them.
 */

const BREAKPOINT = { type: "ephemeral" } as const;

/** A breakpoint whose entry lives an hour rather than five minutes. */
const HOUR_BREAKPOINT = { type: "ephemeral", ttl: "1h" } as const;

/**
 * How a call's prompt is to be cached (`WireObservation.cache`): `none` for a
 * call whose prefix no later call reads (a summary, a classification), which
 * a breakpoint would only bill to write; `1h` to keep the tools and system
 * text for an hour (a heartbeat's next tick). Absent: the default marks.
 */
export type CallCachePolicy = "none" | "1h";

/**
 * Which models behind an endpoint whose preset takes breakpoints
 * (`promptCache.breakpoints`: OpenRouter) cache only what one marks: an
 * Anthropic model, which reads up to four, and a Gemini one, which reads the
 * last alone. `breakpoints` is the call's preset entry; a caller that does not
 * say (a direct call) is judged by the endpoint's host. `undefined` for any
 * other request, which is sent no breakpoint.
 */
function breakpointFamily(url: string | undefined, model: unknown, breakpoints: boolean | undefined): "anthropic" | "gemini" | undefined {
  if (typeof model !== "string" || breakpoints === false) return undefined;
  const family = model.startsWith("anthropic/") ? "anthropic" : model.startsWith("google/gemini") ? "gemini" : undefined;
  if (family === undefined || breakpoints === true) return family;
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname === "openrouter.ai" ? family : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether OpenAI's endpoint takes `model`'s explicit prompt-cache breakpoints (`prompt_cache_breakpoint` on a
 * part) and `prompt_cache_options`: GPT-5.6 and later. An older model may refuse either field.
 */
export function openaiExplicitCacheModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
  if (gpt === null) return false;
  const major = Number(gpt[1]);
  return major > 5 || (major === 5 && Number(gpt[2] ?? "0") >= 6);
}

/** Whether `url` is OpenAI's own API. */
function isOpenAiHost(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/** Marks `message`'s content as a breakpoint; false when it has no text to carry one. */
function mark(message: Record<string, unknown>, breakpoint: typeof BREAKPOINT | typeof HOUR_BREAKPOINT = BREAKPOINT): boolean {
  const content = message["content"];
  if (typeof content === "string") {
    if (content === "") return false;
    message["content"] = [{ type: "text", text: content, cache_control: breakpoint }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index] as Record<string, unknown> | null;
    if (part !== null && typeof part === "object" && part["type"] === "text" && typeof part["text"] === "string" && part["text"] !== "") {
      part["cache_control"] = breakpoint;
      return true;
    }
  }
  return false;
}

/** The first text a message carries, or "". */
function firstText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const part = content.find(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && (entry as Record<string, unknown>)["type"] === "text",
  );
  return typeof part?.["text"] === "string" ? part["text"] : "";
}

/** Marks the newest message at or before `from` that can carry a breakpoint, never the system message. */
function markFrom(messages: readonly Record<string, unknown>[], from: number): boolean {
  for (let index = from; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message["role"] === "system") continue;
    if (mark(message)) return true;
  }
  return false;
}

/**
 * The request body with prompt-cache breakpoints, or `undefined` when the
 * request is not one to mark (or is not a JSON chat request at all).
 */
export function withPromptCacheBreakpoints(
  url: string | undefined,
  body: unknown,
  policy?: CallCachePolicy,
  /** The call's preset entry (`promptCache.breakpoints`); absent, the endpoint's host decides. */
  breakpoints?: boolean,
): string | undefined {
  const partMarked = withPartBreakpoints(url, body, policy, breakpoints);
  if (partMarked !== undefined) return partMarked;
  if (policy === "none" || typeof body !== "string" || !(body.includes("anthropic/") || body.includes("google/"))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const request = parsed as Record<string, unknown>;
  const family = breakpointFamily(url, request["model"], breakpoints);
  if (family === undefined || !Array.isArray(request["messages"])) return undefined;
  const messages = (request["messages"] as unknown[]).filter(
    (message): message is Record<string, unknown> => message !== null && typeof message === "object",
  );
  // The newest message the next call carries: past a trailing user message, the per-call step note.
  const last = messages.length - 1;
  const newestCarried = messages[last]?.["role"] === "user" ? last - 1 : last;
  // A Gemini model reads the last breakpoint alone: that one, where the next call's copy of the request ends.
  if (family === "gemini") return markFrom(messages, newestCarried) ? JSON.stringify(request) : undefined;

  let changed = false;
  const prefixBreakpoint = policy === "1h" ? HOUR_BREAKPOINT : BREAKPOINT;
  // A tool entry carries its breakpoint beside `function`, as a content part does.
  const tools = Array.isArray(request["tools"]) ? (request["tools"] as unknown[]) : [];
  const lastTool = tools.at(-1);
  if (isRecord(lastTool)) {
    lastTool["cache_control"] = prefixBreakpoint;
    changed = true;
  }
  const system = messages.findLast((message) => message["role"] === "system");
  if (system !== undefined && mark(system, prefixBreakpoint)) changed = true;
  // The end of the stable history: just before the message the context block rides in.
  const block = messages.findLastIndex((message) => message["role"] === "user" && firstText(message).startsWith(CONTEXT_MESSAGE_HEAD));
  if (block > 0 && markFrom(messages, block - 1)) changed = true;
  if (markFrom(messages, newestCarried)) changed = true;
  return changed ? JSON.stringify(request) : undefined;
}

/** The key the AI SDK writes on a content part the agent loop marked (`ModelMessage.cacheBreakpoint`). */
const PART_MARKER = "prompt_cache_breakpoint";

/**
 * A body whose parts the agent loop marked (`models.promptLayout` `v2`): the
 * loop chose where the cacheable prefix ends, so only its markers count.
 * For an Anthropic model on OpenRouter each becomes a `cache_control`
 * breakpoint, beside the last tool schema's and the system message's;
 * every other provider is sent the body without them, since a provider that
 * does not know the field may refuse the request.
 */
function withPartBreakpoints(url: string | undefined, body: unknown, policy?: CallCachePolicy, breakpoints?: boolean): string | undefined {
  const request = partMarkedRequest(body);
  if (request === undefined) return undefined;
  // OpenAI's own endpoint reads the loop's markers as its explicit breakpoints from GPT-5.6 on: sent as they are.
  if (policy !== "none" && isOpenAiHost(url) && openaiExplicitCacheModel(request["model"])) return undefined;
  const family = policy === "none" ? undefined : breakpointFamily(url, request["model"], breakpoints);
  const messages = (request["messages"] as unknown[]).filter(isRecord);
  // A Gemini model reads the last breakpoint alone: only the last marked part keeps one.
  const lastMarked = messages.findLastIndex(
    (message) =>
      Array.isArray(message["content"]) &&
      (message["content"] as unknown[]).some((part) => isRecord(part) && part[PART_MARKER] !== undefined),
  );
  messages.forEach((message, index) => {
    if (!Array.isArray(message["content"])) return;
    const parts = message["content"] as unknown[];
    const lastPart = parts.findLastIndex((part) => isRecord(part) && part[PART_MARKER] !== undefined);
    let unmarked = false;
    parts.forEach((part, partIndex) => {
      if (!isRecord(part) || part[PART_MARKER] === undefined) return;
      delete part[PART_MARKER];
      const kept = family === "anthropic" || (family === "gemini" && index === lastMarked && partIndex === lastPart);
      if (kept) part["cache_control"] = BREAKPOINT;
      else unmarked = true;
    });
    // Without its marker the message goes in the shape it has on a call that never marked it.
    if (unmarked && !parts.some((part) => isRecord(part) && part["cache_control"] !== undefined))
      message["content"] = unmarkedContent(message["role"], parts);
  });
  if (family === "anthropic") {
    const prefixBreakpoint = policy === "1h" ? HOUR_BREAKPOINT : BREAKPOINT;
    const lastTool = Array.isArray(request["tools"]) ? (request["tools"] as unknown[]).at(-1) : undefined;
    if (isRecord(lastTool)) lastTool["cache_control"] = prefixBreakpoint;
    const system = messages.findLast((message) => message["role"] === "system");
    if (system !== undefined) mark(system, prefixBreakpoint);
  }
  return JSON.stringify(request);
}

/** `body` with OpenRouter's `reasoning.effort`, unless it names a reasoning setting already; `undefined` when it is not a JSON request. */
export function withReasoningEffort(body: unknown, effort: string): string | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["reasoning"] !== undefined) return undefined;
  return JSON.stringify({ ...parsed, reasoning: { effort } });
}

/** `body` with a `session_id` (OpenRouter's sticky routing), unless it names one already; `undefined` when it is not a JSON request. */
export function withSessionId(body: unknown, sessionId: string): string | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["session_id"] !== undefined) return undefined;
  return JSON.stringify({ ...parsed, session_id: sessionId.slice(0, 256) });
}

/**
 * The parsed chat request when one of its message content parts carries the
 * agent loop's marker (`PART_MARKER`); `undefined` otherwise — a body that
 * only mentions the word, in a person's words or a tool result, is not one.
 */
function partMarkedRequest(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "string" || !body.includes(PART_MARKER)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["messages"])) return undefined;
  const marked = (parsed["messages"] as unknown[]).some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message["content"]) &&
      (message["content"] as unknown[]).some((part) => isRecord(part) && part[PART_MARKER] !== undefined),
  );
  return marked ? parsed : undefined;
}

/** Whether a request body carries the agent loop's part markers (`models.promptLayout` `v2`). */
export function hasPartBreakpoints(body: unknown): boolean {
  return partMarkedRequest(body) !== undefined;
}

/**
 * A message's content as the AI SDK sends it unmarked: an assistant's or a
 * tool's text parts joined into one string, and a user message's single text
 * part as a string; anything else as it is.
 */
function unmarkedContent(role: unknown, content: readonly unknown[]): unknown {
  const plainText = content.every(
    (part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" && Object.keys(part).length === 2,
  );
  if (!plainText) return content;
  const texts = content.map((part) => (part as { readonly text: string }).text);
  if (role === "assistant" || role === "tool") return texts.join("");
  return role === "user" && texts.length === 1 ? texts[0] : content;
}

/** A message's text parts with any breakpoint left out: what a provider caches, whatever shape it came in. */
function normalizedContent(content: unknown): unknown {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return content ?? null;
  return content.map((part: unknown) => {
    if (!isRecord(part)) return part;
    const { cache_control: _breakpoint, prompt_cache_breakpoint: _openai, ...rest } = part;
    return rest["type"] === "text" && typeof rest["text"] === "string" ? rest["text"] : rest;
  });
}

/** Whether a wire message, or one of its content parts, carries a cache breakpoint. */
function marked(message: Record<string, unknown>): boolean {
  const content = message["content"];
  return (
    Array.isArray(content) &&
    content.some(
      (part: unknown) => isRecord(part) && (part["cache_control"] !== undefined || part["prompt_cache_breakpoint"] !== undefined),
    )
  );
}

/**
 * The first 16 hex digits of the SHA-256 of a chat request's cacheable prefix
 * as it goes out: its tools, then its messages through the last one carrying a
 * cache breakpoint, or every message but the newest when none is marked (the
 * newest carries the call's own step note). Content is compared as text parts,
 * so a string and a one-part array hash alike, and breakpoints themselves are
 * left out. `undefined` for a body that is not a JSON chat request.
 */
export function wirePrefixHash(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["messages"])) return undefined;
  const messages = (parsed["messages"] as unknown[]).filter(isRecord);
  const lastMarked = messages.findLastIndex(marked);
  const end = lastMarked !== -1 ? lastMarked + 1 : Math.max(messages.length - 1, 0);
  const tools = Array.isArray(parsed["tools"])
    ? (parsed["tools"] as unknown[]).map((tool) => {
        if (!isRecord(tool)) return tool;
        const { cache_control: _breakpoint, ...rest } = tool;
        return rest;
      })
    : [];
  const prefix = messages.slice(0, end).map((message, index) => {
    const { content, cache_control: _breakpoint, ...rest } = message;
    // The last marked message counts up to its marked part: what follows it (a call's step facts) is not cached.
    const lastPart =
      index === lastMarked && Array.isArray(content)
        ? (content as unknown[]).findLastIndex((part) => isRecord(part) && part["cache_control"] !== undefined)
        : -1;
    return { ...rest, content: normalizedContent(lastPart === -1 ? content : (content as unknown[]).slice(0, lastPart + 1)) };
  });
  return sha256Hex(JSON.stringify({ tools, messages: prefix })).slice(0, 16);
}

/**
 * Whether a usage object a provider streamed says anything about its prompt
 * cache: OpenAI's `prompt_tokens_details` (OpenRouter's too), the Responses
 * API's `input_tokens_details`, or Anthropic's cache counts.
 */
export function usageReportsCache(usage: unknown): boolean {
  if (!isRecord(usage)) return false;
  const details = usage["prompt_tokens_details"] ?? usage["input_tokens_details"];
  if (isRecord(details) && (typeof details["cached_tokens"] === "number" || typeof details["cache_write_tokens"] === "number")) return true;
  return typeof usage["cache_read_input_tokens"] === "number" || typeof usage["cache_creation_input_tokens"] === "number";
}

/** The URL a `fetch` call names, whatever form it was given in. */
export function fetchUrl(input: Parameters<typeof globalThis.fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return typeof (input as { readonly url?: unknown }).url === "string" ? (input as { readonly url: string }).url : undefined;
}
