import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer } from "node:net";

import { listenLocally } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  egressLaunchArgs,
  forwardedHeaders,
  namesNetworkShare,
  splitAuthority,
  startEgressProxy,
  type EgressCheck,
  type EgressProxy,
  type EgressRefusal,
} from "../src/egress-proxy.js";

/**
 * The egress proxy without a browser: raw requests on a socket, an upstream
 * on this machine that the check names for test hosts.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** An HTTP upstream that records each request's headers. */
async function upstream(): Promise<{ readonly port: number; readonly seen: IncomingMessage["headers"][] }> {
  const seen: IncomingMessage["headers"][] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { "Content-Type": "text/plain", Connection: "keep-alive, X-Hop", "X-Hop": "1" }).end("upstream");
  });
  const port = await listenLocally(server);
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { port, seen };
}

async function proxyWith(check: EgressCheck, refused: EgressRefusal[] = [], options = {}): Promise<EgressProxy> {
  const proxy = await startEgressProxy(check, (refusal) => refused.push(refusal), options);
  closers.push(() => proxy.close());
  return proxy;
}

const auth = (proxy: EgressProxy): string =>
  `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`;

/** Sends `text` to the proxy and reads until it closes (or `until` matches), with a deadline. */
async function exchange(proxy: EgressProxy, text: string, until?: RegExp): Promise<string> {
  const port = Number(new URL(proxy.url).port);
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let got = "";
    const done = (): void => {
      socket.destroy();
      resolve(got);
    };
    const timer = setTimeout(done, 3_000);
    socket.on("data", (chunk) => {
      got += chunk.toString();
      if (until?.test(got) === true) {
        clearTimeout(timer);
        done();
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(got);
    });
    socket.on("error", () => undefined);
    socket.write(text);
  });
}

describe("the egress proxy's authority parsing", () => {
  it("keeps the port given, IPv6 brackets included, and the fallback only when none is", () => {
    expect(splitAuthority("app.test:80", 443)).toEqual({ host: "app.test", port: 80 });
    expect(splitAuthority("app.test", 443)).toEqual({ host: "app.test", port: 443 });
    expect(splitAuthority("[::1]:8080", 443)).toEqual({ host: "::1", port: 8080 });
    expect(splitAuthority("[2001:db8::1]", 443)).toEqual({ host: "2001:db8::1", port: 443 });
    for (const bad of ["", ":80", "a:b:c", "[::1", "[::1]x", "app.test:0", "app.test:70000", "app.test:8a", "user@app.test:80"])
      expect(splitAuthority(bad, 443), bad).toBeUndefined();
  });
});

describe("the egress proxy", () => {
  it("checks a CONNECT by the port it names: a WebSocket's port 80 is dialled as 80", async () => {
    const asked: [string, number][] = [];
    const proxy = await proxyWith(async (host, port) => {
      asked.push([host, port]);
      return { refused: "test" };
    });
    await exchange(proxy, `CONNECT app.test:80 HTTP/1.1\r\nHost: app.test:80\r\n${auth(proxy)}\r\n`, /\r\n\r\n/);
    await exchange(proxy, `CONNECT app.test HTTP/1.1\r\nHost: app.test\r\n${auth(proxy)}\r\n`, /\r\n\r\n/);
    expect(asked).toEqual([
      ["app.test", 80],
      ["app.test", 443],
    ]);
  });

  it("answers only a client with its credentials", async () => {
    const proxy = await proxyWith(async () => ({ addresses: ["127.0.0.1"] }));
    expect(await exchange(proxy, "GET http://app.test/ HTTP/1.1\r\nHost: app.test\r\n\r\n", /\r\n\r\n/)).toMatch(/^HTTP\/1\.1 407/);
    expect(
      await exchange(
        proxy,
        "CONNECT app.test:443 HTTP/1.1\r\nHost: app.test:443\r\nProxy-Authorization: Basic d3Jvbmc6d3Jvbmc=\r\n\r\n",
        /\r\n\r\n/,
      ),
    ).toMatch(/^HTTP\/1\.1 407/);
  });

  it("forwards a request with no hop-by-hop header, nor any Connection names, and the absolute URL's host as Host", async () => {
    const target = await upstream();
    const proxy = await proxyWith(async () => ({ addresses: ["127.0.0.1"] }));
    const answer = await exchange(
      proxy,
      `GET http://app.test:${String(target.port)}/page HTTP/1.1\r\nHost: evil.test\r\n${auth(proxy)}Connection: close, X-Secret\r\nX-Secret: 1\r\nUpgrade: h2c\r\nTE: trailers\r\nKeep-Alive: 5\r\nX-Kept: yes\r\n\r\n`,
      /upstream/,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    // A header the upstream's Connection names is about its hop only.
    expect(answer).not.toMatch(/X-Hop/i);
    const [headers] = target.seen;
    expect(headers?.["host"]).toBe(`app.test:${String(target.port)}`);
    expect(headers?.["x-kept"]).toBe("yes");
    for (const name of ["x-secret", "upgrade", "te", "keep-alive", "proxy-authorization"]) expect(headers?.[name], name).toBeUndefined();
    expect(
      forwardedHeaders({ connection: "x-a, x-b", "x-a": "1", "x-b": "2", "x-c": "3", "transfer-encoding": "chunked" }, "h.test"),
    ).toEqual({ "x-c": "3", host: "h.test" });
  });

  it("tries the checked addresses in order, never resolving the name itself", async () => {
    const target = await upstream();
    // 127.0.0.2 refuses the port on most hosts; the second checked address answers.
    const closed = createTcpServer();
    const refusedPort = await listenLocally(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // The first checked address answers nothing on this port (a reserved, unroutable one times out fast here); the second does.
    const proxy = await proxyWith(async () => ({ addresses: ["127.0.0.2", "127.0.0.1"] }), [], { connectTimeoutMs: 500 });
    expect(
      await exchange(proxy, `GET http://app.test:${String(target.port)}/ HTTP/1.1\r\nHost: app.test\r\n${auth(proxy)}\r\n`, /upstream/),
    ).toMatch(/^HTTP\/1\.1 200/);
    const failing = await proxyWith(async () => ({ addresses: ["127.0.0.1"] }));
    expect(
      await exchange(failing, `GET http://app.test:${String(refusedPort)}/ HTTP/1.1\r\nHost: app.test\r\n${auth(failing)}\r\n`, /\r\n\r\n/),
    ).toMatch(/^HTTP\/1\.1 502/);
  });

  it("refuses an Upgrade sent to the proxy itself, and never connects to its own port", async () => {
    const refused: EgressRefusal[] = [];
    const proxy = await proxyWith(async () => ({ addresses: ["127.0.0.1"] }), refused);
    const own = new URL(proxy.url).port;
    expect(
      await exchange(
        proxy,
        `GET http://app.test/ HTTP/1.1\r\nHost: app.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${auth(proxy)}\r\n`,
        /\r\n\r\n/,
      ),
    ).toMatch(/^HTTP\/1\.1 405/);
    expect(await exchange(proxy, `CONNECT app.test:${own} HTTP/1.1\r\nHost: app.test\r\n${auth(proxy)}\r\n`, /\r\n\r\n/)).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(refused.at(-1)?.reason).toContain("own egress proxy");
  });

  it("answers its canary itself, and drops a tunnel whose client left while it was being checked", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let dialled = 0;
    const listener: TcpServer = createTcpServer(() => void (dialled += 1));
    const port = await listenLocally(listener);
    closers.push(() => new Promise((resolve) => listener.close(() => resolve())));
    const proxy = await proxyWith(async (host) => {
      if (host === "slow.test") await held;
      return { addresses: ["127.0.0.1"] };
    });
    const canary = proxy.canaryUrl();
    expect(await exchange(proxy, `GET ${canary} HTTP/1.1\r\nHost: tavi-egress-canary.invalid\r\n${auth(proxy)}\r\n`, /\r\n\r\n/)).toMatch(
      /^HTTP\/1\.1 204/,
    );
    expect(proxy.canarySeen(canary)).toBe(true);
    expect(proxy.canarySeen(proxy.canaryUrl())).toBe(false);
    // The client goes while the check runs: nothing is dialled for it.
    const left = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    left.on("error", () => undefined);
    left.write(`CONNECT slow.test:${String(port)} HTTP/1.1\r\nHost: slow.test\r\n${auth(proxy)}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    left.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dialled).toBe(0);
  });

  it("closes every tunnel when it closes", async () => {
    const listener: TcpServer = createTcpServer((socket) => socket.on("error", () => undefined));
    const port = await listenLocally(listener);
    closers.push(() => new Promise((resolve) => listener.close(() => resolve())));
    const proxy = await startEgressProxy(
      async () => ({ addresses: ["127.0.0.1"] }),
      () => undefined,
    );
    const client = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url).port) });
    client.on("error", () => undefined);
    await new Promise<void>((resolve) =>
      client.once("data", () => resolve()).write(`CONNECT tunnel.test:${String(port)} HTTP/1.1\r\nHost: tunnel.test\r\n${auth(proxy)}\r\n`),
    );
    const ended = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await proxy.close();
    await ended;
    expect(client.destroyed).toBe(true);
  });
});

describe("the browser's launch flags and file URLs", () => {
  it("on Windows resolves no name but through the proxy and offers no Windows sign-in; elsewhere adds nothing", () => {
    const windows = egressLaunchArgs("win32");
    expect(windows).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    expect(windows).toContain("--auth-server-allowlist=tavi-none.invalid");
    expect(egressLaunchArgs("linux")).toEqual(["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]);
    expect(egressLaunchArgs("darwin")).toEqual(egressLaunchArgs("linux"));
  });

  it("knows a file URL naming a network share from a local one", () => {
    for (const share of [
      "file://server/share/a.txt",
      "file:////server/share/a.txt",
      "file://///server/share/a.txt",
      "file:///\\\\server\\share\\a.txt",
      "file://localhost///server/share/a.txt",
      "FILE://10.0.0.5/c$/x",
    ])
      expect(namesNetworkShare(share), share).toBe(true);
    for (const local of [
      "file:///C:/Users/a/x.html",
      "file:///home/a/x.html",
      "file://localhost/etc/hosts",
      "https://server/share",
      "not a url",
    ])
      expect(namesNetworkShare(local), local).toBe(false);
  });
});
