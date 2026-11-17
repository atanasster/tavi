import { TaviError } from "@tavi/contracts";

import type { PressMode } from "./guard.js";

/** How long an action waits for its element's box before it is reported without one. */
export const LIVE_BOX_TIMEOUT_MS = 500;

/** How many observations of one document keep their epoch valid; an older one's refs are stale. */
export const MAX_KEPT_EPOCHS = 16;

/** Default Playwright timeout for element actions. */
export const ACTION_TIMEOUT_MS = 8_000;

/** Default Playwright timeout for page navigations. */
export const NAVIGATION_TIMEOUT_MS = 15_000;

/** Rejects once `signal` aborts (the call was cancelled); never settles otherwise. */
export function abortedBy(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new TaviError("CANCELLED", "Browser action was cancelled"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  void aborted.catch(() => undefined);
  return aborted;
}

/** `promise`, unless `signal` aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([promise, abortedBy(signal)]);
}

/** Cancels (when `cancel`) and deletes a download, bounded: a browser that no longer answers does not hold the call. */
export async function stopDownload(target: { cancel?: () => Promise<void>; delete?: () => Promise<void> }, cancel: boolean): Promise<void> {
  await within(
    (async () => {
      if (cancel && typeof target.cancel === "function") await target.cancel().catch(() => undefined);
      if (typeof target.delete === "function") await target.delete().catch(() => undefined);
    })(),
    2_000,
  );
}

/** How long a file download may take before it is aborted. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** A model's screenshot's JPEG quality: legible text at a fraction of a PNG's size. */
export const MODEL_CAPTURE_QUALITY = 70;

/** How long a page title may take before the observation goes without one. */
export const TITLE_TIMEOUT_MS = 1_000;

/** How long the page's scan of its elements may take before an observation fails as unanswered. */
export const SCAN_TIMEOUT_MS = 10_000;

/** How long a DevTools session of the browser's own may take to attach, answer a command, or let go of its page. */
export const CDP_SESSION_TIMEOUT_MS = 2_000;

/** How long one thumbnail run may hold its session's queue before the next one starts. */
export const THUMBNAIL_TIMEOUT_MS = 5_000;

/** What a key does to the control it lands on: Enter submits, Space presses; any other key presses nothing. */
export function pressModeOf(key: string): PressMode | undefined {
  if (/(^|\+)(enter|return|numpadenter)$/i.test(key)) return "enter";
  if (/^( |space)$/i.test(key)) return "press";
  return undefined;
}

/** `promise`'s value or rejection, or `timedOut()`'s error once `ms` pass. */
export async function beforeDeadline<T>(promise: Promise<T>, ms: number, timedOut: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced against its deadline: a rejection after the deadline has no one to tell.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timedOut()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `promise`'s value, or `undefined` once `ms` pass or it rejects. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Raced against its deadline: a rejection after the deadline has no one to tell.
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
