import type {
  ClientResponse,
  ClientState,
  LiveWatchOpened,
  Opened,
  RunOptions,
  SubscribeOptions,
  Subscription,
  TaviClient,
} from "@tavi/client";
import type { ClientEvent, IpcCommand, IpcCursor, RunPayload, SubscribeResult } from "@tavi/contracts";

/**
 * A `TaviClient` a test scripts (`runChat`'s `connect` seam): answers per
 * command, a subscription's replay and its `SubscribeResult`, and the client's
 * own state changes — for what a live owner cannot easily be made to do, such
 * as evict the start of a stream or have recorded a suspension long ago.
 */
export class ScriptedClient implements TaviClient {
  state: ClientState = "ready";
  failure: unknown;
  readonly features: readonly string[] = [];
  /** The task of every subscription `subscribe` opened that was closed since. */
  readonly closedSubscriptions: string[] = [];
  /** Every `request`, and every `run` payload, in order. */
  readonly requests: { readonly command: string; readonly payload: unknown }[] = [];
  readonly runs: RunPayload[] = [];
  /** The answer to each `request`, by command. */
  answers: Partial<Record<IpcCommand, (payload: unknown) => ClientResponse>> = {};
  /** What `subscribe` answers, and the events it replays synchronously, as the owner writes them behind the answer. */
  subscribed: {
    readonly result: Omit<SubscribeResult, "subscriptionId">;
    readonly events: readonly ClientEvent[] | ((options: SubscribeOptions) => readonly ClientEvent[]);
  } = {
    result: { replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" },
    events: [],
  };
  /** What each `run` answers, in turn; the last repeats. */
  runAnswers: ((options: RunOptions) => Opened)[] = [];
  readonly #stateListeners = new Set<(state: ClientState) => void>();

  connect(): Promise<void> {
    return Promise.resolve();
  }

  request(command: IpcCommand, payload: unknown): Promise<ClientResponse> {
    this.requests.push({ command, payload });
    const answer = this.answers[command];
    return Promise.resolve(
      answer === undefined ? { ok: false, error: { code: "UNSUPPORTED", message: `${command} is not scripted` } } : answer(payload),
    );
  }

  /** The last subscription's listener: `emit` delivers an event to it, as the owner would later. */
  #onEvent: ((event: ClientEvent) => void) | undefined;

  /** An event on the last subscription's stream, after its replay. */
  emit(event: ClientEvent): void {
    this.#onEvent?.(event);
  }

  /** Every subscription asked for, with where it asked to start. */
  readonly subscribes: { readonly taskId: string; readonly options: SubscribeOptions }[] = [];

  subscribe(taskId: string, options: SubscribeOptions): Promise<Opened> {
    this.subscribes.push({ taskId, options });
    this.#onEvent = (event) => options.onEvent(event);
    // A replay may depend on where the subscription starts (`from`): a stream followed from now replays nothing of the past.
    for (const event of typeof this.subscribed.events === "function" ? this.subscribed.events(options) : this.subscribed.events)
      options.onEvent(event);
    return Promise.resolve({
      response: { ok: true, result: { subscriptionId: `sub-${taskId}`, ...this.subscribed.result } },
      // As the real client does for a subscription it accepted: closing it reports its end.
      subscription: subscription(taskId, () => {
        this.closedSubscriptions.push(taskId);
        options.onEnd?.();
      }),
    });
  }

  run(payload: RunPayload, options: RunOptions): Promise<Opened> {
    this.runs.push(payload);
    const answer = this.runAnswers[Math.min(this.runs.length - 1, this.runAnswers.length - 1)];
    if (answer === undefined)
      return Promise.resolve({ response: { ok: false, error: { code: "UNSUPPORTED", message: "run is not scripted" } } });
    return Promise.resolve(answer(options));
  }

  cursor(): IpcCursor | undefined {
    return undefined;
  }

  async liveWatch(): Promise<LiveWatchOpened> {
    return { response: { ok: false, error: { code: "UNSUPPORTED", message: "no live view in this fake" } } };
  }

  onState(listener: (state: ClientState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  /** Move to `state`, as the real client does, telling its listeners. */
  become(state: ClientState, failure?: unknown): void {
    this.state = state;
    this.failure = failure;
    for (const listener of [...this.#stateListeners]) listener(state);
  }

  close(): void {
    this.state = "closed";
  }
}

export function subscription(taskId: string, onClose: () => void = () => undefined): Subscription {
  return {
    taskId,
    cursor: undefined,
    ended: false,
    close: () => {
      onClose();
      return Promise.resolve();
    },
  };
}
