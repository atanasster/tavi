/**
 * Each connection's send pace: its
 * descriptor's `sendRate`, overall and to any one target, as token buckets
 * that allow a short burst; and a pause after the provider said to slow down
 * (a 429's `retry_after`), so the next send waits instead of failing too.
 */
export interface SendRate {
  readonly perMinute: number;
  readonly perTargetPerMinute?: number | undefined;
}

export interface SendPacer {
  /** Waits until `connectionId` may send to `target` at `rate`, then takes the turn. */
  take(connectionId: string, rate: SendRate, target: string): Promise<void>;
  /** Holds every send on `connectionId` for `ms`. */
  backOff(connectionId: string, ms: number): void;
}

/** How many buckets are kept before idle ones are forgotten. */
const MAX_IDLE_BUCKETS = 1_000;

/** Three seconds' worth, so a reply and its follow-up are not held apart. */
function burstOf(perMinute: number): number {
  return Math.max(1, Math.floor(perMinute / 20));
}

export function createSendPacer(nowMs: () => number, sleep: (ms: number) => Promise<void>): SendPacer {
  const buckets = new Map<string, { tokens: number; last: number }>();
  const pausedUntil = new Map<string, number>();

  /** How long until `key` has a token, its bucket refilled to now. */
  const delayOf = (key: string, perMinute: number): number => {
    const at = nowMs();
    // A bucket idle a minute has refilled (a burst is three seconds' worth): forgotten, it is the same as a new one,
    // so one per target ever sent to is not kept for good.
    if (buckets.size > MAX_IDLE_BUCKETS) for (const [idle, bucket] of buckets) if (at - bucket.last > 60_000) buckets.delete(idle);
    const burst = burstOf(perMinute);
    const bucket = buckets.get(key) ?? { tokens: burst, last: at };
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.last) * perMinute) / 60_000);
    bucket.last = at;
    buckets.set(key, bucket);
    return bucket.tokens >= 1 ? 0 : Math.ceil(((1 - bucket.tokens) * 60_000) / perMinute);
  };
  const spend = (key: string): void => {
    const bucket = buckets.get(key);
    if (bucket !== undefined) bucket.tokens -= 1;
  };

  return {
    async take(connectionId, rate, target) {
      const targetKey = `${connectionId}\u0000${target}`;
      for (;;) {
        const paused = (pausedUntil.get(connectionId) ?? 0) - nowMs();
        const overall = delayOf(connectionId, rate.perMinute);
        const toTarget = rate.perTargetPerMinute === undefined ? 0 : delayOf(targetKey, rate.perTargetPerMinute);
        const wait = Math.max(paused, overall, toTarget);
        if (wait <= 0) {
          // Taken with no await since the check, so two sends never take one token.
          spend(connectionId);
          if (rate.perTargetPerMinute !== undefined) spend(targetKey);
          return;
        }
        await sleep(wait);
      }
    },
    backOff(connectionId, ms) {
      pausedUntil.set(connectionId, Math.max(pausedUntil.get(connectionId) ?? 0, nowMs() + ms));
    },
  };
}
