export interface SleepOptions {
  /**
   * What an abort does: `"reject"` (the default) rejects with the signal's
   * reason, as `signal.throwIfAborted()` throws; `"resolve"` ends the wait
   * early, for a loop that checks the signal itself.
   */
  readonly onAbort?: "reject" | "resolve";
}

/** Waits `ms`, or until `signal` aborts; the timer is cleared either way. */
export function sleep(ms: number, signal?: AbortSignal, options: SleepOptions = {}): Promise<void> {
  const resolveOnAbort = options.onAbort === "resolve";
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      if (resolveOnAbort) resolve();
      else reject(signal.reason);
      return;
    }
    const aborted = (): void => {
      clearTimeout(timer);
      if (resolveOnAbort) resolve();
      else reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
