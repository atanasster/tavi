import type { OnboardingConnectAnswer } from "@tavi/contracts";

/** How a canvas sign-in ended: its message for the page, and the connection it made. */
export interface SignInOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly connection?: OnboardingConnectAnswer;
}

/** How a sign-in stands, as `sign-in-status` answers it. */
export interface SignInStatus {
  readonly state: "waiting" | "done" | "failed" | "gone";
  readonly message?: string;
  readonly connectionId?: string;
  readonly connection?: OnboardingConnectAnswer;
}

/** One sign-in in flight: when it started, what its provider keeps, and its outcome once it has one. */
export interface SignInFlow<F> {
  readonly at: number;
  readonly data: F;
  outcome?: SignInOutcome;
}

export interface SignInFlowsOptions<F> {
  /** How long a sign-in is kept, finished or not. */
  readonly ttlMs: number;
  readonly now?: () => number;
  /** Called for a sign-in dropped for its age: what it holds open (a listener) is let go. */
  readonly expired?: (data: F) => void;
}

/**
 * The canvas's sign-ins of one provider on the owner, each owned by its
 * OAuth state and gone `ttlMs` after it began. Every read sweeps first, so an
 * expired state is never owned, waited on or reported.
 */
export class SignInFlows<F> {
  readonly #flows = new Map<string, SignInFlow<F>>();
  readonly #options: SignInFlowsOptions<F>;

  constructor(options: SignInFlowsOptions<F>) {
    this.#options = options;
  }

  /** A new sign-in under `state`. */
  add(state: string, data: F): SignInFlow<F> {
    this.sweep();
    const flow: SignInFlow<F> = { at: this.#now(), data };
    this.#flows.set(state, flow);
    return flow;
  }

  /** The sign-in under `state`, unless it is unknown or expired. */
  get(state: string): SignInFlow<F> | undefined {
    this.sweep();
    return this.#flows.get(state);
  }

  /** How a sign-in stands: waiting, done with its connection, failed, or gone. */
  status(state: string): SignInStatus {
    const flow = this.get(state);
    if (flow === undefined) return { state: "gone" };
    if (flow.outcome === undefined) return { state: "waiting" };
    const connection = flow.outcome.connection;
    return {
      state: flow.outcome.ok ? "done" : "failed",
      message: flow.outcome.message,
      ...(connection === undefined ? {} : { connectionId: connection.connectionId, connection }),
    };
  }

  owns(state: string): boolean {
    return this.get(state) !== undefined;
  }

  /** Drops every sign-in past its time. */
  sweep(): void {
    const now = this.#now();
    for (const [state, flow] of this.#flows) {
      if (now - flow.at > this.#options.ttlMs) {
        this.#flows.delete(state);
        this.#options.expired?.(flow.data);
      }
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}
