/** A body `readBoundedBody` reads: a fetch `Response`, a web stream, or a Node stream such as an `IncomingMessage`. */
export type BodySource = Response | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | null | undefined;

export interface BoundedBodyOptions {
  /**
   * Past `maxBytes`: `"throw"` (the default) stops reading and throws
   * `BodyTooLargeError`; `"truncate"` stops reading and keeps the first
   * `maxBytes` bytes.
   */
  readonly overflow?: "throw" | "truncate";
  /** Aborting cancels the read and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

export interface BoundedBody {
  /** The bytes kept: all of them, or the first `maxBytes` when truncated. */
  readonly bytes: Buffer;
  /** Bytes received, the chunk that crossed the limit included. */
  readonly total: number;
  readonly truncated: boolean;
}

/** A body past its limit. `declared` is the `Content-Length` that refused it before a byte was read. */
export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
  readonly limit: number;
  readonly declared: number | undefined;

  constructor(limit: number, declared?: number) {
    super(
      declared === undefined ? `the body passed ${String(limit)} bytes` : `the body is ${String(declared)} bytes, over ${String(limit)}`,
    );
    this.limit = limit;
    this.declared = declared;
  }
}

/**
 * A body read to at most `maxBytes` while it arrives, never buffered whole
 * first. Past the limit the read stops and the source is cancelled (a Node
 * stream is destroyed). A `Response` whose `Content-Length` is already over
 * the limit is refused before reading when overflow throws. No body reads as
 * empty.
 */
export async function readBoundedBody(source: BodySource, maxBytes: number, options: BoundedBodyOptions = {}): Promise<BoundedBody> {
  const truncate = options.overflow === "truncate";
  const signal = options.signal;
  signal?.throwIfAborted();
  const response = isResponse(source) ? source : undefined;
  const body = response === undefined ? (source as Exclude<BodySource, Response>) : response.body;
  if (!truncate) {
    const declared = Number(response === undefined ? declaredByNode(source) : (response.headers.get("content-length") ?? Number.NaN));
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      if (response !== undefined) await response.body?.cancel().catch(() => undefined);
      else destroy(source);
      throw new BodyTooLargeError(maxBytes, declared);
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let kept = 0;
  /** Takes a chunk; false once the limit is passed. */
  const take = (received: Uint8Array | string): boolean => {
    // A Node stream with an encoding set yields strings: counted in bytes all the same.
    const chunk = typeof received === "string" ? Buffer.from(received) : received;
    total += chunk.byteLength;
    if (total <= maxBytes) {
      chunks.push(chunk);
      kept = total;
      return true;
    }
    if (!truncate) throw new BodyTooLargeError(maxBytes);
    const room = maxBytes - kept;
    if (room > 0) chunks.push(chunk.subarray(0, room));
    kept = maxBytes;
    return false;
  };
  if (body instanceof ReadableStream) await readStream(body, take, signal);
  else if (body !== null && body !== undefined) await readIterable(body, take, signal);
  return { bytes: Buffer.concat(chunks, kept), total, truncated: total > maxBytes };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  take: (chunk: Uint8Array) => boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const reader = stream.getReader();
  const cancel = (): void => {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        finished = true;
        return;
      }
      if (!take(value)) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readIterable(
  iterable: AsyncIterable<Uint8Array | string>,
  take: (chunk: Uint8Array | string) => boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
  aborted.catch(() => undefined);
  const abort = (): void => rejectAborted?.(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let finished = false;
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done === true) {
        finished = true;
        return;
      }
      if (!take(next.value)) return;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) {
      // A Node stream is destroyed outright: its iterator's `return` waits behind a pending read.
      destroy(iterable);
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      void iterator.return?.()?.catch(() => undefined);
    }
  }
}

/** A fetch `Response`, by shape: undici's own class is not the global one. */
function isResponse(source: BodySource): source is Response {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as { readonly headers?: unknown; readonly body?: unknown; readonly arrayBuffer?: unknown };
  return (
    typeof candidate.arrayBuffer === "function" &&
    "body" in candidate &&
    typeof (candidate.headers as { readonly get?: unknown } | undefined)?.get === "function"
  );
}

/** A Node request's declared `Content-Length`, when it has one. */
function declaredByNode(source: BodySource): string | undefined {
  const headers = (source as { readonly headers?: unknown } | null | undefined)?.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const length = (headers as Record<string, unknown>)["content-length"];
  return typeof length === "string" ? length : undefined;
}

function destroy(stream: unknown): void {
  const end = (stream as { readonly destroy?: unknown } | null | undefined)?.destroy;
  if (typeof end === "function") end.call(stream);
}
