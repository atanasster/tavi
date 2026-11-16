import type { ResourceScope } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

type Disposer = () => void | Promise<void>;

const toDisposer = (input: Disposer | { dispose(): void | Promise<void> }): Disposer => {
  if (typeof input === "function") return input;
  return () => input.dispose();
};

/**
 * Owned cleanup.
 *
 * Disposers run once, newest first. A failure does not stop the remaining
 * disposers: they are all attempted and failures are aggregated, because a
 * half-cleaned plugin is worse than a noisy one.
 */
export class OwnedResourceScope implements ResourceScope {
  readonly ownedByPluginHost = true as const;
  readonly #controller = new AbortController();
  readonly #disposers: { readonly name: string; readonly run: Disposer }[] = [];
  #disposed = false;
  #disposal: Promise<readonly { message: string; error: unknown }[]> | undefined;
  #disposalFailures: { message: string; error: unknown }[] = [];
  #disposersAttempted = 0;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Failures observed so far.
   *
   * The list keeps growing while disposal continues, so a caller that reports
   * after a deadline observes late failures too rather than a stale snapshot.
   */
  get disposalFailures(): readonly { message: string; error: unknown }[] {
    return this.#disposalFailures;
  }

  /** Disposers attempted so far; the honest replacement for a registered count. */
  get disposersAttempted(): number {
    return this.#disposersAttempted;
  }

  /** Total disposers registered, whether or not they have run yet. */
  get disposerCount(): number {
    return this.#disposers.length;
  }

  defer(input: Disposer | { dispose(): void | Promise<void> }): void {
    if (this.#disposed) {
      throw new Error("Cannot defer cleanup on a scope that has already been disposed");
    }
    this.#disposers.push({ name: `disposer#${this.#disposers.length + 1}`, run: toDisposer(input) });
  }

  /** Abort dependents without running disposers (used before a drain). */
  abort(reason?: unknown): void {
    this.#controller.abort(reason);
  }

  /**
   * Dispose everything in reverse acquisition order.
   *
   * Returns aggregated failures so the caller can report that cleanup did *not*
   * fully succeed, rather than treating a timeout as success.
   */
  dispose(): Promise<readonly { message: string; error: unknown }[]> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#disposal = Promise.resolve().then(() => this.#runDisposers());
    this.#controller.abort(new Error("plugin stopping"));
    return this.#disposal;
  }

  async #runDisposers(): Promise<readonly { message: string; error: unknown }[]> {
    for (let i = this.#disposers.length - 1; i >= 0; i -= 1) {
      const entry = this.#disposers[i];
      if (entry === undefined) continue;
      this.#disposersAttempted += 1;
      try {
        await entry.run();
      } catch (error) {
        this.#disposalFailures.push({
          message: errorMessage(error),
          error,
        });
      }
    }
    this.#disposers.length = 0;
    return this.#disposalFailures;
  }
}

/**
 * Run disposal under a deadline.
 *
 * Exported for the host and for tests: exceeding the deadline is reported as
 * `timedOut: true`, never as success.
 */
export interface DisposalOutcome {
  readonly timedOut: boolean;
  /**
   * Failures observed. Read from the scope after the race settles, so failures
   * that arrive after a deadline are included (the list is live, not a snapshot).
   */
  readonly failures: readonly { message: string; error: unknown }[];
  readonly attempted: number;
  readonly registered: number;
}

export async function disposeWithDeadline(scope: OwnedResourceScope, deadlineMs: number): Promise<DisposalOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
    timer.unref?.();
  });

  const settled = await Promise.race([scope.dispose().then(() => "disposed" as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);

  return {
    timedOut: settled === "timeout",
    failures: scope.disposalFailures,
    attempted: scope.disposersAttempted,
    registered: scope.disposerCount,
  };
}
