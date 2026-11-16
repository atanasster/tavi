import { IPC_PROTOCOL_VERSION, UI_IPC_PATH, UI_OWNER_PATH, UI_SECRET_HEADER, isProtocolMismatch } from "@tavi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WebSocketOpenError,
  bridgeDialer,
  browserScheduler,
  connectThroughBridge,
  createClient,
  openWebSocket,
  type BrowserWebSocket,
  type FetchFunction,
  type TaviClient,
} from "../src/browser.js";
import { FakeOwner, channelPair, manualScheduler, settle, textEvent } from "./support/fakes.js";

/**
 * `@tavi/client/browser`: the root client over the bridge's
 * WebSocket, finding the owner through the bridge. The WebSocket and `fetch`
 * are fakes of the WHATWG shapes, joined to the fake owner the root's own
 * tests use, so the handshake, framing and reconnect under test are the real
 * ones.
 */

const ORIGIN = "http://127.0.0.1:4100";

/** WebSockets the tests open: each reaches `owner` when `accepting`, and is refused otherwise. */
class FakeSockets {
  owner: FakeOwner | undefined;
  accepting = true;
  readonly urls: string[] = [];
  readonly sent: string[] = [];
  /** A message that is no text frame, sent right after the socket opens. */
  sendBinary = false;
  /** Each `close(code, reason)` a socket was asked for. */
  readonly closes: [number | undefined, string | undefined][] = [];

  readonly WebSocket = (() => {
    const hub = this;
    return class implements BrowserWebSocket {
      readonly #listeners = new Map<string, ((event: { readonly data: unknown }) => void)[]>();
      readonly #end = channelPair();
      #closed = false;

      constructor(url: string) {
        hub.urls.push(url);
        setImmediate(() => {
          const owner = hub.owner;
          if (!hub.accepting || owner === undefined) {
            this.#emit("error");
            this.#emit("close");
            return;
          }
          owner.accept(this.#end.server);
          this.#end.client.onData((chunk) => this.#emit("message", new TextDecoder().decode(chunk)));
          this.#end.client.onClose(() => this.#finish());
          this.#emit("open");
          if (hub.sendBinary) this.#emit("message", new Uint8Array([1, 2]));
        });
      }

      send(data: string): void {
        hub.sent.push(data);
        this.#end.client.write(new TextEncoder().encode(data));
      }

      close(code?: number, reason?: string): void {
        hub.closes.push([code, reason]);
        this.#end.client.close();
        this.#finish();
      }

      addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
      }

      #finish(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#emit("close");
      }

      #emit(type: string, data?: unknown): void {
        for (const listener of this.#listeners.get(type) ?? []) listener({ data });
      }
    };
  })();
}

/** The bridge's `POST /api/owner`, answering for `owner` — or with `status`. */
function bridgeFetch(sockets: FakeSockets, calls: { url: string; secret: string | undefined; credentials: string }[] = []) {
  let status = 200;
  const fetch: FetchFunction = (url, init) => {
    calls.push({ url, secret: init.headers[UI_SECRET_HEADER], credentials: init.credentials });
    const owner = sockets.owner;
    const answer = status === 200 && owner === undefined ? 503 : status;
    return Promise.resolve({
      ok: answer === 200,
      status: answer,
      json: () => Promise.resolve(owner === undefined ? {} : { sessionId: owner.sessionId, protocolVersion: IPC_PROTOCOL_VERSION }),
    });
  };
  return { fetch, calls, answerWith: (next: number) => (status = next) };
}

const clients: TaviClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()?.close();
  vi.unstubAllGlobals();
});

describe("@tavi/client/browser", () => {
  it("finds the owner through the bridge and speaks IPC over its WebSocket, the secret as the handshake's token", async () => {
    const sockets = new FakeSockets();
    sockets.owner = new FakeOwner("session-a", { token: "page-secret" });
    const { fetch, calls } = bridgeFetch(sockets);
    const client = await connectThroughBridge({ origin: `${ORIGIN}/`, secret: "page-secret", fetch, WebSocket: sockets.WebSocket });
    clients.push(client);
    expect(calls).toEqual([{ url: `${ORIGIN}${UI_OWNER_PATH}`, secret: "page-secret", credentials: "same-origin" }]);
    expect(sockets.urls).toEqual([`ws://127.0.0.1:4100${UI_IPC_PATH}`]);
    // One text message per frame, newline-terminated as the codec writes it.
    expect(JSON.parse(sockets.sent[0] ?? "")).toEqual({
      type: "hello",
      protocolVersion: IPC_PROTOCOL_VERSION,
      token: "page-secret",
      sessionId: "session-a",
    });
    expect(sockets.sent[0]?.endsWith("\n")).toBe(true);

    // Requests and pushed events cross the WebSocket as over the socket.
    const owner = sockets.owner;
    owner.onRequest = (request) => {
      request.connection.answer(request.requestId, {
        ok: true,
        result: { subscriptionId: "sub-1", replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" },
      });
      request.connection.event("sub-1", textEvent("session-a", 0, "hello"));
    };
    const seen: string[] = [];
    await client.subscribe("task-1", { onEvent: (event) => seen.push(event.kind === "text.delta" ? event.text : event.kind) });
    await settle();
    expect(seen).toEqual(["hello"]);
  });

  it("reconnects to a restarted owner by asking the bridge again, which names the new session", async () => {
    const sockets = new FakeSockets();
    sockets.owner = new FakeOwner("session-a", { token: "page-secret" });
    const { fetch, calls } = bridgeFetch(sockets);
    const scheduler = manualScheduler();
    const client = createClient({
      dialer: bridgeDialer({ origin: ORIGIN, secret: "page-secret", fetch, WebSocket: sockets.WebSocket }),
      scheduler,
    });
    clients.push(client);
    await client.connect();
    const first = sockets.owner;
    sockets.owner = new FakeOwner("session-b", { token: "page-secret" });
    first.latest.drop();
    await settle();
    await scheduler.advance(10_000);
    expect(client.state).toBe("ready");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(sockets.sent.at(-1) ?? "").sessionId).toBe("session-b");
  });

  it("refuses finally when the bridge refuses the session, and waits out a bridge with no owner", async () => {
    const sockets = new FakeSockets();
    const refused = bridgeFetch(sockets);
    refused.answerWith(401);
    const scheduler = manualScheduler();
    const client = createClient({
      dialer: bridgeDialer({ origin: ORIGIN, secret: "stale", fetch: refused.fetch, WebSocket: sockets.WebSocket }),
      scheduler,
    });
    await expect(client.connect()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(refused.calls).toHaveLength(1);

    // 503: no owner behind the bridge yet — tried again, then reported as unavailable.
    const empty = bridgeFetch(sockets);
    const waiting = createClient({
      dialer: bridgeDialer({ origin: ORIGIN, secret: "s", fetch: empty.fetch, WebSocket: sockets.WebSocket }),
      scheduler,
    });
    const connecting = waiting.connect().catch((error: unknown) => error);
    await scheduler.advance(10_000);
    expect(await connecting).toMatchObject({ code: "UNAVAILABLE" });
    expect(empty.calls.length).toBeGreaterThan(1);
    expect(sockets.urls).toEqual([]);
  });

  it("refuses an owner of another protocol before opening the WebSocket", async () => {
    const sockets = new FakeSockets();
    const fetch: FetchFunction = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sessionId: "s", protocolVersion: IPC_PROTOCOL_VERSION + 1 }),
      });
    const client = createClient({
      dialer: bridgeDialer({ origin: ORIGIN, secret: "x", fetch, WebSocket: sockets.WebSocket }),
      scheduler: manualScheduler(),
    });
    const failure = await client.connect().catch((error: unknown) => error);
    expect(isProtocolMismatch(failure)).toBe(true);
    expect(sockets.urls).toEqual([]);
  });

  it("reports a WebSocket that did not open as retryable, and ends the transport on a binary message", async () => {
    const sockets = new FakeSockets();
    sockets.accepting = false;
    const failure = await openWebSocket(`ws://127.0.0.1:1${UI_IPC_PATH}`, sockets.WebSocket).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebSocketOpenError);
    expect(bridgeDialer({ origin: ORIGIN, secret: "s" }).retryable(failure)).toBe(true);
    expect(bridgeDialer({ origin: ORIGIN, secret: "s" }).retryable(new Error("other"))).toBe(false);

    const binary = new FakeSockets();
    binary.owner = new FakeOwner("session-a");
    binary.sendBinary = true;
    const transport = await openWebSocket(`ws://127.0.0.1:1${UI_IPC_PATH}`, binary.WebSocket);
    await settle();
    expect(transport.closed).toBe(true);
    expect(binary.closes).toEqual([[1003, "text frames only"]]);

    // Closed by this side: a normal closure.
    const normal = new FakeSockets();
    normal.owner = new FakeOwner("session-a");
    (await openWebSocket(`ws://127.0.0.1:1${UI_IPC_PATH}`, normal.WebSocket)).close();
    expect(normal.closes).toEqual([[1000, undefined]]);

    // A URL the constructor refuses is no outage: not retried.
    const Throwing = class {
      constructor() {
        throw new SyntaxError("bad url");
      }
    } as unknown as typeof sockets.WebSocket;
    const invalid = await openWebSocket("nonsense", Throwing).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "INVALID_INPUT" });
    expect(bridgeDialer({ origin: ORIGIN, secret: "s" }).retryable(invalid)).toBe(false);
  });

  it("checks the origin once, up front, and derives the WebSocket's scheme from it", async () => {
    for (const origin of ["127.0.0.1:4100", "HTTP://127.0.0.1:4100", "http://127.0.0.1:4100/path", "ftp://127.0.0.1", "http://"]) {
      expect(() => bridgeDialer({ origin, secret: "s" }), origin).toThrow(/not a bridge origin/);
    }
    const sockets = new FakeSockets();
    sockets.owner = new FakeOwner("session-a", { token: "s" });
    const { fetch, calls } = bridgeFetch(sockets);
    const address = await bridgeDialer({ origin: "https://127.0.0.1:4100/", secret: "s", fetch }).discover();
    expect(calls[0]?.url).toBe(`https://127.0.0.1:4100${UI_OWNER_PATH}`);
    expect(address?.endpoint).toBe(`wss://127.0.0.1:4100${UI_IPC_PATH}`);
  });

  it("answers no owner for an unreachable bridge, and refuses finally a 403 or an answer it cannot read", async () => {
    const answering =
      (status: number, body: unknown): FetchFunction =>
      () =>
        Promise.resolve({ ok: status === 200, status, json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)) });
    const dial = (fetch: FetchFunction) => bridgeDialer({ origin: ORIGIN, secret: "s", fetch }).discover();
    expect(await dial(() => Promise.reject(new TypeError("Failed to fetch")))).toBeUndefined();
    expect(await dial(answering(503, {}))).toBeUndefined();
    await expect(dial(answering(403, {}))).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(dial(answering(200, new SyntaxError("not JSON")))).rejects.toThrow(/cannot read/);
    await expect(dial(answering(200, { sessionId: "" }))).rejects.toThrow(/cannot read/);
  });

  it("uses the page's own fetch, called on the page, and its WebSocket, when none is passed", async () => {
    const sockets = new FakeSockets();
    sockets.owner = new FakeOwner("session-a", { token: "s" });
    const { fetch, calls } = bridgeFetch(sockets);
    // A browser's fetch throws when called off `window`.
    vi.stubGlobal("fetch", function (this: unknown, ...args: Parameters<FetchFunction>) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return fetch(...args);
    });
    vi.stubGlobal("WebSocket", sockets.WebSocket);
    const client = await connectThroughBridge({ origin: ORIGIN, secret: "s" });
    clients.push(client);
    expect(client.state).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(sockets.urls).toEqual([`ws://127.0.0.1:4100${UI_IPC_PATH}`]);
  });

  it("says so when the host has no fetch or no WebSocket", async () => {
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("WebSocket", undefined);
    const dialer = bridgeDialer({ origin: ORIGIN, secret: "s" });
    await expect(dialer.discover()).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
    await expect(dialer.open(`ws://127.0.0.1:4100${UI_IPC_PATH}`)).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("schedules on the page's timers, and cancels", async () => {
    const fired: string[] = [];
    browserScheduler.delay(1, () => fired.push("cancelled"))();
    await new Promise<void>((resolve) => browserScheduler.delay(5, () => resolve(void fired.push("ran"))));
    expect(fired).toEqual(["ran"]);
  });
});
