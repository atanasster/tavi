import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";

import type { BrowserPort } from "@tavi/contracts";
import { listenLocally } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchChromium } from "../src/chromium.js";
import type { EgressRefusal } from "../src/egress-proxy.js";
import { createPlaywrightBrowser } from "../src/playwright.js";

/**
 * A PDF a navigation opens or downloads, in a real Chromium behind the egress
 * proxy. Chromium's PDF viewer keeps a main-frame PDF's body from Playwright,
 * so an inline PDF is read by fetching it again (`Network.loadNetworkResource`):
 * that fetch must go through the proxy, stop past the 64 MiB cap, and be
 * cancelled when it runs too long. `app.test` is served by the fixture only
 * through the proxy's check; Chromium's own resolver maps it to an
 * unreachable address, so anything that reached the fixture went through the
 * proxy. Skipped when Chromium cannot launch here.
 */

const MiB = 1024 * 1024;
const CAP = 64 * MiB;

/** A one-page PDF whose content stream shows `text` literally (the adapter's engine-less reader reads it). */
function pdfOf(text: string, padTo = 0): Buffer {
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n4 0 obj<</Length ${text.length + 26}>>stream\nBT /F1 12 Tf 10 100 Td (${text}) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n`,
    "latin1",
  );
  const tail = Buffer.from("%%EOF\n", "latin1");
  const pad = Math.max(0, padTo - head.length - tail.length);
  // A comment line pads the file without changing what it shows.
  return Buffer.concat([
    head,
    pad > 0 ? Buffer.concat([Buffer.from("%"), Buffer.alloc(pad - 2, 0x20), Buffer.from("\n")]) : Buffer.alloc(0),
    tail,
  ]);
}

const SMALL = pdfOf("Inline statement");
const HUGE = pdfOf("Huge statement", CAP + MiB);

let server: Server;
let port = 0;
let adapter: BrowserPort;
let chromiumAvailable = true;
const reached: string[] = [];
const refused: EgressRefusal[] = [];
/** How many responses of the endless PDF are still being sent. */
const endless = { open: 0 };

const app = (): string => `http://app.test:${port}`;

/** Sends `body` in 1 MiB writes with no `Content-Length` (chunked). */
function sendChunked(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, { "Content-Type": "application/pdf" });
  for (let offset = 0; offset < body.length; offset += MiB) res.write(body.subarray(offset, offset + MiB));
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    reached.push(`${(req.headers.host ?? "").replace(`:${port}`, "")}${req.url ?? ""}`);
    switch (req.url) {
      case "/small.pdf":
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(SMALL.length) });
        return res.end(SMALL);
      case "/small-chunked.pdf":
        return sendChunked(res, SMALL);
      case "/huge.pdf":
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(HUGE.length) });
        return res.end(HUGE);
      case "/huge-chunked.pdf":
        return sendChunked(res, HUGE);
      case "/endless.pdf": {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.write(SMALL.subarray(0, 64));
        endless.open += 1;
        const timer = setInterval(() => res.write(Buffer.alloc(MiB, 0x20)), 20);
        res.on("close", () => {
          clearInterval(timer);
          endless.open -= 1;
        });
        return;
      }
      case "/attached.pdf":
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="attached.pdf"',
          "Content-Length": String(SMALL.length),
        });
        return res.end(SMALL);
      case "/attached-big.pdf": {
        const big = pdfOf("Big attachment", 2 * MiB);
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="attached-big.pdf"',
          "Content-Length": String(big.length),
        });
        return res.end(big);
      }
      default:
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<!doctype html><html><head><title>Page</title></head><body><p>ok</p></body></html>");
    }
  });
  port = await listenLocally(server);
  adapter = createPlaywrightBrowser({
    stagingDirectory: tmpdir(),
    launch: (options) => launchChromium({ ...options, args: [...(options.args ?? []), "--host-resolver-rules=MAP app.test 10.255.255.1"] }),
    egress: async (host) => (host === "app.test" ? { address: "127.0.0.1" } : { refused: `${host} is not the fixture` }),
    onEgressRefused: (refusal) => refused.push(refusal),
    downloadMaxMiB: 1,
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
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Navigates to `path` and reads the page: the text, or the navigation's error. */
async function openAndRead(path: string): Promise<{ readonly text?: string; readonly error?: string }> {
  const session = await adapter.createSession({ workspaceId: "w1" });
  try {
    try {
      await adapter.navigate(session.sessionId, `${app()}${path}`);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return { text: (await adapter.read(session.sessionId)).text };
  } finally {
    await adapter.close(session.sessionId);
  }
}

const fetchesOf = (path: string): number => reached.filter((entry) => entry === `app.test${path}`).length;

describe("a PDF a navigation opens or downloads, in a real browser", () => {
  it("reads an inline PDF within the cap, with or without a declared length, fetched again through the egress proxy", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    for (const path of ["/small.pdf", "/small-chunked.pdf"]) {
      expect(await openAndRead(path), path).toEqual({ text: "Inline statement" });
      // The page load and the bounded re-fetch, both under the name only the proxy resolves.
      expect(fetchesOf(path), path).toBe(2);
    }
  }, 60_000);

  it("shows an inline PDF over the cap with no text: not fetched again when its length says so, stopped past the cap when chunked", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    expect(await openAndRead("/huge.pdf")).toEqual({ text: "" });
    expect(fetchesOf("/huge.pdf")).toBe(1);
    expect(await openAndRead("/huge-chunked.pdf")).toEqual({ text: "" });
    expect(fetchesOf("/huge-chunked.pdf")).toBe(2);
  }, 90_000);

  it("cancels a re-fetch of an inline PDF that never ends", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const session = await adapter.createSession({ workspaceId: "w1" });
    try {
      await adapter.navigate(session.sessionId, `${app()}/endless.pdf`).catch(() => undefined);
      expect(fetchesOf("/endless.pdf")).toBe(2);
      // Once the navigation answered, only the page's own load is still under way: the re-fetch was cancelled.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(endless.open).toBe(1);
    } finally {
      await adapter.close(session.sessionId);
    }
  }, 90_000);

  it("reads a PDF a navigation downloads within the cap, and refuses one over it", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    expect(await openAndRead("/attached.pdf")).toEqual({ text: "Inline statement" });
    expect((await openAndRead("/attached-big.pdf")).error).toMatch(/1 MiB size limit/);
  }, 60_000);
});
