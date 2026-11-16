import { createServer } from "node:http";

import { listenLocally } from "@tavi/test-support";
import { chromium, type Browser } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";

import { createFixtureRenderer, createPlaywrightRenderer, countPdfPages, renderRequestAllowed } from "../src/render.js";

/**
 * The HTML → PDF renderer. The fixture proves the plumbing;
 * the real test proves the actual engine, and skips itself when Chromium cannot
 * launch on this host rather than reporting a false failure (the same posture
 * `playwright.real.test.ts` takes).
 */

const HTML = "<!doctype html><html><body><h1>Brief</h1></body></html>";

describe("fixture renderer", () => {
  it("returns bytes and a page count without a browser process", async () => {
    const renderer = createFixtureRenderer({ pages: 3, bytesPerPage: 500 });
    expect(renderer.capabilities()).toMatchObject({ available: true, provider: "fixture" });
    const rendered = await renderer.renderPdf({ html: HTML });
    expect(rendered.pages).toBe(3);
    expect(rendered.bytes.byteLength).toBe(1_500);
  });

  it("refuses input that is not an HTML document", async () => {
    const renderer = createFixtureRenderer();
    await expect(renderer.renderPdf({ html: "not html" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("propagates a configured failure as a typed error", async () => {
    const renderer = createFixtureRenderer({ failWith: "chromium is not installed" });
    await expect(renderer.renderPdf({ html: HTML })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

let chromiumAvailable = false;
// Chromium's first launch can take well past the default hook timeout on a busy host (every package testing at once).
beforeAll(async () => {
  try {
    const browser = await chromium.launch();
    await browser.close();
    chromiumAvailable = true;
  } catch {
    chromiumAvailable = false;
    // Visible, not silent: the real path is verified separately (`node`
    // outside vitest renders a real `%PDF-` here). Chromium's multi-process launch is what a forked
    // test worker under an outer sandbox refuses.
    console.warn(
      "[plugin-browser] Skipping the real Chromium render tests: Chromium could not launch in this " +
        "process. Run them from an unsandboxed shell, or verify the render path directly.",
    );
  }
}, 60_000);

// Decided per test, once `beforeAll` has probed: a `skipIf` here would be read at collection, before the probe, and
// always skip.
describe("playwright renderer — real Chromium", () => {
  it("renders a real PDF", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const renderer = createPlaywrightRenderer();
    const rendered = await renderer.renderPdf({ html: HTML });
    // A real PDF starts with the `%PDF-` magic; the fixture's bytes deliberately do not.
    expect(new TextDecoder().decode(rendered.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(rendered.bytes.byteLength).toBeGreaterThan(1_000);
  });

  it("reports a page count derived from the document, or none at all", async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const renderer = createPlaywrightRenderer();
    const rendered = await renderer.renderPdf({ html: HTML });
    // Never a guess: the count comes from the PDF's own page objects, and is
    // simply absent when they cannot be read (a
    // `scrollHeight` estimate was wrong by ~2× on the real template).
    expect(rendered.pages === undefined || rendered.pages >= 1).toBe(true);
  });
});

describe("countPdfPages", () => {
  it("counts page objects and ignores the page-tree node", () => {
    const pdf = "%PDF-1.4\n1 0 obj /Type /Pages /Count 2\n2 0 obj /Type /Page\n3 0 obj /Type /Page\n";
    expect(countPdfPages(new TextEncoder().encode(pdf))).toBe(2);
  });

  it("returns undefined rather than a fabricated number", () => {
    expect(countPdfPages(new TextEncoder().encode("not a pdf"))).toBeUndefined();
  });
});

describe("the renderer is offline", () => {
  it("lets only data: and about: requests through", () => {
    expect(renderRequestAllowed("data:image/png;base64,AAAA")).toBe(true);
    expect(renderRequestAllowed("about:blank")).toBe(true);
    expect(renderRequestAllowed("DATA:text/plain,x")).toBe(true);
    for (const url of [
      "https://collect.example/p.png?q=secret",
      "http://127.0.0.1:8080/x",
      "file:///etc/passwd",
      "ws://evil.example/",
      "blob:https://a.example/1",
      "//evil.example/x",
      "",
    ]) {
      expect(renderRequestAllowed(url), url).toBe(false);
    }
  });

  it("routes every request of the page through the check before the HTML is set, with no script, service worker or name resolution", async () => {
    const calls: string[] = [];
    let handler: ((route: unknown) => unknown) | undefined;
    const routeFor = (url: string) => ({
      request: () => ({ url: () => url }),
      continue: async () => {
        calls.push(`continue ${url}`);
      },
      abort: async (code?: string) => {
        calls.push(`abort ${url} ${code ?? ""}`);
      },
    });
    const page = {
      route: async (pattern: string, next: (route: unknown) => unknown) => {
        calls.push(`route ${pattern}`);
        handler = next;
      },
      setContent: async () => {
        calls.push("setContent");
        await handler?.(routeFor("https://collect.example/p.png?q=secret"));
        await handler?.(routeFor("data:image/png;base64,AAAA"));
      },
      pdf: async () => Buffer.from("%PDF-1.4 /Type /Page"),
      close: async () => {},
    };
    const opened: unknown[] = [];
    const launched: unknown[] = [];
    const browser = {
      newPage: async (options: unknown) => {
        opened.push(options);
        return page;
      },
      close: async () => {},
    };
    const renderer = createPlaywrightRenderer({
      launch: async (options) => {
        launched.push(options);
        return browser as unknown as Browser;
      },
    });
    await renderer.renderPdf({ html: HTML });
    expect(calls).toEqual([
      "route **/*",
      "setContent",
      "abort https://collect.example/p.png?q=secret blockedbyclient",
      "continue data:image/png;base64,AAAA",
    ]);
    // No script, no service worker, and no host name resolves.
    expect(opened).toEqual([{ javaScriptEnabled: false, serviceWorkers: "block" }]);
    expect(launched).toEqual([{ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] }]);
  });

  it("aborts a remote image in real Chromium: the server never sees the request", async (ctx) => {
    let probe: Browser | undefined;
    try {
      probe = await chromium.launch();
    } catch {
      ctx.skip();
    } finally {
      await probe?.close();
    }
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.writeHead(200, { "content-type": "image/png" }).end();
    });
    const port = await listenLocally(server);
    try {
      const html = `<!doctype html><html><body><h1>Brief</h1><img src="http://127.0.0.1:${port}/p.png?q=secret"><link rel="stylesheet" href="http://127.0.0.1:${port}/s.css"></body></html>`;
      const rendered = await createPlaywrightRenderer().renderPdf({ html });
      expect(new TextDecoder().decode(rendered.bytes.subarray(0, 5))).toBe("%PDF-");
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
