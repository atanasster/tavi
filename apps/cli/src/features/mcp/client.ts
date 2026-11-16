import { AsyncLocalStorage } from "node:async_hooks";

import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  SSEClientTransport,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type FetchLike,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type Implementation,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type PriorDiscovery,
  type ServerCapabilities,
  type Tool,
  type Transport,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import { TaviError, WorkflowWaitSuspend } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

import { cleanServerText, mapToolResult, type McpCallResult } from "./results.js";
import { DEFAULT_MAX_MESSAGE_BYTES, TaviStdioTransport, type TaviStdioOptions } from "./stdio-transport.js";

/**
 * Tavi's MCP client: SDK v2 over
 * Tavi's own stdio transport or Streamable HTTP (legacy HTTP+SSE only when
 * Streamable HTTP is refused).
 *
 * - **Era.** Negotiated once, at probe (`versionNegotiation: auto`), and
 *   passed back as `prior` on every later connect, so no connect probes
 *   again. On stdio the probe runs in place on Tavi's transport, inside the
 *   server's sandbox; a server that exits on the unknown probe is re-connected
 *   as legacy on a fresh process.
 * - **Recovery.** A transport error discards the SDK `Client`; the next call
 *   builds a new one with the same prior.
 * - **Boundaries.** Every promise the SDK, the transport or a callback makes
 *   is caught here and reported as an event or a `TaviError`; nothing escapes
 *   to the process.
 * - **Validation.** The SDK's own output-schema validation is off (a
 *   mismatch is Tavi's to flag).
 */

/** A cached era verdict, as stored with a server's version (`era_prior_json`). */
export type McpEraPrior = PriorDiscovery;

/** Which HTTP transport a remote server answered on, recorded at probe. */
export type McpHttpMode = "streamable" | "sse";

/** The SDK's fetch, for modules outside `mcp/` that pass one (only `mcp/` imports the SDK). */
export type { FetchLike };

interface McpStdioEndpoint {
  readonly transport: "stdio";
  readonly spawn: Omit<TaviStdioOptions, "maxMessageBytes">;
}

interface McpHttpEndpoint {
  readonly transport: "http";
  readonly url: string;
  /** The guarded fetch; plain `fetch` with no redirects otherwise. */
  readonly fetch?: FetchLike;
  /** Headers resolved per request, from credential settings. */
  readonly headers?: () => Promise<Readonly<Record<string, string>>>;
  /** The transport recorded at probe; absent, Streamable HTTP then, if refused, HTTP+SSE. */
  readonly mode?: McpHttpMode;
}

export type McpEndpoint = McpStdioEndpoint | McpHttpEndpoint;

/** What the client reports: the server's state and log. */
export type McpClientEvent =
  | { readonly kind: "connect"; readonly era: "modern" | "legacy"; readonly ms: number }
  | { readonly kind: "error"; readonly where: string; readonly message: string }
  | { readonly kind: "closed" }
  | { readonly kind: "stderr"; readonly text: string }
  /**
   * The server sent `notifications/tools/list_changed`: its tools are listed again by the drift check, which
   * rate-limits it (`driftScheduler`), never here and never from the notification's own content.
   */
  | { readonly kind: "tools-changed" };

export interface McpConnectionOptions {
  readonly endpoint: McpEndpoint;
  readonly maxMessageBytes?: number;
  readonly prior?: McpEraPrior;
  readonly connectTimeoutMs?: number;
  readonly onEvent?: (event: McpClientEvent) => void;
}

/** A probe's findings. */
export interface McpProbeResult {
  readonly prior: McpEraPrior;
  readonly httpMode?: McpHttpMode;
  readonly serverInfo?: Implementation;
  /** The server's instructions, cleaned: shown to the operator, never to the model. */
  readonly instructions?: string;
  readonly capabilities?: ServerCapabilities;
  readonly tools: readonly Tool[];
}

/** A server's question during a call: a form, or a URL to open; legacy `elicitation/create` or 2026-07-28 `input_required`. */
export type McpElicitation = (ElicitRequestFormParams & { readonly mode?: "form" }) | ElicitRequestURLParams;
/** Answers a server's question for one call, in its era: a legacy server waits on the answer mid-call, a 2026-07-28 one is asked again. */
export type McpElicit = (request: McpElicitation, era: "modern" | "legacy") => Promise<ElicitResult>;

export interface McpCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** The approved definition: used for header mirroring, so no listing is needed first. */
  readonly definition?: Tool;
  /** Who answers the server's questions for this call; absent, each is declined. */
  readonly elicit?: McpElicit;
  /** The server's progress notifications for this call; absent, none is asked for. */
  readonly onProgress?: (progress: McpProgress) => void;
}

/** One progress notification, as the server sent it (its message not yet cleaned). */
export interface McpProgress {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}

/**
 * A server's JSON-RPC error answer to a read (a URI it does not know, a
 * prompt's arguments it refuses) as what it is: its refusal, never the
 * server failing.
 */
async function refusals<T>(where: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProtocolError)
      throw new TaviError(
        "INVALID_INPUT",
        `the MCP server refused ${where}: ${cleanServerText(error.message).replace(/\s+/g, " ").slice(0, 300)}`,
        { details: { mcpFailure: "refused", where } },
      );
    throw error;
  }
}

/** One call's question-answerer, and the suspend its question raised (kept, since the SDK may wrap what a handler throws). */
interface CallQuestions {
  readonly elicit: McpElicit;
  suspended?: WorkflowWaitSuspend;
}

/** The client's name to every server, always: Tavi never registers under another name. */
const MCP_CLIENT_NAME = "Tavi";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** A server's scope words when they are space-separated scope tokens (RFC 6749 §3.3), at most 500 characters. */
export function scopeList(value: unknown): string | undefined {
  return typeof value === "string" && SCOPE_LIST.test(value) ? value : undefined;
}
const SCOPE_LIST = /^(?=.{1,500}$)[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/;
/** Pages of `tools/list` walked before giving up (a server with more than 128 tools fails anyway). */
const LIST_MAX_PAGES = 16;

/** The SDK's output validation, off: Tavi passes a mismatch on, flagged. */
const acceptAll: jsonSchemaValidator = {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/**
 * A fetch that never follows a redirect, adds the resolved headers, and
 * refuses any JSON body, or any one SSE event, over `max` bytes as the bytes
 * arrive (the cap applies per message).
 */
export function cappedFetch(
  base: FetchLike,
  max: number,
  headers?: () => Promise<Readonly<Record<string, string>>>,
  onOversize?: () => void,
): FetchLike {
  return async (url, init) => {
    const extra = headers === undefined ? {} : await headers();
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extra)) merged.set(name, value);
    const response = await base(url, { ...init, headers: merged, redirect: "error" });
    if (response.body === null) return response;
    const length = Number(response.headers.get("content-length") ?? "0");
    const stream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!stream && length > max) {
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      await response.body.cancel().catch(() => undefined);
      onOversize?.();
      throw new TaviError("UNAVAILABLE", `the MCP server's message is over ${String(max)} bytes`);
    }
    let count = 0;
    let lastWasNewline = false;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          for (const byte of chunk) {
            if (stream && byte === 0x0a) {
              // A blank line ends an SSE event: the next event starts its own count.
              if (lastWasNewline) count = 0;
              lastWasNewline = true;
              continue;
            }
            if (byte !== 0x0d) lastWasNewline = false;
            count += 1;
            if (count > max) {
              onOversize?.();
              controller.error(new TaviError("UNAVAILABLE", `the MCP server's message is over ${String(max)} bytes`));
              return;
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Whether an HTTP connect failed because the server refuses Streamable HTTP
 * (so HTTP+SSE is worth a try): any 4xx, as the spec's backwards
 * compatibility says, but a refused credential, a timeout or a rate limit.
 */
export function refusesStreamable(error: unknown): boolean {
  const status = error instanceof SdkHttpError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && ![401, 403, 407, 408, 429].includes(status);
}

export class McpConnection {
  readonly #options: McpConnectionOptions;
  #client: Client | undefined;
  #transport: Transport | undefined;
  #connecting: Promise<Client> | undefined;
  #prior: McpEraPrior | undefined;
  #httpMode: McpHttpMode | undefined;
  #closed = false;
  /** The call a 2026-07-28 question belongs to, by async context. */
  readonly #questions = new AsyncLocalStorage<CallQuestions>();
  /** Calls in flight, for a legacy server's question, which carries no call of its own. */
  readonly #inFlight = new Set<CallQuestions>();
  /** Aborts the connect in progress (an oversized handshake answer). */
  #connectAbort: AbortController | undefined;
  /** Why the last request was refused here (an oversized message), named in its failure. */
  #refused: string | undefined;

  constructor(options: McpConnectionOptions) {
    this.#options = options;
    this.#prior = options.prior;
    this.#httpMode = options.endpoint.transport === "http" ? options.endpoint.mode : undefined;
  }

  /** The era verdict in use: given, or learned at the first connect. */
  get prior(): McpEraPrior | undefined {
    return this.#prior;
  }

  get httpMode(): McpHttpMode | undefined {
    return this.#httpMode;
  }

  /** Whether a live client is held. */
  get connected(): boolean {
    return this.#client !== undefined;
  }

  /** The stdio transport's leader pid, when running. */
  get pid(): number | undefined {
    return this.#transport instanceof TaviStdioTransport ? this.#transport.pid : undefined;
  }

  #emit(event: McpClientEvent): void {
    try {
      this.#options.onEvent?.(event);
    } catch {
      // A listener's failure is its own.
    }
  }

  #maxBytes(): number {
    return this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  #newClient(negotiate: boolean): Client {
    const client = new Client(
      { name: MCP_CLIENT_NAME, version: "1" },
      {
        // Form and URL questions: answered by the person, never with a default.
        capabilities: { elicitation: { form: {}, url: {} } },
        jsonSchemaValidator: acceptAll,
        listMaxPages: LIST_MAX_PAGES,
        ...(negotiate ? { versionNegotiation: { mode: "auto" as const } } : {}),
      },
    );
    client.onerror = (error) => this.#emit({ kind: "error", where: "client", message: errorMessage(error) });
    // A changed tool list is only announced: the SDK's own `listChanged` refresh is not used, so nothing is listed
    // here and a server that floods the notification costs one event each. A 2025 server sends it on the
    // connection; a 2026-07-28 one sends it only on a subscription, which Tavi does not open (its 15-minute check
    // covers it).
    client.setNotificationHandler("notifications/tools/list_changed", () => this.#emit({ kind: "tools-changed" }));
    // A question is matched to its call by the call's async context where the SDK keeps it, else to the one call in
    // flight (a legacy server's `elicitation/create` arrives on the connection; SDK 2.3.1 also fulfils a 2026-07-28
    // `input_required` outside the call's context): with two calls in flight it is declined.
    client.setRequestHandler("elicitation/create", async (request) => {
      const call = this.#questions.getStore() ?? (this.#inFlight.size === 1 ? [...this.#inFlight][0] : undefined);
      if (call === undefined) return { action: "decline" };
      try {
        return await call.elicit(request.params as McpElicitation, client.getProtocolEra() === "modern" ? "modern" : "legacy");
      } catch (error) {
        if (error instanceof WorkflowWaitSuspend) call.suspended = error;
        throw error;
      }
    });
    return client;
  }

  #newTransport(mode: McpHttpMode | undefined): Transport {
    const endpoint = this.#options.endpoint;
    if (endpoint.transport === "stdio") {
      const onStderr = endpoint.spawn.onStderr;
      return new TaviStdioTransport({
        ...endpoint.spawn,
        maxMessageBytes: this.#maxBytes(),
        onStderr: (text) => {
          onStderr?.(text);
          this.#emit({ kind: "stderr", text });
        },
      });
    }
    // An oversized answer fails its request at once: the SDK would otherwise wait for its timeout.
    const fetcher = cappedFetch(endpoint.fetch ?? ((url, init) => fetch(url, init)), this.#maxBytes(), endpoint.headers, () => {
      this.#refused = `the MCP server's message is over ${String(this.#maxBytes())} bytes`;
      this.#emit({ kind: "error", where: "transport", message: this.#refused });
      this.#connectAbort?.abort();
      void this.reset();
    });
    const url = new URL(endpoint.url);
    if (mode === "sse") return new SSEClientTransport(url, { fetch: fetcher });
    return new StreamableHTTPClientTransport(url, { fetch: fetcher, redirectPolicy: "same-origin", requestInit: { redirect: "error" } });
  }

  /** A connected client: the held one, or a new one with the prior (negotiated once when there is none). */
  async #connect(): Promise<Client> {
    if (this.#closed) throw new TaviError("UNAVAILABLE", "the MCP connection is closed");
    if (this.#client !== undefined) return this.#client;
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #open(): Promise<Client> {
    const started = Date.now();
    const timeout = this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const attempt = async (prior: McpEraPrior | undefined, mode: McpHttpMode | undefined): Promise<Client> => {
      const client = this.#newClient(prior === undefined);
      const transport = this.#newTransport(mode);
      transport.onerror = (error) => this.#emit({ kind: "error", where: "transport", message: errorMessage(error) });
      const abort = new AbortController();
      this.#connectAbort = abort;
      try {
        await client.connect(transport, { timeout, signal: abort.signal, ...(prior === undefined ? {} : { prior }) });
      } catch (error) {
        await this.#dispose(client, transport);
        throw error;
      } finally {
        if (this.#connectAbort === abort) this.#connectAbort = undefined;
      }
      return this.#hold(client, transport);
    };
    let client: Client;
    try {
      client = await attempt(this.#prior, this.#httpMode);
    } catch (error) {
      if (this.#options.endpoint.transport === "http" && this.#httpMode === undefined && refusesStreamable(error)) {
        // Streamable HTTP refused: legacy HTTP+SSE, once, and the result recorded.
        client = await attempt(this.#prior, "sse").catch((retry: unknown) => {
          throw this.#failure("connect", retry);
        });
        this.#httpMode = "sse";
      } else if (
        this.#options.endpoint.transport === "stdio" &&
        this.#prior === undefined &&
        error instanceof SdkError &&
        error.code === SdkErrorCode.EraNegotiationFailed
      ) {
        // A server that exits on the unknown probe is a legacy server: a fresh process, the plain handshake.
        client = await attempt({ kind: "legacy" }, undefined).catch((retry: unknown) => {
          throw this.#failure("connect", retry);
        });
      } else {
        throw this.#failure("connect", error);
      }
    }
    if (this.#options.endpoint.transport === "http") this.#httpMode ??= "streamable";
    const era = client.getProtocolEra() === "modern" ? "modern" : "legacy";
    const discover = client.getDiscoverResult();
    this.#prior ??= era === "modern" && discover !== undefined ? { kind: "modern", discover } : { kind: "legacy" };
    this.#emit({ kind: "connect", era, ms: Date.now() - started });
    return client;
  }

  #hold(client: Client, transport: Transport): Client {
    this.#client = client;
    this.#transport = transport;
    const previous = transport.onclose;
    transport.onclose = () => {
      try {
        previous?.();
      } catch {
        // The SDK's own close handler failing leaves the same state.
      }
      // A transport error or exit: the next call builds a new client.
      if (this.#client === client) {
        this.#client = undefined;
        this.#transport = undefined;
        this.#emit({ kind: "closed" });
      }
      // A server that exited on its own still has its group killed, its descendants swept and its record removed
      // (Tavi's transport closes once, however often it is asked).
      if (transport instanceof TaviStdioTransport) void transport.close().catch(() => undefined);
    };
    return client;
  }

  async #dispose(client: Client | undefined, transport: Transport | undefined): Promise<void> {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await client?.close().catch(() => undefined);
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await transport?.close().catch(() => undefined);
  }

  #failure(where: string, error: unknown): TaviError {
    if (error instanceof TaviError) return error;
    const refused = this.#refused;
    this.#refused = undefined;
    if (refused !== undefined) return new TaviError("UNAVAILABLE", `${refused} (${where})`, { details: { mcpFailure: "server", where } });
    const message = cleanServerText(errorMessage(error)).slice(0, 500);
    this.#emit({ kind: "error", where, message });
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
      return new TaviError("UNAVAILABLE", `the MCP server did not answer in time (${where})`, {
        details: { mcpFailure: where === "connect" ? "server" : "timeout", where },
      });
    // The server refused Tavi's credentials: not a crash to back off from, so a token rotated now applies on the next call.
    // A call that needs a scope its sign-in lacks (RFC 6750 `insufficient_scope`): a refusal too, never a login started here.
    if (InsufficientScopeError.isInstance(error))
      return new TaviError("NOT_AUTHORIZED", `the MCP server needs more access than its sign-in grants (${where})`, {
        details: {
          mcpFailure: "auth",
          where,
          status: 403,
          insufficientScope: true,
          // The server's words: kept only as scope tokens (RFC 6749 §3.3), to ask for at the next sign-in.
          ...definedOnly({ requiredScope: scopeList(error.requiredScope) }),
        },
      });
    if (error instanceof SdkHttpError && (error.status === 401 || error.status === 403))
      return new TaviError(
        "NOT_AUTHORIZED",
        `the MCP server refused its credentials (HTTP ${String(error.status)}, ${where}): check its token setting`,
        { details: { mcpFailure: "auth", where, status: error.status } },
      );
    return new TaviError("UNAVAILABLE", `the MCP server failed (${where}): ${message}`, { details: { mcpFailure: "server", where } });
  }

  /** Runs `work` on a connected client; a transport failure drops the client so the next call reconnects. */
  async #with<T>(where: string, work: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.#connected(where, signal);
      try {
        return await work(client);
      } catch (error) {
        if (error instanceof TaviError || error instanceof WorkflowWaitSuspend) throw error;
        // A 404 to a request on a session is the server's word that it no longer knows it: a new session, once.
        if (error instanceof SdkHttpError && error.status === 404 && attempt === 0) {
          await this.reset();
          continue;
        }
        if (error instanceof SdkError && (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected))
          await this.reset();
        throw this.#failure(where, error);
      }
    }
  }

  /** A connected client, or the caller's cancellation: a shared connect is never aborted for one caller. */
  async #connected(where: string, signal?: AbortSignal): Promise<Client> {
    if (signal === undefined) return this.#connect();
    if (signal.aborted) throw new TaviError("CANCELLED", `${where} was cancelled`);
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new TaviError("CANCELLED", `${where} was cancelled`));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const connecting = this.#connect();
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    connecting.catch(() => undefined);
    try {
      return await Promise.race([connecting, cancelled]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  /** The server's instructions as it gives them now, cleaned: shown to the operator, never the model. */
  async instructions(signal?: AbortSignal): Promise<string | undefined> {
    return await this.#with(
      "instructions",
      async (client) => {
        const text = client.getInstructions();
        return text === undefined ? undefined : cleanServerText(text).slice(0, 16 * 1024);
      },
      signal,
    );
  }

  /**
   * The probe: connect, negotiating the era when none is known, then
   * list the tools. Calls no tool.
   */
  async probe(signal?: AbortSignal): Promise<McpProbeResult> {
    const tools = await this.listTools(signal);
    const client = await this.#connect();
    const instructions = client.getInstructions();
    const info = client.getServerVersion();
    const capabilities = client.getServerCapabilities();
    return {
      prior: this.#prior ?? { kind: "legacy" },
      ...(this.#httpMode === undefined ? {} : { httpMode: this.#httpMode }),
      ...(info === undefined
        ? {}
        : {
            serverInfo: { ...info, name: cleanServerText(info.name).slice(0, 200), version: cleanServerText(info.version).slice(0, 100) },
          }),
      ...(instructions === undefined ? {} : { instructions: cleanServerText(instructions).slice(0, 16 * 1024) }),
      ...(capabilities === undefined ? {} : { capabilities }),
      tools,
    };
  }

  /** Every tool, paged, fresh (never from the SDK's cache). */
  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    const tools = await this.#with(
      "tools/list",
      async (client) => (await client.listTools(undefined, { cacheMode: "refresh", ...(signal === undefined ? {} : { signal }) })).tools,
      signal,
    );
    if (this.#transport instanceof TaviStdioTransport) await this.#transport.recordDescendants();
    return tools;
  }

  /** The server's prompts, as it lists them; none when it offers no prompts. */
  async listPrompts(signal?: AbortSignal): Promise<readonly Prompt[]> {
    return await this.#with(
      "prompts/list",
      async (client) =>
        client.getServerCapabilities()?.prompts === undefined
          ? []
          : (await refusals("prompts/list", () => client.listPrompts(undefined, signal === undefined ? {} : { signal }))).prompts,
      signal,
    );
  }

  /** One prompt's messages, with its arguments. */
  async getPrompt(name: string, args: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<GetPromptResult> {
    return await this.#with(
      `prompts/get ${name}`,
      async (client) =>
        await refusals(`prompts/get ${name}`, () =>
          client.getPrompt({ name, arguments: { ...args } }, signal === undefined ? {} : { signal }),
        ),
      signal,
    );
  }

  /** The server's resources, as it lists them; none when it offers no resources. */
  async listResources(signal?: AbortSignal): Promise<readonly Resource[]> {
    return await this.#with(
      "resources/list",
      async (client) =>
        client.getServerCapabilities()?.resources === undefined
          ? []
          : (await refusals("resources/list", () => client.listResources(undefined, signal === undefined ? {} : { signal }))).resources,
      signal,
    );
  }

  /** One resource's contents, read by the server from its own URI. */
  async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    return await this.#with(
      "resources/read",
      async (client) => await refusals("resources/read", () => client.readResource({ uri }, signal === undefined ? {} : { signal })),
      signal,
    );
  }

  /** One tool call, mapped and cleaned; aborting sends cancellation. */
  async callTool(name: string, args: Readonly<Record<string, unknown>>, options: McpCallOptions = {}): Promise<McpCallResult> {
    if (options.signal?.aborted === true) throw new TaviError("CANCELLED", `${name} was cancelled`);
    const questions: CallQuestions = { elicit: options.elicit ?? (async () => ({ action: "decline" })) };
    this.#inFlight.add(questions);
    let result: unknown;
    try {
      result = await this.#with(
        `tools/call ${name}`,
        async (client) => {
          try {
            return await this.#questions.run(questions, () =>
              client.callTool(
                { name, arguments: { ...args } },
                {
                  ...definedOnly({
                    signal: options.signal,
                    timeout: options.timeoutMs,
                    toolDefinition: options.definition,
                    onprogress: options.onProgress,
                  }),
                },
              ),
            );
          } catch (error) {
            // A question the person has not answered yet: the task waits on it, however the SDK reported the throw.
            if (questions.suspended !== undefined) throw questions.suspended;
            if (options.signal?.aborted === true) throw new TaviError("CANCELLED", `${name} was cancelled`);
            throw error;
          }
        },
        options.signal,
      );
    } finally {
      this.#inFlight.delete(questions);
    }
    // A legacy server answers a question it could not have answered with an error result: the task's wait stands.
    if (questions.suspended !== undefined) throw questions.suspended;
    return mapToolResult(name, result as { isError?: unknown; structuredContent?: unknown; content?: unknown });
  }

  /** Whether the server answers a ping within `timeoutMs`: after a cancelled call, a server that does not is killed. */
  async ping(timeoutMs: number): Promise<boolean> {
    const client = this.#client;
    if (client === undefined) return false;
    try {
      await client.ping({ timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** Drops the client and its transport; the next call reconnects. */
  async reset(): Promise<void> {
    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    await this.#dispose(client, transport);
  }

  /** Kills a stdio server's group at once (a stuck call), then drops the client. */
  async kill(): Promise<void> {
    const transport = this.#transport;
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    if (transport instanceof TaviStdioTransport) await transport.kill().catch(() => undefined);
    await this.#dispose(client, transport);
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    await this.#connecting?.catch(() => undefined);
    await this.reset();
  }
}
