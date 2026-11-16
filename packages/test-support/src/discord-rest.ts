import { definedOnly } from "@tavi/contracts/util";

/** The REST client's rate-limit clock (`@tavi/plugin-discord`'s `RateLimitClock`). */
export interface RateLimitClock {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * A fake of Discord's REST API: an injected `fetch` answering each request from a script by method
 * and path, recording every request it saw.
 */

export interface FakeAnswer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Answer only once this resolves: a request held in flight. */
  readonly hold?: Promise<void>;
  /** The body as these bytes, not JSON: a file. */
  readonly bytes?: Uint8Array;
}

export interface FakeRequest {
  /** The request's own signal: a route that never answers ends with it. */
  readonly signal?: AbortSignal | null;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly form?: FormData;
  /** How the request takes a redirect, as its caller set it. */
  readonly redirect?: RequestInit["redirect"];
}

export type FakeRoute = (request: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

export function fakeRest(
  route: FakeRoute,
  base = "https://discord.com/api/v10",
): { readonly fetch: typeof globalThis.fetch; readonly requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const form = init.body instanceof FormData ? init.body : undefined;
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : form?.get("payload_json") !== null && form !== undefined
          ? (JSON.parse(String(form.get("payload_json"))) as unknown)
          : undefined;
    const request: FakeRequest = {
      method: init.method ?? "GET",
      path,
      headers,
      ...definedOnly({ body, form, redirect: init.redirect }),
      signal: init.signal ?? null,
    };
    requests.push(request);
    // A route that never answers ends with the request's own signal, as a real fetch does.
    const aborted = new Promise<never>((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")), {
        once: true,
      }),
    );
    const answer = await Promise.race([route(request), aborted]);
    if (answer.hold !== undefined) await answer.hold;
    init.signal?.throwIfAborted();
    const status = answer.status ?? 200;
    if (answer.bytes !== undefined)
      return new Response(answer.bytes, { status, headers: { "content-length": String(answer.bytes.byteLength), ...answer.headers } });
    return new Response(status === 204 || answer.body === undefined ? null : JSON.stringify(answer.body), {
      status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return { fetch: fetchImpl, requests };
}

/** A clock whose `sleep` moves time on at once, recording each wait. */
export function virtualClock(
  start = Date.parse("2026-10-18T00:00:00.000Z"),
): RateLimitClock & { readonly slept: number[]; advance(ms: number): void } {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms) => {
      now += ms;
    },
  };
}
