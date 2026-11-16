import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { closeServer, listenLocally } from "./port.js";

/**
 * An OpenAI-compatible endpoint on 127.0.0.1: `GET /v1/models` lists the
 * models it was given, and `POST /v1/chat/completions` streams what `reply`
 * answers (by default the text "ok"). Every request is recorded, its body
 * parsed. With `key`, a request bearing any other key is refused with 401 as
 * a provider refuses one; any other path answers 404.
 */

export interface OpenAiStubRequest {
  readonly method: string;
  /** The path and query, as asked: `/v1/chat/completions`. */
  readonly url: string;
  /** The bearer token, without `Bearer `; "" when there was none. */
  readonly key: string;
  readonly authorization: string | undefined;
  /** The body, parsed as JSON; `{}` when empty, and the raw text when it is not JSON. */
  readonly body: unknown;
  readonly raw: string;
}

/** How a completion is answered. */
export type OpenAiStubReply =
  /** The text, streamed in one chunk, then `stop`. */
  | { readonly says: string; readonly usage?: OpenAiStubUsage }
  /** Tool calls, then `tool_calls`. */
  | {
      readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments?: unknown }[];
      readonly usage?: OpenAiStubUsage;
    }
  /** These stream chunks, as written (`sse` makes them). */
  | { readonly streams: string }
  /** A plain response: an error, say. A body that is not a string is sent as JSON. */
  | { readonly status: number; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> };

export interface OpenAiStubUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface OpenAiStubOptions {
  /** What `/v1/models` lists, by id or as entries. Default `[{ id: "m1" }]`. */
  readonly models?: readonly (string | { readonly id: string; readonly owned_by?: string })[];
  /** The one key it accepts; any key when absent. */
  readonly key?: string;
  /** The answer to a completion; `turn` counts completions, from 1. Default `{ says: "ok" }`. */
  readonly reply?: (request: OpenAiStubRequest, turn: number) => OpenAiStubReply | Promise<OpenAiStubReply>;
}

export interface OpenAiStub {
  /** The base URL a connection is given: `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl: string;
  readonly port: number;
  /** Every request, in order. */
  readonly requests: OpenAiStubRequest[];
  close(): Promise<void>;
}

/** One `chat.completion.chunk` carrying `content` (none when ""), with `finish` as its finish reason. */
export function textChunk(content: string, finish: string | null, usage?: OpenAiStubUsage): unknown {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [{ index: 0, delta: content === "" ? {} : { role: "assistant", content }, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/** One chunk opening the tool call at `index`, its arguments whole. */
export function toolCallChunk(call: { readonly id: string; readonly name: string; readonly arguments?: unknown }, index = 0): unknown {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: "stub-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Chunks as a server-sent event stream, ended with `[DONE]`. */
export function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

const STREAM_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" };

function streamOf(reply: OpenAiStubReply): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  if ("streams" in reply) return { status: 200, headers: STREAM_HEADERS, body: reply.streams };
  if ("says" in reply)
    return { status: 200, headers: STREAM_HEADERS, body: sse([textChunk(reply.says, null), textChunk("", "stop", reply.usage)]) };
  if ("calls" in reply)
    return {
      status: 200,
      headers: STREAM_HEADERS,
      body: sse([...reply.calls.map((call, index) => toolCallChunk(call, index)), textChunk("", "tool_calls", reply.usage)]),
    };
  const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  return { status: reply.status, headers: { "content-type": "application/json", ...reply.headers }, body };
}

function parsed(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function send(response: ServerResponse, status: number, headers: Readonly<Record<string, string>>, body: string): void {
  response.writeHead(status, headers);
  response.end(body);
}

export async function startOpenAiStub(options: OpenAiStubOptions = {}): Promise<OpenAiStub> {
  const requests: OpenAiStubRequest[] = [];
  const models = (options.models ?? ["m1"]).map((model) => (typeof model === "string" ? { id: model } : model));
  let turn = 0;
  const handle = async (request: IncomingMessage, response: ServerResponse, raw: string): Promise<void> => {
    const authorization = request.headers.authorization;
    const recorded: OpenAiStubRequest = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      key: (authorization ?? "").replace(/^Bearer /u, ""),
      authorization,
      body: parsed(raw),
      raw,
    };
    requests.push(recorded);
    if (options.key !== undefined && recorded.key !== options.key) {
      send(
        response,
        401,
        { "content-type": "application/json" },
        JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }),
      );
      return;
    }
    const path = recorded.url.split("?")[0];
    if (path === "/v1/models") {
      send(
        response,
        200,
        { "content-type": "application/json" },
        JSON.stringify({ object: "list", data: models.map((model) => ({ object: "model", ...model })) }),
      );
      return;
    }
    if (path === "/v1/chat/completions" && recorded.method === "POST") {
      turn += 1;
      const answer = streamOf((await options.reply?.(recorded, turn)) ?? { says: "ok" });
      send(response, answer.status, answer.headers, answer.body);
      return;
    }
    send(response, 404, { "content-type": "application/json" }, JSON.stringify({ error: { message: "not found" } }));
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      handle(request, response, raw).catch((error: unknown) =>
        send(response, 500, { "content-type": "application/json" }, JSON.stringify({ error: { message: String(error) } })),
      );
    });
  });
  const port = await listenLocally(server);
  return { baseUrl: `http://127.0.0.1:${port}/v1`, port, requests, close: () => closeServer(server) };
}
