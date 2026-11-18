import {
  BROWSER_CLOSE_REASON_RESTART,
  BROWSER_LIVE_TAKE_WAIT_MS,
  IPC_MAX_RECONNECT_ATTEMPTS,
  IPC_PROTOCOL_VERSION,
  ReplyPayloadSchema,
  TaviError,
  protocolMismatchError,
  protocolViolationError,
  unreadableFrameError,
  type BrowserLiveMessage,
  type BrowserLiveControlRequest,
  type BrowserLiveSessionInfo,
  type BrowserLiveWatchAnswer,
  type ClientEvent,
  type IpcCommand,
  type IpcCursor,
  type RunPayload,
  type RunResult,
  type SubscribeResult,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import {
  CLIENT_DISCONNECTED,
  CLIENT_TIMEOUT,
  REQUEST_TIMEOUT_MS,
  handshakeFailure,
  openConnection,
  type ClientResponse,
  type Connection,
  type ConnectionFault,
  type LiveFrame,
  type OrphanResponse,
  type OwnerCredentials,
  type SubscriptionEvent,
} from "./connection.js";
import { alreadyDelivered, memoryCursorStore, type CursorStore } from "./cursors.js";
import type { Scheduler } from "./scheduler.js";
import type { FrameTransport } from "./transport.js";

/** An owner as its discovery record describes it, with the cookie beside it. */
export interface OwnerAddress extends OwnerCredentials {
  /** Where to connect: the record's `endpoint`, never a path derived from convention. */
  readonly endpoint: string;
  readonly protocolVersion: number;
}

/**
 * How a host finds and reaches an owner. `@tavi/client/node`
 * supplies one over the data directory's discovery files and a Unix socket.
 */
export interface Dialer {
  /**
   * Read the owner's discovery afresh: the owner serving now, or `undefined`
   * when none is published. Called before every attempt, because a restarted
   * owner has a new session, a new cookie and possibly a new endpoint. A
   * rejection is final (a record another user could have planted, say).
   */
  discover(): Promise<OwnerAddress | undefined>;
  /** Open a transport to an endpoint discovery named. */
  open(endpoint: string): Promise<FrameTransport>;
  /** Whether an `open` failure could clear on another attempt (the owner is not bound yet). */
  retryable(error: unknown): boolean;
}

/**
 * The commands answered once their admission is claimed. An
 * admission can queue behind a busy task, so they wait `ADMISSION_TIMEOUT_MS`
 * rather than a read's `REQUEST_TIMEOUT_MS`.
 */
export const ADMISSION_COMMANDS: ReadonlySet<string> = new Set<IpcCommand>(["run", "approve", "review", "reply"]);

/**
 * Whether `command` with `payload` admits: an `ADMISSION_COMMANDS` member, or
 * `approvals` deciding a round (`approve`/`reject`), which the owner answers
 * through the same claim-gated path as `approve`.
 */
export function isAdmission(command: string, payload: unknown): boolean {
  if (ADMISSION_COMMANDS.has(command)) return true;
  const action = (payload as { readonly action?: unknown } | undefined)?.action;
  return command === "approvals" && (action === "approve" || action === "reject");
}

/** The deadline of an admitting request (`isAdmission`). */
export const ADMISSION_TIMEOUT_MS = 30_000;

/**
 * Whether a request may be sent again after the connection it was in flight
 * on dropped: only when its payload carries the durable key an
 * owner that already admitted it answers the resend from — `run` its
 * `operationKey`, `approve` its round (`expectedSteps`), a `review` that
 * resumes its round too (decisions alone are recorded once, whoever repeats
 * them), and `reply` its `clientMessageId`. An `approve` without its
 * round would decide whatever round is pending *now*, which after a claimed
 * first send is the next one, never shown to the operator. Everything else is
 * answered `DISCONNECTED`: resending it could run it twice.
 */
export function isResendable(command: string, payload: unknown): boolean {
  return retryKey(command, payload).safe;
}

/** Whether the contract's `reply` payload keeps a `clientMessageId`; see `retryKey`. */
const REPLY_CARRIES_ITS_KEY = "clientMessageId" in ReplyPayloadSchema.shape;

/**
 * Whether sending an admitting request again is safe, and why: the one rule a
 * resend after a drop (`isResendable`) and the answer to a timeout
 * (`unknownOutcome`) both read, so they cannot disagree.
 */
function retryKey(command: string, payload: unknown): { readonly safe: true; readonly how: string } | { readonly safe: false } {
  const fields = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  switch (command) {
    case "run":
      return typeof fields["operationKey"] === "string"
        ? { safe: true, how: `sending it again under operation key ${fields["operationKey"]} rejoins it rather than starting another run` }
        : { safe: false };
    case "approve":
      return typeof fields["expectedSteps"] === "number"
        ? { safe: true, how: `sending the same decision again for round ${fields["expectedSteps"]} is answered from the record` }
        : { safe: false };
    case "review":
      if (fields["resume"] !== true) return { safe: true, how: "sending the same decisions again records them once, whoever repeats them" };
      return typeof fields["expectedSteps"] === "number"
        ? { safe: true, how: `sending the same review again for round ${fields["expectedSteps"]} is answered from the record` }
        : { safe: false };
    case "reply":
      // On its `clientMessageId`, which the owner records
      // the message under — as long as the contract's payload keeps it: a key
      // the owner stripped could not answer a resend from the record.
      return typeof fields["clientMessageId"] === "string" && REPLY_CARRIES_ITS_KEY
        ? { safe: true, how: `sending it again with message id ${fields["clientMessageId"]} is recorded once` }
        : { safe: false };
    default:
      return { safe: false };
  }
}

/**
 * An admitting request that timed out: its outcome is unknown —
 * the owner may have admitted it — so the message says whether sending it
 * again is safe, and under which key.
 */
function unknownOutcome(command: string, payload: unknown, timedOut: string): string {
  const unknown = `${timedOut}; the outcome is unknown — the owner may have admitted it`;
  const key = retryKey(command, payload);
  if (!key.safe) return `${unknown}, and nothing in it makes a retry safe: check what the task did before sending it again`;
  return `${unknown}. ${key.how.charAt(0).toUpperCase()}${key.how.slice(1)}`;
}

/** The first pause between attempts to connect: an owner that is starting binds within it. */
export const RETRY_DELAY_MS = 500;

/**
 * The first pause between attempts to reconnect; the next one doubles it. With
 * the contract's three attempts that is about 12 s, which outlasts a
 * supervised restart (`tavi service unit`: systemd's `RestartSec=5`, launchd's
 * relaunch throttle) and the new owner's startup.
 */
export const RECONNECT_DELAY_MS = 4_000;

export type ClientState = "idle" | "connecting" | "ready" | "reconnecting" | "closed";

export interface ClientOptions {
  readonly dialer: Dialer;
  readonly scheduler: Scheduler;
  /** Where cursors are kept; a store that lives as long as the client otherwise. */
  readonly cursors?: CursorStore;
  /**
   * Connection attempts per outage, including the first; clamped to
   * `1..IPC_MAX_RECONNECT_ATTEMPTS`, which is also the default.
   */
  readonly maxAttempts?: number;
  /** The first pause between attempts of `connect()`; `RETRY_DELAY_MS` otherwise. */
  readonly retryDelayMs?: number;
  /** The first pause between attempts after a drop; `RECONNECT_DELAY_MS` otherwise. */
  readonly reconnectDelayMs?: number;
  /** Each attempt's handshake deadline; `HANDSHAKE_TIMEOUT_MS` otherwise. A timeout is final, not retried. */
  readonly handshakeTimeoutMs?: number;
}

export interface ClientRequestOptions {
  /** This request's deadline: `ADMISSION_TIMEOUT_MS` for an admitting command, `REQUEST_TIMEOUT_MS` otherwise. */
  readonly timeoutMs?: number;
}

export interface SubscribeOptions {
  /**
   * Where to start: a cursor (exclusive), `"beginning"` for everything the owner
   * retains, or absent for "from now". After a reconnect the subscription
   * resumes from its own cursor instead — or, having none, from the position
   * the owner reported as it opened. A first "from now" still in flight when
   * the connection drops is sent again as "from now": what was published in
   * between is not replayed.
   */
  readonly from?: IpcCursor | "beginning";
  /**
   * Each event, synchronously and in the owner's order; an event a
   * resubscription replays again is not delivered twice. A `resync.required`
   * means the events before it cannot be replayed gaplessly: reset, then carry
   * on. A throw ends the subscription with that error.
   */
  readonly onEvent: (event: ClientEvent) => void;
  /**
   * Called once when the subscription ends: without an error when it was
   * closed (or the client was), with one when the owner refused to resume it,
   * the client could not reconnect, it fell behind repeatedly, or `onEvent`
   * (or the cursor store) threw.
   */
  readonly onEnd?: (error?: unknown) => void;
  /** The deadline of this subscription's own `subscribe` requests, the first and every resume; `REQUEST_TIMEOUT_MS` otherwise. */
  readonly timeoutMs?: number;
}

export type RunOptions = Omit<SubscribeOptions, "from">;

/** A watch of a chat's browser sessions, kept across reconnects. */
export interface LiveWatchOptions {
  readonly workspaceId: string;
  /** One session only; every session of the task's tree when absent. */
  readonly sessionId?: string;
  /** The widest frame wanted, in pixels; the owner clamps it. */
  readonly maxWidth?: number;
  /**
   * Each message, synchronously and in the owner's order. For a frame, call
   * `ack` once it is shown: no more than two frames come unacknowledged, so
   * the ack is the stream's pace. A throw ends the watch with that error.
   * After a reconnect the client itself hands over an `ended` (reason
   * `owner restarted`) for each session the re-watch no longer has, or for
   * every known one when the re-watch is refused; its `ack` does nothing.
   */
  readonly onMessage: (message: BrowserLiveMessage, ack: () => void) => void;
  /** The sessions the watch covers, each time it is (re)opened — after a reconnect too. */
  readonly onSessions?: (sessions: readonly BrowserLiveSessionInfo[]) => void;
  /**
   * Called once when the watch ends: without an error when it was closed (or
   * the client was), with one when the owner refused to reopen it after a
   * reconnect, dropped it, the client could not reconnect, or `onMessage` or
   * `onSessions` threw.
   */
  readonly onEnd?: (error?: unknown) => void;
}

/** A live watch the client keeps across reconnects. */
export interface LiveWatch {
  readonly ended: boolean;
  /** End it, and release the owner's side if connected. */
  close(): Promise<void>;
  /**
   * A takeover action on one of its sessions,
   * sent under the watch's current subscription. Never resent after a drop:
   * input applied twice is worse than input lost. `UNAVAILABLE` while the watch
   * is not bound (reconnecting, or ended).
   */
  control(request: BrowserLiveControlRequest): Promise<ClientResponse>;
}

export interface LiveWatchOpened {
  readonly response: ClientResponse;
  readonly watch?: LiveWatch;
}

/** A subscription the client keeps across reconnects. */
export interface Subscription {
  readonly taskId: string;
  /**
   * The last event delivered, or the position the subscription opened at: what
   * it resubscribes from. Absent before either is known.
   */
  readonly cursor: IpcCursor | undefined;
  readonly ended: boolean;
  /** End it, and release the owner's side if connected. */
  close(): Promise<void>;
}

/** What `subscribe` and `run` answer: the owner's response, and the subscription when it opened one. */
export interface Opened {
  readonly response: ClientResponse;
  readonly subscription?: Subscription;
}

/** A client of one owner that survives the owner's restarts. */
export interface TaviClient {
  readonly state: ClientState;
  /**
   * Why the client closed on its own — every attempt failed, or the owner sent
   * what it cannot read (`isProtocolMismatch`) — so a host can say which.
   * Absent while it is open, and after a deliberate `close()`.
   */
  readonly failure: unknown;
  /** The connected owner's commands (`ready.features`); empty while not connected. */
  readonly features: readonly string[];
  /**
   * Connect, re-reading discovery before each attempt. Rejects when every
   * attempt failed, or at once for an owner that speaks another protocol.
   */
  connect(): Promise<void>;
  /**
   * Send one request. One in flight when the connection drops is sent again
   * once the client reconnects only when `isResendable` says its payload
   * carries its durable key; any other is answered `DISCONNECTED`. Resolves
   * with the owner's answer otherwise.
   */
  request(command: IpcCommand, payload: unknown, options?: ClientRequestOptions): Promise<ClientResponse>;
  /** Subscribe to a task's events, kept across reconnects from its cursor. */
  subscribe(taskId: string, options: SubscribeOptions): Promise<Opened>;
  /**
   * Start (or, under the same `operationKey`, rejoin) a run, and follow the
   * stream it opens. A run answered `TIMEOUT` may still have started: sending
   * it again under the same key rejoins it.
   */
  run(payload: RunPayload, options: RunOptions): Promise<Opened>;
  /**
   * Watch the browser sessions of `taskId`'s tree live (`browser-live
   * watch`); re-watched after a reconnect, where the owner answers with the
   * sessions as they stand then.
   */
  liveWatch(taskId: string, options: LiveWatchOptions): Promise<LiveWatchOpened>;
  /** The stored cursor for a task, for a caller that subscribes after a restart. */
  cursor(taskId: string): IpcCursor | undefined;
  /** Observe state changes. Returns the unsubscribe. */
  onState(listener: (state: ClientState) => void): () => void;
  /** Close the connection and end every subscription. */
  close(): void;
}

export function createClient(options: ClientOptions): TaviClient {
  return new ReconnectingClient(options);
}

/** A subscription's client side: its routing, its cursor, and how to resume it. Never handed out. */
class Handle {
  /** The owner's id on the current connection, once bound. */
  subscriptionId: string | undefined;
  /** The request that created the current binding: a BACKLOG drop is reported under it. */
  requestId: string | undefined;
  cursor: IpcCursor | undefined;
  ended = false;
  /** The owner has accepted it at least once: only then is its end reported through `onEnd`. */
  accepted = false;
  /** A `subscribe` (or its `run`) is in flight for it; that request resends itself after a reconnect. */
  binding = false;
  /** BACKLOG drops since it last delivered an event. */
  drops = 0;
  /**
   * The owner session it was first bound in when the owner reported no
   * position ("from now" on a stream it holds nothing of): a resume in another
   * session starts from that session's epoch, which the new owner answers with
   * a resync — never from the new stream's beginning as if nothing was lost.
   */
  openedIn: string | undefined;
  /** Empty for a run until its answer names the task. */
  taskId: string;
  /** What a resubscription without a cursor starts from. */
  readonly from: IpcCursor | "beginning" | undefined;
  readonly options: SubscribeOptions | RunOptions;
  /** What its caller holds: state to read and `close`, none of the routing. */
  readonly view: Subscription;

  constructor(
    taskId: string,
    from: IpcCursor | "beginning" | undefined,
    options: SubscribeOptions | RunOptions,
    close: (handle: Handle) => Promise<void>,
  ) {
    this.taskId = taskId;
    this.from = from;
    this.options = options;
    const read = (): Handle => this;
    this.view = {
      get taskId() {
        return read().taskId;
      },
      get cursor() {
        return read().cursor;
      },
      get ended() {
        return read().ended;
      },
      close: () => close(read()),
    };
  }

  /**
   * Where to resume in owner session `session`: the cursor, else the original
   * start — `"beginning"` for "now", since nothing preceded it in the session
   * it opened in; in another session, that session's epoch, so the gap is a
   * resync.
   */
  resumeFrom(session: string | undefined): IpcCursor | "beginning" {
    if (this.cursor !== undefined) return this.cursor;
    if (this.from !== undefined) return this.from;
    if (this.openedIn !== undefined && session !== undefined && session !== this.openedIn) return { epoch: this.openedIn, sequence: 0 };
    return "beginning";
  }
}

/** A live watch's client side: its routing on the current connection. Never handed out. */
class LiveHandle {
  subscriptionId: string | undefined;
  requestId: string | undefined;
  ended = false;
  accepted = false;
  binding = false;
  /** Sessions this watch has heard of and not seen end: told `ended` if a re-bind no longer has them. */
  readonly known = new Set<string>();
  readonly view: LiveWatch;
  readonly taskId: string;
  readonly options: LiveWatchOptions;

  constructor(
    taskId: string,
    options: LiveWatchOptions,
    close: (handle: LiveHandle) => Promise<void>,
    control: (handle: LiveHandle, request: BrowserLiveControlRequest) => Promise<ClientResponse>,
  ) {
    this.taskId = taskId;
    this.options = options;
    const read = (): LiveHandle => this;
    this.view = {
      get ended() {
        return read().ended;
      },
      close: () => close(read()),
      control: (request) => control(read(), request),
    };
  }
}

class ReconnectingClient implements TaviClient {
  readonly #dialer: Dialer;
  readonly #scheduler: Scheduler;
  readonly #cursors: CursorStore;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #reconnectDelayMs: number;
  readonly #handshakeTimeoutMs: number | undefined;
  readonly #stateListeners = new Set<(state: ClientState) => void>();
  readonly #handles = new Set<Handle>();
  /** Routing for the current connection only; cleared when it drops. */
  #bySubscription = new Map<string, Handle>();
  #byRequest = new Map<string, Handle>();
  readonly #liveHandles = new Set<LiveHandle>();
  #byLive = new Map<string, LiveHandle>();
  #byLiveRequest = new Map<string, LiveHandle>();
  #state: ClientState = "idle";
  #connection: Connection | undefined;
  /** Settles when the client is next ready (with the connection) or closed (with nothing). */
  #waiters: ((connection: Connection | undefined) => void)[] = [];
  /** Why the client closed, when it did not close deliberately. */
  #failure: unknown;
  /** Ends the pause between attempts early, when the client closes. */
  #wake: (() => void) | undefined;
  /** The connection adopted last has not yet lived a reconnect's first pause; see `#adopt`. */
  #young = false;
  #cancelYoung: (() => void) | undefined;
  /** Connections in a row that died young; from the second, a reconnect pauses first. */
  #youngLosses = 0;
  #requestCounter = 0;

  constructor(options: ClientOptions) {
    this.#dialer = options.dialer;
    this.#scheduler = options.scheduler;
    this.#cursors = options.cursors ?? memoryCursorStore();
    const requested = options.maxAttempts ?? IPC_MAX_RECONNECT_ATTEMPTS;
    this.#maxAttempts = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), IPC_MAX_RECONNECT_ATTEMPTS)
      : IPC_MAX_RECONNECT_ATTEMPTS;
    this.#retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs;
  }

  get state(): ClientState {
    return this.#state;
  }

  get failure(): unknown {
    return this.#failure;
  }

  get features(): readonly string[] {
    return this.#state === "ready" ? (this.#connection?.features ?? []) : [];
  }

  async connect(): Promise<void> {
    if (this.#state === "idle") {
      this.#setState("connecting");
      this.#establish(this.#retryDelayMs).catch((error: unknown) => this.#shutDown(error));
    }
    if ((await this.#ready()) === undefined) throw this.#closedError();
  }

  async request(command: IpcCommand, payload: unknown, options?: ClientRequestOptions): Promise<ClientResponse> {
    // Their events are routed to a subscription only when the client opened it.
    if (command === "subscribe" || command === "run") {
      throw new TaviError("INVALID_INPUT", `use the client's ${command}() for ${command}, so its events are routed`);
    }
    if (command === "browser-live" && (payload as { action?: unknown } | undefined)?.action === "watch") {
      throw new TaviError("INVALID_INPUT", "use the client's liveWatch() for a browser-live watch, so its messages are routed");
    }
    return this.#send(command, payload, options?.timeoutMs, isResendable(command, payload));
  }

  async subscribe(taskId: string, options: SubscribeOptions): Promise<Opened> {
    this.#assertStarted();
    const handle = this.#track(taskId, options.from, options);
    const response = await this.#bind(handle, options.from);
    return this.#opened(handle, response);
  }

  async run(payload: RunPayload, options: RunOptions): Promise<Opened> {
    this.#assertStarted();
    // A run's stream is the task's own from its start, so a resubscription that
    // has seen nothing yet asks for the beginning. Its task id is learnt from
    // the answer; until then the handle is not routable.
    const handle = this.#track("", "beginning", options);
    handle.binding = true;
    let response: ClientResponse;
    try {
      response = await this.#send("run", payload, options.timeoutMs, isResendable("run", payload), (requestId, answer) => {
        if (!answer.ok) return;
        const result = answer.result as RunResult;
        // Abandoned (timed out, or closed) before this answer: the run goes on,
        // but nobody follows this stream.
        if (handle.ended) {
          this.#release(result.subscriptionId);
          return;
        }
        handle.taskId = result.taskId;
        this.#route(handle, result.subscriptionId, requestId);
      });
    } finally {
      handle.binding = false;
    }
    return this.#opened(handle, response);
  }

  async liveWatch(taskId: string, options: LiveWatchOptions): Promise<LiveWatchOpened> {
    this.#assertStarted();
    const handle = new LiveHandle(
      taskId,
      options,
      (closing) => this.#endLive(closing, undefined, true),
      (bound, request) => {
        if (bound.ended || bound.subscriptionId === undefined)
          return Promise.resolve({ ok: false, error: { code: "UNAVAILABLE", message: "this live watch is not connected now" } });
        // A take answers once the agent's step in flight settles: it may wait that long, and a little more.
        const timeoutMs = request.action === "take" ? BROWSER_LIVE_TAKE_WAIT_MS + 30_000 : undefined;
        return this.#send("browser-live", { ...request, subscriptionId: bound.subscriptionId }, timeoutMs, false);
      },
    );
    this.#liveHandles.add(handle);
    const response = await this.#bindLive(handle);
    if (response.ok) {
      if (!handle.ended && handle.subscriptionId === undefined && this.#state === "ready") void this.#resumeLive(handle);
      return { response, watch: handle.view };
    }
    this.#liveHandles.delete(handle);
    this.#unrouteLive(handle);
    handle.ended = true;
    return { response };
  }

  cursor(taskId: string): IpcCursor | undefined {
    return this.#cursors.get(taskId);
  }

  onState(listener: (state: ClientState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  close(): void {
    this.#shutDown(undefined);
  }

  // -------------------------------------------------------------------------

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state);
      } catch {
        // A broken observer must not stop the client's own transitions.
      }
    }
  }

  /** Read through a call, so a check after an `await` is not narrowed by one before it. */
  #closed(): boolean {
    return this.#state === "closed";
  }

  #assertStarted(): void {
    if (this.#state === "idle") throw new TaviError("UNAVAILABLE", "this client is not connected: call connect() first");
  }

  #closedError(): unknown {
    return this.#failure ?? new TaviError("UNAVAILABLE", "this client is closed");
  }

  #nextRequestId(): string {
    this.#requestCounter += 1;
    return `c${this.#requestCounter}`;
  }

  /** The connection once the client is ready; `undefined` once it is closed. */
  #ready(): Promise<Connection | undefined> {
    if (this.#state === "ready" && this.#connection !== undefined && !this.#connection.closed) {
      return Promise.resolve(this.#connection);
    }
    if (this.#state === "closed") return Promise.resolve(undefined);
    this.#assertStarted();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #settleWaiters(connection: Connection | undefined): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter(connection);
  }

  /**
   * Send until answered. With `resend`, a request the connection dropped
   * under is sent again once the client reconnects — at most once per attempt
   * the client may make; without it, the drop is the answer.
   */
  async #send(
    command: string,
    payload: unknown,
    timeoutMs: number | undefined,
    resend: boolean,
    onResponse?: (requestId: string, response: ClientResponse) => void,
  ): Promise<ClientResponse> {
    const deadline = timeoutMs ?? (isAdmission(command, payload) ? ADMISSION_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    for (let send = 1; ; send += 1) {
      const connection = await this.#ready();
      // Closed for a reason (a refused session, say): that reason, which says what to do, not just that it closed.
      if (connection === undefined)
        return disconnected(this.#failure === undefined ? "this client is closed" : errorMessage(this.#failure));
      const requestId = this.#nextRequestId();
      const response = await connection.request(command, payload, requestId, {
        timeoutMs: deadline,
        ...(onResponse === undefined ? {} : { onResponse: (answer: ClientResponse) => onResponse(requestId, answer) }),
      });
      if (response.error?.code === CLIENT_TIMEOUT && isAdmission(command, payload)) {
        return { ok: false, error: { code: CLIENT_TIMEOUT, message: unknownOutcome(command, payload, response.error.message) } };
      }
      if (response.error?.code !== CLIENT_DISCONNECTED || !resend || send >= this.#maxAttempts) return response;
    }
  }

  #track(taskId: string, from: IpcCursor | "beginning" | undefined, options: SubscribeOptions | RunOptions): Handle {
    const handle = new Handle(taskId, from, options, (closing) => this.#end(closing, undefined, true));
    this.#handles.add(handle);
    return handle;
  }

  #opened(handle: Handle, response: ClientResponse): Opened {
    if (response.ok) {
      // Dropped while its answer was on its way: resume it now (a no-op if a
      // reconnect already is). An `onEvent` that threw during the replay has
      // ended it already, and `onEnd` said why.
      if (!handle.ended && handle.subscriptionId === undefined && this.#state === "ready") void this.#resume(handle);
      return { response, subscription: handle.view };
    }
    // Refused, or never answered: nothing to keep across reconnects, and no
    // end to report for a subscription its caller never held. A late answer
    // finds it ended and releases what it opened.
    this.#handles.delete(handle);
    this.#unroute(handle);
    handle.ended = true;
    return { response };
  }

  /** (Re)open `handle`'s subscription on the current connection. */
  async #bind(handle: Handle, from: IpcCursor | "beginning" | undefined): Promise<ClientResponse> {
    handle.binding = true;
    try {
      return await this.#send(
        "subscribe",
        { taskId: handle.taskId, ...(from === undefined ? {} : { from }) },
        handle.options.timeoutMs,
        true,
        (requestId, answer) => {
          if (!answer.ok) return;
          const result = answer.result as SubscribeResult;
          // Closed while this was in flight, or bound meanwhile by an earlier
          // attempt's late answer: the owner's new subscription is not wanted.
          if (handle.ended || handle.subscriptionId !== undefined) {
            this.#release(result.subscriptionId);
            return;
          }
          // "From now": the position it opened at, so a reconnect before any
          // event resumes exactly there, and a host that persists cursors does.
          if (handle.cursor === undefined && result.cursor !== undefined) {
            handle.cursor = result.cursor;
            this.#storeCursor(handle.taskId, result.cursor);
          }
          if (handle.cursor === undefined && handle.openedIn === undefined) handle.openedIn = this.#connection?.sessionId;
          this.#route(handle, result.subscriptionId, requestId);
        },
      );
    } finally {
      handle.binding = false;
    }
  }

  /** Synchronously, from the creating response: the events that follow it are routed. */
  #route(handle: Handle, subscriptionId: string, requestId: string): void {
    handle.accepted = true;
    handle.subscriptionId = subscriptionId;
    handle.requestId = requestId;
    this.#bySubscription.set(subscriptionId, handle);
    this.#byRequest.set(requestId, handle);
  }

  #unroute(handle: Handle): void {
    if (handle.subscriptionId !== undefined) this.#bySubscription.delete(handle.subscriptionId);
    if (handle.requestId !== undefined) this.#byRequest.delete(handle.requestId);
    handle.subscriptionId = undefined;
    handle.requestId = undefined;
  }

  /** Release an owner-side subscription nobody routes to; best effort, on the current connection. */
  #release(subscriptionId: string): void {
    const connection = this.#connection;
    if (this.#state !== "ready" || connection === undefined) return;
    void connection.request("unsubscribe", { subscriptionId }, this.#nextRequestId());
  }

  /**
   * Resume `handle` from its cursor until it is bound again. A drop mid-way
   * leaves it to the reconnect, which resumes it again; a resume that times out
   * is tried again within the attempt bound; a BACKLOG drop in the same chunk
   * as the answer resumes it again (`#onOrphan` bounds those). Only the owner's
   * own refusal, or running out of attempts, ends it.
   */
  async #resume(handle: Handle): Promise<void> {
    if (handle.ended || handle.binding) return;
    for (let timeouts = 0; ; ) {
      const response = await this.#bind(handle, handle.resumeFrom(this.#connection?.sessionId));
      if (handle.ended || handle.subscriptionId !== undefined || this.#state !== "ready") return;
      if (response.ok) continue;
      if (response.error?.code === CLIENT_DISCONNECTED) return;
      if (response.error?.code === CLIENT_TIMEOUT && (timeouts += 1) < this.#maxAttempts) continue;
      await this.#end(handle, responseError(response), false);
      return;
    }
  }

  async #end(handle: Handle, error: unknown, unsubscribe: boolean): Promise<void> {
    if (handle.ended) return;
    handle.ended = true;
    this.#handles.delete(handle);
    const subscriptionId = handle.subscriptionId;
    this.#unroute(handle);
    if (handle.accepted) {
      try {
        handle.options.onEnd?.(error);
      } catch {
        // As for state listeners.
      }
    }
    const connection = this.#connection;
    if (unsubscribe && subscriptionId !== undefined && this.#state === "ready" && connection !== undefined) {
      await connection.request("unsubscribe", { subscriptionId }, this.#nextRequestId());
    }
  }

  /** (Re)open a live watch on the current connection. */
  async #bindLive(handle: LiveHandle): Promise<ClientResponse> {
    handle.binding = true;
    const { workspaceId, sessionId, maxWidth } = handle.options;
    try {
      return await this.#send(
        "browser-live",
        {
          action: "watch",
          workspaceId,
          taskId: handle.taskId,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(maxWidth === undefined ? {} : { maxWidth }),
        },
        undefined,
        true,
        (requestId, answer) => {
          if (!answer.ok) return;
          const result = answer.result as BrowserLiveWatchAnswer;
          if (handle.ended || handle.subscriptionId !== undefined) {
            this.#release(result.subscriptionId);
            return;
          }
          const rebound = handle.accepted;
          handle.accepted = true;
          handle.subscriptionId = result.subscriptionId;
          handle.requestId = requestId;
          this.#byLive.set(result.subscriptionId, handle);
          this.#byLiveRequest.set(requestId, handle);
          // After a reconnect (an owner restart, say) a session the old binding streamed may be gone: say so, or the view waits on it forever.
          if (rebound) this.#endMissing(handle, new Set(result.sessions.map((session) => session.sessionId)), BROWSER_CLOSE_REASON_RESTART);
          if (handle.ended) return;
          for (const session of result.sessions) handle.known.add(session.sessionId);
          try {
            handle.options.onSessions?.(result.sessions);
          } catch (error) {
            void this.#endLive(handle, error, true);
          }
        },
      );
    } finally {
      handle.binding = false;
    }
  }

  async #resumeLive(handle: LiveHandle): Promise<void> {
    if (handle.ended || handle.binding) return;
    for (let timeouts = 0; ; ) {
      const response = await this.#bindLive(handle);
      if (handle.ended || handle.subscriptionId !== undefined || this.#state !== "ready") return;
      if (response.ok) continue;
      if (response.error?.code === CLIENT_DISCONNECTED) return;
      if (response.error?.code === CLIENT_TIMEOUT && (timeouts += 1) < this.#maxAttempts) continue;
      this.#endMissing(handle, new Set(), BROWSER_CLOSE_REASON_RESTART);
      await this.#endLive(handle, responseError(response), false);
      return;
    }
  }

  /** Hands the watcher an `ended` for each session it knew that `present` lacks. */
  #endMissing(handle: LiveHandle, present: ReadonlySet<string>, reason: string): void {
    for (const sessionId of [...handle.known]) {
      if (present.has(sessionId) || handle.ended) continue;
      handle.known.delete(sessionId);
      try {
        handle.options.onMessage({ kind: "ended", sessionId, reason }, () => undefined);
      } catch (error) {
        void this.#endLive(handle, error, true);
      }
    }
  }

  #unrouteLive(handle: LiveHandle): void {
    if (handle.subscriptionId !== undefined) this.#byLive.delete(handle.subscriptionId);
    if (handle.requestId !== undefined) this.#byLiveRequest.delete(handle.requestId);
    handle.subscriptionId = undefined;
    handle.requestId = undefined;
  }

  async #endLive(handle: LiveHandle, error: unknown, unwatch: boolean): Promise<void> {
    if (handle.ended) return;
    handle.ended = true;
    this.#liveHandles.delete(handle);
    const subscriptionId = handle.subscriptionId;
    this.#unrouteLive(handle);
    if (handle.accepted) {
      try {
        handle.options.onEnd?.(error);
      } catch {
        // As for state listeners.
      }
    }
    const connection = this.#connection;
    if (unwatch && subscriptionId !== undefined && this.#state === "ready" && connection !== undefined) {
      await connection.request("browser-live", { action: "unwatch", subscriptionId }, this.#nextRequestId());
    }
  }

  #onLive(frame: LiveFrame): void {
    const handle = this.#byLive.get(frame.subscriptionId);
    if (handle === undefined || handle.ended) return;
    const connection = this.#connection;
    let acked = false;
    // Bound to this binding: after a reconnect the old seq means nothing.
    const ack = (): void => {
      if (acked || handle.subscriptionId !== frame.subscriptionId || connection === undefined || connection !== this.#connection) return;
      acked = true;
      void connection.request(
        "browser-live",
        { action: "ack", subscriptionId: frame.subscriptionId, seq: frame.seq },
        this.#nextRequestId(),
      );
    };
    const message = frame.message;
    if (message.kind === "ended") handle.known.delete(message.sessionId);
    else if ("sessionId" in message) handle.known.add(message.sessionId);
    try {
      handle.options.onMessage(message, ack);
    } catch (error) {
      void this.#endLive(handle, error, true);
    }
  }

  /** Keep the furthest position per task: two subscriptions to one task never move it back. */
  #storeCursor(taskId: string, cursor: IpcCursor): void {
    const stored = this.#cursors.get(taskId);
    if (stored === undefined || stored.epoch !== cursor.epoch || cursor.sequence > stored.sequence) {
      this.#cursors.set(taskId, cursor);
    }
  }

  #deliver(handle: Handle, event: ClientEvent): void {
    if (handle.ended || alreadyDelivered(event, handle.cursor)) return;
    const previous = handle.cursor;
    const stored = this.#cursors.get(handle.taskId);
    handle.cursor = { epoch: event.epoch, sequence: event.sequence };
    handle.drops = 0;
    try {
      // Inside the guard: a store that fails ends the subscription rather than
      // skipping an event its cursor has already moved past.
      this.#storeCursor(handle.taskId, handle.cursor);
    } catch (error) {
      void this.#end(handle, error, true);
      return;
    }
    try {
      handle.options.onEvent(event);
    } catch (error) {
      // Not applied: neither the handle nor the store stays past it —
      // a host resuming from `cursor(taskId)` gets it again. (A store that held
      // nothing for the task keeps this position: it has no way to forget one.)
      handle.cursor = previous;
      if (stored !== undefined) {
        try {
          this.#cursors.set(handle.taskId, stored);
        } catch {
          // The subscription ends either way; a store that cannot be written is the host's to report.
        }
      }
      void this.#end(handle, error, true);
    }
  }

  #onEvent(frame: SubscriptionEvent): void {
    const handle = this.#bySubscription.get(frame.subscriptionId);
    if (handle !== undefined) this.#deliver(handle, frame.event);
  }

  #onOrphan(orphan: OrphanResponse): void {
    const live = this.#byLiveRequest.get(orphan.requestId);
    if (live !== undefined) {
      this.#unrouteLive(live);
      void this.#endLive(live, new TaviError("UNAVAILABLE", orphan.message, { details: { code: orphan.code } }), false);
      return;
    }
    const handle = this.#byRequest.get(orphan.requestId);
    if (handle === undefined) return;
    this.#unroute(handle);
    if (orphan.code === "BACKLOG" && (handle.drops += 1) < this.#maxAttempts) {
      // Dropped for falling behind: resume from the cursor. While
      // its answer is still being handled, `#resume`'s own loop picks it up.
      void this.#resume(handle);
      return;
    }
    void this.#end(handle, new TaviError("UNAVAILABLE", orphan.message, { details: { code: orphan.code } }), false);
  }

  /**
   * Connect, re-reading discovery before each attempt. Another
   * attempt is made only when it could succeed where this one failed:
   * - no owner was published yet;
   * - the endpoint was not accepting;
   * - the owner refused this attempt's credentials, but discovery has changed
   *   since they were read (an owner restarted at the same endpoint, found
   *   through the record its predecessor left); or the endpoint answered for
   *   another session;
   * - the connection closed straight after its handshake.
   * A protocol mismatch, a cookie refused by the owner discovery still names,
   * and a handshake that timed out are final.
   */
  async #establish(firstPauseMs: number, beforeFirstMs = 0): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (attempt > 1) await this.#pause(firstPauseMs * 2 ** (attempt - 2));
      else if (beforeFirstMs > 0) await this.#pause(beforeFirstMs);
      if (this.#closed()) throw this.#closedError();
      const address = await this.#dialer.discover();
      if (this.#closed()) throw this.#closedError();
      if (address === undefined) {
        lastError = new TaviError("UNAVAILABLE", "no tavi owner is serving: none is published where this client finds one");
        continue;
      }
      // Before connecting: the cookie is never presented to an owner that will
      // refuse this client's protocol anyway.
      if (address.protocolVersion !== IPC_PROTOCOL_VERSION) throw protocolMismatchError(address.protocolVersion);
      let transport: FrameTransport;
      try {
        transport = await this.#dialer.open(address.endpoint);
      } catch (error) {
        if (!this.#dialer.retryable(error)) throw error;
        lastError = error;
        continue;
      }
      // Closed while the socket opened: the cookie is not presented.
      if (this.#closed()) {
        transport.close();
        throw this.#closedError();
      }
      let connection: Connection;
      try {
        connection = await openConnection(transport, address, {
          scheduler: this.#scheduler,
          ...(this.#handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: this.#handshakeTimeoutMs }),
        });
      } catch (error) {
        if (!(await this.#worthRetrying(error, address))) throw error;
        lastError = error;
        continue;
      }
      // Closed while the handshake ran: the connection is not wanted.
      if (this.#closed()) {
        connection.close();
        throw this.#closedError();
      }
      // Closed in the same chunk as its `ready`: nothing to adopt.
      if (connection.closed) {
        lastError = new TaviError("UNAVAILABLE", "the IPC connection closed right after its handshake");
        continue;
      }
      this.#adopt(connection);
      return;
    }
    throw lastError;
  }

  /** Whether a failed handshake could succeed on another attempt; see `#establish`. */
  async #worthRetrying(error: unknown, address: OwnerAddress): Promise<boolean> {
    const failure = handshakeFailure(error);
    if (failure === "session") return true;
    if (failure !== "closed") return false;
    // A refusal is final for the owner these credentials were read for; one
    // whose record has changed since is a different owner.
    const now = await this.#dialer.discover().catch(() => undefined);
    // No owner published now: one shutting down has unpublished, or its
    // successor has not published yet — worth another attempt.
    if (now === undefined) return true;
    return now.sessionId !== address.sessionId || now.token !== address.token || now.endpoint !== address.endpoint;
  }

  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.#scheduler.delay(ms, () => {
        this.#wake = undefined;
        resolve();
      });
      this.#wake = () => {
        this.#wake = undefined;
        cancel();
        resolve();
      };
    });
  }

  #adopt(connection: Connection): void {
    this.#connection = connection;
    // Young until a reconnect's first pause (`reconnectDelayMs`) has passed.
    // One connection that dies young is reconnected at once — an owner
    // restarted just after this client connected — but a second in a row
    // waits that pause first, the next twice as long, and past the attempt
    // bound the client gives up: each handshake that succeeds starts a new
    // attempt budget, so an owner that accepts and then drops every
    // connection would otherwise be redialled for ever.
    this.#young = true;
    this.#cancelYoung?.();
    this.#cancelYoung = this.#scheduler.delay(this.#reconnectDelayMs, () => {
      this.#young = false;
      this.#youngLosses = 0;
    });
    connection.onEvent((frame) => this.#onEvent(frame));
    connection.onLive((frame) => this.#onLive(frame));
    connection.onOrphanResponse((orphan) => this.#onOrphan(orphan));
    connection.onClose((fault) => this.#lost(connection, fault));
    this.#setState("ready");
    this.#settleWaiters(connection);
    // After a reconnect, every live subscription resumes from its cursor; on
    // the first connect there are none yet.
    for (const handle of [...this.#handles]) {
      if (handle.accepted && handle.subscriptionId === undefined) void this.#resume(handle);
    }
    for (const handle of [...this.#liveHandles]) {
      if (handle.accepted && handle.subscriptionId === undefined) void this.#resumeLive(handle);
    }
  }

  /**
   * The connection dropped: reconnect, unless the client is the one that
   * closed it — or closed it for what the owner sent, which it would send
   * again on every resumption — or the owner keeps dropping young connections.
   */
  #lost(connection: Connection, fault?: ConnectionFault): void {
    if (this.#connection !== connection || this.#state === "closed") return;
    // A connection that outlived its window reset the count when it did.
    if (this.#young) this.#youngLosses += 1;
    this.#cancelYoung?.();
    this.#cancelYoung = undefined;
    this.#young = false;
    if (fault !== undefined) {
      this.#shutDown(fault.kind === "unreadable" ? unreadableFrameError(fault.detail) : protocolViolationError(fault.detail));
      return;
    }
    if (this.#youngLosses > this.#maxAttempts) {
      this.#shutDown(
        new TaviError(
          "UNAVAILABLE",
          `the owner dropped ${this.#youngLosses} connections in a row, each within ${this.#reconnectDelayMs} ms of its handshake`,
        ),
      );
      return;
    }
    this.#connection = undefined;
    this.#bySubscription = new Map();
    this.#byRequest = new Map();
    for (const handle of this.#handles) {
      handle.subscriptionId = undefined;
      handle.requestId = undefined;
    }
    this.#byLive = new Map();
    this.#byLiveRequest = new Map();
    for (const handle of this.#liveHandles) {
      handle.subscriptionId = undefined;
      handle.requestId = undefined;
    }
    this.#setState("reconnecting");
    const beforeFirstMs = this.#youngLosses >= 2 ? this.#reconnectDelayMs * 2 ** (this.#youngLosses - 2) : 0;
    this.#establish(this.#reconnectDelayMs, beforeFirstMs).catch((error: unknown) => this.#shutDown(error));
  }

  /** Close for good: deliberately (`error` absent) or because reconnecting failed. */
  #shutDown(error: unknown): void {
    if (this.#state === "closed") return;
    this.#failure = error;
    this.#setState("closed");
    // A pause between attempts ends now, so no timer outlives the client.
    this.#wake?.();
    this.#cancelYoung?.();
    this.#cancelYoung = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    connection?.close();
    this.#settleWaiters(undefined);
    for (const handle of [...this.#handles]) void this.#end(handle, error, false);
    for (const handle of [...this.#liveHandles]) void this.#endLive(handle, error, false);
  }
}

function disconnected(message: string): ClientResponse {
  return { ok: false, error: { code: CLIENT_DISCONNECTED, message } };
}

function responseError(response: ClientResponse): TaviError {
  return new TaviError("UNAVAILABLE", response.error?.message ?? "the owner refused the subscription", {
    details: { code: response.error?.code ?? "UNKNOWN" },
  });
}
