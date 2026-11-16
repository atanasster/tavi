import { fetchWithTimeout, readJson, redactedError } from "@tavi/channel-kit";
import { TaviError } from "@tavi/contracts";
import { TAVI_REPOSITORY_URL } from "@tavi/contracts/url-text";

import { RateLimits, type RateLimitClock } from "./buckets.js";

/**
 * Discord's REST API: every
 * request bounded in time, sent as the bot with Discord's User-Agent form,
 * paced by its bucket and the global window, and its failures worded without
 * the token. A 429 says how long to wait (the larger of the header and the
 * body), and too many refusals in ten minutes stop the client before
 * Cloudflare would.
 */

const DISCORD_API = "https://discord.com/api/v10";

/** Refusals (401, 403, a 429 not in a shared bucket) in the breaker's window past which the client stops. */
export const INVALID_REQUESTS_MAX = 1000;
const INVALID_REQUESTS_WINDOW_MS = 10 * 60 * 1000;

export interface DiscordRestOptions {
  readonly fetch: typeof globalThis.fetch;
  /** The bot token, once the connection has read it. */
  readonly token: () => string | undefined;
  /** The plugin's version, in the User-Agent. */
  readonly version: string;
  readonly clock?: RateLimitClock;
  readonly requestTimeoutMs?: number;
  readonly baseUrl?: string;
  /** Told once, as the invalid-request breaker trips: the connection then stops. */
  readonly onTripped?: () => void;
  /** Discord refused the bot's token (401) on a route the bot's own token authorises: it was reset or revoked. */
  readonly onUnauthorized?: () => void;
}

/** What Discord answered. `code` and `message` are its JSON error's; `retryAfterMs` is set on a 429. */
export interface DiscordReply<T = unknown> {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: T;
  readonly code?: number;
  readonly message?: string;
  readonly retryAfterMs?: number;
  /** A 429's `X-RateLimit-Scope`: `user`, `global` or `shared`. */
  readonly scope?: string;
}

export interface DiscordRequest {
  readonly body?: unknown;
  /** A multipart body (a file); `body`, when given too, is its `payload_json`. */
  readonly form?: FormData;
  /** `X-Audit-Log-Reason`: what the server's audit log says the action was for. */
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

const realClock: RateLimitClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** A header's number, or `undefined` for none or one that is not a number. */
const headerNumber = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class DiscordRest {
  readonly #options: DiscordRestOptions;
  readonly #clock: RateLimitClock;
  readonly #limits: RateLimits;
  /** When each counted refusal came, oldest first, within the breaker's window. */
  #refusals: number[] = [];
  #tripped = false;

  constructor(options: DiscordRestOptions) {
    this.#options = options;
    this.#clock = options.clock ?? realClock;
    this.#limits = new RateLimits(this.#clock);
  }

  /** Whether too many refusals stopped the client; it stays stopped until the connection is opened again. */
  get tripped(): boolean {
    return this.#tripped;
  }

  #refused(scope: string | undefined): void {
    // A shared bucket's 429 is another bot's doing, and Discord does not count it against this one.
    if (scope === "shared") return;
    const now = this.#clock.now();
    this.#refusals = this.#refusals.filter((at) => now - at < INVALID_REQUESTS_WINDOW_MS);
    this.#refusals.push(now);
    if (this.#refusals.length > INVALID_REQUESTS_MAX && !this.#tripped) {
      this.#tripped = true;
      this.#options.onTripped?.();
    }
  }

  /**
   * One request. A transport failure or a timeout throws, its words without
   * the token: the caller decides what an unknown outcome is. An HTTP refusal
   * is answered, never thrown.
   */
  async request<T = unknown>(method: string, path: string, request: DiscordRequest = {}): Promise<DiscordReply<T>> {
    if (this.#tripped)
      throw new TaviError(
        "UNAVAILABLE",
        "Discord refused too many requests in ten minutes; the connection stopped sending until it is opened again",
      );
    const token = this.#options.token();
    if (token === undefined) throw new TaviError("UNAVAILABLE", "the Discord connection has no token yet");
    const release = await this.#limits.acquire(method, path, request.signal);
    try {
      const headers: Record<string, string> = {
        authorization: `Bot ${token}`,
        "user-agent": `DiscordBot (${TAVI_REPOSITORY_URL}, ${this.#options.version})`,
      };
      // Cut by code point, so an emoji at the cut is never half a pair (`encodeURIComponent` throws on one).
      if (request.reason !== undefined)
        headers["x-audit-log-reason"] = encodeURIComponent(Array.from(request.reason).slice(0, 512).join(""));
      let body: string | FormData | undefined;
      if (request.form !== undefined) {
        if (request.body !== undefined) request.form.set("payload_json", JSON.stringify(request.body));
        body = request.form;
      } else if (request.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(request.body);
      }
      let response: Response;
      // Its caller gave up while it waited for its bucket: nothing is sent.
      request.signal?.throwIfAborted();
      try {
        response = await fetchWithTimeout(
          this.#options.fetch,
          `${this.#options.baseUrl ?? DISCORD_API}${path}`,
          { method, headers, ...(body === undefined ? {} : { body }) },
          this.#options.requestTimeoutMs ?? 15_000,
          request.signal,
        );
      } catch (error) {
        const failed = new Error(redactedError(error, [token]));
        if (error instanceof Error) failed.name = error.name;
        throw failed;
      }
      const resetAfter = headerNumber(response.headers.get("x-ratelimit-reset-after"));
      this.#limits.update(method, path, {
        bucket: response.headers.get("x-ratelimit-bucket") ?? undefined,
        remaining: headerNumber(response.headers.get("x-ratelimit-remaining")),
        resetAfterMs: resetAfter === undefined ? undefined : resetAfter * 1000,
      });
      const json = response.status === 204 ? undefined : await readJson(response);
      const error =
        json !== null && typeof json === "object"
          ? (json as { readonly code?: unknown; readonly message?: unknown; readonly retry_after?: unknown; readonly global?: unknown })
          : undefined;
      if (response.ok) return { ok: true, status: response.status, ...(json === undefined ? {} : { body: json as T }) };
      const scope = response.headers.get("x-ratelimit-scope") ?? undefined;
      if (response.status === 401 || response.status === 403 || response.status === 429) this.#refused(scope);
      // An interaction's own token (webhooks, callbacks) lapses after 15 minutes: that 401 says nothing of the bot's.
      if (response.status === 401 && !/^\/(webhooks|interactions)\//.test(path)) this.#options.onUnauthorized?.();
      let retryAfterMs: number | undefined;
      if (response.status === 429) {
        // The larger of the header (whole seconds) and the body (fractions): either alone has been seen to undercount.
        const header = headerNumber(response.headers.get("retry-after")) ?? 0;
        const inBody = typeof error?.retry_after === "number" ? error.retry_after : 0;
        retryAfterMs = Math.ceil(Math.max(header, inBody) * 1000);
        this.#limits.limited(method, path, retryAfterMs, scope === "global" || error?.global === true);
      }
      return {
        ok: false,
        status: response.status,
        ...(typeof error?.code === "number" ? { code: error.code } : {}),
        ...(typeof error?.message === "string" ? { message: redactedError(error.message, [token]).slice(0, 300) } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(scope === undefined ? {} : { scope }),
      };
    } finally {
      release();
    }
  }
}
