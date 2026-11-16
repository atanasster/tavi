/**
 * Prefix continuity: whether one model request's cacheable prefix is still
 * the start of the next one, as a provider's prompt cache sees it.
 *
 * A request is flattened into items — a role marker per message, then the
 * message's other fields (its tool calls, tool-call id, name and anything
 * else it carries), then each content part's text (a string and a one-part
 * array alike, since a provider renders both the same) — with cache
 * breakpoints left out of the items but remembered: the cacheable prefix runs
 * through the last item a breakpoint marks, or, with none marked, through
 * every message but the newest (which carries the call's own step note). The
 * next request reuses the cache when its tools match and its items start
 * with that prefix.
 */

/** Where in a request an item sits: the message's index and role. */
export interface WirePosition {
  readonly message: number;
  readonly role: string;
}

export interface PrefixContinuity {
  /** The next request's tools match and it starts with the previous request's cacheable prefix. */
  readonly hit: boolean;
  /** Whether the two requests offered the same tools, which lead every provider's cached prefix. */
  readonly toolsMatch: boolean;
  /** The last message the previous request's cacheable prefix reaches; undefined when it reaches none. */
  readonly cacheableThrough: WirePosition | undefined;
  /** The previous request's first message that differs in the next; undefined when every message it has is shared. */
  readonly divergesAt: WirePosition | undefined;
}

interface Flattened {
  readonly tools: string;
  readonly items: readonly { readonly key: string; readonly at: WirePosition }[];
  /** How many leading items the cacheable prefix holds. */
  readonly cacheable: number;
}

/** Whether a wire value carries a cache breakpoint. */
function carriesBreakpoint(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    ((value as Record<string, unknown>)["cache_control"] !== undefined ||
      (value as Record<string, unknown>)["prompt_cache_breakpoint"] !== undefined)
  );
}

/** A value with any breakpoint left out. */
function withoutBreakpoint(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { cache_control: _breakpoint, prompt_cache_breakpoint: _openai, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** A chat request body as items, its tools and its cacheable length. */
function flatten(body: string): Flattened {
  const parsed = JSON.parse(body) as { readonly tools?: unknown; readonly messages?: unknown };
  if (!Array.isArray(parsed.messages)) throw new Error("not a chat request: it has no messages");
  const tools = JSON.stringify(Array.isArray(parsed.tools) ? parsed.tools.map(withoutBreakpoint) : []);
  const items: { key: string; at: WirePosition }[] = [];
  let lastMarked = -1;
  const messageStarts: number[] = [];
  parsed.messages.forEach((entry: unknown, index) => {
    const message = (entry ?? {}) as Record<string, unknown>;
    const at = { message: index, role: String(message["role"]) };
    messageStarts.push(items.length);
    items.push({ key: JSON.stringify(["role", message["role"]]), at });
    const { role: _role, content, cache_control: _breakpoint, ...fields } = message;
    if (Object.keys(fields).length > 0) items.push({ key: JSON.stringify(["fields", fields]), at });
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content : content == null ? [] : [content];
    for (const part of parts) {
      const plain = withoutBreakpoint(part) as Record<string, unknown> | string;
      const text = typeof plain === "object" && plain["type"] === "text" && typeof plain["text"] === "string" ? plain["text"] : plain;
      items.push({ key: JSON.stringify(["part", text]), at });
      if (carriesBreakpoint(part)) lastMarked = items.length;
    }
    if (carriesBreakpoint(message)) lastMarked = items.length;
  });
  const cacheable = lastMarked !== -1 ? lastMarked : (messageStarts.at(-1) ?? 0);
  return { tools, items, cacheable };
}

/**
 * How the request sent after `previous` reuses its cacheable prefix. Both are
 * Chat Completions request bodies as sent (JSON strings).
 */
export function prefixContinuity(previous: string, next: string): PrefixContinuity {
  const before = flatten(previous);
  const after = flatten(next);
  const toolsMatch = before.tools === after.tools;
  let shared = 0;
  while (shared < before.items.length && shared < after.items.length && before.items[shared]?.key === after.items[shared]?.key) shared += 1;
  const cacheableThrough = before.cacheable === 0 ? undefined : before.items[before.cacheable - 1]?.at;
  return {
    hit: toolsMatch && shared >= before.cacheable,
    toolsMatch,
    cacheableThrough,
    divergesAt: shared < before.items.length ? before.items[shared]?.at : undefined,
  };
}

/**
 * A `fetch` that keeps every request body it is sent and answers each with
 * `answer(index, body)`: the harness's view of what reached the provider.
 */
export function recordingFetch(answer: (index: number, body: string) => Response | Promise<Response>): {
  readonly fetch: typeof fetch;
  readonly bodies: string[];
} {
  const bodies: string[] = [];
  return {
    bodies,
    fetch: async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("recordingFetch records string request bodies only");
      const body = init.body;
      bodies.push(body);
      return await answer(bodies.length - 1, body);
    },
  };
}
