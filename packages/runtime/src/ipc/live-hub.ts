import {
  BROWSER_LIVE_CONNECTION_PAUSE_BYTES,
  BROWSER_LIVE_ENDED_TASK,
  BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND,
  BROWSER_LIVE_MAX_UNACKED,
  BROWSER_LIVE_MAX_WATCHES,
  BROWSER_LIVE_QUALITY,
  TaviError,
  clampLiveWidth,
  type BrowserLiveFrame,
  type BrowserLiveMessage,
  type BrowserLiveControlPayload,
  type BrowserLivePort,
  type BrowserLiveSessionInfo,
  type BrowserLiveWatch,
  type BrowserLiveWatchAnswer,
} from "@tavi/contracts";

/**
 * The owner's fan-out of the live browser view: what `browser-live` watch, ack and unwatch do.
 *
 * - **A watch covers a chat's task tree**: the task, and every task under it,
 *   so a sub-agent's browsing shows too. A session opened later in the tree
 *   joins the subscription.
 * - **Credit.** At most `BROWSER_LIVE_MAX_UNACKED` frames are unacknowledged
 *   per subscription; a newer frame replaces one waiting to be sent
 *   (latest wins). Other messages are always sent, never dropped. A session
 *   whose frame waits holds Chromium's acknowledgement (the source's sink
 *   answers `false`) until an `ack` frees credit.
 * - **Budgets for the shared connection.** Every tab of `tavi ui` shares one
 *   owner connection, closed past 16 MiB of backlog — which would drop every
 *   tab. So a connection holds at most `BROWSER_LIVE_MAX_WATCHES` watches,
 *   and no frame is sent while its backlog is over
 *   `BROWSER_LIVE_CONNECTION_PAUSE_BYTES` (the latest waits).
 * - **Task end.** The adapter makes a task's sessions inactive when it ends;
 *   the source then tells their watchers `ended { task-ended }`. The session
 *   is kept, and so is its watch: a person may still take it over, and it
 *   streams again once in use. A session closed and opened again is watched
 *   again (`onSession`).
 * - **Cleanup.** An unwatch, or the connection closing, stops everything the
 *   subscription watched.
 * - **Takeover.** `take`, `input`, `select`, `dialog` and `release`
 *   name a session of one of the connection's own watches, and reach the
 *   source through that watch — which refuses all but `take` unless it holds
 *   control. Input batches are limited per watch to
 *   `BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND`, and must come in order.
 *   Their contents pass through untouched and are never kept or logged.
 *
 * Nothing here is stored: frames pass through and are forgotten.
 */

/** What the hub needs of an IPC connection: `IpcConnection`'s live surface. */
export interface LiveHubConnection {
  readonly createSubscription: (input: {
    readonly subscriptionId: string;
    readonly requestId: string;
    readonly onDropped: (reason: string) => void;
    readonly live: true;
  }) => void;
  readonly dropSubscription: (subscriptionId: string) => void;
  readonly sendLive: (subscriptionId: string, seq: number, message: BrowserLiveMessage) => boolean;
  readonly backlogBytes: () => number;
  readonly onClose: (listener: () => void) => () => void;
}

export interface LiveHubOptions {
  readonly source: BrowserLivePort;
  /** The task and every task under it; `NOT_FOUND` when the task is not in the workspace. */
  readonly taskTree: (workspaceId: string, taskId: string) => Promise<readonly string[]>;
  /** The task's ancestors, nearest last; used to place a session opened later. */
  readonly ancestors: (workspaceId: string, taskId: string) => Promise<readonly string[]>;
  readonly newSubscriptionId: () => string;
  /** The name of the sub-agent a task below the watched one runs, for the session switcher; absent for none. */
  readonly agentLabel?: (workspaceId: string, taskId: string) => Promise<string | undefined>;
  /** How long a frame held by the connection's backlog waits before it is tried again. Default 100 ms. */
  readonly retryMs?: number;
  readonly pauseBytes?: number;
  readonly onError?: (error: unknown) => void;
  /** Milliseconds, for the input rate limit; injectable for tests. */
  readonly now?: () => number;
}

export interface LiveHubWatchInput {
  readonly connection: LiveHubConnection;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly sessionId?: string | undefined;
  readonly maxWidth?: number | undefined;
}

export interface LiveHub {
  watch(input: LiveHubWatchInput): Promise<BrowserLiveWatchAnswer>;
  /** Credit back for a frame; `NOT_FOUND` for a subscription that is not this connection's. */
  ack(connection: LiveHubConnection, subscriptionId: string, seq: number): void;
  unwatch(connection: LiveHubConnection, subscriptionId: string): void;
  /** Live watches on `connection` now. */
  count(connection: LiveHubConnection): number;
  /** Whether `subscriptionId` is a live watch of `connection`'s. */
  owns(connection: LiveHubConnection, subscriptionId: string): boolean;
  /** A takeover action on a session of one of `connection`'s watches; `actor` is who a release or decline is recorded as. */
  control(connection: LiveHubConnection, payload: BrowserLiveControlPayload, actor?: string): Promise<void>;
  close(): void;
}

interface SessionEntry {
  readonly taskId: string;
  watch: BrowserLiveWatch | undefined;
  /** The latest frame not yet sent for want of credit. */
  pending: BrowserLiveFrame | undefined;
}

interface Subscription {
  readonly id: string;
  readonly connection: LiveHubConnection;
  readonly workspaceId: string;
  readonly tasks: Set<string>;
  /** Sub-agents' names by task, for the tree's tasks below the watched one. */
  readonly agents: Map<string, string>;
  /** Only this session, when the watch named one. */
  readonly sessionId: string | undefined;
  readonly maxWidth: number;
  seq: number;
  readonly unacked: Set<number>;
  readonly sessions: Map<string, SessionEntry>;
  retry: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /** When its recent input batches came (ms), for the rate limit. */
  readonly inputTimes: number[];
  /** The last input batch's `seq`. */
  lastInputSeq: number | undefined;
}

export function createLiveHub(options: LiveHubOptions): LiveHub {
  const pauseBytes = options.pauseBytes ?? BROWSER_LIVE_CONNECTION_PAUSE_BYTES;
  const retryMs = options.retryMs ?? 100;
  const now = options.now ?? Date.now;
  const byConnection = new Map<LiveHubConnection, Map<string, Subscription>>();
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter that throws must not break the hub.
    }
  };

  const allSubscriptions = (): Subscription[] => [...byConnection.values()].flatMap((subscriptions) => [...subscriptions.values()]);
  const hasCredit = (subscription: Subscription): boolean => subscription.unacked.size < BROWSER_LIVE_MAX_UNACKED;

  /** A session's info with its sub-agent's name, when its task has one. */
  function labelled<T extends BrowserLiveSessionInfo>(subscription: Subscription, info: T): T {
    const agent = subscription.agents.get(info.taskId);
    return agent === undefined ? info : { ...info, agent };
  }

  /** The names of the sub-agents running `taskIds`, best effort: a name that cannot be read is left out. */
  async function agentsOf(workspaceId: string, taskIds: readonly string[]): Promise<Map<string, string>> {
    const agents = new Map<string, string>();
    const label = options.agentLabel;
    if (label === undefined) return agents;
    await Promise.all(
      taskIds.map(async (taskId) => {
        const name = await label(workspaceId, taskId).catch((error: unknown) => (report(error), undefined));
        if (name !== undefined) agents.set(taskId, name.slice(0, 64));
      }),
    );
    return agents;
  }

  /** Sends one message; a connection that refuses it is gone, and the subscription with it. */
  function emit(subscription: Subscription, message: BrowserLiveMessage): number | undefined {
    if (subscription.closed) return undefined;
    const seq = subscription.seq;
    subscription.seq += 1;
    if (!subscription.connection.sendLive(subscription.id, seq, message)) {
      end(subscription);
      return undefined;
    }
    return seq;
  }

  /** Sends waiting frames while there is credit and the connection has room. */
  function flush(subscription: Subscription): void {
    if (subscription.closed) return;
    for (const entry of subscription.sessions.values()) {
      if (entry.pending === undefined) continue;
      if (!hasCredit(subscription)) return;
      if (subscription.connection.backlogBytes() > pauseBytes) {
        if (subscription.retry === undefined) {
          subscription.retry = setTimeout(() => {
            subscription.retry = undefined;
            flush(subscription);
            demand(subscription);
          }, retryMs);
        }
        return;
      }
      const frame = entry.pending;
      entry.pending = undefined;
      const seq = emit(subscription, frame);
      if (seq === undefined) return;
      subscription.unacked.add(seq);
    }
  }

  /** Lets every session without a waiting frame render its next one. */
  function demand(subscription: Subscription): void {
    if (subscription.closed || !hasCredit(subscription)) return;
    for (const entry of subscription.sessions.values()) {
      if (entry.pending === undefined) entry.watch?.demand();
    }
  }

  function watchSession(subscription: Subscription, info: BrowserLiveSessionInfo): void {
    if (subscription.closed || subscription.sessions.has(info.sessionId)) return;
    if (info.state === "closed") return;
    const entry: SessionEntry = { taskId: info.taskId, watch: undefined, pending: undefined };
    subscription.sessions.set(info.sessionId, entry);
    entry.watch = options.source.watch(info.sessionId, { maxWidth: subscription.maxWidth, quality: BROWSER_LIVE_QUALITY }, (message) => {
      if (subscription.closed || subscription.sessions.get(info.sessionId) !== entry) return false;
      if (message.kind === "frame") {
        entry.pending = message;
        flush(subscription);
        return entry.pending === undefined && hasCredit(subscription);
      }
      // A frame still waiting predates this news: a hidden or ended page's is never sent.
      if (message.kind === "hidden" || message.kind === "ended") entry.pending = undefined;
      emit(subscription, message.kind === "session" ? labelled(subscription, message) : message);
      // A session whose task ended is kept, and its watch with it: a person may still take it, and it streams again in use.
      if (message.kind === "ended" && message.reason !== BROWSER_LIVE_ENDED_TASK) subscription.sessions.delete(info.sessionId);
      return hasCredit(subscription);
    });
  }

  /** Stops what the subscription watched; it receives nothing more. */
  function end(subscription: Subscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    if (subscription.retry !== undefined) clearTimeout(subscription.retry);
    for (const entry of subscription.sessions.values()) entry.watch?.close();
    subscription.sessions.clear();
    byConnection.get(subscription.connection)?.delete(subscription.id);
  }

  function ownSubscription(connection: LiveHubConnection, subscriptionId: string): Subscription {
    const subscription = byConnection.get(connection)?.get(subscriptionId);
    if (subscription === undefined) throw new TaviError("NOT_FOUND", `no live watch ${subscriptionId} on this connection`);
    return subscription;
  }

  /** A session opened, or changed state, somewhere: a watch over its task tree takes it up. */
  const stopListening = options.source.onSession((workspaceId, info) => {
    if (info.state !== "open") return;
    const undecided: Subscription[] = [];
    for (const subscription of allSubscriptions()) {
      // A watch of one session takes up that one again once it is back in use; a tree's, any of the tree's.
      if (
        subscription.workspaceId !== workspaceId ||
        (subscription.sessionId !== undefined && subscription.sessionId !== info.sessionId) ||
        subscription.sessions.has(info.sessionId)
      )
        continue;
      if (subscription.tasks.has(info.taskId)) watchSession(subscription, info);
      else undecided.push(subscription);
    }
    if (undecided.length === 0) return;
    // One lookup of the task's ancestors, for every watch it might belong to.
    void options.ancestors(workspaceId, info.taskId).then(async (ancestors) => {
      const joining = undecided.filter((subscription) => ancestors.some((ancestor) => subscription.tasks.has(ancestor)));
      if (joining.length === 0) return;
      const agent = (await agentsOf(workspaceId, [info.taskId])).get(info.taskId);
      for (const subscription of joining) {
        subscription.tasks.add(info.taskId);
        if (agent !== undefined) subscription.agents.set(info.taskId, agent);
        watchSession(subscription, info);
      }
    }, report);
  });

  return {
    async watch(input) {
      const tasks = await options.taskTree(input.workspaceId, input.taskId);
      const full = (): boolean => (byConnection.get(input.connection)?.size ?? 0) >= BROWSER_LIVE_MAX_WATCHES;
      const refuseFull = (): never => {
        throw new TaviError("BUDGET_EXCEEDED", `this connection already holds ${BROWSER_LIVE_MAX_WATCHES} live watches; unwatch one first`);
      };
      if (full()) refuseFull();
      // Named after the limit check and before the sessions are read: a session opened meanwhile is not missed.
      const agents = await agentsOf(
        input.workspaceId,
        tasks.filter((taskId) => taskId !== input.taskId),
      );
      // Read after the wait: another watch may have opened meanwhile.
      if (full()) refuseFull();
      let subscriptions = byConnection.get(input.connection);
      const infos = options.source.sessions({ workspaceId: input.workspaceId, taskIds: tasks });
      const chosen = input.sessionId === undefined ? infos : infos.filter((info) => info.sessionId === input.sessionId);
      if (input.sessionId !== undefined && chosen.length === 0) {
        throw new TaviError("NOT_FOUND", `no browser session ${input.sessionId} in task ${input.taskId}'s tree`);
      }
      const subscriptionId = options.newSubscriptionId();
      // Throws on a closed connection, or one at its subscription limit.
      input.connection.createSubscription({
        subscriptionId,
        requestId: input.requestId,
        live: true,
        onDropped: () => {
          const subscription = byConnection.get(input.connection)?.get(subscriptionId);
          if (subscription !== undefined) end(subscription);
        },
      });
      if (subscriptions === undefined) {
        const created = new Map<string, Subscription>();
        subscriptions = created;
        byConnection.set(input.connection, created);
        input.connection.onClose(() => {
          for (const subscription of [...created.values()]) end(subscription);
          byConnection.delete(input.connection);
        });
      }
      const subscription: Subscription = {
        id: subscriptionId,
        connection: input.connection,
        workspaceId: input.workspaceId,
        tasks: new Set(tasks),
        agents,
        sessionId: input.sessionId,
        maxWidth: clampLiveWidth(input.maxWidth),
        seq: 0,
        unacked: new Set(),
        sessions: new Map(),
        retry: undefined,
        closed: false,
        inputTimes: [],
        lastInputSeq: undefined,
      };
      subscriptions.set(subscriptionId, subscription);
      // Its messages are held by the connection until this answer is written.
      for (const info of chosen) watchSession(subscription, info);
      return { subscriptionId, sessions: chosen.map((info) => labelled(subscription, info)) };
    },

    ack(connection, subscriptionId, seq) {
      const subscription = ownSubscription(connection, subscriptionId);
      if (!subscription.unacked.delete(seq)) return;
      flush(subscription);
      demand(subscription);
    },

    unwatch(connection, subscriptionId) {
      const subscription = ownSubscription(connection, subscriptionId);
      end(subscription);
      connection.dropSubscription(subscriptionId);
    },

    count: (connection) => byConnection.get(connection)?.size ?? 0,

    owns: (connection, subscriptionId) => byConnection.get(connection)?.has(subscriptionId) === true,

    async control(connection, payload, actor) {
      const subscription = ownSubscription(connection, payload.subscriptionId);
      const shown = subscription.sessions.has(payload.sessionId);
      const control = subscription.sessions.get(payload.sessionId)?.watch?.control;
      if (control === undefined) {
        throw shown
          ? new TaviError("CAPABILITY_MISSING", "this browser session cannot be taken over")
          : new TaviError("NOT_FOUND", `live watch ${payload.subscriptionId} does not show browser session ${payload.sessionId}`);
      }
      switch (payload.action) {
        case "take":
          return control.take({
            maxWidth: payload.maxWidth ?? subscription.maxWidth,
            ...(payload.viewport === undefined ? {} : { viewport: payload.viewport }),
          });
        case "input": {
          // Order and rate are checked before the source is asked: a refused batch reaches nothing.
          if (subscription.lastInputSeq !== undefined && payload.seq <= subscription.lastInputSeq) {
            throw new TaviError("CONFLICT", "an input batch arrived after a later one; it was not applied");
          }
          const at = now();
          while (subscription.inputTimes.length > 0 && at - (subscription.inputTimes[0] ?? at) >= 1000) subscription.inputTimes.shift();
          if (subscription.inputTimes.length >= BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND) {
            throw new TaviError("BUDGET_EXCEEDED", `at most ${BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND} input batches a second`);
          }
          subscription.inputTimes.push(at);
          subscription.lastInputSeq = payload.seq;
          return control.input(payload.events);
        }
        case "select":
          return control.select(payload.ref, payload.value);
        case "dialog":
          return control.dialog(payload.accept, payload.text);
        case "release":
          control.release(payload.outcome, payload.note, actor);
          return;
        case "decline":
          control.decline(payload.note, actor);
          return;
        case "upload":
          // The bytes pass through to the source, which holds them only until the page takes them.
          return control.upload({
            count: payload.count,
            index: payload.index,
            name: payload.name,
            type: payload.type,
            size: payload.size,
            offset: payload.offset,
            data: payload.data,
          });
        case "upload-cancel":
          return control.cancelUpload();
      }
    },

    close() {
      stopListening();
      for (const subscription of allSubscriptions()) end(subscription);
      byConnection.clear();
    },
  };
}
