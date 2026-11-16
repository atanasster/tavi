/** How long a read made as tools are offered is reused: every tool's hook of one model step shares it. */
export const OFFER_READ_REUSE_MS = 1_000;

/**
 * A read the calls of one burst share: a call within `windowMs` of the one
 * that read reuses that read, even while it is pending, rather than starting
 * another. It never rejects: a failed read is tried again once the window
 * has passed.
 */
export function recentRead(read: (key: string) => Promise<unknown>, windowMs: number): (key: string) => Promise<void> {
  const reads = new Map<string, { readonly at: number; readonly done: Promise<void> }>();
  return (key) => {
    const now = Date.now();
    const recent = reads.get(key);
    if (recent !== undefined && now - recent.at <= windowMs) return recent.done;
    const done = read(key).then(
      () => undefined,
      () => undefined,
    );
    reads.set(key, { at: now, done });
    return done;
  };
}
