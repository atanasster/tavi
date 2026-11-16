/**
 * Polling waits. The default limit is well inside the 30-second test timeout
 * and far above an idle run's wait: under a full parallel suite a condition
 * that settles in milliseconds alone has taken over 5 seconds, and a shorter
 * limit failed a passing test for no reason it named.
 */

export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const DEFAULT_WAIT_INTERVAL_MS = 10;

export interface WaitOptions {
  /** Pause between checks. Default 10 ms. */
  readonly intervalMs?: number;
  /** What is awaited, for the timeout's message. */
  readonly what?: string;
}

/** Resolves after `ms` milliseconds, on whatever `setTimeout` is installed when it is called (a fake timer's, under `vi.useFakeTimers`). */
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function timedOut(timeoutMs: number, what: string | undefined, fallback: string): Error {
  return new Error(what === undefined ? fallback : `timed out waiting for ${what} after ${timeoutMs}ms`);
}

/** Polls until `predicate` holds. It is checked at least once, and once more after the deadline passes. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  options: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw timedOut(timeoutMs, options.what, `condition was still false after ${timeoutMs}ms`);
    await delay(options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  }
}

/** Polls `read` until `predicate` holds of its value, and answers that value. */
export async function until<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  options: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline)
      throw timedOut(timeoutMs, options.what, `still not so after ${timeoutMs}ms: ${String(JSON.stringify(value)).slice(0, 400)}`);
    await delay(options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  }
}

/** Polls `read` until it answers something other than `undefined`, and answers that. */
export async function waitForValue<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  options: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw timedOut(timeoutMs, options.what, `condition was still false after ${timeoutMs}ms`);
    await delay(options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  }
}
