import { CLIENT_PROTOCOL_VERSION, IPC_COMMANDS, IPC_PROTOCOL_VERSION, encodeFrame, type ClientEvent, type IpcFrame } from "@tavi/contracts";

import type { OwnerAddress, Dialer } from "../../src/client.js";
import type { ClientResponse } from "../../src/connection.js";
import type { Scheduler } from "../../src/scheduler.js";
import { frameTransport, type ByteChannel, type FrameTransport } from "../../src/transport.js";

/** A scheduler whose time moves only when a test advances it. */
export interface ManualScheduler extends Scheduler {
  /** Move time forward, running every callback that falls due, in order. */
  advance(ms: number): Promise<void>;
  /** Callbacks waiting to run. */
  pending(): number;
  /** The delays asked for, in order. */
  readonly requested: number[];
}

export function manualScheduler(): ManualScheduler {
  let now = 0;
  let order = 0;
  const timers: { at: number; order: number; callback: () => void; cancelled: boolean }[] = [];
  const requested: number[] = [];
  return {
    requested,
    delay(ms, callback) {
      requested.push(ms);
      const timer = { at: now + ms, order: (order += 1), callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await settle();
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= until)
          .sort((left, right) => left.at - right.at || left.order - right.order)[0];
        if (due === undefined) break;
        now = due.at;
        due.cancelled = true;
        due.callback();
      }
      now = until;
      await settle();
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

/** Deliveries `PipeEnd` has scheduled and not yet made. */
let inFlight = 0;

/**
 * Let every pipe delivery, and the work it sets off, run: until no delivery
 * is in flight for a few turns in a row, so a flow with more hops than usual
 * is waited out rather than cut off at a fixed count.
 */
export async function settle(): Promise<void> {
  for (let quiet = 0, turns = 0; quiet < 3; turns += 1) {
    if (turns > 10_000) throw new Error("the pipes never went quiet");
    await new Promise<void>((resolve) => setImmediate(resolve));
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
}

/** Deliver on a later turn, as a socket does, counted so `settle` can wait for it. */
function later(deliver: () => void): void {
  inFlight += 1;
  setImmediate(() => {
    inFlight -= 1;
    deliver();
  });
}

/**
 * Two byte channels joined back to back, delivering asynchronously as a
 * socket does, so the tests exercise the real codec and its chunking.
 */
export function channelPair(): { readonly client: ByteChannel; readonly server: ByteChannel } {
  const client = new PipeEnd();
  const server = new PipeEnd();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

/** One end of `channelPair`: writes land on the peer a turn later. */
class PipeEnd implements ByteChannel {
  peer: PipeEnd | undefined;
  readonly #dataListeners: ((chunk: Uint8Array) => void)[] = [];
  readonly #closeListeners: (() => void)[] = [];
  #closed = false;

  write(bytes: Uint8Array): void {
    if (this.#closed) return;
    const copy = Uint8Array.prototype.slice.call(bytes);
    later(() => this.peer?.receive(copy));
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.end();
    later(() => this.peer?.end());
  }

  receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    for (const listener of this.#dataListeners) listener(chunk);
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}

let eventCounter = 0;

/** A valid event of the task's stream, numbered as the owner's bus numbers them. */
export function textEvent(epoch: string, sequence: number, text = `t${sequence}`): ClientEvent {
  eventCounter += 1;
  return {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch,
    sequence,
    runId: "task-1",
    attemptId: "attempt-1",
    at: new Date(Date.UTC(2026, 8, 18, 12, 0, eventCounter % 60)).toISOString(),
    kind: "text.delta",
    blockId: "block-1",
    text,
  };
}

export function resyncEvent(epoch: string, sequence: number): ClientEvent {
  return {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch,
    sequence,
    runId: "task-1",
    attemptId: "attempt-1",
    at: "2026-09-18T12:00:00.000Z",
    kind: "resync.required",
    reason: "cursor evicted",
  };
}

export interface ReceivedRequest {
  readonly requestId: string;
  readonly command: string;
  readonly payload: unknown;
  readonly connection: OwnerConnection;
}

/** One connection as the fake owner holds it. */
export interface OwnerConnection {
  readonly transport: FrameTransport;
  answer(requestId: string, response: ClientResponse): void;
  event(subscriptionId: string, event: ClientEvent): void;
  /** Several frames written in one chunk, as the owner writes a response and its held events. */
  burst(frames: readonly IpcFrame[]): void;
  /** Bytes as they are, past the encoder: what a peer of another build might write. */
  raw(text: string): void;
  drop(): void;
}

/**
 * An owner the tests script: it authenticates like the real one (refusing a
 * wrong cookie by closing, echoing its session) and hands every request to
 * `onRequest`, which answers it — or not, to leave it in flight.
 */
export class FakeOwner {
  readonly connections: OwnerConnection[] = [];
  readonly requests: ReceivedRequest[] = [];
  onRequest: (request: ReceivedRequest) => void = (request) => request.connection.answer(request.requestId, { ok: true, result: {} });
  readonly sessionId: string;
  readonly token: string;
  readonly endpoint: string;
  readyVersion = IPC_PROTOCOL_VERSION;
  readySession: string | undefined;
  /** Follow `ready` in the same chunk with a frame an authenticated owner may not send. */
  breakAfterReady = false;
  /** When set, `ready` waits for it: a handshake held open mid-way. */
  holdReady: Promise<void> | undefined;
  features: readonly string[] = IPC_COMMANDS;

  constructor(sessionId: string, options: { readonly token?: string; readonly endpoint?: string } = {}) {
    this.sessionId = sessionId;
    this.token = options.token ?? `token-${sessionId}`;
    this.endpoint = options.endpoint ?? `/fake/${sessionId}.sock`;
  }

  get address(): OwnerAddress {
    return { endpoint: this.endpoint, sessionId: this.sessionId, token: this.token, protocolVersion: IPC_PROTOCOL_VERSION };
  }

  get latest(): OwnerConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error("no connection yet");
    return connection;
  }

  accept(channel: ByteChannel): void {
    const transport = frameTransport(channel);
    let authenticated = false;
    const connection: OwnerConnection = {
      transport,
      answer: (requestId, response) =>
        transport.send({
          type: "response",
          requestId,
          ok: response.ok,
          ...(response.result === undefined ? {} : { result: response.result }),
          ...(response.error === undefined ? {} : { error: response.error }),
        }),
      event: (subscriptionId, event) => transport.send({ type: "event", subscriptionId, event }),
      burst: (frames) => {
        // Through the contract's own encoder, so a malformed test frame fails here.
        const encoded = frames.map((frame) => encodeFrame(frame));
        const chunk = new Uint8Array(encoded.reduce((total, bytes) => total + bytes.byteLength, 0));
        let offset = 0;
        for (const bytes of encoded) {
          chunk.set(bytes, offset);
          offset += bytes.byteLength;
        }
        channel.write(chunk);
      },
      raw: (text) => channel.write(new TextEncoder().encode(text)),
      drop: () => transport.close(),
    };
    this.connections.push(connection);
    transport.onFrame((frame) => {
      if (!authenticated) {
        if (frame.type !== "hello" || frame.token !== this.token || frame.sessionId !== this.sessionId) {
          transport.close();
          return;
        }
        authenticated = true;
        const ready: IpcFrame = {
          type: "ready",
          protocolVersion: this.readyVersion,
          sessionId: this.readySession ?? this.sessionId,
          features: [...this.features],
        };
        const answer = (): void => {
          if (this.breakAfterReady) {
            connection.burst([
              ready,
              { type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: this.token, sessionId: this.sessionId },
            ]);
          } else {
            transport.send(ready);
          }
        };
        if (this.holdReady === undefined) answer();
        else void this.holdReady.then(answer);
        return;
      }
      if (frame.type === "request") {
        const request = { requestId: frame.requestId, command: frame.command, payload: frame.payload, connection };
        this.requests.push(request);
        this.onRequest(request);
      }
    });
  }
}

/** Refused as a socket refuses when nothing listens: retryable. */
function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
}

/**
 * A dialer over fake owners: `current` is what discovery says right now (a
 * test swaps it to simulate a restart), and each endpoint reaches the owner
 * listening there, if any.
 */
export class FakeDialer implements Dialer {
  current: OwnerAddress | undefined;
  readonly listening = new Map<string, FakeOwner>();
  discoveries = 0;
  opens: string[] = [];
  failOpen: ((endpoint: string) => Error | undefined) | undefined;

  constructor(owner?: FakeOwner) {
    if (owner !== undefined) this.serve(owner);
  }

  /** Publish `owner` in discovery and listen at its endpoint. */
  serve(owner: FakeOwner): void {
    this.current = owner.address;
    this.listening.set(owner.endpoint, owner);
  }

  discover(): Promise<OwnerAddress | undefined> {
    this.discoveries += 1;
    return Promise.resolve(this.current);
  }

  open(endpoint: string): Promise<FrameTransport> {
    this.opens.push(endpoint);
    const failure = this.failOpen?.(endpoint);
    if (failure !== undefined) return Promise.reject(failure);
    const owner = this.listening.get(endpoint);
    if (owner === undefined) return Promise.reject(refused());
    const { client, server } = channelPair();
    owner.accept(server);
    return Promise.resolve(frameTransport(client));
  }

  retryable(error: unknown): boolean {
    return (error as { code?: string }).code === "ECONNREFUSED";
  }
}
