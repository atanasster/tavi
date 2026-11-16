import { clipBrowserTitle, type BrowserActionOutcome } from "@tavi/contracts";
import type { Locator } from "playwright";

import type { LiveActionEvent } from "./live.js";
import type { PageGlobals } from "./page-globals.js";
import { thumbnailFor, playwrightThumbnailPage } from "./thumbnail.js";
import {
  extractLiteralPdfText,
  declaredLengthOf,
  UPLOAD_MAX_BYTES,
  PDF_READ_CHUNK_BYTES,
  pdfBodyOf,
  sniffDownloadMediaType,
} from "./download-media.js";
import { reportHistoryError, blockedHostsOf } from "./observation.js";
import { READ_TIMEOUT_MS } from "./page-read.js";
import { hostOfUrl, declineConsent } from "./page-status.js";
import type { SessionRecord, BrowserRuntime } from "./session-types.js";
import { personActs } from "./sessions.js";
import { within, TITLE_TIMEOUT_MS, LIVE_BOX_TIMEOUT_MS, THUMBNAIL_TIMEOUT_MS } from "./timing.js";

/**
 * A PDF's text, read by the wired PDF engine (production always wires one):
 * a PDF it cannot read has none. The literal-stream reader is only for an
 * adapter built without an engine, as tests build it.
 */
export async function readPdfBytes(ctx: BrowserRuntime, bytes: Uint8Array): Promise<string> {
  const engine = typeof ctx.options.pdf === "function" ? ctx.options.pdf() : ctx.options.pdf;
  if (engine === undefined) return extractLiteralPdfText(bytes);
  try {
    const res =
      typeof engine.readWithOcr === "function" ? (await engine.readWithOcr(bytes, {})).read : await engine.run({ op: "read" }, bytes);
    if (!res.ok || !res.answer.ok) return "";
    return (res.answer.pages ?? [])
      .map((p) => p.text.trim())
      .filter((t) => t !== "")
      .join("\n\n");
  } catch {
    // An engine that cannot parse the file reads nothing from it.
    return "";
  }
}

/**
 * Fetches `url` again through the page's own network stack (its cookies and
 * the egress proxy), read in chunks that stop past `UPLOAD_MAX_BYTES`: a
 * chunked response declares no length to check first. Chromium loads the
 * whole response before it hands the stream over, so `signal` aborting
 * detaches the DevTools session, which cancels a load still under way (a
 * large or endless body). Nothing when the page has no DevTools session, the
 * fetch fails, the file is over the cap, or `signal` aborts.
 */
async function fetchBoundedPdf(session: SessionRecord, url: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
  const context = session.context;
  if (typeof context?.newCDPSession !== "function") return undefined;
  const cdp = await context.newCDPSession(session.page).catch(() => undefined);
  if (cdp === undefined) return undefined;
  const stopLoading = (): void => void cdp.detach().catch(() => undefined);
  signal.addEventListener("abort", stopLoading, { once: true });
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { resource } = await cdp.send("Network.loadNetworkResource", {
      frameId: frameTree.frame.id,
      url,
      options: { disableCache: false, includeCredentials: true },
    });
    const handle = resource.stream;
    if (!resource.success || handle === undefined) return undefined;
    try {
      const declared = declaredLengthOf(
        Object.fromEntries(Object.entries(resource.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)])),
      );
      if (declared !== undefined && declared > UPLOAD_MAX_BYTES) return undefined;
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        if (signal.aborted) return undefined;
        const chunk = await cdp.send("IO.read", { handle, size: PDF_READ_CHUNK_BYTES });
        const buf = Buffer.from(chunk.data, chunk.base64Encoded === true ? "base64" : "utf8");
        total += buf.byteLength;
        if (total > UPLOAD_MAX_BYTES) return undefined;
        chunks.push(buf);
        if (chunk.eof) break;
      }
      return new Uint8Array(Buffer.concat(chunks, total));
    } finally {
      await cdp.send("IO.close", { handle }).catch(() => undefined);
    }
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", stopLoading);
    if (!signal.aborted) await cdp.detach().catch(() => undefined);
  }
}

export async function captureMainPdfNavigation(
  ctx: BrowserRuntime,
  session: SessionRecord,
  fallbackUrl?: string,
  gotoResponse?: {
    readonly headers?: () => Record<string, string>;
    readonly body?: () => Promise<Uint8Array>;
    readonly url?: () => string;
  } | null,
): Promise<void> {
  let pending = session.lastMainPdfBytes;
  session.lastMainPdfBytes = undefined;
  if (pending === undefined && gotoResponse !== undefined && gotoResponse !== null) {
    const headers = typeof gotoResponse.headers === "function" ? gotoResponse.headers() : {};
    const contentType = (headers["content-type"] ?? "").toLowerCase();
    const resUrl = (typeof gotoResponse.url === "function" ? gotoResponse.url() : undefined) ?? fallbackUrl ?? session.page.url();
    if (contentType.includes("application/pdf") || /\.pdf(?:[?#]|$)/i.test(resUrl)) {
      const body = gotoResponse.body;
      pending = {
        url: resUrl,
        bytes: typeof body === "function" ? pdfBodyOf(headers, () => body.call(gotoResponse)) : Promise.resolve(undefined),
      };
    }
  }
  if (pending === undefined && fallbackUrl !== undefined && /\.pdf(?:[?#]|$)/i.test(fallbackUrl)) {
    pending = { url: fallbackUrl, bytes: Promise.resolve(undefined) };
  }
  if (pending === undefined) return;
  const pdfUrl = pending.url || fallbackUrl || session.page.url();
  const read = await within(pending.bytes, READ_TIMEOUT_MS);
  // Over the cap by its own account: not fetched again.
  if (read === "over-cap") return;
  let bytes = read;
  if (bytes === undefined || sniffDownloadMediaType(bytes, "document.pdf") !== "application/pdf") {
    const stop = new AbortController();
    bytes = await within(fetchBoundedPdf(session, pdfUrl, stop.signal), READ_TIMEOUT_MS);
    stop.abort();
  }
  if (bytes === undefined || sniffDownloadMediaType(bytes, "document.pdf") !== "application/pdf") return;
  const text = await readPdfBytes(ctx, bytes);
  session.pdfPage = { url: pdfUrl, hostPageUrl: session.page.url(), text };
}

/**
 * After a click or a submit: when it took the page elsewhere, record the new
 * page and queue its thumbnail, as a navigate would, instead of waiting for
 * the next observe. The model's refs still name the old page's elements, so
 * the epoch is left for the next observe to advance.
 */
export async function recordNavigation(ctx: BrowserRuntime, session: SessionRecord): Promise<void> {
  await captureMainPdfNavigation(ctx, session);
  const url = session.page.url();
  if (url === session.url) return;
  if (
    session.pdfPage !== undefined &&
    session.pdfPage.url !== url &&
    session.pdfPage.hostPageUrl !== url &&
    url !== "" &&
    url !== "about:blank"
  ) {
    session.pdfPage = undefined;
  }
  session.url = url;
  session.pendingConsent = undefined;
  const currentHost = hostOfUrl(url);
  if (currentHost !== undefined && currentHost !== session.lastConsentHost) {
    session.lastConsentHost = currentHost;
    const result = await declineConsent(session.page);
    session.url = session.page.url();
    const settledHost = hostOfUrl(session.url) ?? currentHost;
    session.lastConsentHost = settledHost;
    session.pendingConsent = { host: settledHost, result };
  }
  if (ctx.options.history === undefined || session.historyId === undefined) return;
  const title = clipBrowserTitle(
    await within(
      Promise.resolve().then(() => session.page.title()),
      TITLE_TIMEOUT_MS,
    ),
  );
  reportNavigated(ctx, session, title);
  await recordPage(ctx, session, title);
  scheduleThumbnail(ctx, session);
}

export function reportNavigated(ctx: BrowserRuntime, session: SessionRecord, title: string | undefined): void {
  if (ctx.options.live === undefined || session.historyId === undefined) return;
  ctx.options.live.navigated(session.historyId, { url: session.url, title, epoch: session.epoch });
}

/**
 * An element's box in the page's document CSS pixels (its viewport box plus
 * the page's scroll), when it can be read in time: a viewer subtracts each
 * frame's own scroll, so the outline stays on the element when acting on
 * it scrolls the page.
 */
export async function boxOf(locator: Locator | undefined): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  if (locator === undefined) return undefined;
  const [box, scroll] = await Promise.all([
    within(locator.boundingBox(), LIVE_BOX_TIMEOUT_MS),
    // Unread, it counts as unscrolled: the box is then where it was before.
    within(
      Promise.resolve().then(() =>
        locator.page().evaluate(() => {
          const page = globalThis as PageGlobals;
          return { x: page.scrollX ?? 0, y: page.scrollY ?? 0 };
        }),
      ),
      LIVE_BOX_TIMEOUT_MS,
    ),
  ]);
  if (box === null || box === undefined) return undefined;
  return { x: box.x + (scroll?.x ?? 0), y: box.y + (scroll?.y ?? 0), width: box.width, height: box.height };
}

export function reportAction(ctx: BrowserRuntime, session: SessionRecord, event: LiveActionEvent): void {
  if (ctx.options.live === undefined || session.historyId === undefined) return;
  ctx.options.live.action(session.historyId, event);
}

/**
 * Reports `run` to the live view as an action: started (with the element's
 * box, in document CSS pixels, when it can be read in time), then ended
 * with its outcome. Without a live view it only runs.
 */
export async function liveAction(
  ctx: BrowserRuntime,
  session: SessionRecord,
  action: LiveActionEvent["action"],
  callId: string | undefined,
  locator: Locator | undefined,
  run: () => Promise<BrowserActionOutcome>,
): Promise<BrowserActionOutcome> {
  if (ctx.options.live === undefined || session.historyId === undefined) return run();
  const box = await boxOf(locator);
  const call = callId === undefined ? {} : { callId };
  reportAction(ctx, session, { phase: "started", action, ...(box === undefined ? {} : { box }), ...call });
  try {
    const outcome = await run();
    reportAction(ctx, session, { phase: "ended", action, status: outcome.status, ...call });
    return outcome;
  } catch (error) {
    reportAction(ctx, session, { phase: "ended", action, status: "rejected", ...call });
    throw error;
  }
}

export async function recordPage(ctx: BrowserRuntime, session: SessionRecord, title: string | undefined): Promise<void> {
  if (ctx.options.history === undefined || session.historyId === undefined) return;
  try {
    await ctx.options.history.recordPage({ sessionId: session.historyId, url: session.url, title, at: ctx.now() });
  } catch (error) {
    reportHistoryError(ctx, error);
  }
}

/**
 * Queue the thumbnail rules for the page this refresh recorded. A run whose
 * refresh has been superseded by a newer one is dropped before it starts.
 */
export function scheduleThumbnail(ctx: BrowserRuntime, session: SessionRecord): void {
  if (
    ctx.options.history === undefined ||
    ctx.options.artifacts === undefined ||
    session.historyId === undefined ||
    personActs(ctx, session)
  )
    return;
  const epoch = (session.lastThumbnailEpoch = (session.lastThumbnailEpoch ?? 0) + 1);
  const checkedUrl = session.url;
  session.thumbnailQueue = session.thumbnailQueue.then(async () => {
    if (session.lastThumbnailEpoch !== epoch || session.state === "closed") return;
    await within(updateThumbnail(ctx, session, epoch, checkedUrl), THUMBNAIL_TIMEOUT_MS);
  });
}

/**
 * Apply the thumbnail rules (`thumbnail.ts`) to the page a refresh recorded.
 * An image is kept only if the session is still on that page (same epoch,
 * same URL) once it is taken; a run that outlived its time bound is caught
 * by the same check.
 */
async function updateThumbnail(ctx: BrowserRuntime, session: SessionRecord, epoch: number, checkedUrl: string): Promise<void> {
  const history = ctx.options.history;
  const artifacts = ctx.options.artifacts;
  const historyId = session.historyId;
  if (history === undefined || artifacts === undefined || historyId === undefined) return;
  const stale = (): boolean =>
    session.state === "closed" || session.lastThumbnailEpoch !== epoch || session.page.url() !== checkedUrl || personActs(ctx, session);
  try {
    const blockedHosts = await blockedHostsOf(ctx, session.workspaceId);
    if (stale()) return;
    const at = Date.parse(ctx.now());
    const outcome = await thumbnailFor((ctx.options.thumbnailPage ?? playwrightThumbnailPage)(session.page), {
      lastCapturedAt: session.lastThumbnailAt,
      now: at,
      blockedHosts,
    });
    if (outcome.kind === "sensitive") {
      // Clearing is safe whatever page the session is on now.
      ctx.options.live?.thumbnail(historyId, undefined);
      await history.setThumbnail({ sessionId: historyId, artifactId: null });
      return;
    }
    if (outcome.kind === "throttled" || stale()) return;
    session.lastThumbnailAt = at;
    const artifact = await artifacts.putArtifact({
      workspaceId: session.workspaceId,
      ...(session.taskId === undefined ? {} : { runId: session.taskId }),
      contentType: "image/jpeg",
      body: outcome.bytes,
      extension: "jpg",
      // The operator's own page reads it; the model never does
      // (`isModelVisibleArtifact`), so there is nothing to review.
      reviewState: "approved",
      purpose: "thumbnail",
    });
    await history.setThumbnail({ sessionId: historyId, artifactId: artifact.artifactId });
    ctx.options.live?.thumbnail(historyId, outcome.bytes);
  } catch (error) {
    reportHistoryError(ctx, error);
  }
}
