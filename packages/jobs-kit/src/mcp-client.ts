import { isRecord } from "@tavi/contracts/util";

/**
 * A minimal MCP client over Streamable HTTP: `initialize`, the
 * `initialized` notification, then one `tools/call`, for the job boards'
 * official servers that need no account. It holds no transport itself: the
 * worker gives it `post`, so the same exchange is replayed from recordings in
 * tests.
 */

/** MCP's protocol revision the boards' servers answered with when recorded. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpHttpAnswer {
  readonly status: number;
  readonly retryAfter: string | null;
  /** `Mcp-Session-Id`, when the server keeps one. */
  readonly session: string | null;
  readonly text: string;
}

/** One POST of a JSON-RPC message to the server's endpoint with these headers, or (no body) the DELETE that ends its session. */
export type McpPost = (body: string | undefined, headers: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<McpHttpAnswer>;

/**
 * What the call answered, as the body an adapter reads: the tool's result
 * (its `structuredContent`, else its first text content as JSON or text), or
 * the JSON-RPC error the server gave.
 */
export type McpBody =
  | { readonly kind: "result"; readonly value: unknown; readonly isError: boolean }
  /** `step`: whether `initialize` or the call answered with the error. */
  | { readonly kind: "error"; readonly step: "initialize" | "call"; readonly code: number; readonly message: string };

export interface McpCallAnswer {
  /** The first non-2xx HTTP status of the exchange, else the call's. */
  readonly status: number;
  readonly retryAfter: string | null;
  /** `null` when an HTTP status ended the exchange, or the answer was not JSON-RPC. */
  readonly body: McpBody | null;
  readonly bytes: number;
}

const UTF8 = new TextEncoder();

type Message = { readonly id?: unknown; readonly result?: unknown; readonly error?: unknown };

const object = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The JSON-RPC answer to request `id`, from a JSON body or a `text/event-stream` one. */
export function mcpMessage(text: string, id: number): Message | undefined {
  const whole = object(json(text.trim()));
  if (whole !== undefined) return whole["id"] === id ? whole : undefined;
  // An event stream: the `data:` lines of each event, joined.
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const message = object(json(data));
    if (message?.["id"] === id) return message;
  }
  return undefined;
}

/** A tool's result as an adapter reads it. */
function toolValue(result: Record<string, unknown>): unknown {
  if (result["structuredContent"] !== undefined) return result["structuredContent"];
  const content = Array.isArray(result["content"]) ? result["content"].map(object) : [];
  const text = content.find((item) => item?.["type"] === "text")?.["text"];
  if (typeof text !== "string") return undefined;
  return json(text) ?? text;
}

/** Calls `tool` with `args` on the server behind `post`, after initializing a session. */
export async function mcpToolCall(
  post: McpPost,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  client: { readonly name: string; readonly version: string },
  signal: AbortSignal,
): Promise<McpCallAnswer> {
  let bytes = 0;
  let session: string | null = null;
  const headers = (): Record<string, string> => ({
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(session === null ? {} : { "Mcp-Session-Id": session }),
  });
  const send = async (message: Record<string, unknown>): Promise<McpHttpAnswer> => {
    const answer = await post(
      JSON.stringify({ jsonrpc: "2.0", ...message }),
      { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers() },
      signal,
    );
    bytes += UTF8.encode(answer.text).byteLength;
    session = answer.session ?? session;
    return answer;
  };
  const exchange = async (): Promise<McpCallAnswer> => {
    const ended = (answer: McpHttpAnswer): McpCallAnswer => ({ status: answer.status, retryAfter: answer.retryAfter, body: null, bytes });
    const initialized = await send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: client },
    });
    if (initialized.status < 200 || initialized.status > 299) return ended(initialized);
    const hello = mcpMessage(initialized.text, 1);
    if (hello === undefined || object(hello.result) === undefined)
      return { status: initialized.status, retryAfter: null, body: errorOf(hello, "initialize"), bytes };
    const notified = await send({ method: "notifications/initialized" });
    if (notified.status < 200 || notified.status > 299) return ended(notified);
    const called = await send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    if (called.status < 200 || called.status > 299) return ended(called);
    const answer = mcpMessage(called.text, 2);
    const result = object(answer?.result);
    if (result === undefined) return { status: called.status, retryAfter: null, body: errorOf(answer, "call"), bytes };
    return {
      status: called.status,
      retryAfter: null,
      body: { kind: "result", value: toolValue(result), isError: result["isError"] === true },
      bytes,
    };
  };
  const answer = await exchange();
  // A session the server keeps is ended, not left to time out; its answer changes nothing.
  if (session !== null) await post(undefined, headers(), signal).catch(() => undefined);
  return answer;
}

/** A JSON-RPC error, or `null` for an answer that is not JSON-RPC at all. */
function errorOf(message: Message | undefined, step: "initialize" | "call"): McpBody | null {
  const error = object(message?.error);
  if (error === undefined) return null;
  return {
    kind: "error",
    step,
    code: typeof error["code"] === "number" ? error["code"] : 0,
    message: typeof error["message"] === "string" ? error["message"].slice(0, 200) : "",
  };
}
