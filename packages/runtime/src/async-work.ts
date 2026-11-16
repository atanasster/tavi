import { TaviError } from "@tavi/contracts";

/** Own accepted work until it settles, including work that outlives a caller timeout. */
export class AsyncWork {
  #closed = false;
  readonly #pending = new Set<Promise<unknown>>();
  get active(): boolean {
    return this.#pending.size > 0;
  }
  get closed(): boolean {
    return this.#closed;
  }
  stop(): void {
    this.#closed = true;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new TaviError("UNAVAILABLE", "Background work is stopping"));
    return this.track(Promise.resolve().then(operation));
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }

  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  async idleWithin(milliseconds: number): Promise<boolean> {
    if (!this.active) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.idle().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
