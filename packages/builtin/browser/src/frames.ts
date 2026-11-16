import type { Frame, Page } from "playwright";

import { hostOfUrl } from "./page-status.js";
import { within, LIVE_BOX_TIMEOUT_MS } from "./timing.js";

/** How long a scope's element may take to be found before the observation fails. */
export const SCOPE_TIMEOUT_MS = 2_000;

/** At most 8 visible child frames are scanned per page, each at least 40×40 CSS pixels. */
const MAX_OBSERVED_FRAMES = 8;

const MIN_FRAME_DIMENSION_PX = 40;

interface VisibleChildFrame {
  readonly frame: Frame;
  readonly prefix: string;
  readonly url: string;
  readonly origin: string;
  readonly host: string;
}

/**
 * Whose content a frame holds: its own origin's, or for an opaque frame
 * (`about:srcdoc`, `data:`) its nearest ancestor's with one. A `blob:` frame's
 * origin is its creator's. `undefined` when no frame up to the top has one.
 */
export function frameOwnerOf(frame: Frame): { readonly origin: string; readonly host: string } | undefined {
  for (let current: Frame | null = frame; current !== null; ) {
    const origin = URL.parse(typeof current.url === "function" ? current.url() : "")?.origin;
    const parsed = origin === undefined || origin === "null" ? null : URL.parse(origin);
    if (parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
      return { origin: parsed.origin, host: parsed.host.toLowerCase() };
    }
    current = typeof current.parentFrame === "function" ? current.parentFrame() : null;
  }
  return undefined;
}

/**
 * Whether a frame's element is the focused element of its own document, read
 * through open shadow roots (a frame inside a component is focused through its
 * host). Run in the parent frame: the page that holds the frame says where its
 * keystrokes go, never the frame itself.
 */
const IS_FOCUSED_FRAME_ELEMENT = (element: { readonly ownerDocument: { readonly activeElement: unknown } }): boolean => {
  type Focused = { readonly shadowRoot?: { readonly activeElement: unknown } | null } | null | undefined;
  let active = element.ownerDocument.activeElement as Focused;
  for (let depth = 0; active !== null && active !== undefined && depth < 16; depth += 1) {
    if ((active as unknown) === element) return true;
    active = active.shadowRoot?.activeElement as Focused;
  }
  return false;
};

/**
 * The frame keyboard focus is in, followed down from the page through nested
 * frames; the main frame when focus is in the page itself, and `"unknown"` when
 * a frame on the way cannot be read in time (it fails closed: keys sent then may
 * land in a frame no one decided on).
 */
export async function focusedFrameOf(page: Page): Promise<Frame | "unknown" | undefined> {
  if (typeof page.mainFrame !== "function") return undefined;
  let frame = page.mainFrame();
  for (let depth = 0; depth < 8; depth += 1) {
    const children = typeof frame.childFrames === "function" ? frame.childFrames() : [];
    let next: Frame | undefined;
    for (const child of children) {
      if (typeof child.isDetached === "function" && child.isDetached()) continue;
      if (typeof child.frameElement !== "function") continue;
      const handle = await within(child.frameElement(), SCOPE_TIMEOUT_MS);
      if (handle === undefined || handle === null) return "unknown";
      const focused = await within(handle.evaluate(IS_FOCUSED_FRAME_ELEMENT), SCOPE_TIMEOUT_MS);
      await handle.dispose().catch(() => undefined);
      if (focused === undefined) return "unknown";
      if (focused) {
        next = child;
        break;
      }
    }
    if (next === undefined) return frame;
    frame = next;
  }
  return frame;
}

/**
 * The child frames whose content stays out of what the model reads: a frame on
 * a host the policy refuses, and every frame inside one. The page's own host,
 * and every frame with no policy, are read.
 */
export async function refusedFrames(
  children: readonly VisibleChildFrame[],
  pageUrl: string,
  allowed: ((frameOrigin: string) => boolean | Promise<boolean>) | undefined,
): Promise<ReadonlySet<Frame>> {
  const refused = new Set<Frame>();
  if (allowed === undefined) return refused;
  const pageHost = hostOfUrl(pageUrl) ?? "";
  const insideRefused = (frame: Frame): boolean => {
    for (let parent = typeof frame.parentFrame === "function" ? frame.parentFrame() : null; parent !== null; ) {
      if (refused.has(parent)) return true;
      parent = typeof parent.parentFrame === "function" ? parent.parentFrame() : null;
    }
    return false;
  };
  for (const child of children) {
    if (insideRefused(child.frame) || (child.host !== "" && child.host !== pageHost && !(await allowed(child.origin)))) {
      refused.add(child.frame);
    }
  }
  return refused;
}

export async function visibleChildFrames(page: Page): Promise<readonly VisibleChildFrame[]> {
  if (typeof page.frames !== "function") return [];
  const main = typeof page.mainFrame === "function" ? page.mainFrame() : page.frames()[0];
  const children = page.frames().filter((frame) => frame !== main);
  const visible: VisibleChildFrame[] = [];
  const pageOrigin = URL.parse(page.url())?.origin;
  const pageHost = hostOfUrl(page.url()) ?? "";
  for (const frame of children) {
    if (visible.length >= MAX_OBSERVED_FRAMES) break;
    if (typeof (frame as { readonly locator?: unknown }).locator !== "function") continue;
    if (typeof (frame as { readonly isDetached?: () => boolean }).isDetached === "function" && frame.isDetached()) continue;
    const rawUrl = typeof frame.url === "function" ? frame.url() : "";
    if (rawUrl === "" || rawUrl === "about:blank" || rawUrl.startsWith("javascript:")) continue;
    if (typeof frame.frameElement === "function") {
      const handle = await within(frame.frameElement(), SCOPE_TIMEOUT_MS);
      if (handle === undefined || handle === null) continue;
      const box = await within(handle.boundingBox(), LIVE_BOX_TIMEOUT_MS);
      await handle.dispose().catch(() => undefined);
      if (box === undefined || box === null || box.width < MIN_FRAME_DIMENSION_PX || box.height < MIN_FRAME_DIMENSION_PX) {
        continue;
      }
    }
    const owner = frameOwnerOf(frame);
    const origin = owner?.origin ?? (pageOrigin !== undefined && pageOrigin !== "null" ? pageOrigin : rawUrl);
    const host = owner?.host ?? pageHost;
    const prefix = `f${visible.length + 1}`;
    visible.push({ frame, prefix, url: rawUrl, origin, host });
  }
  return visible;
}
