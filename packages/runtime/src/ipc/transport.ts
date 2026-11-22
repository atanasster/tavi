import { createServer, createConnection, type Server, type Socket } from "node:net";

import {
  IPC_AUTH_DEADLINE_MS,
  IPC_MAX_CONNECTIONS,
  IPC_MAX_UNAUTHENTICATED_CONNECTIONS,
  IPC_COMMANDS,
  IPC_MAX_CONNECTION_BACKLOG_BYTES,
  IPC_MAX_FRAME_BYTES,
  IPC_MAX_RECONNECT_ATTEMPTS,
  IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES,
  IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  IPC_PROTOCOL_VERSION,
  IPC_RETRYABLE_CONNECT_CODES,
  FrameReader,
  IdSchema,
  TaviError,
  clampMessage,
  encodeFrame,
  protocolMismatchError,
  type BrowserLiveMessage,
  type ClientEvent,
  type IpcFrame,
  type TextRef,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { assertPipeOwnedHere, sleep } from "@tavi/node-kit";

import { tokenMatches } from "./credentials.js";

/**
 * The frame codec lives in `@tavi/contracts`.
 *
 * It is platform-neutral there (`Uint8Array`, no `Buffer`) so `@tavi/client` can
 * share it without a Node dependency; re-exported here because the runtime's
 * public surface and its tests import it from this module.
 */
export { FrameReader, clampMessage, encodeFrame };

/**
 * One authenticated connection, as a command handler sees it.
 *
 * A handler that answers `subscribe` registers a subscription here and pushes
 * events through it; the transport owns the framing, the backlog budget and the
 * teardown, so a handler cannot write to a dead socket or hold an unbounded
 * buffer of its own.
 */
export interface IpcConnection {
  /**
   * Register a subscription.
   *
   * `requestId` is the id of the request that created it, so a backlog drop is
   * reported against the request the client is still holding — the wire has no
   * separate "unsubscribed" frame, since subscriptions add only one new frame
   * type to the protocol. Its events are held until that request's response is written,
   * so they never precede the response that names the subscription; if the
   * response is a failure they are discarded with the subscription and
   * `onDropped("FAILED")` is called. `onDropped("BACKLOG")` reports a
   * subscription that fell behind its budget.
   *
   * Throws for an invalid or duplicate id, on a closed connection, and once the
   * connection holds `IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION` subscriptions.
   */
  readonly createSubscription: (input: {
    readonly subscriptionId: string;
    readonly requestId: string;
    readonly onDropped: (reason: string) => void;
    /**
     * A live browser-view subscription: it
     * carries `live` frames (`sendLive`), not events, and its bytes are left
     * out of the per-subscription backlog budget — the live hub bounds them
     * itself, by credit and by `backlogBytes`. The connection's ceiling still
     * applies.
     */
    readonly live?: boolean;
  }) => void;
  /** Stop delivering to a subscription; its caller has unsubscribed it. */
  readonly dropSubscription: (subscriptionId: string) => void;
  /**
   * Push one event. True when it was accepted — written, or held until the
   * subscription's creating response is out — whatever the socket's
   * back-pressure; false only when the subscription is unknown or dropped, or
   * the connection is closed. A caller may release its own state on false.
   */
  readonly sendEvent: (subscriptionId: string, event: ClientEvent) => boolean;
  /** Push one live browser-view message on a live subscription; false as for `sendEvent`. */
  readonly sendLive: (subscriptionId: string, seq: number, message: BrowserLiveMessage) => boolean;
  /** The bytes this connection holds for its peer now: unflushed and held. */
  readonly backlogBytes: () => number;
  readonly subscriptions: () => readonly string[];
  /**
   * Run `listener` once when the connection closes (immediately if it already
   * has). A handler that registered per-connection state — a bus subscription
   * feeding this connection — releases it here. Returns the deregistration.
   */
  readonly onClose: (listener: () => void) => () => void;
  /**
   * Resolves once this connection has flushed.
   *
   * Shutdown uses it so a client sees the final events of a run that finishes
   * inside the drain deadline, rather than having the socket destroyed under it.
   */
  readonly flushed: () => Promise<void>;
  /** Whether the client said in its `hello` that it is `tavi ui`'s bridge, forwarding a page's commands. */
  readonly viaBridge: () => boolean;
}

export interface IpcServerOptions {
  readonly endpoint: string;
  readonly sessionId: string;
  /** Expected bearer cookie; never logged. */
  readonly token: string;
  readonly onRequest: (request: {
    readonly command: string;
    readonly payload: unknown;
    /**
     * The id the client gave this request.
     *
     * Needed by a `subscribe` handler: a backlog drop is reported as a `response`
     * carrying this id, which is how the client correlates a late failure to the
     * subscription it created. That only works when a client never reuses an id
     * on one connection — `IpcClient.request` documents the rule and refuses a
     * pending duplicate.
     */
    readonly requestId: string;
    /** The authenticated connection this request arrived on. */
    readonly connection: IpcConnection;
  }) => Promise<{ readonly ok: boolean; readonly result?: unknown; readonly error?: IpcErrorBody }>;
  /** Per-subscription outbound budget. */
  readonly maxSubscriptionBacklogBytes?: number;
  /** Per-connection outbound ceiling across its subscriptions. */
  readonly maxConnectionBacklogBytes?: number;
  /** Subscriptions one connection may hold at once. */
  readonly maxSubscriptionsPerConnection?: number;
  readonly maxConnections?: number;
  /** Of `maxConnections`, how many may be waiting to authenticate at once. */
  readonly maxUnauthenticated?: number;
  readonly authDeadlineMs?: number;
  /**
   * Whether connections are taken yet. Until the endpoint's access is
   * confirmed (a socket's mode, a pipe's access list) this answers false, and
   * a connection accepted meanwhile is destroyed unread. Default: always.
   */
  readonly admitting?: () => boolean;
  /**
   * Command names this owner actually implements.
   *
   * Advertised in `ready.features`. Defaults to the whole contract, which is
   * correct for a server that implements everything it declares; an owner whose
   * contract has landed ahead of its implementation passes the narrower set, so
   * the handshake never advertises a command that would answer `UNSUPPORTED`.
   * Validated as a subset of `IPC_COMMANDS` at construction.
   */
  readonly features?: readonly string[];
  /** Called for diagnostics; must never receive the token. */
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface IpcServer {
  /** Resolves once the endpoint is accepting connections. */
  readonly listening: Promise<void>;
  readonly connectionCount: () => number;
  readonly authFailures: () => number;
  /**
   * Stop accepting new connections, leaving authenticated ones up.
   *
   * Shutdown needs the two separated: closing admission and the listener first
   * stops new work, while attached clients keep receiving the final events of
   * runs that finish inside the drain deadline.
   */
  closeListener(): Promise<void>;
  /** Wait for every connection's buffer to flush, or the deadline to pass. */
  drain(deadlineMs: number): Promise<void>;
  /** Destroy every connection. */
  close(): Promise<void>;
}

/**
 * A once-only "this connection ended" signal.
 *
 * Shared by the server's connection and the client, which both need the same
 * three properties: listeners run once, a listener added after the end runs at
 * once rather than never, and one listener that throws cannot stop the others.
 */
function createCloseSignal(onListenerError: (error: unknown) => void): {
  readonly onClose: (listener: () => void) => () => void;
  readonly fire: () => void;
  readonly fired: () => boolean;
} {
  const listeners = new Set<() => void>();
  let fired = false;
  return {
    onClose: (listener) => {
      if (fired) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire: () => {
      if (fired) return;
      fired = true;
      const pending = [...listeners];
      listeners.clear();
      for (const listener of pending) {
        try {
          listener();
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    fired: () => fired,
  };
}

/**
 * Authenticated local endpoint.
 *
 * A connection may send exactly one `hello` and nothing else until it is
 * authenticated. Unauthenticated connections are closed at the auth deadline, so
 * an idle peer cannot hold a slot, and the connection count is capped so a local
 * flood cannot exhaust the owner.
 */
export function createIpcServer(options: IpcServerOptions): IpcServer {
  const maxConnections = options.maxConnections ?? IPC_MAX_CONNECTIONS;
  const maxUnauthenticated = Math.min(options.maxUnauthenticated ?? IPC_MAX_UNAUTHENTICATED_CONNECTIONS, maxConnections);
  // A feature the contract does not declare could never be dispatched, so
  // advertising it would be a lie in the other direction; refused loudly here
  // rather than surfacing as an `UNSUPPORTED` at a client's first call.
  const known = new Set<string>(IPC_COMMANDS);
  const implementedFeatures: readonly string[] = options.features ?? IPC_COMMANDS;
  for (const feature of implementedFeatures) {
    if (!known.has(feature)) {
      throw new Error(`refusing to advertise ${JSON.stringify(feature)}: not a command in IPC_COMMANDS`);
    }
  }
  const authDeadlineMs = options.authDeadlineMs ?? IPC_AUTH_DEADLINE_MS;
  const backlogLimit = options.maxSubscriptionBacklogBytes ?? IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES;
  const connectionCeiling = options.maxConnectionBacklogBytes ?? IPC_MAX_CONNECTION_BACKLOG_BYTES;
  const subscriptionLimit = options.maxSubscriptionsPerConnection ?? IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION;
  // The ceiling must leave room for one subscription to reach its own budget
  // (plus the frame that crosses it), or the connection is closed before any
  // single subscription could be dropped — reversing per-subscription
  // isolation, where a stalled tab drops only itself.
  if (connectionCeiling < backlogLimit + IPC_MAX_FRAME_BYTES) {
    throw new Error(
      `the per-connection ceiling (${connectionCeiling}) must be at least the per-subscription budget ` +
        `plus one frame (${backlogLimit + IPC_MAX_FRAME_BYTES})`,
    );
  }
  const sockets = new Set<Socket>();
  // The sockets still waiting to authenticate.
  const waiting = new Set<Socket>();
  const connections = new Set<IpcConnection>();
  let authFailures = 0;

  /** Report a diagnostic; a sink that throws must never break the transport. */
  const diagnose = (message: string, fields?: Record<string, unknown>): void => {
    try {
      options.onDiagnostic?.(message, fields);
    } catch {
      // Contained: the diagnostic is lost, the connection is not.
    }
  };

  const server: Server = createServer((socket) => {
    if (options.admitting !== undefined && !options.admitting()) {
      diagnose("refusing connection: the endpoint's access is not confirmed yet");
      socket.destroy();
      return;
    }
    if (waiting.size >= maxUnauthenticated) {
      diagnose("refusing connection: too many connections are waiting to authenticate", { limit: maxUnauthenticated });
      socket.destroy();
      return;
    }
    if (sockets.size >= maxConnections) {
      diagnose("refusing connection: connection limit reached", { limit: maxConnections });
      socket.destroy();
      return;
    }
    sockets.add(socket);
    waiting.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      waiting.delete(socket);
      connections.delete(connection);
      clearTimeout(deadline);
    });
    socket.on("error", () => {
      sockets.delete(socket);
      waiting.delete(socket);
    });

    /**
     * One subscription's outbound state.
     *
     * Per **subscription**, not per connection: the web bridge multiplexes every
     * browser tab over one connection, so a shared budget would let one stalled
     * tab drop every tab's subscriptions.
     *
     * `inFlight` records where each of this subscription's frames ends in the
     * connection's byte stream, and a frame stops counting once the stream is
     * confirmed flushed past its end — so a response or a sibling's write in
     * between cannot take this subscription's credit (the previous accounting
     * credited drained bytes to whichever subscription wrote next). "Confirmed
     * flushed" is Node's `writableLength`, which moves a whole write request at a
     * time: after a stall Node sends everything queued as one `writev`, and all of
     * it counts as unflushed until the kernel has taken the last byte. The budget
     * therefore bounds bytes Node still holds for the peer, and can over-count
     * what the peer has read by up to one such batch — the conservative
     * direction, and the one that matches the memory the budget exists to bound.
     *
     * `held` is non-null until the response to the request that created the
     * subscription is written: a subscription's events never precede the response
     * that names it on the wire.
     */
    interface Subscription {
      readonly requestId: string;
      readonly live: boolean;
      readonly onDropped: (reason: string) => void;
      readonly inFlight: { end: number; bytes: number }[];
      held: Uint8Array[] | null;
      outstanding: number;
    }
    const subscriptions = new Map<string, Subscription>();
    /**
     * Subscriptions dropped while their creating response was unwritten; the
     * BACKLOG notice is written right after that response. Kept even if the
     * handler then calls `dropSubscription`: the notice is the only way the
     * client learns its subscription died.
     */
    const owedNotices = new Map<string, Subscription>();
    const closeSignal = createCloseSignal((error) => diagnose("a connection's close listener threw", { reason: errorMessage(error) }));
    let drainWaiters: (() => void)[] = [];
    /** Every byte handed to `socket.write` on this connection. */
    let written = 0;
    /** Bytes held for subscriptions whose creating response is unwritten. */
    let heldBytes = 0;

    const closed = (): boolean => closeSignal.fired() || socket.destroyed;

    /** Bytes the socket has flushed: everything written minus what Node still holds. */
    const flushedThrough = (): number => written - socket.writableLength;

    /** Forget frames the stream has flushed past, for every subscription. */
    const settle = (): void => {
      const flushed = flushedThrough();
      for (const subscription of subscriptions.values()) {
        while (subscription.inFlight.length > 0 && (subscription.inFlight[0]?.end ?? Infinity) <= flushed) {
          subscription.outstanding -= subscription.inFlight.shift()?.bytes ?? 0;
        }
      }
    };

    /** Close a connection over its ceiling; its client resubscribes from its cursors. */
    const enforceCeiling = (): boolean => {
      // Already closing: the diagnostic was reported once, and a destroyed
      // socket's buffer stays over the ceiling until Node releases it.
      if (socket.destroyed) return false;
      const backlog = socket.writableLength + heldBytes;
      if (backlog <= connectionCeiling) return true;
      diagnose("closing a connection whose outbound backlog exceeded its ceiling", { backlog, ceiling: connectionCeiling });
      socket.destroy();
      return false;
    };

    const encode = (frame: IpcFrame): Uint8Array | undefined => {
      try {
        return encodeFrame(frame);
      } catch (error) {
        diagnose("could not encode a frame", { reason: errorMessage(error) });
        return undefined;
      }
    };

    /** Hand bytes to the socket. Back-pressure is accounted, never an error. */
    const writeBytes = (bytes: Uint8Array): void => {
      if (socket.destroyed) return;
      socket.write(bytes);
      written += bytes.byteLength;
      settle();
    };

    /** Write a non-subscription frame. False only when it could not be encoded. */
    const writeFrame = (frame: IpcFrame): boolean => {
      const bytes = encode(frame);
      if (bytes === undefined) return false;
      writeBytes(bytes);
      enforceCeiling();
      return true;
    };

    const dropNotice = (subscription: Subscription): void => {
      writeFrame({
        type: "response",
        requestId: subscription.requestId,
        ok: false,
        error: {
          code: "BACKLOG",
          message: clampMessage("this subscription fell too far behind its outbound budget; re-subscribe from your last cursor"),
        },
      });
    };

    /** Tell a subscription's owner it is gone; its callback is contained. */
    const notifyDropped = (subscriptionId: string, subscription: Subscription, reason: string): void => {
      try {
        subscription.onDropped(reason);
      } catch (error) {
        diagnose("a subscription's onDropped callback threw", {
          subscriptionId,
          reason: errorMessage(error),
        });
      }
    };

    /** Release a subscription's held frames from the connection's held total. */
    const discardHeld = (subscription: Subscription): Uint8Array[] => {
      const held = subscription.held ?? [];
      subscription.held = null;
      for (const frame of held) {
        heldBytes -= frame.byteLength;
        subscription.outstanding -= frame.byteLength;
      }
      return held;
    };

    /** Drop a subscription over its budget, telling its client how to recover. */
    const dropForBacklog = (subscriptionId: string, subscription: Subscription): void => {
      diagnose("dropping a subscription that exceeded its backlog", {
        subscriptionId,
        outstanding: subscription.outstanding,
        limit: backlogLimit,
      });
      subscriptions.delete(subscriptionId);
      if (subscription.held !== null) {
        // Its creating response is not written yet; the notice must follow it,
        // or the client sees a failure for a request it is still waiting on.
        discardHeld(subscription);
        owedNotices.set(subscriptionId, subscription);
        notifyDropped(subscriptionId, subscription, "BACKLOG");
        return;
      }
      notifyDropped(subscriptionId, subscription, "BACKLOG");
      dropNotice(subscription);
    };

    /**
     * Write (or hold) one subscription frame, charging it to the subscription.
     * False when the subscription was dropped for it (the frame is not
     * delivered).
     */
    const writeSubscriptionFrame = (subscriptionId: string, subscription: Subscription, bytes: Uint8Array): boolean => {
      subscription.outstanding += bytes.byteLength;
      if (subscription.held !== null) {
        subscription.held.push(bytes);
        heldBytes += bytes.byteLength;
      } else {
        writeBytes(bytes);
        subscription.inFlight.push({ end: written, bytes: bytes.byteLength });
        settle();
      }
      if (!subscription.live && subscription.outstanding > backlogLimit) {
        dropForBacklog(subscriptionId, subscription);
        return false;
      }
      return enforceCeiling();
    };

    /**
     * The creating request has been answered: release or discard what was held.
     *
     * On success the held frames follow the response, in order, then any drop
     * notice owed. On failure the subscriptions it created are discarded — the
     * client holds no id to address them by — and their owners are told, so a
     * handler whose `ok` result could not be encoded does not keep feeding a
     * subscription nobody can receive.
     */
    const answered = (requestId: string, ok: boolean): void => {
      for (const [subscriptionId, subscription] of [...subscriptions.entries()]) {
        if (subscription.requestId !== requestId || subscription.held === null) continue;
        const held = discardHeld(subscription);
        if (!ok) {
          subscriptions.delete(subscriptionId);
          notifyDropped(subscriptionId, subscription, "FAILED");
          continue;
        }
        for (const frame of held) {
          if (!writeSubscriptionFrame(subscriptionId, subscription, frame)) break;
        }
      }
      for (const [subscriptionId, subscription] of [...owedNotices.entries()]) {
        if (subscription.requestId !== requestId) continue;
        owedNotices.delete(subscriptionId);
        if (ok) dropNotice(subscription);
      }
    };

    const releaseDrainWaiters = (): void => {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    };

    /** Resolve a waiter and stop tracking it. */
    const release = (resolve: () => void): void => {
      const index = drainWaiters.indexOf(resolve);
      if (index !== -1) drainWaiters.splice(index, 1);
      resolve();
    };

    socket.on("close", () => {
      releaseDrainWaiters();
      // Nothing is delivered to a closed connection, so a subscription left
      // registered here would only keep its producer's closures alive.
      subscriptions.clear();
      owedNotices.clear();
      heldBytes = 0;
      closeSignal.fire();
    });
    socket.on("error", releaseDrainWaiters);

    socket.on("drain", () => {
      settle();
      releaseDrainWaiters();
    });

    let authenticated = false;
    let viaBridge = false;
    const deadline: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (!authenticated) {
        diagnose("closing unauthenticated connection at the auth deadline");
        socket.destroy();
      }
    }, authDeadlineMs);
    deadline.unref?.();

    const connection: IpcConnection = {
      viaBridge: () => viaBridge,
      createSubscription: ({ subscriptionId, requestId, onDropped, live = false }) => {
        // A handler that awaited across a disconnect would otherwise register
        // into a map the close already cleared, and it would never be released.
        if (closed()) {
          throw new TaviError("UNAVAILABLE", "this connection is closed");
        }
        // The id travels in every event frame; one the frame schema refuses would
        // make every frame for it fail to encode, silently.
        if (!IdSchema.safeParse(subscriptionId).success) {
          throw new TaviError("INVALID_INPUT", "a subscription id must be a valid id");
        }
        if (subscriptions.has(subscriptionId)) {
          throw new TaviError("CONFLICT", `subscription ${subscriptionId} already exists on this connection`);
        }
        if (subscriptions.size >= subscriptionLimit) {
          throw new TaviError("BUDGET_EXCEEDED", `this connection already holds ${subscriptionLimit} subscriptions; unsubscribe one first`);
        }
        subscriptions.set(subscriptionId, { requestId, live, onDropped, inFlight: [], held: [], outstanding: 0 });
      },
      dropSubscription: (subscriptionId) => {
        const subscription = subscriptions.get(subscriptionId);
        if (subscription === undefined) return;
        subscriptions.delete(subscriptionId);
        discardHeld(subscription);
        // An owed BACKLOG notice stays owed: it is settled by `answered()` or by
        // close, and it is the client's only news that the subscription died.
      },
      sendEvent: (subscriptionId, event) => {
        const subscription = subscriptions.get(subscriptionId);
        if (subscription === undefined || subscription.live || closed()) return false;
        const bytes = encode({ type: "event", subscriptionId, event });
        if (bytes === undefined) return false;
        return writeSubscriptionFrame(subscriptionId, subscription, bytes);
      },
      sendLive: (subscriptionId, seq, message) => {
        const subscription = subscriptions.get(subscriptionId);
        if (subscription === undefined || !subscription.live || closed()) return false;
        const bytes = encode({ type: "live", subscriptionId, seq, message });
        if (bytes === undefined) return false;
        return writeSubscriptionFrame(subscriptionId, subscription, bytes);
      },
      backlogBytes: () => (socket.destroyed ? 0 : socket.writableLength + heldBytes),
      subscriptions: () => [...subscriptions.keys()],
      onClose: (listener) => closeSignal.onClose(listener),
      flushed: () =>
        new Promise<void>((resolve) => {
          // Resolved by observing the buffer, not by waiting for `'drain'`:
          // `'drain'` is emitted only after a `write` returned false, so a
          // connection whose writes were all accepted never emits it and a
          // parked waiter would sit until the caller's deadline — which is how
          // the first version of this passed its test by timing out rather than
          // by flushing. Held frames count too: they are owed to the client once
          // their request is answered, so a drain that ignored them would end
          // before the events it exists to deliver.
          const settleWaiter = (): void => {
            if ((socket.writableLength === 0 && heldBytes === 0) || socket.destroyed) {
              clearInterval(poll);
              release(resolve);
            }
          };
          const poll = setInterval(settleWaiter, 5);
          poll.unref?.();
          drainWaiters.push(resolve);
          settleWaiter();
        }),
    };

    connections.add(connection);

    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => {
      const { frames, error } = reader.push(chunk);
      if (error !== undefined) {
        diagnose("refusing malformed frame", { reason: error });
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === "hello") {
          if (authenticated) {
            socket.destroy();
            return;
          }
          if (frame.protocolVersion !== IPC_PROTOCOL_VERSION) {
            authFailures += 1;
            diagnose("refusing a protocol version mismatch", {
              client: frame.protocolVersion,
              owner: IPC_PROTOCOL_VERSION,
            });
            socket.destroy();
            return;
          }
          // Constant-time comparison of the bearer cookie.
          if (!tokenMatches(options.token, frame.token) || frame.sessionId !== options.sessionId) {
            authFailures += 1;
            // The reason is deliberately not disclosed: a wrong token and a wrong
            // session are the same answer to a caller that is not the owner.
            diagnose("refusing an unauthenticated client");
            socket.destroy();
            return;
          }
          authenticated = true;
          waiting.delete(socket);
          viaBridge = frame.client === "bridge";
          clearTimeout(deadline);
          writeFrame({
            type: "ready",
            protocolVersion: IPC_PROTOCOL_VERSION,
            sessionId: options.sessionId,
            // Taken from the contract rather than retyped, so the handshake
            // cannot advertise a command set the owner does not implement.
            features: [...implementedFeatures],
          });
          continue;
        }

        if (!authenticated) {
          // Every command is rejected until the connection is authenticated.
          socket.destroy();
          return;
        }
        if (frame.type !== "request") continue;

        const respond = (response: { readonly ok: boolean; readonly result?: unknown; readonly error?: IpcErrorBody }): void => {
          // A handler result that cannot be encoded (an oversized or
          // non-serializable value) must still answer: a request left unanswered
          // hangs the caller until its timeout. Only an encoding failure takes
          // this path — back-pressure is not a failure, and treating it as one
          // sent a second, false `INTERNAL` response after a successful one.
          const encoded = writeFrame({
            type: "response",
            requestId: frame.requestId,
            ok: response.ok,
            ...(response.result === undefined ? {} : { result: response.result }),
            ...(response.error === undefined
              ? {}
              : {
                  error: {
                    code: response.error.code,
                    message: clampMessage(response.error.message),
                    // Facts beside the code (`settled` on a late decision); a
                    // result too large to frame still answers, as below.
                    ...(response.error.details === undefined ? {} : { details: response.error.details }),
                    ...(response.error.i18n === undefined ? {} : { i18n: response.error.i18n }),
                  },
                }),
          });
          if (!encoded) {
            writeFrame({
              type: "response",
              requestId: frame.requestId,
              ok: false,
              error: { code: "INTERNAL", message: clampMessage("the handler's result could not be encoded as a frame") },
            });
          }
          // The response is out; nothing after this point may answer again.
          try {
            answered(frame.requestId, encoded && response.ok);
          } catch (error) {
            diagnose("releasing a request's held subscriptions failed", {
              requestId: frame.requestId,
              reason: errorMessage(error),
            });
          }
        };

        void options
          .onRequest({ command: frame.command, payload: frame.payload, requestId: frame.requestId, connection })
          .then(respond, (error: unknown) => {
            // A handler failure must not escape as an unhandled rejection: the
            // owner process would die. The message is clamped to the contract.
            // A second argument to `then`, not a `catch`: a throw from `respond`
            // itself must never produce a second response for the same request.
            respond({
              ok: false,
              error: { code: "INTERNAL", message: errorMessage(error) },
            });
          })
          .catch((error: unknown) => {
            diagnose("answering a request failed", {
              requestId: frame.requestId,
              reason: errorMessage(error),
            });
          });
      }
    });
  });

  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => resolve());
  });

  let listeningClosed = false;
  return {
    listening,
    connectionCount: () => sockets.size,
    authFailures: () => authFailures,
    async closeListener(): Promise<void> {
      if (listeningClosed) return;
      listeningClosed = true;
      // `server.close(cb)`'s callback fires only once every connection has ended,
      // which is *not* what "stop accepting new connections" means — awaiting it
      // would hang shutdown before `drain` is ever reached, and the drain exists
      // precisely so those connections can finish. The listening handle is
      // released immediately, so `server.listening` is the signal to wait for.
      server.close();
      while (server.listening) {
        await sleep(5);
      }
    },
    async drain(deadlineMs: number): Promise<void> {
      // Waited for, not slept through: each connection resolves when its socket
      // buffer empties, so a drain finishes as soon as the last frame is out.
      const flushes = [...connections.values()].map((connection) => connection.flushed());
      if (flushes.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.all(flushes).then(() => undefined), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface IpcClientOptions {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly token: string;
  /**
   * The protocol version the owner advertised in its discovery record.
   *
   * Compared **before** connecting, so a version mismatch produces the
   * documented remedy ("the running `tavi serve` speaks protocol 1; this CLI
   * speaks 2 — restart the service") instead of the handshake's deliberately
   * uninformative "closed before authentication". Optional because a caller that
   * has no discovery record still gets the handshake's own check.
   */
  readonly protocolVersion?: number;
  readonly timeoutMs?: number;
  /** Total connection attempts, including the first. Bounded by the contract. */
  readonly maxAttempts?: number;
  /** Delay between connection attempts. */
  readonly retryDelayMs?: number;
}

/** A server-initiated frame the client could not correlate to a request. */
interface IpcClientFrame {
  readonly subscriptionId: string;
  readonly event: ClientEvent;
}

/** A live browser-view message, as `IpcClient.onLive` delivers it. */
export interface IpcClientLiveFrame {
  readonly subscriptionId: string;
  readonly seq: number;
  readonly message: BrowserLiveMessage;
}

/** A request's answer, as the client sees it. */
export interface IpcClientResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: IpcErrorBody;
}

/** A refusal: its code, its message, and the facts some commands add (`IpcResponseSchema`). */
interface IpcErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  /** `message` by key, for a client that says it in the workspace's language (`IpcResponseSchema`). */
  readonly i18n?: TextRef | undefined;
}

export interface IpcClientRequestOptions {
  /** This request's own timeout; the connection's `timeoutMs` otherwise. */
  readonly timeoutMs?: number;
  /**
   * Called with the response synchronously, as the frame is read — before any
   * frame after it is dispatched.
   *
   * The promise resolves a microtask later, and the owner writes a
   * subscription's held events immediately after the response that creates it,
   * usually in the same chunk: a caller that registers an event listener after
   * `await request(...)` has already missed them. Registering it here, from the
   * id the response carries, sees every one.
   */
  readonly onResponse?: (response: IpcClientResponse) => void;
}

export interface IpcClient {
  /**
   * Send one request.
   *
   * `requestId` must be unique among every request this connection sends, not
   * only the pending ones: the owner reports a subscription's later BACKLOG drop
   * as a second response under the id of the request that created it, and
   * releases a subscription's held events on the response carrying that id. An
   * id that is still pending is refused here.
   */
  request(command: string, payload: unknown, requestId: string, options?: IpcClientRequestOptions): Promise<IpcClientResponse>;
  /**
   * Commands the owner advertised in its `ready` frame.
   *
   * A subset of `IPC_COMMANDS`, because the contract may declare a command
   * before the owner implements it. A client offers an affordance only for a
   * command listed here, so it never presents a control whose call would answer
   * `UNSUPPORTED`.
   */
  readonly features: readonly string[];
  /**
   * Observe pushed events.
   *
   * Returns the unsubscribe. Listeners are called synchronously in frame order,
   * so a reducer that appends what it receives cannot observe a reordering.
   * A subscription's first events can reach listeners before the promise of the
   * request that created it resolves; register from `onResponse` to see them.
   */
  onEvent(listener: (frame: IpcClientFrame) => void): () => void;
  /** Live browser-view messages, on the subscriptions `browser-live watch` opened. */
  onLive(listener: (frame: IpcClientLiveFrame) => void): () => void;
  /**
   * Observe `response` frames that matched no pending request.
   *
   * A backlog drop arrives this way: it is reported against the `subscribe`
   * request that created the subscription, which has long since resolved, so
   * there is no pending promise left to settle and no separate frame type for it.
   */
  onOrphanResponse(
    listener: (response: { readonly requestId: string; readonly code: string; readonly message: string }) => void,
  ): () => void;
  /**
   * Run `listener` once when the connection ends, whoever ended it (immediately
   * if it already has). An attached command uses it to learn that its owner
   * stopped rather than waiting on a stream that will never continue.
   */
  onClose(listener: () => void): () => void;
  close(): void;
}

/**
 * Connect, authenticate, and issue bounded requests.
 *
 * Only the connection and authentication phase is retried, and only for errors
 * that a later attempt could plausibly fix (the endpoint is not there yet, the
 * owner is still binding, a transient `EAGAIN`). A request is never resent: a
 * non-idempotent command that may already have run is not replayed, which is why
 * the retry loop wraps the handshake alone.
 */
export async function createIpcClient(options: IpcClientOptions): Promise<IpcClient> {
  // Before any connection attempt: a mismatch is not a transport fault, so
  // retrying it would only present the cookie to an owner that will refuse it.
  if (options.protocolVersion !== undefined && options.protocolVersion !== IPC_PROTOCOL_VERSION) {
    // Typed, and marked, so a caller can report the remedy as it is rather than
    // folding it into a generic "the owner did not answer": the owner is healthy,
    // it is only the wrong version.
    throw protocolMismatchError(options.protocolVersion);
  }
  const requested = options.maxAttempts ?? IPC_MAX_RECONNECT_ATTEMPTS;
  const maxAttempts = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), IPC_MAX_RECONNECT_ATTEMPTS)
    : IPC_MAX_RECONNECT_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? 50;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptIpcConnection(options);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableConnectError(error)) throw error;
      // Deliberately ref'd: an unref'd delay lets the process exit during the
      // retry window, which would turn a bounded retry into exit code 13.
      await sleep(retryDelayMs);
    }
  }
}

/**
 * Errors worth another attempt, all of the "the endpoint is not there yet" kind:
 * missing socket, refused connection, or a transient resource shortage.
 *
 * Two failures are deliberately **not** retried. An authentication refusal will
 * be refused again, and repeating it only looks like a brute-force attempt to the
 * owner. A handshake timeout is not retried either: the cookie would be presented
 * again, and `maxAttempts × timeoutMs` would silently become the command's real
 * deadline instead of the documented per-attempt one.
 */
function isRetryableConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && IPC_RETRYABLE_CONNECT_CODES.includes(code);
}

function attemptIpcConnection(options: IpcClientOptions): Promise<IpcClient> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise<IpcClient>((resolve, reject) => {
    // On Windows: a pipe another account bound under this name is refused before the cookie is sent.
    assertPipeOwnedHere(options.endpoint);
    const socket = createConnection(options.endpoint);
    const reader = new FrameReader();
    // Hoisted to the connection scope: the frame dispatcher runs in the same data
    // handler as the handshake, outside the `ready` branch's block.
    const eventListeners = new Set<(frame: IpcClientFrame) => void>();
    const liveListeners = new Set<(frame: IpcClientLiveFrame) => void>();
    const orphanListeners = new Set<(response: { requestId: string; code: string; message: string }) => void>();
    const pending = new Map<
      string,
      { readonly settle: (value: IpcClientResponse) => void; readonly onResponse?: (value: IpcClientResponse) => void }
    >();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC connection to ${options.endpoint} timed out`));
    }, timeoutMs);

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    let ready = false;
    // A broken listener must not stop the others from learning of the close.
    const closeSignal = createCloseSignal(() => {});
    const disconnected: IpcClientResponse = { ok: false, error: { code: "DISCONNECTED", message: "IPC connection closed" } };
    socket.once("close", () => {
      clearTimeout(timer);
      // A disconnect must fail every in-flight request; leaving them pending
      // would hang a caller until its timeout, or forever.
      for (const entry of pending.values()) entry.settle(disconnected);
      pending.clear();
      if (!ready) {
        reject(new Error(`IPC connection to ${options.endpoint} closed before authentication`));
      }
      closeSignal.fire();
    });

    socket.on("data", (chunk: Buffer) => {
      const { frames, error } = reader.push(chunk);
      if (error !== undefined) {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === "ready") {
          // The contract echoes the session so a client can tell that it reached
          // the endpoint its discovery record named, not another listener that
          // happens to speak the protocol.
          if (frame.sessionId !== options.sessionId) {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(`IPC endpoint ${options.endpoint} answered for session ${frame.sessionId}, ` + `not ${options.sessionId}`));
            return;
          }
          if (frame.protocolVersion !== IPC_PROTOCOL_VERSION) {
            clearTimeout(timer);
            socket.destroy();
            // The discovery record disagreed with the owner it described; the
            // remedy is the same as the pre-connect check's, so is the error.
            reject(protocolMismatchError(frame.protocolVersion));
            return;
          }
          clearTimeout(timer);
          ready = true;
          resolve({
            features: [...frame.features],
            onEvent: (listener) => {
              eventListeners.add(listener);
              return () => {
                eventListeners.delete(listener);
              };
            },
            onLive: (listener) => {
              liveListeners.add(listener);
              return () => {
                liveListeners.delete(listener);
              };
            },
            onOrphanResponse: (listener) => {
              orphanListeners.add(listener);
              return () => {
                orphanListeners.delete(listener);
              };
            },
            request: (command, payload, requestId, requestOptions) =>
              new Promise((resolveRequest, rejectRequest) => {
                // Answered at once on a closed connection: nothing can reply, and
                // waiting out the timeout only delays the caller's own recovery.
                if (closeSignal.fired() || socket.destroyed) {
                  requestOptions?.onResponse?.(disconnected);
                  resolveRequest(disconnected);
                  return;
                }
                if (pending.has(requestId)) {
                  rejectRequest(new Error(`IPC request id ${requestId} is already pending on this connection`));
                  return;
                }
                const requestTimer = setTimeout(() => {
                  pending.delete(requestId);
                  rejectRequest(new Error(`IPC request ${command} timed out`));
                }, requestOptions?.timeoutMs ?? timeoutMs);
                pending.set(requestId, {
                  settle: (value) => {
                    clearTimeout(requestTimer);
                    resolveRequest(value);
                  },
                  ...(requestOptions?.onResponse === undefined ? {} : { onResponse: requestOptions.onResponse }),
                });
                socket.write(encodeFrame({ type: "request", requestId, command, payload }));
              }),
            onClose: (listener) => closeSignal.onClose(listener),
            close: () => {
              // A listener that never unsubscribed must not outlive the
              // connection: a bridge holds one client for the process's life.
              // Close listeners still run: they are how a holder learns of it.
              eventListeners.clear();
              liveListeners.clear();
              orphanListeners.clear();
              socket.destroy();
            },
          });
          continue;
        }
        if (frame.type === "event") {
          // Forwarded to every listener; a listener that throws must not stop the
          // others or kill the socket read loop.
          for (const listener of [...eventListeners]) {
            try {
              listener({ subscriptionId: frame.subscriptionId, event: frame.event });
            } catch {
              // A broken consumer is its own problem; the stream continues.
            }
          }
          continue;
        }
        if (frame.type === "live") {
          for (const listener of [...liveListeners]) {
            try {
              listener({ subscriptionId: frame.subscriptionId, seq: frame.seq, message: frame.message });
            } catch {
              // As for events: one broken consumer does not stop the stream.
            }
          }
          continue;
        }
        if (frame.type === "response") {
          const entry = pending.get(frame.requestId);
          if (entry !== undefined) {
            pending.delete(frame.requestId);
            const response: IpcClientResponse = {
              ok: frame.ok,
              ...(frame.result === undefined ? {} : { result: frame.result }),
              ...(frame.error === undefined ? {} : { error: frame.error }),
            };
            // Synchronously, before the next frame in this chunk is dispatched:
            // that is where a caller registers for the events that follow.
            try {
              entry.onResponse?.(response);
            } catch {
              // A broken hook must not stop the read loop or the promise.
            }
            entry.settle(response);
            continue;
          }
          // No pending request: a backlog drop is reported against the
          // `subscribe` request that created the subscription, which has already
          // resolved.
          if (frame.error !== undefined) {
            for (const listener of [...orphanListeners]) {
              try {
                listener({ requestId: frame.requestId, code: frame.error.code, message: frame.error.message });
              } catch {
                // As above.
              }
            }
          }
        }
      }
    });

    socket.write(
      encodeFrame({
        type: "hello",
        protocolVersion: IPC_PROTOCOL_VERSION,
        token: options.token,
        sessionId: options.sessionId,
      }),
    );
  });
}
