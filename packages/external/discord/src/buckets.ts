/**
 * Discord's rate limits as the REST client keeps them: a bucket per
 * `X-RateLimit-Bucket` and top-level resource (a channel, a guild, a
 * webhook), learned from each route's first answer; requests sharing one are
 * sent one at a time, and wait while it has nothing left until it resets. A
 * global window of 45 requests a second sits in front of every bucket.
 */

export interface RateLimitClock {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

interface Bucket {
  remaining: number;
  resetAt: number;
  /** The end of the request ahead of the next one: requests in one bucket go one at a time. */
  tail: Promise<void>;
  /** Requests holding or waiting for a turn: a bucket with any is never evicted. */
  pending: number;
}

/** The most buckets and learned routes kept; past it the least recently used idle one goes. */
const MAX_ENTRIES = 2000;

const TOP_LEVEL = /^\/(channels|guilds|webhooks)\/(\d+)/;

/** The top-level resource a path names, which splits a bucket by channel, guild or webhook. */
export function majorOf(path: string): string {
  const match = TOP_LEVEL.exec(path);
  return match === null ? "" : `${match[1] ?? ""}:${match[2] ?? ""}`;
}

/**
 * A route as its bucket is keyed before Discord names it: the method, and the
 * path with every id but the top-level one as `:id`, and what names no
 * bucket of its own — a reaction's emoji, a webhook's or an interaction's
 * token — folded, so it never lands in a key.
 */
export function routeOf(method: string, path: string): string {
  const major = TOP_LEVEL.exec(path)?.[0] ?? "";
  const rest = (path.slice(major.length).split("?")[0] ?? "")
    .replace(/\/reactions\/[^/]+/, "/reactions/:emoji")
    .replace(/\/\d{16,20}/g, "/:id")
    .replace(/\/interactions\/:id\/[^/]+/, "/interactions/:id/:token");
  // A webhook's token follows its id: never kept.
  const folded = major.startsWith("/webhooks/") ? rest.replace(/^\/[^/]+/, "/:token") : rest;
  return `${method} ${major}${folded}`;
}

/** A map that keeps its most recently used entries, never evicting one `busy` says is in use. */
class Recent<V> {
  readonly #entries = new Map<string, V>();
  readonly #busy: (value: V) => boolean;

  constructor(busy: (value: V) => boolean = () => false) {
    this.#busy = busy;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size <= MAX_ENTRIES) return;
    for (const [candidate, entry] of this.#entries) {
      if (this.#busy(entry)) continue;
      this.#entries.delete(candidate);
      return;
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

/** A wait that ends early, throwing, when `signal` aborts. */
async function waitFor(clock: RateLimitClock, ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) return clock.sleep(ms);
  await Promise.race([
    clock.sleep(ms),
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
}

export class RateLimits {
  readonly #clock: RateLimitClock;
  readonly #globalPerSecond: number;
  /** Route → the bucket hash Discord named for it. */
  readonly #hashes = new Recent<string>();
  readonly #buckets: Recent<Bucket>;
  /** When each of the last second's requests went, oldest first. */
  #recent: number[] = [];
  /** A global 429: nothing goes until then. */
  #globalUntil = 0;

  constructor(clock: RateLimitClock, globalPerSecond = 45) {
    this.#clock = clock;
    this.#globalPerSecond = globalPerSecond;
    this.#buckets = new Recent<Bucket>((bucket) => bucket.pending > 0 || bucket.resetAt > clock.now());
  }

  #keyOf(method: string, path: string): string {
    const route = routeOf(method, path);
    return `${this.#hashes.get(route) ?? `route:${route}`}|${majorOf(path)}`;
  }

  #bucket(key: string): Bucket {
    const existing = this.#buckets.get(key);
    if (existing !== undefined) return existing;
    const created: Bucket = { remaining: 1, resetAt: 0, tail: Promise.resolve(), pending: 0 };
    this.#buckets.set(key, created);
    return created;
  }

  /**
   * Waits for this request's turn: after the request ahead of it in its
   * bucket, until the bucket has room or resets, and until the global window
   * and any global block allow; an abort gives the turn up. Answers the
   * release to call once its answer is in.
   */
  async acquire(method: string, path: string, signal?: AbortSignal): Promise<() => void> {
    const bucket = this.#bucket(this.#keyOf(method, path));
    bucket.pending += 1;
    let done = (): void => {};
    const ahead = bucket.tail;
    bucket.tail = new Promise<void>((resolve) => {
      done = resolve;
    });
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      bucket.pending -= 1;
      done();
    };
    try {
      await ahead;
      const now = this.#clock.now();
      if (bucket.remaining <= 0 && now < bucket.resetAt) await waitFor(this.#clock, bucket.resetAt - now, signal);
      await this.#globalTurn(signal);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  async #globalTurn(signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      const now = this.#clock.now();
      if (now < this.#globalUntil) {
        await waitFor(this.#clock, this.#globalUntil - now, signal);
        continue;
      }
      this.#recent = this.#recent.filter((at) => now - at < 1000);
      if (this.#recent.length < this.#globalPerSecond) {
        this.#recent.push(now);
        return;
      }
      await waitFor(this.#clock, 1000 - (now - (this.#recent[0] ?? now)), signal);
    }
  }

  /** What an answer said of its bucket: its hash, what is left in it, and how long until it resets. */
  update(
    method: string,
    path: string,
    headers: { readonly bucket?: string | undefined; readonly remaining?: number | undefined; readonly resetAfterMs?: number | undefined },
  ): void {
    const route = routeOf(method, path);
    if (headers.bucket !== undefined && this.#hashes.get(route) !== headers.bucket) {
      const provisionalKey = this.#keyOf(method, path);
      const provisional = this.#buckets.get(provisionalKey);
      this.#hashes.set(route, headers.bucket);
      const namedKey = this.#keyOf(method, path);
      // The route's provisional bucket becomes the named one, its queue with it, unless another route already learned it.
      if (provisional !== undefined && this.#buckets.get(namedKey) === undefined) this.#buckets.set(namedKey, provisional);
      if (provisional !== undefined && provisional.pending === 0) this.#buckets.delete(provisionalKey);
    }
    const bucket = this.#bucket(this.#keyOf(method, path));
    if (headers.remaining !== undefined) bucket.remaining = headers.remaining;
    if (headers.resetAfterMs !== undefined) bucket.resetAt = this.#clock.now() + headers.resetAfterMs;
  }

  /** A 429: its bucket, or everything for a global one, waits `retryAfterMs`. */
  limited(method: string, path: string, retryAfterMs: number, global: boolean): void {
    const until = this.#clock.now() + retryAfterMs;
    if (global) {
      this.#globalUntil = Math.max(this.#globalUntil, until);
      return;
    }
    const bucket = this.#bucket(this.#keyOf(method, path));
    bucket.remaining = 0;
    bucket.resetAt = Math.max(bucket.resetAt, until);
  }
}
