/** The canvas's one abortable wait, the browser's counterpart of node-kit's `sleep`. */

export interface DelayOptions {
  /**
   * What an abort does: `"reject"` (the default) rejects with the signal's
   * reason, as `signal.throwIfAborted()` throws; `"resolve"` ends the wait
   * early, for a caller that checks the signal itself.
   */
  readonly onAbort?: "reject" | "resolve";
}

/** Waits `ms`, or until `signal` aborts; the timer is cleared either way (node-kit's `sleep`, for the browser). */
export function delay(ms: number, signal?: AbortSignal, options: DelayOptions = {}): Promise<void> {
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
