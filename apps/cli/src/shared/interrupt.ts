/** The signals that end a foreground command: Ctrl-C, a stop, and its terminal (or, on Windows, its console window) closing. */
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Call `stop` once on the first of `INTERRUPTS`; returns what takes the listeners off again. */
export function onInterrupt(stop: () => void): () => void {
  for (const signal of INTERRUPTS) process.once(signal, stop);
  return () => {
    for (const signal of INTERRUPTS) process.removeListener(signal, stop);
  };
}
