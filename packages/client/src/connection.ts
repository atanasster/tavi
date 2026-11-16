import {
  IPC_PROTOCOL_VERSION,
  TaviError,
  protocolMismatchError,
  type BrowserLiveMessage,
  type ClientEvent,
  type IpcFrame,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { Scheduler } from "./scheduler.js";
import { contain, type FrameTransport } from "./transport.js";

/** What an owner's discovery record and cookie say about it, for the handshake. */
export interface OwnerCredentials {
  /** Echoed by the owner's `ready`, so a client can tell it reached this owner. */
  readonly sessionId: string;
  readonly token: string;
}

/** A request's answer, as a client sees it. */
export interface ClientResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  /** `details` carries facts some refusals add, such as `settled` on a decision that came too late. */
  readonly error?: { readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> | undefined };
}

/** An event the owner pushed on one of this connection's subscriptions. */
export interface SubscriptionEvent {
  readonly subscriptionId: string;
  readonly event: ClientEvent;
}

/** A live browser-view message on one of this connection's `browser-live` watches. */
export interface LiveFrame {
  readonly subscriptionId: string;
  readonly seq: number;
  readonly message: BrowserLiveMessage;
}

/** An error `response` that matched no pending request: a subscription's BACKLOG drop. */
export interface OrphanResponse {
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

/** The answer to a request the connection ended under before the owner replied. */
export const CLIENT_DISCONNECTED = "DISCONNECTED";
/** The answer to a request the owner did not reply to within its deadline. */
export const CLIENT_TIMEOUT = "TIMEOUT";

/** The default per-request deadline: a read answers well inside it. */
export const REQUEST_TIMEOUT_MS = 5_000;
/** The handshake's deadline; the owner closes an unauthenticated peer at its own. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Timed-out requests whose late answer is still passed to `onResponse`. An
 * answer that creates a subscription is the owner's commitment to stream to
 * it, so the caller must see it to release it; beyond this many, the oldest are
 * forgotten.
 */
const LATE_ANSWERS_KEPT = 64;

export interface RequestOptions {
  /** This request's deadline; `REQUEST_TIMEOUT_MS` otherwise. */
  readonly timeoutMs?: number;
  /**
   * Called with the answer synchronously, as its frame is read — before any
   * frame after it is dispatched. The owner writes a new subscription's held
   * events straight after the response that creates it, usually in the same
   * chunk, so this is where a caller learns the subscription's id in time to
   * route them. A request that timed out still has its late answer passed
   * here (its promise has already resolved with `CLIENT_TIMEOUT`).
   */
  readonly onResponse?: (response: ClientResponse) => void;
}

/** One authenticated connection to an owner. */
export interface Connection {
  /** The owner session the handshake confirmed; every event's `epoch` in this connection. */
  readonly sessionId: string;
  /**
   * The commands the owner implements (its `ready.features`): a subset of
   * `IPC_COMMANDS`. Offer an affordance only for a command listed here.
   */
  readonly features: readonly string[];
  /**
   * Send one request. It always resolves: with the owner's answer, or with
   * `CLIENT_DISCONNECTED` or `CLIENT_TIMEOUT` when there is none. `requestId`
   * must be unique across the connection's life, not only among pending
   * requests — the owner reports a subscription's BACKLOG drop under the id of
   * the request that created it — so an id already pending is refused.
   */
  request(command: string, payload: unknown, requestId: string, options?: RequestOptions): Promise<ClientResponse>;
  /** Observe pushed events, synchronously in frame order. Returns the unsubscribe. */
  onEvent(listener: (event: SubscriptionEvent) => void): () => void;
  /** Observe live browser-view messages, synchronously in frame order. Returns the unsubscribe. */
  onLive(listener: (frame: LiveFrame) => void): () => void;
  /** Observe error responses that matched no pending request. Returns the unsubscribe. */
  onOrphanResponse(listener: (response: OrphanResponse) => void): () => void;
  /**
   * Called once when the connection ends, whoever ended it; immediately if it
   * has. `fault` is set only when this client ended it for what the owner
   * sent — see `ConnectionFault` — and absent for a socket that closed or a
   * deliberate `close()`.
   */
  onClose(listener: (fault?: ConnectionFault) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Why this client ended an authenticated connection: bytes its codec refused
 * (`unreadable` — the owner may be another build) or a frame out of the
 * protocol's order (`protocol` — a broken owner). Either would recur on a
 * reconnect.
 */
export interface ConnectionFault {
  readonly kind: "unreadable" | "protocol";
  readonly detail: string;
}

export interface ConnectionOptions {
  readonly scheduler: Scheduler;
  /** The handshake's deadline; `HANDSHAKE_TIMEOUT_MS` otherwise. */
  readonly handshakeTimeoutMs?: number;
  /** Said in the `hello` by `tavi ui`'s bridge: it forwards a page's commands. */
  readonly client?: "bridge";
}

/** Why a handshake failed, for a caller that decides whether another attempt could help. */
export type HandshakeFailure = "timeout" | "closed" | "session" | "protocol";

/** The reason a handshake failure carries in its `details`. */
export function handshakeFailure(error: unknown): HandshakeFailure | undefined {
  if (!(error instanceof TaviError)) return undefined;
  const failure = error.details?.["handshake"];
  return failure === "timeout" || failure === "closed" || failure === "session" || failure === "protocol" ? failure : undefined;
}

/**
 * Authenticate over `transport` and return the connection.
 *
 * Sends `hello`, then waits for `ready`: its echoed session must be the one
 * `credentials` named — another listener at the endpoint is refused — and its
 * protocol this client's, or the typed protocol mismatch is raised with the
 * documented remedy. The owner never says why it refused a peer, so a refusal
 * is only "closed before authentication". Any failure closes the transport.
 */
export function openConnection(transport: FrameTransport, credentials: OwnerCredentials, options: ConnectionOptions): Promise<Connection> {
  const { scheduler } = options;
  return new Promise<Connection>((resolve, reject) => {
    let settled = false;
    // Assigned below; a no-op until then, because a transport that is already
    // closed reports so while its listener is still being registered.
    let cancelDeadline = (): void => undefined;
    let stopFrames = (): void => undefined;
    let stopClose = (): void => undefined;
    const fail = (error: TaviError): void => {
      if (settled) return;
      settled = true;
      cancelDeadline();
      stopFrames();
      stopClose();
      transport.close();
      reject(error);
    };
    cancelDeadline = scheduler.delay(options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS, () =>
      fail(new TaviError("UNAVAILABLE", "the owner did not complete the IPC handshake in time", { details: { handshake: "timeout" } })),
    );
    stopClose = transport.onClose(() =>
      fail(new TaviError("UNAVAILABLE", "the IPC connection closed before authentication", { details: { handshake: "closed" } })),
    );
    stopFrames = transport.onFrame((frame) => {
      if (settled) return;
      if (frame.type !== "ready") {
        fail(new TaviError("UNAVAILABLE", `the owner sent ${frame.type} before ready`, { details: { handshake: "closed" } }));
        return;
      }
      if (frame.sessionId !== credentials.sessionId) {
        fail(
          new TaviError("UNAVAILABLE", `the IPC endpoint answered for session ${frame.sessionId}, not ${credentials.sessionId}`, {
            details: { handshake: "session" },
          }),
        );
        return;
      }
      if (frame.protocolVersion !== IPC_PROTOCOL_VERSION) {
        const mismatch = protocolMismatchError(frame.protocolVersion);
        fail(new TaviError(mismatch.code, mismatch.message, { details: { ...mismatch.details, handshake: "protocol" } }));
        return;
      }
      settled = true;
      cancelDeadline();
      stopFrames();
      stopClose();
      resolve(authenticated(transport, frame.sessionId, frame.features, scheduler));
    });
    if (settled) return;
    transport.send({
      type: "hello",
      protocolVersion: IPC_PROTOCOL_VERSION,
      token: credentials.token,
      sessionId: credentials.sessionId,
      ...(options.client === undefined ? {} : { client: options.client }),
    });
  });
}

function authenticated(transport: FrameTransport, sessionId: string, features: readonly string[], scheduler: Scheduler): Connection {
  const pending = new Map<
    string,
    { readonly settle: (response: ClientResponse) => void; readonly onResponse?: (response: ClientResponse) => void }
  >();
  /** Set when this client closed the connection for a frame out of the protocol's order. */
  let outOfOrder: string | undefined;
  /** Timed-out requests' `onResponse`, oldest first, for an answer that arrives after all. */
  const late = new Map<string, (response: ClientResponse) => void>();
  const eventListeners = new Set<(event: SubscriptionEvent) => void>();
  const liveListeners = new Set<(frame: LiveFrame) => void>();
  const orphanListeners = new Set<(response: OrphanResponse) => void>();
  const disconnected: ClientResponse = {
    ok: false,
    error: { code: CLIENT_DISCONNECTED, message: "the IPC connection closed before the owner answered" },
  };

  transport.onFrame((frame: IpcFrame) => {
    if (frame.type === "event") {
      const event: SubscriptionEvent = { subscriptionId: frame.subscriptionId, event: frame.event };
      for (const listener of [...eventListeners]) contain(() => listener(event));
      return;
    }
    if (frame.type === "live") {
      const live: LiveFrame = { subscriptionId: frame.subscriptionId, seq: frame.seq, message: frame.message };
      for (const listener of [...liveListeners]) contain(() => listener(live));
      return;
    }
    if (frame.type !== "response") {
      // `hello`/`ready`/`request` from an authenticated owner break the protocol.
      outOfOrder = `the owner sent ${frame.type} after ready`;
      transport.close(outOfOrder);
      return;
    }
    const response: ClientResponse = {
      ok: frame.ok,
      ...(frame.result === undefined ? {} : { result: frame.result }),
      ...(frame.error === undefined ? {} : { error: frame.error }),
    };
    const entry = pending.get(frame.requestId);
    if (entry !== undefined) {
      pending.delete(frame.requestId);
      // Before the next frame in this chunk: see `RequestOptions.onResponse`.
      if (entry.onResponse !== undefined) contain(() => entry.onResponse?.(response));
      entry.settle(response);
      return;
    }
    const tardy = late.get(frame.requestId);
    if (tardy !== undefined) {
      late.delete(frame.requestId);
      contain(() => tardy(response));
      return;
    }
    if (frame.error !== undefined) {
      const orphan: OrphanResponse = { requestId: frame.requestId, code: frame.error.code, message: frame.error.message };
      for (const listener of [...orphanListeners]) contain(() => listener(orphan));
    }
  });
  transport.onClose(() => {
    // Every request still waiting learns now, not at its deadline.
    late.clear();
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) {
      if (entry.onResponse !== undefined) contain(() => entry.onResponse?.(disconnected));
      entry.settle(disconnected);
    }
    eventListeners.clear();
    liveListeners.clear();
    orphanListeners.clear();
  });

  return {
    sessionId,
    features: [...features],
    request(command, payload, requestId, requestOptions) {
      if (transport.closed) {
        if (requestOptions?.onResponse !== undefined) contain(() => requestOptions.onResponse?.(disconnected));
        return Promise.resolve(disconnected);
      }
      if (pending.has(requestId)) {
        return Promise.reject(new TaviError("INVALID_INPUT", `IPC request id ${requestId} is already pending on this connection`));
      }
      return new Promise<ClientResponse>((resolve) => {
        const timeoutMs = requestOptions?.timeoutMs ?? REQUEST_TIMEOUT_MS;
        const cancel = scheduler.delay(timeoutMs, () => {
          pending.delete(requestId);
          if (requestOptions?.onResponse !== undefined) {
            late.set(requestId, requestOptions.onResponse);
            if (late.size > LATE_ANSWERS_KEPT) late.delete(late.keys().next().value ?? requestId);
          }
          resolve({ ok: false, error: { code: CLIENT_TIMEOUT, message: `the owner did not answer ${command} within ${timeoutMs} ms` } });
        });
        pending.set(requestId, {
          settle: (response) => {
            cancel();
            resolve(response);
          },
          ...(requestOptions?.onResponse === undefined ? {} : { onResponse: requestOptions.onResponse }),
        });
        try {
          transport.send({ type: "request", requestId, command, payload });
        } catch (error) {
          pending.delete(requestId);
          cancel();
          // A payload the contract refuses never left this process.
          resolve({
            ok: false,
            error: { code: "INVALID_INPUT", message: errorMessage(error) },
          });
        }
      });
    },
    onEvent(listener) {
      if (transport.closed) return () => undefined;
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onLive(listener) {
      if (transport.closed) return () => undefined;
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    onOrphanResponse(listener) {
      if (transport.closed) return () => undefined;
      orphanListeners.add(listener);
      return () => {
        orphanListeners.delete(listener);
      };
    },
    onClose(listener) {
      return transport.onClose((reason) =>
        listener(
          outOfOrder !== undefined
            ? { kind: "protocol", detail: outOfOrder }
            : reason === undefined
              ? undefined
              : { kind: "unreadable", detail: reason },
        ),
      );
    },
    close() {
      transport.close();
    },
    get closed() {
      return transport.closed;
    },
  };
}
