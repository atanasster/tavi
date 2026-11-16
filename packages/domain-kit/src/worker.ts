import { realpathSync } from "node:fs";

// The `Retry-After` reading every source and channel shares, kept on the kit's surface for its sources.
export { RETRY_AFTER_MAX_MS, retryAfterMs } from "@tavi/contracts/util";

/**
 * What every domain plugin's confined worker shares (PLUGINS.md): an
 * answer read to a bound, the request that reads it, the worker's home, and
 * a wait a signal ends.
 */

/** The most of one answer a worker reads; a bigger one is refused, not cut. */
export const ANSWER_MAX_BYTES = 8 * 1024 * 1024;

/** An answer as a source adapter reads it. */
export interface SourceResponse {
  readonly status: number;
  /** The `Retry-After` header, as sent. */
  readonly retryAfter?: string | null;
  /** The `ETag` header, as sent, for a source read again with `If-None-Match` (NAV's feed). */
  readonly etag?: string | null;
  /** The `Content-Signal` header, as sent: an open-page list honours `ai-input=no`. */
  readonly contentSignal?: string | null;
  readonly body: unknown;
}

/** What one request answered, as the worker read it. */
export interface Fetched extends SourceResponse {
  readonly retryAfter: string | null;
  /** A redirect's `Location`, for a request the worker follows itself (`redirect: "manual"`). */
  readonly location?: string | null;
  readonly bytes: number;
}

/** One request made by the worker: an engine's only way out, so a test hands it a fake network. */
export type Fetcher<Request> = (request: Request, signal: AbortSignal) => Promise<Fetched>;

/** Who a tool call is for: whether anyone attends it. */
export interface CallContext {
  readonly unattended: boolean;
}

/** A heartbeat signal as `collect` answers it (`HeartbeatSignal`); the host validates it. */
export interface HeartbeatSignalLike<Data = string> {
  readonly key: string;
  readonly hash: string;
  readonly title: string;
  readonly at: string;
  readonly source: string;
  readonly data?: Readonly<Record<string, Data>>;
}

/** A response's body as text, refused past `ANSWER_MAX_BYTES`. */
export async function boundedText(response: Response): Promise<{ readonly text: string; readonly bytes: number }> {
  const read = await boundedBytes(response);
  return { text: Buffer.from(read.data).toString("utf8"), bytes: read.bytes };
}

/** A response's body as bytes, refused past `ANSWER_MAX_BYTES`: a file a source publishes (a spreadsheet). */
export async function boundedBytes(response: Response): Promise<{ readonly data: Uint8Array; readonly bytes: number }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = reader === undefined ? undefined : await reader.read();
    if (chunk === undefined || chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > ANSWER_MAX_BYTES) {
      await reader?.cancel();
      throw new Error(`the answer is over ${String(ANSWER_MAX_BYTES)} bytes`);
    }
    chunks.push(chunk.value);
  }
  return { data: new Uint8Array(Buffer.concat(chunks)), bytes };
}

/** How a plugin's worker makes a request of its kind. */
export interface WorkerFetchOptions<Request> {
  /** The longest one request runs, its answer read. */
  readonly timeoutMs: number;
  /** The request's method, headers, body and redirect handling. */
  readonly init: (request: Request) => Omit<RequestInit, "signal">;
  /** How its answer is read: parsed JSON (its text when it is not JSON, which the adapter reads as a changed answer), its text, or its bytes. */
  readonly read: (request: Request) => "json" | "text" | "bytes";
  /** The headers kept beside `Retry-After`, by the field each becomes. */
  readonly keep?: { readonly [Field in "etag" | "contentSignal" | "location"]?: string };
}

/** One request with the worker's `fetch`, through its proxy, read to a bounded body. */
export function createWorkerFetcher<Request extends { readonly url: string }>(options: WorkerFetchOptions<Request>): Fetcher<Request> {
  return async (request, signal) => {
    const response = await fetch(request.url, {
      ...options.init(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    const kept = Object.fromEntries(Object.entries(options.keep ?? {}).map(([field, header]) => [field, response.headers.get(header)]));
    const read = options.read(request);
    if (read === "bytes") {
      const { data, bytes } = await boundedBytes(response);
      return { status: response.status, retryAfter: response.headers.get("retry-after"), ...kept, body: data, bytes };
    }
    const { text, bytes } = await boundedText(response);
    let body: unknown = text;
    if (read === "json") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, retryAfter: response.headers.get("retry-after"), ...kept, body, bytes };
  };
}

/**
 * The worker's home: its `cwd` and `HOME`. Run beside the owner it has
 * neither, so it refuses rather than write `stores` into the owner's folder.
 */
export function workerHome(pluginId: string, stores = "its store"): string {
  const home = process.cwd();
  const declared = process.env["HOME"];
  // The worker's cwd is its home resolved (macOS's /var is /private/var); HOME is as the owner wrote it.
  if (declared === undefined || realpathSync(declared) !== realpathSync(home))
    throw new Error(`${pluginId} runs only as a confined worker, which keeps ${stores} in the worker's home`);
  return home;
}

/** Waits `ms`, or less when `signal` aborts; never throws, so work cut short keeps what it read. */
export const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
