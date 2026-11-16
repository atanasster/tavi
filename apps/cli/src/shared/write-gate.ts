/**
 * Whether periodic work has anything new to look at: something was written
 * since it last ran, or `everyMs` has passed (the work that falls due with
 * time alone). `writes` is the store's count of requests that changed rows
 * (`DatabaseClient.writeCount`), so an idle owner's tick costs no worker call.
 *
 * `ran` is called once the work ends, so its own writes do not make it due
 * again; a write that lands while it runs waits for the next write or for
 * `everyMs`. The first check is always due.
 */
export interface WriteGate {
  due(): boolean;
  ran(): void;
}

export function writeGate(writes: () => number, everyMs: number, now: () => number = Date.now): WriteGate {
  let seen: number | undefined;
  let at = 0;
  return {
    due: () => seen === undefined || writes() !== seen || now() - at >= everyMs,
    ran: () => {
      seen = writes();
      at = now();
    },
  };
}
