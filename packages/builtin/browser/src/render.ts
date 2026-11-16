import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaviError, type RenderCapabilities, type RenderedDocument, type RenderPdfInput, type RenderPort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { Browser, Page } from "playwright";

import { PLAYWRIGHT_MISSING_MESSAGE, launchChromium, playwrightInstalled } from "./chromium.js";

/**
 * Real HTML → PDF renderer over Playwright's Chromium.
 *
 * It works from inside the agent's own nested Seatbelt sandbox too: headless
 * Chromium launches and `page.pdf()` produces a valid A4 document. Its output
 * has no useful bound — a sample brief is already 77.5 KiB — so the artifact
 * path (not a tool return) is a requirement, not a preference.
 *
 * **Injectable `launch`**, mirroring `playwright.ts`'s own seam: only the launch
 * is substitutable, and the real types are used throughout.
 */
export interface PlaywrightRendererOptions {
  readonly launch?: (options: { readonly headless: boolean; readonly args?: readonly string[] }) => Promise<Browser>;
  /** Whether Playwright resolves, for `capabilities()`; `playwrightInstalled` otherwise. */
  readonly playwrightInstalled?: () => boolean;
}

/**
 * Count page objects in a produced PDF, or `undefined` when that cannot be read.
 *
 * A `scrollHeight`-derived estimate was wrong by ~2× on this very template
 * (the print layout's margins and `break-inside: avoid`
 * make the paginated document taller than the screen layout measured), so the
 * count comes from the document itself and is simply omitted when the
 * markers are not found — a missing number is honest, a confident wrong one is
 * not.
 */
export function countPdfPages(bytes: Uint8Array): number | undefined {
  const text = new TextDecoder("latin1").decode(bytes);
  const matches = text.match(/\/Type\s*\/Page(?![s])/g);
  return matches === null || matches.length === 0 ? undefined : matches.length;
}

/**
 * Whether the renderer lets a page request through: only a `data:` or `about:` URL. The templates escape every value
 * today, so this is defence in depth — a remote image, stylesheet, font or
 * frame a report somehow carried would otherwise be fetched, its URL and
 * query string included, the moment the PDF is laid out.
 */
export function renderRequestAllowed(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return scheme === "data" || scheme === "about";
}

/** The renderer's Chromium resolves no host name. */
export const RENDER_BROWSER_ARGS: readonly string[] = ["--host-resolver-rules=MAP * ~NOTFOUND"];

export function createPlaywrightRenderer(options: PlaywrightRendererOptions = {}): RenderPort {
  const launch =
    options.launch ??
    ((launchOptions) =>
      launchChromium({ headless: launchOptions.headless, ...(launchOptions.args === undefined ? {} : { args: [...launchOptions.args] }) }));

  return {
    capabilities(): RenderCapabilities {
      // Only the default launch speaks for Playwright; an injected one makes no claim.
      if (options.launch === undefined && !(options.playwrightInstalled ?? playwrightInstalled)()) {
        return { available: false, provider: "playwright", detail: PLAYWRIGHT_MISSING_MESSAGE };
      }
      return {
        available: true,
        provider: "playwright",
        detail: "headless Chromium; readiness is confirmed by the first render, not probed here",
      };
    },

    async renderPdf(input: RenderPdfInput): Promise<RenderedDocument> {
      // Outside the `try` on purpose: a missing Playwright or Chromium is
      // `CAPABILITY_MISSING` (chromium.ts), not a render failure.
      // No host name resolves, so a `dns-prefetch` or `preconnect` hint leaks nothing over DNS.
      const browser = await launch({ headless: true, args: RENDER_BROWSER_ARGS });
      let page: Page | undefined;
      try {
        // A static report needs no script and no service worker: neither can open a socket or serve a request the route below does not see.
        page = await browser.newPage({ javaScriptEnabled: false, serviceWorkers: "block" });
        // Offline: every request but `data:` and `about:` is aborted before it leaves.
        await page.route("**/*", (route) =>
          renderRequestAllowed(route.request().url()) ? route.continue() : route.abort("blockedbyclient"),
        );
        await page.setContent(input.html, { waitUntil: "load" });
        const bytes = await page.pdf({
          format: input.pageSize ?? "A4",
          printBackground: true,
          // `path` is deliberately omitted: the bytes are returned to the caller
          // so they can be stored through the artifact repository, never written
          // to a path the renderer chose.
        });
        const rendered = new Uint8Array(bytes);
        const pages = countPdfPages(rendered);
        return { bytes: rendered, ...(pages === undefined ? {} : { pages }) };
      } catch (error) {
        if (error instanceof TaviError) throw error;
        throw new TaviError("UNAVAILABLE", `the report could not be rendered: ${errorMessage(error)}`);
      } finally {
        // Both closes always run, independently: a page-close failure must never
        // leave a headless Chromium process alive under `serve`.
        await Promise.allSettled([page?.close(), browser.close()]);
      }
    },
  };
}

/**
 * Fixture renderer: a real file round-trip through a temporary directory, a
 * deterministic byte body, no browser process.
 *
 * Sufficient to test the plumbing a real renderer needs — bytes out, a page
 * count, failure propagation — the same role the fixture browser (`test/support/fixture.ts`) plays for
 * `BrowserPort`. It is deliberately **not** a PDF producer, so a test that
 * asserts "a real PDF" must use `playwright.real.test.ts` instead.
 */
export interface FixtureRendererOptions {
  readonly pages?: number;
  readonly bytesPerPage?: number;
  /** When set, `renderPdf` rejects with this message. */
  readonly failWith?: string;
  readonly now?: () => string;
}

export function createFixtureRenderer(options: FixtureRendererOptions = {}): RenderPort {
  const pages = options.pages ?? 1;
  const perPage = options.bytesPerPage ?? 1_024;
  return {
    capabilities(): RenderCapabilities {
      return { available: true, provider: "fixture", detail: "in-memory, no browser process" };
    },
    async renderPdf(input: RenderPdfInput): Promise<RenderedDocument> {
      if (options.failWith !== undefined) throw new TaviError("UNAVAILABLE", options.failWith);
      if (!input.html.includes("<html")) {
        throw new TaviError("INVALID_INPUT", "the fixture renderer expects an HTML document");
      }
      const directory = await mkdtemp(join(tmpdir(), "tavi-render-"));
      try {
        const path = join(directory, "report.pdf");
        await writeFile(path, Buffer.alloc(pages * perPage, 0x25));
        const { readFile } = await import("node:fs/promises");
        return { bytes: new Uint8Array(await readFile(path)), pages };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
