/** One at a time: each task runs after the one before it has settled. */
export type SerialLock = <T>(task: () => Promise<T>) => Promise<T>;

export function serialLock(): SerialLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    tail = run.catch(() => undefined);
    return run;
  };
}
