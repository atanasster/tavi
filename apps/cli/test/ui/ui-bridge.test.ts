import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

import { connectThroughBridge, type FetchFunction, type TaviClient, type WebSocketConstructor } from "@tavi/client/browser";
import {
  IPC_MAX_PROMPT_CHARS,
  IPC_PROTOCOL_VERSION,
  UI_IPC_PATH,
  UI_OWNER_PATH,
  UI_SECRET_HEADER,
  UI_SESSION_PATH,
  encodeFrame,
  type IpcFrame,
  type ModelOutcome,
  type ModelPort,
} from "@tavi/contracts";
import { readOwner, type ClientResponse, type Connection, type OrphanResponse, type RequestOptions } from "@tavi/client/node";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createBrowserLiveSource } from "@tavi/plugin-browser/live";
import type { BrowserLivePort } from "@tavi/contracts";
import { temporaryDirectories, waitFor, partialFake } from "@tavi/test-support";

import { UI_USAGE } from "../../src/features/ui/parse.js";
import { fittedText } from "../../src/shared/terminal-text.js";
import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import {
  UI_CLOSE,
  UI_MAX_BODY_BYTES,
  UI_MAX_MESSAGE_BYTES,
  UI_MAX_TAB_SUBSCRIPTIONS,
  discoveryDialer,
  startUiBridge,
  type UiBridge,
  type UiBridgeOptions,
} from "../../src/server/ui-bridge.js";
import { SHARED_HOST_NOTE, builtCanvasDirectory, runUi } from "../../src/features/ui/client.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi ui`'s bridge: the listener's hardening — three
 * request classes, the token exchange, the upgrade router — and the bridge
 * itself, against a real owner: the allowlist, one IPC connection shared by
 * tabs, a stalled tab dropped alone, a restarted owner found again.
 */

const directories = temporaryDirectories({ prefix: "tavi-ui-" });
const handles: ServeHandle[] = [];
const bridges: UiBridge[] = [];
const sockets: WebSocket[] = [];
const clients: TaviClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (sockets.length > 0) sockets.pop()?.terminate();
  while (bridges.length > 0) await bridges.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

/** A model that answers `text` in `deltas` pieces, once `until` settles. */
function answering(options: { readonly deltas?: number; readonly text?: string; readonly until?: Promise<void> } = {}): ModelPort {
  return {
    async stream(request, stream): Promise<ModelOutcome> {
      if (options.until !== undefined) await options.until;
      const piece = options.text ?? "brief";
      for (let index = 0; index < (options.deltas ?? 1); index += 1) {
        stream.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: piece });
      }
      return { status: "completed", attemptId: request.attemptId, text: piece, toolCalls: [], usage: {} };
    },
  };
}

async function startOwner(directory: string, model: ModelPort = answering()): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "running-conn", defaultModel: "running-model" }),
    {
      dataDirectory: directory,
      drainDeadlineMs: 5_000,
      modelTarget: { source: "default", connectionId: "running-conn", model: "running-model", workspaceId: "default" },
    },
    quietIo,
    { modelOverride: model },
  );
  handles.push(handle);
  return handle;
}

async function bridgeFor(directory: string, options: Partial<UiBridgeOptions> = {}): Promise<UiBridge> {
  const bridge = await startUiBridge({ dataDirectory: directory, ...options });
  bridges.push(bridge);
  return bridge;
}

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A raw HTTP request, every header as given — `Host` and `Origin` included, or left out. */
function http(bridge: UiBridge, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: bridge.port, method, path, headers, setHost: false }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const hostOf = (bridge: UiBridge) => ({ host: `127.0.0.1:${bridge.port}` });
const pageOf = (bridge: UiBridge) => ({ ...hostOf(bridge), origin: bridge.origin });

function tokenOf(link: string): string {
  return link.slice(link.indexOf("#") + 1);
}

/** Exchange a fresh link for a session, as the page does. */
async function session(bridge: UiBridge): Promise<{ readonly cookie: string; readonly secret: string; readonly answer: Answer }> {
  const answer = await http(
    bridge,
    "POST",
    UI_SESSION_PATH,
    { ...pageOf(bridge), "content-type": "application/json" },
    JSON.stringify({ token: tokenOf(bridge.mintLink()) }),
  );
  expect(answer.status).toBe(200);
  const setCookie = answer.headers["set-cookie"]?.[0] ?? "";
  return { cookie: setCookie.split(";")[0] ?? "", secret: (JSON.parse(answer.body) as { secret: string }).secret, answer };
}

interface RawTab {
  readonly socket: WebSocket;
  readonly frames: IpcFrame[];
  readonly raw: string[];
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  send(frame: unknown): void;
  /** Resolves with the first frame received after this call that matches. */
  next(match: (frame: IpcFrame) => boolean): Promise<IpcFrame>;
}

/** A WebSocket to the bridge, headers as given; rejects with the status of a refused upgrade. */
function tab(bridge: UiBridge, headers: Record<string, string>, path = UI_IPC_PATH): Promise<RawTab> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}${path}`, { headers });
    sockets.push(socket);
    const frames: IpcFrame[] = [];
    const raw: string[] = [];
    const waiters: { match: (frame: IpcFrame) => boolean; resolve: (frame: IpcFrame) => void }[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) =>
      socket.on("close", (code, reason) => done({ code, reason: reason.toString("utf8") })),
    );
    socket.on("message", (data: Buffer) => {
      const text = data.toString("utf8");
      raw.push(text);
      const frame = JSON.parse(text) as IpcFrame;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.match(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
    socket.on("unexpected-response", (_request, response) => reject(Object.assign(new Error("refused"), { status: response.statusCode })));
    socket.on("error", (error) => reject(error));
    socket.on("open", () =>
      resolve({
        socket,
        frames,
        raw,
        closed,
        send: (frame) => socket.send(`${JSON.stringify(frame)}\n`),
        next: (match) => new Promise((done) => waiters.push({ match, resolve: done })),
      }),
    );
  });
}

/** A tab past its handshake: `ready` received. */
async function readyTab(
  bridge: UiBridge,
  auth: { readonly cookie: string; readonly secret: string },
  ownerSession: string,
): Promise<RawTab> {
  const opened = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
  const ready = opened.next((frame) => frame.type === "ready");
  opened.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: auth.secret, sessionId: ownerSession });
  await ready;
  return opened;
}

/** `POST /api/owner` as the page asks it: its Origin, cookie and secret. */
function probeOwner(bridge: UiBridge, auth: { readonly cookie: string; readonly secret: string }): Promise<Answer> {
  return http(bridge, "POST", UI_OWNER_PATH, { ...pageOf(bridge), cookie: auth.cookie, [UI_SECRET_HEADER]: auth.secret }, "{}");
}

async function ownerSessionOf(bridge: UiBridge, auth: { readonly cookie: string; readonly secret: string }): Promise<string> {
  const answer = await probeOwner(bridge, auth);
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { sessionId: string }).sessionId;
}

interface SpiedRequest {
  readonly command: string;
  readonly payload: unknown;
  readonly id: string;
  response?: ClientResponse;
}

/**
 * The bridge's real connection to the owner, watched: every request it
 * forwards and its answer, the owner's orphan-response listener (so a test
 * can play a BACKLOG drop), and a gate that holds `subscribe` answers.
 */
function spiedDialer(directory: string): {
  readonly dial: () => Promise<Connection | undefined>;
  readonly requests: SpiedRequest[];
  orphan: ((orphan: OrphanResponse) => void) | undefined;
  hold: Promise<void> | undefined;
  fail: string | undefined;
} {
  const spy = {
    requests: [] as SpiedRequest[],
    orphan: undefined as ((orphan: OrphanResponse) => void) | undefined,
    hold: undefined as Promise<void> | undefined,
    /** A command whose requests reject, as a timed-out request does. */
    fail: undefined as string | undefined,
    dial: async (): Promise<Connection | undefined> => {
      const connection = await discoveryDialer(directory)();
      if (connection === undefined) return undefined;
      return new Proxy(connection, {
        get(target, property) {
          if (property === "request") {
            return (command: string, payload: unknown, id: string, options?: RequestOptions) => {
              const entry: SpiedRequest = { command, payload, id };
              spy.requests.push(entry);
              if (command === spy.fail) return Promise.reject(new Error(`request ${id} timed out`));
              const hold = command === "subscribe" ? spy.hold : undefined;
              const onResponse = options?.onResponse;
              const held =
                hold === undefined || onResponse === undefined
                  ? options
                  : { ...options, onResponse: (response: ClientResponse) => void hold.then(() => onResponse(response)) };
              return target.request(command, payload, id, held).then(async (response) => {
                entry.response = response;
                if (hold !== undefined) await hold;
                return response;
              });
            };
          }
          if (property === "onOrphanResponse") {
            return (listener: (orphan: OrphanResponse) => void) => {
              spy.orphan = listener;
              return target.onOrphanResponse(listener);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
  return spy;
}

/** The session of the owner serving `directory`, as its discovery record names it. */
function ownerSession(directory: string): string {
  const owner = readOwner(directory);
  if (owner === undefined) throw new Error("no owner is serving");
  return owner.sessionId;
}

const runPayload = (operationKey: string, approval: "approve" | "client" | "deny" = "approve") => ({
  prompt: "write the brief",
  workspaceId: "default",
  principal: "operator",
  operationKey,
  approval,
});

describe("tavi ui: the listener", () => {
  it("binds the loopback literal, and serves the page with no Origin and no session — never to a foreign Host or another site", async () => {
    const canvas = directories.create();
    mkdirSync(join(canvas, "assets"));
    writeFileSync(join(canvas, "index.html"), "<!doctype html><head><title>canvas</title></head>");
    writeFileSync(join(canvas, "assets", "app-1a2b.js"), "console.log(1)");
    writeFileSync(join(canvas, "notes.unknown"), "not served");
    const bridge = await bridgeFor(directories.create(), { staticDirectory: canvas });
    expect(bridge.origin).toBe(`http://127.0.0.1:${bridge.port}`);

    const page = await http(bridge, "GET", "/", hostOf(bridge));
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>canvas</title>");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain(`connect-src 'self' ws://127.0.0.1:${bridge.port}`);
    // A fresh style nonce each time the page is served, named in its CSP and in the page; no inline style otherwise.
    const nonceOf = (served: { body: string; headers: Record<string, unknown> }) => {
      const named = /style-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(String(served.headers["content-security-policy"]))?.[1];
      expect(served.body).toContain(`<meta name="csp-nonce" content="${named}">`);
      expect(String(served.headers["content-security-policy"])).not.toContain("unsafe-inline");
      return named;
    };
    const first = nonceOf(page);
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonceOf(await http(bridge, "GET", "/", hostOf(bridge)))).not.toBe(first);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect((await http(bridge, "GET", "/assets/app-1a2b.js", { ...hostOf(bridge), "sec-fetch-site": "same-origin" })).body).toBe(
      "console.log(1)",
    );
    expect((await http(bridge, "GET", "/", { ...hostOf(bridge), "sec-fetch-site": "none" })).status).toBe(200);

    // DNS rebinding: a name that resolves here is still not this origin.
    expect((await http(bridge, "GET", "/", { host: `evil.example:${bridge.port}` })).status).toBe(403);
    expect((await http(bridge, "GET", "/", { host: `127.0.0.1:${bridge.port + 1}` })).status).toBe(403);
    // Loaded as a subresource of another site.
    expect((await http(bridge, "GET", "/", { ...hostOf(bridge), "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await http(bridge, "GET", "/", { ...hostOf(bridge), "sec-fetch-site": "same-site" })).status).toBe(403);
    // Only the files the canvas was built with; no path reaches the filesystem.
    expect((await http(bridge, "GET", "/notes.unknown", hostOf(bridge))).status).toBe(404);
    expect((await http(bridge, "GET", "/../index.html", hostOf(bridge))).status).toBe(404);
    expect((await http(bridge, "GET", "/assets/%2e%2e/index.html", hostOf(bridge))).status).toBe(404);

    // One canonical origin: `localhost` is sent to it, path kept (the fragment stays in the browser).
    const redirected = await http(bridge, "GET", "/", { host: `localhost:${bridge.port}` });
    expect(redirected.status).toBe(308);
    expect(redirected.headers["location"]).toBe(`${bridge.origin}/`);
    expect(
      (await http(bridge, "POST", UI_SESSION_PATH, { host: `localhost:${bridge.port}`, origin: `http://localhost:${bridge.port}` }, "{}"))
        .status,
    ).toBe(403);
  });

  it("serves a placeholder page when the canvas is not built", async () => {
    const bridge = await bridgeFor(directories.create());
    const page = await http(bridge, "GET", "/", hostOf(bridge));
    expect(page.status).toBe(200);
    expect(page.body).toContain("not built");
  });

  it("serves the canvas at its routes, so a deep link or a refresh on one is the page", async () => {
    const canvas = directories.create();
    mkdirSync(join(canvas, "assets"));
    writeFileSync(join(canvas, "index.html"), "<!doctype html><title>canvas</title>");
    writeFileSync(join(canvas, "assets", "index-1a2b.js"), "console.log(1)");
    const bridge = await bridgeFor(directories.create(), { staticDirectory: canvas });
    const navigation = { ...hostOf(bridge), "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

    // A path the build ships no file at, reached as a document: the entry point.
    const deep = await http(bridge, "GET", "/settings/system-prompt", navigation);
    expect(deep.status).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    expect(deep.body).toContain("<title>canvas</title>");
    expect((await http(bridge, "GET", "/tasks/task-1", navigation)).body).toContain("<title>canvas</title>");

    // Another site may link to a route as it may link to the page...
    expect((await http(bridge, "GET", "/routines", { ...navigation, "sec-fetch-site": "cross-site" })).status).toBe(200);
    // ...but a route is not an asset: the same path as a subresource is not served.
    expect((await http(bridge, "GET", "/settings", hostOf(bridge))).status).toBe(404);
    expect(
      (
        await http(bridge, "GET", "/settings", {
          ...hostOf(bridge),
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        })
      ).status,
    ).toBe(404);
    // A file is always itself, whatever loaded it.
    expect((await http(bridge, "GET", "/assets/index-1a2b.js", { ...navigation, "sec-fetch-site": "same-origin" })).body).toBe(
      "console.log(1)",
    );

    // `localhost` is sent to the one origin at a route too, the path kept.
    const redirected = await http(bridge, "GET", "/settings/models", {
      host: `localhost:${bridge.port}`,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    expect(redirected.status).toBe(308);
    expect(redirected.headers["location"]).toBe(`${bridge.origin}/settings/models`);
  });

  it("exchanges a token once, from the page only, for a cookie and a secret — neither Secure nor __Host-", async () => {
    const bridge = await bridgeFor(directories.create());
    const post = (headers: Record<string, string>, token: string) =>
      http(bridge, "POST", UI_SESSION_PATH, { "content-type": "application/json", ...headers }, JSON.stringify({ token }));
    // A forged Origin, and none at all: refused, and the token survives both.
    const link = bridge.mintLink();
    expect((await post({ ...hostOf(bridge), origin: "http://evil.example" }, tokenOf(link))).status).toBe(403);
    expect((await post({ ...hostOf(bridge), origin: `http://127.0.0.1:${bridge.port + 1}` }, tokenOf(link))).status).toBe(403);
    expect((await post(hostOf(bridge), tokenOf(link))).status).toBe(403);
    expect((await post({ host: "evil.example", origin: bridge.origin }, tokenOf(link))).status).toBe(403);

    const first = await post(pageOf(bridge), tokenOf(link));
    expect(first.status).toBe(200);
    const cookie = first.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(new RegExp(`^tavi_ui_${bridge.port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/`));
    expect(cookie).not.toMatch(/Secure|__Host-/);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect((JSON.parse(first.body) as { secret: string }).secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Single use.
    expect((await post(pageOf(bridge), tokenOf(link))).status).toBe(401);
    // Each exchange mints its own session.
    const again = await post(pageOf(bridge), tokenOf(bridge.mintLink()));
    expect(again.headers["set-cookie"]?.[0]).not.toBe(cookie);
    expect(JSON.parse(again.body)).not.toEqual(JSON.parse(first.body));
    // Not a token at all, or a body that is not one.
    expect((await post(pageOf(bridge), "made-up")).status).toBe(401);
    expect((await http(bridge, "POST", UI_SESSION_PATH, pageOf(bridge), "not json")).status).toBe(400);
  });

  it("lets exactly one of two racing exchanges have a token", async () => {
    const bridge = await bridgeFor(directories.create());
    const token = tokenOf(bridge.mintLink());
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => http(bridge, "POST", UI_SESSION_PATH, pageOf(bridge), JSON.stringify({ token }))),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401, 401, 401, 401, 401, 401, 401]);
  });

  it("expires a token after its life", async () => {
    let now = 1_000_000;
    const bridge = await bridgeFor(directories.create(), { now: () => now, tokenTtlMs: 60_000 });
    const link = bridge.mintLink();
    now += 60_001;
    expect((await http(bridge, "POST", UI_SESSION_PATH, pageOf(bridge), JSON.stringify({ token: tokenOf(link) }))).status).toBe(401);
  });

  it("answers the API only to the page's Origin with the cookie and the secret — a replayed cookie alone is refused", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const ask = (headers: Record<string, string>) => http(bridge, "POST", UI_OWNER_PATH, headers, "{}");

    const answered = await ask({ ...pageOf(bridge), cookie: auth.cookie, [UI_SECRET_HEADER]: auth.secret });
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.body)).toEqual({ sessionId: ownerSession(directory), protocolVersion: IPC_PROTOCOL_VERSION });

    // The cross-port case: another loopback server the browser visits receives
    // the cookie and replays it with forged Host and Origin — but never saw the secret.
    expect((await ask({ ...pageOf(bridge), cookie: auth.cookie })).status).toBe(401);
    expect((await ask({ ...pageOf(bridge), cookie: auth.cookie, [UI_SECRET_HEADER]: "A".repeat(43) })).status).toBe(401);
    // The secret without its cookie, or with another session's.
    expect((await ask({ ...pageOf(bridge), [UI_SECRET_HEADER]: auth.secret })).status).toBe(401);
    const other = await session(bridge);
    expect((await ask({ ...pageOf(bridge), cookie: other.cookie, [UI_SECRET_HEADER]: auth.secret })).status).toBe(401);
    // An absent or forged Origin, with both.
    expect((await ask({ ...hostOf(bridge), cookie: auth.cookie, [UI_SECRET_HEADER]: auth.secret })).status).toBe(401);
    expect(
      (await ask({ ...hostOf(bridge), origin: "http://evil.example", cookie: auth.cookie, [UI_SECRET_HEADER]: auth.secret })).status,
    ).toBe(401);
    // A cookie of the same name another loopback server set beside ours does not hide ours.
    expect(
      (await ask({ ...pageOf(bridge), cookie: `tavi_ui_${bridge.port}=planted; ${auth.cookie}`, [UI_SECRET_HEADER]: auth.secret })).status,
    ).toBe(200);
    // A GET, which a same-origin fetch may send without Origin, is no API request.
    expect(
      (await http(bridge, "GET", UI_OWNER_PATH, { ...pageOf(bridge), cookie: auth.cookie, [UI_SECRET_HEADER]: auth.secret })).status,
    ).toBe(405);
  });

  it("answers 503 when no owner serves the data directory", async () => {
    const bridge = await bridgeFor(directories.create());
    const auth = await session(bridge);
    expect((await probeOwner(bridge, auth)).status).toBe(503);
  });

  it("destroys an upgrade on an unrouted path, and refuses one without the page's Origin or a session", async () => {
    const bridge = await bridgeFor(directories.create());
    const auth = await session(bridge);
    // Unrouted: the socket is destroyed, with no HTTP answer at all.
    const destroyed = await new Promise<string>((resolve) => {
      const socket = connect(bridge.port, "127.0.0.1", () =>
        socket.write(
          `GET /elsewhere HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nOrigin: ${bridge.origin}\r\nCookie: ${auth.cookie}\r\n` +
            "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ),
      );
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString("utf8")));
      socket.on("close", () => resolve(received));
    });
    expect(destroyed).toBe("");

    const refused = (headers: Record<string, string>) =>
      tab(bridge, headers).then(
        () => 0,
        (error: { status?: number }) => error.status ?? -1,
      );
    expect(await refused({ ...hostOf(bridge), cookie: auth.cookie })).toBe(401);
    expect(await refused({ ...hostOf(bridge), origin: "http://evil.example", cookie: auth.cookie })).toBe(401);
    expect(await refused(pageOf(bridge))).toBe(401);
    expect(await refused({ host: "evil.example", origin: bridge.origin, cookie: auth.cookie })).toBe(401);
  });

  it("closes a tab whose hello does not carry its session's secret, or that sends none", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory, { helloDeadlineMs: 200 });
    const auth = await session(bridge);
    const other = await session(bridge);

    const wrong = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    wrong.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: other.secret, sessionId: ownerSession(directory) });
    expect((await wrong.closed).code).toBe(UI_CLOSE.unauthenticated);
    expect(wrong.frames).toEqual([]);

    const silent = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    expect((await silent.closed).code).toBe(UI_CLOSE.unauthenticated);

    // A request before the hello is no hello.
    const early = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    early.send({ type: "request", requestId: "r", command: "tasks", payload: {} });
    expect((await early.closed).code).toBe(UI_CLOSE.unauthenticated);

    // An owner session the bridge is not connected to: the page asks again.
    const stale = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    stale.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: auth.secret, sessionId: "an-old-owner" });
    expect((await stale.closed).code).toBe(UI_CLOSE.ownerGone);
  });

  it("closes a tab's socket when its session expires", async () => {
    let now = 1_000_000;
    const directory = directories.create();
    await startOwner(directory);
    // The heartbeat also drops a tab that missed a ping: this process answers the page's pongs too, so
    // a beat shorter than a stall under load (an owner starting) drops the tab before it is ready.
    const bridge = await bridgeFor(directory, { now: () => now, sessionTtlMs: 60_000, heartbeatMs: 500 });
    const auth = await session(bridge);
    const opened = await readyTab(bridge, auth, ownerSession(directory));
    now += 60_001;
    expect((await opened.closed).code).toBe(UI_CLOSE.sessionExpired);
    expect((await probeOwner(bridge, auth)).status).toBe(401);
  });
});

describe("tavi ui: the bridge to the owner", () => {
  it("answers ready for the owner with the allowlisted commands, and refuses shutdown, recover and doctor itself", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const opened = await readyTab(bridge, auth, ownerSession(directory));
    const ready = opened.frames[0];
    expect(ready).toMatchObject({ type: "ready", protocolVersion: IPC_PROTOCOL_VERSION, sessionId: ownerSession(directory) });
    const features = ready?.type === "ready" ? ready.features : [];
    expect(features).toContain("run");
    for (const refused of ["shutdown", "recover", "doctor"]) expect(features).not.toContain(refused);

    for (const [index, command] of ["shutdown", "recover", "doctor", "no-such-command"].entries()) {
      const answer = opened.next((frame) => frame.type === "response" && frame.requestId === `refused-${index}`);
      opened.send({ type: "request", requestId: `refused-${index}`, command, payload: {} });
      expect(await answer).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    }
    // The owner is still serving, and still answers an allowed command.
    const tasks = opened.next((frame) => frame.type === "response" && frame.requestId === "tasks");
    opened.send({ type: "request", requestId: "tasks", command: "tasks", payload: {} });
    expect(await tasks).toMatchObject({ ok: true });
    // The configuration families a page's settings use reach the owner, search
    // included and the editable system prompt with it: the
    // editor is a page, and `UI_BRIDGE_COMMANDS` is a second allowlist that
    // refuses the command before the owner ever sees it.
    expect(features).toEqual(expect.arrayContaining(["models", "credentials", "search", "system-prompt"]));
    const providers = opened.next((frame) => frame.type === "response" && frame.requestId === "search");
    opened.send({ type: "request", requestId: "search", command: "search", payload: { action: "list" } });
    expect(await providers).toMatchObject({ ok: true, result: { providers: [], truncated: false } });

    const prompt = opened.next((frame) => frame.type === "response" && frame.requestId === "system-prompt");
    opened.send({
      type: "request",
      requestId: "system-prompt",
      command: "system-prompt",
      payload: { action: "get", workspaceId: "default" },
    });
    expect(await prompt).toMatchObject({ ok: true, result: { effective: { source: "builtin" }, revision: 0 } });

    // A page's *write* is attributed to the UI, not the CLI: the bridge marks its
    // own IPC connection, and the owner passes that connection to the handler
    // (attribution only — the authority is the socket and the session secret).
    const pageWrite = opened.next((frame) => frame.type === "response" && frame.requestId === "system-prompt-set");
    opened.send({
      type: "request",
      requestId: "system-prompt-set",
      command: "system-prompt",
      payload: { action: "set", workspaceId: "default", text: "from the editor", expectedRevision: 0 },
    });
    expect(await pageWrite).toMatchObject({ ok: true, result: { custom: { actor: "operator:ui", revision: 1 } } });
    expect(ownerSession(directory)).toBe(await ownerSessionOf(bridge, auth));
  });

  it("carries a run to its end for a page on @tavi/client/browser, and never lets the IPC cookie reach it", async () => {
    const directory = directories.create();
    await startOwner(directory, answering({ text: "the brief" }));
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const seen: string[] = [auth.answer.body, JSON.stringify(auth.answer.headers)];
    const fetch: FetchFunction = async (url, init) => {
      const answer = await http(
        bridge,
        init.method,
        new URL(url).pathname,
        { ...pageOf(bridge), cookie: auth.cookie, ...init.headers },
        init.body,
      );
      seen.push(answer.body, JSON.stringify(answer.headers));
      return { ok: answer.status === 200, status: answer.status, json: () => Promise.resolve(JSON.parse(answer.body)) };
    };
    const PageSocket = class extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { origin: bridge.origin, cookie: auth.cookie } });
        this.on("message", (data: Buffer) => seen.push(data.toString("utf8")));
      }
    } as unknown as WebSocketConstructor;
    const client = await connectThroughBridge({ origin: bridge.origin, secret: auth.secret, fetch, WebSocket: PageSocket });
    clients.push(client);

    const texts: string[] = [];
    const ended = new Promise<void>((resolve) => {
      void client.run(runPayload("ui-run-1"), {
        onEvent: (event) => {
          if (event.kind === "text.delta") texts.push(event.text);
          if (event.kind === "task.completed" || event.kind === "task.failed") resolve();
        },
      });
    });
    await ended;
    expect(texts.join("")).toBe("the brief");
    const cookie = readFileSync(join(directory, "runtime", "ipc.token"), "utf8").trim();
    expect(cookie.length).toBeGreaterThan(20);
    for (const text of seen) expect(text).not.toContain(cookie);
  });

  it("admits a frame the size of the longest prompt the owner accepts", async () => {
    // Escaped at its worst (a control character is six bytes in JSON), a
    // maximal prompt still fits the WebSocket's bound.
    const frame = encodeFrame({
      type: "request",
      requestId: "r".repeat(96),
      command: "run",
      payload: { ...runPayload("k".repeat(256)), prompt: "".repeat(IPC_MAX_PROMPT_CHARS) },
    });
    expect(frame.byteLength).toBeLessThanOrEqual(UI_MAX_MESSAGE_BYTES);
  });

  it("drops a stalled tab and only its subscriptions; the tab beside it reads everything", async () => {
    const directory = directories.create();
    let release = (): void => undefined;
    const until = new Promise<void>((resolve) => (release = resolve));
    const deltas = 1_500;
    await startOwner(directory, answering({ deltas, text: "x".repeat(2_048), until }));
    const lines: string[] = [];
    const bridge = await bridgeFor(directory, { tabBufferBytes: 64 * 1024, log: (line) => lines.push(line) });
    const auth = await session(bridge);
    const reader = await readyTab(bridge, auth, ownerSession(directory));
    const stalled = await readyTab(bridge, auth, ownerSession(directory));

    const started = reader.next((frame) => frame.type === "response" && frame.requestId === "run");
    reader.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-stall") });
    const runAnswer = await started;
    const taskId = runAnswer.type === "response" ? (runAnswer.result as { taskId: string }).taskId : "";
    const subscribed = stalled.next((frame) => frame.type === "response" && frame.requestId === "sub");
    stalled.send({ type: "request", requestId: "sub", command: "subscribe", payload: { taskId, from: "beginning" } });
    expect(await subscribed).toMatchObject({ ok: true });

    stalled.socket.pause();
    release();
    await waitFor(
      () => reader.frames.filter((frame) => frame.type === "event" && frame.event.kind === "text.delta").length === deltas,
      30_000,
    );
    stalled.socket.resume();
    expect((await stalled.closed).code).toBe(UI_CLOSE.fallingBehind);
    expect(lines.some((line) => line.includes("fell behind"))).toBe(true);
    expect(bridge.tabs()).toBe(1);
    // The reader's connection is untouched, and still answers.
    const tasks = reader.next((frame) => frame.type === "response" && frame.requestId === "after");
    reader.send({ type: "request", requestId: "after", command: "tasks", payload: {} });
    expect(await tasks).toMatchObject({ ok: true });
  }, 60_000);

  it("lets a tab end only its own subscriptions, and routes each subscription's events to the tab that opened it", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const first = await readyTab(bridge, auth, ownerSession(directory));
    const second = await readyTab(bridge, auth, ownerSession(directory));
    const done = first.next((frame) => frame.type === "event" && frame.event.kind === "task.completed");
    first.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-route") });
    const opened = await first.next((frame) => frame.type === "response" && frame.requestId === "run");
    const subscriptionId = opened.type === "response" ? (opened.result as { subscriptionId: string }).subscriptionId : "";
    await done;
    expect(second.frames.filter((frame) => frame.type === "event")).toEqual([]);

    const refused = second.next((frame) => frame.type === "response" && frame.requestId === "steal");
    second.send({ type: "request", requestId: "steal", command: "unsubscribe", payload: { subscriptionId } });
    expect(await refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const own = first.next((frame) => frame.type === "response" && frame.requestId === "unsub");
    first.send({ type: "request", requestId: "unsub", command: "unsubscribe", payload: { subscriptionId } });
    expect(await own).toMatchObject({ ok: true });

    // A request id too long to prefix is refused.
    const long = second.next((frame) => frame.type === "response" && frame.requestId === "l".repeat(97));
    second.send({ type: "request", requestId: "l".repeat(97), command: "tasks", payload: {} });
    expect(await long).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("closes every tab when the owner stops, and reaches the restarted owner when the page asks again", async () => {
    const directory = directories.create();
    const first = await startOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const firstSession = ownerSession(directory);
    const opened = await readyTab(bridge, auth, firstSession);

    await first.shutdown("restart");
    handles.splice(handles.indexOf(first), 1);
    expect((await opened.closed).code).toBe(UI_CLOSE.ownerGone);
    expect((await probeOwner(bridge, auth)).status).toBe(503);

    await startOwner(directory);
    expect(ownerSession(directory)).not.toBe(firstSession);
    expect(await ownerSessionOf(bridge, auth)).toBe(ownerSession(directory));
    const again = await readyTab(bridge, auth, ownerSession(directory));
    expect(again.frames[0]).toMatchObject({ type: "ready", sessionId: ownerSession(directory) });
  });
});

describe("tavi ui: limits and misbehaving tabs", () => {
  it("refuses to start on an address that is not the loopback literal", async () => {
    await expect(startUiBridge({ dataDirectory: directories.create(), listenAddress: "::1" })).rejects.toThrow(
      /not 127\.0\.0\.1|EADDRNOTAVAIL/,
    );
  });

  it("lets another site link to the page but not load it or its assets", async () => {
    const canvas = directories.create();
    writeFileSync(join(canvas, "index.html"), "<!doctype html>");
    writeFileSync(join(canvas, "app.js"), "1");
    const bridge = await bridgeFor(directories.create(), { staticDirectory: canvas });
    const navigation = { ...hostOf(bridge), "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect((await http(bridge, "GET", "/", navigation)).status).toBe(200);
    expect((await http(bridge, "GET", "/app.js", navigation)).status).toBe(403);
    expect((await http(bridge, "GET", "/", { ...navigation, "sec-fetch-dest": "iframe" })).status).toBe(403);
  });

  it("answers a body too large, and the wrong method, without reading on", async () => {
    const bridge = await bridgeFor(directories.create());
    const large = JSON.stringify({ token: "t".repeat(UI_MAX_BODY_BYTES) });
    expect((await http(bridge, "POST", UI_SESSION_PATH, pageOf(bridge), large)).status).toBe(413);
    expect((await http(bridge, "GET", UI_SESSION_PATH, pageOf(bridge))).status).toBe(405);
    expect((await http(bridge, "GET", "/elsewhere", pageOf(bridge))).status).toBe(404);
  });

  it("keeps tabs that never say hello to their own few places, apart from the page's", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory, { maxPendingTabs: 2, maxTabs: 2 });
    const auth = await session(bridge);
    const refused = () =>
      tab(bridge, { ...pageOf(bridge), cookie: auth.cookie }).then(
        () => 0,
        (error: { status?: number }) => error.status ?? -1,
      );
    // A cookie replayed without the secret holds at most the pending places...
    await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    const second = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    expect(await refused()).toBe(503);
    // ...and a tab past its hello leaves them.
    const ready = second.next((frame) => frame.type === "ready");
    second.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: auth.secret, sessionId: ownerSession(directory) });
    await ready;
    await readyTab(bridge, auth, ownerSession(directory));
    // Two authenticated tabs: the cap, answered as busy rather than unauthorised.
    expect(await refused()).toBe(503);
  });

  it("closes a tab for a binary message, a malformed frame, a frame other than a request, or another protocol", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const binary = await readyTab(bridge, auth, ownerSession(directory));
    binary.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await binary.closed).code).toBe(1003);
    const malformed = await readyTab(bridge, auth, ownerSession(directory));
    malformed.socket.send("{not a frame}\n");
    expect((await malformed.closed).code).toBe(1007);
    const wrongKind = await readyTab(bridge, auth, ownerSession(directory));
    wrongKind.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: auth.secret, sessionId: ownerSession(directory) });
    expect((await wrongKind.closed).code).toBe(1008);
    const older = await tab(bridge, { ...pageOf(bridge), cookie: auth.cookie });
    older.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION + 1, token: auth.secret, sessionId: ownerSession(directory) });
    expect((await older.closed).code).toBe(1002);
  });

  it("drops a tab that stops answering pings", async () => {
    const directory = directories.create();
    await startOwner(directory);
    // Long enough that the live tab answers in time under load, as the session-expiry test's.
    const bridge = await bridgeFor(directory, { heartbeatMs: 500 });
    const auth = await session(bridge);
    const live = await readyTab(bridge, auth, ownerSession(directory));
    const silent = await readyTab(bridge, auth, ownerSession(directory));
    silent.socket.pause();
    await waitFor(() => bridge.tabs() === 1);
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("forgets the oldest session beyond its bound, closing its tabs", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory, { maxSessions: 1 });
    const first = await session(bridge);
    const opened = await readyTab(bridge, first, ownerSession(directory));
    await session(bridge);
    expect((await opened.closed).code).toBe(UI_CLOSE.sessionExpired);
    expect((await probeOwner(bridge, first)).status).toBe(401);
  });

  it("refuses a request id already in flight on the tab", async () => {
    const directory = directories.create();
    let release = (): void => undefined;
    await startOwner(directory, answering({ until: new Promise<void>((resolve) => (release = resolve)) }));
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const opened = await readyTab(bridge, auth, ownerSession(directory));
    // The run is answered once admitted, so a second run under the same key queues behind it.
    opened.send({ type: "request", requestId: "same", command: "run", payload: runPayload("ui-dup") });
    const refused = opened.next((frame) => frame.type === "response" && frame.requestId === "same" && !frame.ok);
    opened.send({ type: "request", requestId: "same", command: "tasks", payload: {} });
    expect(await refused).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    release();
  });

  it("bounds the subscriptions one tab holds, so the owner's are shared", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const opened = await readyTab(bridge, auth, ownerSession(directory));
    const done = opened.next((frame) => frame.type === "event" && frame.event.kind === "task.completed");
    opened.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-cap") });
    const started = await opened.next((frame) => frame.type === "response" && frame.requestId === "run");
    const taskId = started.type === "response" ? (started.result as { taskId: string }).taskId : "";
    await done;
    for (let index = 1; index < UI_MAX_TAB_SUBSCRIPTIONS; index += 1) {
      const answer = opened.next((frame) => frame.type === "response" && frame.requestId === `sub-${index}`);
      opened.send({ type: "request", requestId: `sub-${index}`, command: "subscribe", payload: { taskId } });
      expect(await answer).toMatchObject({ ok: true });
    }
    const over = opened.next((frame) => frame.type === "response" && frame.requestId === "sub-over");
    opened.send({ type: "request", requestId: "sub-over", command: "subscribe", payload: { taskId } });
    expect(await over).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    // Another tab has its own share.
    const other = await readyTab(bridge, auth, ownerSession(directory));
    const theirs = other.next((frame) => frame.type === "response" && frame.requestId === "sub");
    other.send({ type: "request", requestId: "sub", command: "subscribe", payload: { taskId } });
    expect(await theirs).toMatchObject({ ok: true });
  });

  it("ends a closed tab's subscriptions at the owner, one answered after it closed included", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const spy = spiedDialer(directory);
    const bridge = await bridgeFor(directory, { dial: spy.dial });
    const auth = await session(bridge);
    const opened = await readyTab(bridge, auth, ownerSession(directory));
    const done = opened.next((frame) => frame.type === "event" && frame.event.kind === "task.completed");
    opened.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-release") });
    const started = await opened.next((frame) => frame.type === "response" && frame.requestId === "run");
    const { taskId, subscriptionId } =
      started.type === "response" ? (started.result as { taskId: string; subscriptionId: string }) : { taskId: "", subscriptionId: "" };
    await done;

    // A subscribe whose answer is held until after the tab has gone.
    let letGo = (): void => undefined;
    spy.hold = new Promise<void>((resolve) => (letGo = resolve));
    opened.send({ type: "request", requestId: "late", command: "subscribe", payload: { taskId } });
    await waitFor(() => spy.requests.some((request) => request.command === "subscribe" && request.response !== undefined));
    opened.socket.terminate();
    await waitFor(() => bridge.tabs() === 0);
    letGo();
    const late = spy.requests.find((request) => request.command === "subscribe")?.response?.result as { subscriptionId: string };
    const released = () =>
      spy.requests
        .filter((request) => request.command === "unsubscribe")
        .map((request) => (request.payload as { subscriptionId: string }).subscriptionId);
    await waitFor(() => released().includes(subscriptionId) && released().includes(late.subscriptionId));
    await waitFor(() =>
      spy.requests.filter((request) => request.command === "unsubscribe").every((request) => request.response?.ok === true),
    );
  });

  it("logs a release the owner never answers instead of leaving an unhandled rejection", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const spy = spiedDialer(directory);
    spy.fail = "unsubscribe";
    const lines: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const bridge = await bridgeFor(directory, { dial: spy.dial, log: (line) => lines.push(line) });
      const auth = await session(bridge);
      const opened = await readyTab(bridge, auth, ownerSession(directory));
      const done = opened.next((frame) => frame.type === "event" && frame.event.kind === "task.completed");
      opened.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-release-fails") });
      await opened.next((frame) => frame.type === "response" && frame.requestId === "run");
      await done;
      opened.socket.terminate();
      await waitFor(() => lines.some((line) => line.startsWith("ui: unsubscribe failed: request ui.release.")));
      // A rejection is reported on the next turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("forgets a subscription the owner dropped for its backlog, and tells the tab under its own request id", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const spy = spiedDialer(directory);
    const bridge = await bridgeFor(directory, { dial: spy.dial });
    const auth = await session(bridge);
    const opened = await readyTab(bridge, auth, ownerSession(directory));
    const done = opened.next((frame) => frame.type === "event" && frame.event.kind === "task.completed");
    opened.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-backlog") });
    const started = await opened.next((frame) => frame.type === "response" && frame.requestId === "run");
    const { subscriptionId } = started.type === "response" ? (started.result as { subscriptionId: string }) : { subscriptionId: "" };
    await done;
    const forwarded = spy.requests.find((request) => request.command === "run")?.id ?? "";
    expect(forwarded).not.toBe("run");

    const told = opened.next((frame) => frame.type === "response" && frame.requestId === "run");
    spy.orphan?.({ requestId: forwarded, code: "BACKLOG", message: "the subscription fell behind" });
    expect(await told).toMatchObject({ ok: false, error: { code: "BACKLOG" } });
    // No longer the tab's: ending it is refused by the bridge, not sent on.
    const refused = opened.next((frame) => frame.type === "response" && frame.requestId === "unsub");
    opened.send({ type: "request", requestId: "unsub", command: "unsubscribe", payload: { subscriptionId } });
    expect(await refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("tavi ui: UI plugins", () => {
  it("serves an enabled, approved UI plugin's document to the canvas's iframe, refuses it once disabled, and frames nothing else", async () => {
    const directory = directories.create();
    const source = directories.create();
    writeFileSync(
      join(source, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.view",
        version: "1.0.0",
        name: "Acme view",
        ui: {
          abi: "tavi.ui/1",
          contributions: [{ id: "live", title: "Browser", document: "live.html", placements: [{ slot: "chat.panel.tab" }] }],
        },
      }),
    );
    writeFileSync(join(source, "live.html"), "<!doctype html><p>acme</p>");
    for (const argv of [
      ["plugins", "install", source],
      ["plugins", "approve", "acme.view", "1.0.0"],
      ["plugins", "enable", "acme.view"],
    ]) {
      expect(await main([...argv, "--data-dir", directory], { io: quietIo })).toBe(EXIT.ok);
    }
    const handle = await startOwner(directory);
    const canvas = directories.create();
    writeFileSync(join(canvas, "index.html"), "<!doctype html><title>canvas</title>");
    mkdirSync(join(canvas, "plugins", "tavi.other"), { recursive: true });
    writeFileSync(join(canvas, "plugins", "tavi.other", "page.html"), "<!doctype html><p>never same-origin</p>");
    const bridge = await bridgeFor(directory, { staticDirectory: canvas });

    const listed = await handle.runtime.plugins.registry.list();
    const hash = listed.find((plugin) => plugin.id === "acme.view")?.versions[0]?.contentHash ?? "";
    const frame = { ...hostOf(bridge), "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
    const served = await http(bridge, "GET", `/plugin-ui/acme.view/${hash}/live.html`, frame);
    expect(served.status).toBe(200);
    expect(served.body).toContain("acme");
    expect(served.headers["x-frame-options"]).toBeUndefined();
    // Another Host is refused before the route is reached.
    expect(
      (await http(bridge, "GET", `/plugin-ui/acme.view/${hash}/live.html`, { ...frame, host: `localhost:${bridge.port}` })).status,
    ).toBe(403);

    // The canvas may frame plugin documents and nothing else, and never serves the build's plugins as its own documents.
    const page = await http(bridge, "GET", "/", {
      ...hostOf(bridge),
      "sec-fetch-site": "none",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    });
    expect(String(page.headers["content-security-policy"])).toContain(`frame-src ${bridge.origin}/plugin-ui/`);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    const leaked = await http(bridge, "GET", "/plugins/tavi.other/page.html", {
      ...hostOf(bridge),
      "sec-fetch-site": "none",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    });
    expect(leaked.body).not.toContain("never same-origin");

    await handle.runtime.plugins.registry.disable("acme.view", "operator");
    expect((await http(bridge, "GET", `/plugin-ui/acme.view/${hash}/live.html`, frame)).status).toBe(404);
  });
});

describe("tavi ui: the built-in browser view", () => {
  it("serves the canvas build's tavi.browserview under the hash the owner offers it with", async (ctx) => {
    const canvas = builtCanvasDirectory();
    if (canvas === undefined || !existsSync(join(canvas, "plugins", "tavi.browserview"))) return ctx.skip();
    const directory = directories.create();
    const handle = await startOwner(directory);
    const bridge = await bridgeFor(directory, { staticDirectory: canvas });
    const offered = (await handle.runtime.plugins.registry.list()).find((plugin) => plugin.id === "tavi.browserview");
    expect(offered).toMatchObject({ kind: "builtin", uiOnly: true });
    const hash = offered?.uiContentHash ?? "";
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const frame = { ...hostOf(bridge), "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
    const served = await http(bridge, "GET", `/plugin-ui/tavi.browserview/${hash}/live.html`, frame);
    expect(served.status).toBe(200);
    expect(served.body).toContain('src="live.js"');
    const script = await http(bridge, "GET", `/plugin-ui/tavi.browserview/${hash}/live.js`, {
      ...hostOf(bridge),
      "sec-fetch-dest": "script",
      "sec-fetch-site": "cross-site",
      origin: "null",
    });
    expect(script.status).toBe(200);
    // Disabled, the built-in is refused too.
    await handle.runtime.plugins.registry.disable("tavi.browserview", "operator");
    expect((await http(bridge, "GET", `/plugin-ui/tavi.browserview/${hash}/live.html`, frame)).status).toBe(404);
  });
});

describe("tavi ui: the live browser view", () => {
  /** An owner whose fixture browser streams frames, with the live source's watches counted. */
  async function liveOwner(directory: string) {
    const live = createBrowserLiveSource();
    const counts = { open: 0, frames: 0 };
    const watched: BrowserLivePort["watch"] = (sessionId, options, sink) => {
      counts.open += 1;
      const watch = live.watch(sessionId, options, (message) => {
        if (message.kind === "frame") counts.frames += 1;
        return sink(message);
      });
      return {
        demand: () => watch.demand(),
        close: () => {
          counts.open -= 1;
          watch.close();
        },
        ...(watch.control === undefined ? {} : { control: watch.control }),
      };
    };
    const browser = createFixtureBrowser({ live: { ...live, watch: watched }, liveFrameMs: 5 });
    const handle = await serve(
      fixtureServeOptions(directory, { defaultConnectionId: "running-conn", defaultModel: "running-model" }),
      {
        dataDirectory: directory,
        drainDeadlineMs: 5_000,
        modelTarget: { source: "default", connectionId: "running-conn", model: "running-model", workspaceId: "default" },
      },
      quietIo,
      { modelOverride: answering(), browserOverride: browser, liveOverride: { ...live, watch: watched } },
    );
    handles.push(handle);
    return { browser, counts };
  }

  /** A finished run's task, with a browser session opened for it. */
  async function taskWithSession(page: RawTab, browser: ReturnType<typeof createFixtureBrowser>): Promise<string> {
    const done = page.next((frame) => frame.type === "event" && frame.event.kind === "task.completed");
    page.send({ type: "request", requestId: "run", command: "run", payload: runPayload("ui-live") });
    const opened = await page.next((frame) => frame.type === "response" && frame.requestId === "run");
    await done;
    const taskId = opened.type === "response" ? (opened.result as { taskId: string }).taskId : "";
    await browser.createSession({ workspaceId: "default", taskId });
    return taskId;
  }

  it("counts a tab's live watches in its share of subscriptions, so a watch past it is refused", async () => {
    const directory = directories.create();
    const { browser } = await liveOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const page = await readyTab(bridge, auth, ownerSession(directory));
    const taskId = await taskWithSession(page, browser);
    // The run took one; subscriptions and watches share the rest.
    for (let index = 1; index < UI_MAX_TAB_SUBSCRIPTIONS; index += 1) {
      const answer = page.next((frame) => frame.type === "response" && frame.requestId === `open-${index}`);
      page.send(
        index % 2 === 0
          ? { type: "request", requestId: `open-${index}`, command: "subscribe", payload: { taskId } }
          : {
              type: "request",
              requestId: `open-${index}`,
              command: "browser-live",
              payload: { action: "watch", workspaceId: "default", taskId },
            },
      );
      expect(await answer).toMatchObject({ ok: true });
    }
    const over = page.next((frame) => frame.type === "response" && frame.requestId === "watch-over");
    page.send({
      type: "request",
      requestId: "watch-over",
      command: "browser-live",
      payload: { action: "watch", workspaceId: "default", taskId },
    });
    expect(await over).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("routes a watch's frames to the tab that opened it, lets only that tab ack or unwatch it, and ends it with the tab", async () => {
    const directory = directories.create();
    const { browser, counts } = await liveOwner(directory);
    const bridge = await bridgeFor(directory);
    const auth = await session(bridge);
    const first = await readyTab(bridge, auth, ownerSession(directory));
    const second = await readyTab(bridge, auth, ownerSession(directory));
    const taskId = await taskWithSession(first, browser);
    const answered = first.next((frame) => frame.type === "response" && frame.requestId === "watch");
    first.send({
      type: "request",
      requestId: "watch",
      command: "browser-live",
      payload: { action: "watch", workspaceId: "default", taskId },
    });
    const watch = await answered;
    expect(watch).toMatchObject({ ok: true });
    const subscriptionId = watch.type === "response" ? (watch.result as { subscriptionId: string }).subscriptionId : "";
    await waitFor(() => first.frames.filter((frame) => frame.type === "live" && frame.message.kind === "frame").length === 2, 5_000);
    expect(second.frames.some((frame) => frame.type === "live")).toBe(false);

    for (const action of ["ack", "unwatch"] as const) {
      const refused = second.next((frame) => frame.type === "response" && frame.requestId === `steal-${action}`);
      second.send({
        type: "request",
        requestId: `steal-${action}`,
        command: "browser-live",
        payload: { action, subscriptionId, ...(action === "ack" ? { seq: 1 } : {}) },
      });
      expect(await refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    // Every tab shares the owner connection: the bridge alone keeps a tab from taking over, or typing through, another's watch.
    const sessionId = "fixture-live-1";
    for (const [action, extra] of [
      ["take", {}],
      ["input", { seq: 0, events: [{ type: "text", text: "x" }] }],
      ["release", { outcome: "done" }],
    ] as const) {
      const refused = second.next((frame) => frame.type === "response" && frame.requestId === `steal-${action}`);
      second.send({
        type: "request",
        requestId: `steal-${action}`,
        command: "browser-live",
        payload: { action, subscriptionId, sessionId, ...extra },
      });
      expect(await refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    const took = first.next((frame) => frame.type === "response" && frame.requestId === "take");
    first.send({ type: "request", requestId: "take", command: "browser-live", payload: { action: "take", subscriptionId, sessionId } });
    expect(await took).toMatchObject({ ok: true });
    const released = first.next((frame) => frame.type === "response" && frame.requestId === "release");
    first.send({
      type: "request",
      requestId: "release",
      command: "browser-live",
      payload: { action: "release", subscriptionId, sessionId, outcome: "done" },
    });
    expect(await released).toMatchObject({ ok: true });
    const firstFrame = first.frames.find((frame) => frame.type === "live" && frame.message.kind === "frame");
    first.send({
      type: "request",
      requestId: "ack",
      command: "browser-live",
      payload: { action: "ack", subscriptionId, seq: firstFrame?.type === "live" ? firstFrame.seq : -1 },
    });
    await waitFor(() => first.frames.filter((frame) => frame.type === "live" && frame.message.kind === "frame").length === 3, 5_000);
    expect(counts.open).toBe(1);

    first.socket.close();
    await waitFor(() => counts.open === 0, 5_000);
  });

  it("drops a frame a slow tab cannot take, and acknowledges it to the owner itself so the stream goes on", async () => {
    const directory = directories.create();
    const { browser, counts } = await liveOwner(directory);
    // Every frame counts as one the tab is too slow for.
    const bridge = await bridgeFor(directory, { liveFrameDropBytes: -1 });
    const auth = await session(bridge);
    const page = await readyTab(bridge, auth, ownerSession(directory));
    const taskId = await taskWithSession(page, browser);
    const answered = page.next((frame) => frame.type === "response" && frame.requestId === "watch");
    page.send({
      type: "request",
      requestId: "watch",
      command: "browser-live",
      payload: { action: "watch", workspaceId: "default", taskId },
    });
    expect(await answered).toMatchObject({ ok: true });
    // Far past the two unacknowledged frames the owner allows: the bridge's acks kept it going.
    await waitFor(() => counts.frames > 6, 5_000);
    expect(page.frames.some((frame) => frame.type === "live" && frame.message.kind === "frame")).toBe(false);
    expect(page.frames.some((frame) => frame.type === "live" && frame.message.kind === "session")).toBe(true);
  });
});

describe("tavi ui (the command)", () => {
  it("is refused with exit 4 when the owner speaks another protocol", async () => {
    const directory = directories.create();
    mkdirSync(join(directory, "runtime"), { mode: 0o700 });
    writeFileSync(join(directory, "runtime", "ipc.token"), "token", { mode: 0o600 });
    writeFileSync(
      join(directory, "runtime", "ipc.json"),
      JSON.stringify({
        protocolVersion: IPC_PROTOCOL_VERSION + 1,
        sessionId: "s",
        endpoint: join(directory, "ipc.sock"),
        pid: process.pid,
        startedAt: "2026-09-19T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const errors: string[] = [];
    const code = await runUi(
      { dataDirectory: directory, printUrl: true },
      { stdout: () => undefined, stderr: (chunk) => errors.push(chunk) },
      { ok: EXIT.ok, unavailable: EXIT.unavailable },
    );
    expect(code).toBe(EXIT.unavailable);
    expect(errors.join("")).toContain(`speaks IPC protocol ${IPC_PROTOCOL_VERSION + 1}`);
  });

  it("parses its flags, and refuses what it does not take", async () => {
    expect(parseArgs(["ui"])).toEqual({ command: "ui", ui: { printUrl: false } });
    expect(parseArgs(["ui", "--print-url", "--port", "8123", "--data-dir", "/srv/tavi"])).toEqual({
      command: "ui",
      ui: { printUrl: true, port: 8123, dataDirectory: "/srv/tavi" },
    });
    expect(() => parseArgs(["ui", "--print-url=yes"])).toThrow(/takes no value/);
    for (const argv of [
      ["ui", "--port", "http"],
      ["ui", "--port", "70000"],
      ["ui", "--open"],
      ["ui", "extra"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow();
    }
    let shown = "";
    expect(await main(["ui", "--help"], { io: { stdout: (chunk) => void (shown += chunk), stderr: () => undefined, isTty: false } })).toBe(
      EXIT.ok,
    );
    // The usage, fitted to 80 columns as every help page is in a pipe.
    expect(shown).toBe(fittedText(UI_USAGE, 80));
    let index = "";
    await main(["help"], { io: { stdout: (chunk) => void (index += chunk), stderr: () => undefined, isTty: false } });
    expect(index).toContain("tavi ui [options]");
  });

  it("is refused with exit 4 when no owner serves the data directory", async () => {
    const errors: string[] = [];
    const code = await runUi(
      { dataDirectory: directories.create(), printUrl: true },
      { stdout: () => undefined, stderr: (chunk) => errors.push(chunk) },
      { ok: EXIT.ok, unavailable: EXIT.unavailable },
    );
    expect(code).toBe(EXIT.unavailable);
    expect(errors.join("")).toContain("start `tavi serve` first");
  });

  it("prints a one-time link with --print-url, and another for each line typed; a browser that will not open still gets one", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const printed: string[] = [];
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    let stop = (): void => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let bridge: UiBridge | undefined;
    const running = runUi(
      { dataDirectory: directory, printUrl: true },
      { stdout: (chunk) => printed.push(chunk), stderr: () => undefined, input },
      { ok: EXIT.ok, unavailable: EXIT.unavailable },
      { stopped, onListening: (listening) => (bridge = listening) },
    );
    await waitFor(() => printed.length === 1);
    expect(printed[0]).toMatch(new RegExp(`^${bridge?.origin}/#[A-Za-z0-9_-]{43}\\n$`));
    input.write("\n");
    await waitFor(() => printed.length === 2);
    expect(printed[1]).not.toBe(printed[0]);
    stop();
    expect(await running).toBe(EXIT.ok);

    const opened: string[] = [];
    const fallback: string[] = [];
    let stopAgain = (): void => undefined;
    const second = runUi(
      { dataDirectory: directory, printUrl: false },
      { stdout: (chunk) => fallback.push(chunk), stderr: () => undefined },
      { ok: EXIT.ok, unavailable: EXIT.unavailable },
      {
        stopped: new Promise<void>((resolve) => (stopAgain = resolve)),
        openBrowser: (url) => {
          opened.push(url);
          return Promise.resolve(false);
        },
      },
    );
    await waitFor(() => fallback.length === 1);
    expect(opened).toEqual([fallback[0]?.trim()]);
    stopAgain();
    expect(await second).toBe(EXIT.ok);
  });

  it("opens the link itself, then says how to keep it out of the process list on a shared computer; --print-url says nothing of it", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const opened: string[] = [];
    const notes: string[] = [];
    let stop = (): void => undefined;
    let bridge: UiBridge | undefined;
    const running = runUi(
      { dataDirectory: directory, printUrl: false },
      { stdout: () => undefined, stderr: (chunk) => notes.push(chunk) },
      { ok: EXIT.ok, unavailable: EXIT.unavailable },
      {
        stopped: new Promise<void>((resolve) => (stop = resolve)),
        onListening: (listening) => (bridge = listening),
        openBrowser: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
      },
    );
    await waitFor(() => opened.length === 1);
    expect(opened[0]).toMatch(new RegExp(`^${bridge?.origin}/#[A-Za-z0-9_-]{43}$`));
    await waitFor(() => notes.includes(SHARED_HOST_NOTE));
    expect(SHARED_HOST_NOTE).toContain("tavi ui --print-url");
    stop();
    expect(await running).toBe(EXIT.ok);

    const printedNotes: string[] = [];
    const printed: string[] = [];
    let stopPrinting = (): void => undefined;
    const printing = runUi(
      { dataDirectory: directory, printUrl: true },
      { stdout: (chunk) => printed.push(chunk), stderr: (chunk) => printedNotes.push(chunk) },
      { ok: EXIT.ok, unavailable: EXIT.unavailable },
      { stopped: new Promise<void>((resolve) => (stopPrinting = resolve)) },
    );
    await waitFor(() => printed.length === 1);
    stopPrinting();
    expect(await printing).toBe(EXIT.ok);
    expect(printedNotes).not.toContain(SHARED_HOST_NOTE);
  });
});

describe("tavi ui: the OAuth callback", () => {
  it("hands a provider's redirect to the owner with no session, and shows only whether it worked", async () => {
    const directory = directories.create();
    const forwarded: unknown[] = [];
    const owner = partialFake<Connection>({
      request: async (command: string, payload: unknown) => {
        forwarded.push({ command, payload });
        return { ok: true, result: { ok: true, message: "Connected as <ana@example.com>." } };
      },
      onOrphanResponse: () => () => undefined,
      onEvent: () => () => undefined,
      onLive: () => () => undefined,
      onClose: () => () => undefined,
      closed: false,
      sessionId: "owner-session",
      close: () => undefined,
    });
    const bridge = await bridgeFor(directory, { dial: async () => owner });
    const page = await http(bridge, "GET", "/oauth/callback?state=s-123456789012345678&code=c-1", {
      ...hostOf(bridge),
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    expect(forwarded).toEqual([{ command: "channels", payload: { action: "oauth-callback", state: "s-123456789012345678", code: "c-1" } }]);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Connected as &#60;ana@example.com&#62;.");
    expect(page.body).not.toContain("c-1");
    // Without a state, nothing is asked of the owner.
    expect((await http(bridge, "GET", "/oauth/callback?code=c-2", hostOf(bridge))).status).toBe(400);
    expect(forwarded).toHaveLength(1);
  });
});
