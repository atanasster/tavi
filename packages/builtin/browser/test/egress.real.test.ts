import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";

import type { BrowserPort } from "@tavi/contracts";
import { listenLocally } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchChromium } from "../src/chromium.js";
import type { EgressRefusal } from "../src/egress-proxy.js";
import { createPlaywrightBrowser } from "../src/playwright.js";

/**
 * The egress proxy in a real Chromium: every connection goes through it, and
 * it connects only to the address its check names. The check here stands for
 * the owner's: `app.test` and `rebind.test` are public sites served by the
 * fixture (the check names 127.0.0.1 for them); `metadata.test` resolves to a
 * private address; any IP literal of this machine or the private network is
 * refused. Chromium's own resolver maps `rebind.test` to an unreachable
 * private address — what a rebinding name would answer the browser — so a
 * page that loads from it shows the proxy connected to the checked address,
 * never Chromium's answer. Skipped when Chromium cannot launch here.
 */

let server: Server;
let port = 0;
let adapter: BrowserPort;
let chromiumAvailable = true;
const reached: string[] = [];
const refused: EgressRefusal[] = [];

const html = (body: string): string => `<!doctype html><html><head><title>Page</title></head><body>${body}</body></html>`;
const app = (): string => `http://app.test:${port}`;
const blockedHere = (): string => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    reached.push(`${(req.headers.host ?? "").replace(`:${port}`, "")}${req.url ?? ""}`);
    const redirect = (location: string): void => {
      res.writeHead(302, { Location: location });
      res.end();
    };
    const page = (body: string): void => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(body));
    };
    const script = (body: string): void => {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(body);
    };
    switch (req.url) {
      case "/redirect":
        return redirect(`${blockedHere()}/secret`);
      case "/redirect-name":
        return redirect(`http://metadata.test:${port}/latest`);
      case "/hop":
        return redirect("/landed");
      case "/shared":
        return page(`<script>new SharedWorker("/shared-worker.js");</script>`);
      case "/shared-worker.js":
        return script(
          `fetch("${blockedHere()}/from-shared").catch(() => undefined); try { new WebSocket("ws://127.0.0.1:${port}/shared-socket"); } catch {}`,
        );
      case "/worker":
        return page(`<script>new Worker("/worker.js");</script>`);
      case "/worker.js":
        return script(`try { new WebSocket("ws://127.0.0.1:${port}/worker-socket"); } catch {}`);
      case "/opens":
        return page(`<script>window.open("/redirect-popup");</script>`);
      case "/redirect-popup":
        return redirect(`${blockedHere()}/from-popup`);
      case "/speculates":
        return page(
          `<script type="speculationrules">{"prerender":[{"source":"list","urls":["/prerender-hop"]}],"prefetch":[{"source":"list","urls":["/prefetch-hop"]}]}</script>`,
        );
      case "/prerender-hop":
        return redirect(`${blockedHere()}/prerendered`);
      case "/prefetch-hop":
        return redirect(`${blockedHere()}/prefetched`);
      case "/socket-page":
        return page(`<p id="out">waiting</p><script>
        const socket = new WebSocket("ws://app.test:${port}/echo");
        socket.onopen = () => socket.send("ping");
        socket.onmessage = (event) => { document.getElementById("out").textContent = String(event.data); };
        socket.onerror = () => { document.getElementById("out").textContent = "error"; };
      </script>`);
      default:
        return page("ok");
    }
  });
  // A WebSocket echo (one text frame), for a socket that may go through.
  server.on("upgrade", (req, socket) => {
    reached.push(`ws:${(req.headers.host ?? "").replace(`:${port}`, "")}${req.url ?? ""}`);
    const accept = createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // Any frame from the page is answered with one text frame.
    socket.once("data", () => socket.end(Buffer.concat([Buffer.from([0x81, 4]), Buffer.from("echo")])));
  });
  port = await listenLocally(server);
  adapter = createPlaywrightBrowser({
    stagingDirectory: tmpdir(),
    launch: (options) =>
      launchChromium({ ...options, args: [...(options.args ?? []), "--host-resolver-rules=MAP rebind.test 10.255.255.1"] }),
    egress: async (host) => {
      if (host === "app.test" || host === "rebind.test") return { address: "127.0.0.1" };
      if (host === "metadata.test") return { refused: "metadata.test resolves to a link-local address" };
      return { refused: `${host} is this machine or a private network` };
    },
    onEgressRefused: (refusal) => refused.push(refusal),
  });
  try {
    const session = await adapter.createSession({ workspaceId: "probe" });
    await adapter.close(session.sessionId);
  } catch {
    chromiumAvailable = false;
  }
}, 60_000);

afterAll(async () => {
  await adapter.dispose?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Opens `path` on the fixture site, waits `ms`, and closes the session. */
async function visit(path: string, ms = 1_500): Promise<void> {
  const session = await adapter.createSession({ workspaceId: "w1" });
  try {
    await adapter.navigate(session.sessionId, `${app()}${path}`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    await adapter.close(session.sessionId);
  }
}

const reachedThisMachine = (): readonly string[] =>
  reached.filter((entry) => entry.startsWith("127.0.0.1") || entry.startsWith("ws:127.0.0.1") || entry.startsWith("metadata.test"));

describe("the egress proxy in a real browser", () => {
  it("lets a public site through: a page, a same-host redirect and a WebSocket", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const session = await adapter.createSession({ workspaceId: "w1" });
    try {
      const landed = await adapter.navigate(session.sessionId, `${app()}/hop`);
      expect(landed.url).toBe(`${app()}/landed`);
      await adapter.navigate(session.sessionId, `${app()}/socket-page`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(reached).toContain("ws:app.test/echo");
    } finally {
      await adapter.close(session.sessionId);
    }
  }, 60_000);

  it("refuses a redirect to this machine and to a name that resolves to a private address", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    await visit("/redirect", 200);
    await visit("/redirect-name", 200);
    expect(reached).toContain("app.test/redirect");
    expect(reached).toContain("app.test/redirect-name");
    expect(reachedThisMachine()).toEqual([]);
    expect(refused.map((entry) => entry.host)).toEqual(expect.arrayContaining([`127.0.0.1:${port}`, `metadata.test:${port}`]));
  }, 60_000);

  it("refuses a shared worker's fetch and WebSocket, and a dedicated worker's WebSocket, to this machine", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    await visit("/shared");
    await visit("/worker");
    expect(reached).toContain("app.test/shared-worker.js");
    expect(reached).toContain("app.test/worker.js");
    expect(reachedThisMachine()).toEqual([]);
  }, 60_000);

  it("refuses a popup's redirect, and what speculation rules prefetch or prerender, to this machine", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    await visit("/opens");
    await visit("/speculates", 2_500);
    expect(reachedThisMachine()).toEqual([]);
  }, 60_000);

  it("connects to the address it checked, never to what the browser's own resolver answers (DNS rebinding)", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const session = await adapter.createSession({ workspaceId: "w1" });
    try {
      const page = await adapter.navigate(session.sessionId, `http://rebind.test:${port}/pinned`);
      expect(page.url).toBe(`http://rebind.test:${port}/pinned`);
      expect(reached).toContain("rebind.test/pinned");
    } finally {
      await adapter.close(session.sessionId);
    }
  }, 60_000);
});
