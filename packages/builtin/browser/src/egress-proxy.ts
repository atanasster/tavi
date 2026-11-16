import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { errorMessage } from "@tavi/contracts/util";

/**
 * The browser's egress proxy: every connection Chromium makes goes through
 * it (`--proxy-server`, loopback included), so every request a page, a frame,
 * a worker, a service worker, a prefetch or a prerender makes — and every
 * redirect hop, WebSocket and WebRTC relay — is checked where it leaves, not
 * where a page could hide it. `check` names the addresses to connect to for a
 * host, resolved and checked once; the proxy connects to those addresses, in
 * order, and never resolves the name again, so a name that answers
 * differently later (DNS rebinding) reaches only what was checked. A refusal
 * is a 403.
 *
 * It listens on 127.0.0.1 on a port of its own, one per browser, and answers
 * only a client that presents its credentials (`Proxy-Authorization`), which
 * the browser is launched with: another local process cannot use it.
 */

/** Where the proxy may connect for `host:port`: the checked addresses, in order, or why not. */
export type EgressCheck = (
  host: string,
  port: number,
) => Promise<{ readonly addresses: readonly string[] } | { readonly address: string } | { readonly refused: string }>;

/** A connection the proxy refused: the host and why — never the full URL. */
export interface EgressRefusal {
  readonly host: string;
  readonly reason: string;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The credentials the browser presents (Playwright's `proxy.username` and `proxy.password`). */
  readonly username: string;
  readonly password: string;
  /** A URL whose request the proxy answers itself: what shows a launched browser's traffic reaches it. */
  canaryUrl(): string;
  /** Whether a request for `url` (from `canaryUrl`) reached the proxy. */
  canarySeen(url: string): boolean;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  /** How long a connection to the checked address may take; 30 s by default. */
  readonly connectTimeoutMs?: number;
  /** At most this many client connections at once; 512 by default. */
  readonly maxConnections?: number;
}

/** The canary's host: `.invalid` never resolves, so only this proxy can answer it. */
const CANARY_HOST = "tavi-egress-canary.invalid";
/** Headers about one hop, which the next hop never sees (with every header `Connection` names). */
const HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * `host` and `port` of an authority (`example.com:80`, `[::1]:8080`, `example.com`), split by hand: the
 * port as given, `fallback` only when none is.
 */
export function splitAuthority(authority: string, fallback: number): { readonly host: string; readonly port: number } | undefined {
  let host: string;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return undefined;
    host = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return undefined;
    portText = rest === "" ? undefined : rest.slice(1);
    if (isIP(host) !== 6) return undefined;
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0 && authority.indexOf(":") !== colon) return undefined;
    host = colon < 0 ? authority : authority.slice(0, colon);
    portText = colon < 0 ? undefined : authority.slice(colon + 1);
  }
  if (host === "" || /[\s/?#@]/.test(host)) return undefined;
  if (portText === undefined) return { host, port: fallback };
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  return port > 0 && port <= 65_535 ? { host, port } : undefined;
}

/** The request's headers for the next hop: every hop-by-hop header gone, and the absolute URL's host as `Host`. */
export function forwardedHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const named = new Set(
    String(headers["connection"] ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_HEADERS.has(lower) || named.has(lower)) continue;
    kept[lower] = value;
  }
  kept["host"] = host;
  return kept;
}

/** An answer's raw headers for the client: every hop-by-hop header gone (and every header `Connection` names). */
function responseHeaders(raw: readonly string[]): string[] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index]!, raw[index + 1]!]);
  const named = new Set(
    pairs
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(",").map((name) => name.trim().toLowerCase())),
  );
  return pairs.filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()) && !named.has(name.toLowerCase())).flat();
}

/** Starts the proxy; `onRefused` hears each refusal. */
export async function startEgressProxy(
  check: EgressCheck,
  onRefused: (refusal: EgressRefusal) => void,
  options: EgressProxyOptions = {},
): Promise<EgressProxy> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const username = `tavi-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const canaries = new Set<string>();
  const sockets = new Set<Duplex>();
  let closing = false;
  let ownPort = 0;

  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  /** A request that presents the proxy's credentials. */
  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(String(request.headers["proxy-authorization"] ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  /** The checked addresses for `host:port`, or the refusal said and `undefined`. */
  const target = async (host: string, port: number): Promise<readonly string[] | undefined> => {
    let decided: Awaited<ReturnType<EgressCheck>>;
    try {
      decided = await check(host, port);
    } catch (error) {
      decided = { refused: `the address could not be checked: ${errorMessage(error)}` };
    }
    const addresses = "refused" in decided ? [] : "addresses" in decided ? decided.addresses : [decided.address];
    // The proxy itself is never a destination, whatever the check allowed.
    const self = addresses.some(
      (address) => port === ownPort && (address === "127.0.0.1" || address === "::1" || address.startsWith("127.")),
    );
    if ("refused" in decided || addresses.length === 0 || self) {
      onRefused({
        host: `${host}:${String(port)}`,
        reason: "refused" in decided ? decided.refused : self ? "the browser's own egress proxy" : "no address to connect to",
      });
      return undefined;
    }
    return addresses;
  };
  /** A connection to the first of `addresses` that answers within the timeout, or `undefined`. */
  const dial = async (addresses: readonly string[], port: number): Promise<Socket | undefined> => {
    for (const address of addresses) {
      if (closing) return undefined;
      const socket = track(connect({ host: address, port }));
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), connectTimeoutMs);
        timer.unref();
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (connected && !closing) return socket;
      socket.destroy();
    }
    return undefined;
  };
  /** A client that left: closed, or (the server keeps half-open sockets) one that ended its side. */
  const gone = (socket: Duplex): boolean => socket.destroyed || socket.readableEnded;
  /** Two sockets bound: either ending or failing ends the other. */
  const splice = (client: Duplex, upstream: Duplex): void => {
    const end = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.once("close", end);
    upstream.once("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const refuseSocket = (socket: Duplex, status: string, reason: string): void => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = `${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n${status.startsWith("407") ? 'Proxy-Authenticate: Basic realm="tavi"\r\n' : ""}\r\n${body}`,
    );
  };
  const refuseResponse = (response: ServerResponse, status: number, reason: string): void => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response
      .writeHead(status, {
        "Content-Type": "text/plain",
        Connection: "close",
        ...(status === 407 ? { "Proxy-Authenticate": 'Basic realm="tavi"' } : {}),
      })
      .end(`${reason}\n`);
  };

  const server: Server = createServer((request, response) => {
    if (!authorized(request)) return refuseResponse(response, 407, "Proxy authentication required");
    // A plain http:// request through the proxy: its URL is absolute.
    const url = URL.parse(request.url ?? "");
    if (url === null || url.protocol !== "http:") return refuseResponse(response, 400, "An absolute http:// URL is required");
    if (url.hostname === CANARY_HOST) {
      canaries.add(url.href);
      response.writeHead(204).end();
      return;
    }
    const authority = splitAuthority(url.host, 80);
    if (authority === undefined) return refuseResponse(response, 400, "No host to connect to");
    void (async () => {
      const addresses = await target(authority.host, authority.port);
      if (response.destroyed || closing) return;
      if (addresses === undefined) return refuseResponse(response, 403, "Refused by the owner's browser address rule");
      const upstreamSocket = await dial(addresses, authority.port);
      if (response.destroyed || closing) {
        upstreamSocket?.destroy();
        return;
      }
      if (upstreamSocket === undefined) return refuseResponse(response, 502, "Bad gateway");
      // The connection made to a checked address, and no other: no pool shared across hosts.
      const outgoing = httpRequest({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardedHeaders(request.headers, url.host),
        setHost: false,
        createConnection: () => upstreamSocket,
      });
      outgoing.once("response", (upstream) => {
        upstream.once("aborted", () => response.destroy());
        upstream.once("error", () => response.destroy());
        response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, responseHeaders(upstream.rawHeaders));
        upstream.pipe(response);
      });
      outgoing.once("error", () => refuseResponse(response, 502, "Bad gateway"));
      response.once("close", () => {
        outgoing.destroy();
        upstreamSocket.destroy();
      });
      request.pipe(outgoing);
    })();
  });

  // https://, wss:// and anything else Chromium tunnels: checked by host, connected to a checked address.
  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    if (!authorized(request)) return refuseSocket(client, "407 Proxy Authentication Required", "Proxy authentication required");
    const authority = splitAuthority(request.url ?? "", 443);
    if (authority === undefined) return refuseSocket(client, "400 Bad Request", "No host to connect to");
    // Read while the host is checked, so a client that leaves is seen leaving; what it sent early goes on after.
    const early: Buffer[] = [head];
    const hold = (chunk: Buffer): void => void early.push(chunk);
    client.on("data", hold);
    void (async () => {
      const addresses = await target(authority.host, authority.port);
      if (gone(client) || closing) {
        client.destroy();
        return;
      }
      if (addresses === undefined) return refuseSocket(client, "403 Forbidden", "Refused by the owner's browser address rule");
      const upstream = await dial(addresses, authority.port);
      if (gone(client) || closing) {
        client.destroy();
        upstream?.destroy();
        return;
      }
      if (upstream === undefined) return refuseSocket(client, "502 Bad Gateway", "Bad gateway");
      client.off("data", hold);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      for (const chunk of early) if (chunk.length > 0) upstream.write(chunk);
      splice(client, upstream);
    })();
  });

  // Chromium sends a WebSocket through a proxy as a CONNECT tunnel: an Upgrade sent to the proxy itself is refused.
  server.on("upgrade", (_request: IncomingMessage, client: Duplex) => {
    track(client);
    refuseSocket(client, "405 Method Not Allowed", "Upgrade through the proxy is not supported");
  });
  server.on("connection", (socket) => track(socket));
  server.maxConnections = options.maxConnections ?? 512;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  ownPort = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(ownPort)}`,
    username,
    password,
    canaryUrl: () => `http://${CANARY_HOST}/${randomBytes(8).toString("hex")}`,
    canarySeen: (url) => canaries.has(url),
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Playwright's `proxy` for the browser: all traffic through it, loopback too
 * (Playwright puts `<-loopback>` in the bypass list), with its credentials.
 */
export function egressProxyOption(proxy: EgressProxy): { readonly server: string; readonly username: string; readonly password: string } {
  return { server: proxy.url, username: proxy.username, password: proxy.password };
}

/**
 * The launch flags beside the proxy: WebRTC only over the proxy (no direct
 * UDP, so no STUN or TURN around it), and no QUIC, which a proxy cannot carry.
 * On Windows also: no name is resolved here, only by the proxy (a prefetch or
 * a preconnect would otherwise ask the network's resolver around it), and no
 * server is allowed integrated Windows authentication (the allowlist names a
 * host that cannot exist), which would hand an intranet site that asks this
 * account's Kerberos or NTLM credentials.
 */
export function egressLaunchArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  const common = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"];
  if (platform !== "win32") return common;
  return [...common, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--auth-server-allowlist=tavi-none.invalid"];
}

/**
 * Whether `url` is a `file:` URL naming a network share (`file://server/share`,
 * `file:////server/share`, `file:///\\server\share`, which a URL parser reads
 * as a path starting with two or more slashes): opening one would connect to
 * that server over SMB, around the proxy, and on Windows offer it this
 * account's credentials.
 */
export function namesNetworkShare(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return false;
  return (parsed.hostname !== "" && parsed.hostname !== "localhost") || parsed.pathname.startsWith("//");
}
