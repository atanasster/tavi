import { BROWSER_THUMBNAIL_INTERVAL_MS, BROWSER_THUMBNAIL_QUALITY, BROWSER_THUMBNAIL_WIDTH } from "@tavi/contracts";
import type { Page } from "playwright";

import { playwrightSensitivePage, sensitivityOf, type SensitivePage, type SensitiveReason } from "./sensitivity.js";

/**
 * The rules for a browser session's card thumbnail, apart from Playwright so they are testable with a fake page.
 *
 * In order:
 *
 *  1. a page the sensitivity rules hold back (`sensitivity.ts`: a blocked host,
 *     a password, payment or one-time-code field) gets **no** thumbnail, and
 *     the session's previous one is cleared, so the card never shows an older
 *     page under a sensitive URL;
 *  2. otherwise at most one thumbnail per `BROWSER_THUMBNAIL_INTERVAL_MS` per
 *     session;
 *  3. otherwise a `BROWSER_THUMBNAIL_WIDTH`-pixel JPEG of the viewport, checked
 *     again after it is taken: a page that became sensitive meanwhile is
 *     reported sensitive and the image is discarded.
 */

/** What the rules need of a page. */
export interface ThumbnailPage extends SensitivePage {
  jpeg(): Promise<Uint8Array>;
}

export type ThumbnailOutcome =
  | { readonly kind: "sensitive"; readonly reason: SensitiveReason }
  | { readonly kind: "throttled" }
  | { readonly kind: "image"; readonly bytes: Uint8Array };

export async function thumbnailFor(
  page: ThumbnailPage,
  input: { readonly lastCapturedAt: number | undefined; readonly now: number; readonly blockedHosts: readonly string[] },
): Promise<ThumbnailOutcome> {
  const before = await sensitivityOf(page, input.blockedHosts);
  if (before !== undefined) return { kind: "sensitive", reason: before };
  if (input.lastCapturedAt !== undefined && input.now - input.lastCapturedAt < BROWSER_THUMBNAIL_INTERVAL_MS) return { kind: "throttled" };
  const bytes = await page.jpeg();
  const after = await sensitivityOf(page, input.blockedHosts);
  return after === undefined ? { kind: "image", bytes } : { kind: "sensitive", reason: after };
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * A Playwright page as a `ThumbnailPage`. The JPEG is taken over the Chrome
 * DevTools protocol, whose screenshot clip takes a scale, so the image is
 * rendered at 320 pixels wide rather than captured full size and resized (the
 * browser is Chromium: `chromium.ts`).
 */
export function playwrightThumbnailPage(page: Page): ThumbnailPage {
  return {
    ...playwrightSensitivePage(page),
    async jpeg() {
      const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
      const cdp = await page.context().newCDPSession(page);
      try {
        const metrics = await cdp.send("Page.getLayoutMetrics");
        const { data } = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: BROWSER_THUMBNAIL_QUALITY,
          clip: {
            x: metrics.cssVisualViewport.pageX,
            y: metrics.cssVisualViewport.pageY,
            width: viewport.width,
            height: viewport.height,
            scale: BROWSER_THUMBNAIL_WIDTH / viewport.width,
          },
        });
        return Buffer.from(data, "base64");
      } finally {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await cdp.detach().catch(() => undefined);
      }
    },
  };
}
