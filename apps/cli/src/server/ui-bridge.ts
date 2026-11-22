import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { extname, join, relative, sep } from "node:path";

import {
  FrameReader,
  IPC_MAX_FRAME_BYTES,
  IPC_MAX_MESSAGE_CHARS,
  IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES,
  IPC_PROTOCOL_VERSION,
  UI_CLOSE,
  UI_IPC_PATH,
  UI_OWNER_PATH,
  UI_SECRET_HEADER,
  UI_SESSION_COOKIE,
  UI_SESSION_PATH,
  UiSessionRequestSchema,
  PluginUiAnswerSchema,
  encodeFrame,
  isUiBridgeCommand,
  type IpcFrame,
  englishOf,
  navPath,
} from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";
import {
  CLIENT_TIMEOUT,
  nodeScheduler,
  openConnection,
  openSocket,
  readOwner,
  type ClientResponse,
  type Connection,
  type LiveFrame,
  type OrphanResponse,
  type SubscriptionEvent,
} from "@tavi/client/node";
import { assertPipeOwnedHere, privacyProblem, securityHeaders, sha256Hex } from "@tavi/node-kit";
import { WebSocketServer, type WebSocket } from "ws";

import { createPluginUiRoute } from "./plugin-ui-route.js";
import { oauthCallbackPage } from "../features/oauth/flow.js";

/** Where a provider sends the browser back after an OAuth sign-in. */
const OAUTH_CALLBACK_PATH = "/oauth/callback";

export { UI_CLOSE } from "@tavi/contracts";

/**
 * `tavi ui`'s bridge: a loopback HTTP and WebSocket server,
 * its own process, carrying IPC frames between browser tabs and the owner of a
 * data directory over **one** IPC connection.
 *
 * Hardened as a listener, because a browser is a confused deputy for every
 * site it visits:
 * - bound to `127.0.0.1` and asserted so before a URL is printed; one origin,
 *   `http://127.0.0.1:<port>`, a navigation to `localhost` redirected to it;
 * - three request classes, each with its own check — *bootstrap* (the page,
 *   its assets and its routes: `Host`, and `Sec-Fetch-Site` when present;
 *   a route is what a deep link or a refresh on one asks for),
 *   *exchange* (the one-time token for a session: `Host`, exact `Origin`) and
 *   *API and upgrade* (`Host`, exact `Origin`, the session cookie **and** its
 *   secret);
 * - one upgrade router, which destroys every upgrade it does not route;
 * - the command allowlist enforced here, whatever the page sends.
 *
 * Tabs share the IPC connection: each request is forwarded under an id the
 * bridge mints (its tab's prefix, a counter, the tab's own id), and each
 * subscription is routed to the tab that opened it. A tab that stops reading
 * is closed once its buffer passes its bound, and its subscriptions are
 * dropped — the others are untouched. A tab holds at most its share of the
 * owner's subscriptions. When the owner goes, every tab is closed; the next
 * page to ask is answered by whatever owner discovery names then.
 */

/** A one-time token's life: long enough to open a browser, short enough that a stale link is dead. */
const UI_TOKEN_TTL_MS = 60_000;
/** A session's life, from its exchange: a working day, then a new link. */
const UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Sessions held at once; the oldest is forgotten beyond this. */
const UI_MAX_SESSIONS = 32;
/** Authenticated tabs at once. */
const UI_MAX_TABS = 64;
/**
 * Tabs past the upgrade and not yet past their `hello`, at once. Apart from
 * `UI_MAX_TABS`: an upgrade needs only the cookie, which another loopback
 * server can replay, so tabs that never authenticate must not take the
 * page's places.
 */
const UI_MAX_PENDING_TABS = 8;
/**
 * Subscriptions one tab may hold, opening ones included: a quarter of what the
 * owner allows the bridge's one connection, so no tab can take them all.
 */
export const UI_MAX_TAB_SUBSCRIPTIONS = IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION / 4;
/** Bytes a tab may leave unread before it is closed: one subscription's backlog. */
const UI_TAB_BUFFER_BYTES = IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES;
/**
 * The largest WebSocket message a tab may send: one frame at the owner's own
 * bound, which admits a `run` of the longest prompt the owner accepts
 * (`IPC_MAX_PROMPT_CHARS`, escaped), so a prompt the TUI can send is not
 * refused from a browser.
 */
export const UI_MAX_MESSAGE_BYTES = IPC_MAX_FRAME_BYTES;
/**
 * A tab's unread bytes past which a live browser-view frame is dropped rather
 * than sent — and acknowledged to the owner by the bridge itself, so the
 * watch's credit is never lost. Well under
 * `UI_TAB_BUFFER_BYTES`: live traffic never closes a tab for falling behind.
 */
const UI_LIVE_FRAME_DROP_BYTES = 1024 * 1024;
/** How long a tab has to send its `hello`. */
const UI_HELLO_DEADLINE_MS = 2_000;
/** Ping period; a tab that has not answered the previous ping by the next is gone. */
const UI_HEARTBEAT_MS = 15_000;
/**
 * How long the bridge waits on the owner for a tab's request. Longer than
 * any client deadline: the page times out first and decides what to do; the
 * bridge only needs to forget a request eventually.
 */
const UI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** The largest HTTP body the bridge reads. */
export const UI_MAX_BODY_BYTES = 4 * 1024;
/** Longest request id a tab may use: the bridge's prefix fits within the contract's 128. */
const MAX_TAB_REQUEST_ID = 96;

/** The owner a bridge reaches, as it dials one; a test substitutes its own. */
export type OwnerDialer = () => Promise<Connection | undefined>;

export interface UiBridgeOptions {
  readonly dataDirectory: string;
  /** The built canvas; a placeholder page is served when it is absent. */
  readonly staticDirectory?: string;
  /** `0`, any free port, by default. */
  readonly port?: number;
  /** Connection-lifecycle lines, one per call. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly dial?: OwnerDialer;
  readonly tokenTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly tabBufferBytes?: number;
  /** A tab's unread bytes past which a live frame is dropped and acknowledged; `UI_LIVE_FRAME_DROP_BYTES` otherwise. */
  readonly liveFrameDropBytes?: number;
  readonly heartbeatMs?: number;
  readonly helloDeadlineMs?: number;
  readonly maxTabs?: number;
  readonly maxPendingTabs?: number;
  readonly maxSessions?: number;
  /**
   * The address to listen on: a test's way to see a bind that is not the
   * loopback literal refused. The bridge serves only `127.0.0.1` whatever
   * this says.
   */
  readonly listenAddress?: string;
}

export interface UiBridge {
  /** `http://127.0.0.1:<port>`: the one origin. */
  readonly origin: string;
  readonly port: number;
  /** A fresh one-time token, as the link a browser opens: `<origin>/#<token>`. */
  mintLink(): string;
  /** Tabs connected now, authenticated or not. */
  tabs(): number;
  close(): Promise<void>;
}

interface Session {
  readonly id: string;
  readonly secret: Buffer;
  readonly expiresAt: number;
  readonly tabs: Set<Tab>;
}

interface Tab {
  readonly id: number;
  readonly prefix: string;
  readonly socket: WebSocket;
  readonly session: Session;
  readonly subscriptions: Set<string>;
  /** The tab's request ids in flight. */
  readonly pending: Set<string>;
  /** Forwarded ids of the `run`/`subscribe` requests in flight, and then of the subscriptions they opened. */
  readonly opening: Set<string>;
  /** Each subscription by the forwarded id of the request that opened it: how an owner's BACKLOG drop is matched. */
  readonly openedBy: Map<string, string>;
  authenticated: boolean;
  alive: boolean;
  closed: boolean;
}

interface StaticFile {
  readonly body: Buffer;
  readonly type: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const PLACEHOLDER = Buffer.from(
  '<!doctype html><html><head><meta charset="utf-8"><title>tavi</title></head>' +
    "<body><p>The tavi web canvas is not built in this install.</p></body></html>",
);

/** The owner of `dataDirectory`, read from discovery afresh, over its socket; `log` says why there is none. */
export function discoveryDialer(dataDirectory: string, log: (line: string) => void = () => undefined): OwnerDialer {
  return async () => {
    const address = readOwner(dataDirectory, { privacyProblem });
    if (address === undefined) return undefined;
    if (address.protocolVersion !== IPC_PROTOCOL_VERSION) {
      log(`ui: the owner speaks IPC protocol ${address.protocolVersion}, this bridge ${IPC_PROTOCOL_VERSION}: restart one of them`);
      return undefined;
    }
    // On Windows: the pipe must be this account's before the cookie goes to it.
    const transport = await openSocket(address.endpoint, { verify: assertPipeOwnedHere });
    // Said so in the hello: the owner holds what a page asks of it to a stricter rule.
    return openConnection(transport, address, { scheduler: nodeScheduler, client: "bridge" });
  };
}

/** Start the bridge; resolves once it listens on the loopback address, and says so. */
export async function startUiBridge(options: UiBridgeOptions): Promise<UiBridge> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const dial = options.dial ?? discoveryDialer(options.dataDirectory, log);
  const tokenTtlMs = options.tokenTtlMs ?? UI_TOKEN_TTL_MS;
  const sessionTtlMs = options.sessionTtlMs ?? UI_SESSION_TTL_MS;
  const tabBufferBytes = options.tabBufferBytes ?? UI_TAB_BUFFER_BYTES;
  const liveFrameDropBytes = options.liveFrameDropBytes ?? UI_LIVE_FRAME_DROP_BYTES;
  const maxTabs = options.maxTabs ?? UI_MAX_TABS;
  const maxPendingTabs = options.maxPendingTabs ?? UI_MAX_PENDING_TABS;
  const maxSessions = options.maxSessions ?? UI_MAX_SESSIONS;
  const files = loadStatic(options.staticDirectory);

  /** Token digests to their expiry: a token is consumed by deleting it, in one synchronous step. */
  const tokens = new Map<string, number>();
  const sessions = new Map<string, Session>();
  const tabs = new Set<Tab>();
  /** Subscriptions to the tab that opened them. */
  const routes = new Map<string, Tab>();
  let tabCounter = 0;
  let requestCounter = 0;
  let owner: Connection | undefined;
  let dialing: Promise<Connection | undefined> | undefined;
  let closing = false;

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "internal" });
      else response.destroy();
    });
  });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: UI_MAX_MESSAGE_BYTES });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.listenAddress ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  // `listen` on a name can bind dual-stack; nothing is printed or opened until
  // the bound address is the loopback literal.
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`tavi ui bound ${JSON.stringify(address)}, not 127.0.0.1`);
  }
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;
  const cookieName = `${UI_SESSION_COOKIE}_${port}`;
  // UI plugins' documents and files.
  const pluginUi = createPluginUiRoute({
    origin,
    dataDirectory: options.dataDirectory,
    ...(options.staticDirectory === undefined ? {} : { staticDirectory: options.staticDirectory }),
    log,
    lookup: async (pluginId, contentHash) => {
      const connection = await ownerConnection();
      if (connection === undefined) return {};
      requestCounter += 1;
      const answer = await connection.request("plugins", { action: "ui", pluginId, contentHash }, `ui.plugin.${requestCounter}`);
      const parsed = answer.ok ? PluginUiAnswerSchema.safeParse(answer.result) : undefined;
      if (parsed?.success !== true) return {};
      const matches = (entry: { readonly pluginId: string; readonly contentHash: string }) =>
        entry.pluginId === pluginId && entry.contentHash === contentHash;
      return { entry: parsed.data.entries.find(matches), icons: parsed.data.icons?.find(matches) };
    },
  });
  /**
   * The canvas's policy. A page carries a nonce of its own (`withStyleNonce`):
   * the `<style>`s a Radix select's scroll lock injects name it, and no
   * other inline style is allowed — never `unsafe-inline`.
   */
  const cspWith = (styleNonce?: string): string =>
    [
      "default-src 'none'",
      "script-src 'self'",
      styleNonce === undefined ? "style-src 'self'" : `style-src 'self' 'nonce-${styleNonce}'`,
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ws://${host}`,
      // Only UI plugins' sandboxed documents may be framed, and only by the canvas.
      `frame-src ${pluginUi.frameSource}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  const csp = cspWith();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Registering an upgrade listener makes Node accept every upgrade: anything
    // not routed here is destroyed, never left open.
    if (pathOf(request) !== UI_IPC_PATH || closing) {
      socket.destroy();
      return;
    }
    const session = authorizedSession(request, false);
    if (session === undefined) {
      refuseUpgrade(socket, "401 Unauthorized");
      return;
    }
    // Full is not unauthorised: a page told 401 would ask for a new link.
    if (pendingTabs() >= maxPendingTabs || authenticatedTabs() >= maxTabs) {
      refuseUpgrade(socket, "503 Service Unavailable");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => openTab(ws, session));
  });

  const heartbeat = setInterval(() => {
    for (const tab of tabs) {
      if (!tab.alive) {
        log(`ui: tab ${tab.id} did not answer a ping; dropped`);
        forgetTab(tab);
        tab.socket.terminate();
        continue;
      }
      tab.alive = false;
      tab.socket.ping();
    }
    const at = now();
    for (const [digest, expiresAt] of tokens) if (expiresAt <= at) tokens.delete(digest);
    for (const session of sessions.values()) if (session.expiresAt <= at) endSession(session);
  }, options.heartbeatMs ?? UI_HEARTBEAT_MS);
  heartbeat.unref();

  log(`ui: listening on ${origin}`);

  function pendingTabs(): number {
    let count = 0;
    for (const tab of tabs) if (!tab.authenticated) count += 1;
    return count;
  }

  function authenticatedTabs(): number {
    return tabs.size - pendingTabs();
  }

  function refuseUpgrade(socket: Duplex, status: string): void {
    // Ended after the answer is flushed, so the client reads the status rather than a reset.
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }

  // ---- HTTP -------------------------------------------------------------

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = pathOf(request);
    const requestHost = request.headers.host;
    if (requestHost !== host) {
      // One canonical origin: a navigation to `localhost` is sent to it, fragment kept by the browser.
      if (requestHost === `localhost:${port}` && request.method === "GET" && isShell(request, path)) {
        response.writeHead(308, { location: `${origin}${request.url ?? "/"}`, "cache-control": "no-store" });
        response.end();
        return;
      }
      respond(response, 403, { error: "this host is not served" });
      return;
    }
    // A provider's OAuth redirect: ahead of the page's routes, and with no session — the
    // state it carries is the owner's to check, once.
    if (request.method === "GET" && path === OAUTH_CALLBACK_PATH) {
      await oauthCallback(request, response);
      return;
    }
    if (await pluginUi.handle(request, response, path)) return;
    if (request.method === "GET" && isShell(request, path)) {
      bootstrap(request, response, path);
      return;
    }
    if (request.method === "POST" && path === UI_SESSION_PATH) {
      await exchange(request, response);
      return;
    }
    if (request.method === "POST" && path === UI_OWNER_PATH) {
      if (authorizedSession(request, true) === undefined) {
        respond(response, 401, { error: "no session: open a new link from `tavi ui`" });
        return;
      }
      const connection = await ownerConnection();
      if (connection === undefined) {
        respond(response, 503, { error: "no tavi owner this bridge can reach is serving this data directory" });
        return;
      }
      respond(response, 200, { sessionId: connection.sessionId, protocolVersion: IPC_PROTOCOL_VERSION });
      return;
    }
    respond(response, isShell(request, path) || path === UI_SESSION_PATH || path === UI_OWNER_PATH ? 405 : 404, { error: "not found" });
  }

  /**
   * The page, one of its assets, or one of its routes — anything the canvas
   * itself answers. A GET of one is the bootstrap class; a route is served the
   * built page, so a deep link or a refresh on one works.
   */
  function isShell(request: IncomingMessage, path: string): boolean {
    return path === "/" || files.has(path) || isRoute(request, path);
  }

  /**
   * A path the build ships no file at, reached as a top-level document load:
   * `/settings/system-prompt` in the address bar, or that URL refreshed. Only
   * such a load is a route — a subresource request for the same path is still
   * a 404, and no path is ever opened on the filesystem.
   */
  function isRoute(request: IncomingMessage, path: string): boolean {
    return path !== "/" && !files.has(path) && isDocument(request);
  }

  /** A browser's top-level document load (`Sec-Fetch-*`), not a subresource. */
  function isDocument(request: IncomingMessage): boolean {
    return request.headers["sec-fetch-mode"] === "navigate" && request.headers["sec-fetch-dest"] === "document";
  }

  /**
   * Class 1: the page, its assets and its routes — no session yet, and a
   * navigation carries no `Origin`. Another site may not load them as a
   * subresource; it may link to the page or to any route, whose top-level load
   * leaks nothing to it (the page cannot be framed, and its opener is cut off).
   */
  function bootstrap(request: IncomingMessage, response: ServerResponse, path: string): void {
    const site = request.headers["sec-fetch-site"];
    const navigation = (path === "/" || isRoute(request, path)) && isDocument(request);
    if (site !== undefined && site !== "none" && site !== "same-origin" && !navigation) {
      respond(response, 403, { error: "not loaded from another site" });
      return;
    }
    // A route is answered with the built entry point; its assets are absolute
    // (`/assets/…`), so the page loads the same from any path.
    const file = files.get(path) ?? files.get("/index.html") ?? { body: PLACEHOLDER, type: CONTENT_TYPES[".html"] ?? "text/html" };
    // A page gets a fresh style nonce each time it is served; an asset is served as it is.
    const nonce = file.type.startsWith("text/html") ? randomBytes(16).toString("base64") : undefined;
    const body = nonce === undefined ? file.body : withStyleNonce(file.body, nonce);
    response.writeHead(200, {
      ...securityHeaders(nonce === undefined ? csp : cspWith(nonce), { sameOrigin: true }),
      "content-type": file.type,
      "content-length": String(body.byteLength),
    });
    response.end(body);
  }

  /** Class 2: a one-time token for a session — a new cookie and a new secret. */
  async function exchange(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== origin) {
      respond(response, 403, { error: "the exchange is made from the page only" });
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      respond(response, 413, { error: "too large" });
      return;
    }
    const parsed = UiSessionRequestSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      respond(response, 400, { error: "expected { token }" });
      return;
    }
    // Compare-and-swap in one synchronous step: of two exchanges racing for a
    // token, the first to reach this line deletes it and the other finds nothing.
    const digest = sha256Hex(parsed.data.token);
    const expiresAt = tokens.get(digest);
    tokens.delete(digest);
    if (expiresAt === undefined || expiresAt <= now()) {
      respond(response, 401, { error: "this link was used or has expired: open a new one from `tavi ui`" });
      return;
    }
    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      secret: randomBytes(32),
      expiresAt: now() + sessionTtlMs,
      tabs: new Set(),
    };
    sessions.set(session.id, session);
    while (sessions.size > maxSessions) {
      const oldest = sessions.values().next().value;
      if (oldest === undefined) break;
      endSession(oldest);
    }
    log("ui: a link was exchanged for a session");
    response.setHeader(
      "set-cookie",
      // Neither `Secure` nor the `__Host-` prefix: their handling over
      // `http://127.0.0.1` differs between engines, and nothing here depends on
      // them — the secret is what authenticates.
      `${cookieName}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    );
    respond(response, 200, { secret: session.secret.toString("base64url") });
  }

  /**
   * Class 3: exact `Host` and `Origin` (absent is refused: it closes
   * cross-site WebSocket hijacking), and a live session by its cookie. With
   * `withSecret`, the secret must be in its header too; an upgrade presents it
   * in its `hello` instead.
   */
  function authorizedSession(request: IncomingMessage, withSecret: boolean): Session | undefined {
    if (request.headers.host !== host || request.headers.origin !== origin) return undefined;
    const session = sessionFromCookie(request.headers.cookie);
    if (session === undefined) return undefined;
    if (!withSecret) return session;
    const presented = request.headers[UI_SECRET_HEADER];
    return typeof presented === "string" && secretMatches(session, presented) ? session : undefined;
  }

  function sessionFromCookie(header: string | undefined): Session | undefined {
    if (header === undefined) return undefined;
    // Cookies are not isolated by port: another loopback server may set one of
    // this name too, so every value is tried.
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== cookieName) continue;
      const session = sessions.get(rest.join("="));
      if (session === undefined) continue;
      if (session.expiresAt <= now()) {
        endSession(session);
        continue;
      }
      return session;
    }
    return undefined;
  }

  /** Hands the redirect's state and code to the owner, and shows only whether it worked. */
  async function oauthCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const query = new URL(request.url ?? "/", origin).searchParams;
    // Held to what the owner takes, so an over-long value is refused here rather than by the owner's schema.
    const state = query.get("state")?.slice(0, 128) ?? null;
    const code = query.get("code")?.slice(0, 4096) ?? null;
    const error = query.get("error")?.slice(0, 256) ?? null;
    const iss = query.get("iss")?.slice(0, 512) ?? null;
    let outcome: { readonly ok: boolean; readonly message: string } = { ok: false, message: "This sign-in link is no longer valid." };
    if (state !== null) {
      const connection = await ownerConnection();
      if (connection === undefined)
        outcome = { ok: false, message: "No tavi owner is serving this data directory: start `tavi serve` and connect again." };
      else {
        requestCounter += 1;
        try {
          const answer = await connection.request(
            "channels",
            {
              action: "oauth-callback",
              state,
              ...(code === null ? {} : { code }),
              ...(error === null ? {} : { error }),
              ...(iss === null ? {} : { iss }),
            },
            `ui.oauth.${requestCounter}`,
          );
          const result = answer.ok ? (answer.result as { ok?: unknown; message?: unknown }) : undefined;
          if (result !== undefined && typeof result.ok === "boolean" && typeof result.message === "string")
            outcome = { ok: result.ok, message: result.message };
        } catch {
          outcome = {
            ok: false,
            message: `The owner did not answer; connect again from ${englishOf(navPath("nav.route.settings", "nav.settings.channels"))}.`,
          };
        }
      }
    }
    const page = oauthCallbackPage(outcome);
    response.writeHead(page.status, page.headers);
    response.end(page.body);
  }

  function respond(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      ...securityHeaders(csp, { sameOrigin: true }),
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
    });
    response.end(text);
  }

  // ---- The owner --------------------------------------------------------

  /** The owner's connection, dialled afresh — discovery re-read — when there is none. */
  function ownerConnection(): Promise<Connection | undefined> {
    if (owner !== undefined && !owner.closed) return Promise.resolve(owner);
    dialing ??= dial()
      // An owner that cannot be dialled reads as none: each request then answers that it is not running.
      .catch(() => undefined)
      .then((connection) => {
        dialing = undefined;
        if (connection === undefined) return undefined;
        if (closing) {
          connection.close();
          return undefined;
        }
        adopt(connection);
        return connection;
      });
    return dialing;
  }

  function adopt(connection: Connection): void {
    owner = connection;
    log(`ui: connected to the owner (session ${connection.sessionId})`);
    connection.onEvent((event: SubscriptionEvent) => {
      const tab = routes.get(event.subscriptionId);
      // Validated as the connection read it: passed on as it is.
      if (tab !== undefined) sendTrusted(tab, { type: "event", subscriptionId: event.subscriptionId, event: event.event });
    });
    connection.onLive((frame: LiveFrame) => {
      const tab = routes.get(frame.subscriptionId);
      if (tab === undefined || tab.closed) return;
      // A slow tab skips a frame instead of filling its socket: the bridge
      // acknowledges it to the owner itself, so the next one still comes.
      if (frame.message.kind === "frame" && tab.socket.bufferedAmount > liveFrameDropBytes) {
        requestCounter += 1;
        requestInBackground(
          connection,
          "browser-live",
          { action: "ack", subscriptionId: frame.subscriptionId, seq: frame.seq },
          `ui.live-ack.${requestCounter}`,
        );
        return;
      }
      sendTrusted(tab, { type: "live", subscriptionId: frame.subscriptionId, seq: frame.seq, message: frame.message });
    });
    connection.onOrphanResponse((orphan: OrphanResponse) => {
      // A subscription's BACKLOG drop, under the id of the request that opened it.
      const tab = tabOfRequest(orphan.requestId);
      if (tab === undefined) return;
      const dropped = tab.openedBy.get(orphan.requestId);
      if (dropped !== undefined) forgetSubscription(tab, dropped);
      sendTrusted(tab, {
        type: "response",
        requestId: tabRequestId(tab, orphan.requestId),
        ok: false,
        error: { code: orphan.code, message: orphan.message },
      });
    });
    connection.onClose(() => {
      if (owner === connection) owner = undefined;
      routes.clear();
      log("ui: the owner's connection closed; tabs reconnect to whichever owner is serving");
      for (const tab of [...tabs]) closeTab(tab, UI_CLOSE.ownerGone, "the owner went away");
    });
  }

  function tabOfRequest(forwardedId: string): Tab | undefined {
    for (const tab of tabs) if (forwardedId.startsWith(tab.prefix)) return tab;
    return undefined;
  }

  /** A forwarded id back to the tab's own: `<prefix><n>.<id>` → `<id>`. */
  function tabRequestId(tab: Tab, forwardedId: string): string {
    const rest = forwardedId.slice(tab.prefix.length);
    return rest.slice(rest.indexOf(".") + 1);
  }

  // ---- Tabs -------------------------------------------------------------

  function openTab(socket: WebSocket, session: Session): void {
    tabCounter += 1;
    const tab: Tab = {
      id: tabCounter,
      prefix: `ui${tabCounter}.`,
      socket,
      session,
      subscriptions: new Set(),
      pending: new Set(),
      opening: new Set(),
      openedBy: new Map(),
      authenticated: false,
      alive: true,
      closed: false,
    };
    tabs.add(tab);
    session.tabs.add(tab);
    log(`ui: tab ${tab.id} connected`);
    const reader = new FrameReader();
    const deadline = setTimeout(() => {
      if (!tab.authenticated) closeTab(tab, UI_CLOSE.unauthenticated, "no hello");
    }, options.helloDeadlineMs ?? UI_HELLO_DEADLINE_MS);
    deadline.unref();
    socket.on("pong", () => {
      tab.alive = true;
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (tab.closed) return;
      if (isBinary) {
        closeTab(tab, 1003, "text frames only");
        return;
      }
      const { frames, error } = reader.push(data);
      for (const frame of frames) {
        if (tab.closed) return;
        // One tab's failure is its own: it is closed, the bridge and the other tabs go on.
        receive(tab, frame).catch((failure: unknown) => {
          log(`ui: tab ${tab.id}: ${errorMessage(failure)}`);
          closeTab(tab, UI_CLOSE.internal, "internal error");
        });
      }
      if (error !== undefined) closeTab(tab, 1007, "not a frame");
    });
    socket.on("close", (code: number) => {
      clearTimeout(deadline);
      forgetTab(tab);
      log(`ui: tab ${tab.id} closed (${code})`);
    });
    socket.on("error", () => undefined);
  }

  async function receive(tab: Tab, frame: IpcFrame): Promise<void> {
    if (!tab.authenticated) {
      if (frame.type !== "hello" || !secretMatches(tab.session, frame.token)) {
        closeTab(tab, UI_CLOSE.unauthenticated, "not authenticated");
        return;
      }
      // A page of another build: refused as the owner refuses one.
      if (frame.protocolVersion !== IPC_PROTOCOL_VERSION) {
        closeTab(tab, 1002, `this bridge speaks IPC protocol ${IPC_PROTOCOL_VERSION}`);
        return;
      }
      if (tab.session.expiresAt <= now()) {
        closeTab(tab, UI_CLOSE.sessionExpired, "the session expired");
        return;
      }
      const connection = await ownerConnection();
      if (tab.closed) return;
      // Another session than the page found: the owner restarted since; the
      // page asks the bridge again.
      if (connection === undefined || frame.sessionId !== connection.sessionId) {
        closeTab(tab, UI_CLOSE.ownerGone, "no such owner");
        return;
      }
      if (authenticatedTabs() >= maxTabs) {
        closeTab(tab, UI_CLOSE.busy, "too many tabs");
        return;
      }
      tab.authenticated = true;
      send(tab, {
        type: "ready",
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionId: connection.sessionId,
        features: connection.features.filter(isUiBridgeCommand),
      });
      return;
    }
    if (frame.type !== "request") {
      closeTab(tab, 1008, `a tab sends requests, not ${frame.type}`);
      return;
    }
    const answer = (response: ClientResponse): void =>
      send(tab, {
        type: "response",
        requestId: frame.requestId,
        ok: response.ok,
        ...(response.result === undefined ? {} : { result: response.result }),
        ...(response.error === undefined ? {} : { error: response.error }),
      });
    if (!isUiBridgeCommand(frame.command)) {
      answer({ ok: false, error: { code: "NOT_AUTHORIZED", message: `${frame.command} is not available through tavi ui` } });
      return;
    }
    if (frame.requestId.length > MAX_TAB_REQUEST_ID || tab.pending.has(frame.requestId)) {
      answer({ ok: false, error: { code: "INVALID_INPUT", message: "a request id must be unique on the tab and at most 96 characters" } });
      return;
    }
    const connection = owner;
    if (connection === undefined || connection.closed) {
      answer({ ok: false, error: { code: "DISCONNECTED", message: "the owner went away" } });
      return;
    }
    const liveAction = frame.command === "browser-live" ? (frame.payload as { action?: unknown } | undefined)?.action : undefined;
    if (frame.command === "unsubscribe" || (frame.command === "browser-live" && liveAction !== "watch")) {
      const subscriptionId = (frame.payload as { subscriptionId?: unknown } | undefined)?.subscriptionId;
      // A tab ends — or acknowledges frames on — only its own subscriptions.
      if (typeof subscriptionId !== "string" || !tab.subscriptions.has(subscriptionId)) {
        answer({ ok: false, error: { code: "NOT_FOUND", message: "no such subscription on this tab" } });
        return;
      }
    }
    requestCounter += 1;
    // Minted by the bridge, never reused: a late answer to a timed-out request
    // cannot settle a later one that reused the tab's id.
    const forwardedId = `${tab.prefix}${requestCounter}.${frame.requestId}`;
    // A live browser-view watch opens a subscription as `run` and `subscribe` do.
    const opens = frame.command === "run" || frame.command === "subscribe" || liveAction === "watch";
    if (opens) {
      if (tab.opening.size >= UI_MAX_TAB_SUBSCRIPTIONS) {
        answer({
          ok: false,
          error: { code: "UNAVAILABLE", message: `a tab holds at most ${UI_MAX_TAB_SUBSCRIPTIONS} subscriptions: end one first` },
        });
        return;
      }
      tab.opening.add(forwardedId);
    }
    tab.pending.add(frame.requestId);
    // Synchronously, as the answer is read: a new subscription's held events
    // follow it in the same chunk, and must find their route.
    const onResponse = (response: ClientResponse): void => {
      tab.pending.delete(frame.requestId);
      const opened = opens ? openedSubscription(response) : undefined;
      if (opens && opened === undefined) tab.opening.delete(forwardedId);
      if (opened !== undefined) {
        if (tab.closed) {
          release(connection, opened);
        } else {
          tab.subscriptions.add(opened);
          tab.openedBy.set(forwardedId, opened);
          routes.set(opened, tab);
        }
      }
      if ((frame.command === "unsubscribe" || liveAction === "unwatch") && response.ok) {
        forgetSubscription(tab, (frame.payload as { subscriptionId: string }).subscriptionId);
      }
      if (!tab.closed) answer(response);
    };
    const settled = await connection
      .request(frame.command, frame.payload, forwardedId, { timeoutMs: UI_REQUEST_TIMEOUT_MS, onResponse })
      .catch(
        (error: unknown): ClientResponse => ({
          ok: false,
          error: { code: "INVALID_INPUT", message: clip(errorMessage(error), IPC_MAX_MESSAGE_CHARS) },
        }),
      );
    // Past the bridge's deadline the tab's id is free again; a late answer still reaches the tab.
    if (!settled.ok && settled.error?.code === CLIENT_TIMEOUT) tab.pending.delete(frame.requestId);
    else if (tab.pending.delete(frame.requestId)) {
      if (opens) tab.opening.delete(forwardedId);
      if (!tab.closed) answer(settled);
    }
  }

  function forgetSubscription(tab: Tab, subscriptionId: string): void {
    tab.subscriptions.delete(subscriptionId);
    routes.delete(subscriptionId);
    for (const [forwardedId, opened] of tab.openedBy) {
      if (opened !== subscriptionId) continue;
      tab.openedBy.delete(forwardedId);
      tab.opening.delete(forwardedId);
    }
  }

  /** Write a frame this bridge built to a tab, through the contract's encoder. */
  function send(tab: Tab, frame: IpcFrame): void {
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame);
    } catch (error) {
      log(`ui: tab ${tab.id}: a frame broke the contract: ${errorMessage(error)}`);
      closeTab(tab, UI_CLOSE.internal, "internal error");
      return;
    }
    write(tab, bytes);
  }

  /** Write a frame the owner sent, already validated as the connection read it. */
  function sendTrusted(tab: Tab, frame: IpcFrame): void {
    write(tab, Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
  }

  /** Send bytes to a tab; one that has left more than its bound unread is closed instead. */
  function write(tab: Tab, bytes: Uint8Array): void {
    if (tab.closed) return;
    if (tab.socket.bufferedAmount + bytes.byteLength > tabBufferBytes) {
      log(`ui: tab ${tab.id} fell behind by ${tab.socket.bufferedAmount} bytes; its subscriptions are dropped`);
      closeTab(tab, UI_CLOSE.fallingBehind, "falling behind");
      return;
    }
    tab.socket.send(bytes, { binary: false });
  }

  function closeTab(tab: Tab, code: number, reason: string): void {
    if (tab.closed) return;
    forgetTab(tab);
    tab.socket.close(code, reason);
    // A tab that does not answer the closing handshake is not waited on.
    setTimeout(() => tab.socket.terminate(), 1_000).unref();
  }

  /** Drop a tab's routes, and its subscriptions at the owner: nobody reads them now. */
  function forgetTab(tab: Tab): void {
    if (tab.closed) return;
    tab.closed = true;
    tabs.delete(tab);
    tab.session.tabs.delete(tab);
    const connection = owner;
    for (const subscriptionId of tab.subscriptions) {
      routes.delete(subscriptionId);
      if (connection !== undefined) release(connection, subscriptionId);
    }
    tab.subscriptions.clear();
    tab.openedBy.clear();
  }

  function release(connection: Connection, subscriptionId: string): void {
    requestCounter += 1;
    requestInBackground(connection, "unsubscribe", { subscriptionId }, `ui.release.${requestCounter}`);
  }

  /**
   * A request nobody awaits (an acknowledgement, a release): a timeout or a
   * refused id is logged, never left as an unhandled rejection that would end
   * the `tavi ui` process.
   */
  function requestInBackground(connection: Connection, command: string, payload: unknown, requestId: string): void {
    connection.request(command, payload, requestId).catch((error: unknown) => {
      log(`ui: ${command} failed: ${errorMessage(error)}`);
    });
  }

  function endSession(session: Session): void {
    sessions.delete(session.id);
    for (const tab of [...session.tabs]) closeTab(tab, UI_CLOSE.sessionExpired, "the session ended");
  }

  return {
    origin,
    port,
    mintLink() {
      const token = randomBytes(32).toString("base64url");
      tokens.set(sha256Hex(token), now() + tokenTtlMs);
      return `${origin}/#${token}`;
    },
    tabs: () => tabs.size,
    async close() {
      closing = true;
      clearInterval(heartbeat);
      for (const tab of [...tabs]) closeTab(tab, 1001, "tavi ui is stopping");
      for (const client of sockets.clients) client.terminate();
      owner?.close();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The subscription a `run` or `subscribe` answer opened, if any. */
function openedSubscription(response: ClientResponse): string | undefined {
  if (!response.ok) return undefined;
  const id = (response.result as { subscriptionId?: unknown } | undefined)?.subscriptionId;
  return typeof id === "string" ? id : undefined;
}

function secretMatches(session: Session, presented: string): boolean {
  const given = Buffer.from(presented, "base64url");
  return given.byteLength === session.secret.byteLength && timingSafeEqual(given, session.secret);
}

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? "/";
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The request's body, or `undefined` once it passes `UI_MAX_BODY_BYTES`. */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.byteLength;
      if (size > UI_MAX_BODY_BYTES) {
        // Read to its end, unkept, so the answer reaches the client.
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * The built canvas, read once at startup into a map of URL paths: only these
 * files are ever served, and a route — a path the map does not hold, reached
 * as a document — is answered with the entry point already in it. No
 * request path reaches the filesystem.
 */
function loadStatic(directory: string | undefined): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  if (directory === undefined || !existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    // Built-in UI plugins ship in the build, but are served only under
    // `/plugin-ui/`, never as same-origin canvas documents.
    if (entry === "plugins" || entry.startsWith(`plugins${sep}`)) continue;
    const path = join(directory, entry);
    if (!statSync(path).isFile()) continue;
    const type = CONTENT_TYPES[extname(path).toLowerCase()];
    if (type === undefined) continue;
    files.set(`/${relative(directory, path).split(sep).join("/")}`, { body: readFileSync(path), type });
  }
  return files;
}

/** `page` with `<meta name="csp-nonce">` naming `nonce`, before `</head>`: the canvas hands it to what injects a style at start. */
function withStyleNonce(page: Buffer, nonce: string): Buffer {
  return Buffer.from(page.toString("utf8").replace(/<\/head>/i, `<meta name="csp-nonce" content="${nonce}"></head>`), "utf8");
}
