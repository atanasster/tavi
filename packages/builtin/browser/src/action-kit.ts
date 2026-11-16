import { TaviError } from "@tavi/contracts";

import type { PageGlobals } from "./page-globals.js";

/**
 * How long a click waits to see whether it opened a new tab. Links that open
 * one (`target="_blank"`, a script's `window.open`) do so as the click lands;
 * a click that opens none pays this wait once.
 */
export const POPUP_GRACE_MS = 1_000;

/** How long a click waits for a new tab after `domcontentloaded` settles. */
export const POPUP_SETTLE_MS = 150;

/** Maximum number of open pages kept per session; the oldest inactive page is evicted past this cap. */
export const MAX_SESSION_PAGES = 5;

/** The pause between keys when typing as a person does. */
export const KEY_DELAY_MS = 60;

/** What a field's suggestions look like: the options of a list box or a combobox's popup, as shown. */
export const SUGGESTION_SELECTOR = "[role=option]:visible, [role=listbox]:visible li:visible";

/** How often typing checks for its suggestions. */
export const SUGGESTION_POLL_MS = 150;

/** How long a field may take to open its suggestions after the last key. */
export const SUGGESTION_WAIT_MS = 2_500;

/** How long a field without autocomplete attributes waits to see whether typing opened suggestions. */
export const SUGGESTION_SHORT_WAIT_MS = 400;

/** How long its suggestions may take to fill in once the list opens. */
export const SUGGESTION_SETTLE_MS = 600;

/** How long `select` waits for its option: a `<select>` that has it chooses it at once. */
export const SELECT_TIMEOUT_MS = 2_000;

/** What Playwright says when a `<select>` has no such option (it waits for one until its timeout). */
export const NO_SUCH_OPTION = /did not find some options|Timeout \d+ms exceeded/i;

/** The options a custom drop-down shows once open: ARIA options and menu items, as shown. */
export const LIST_OPTION_SELECTOR =
  "[role=option]:visible, [role=menuitem]:visible, [role=menuitemradio]:visible, [role=menuitemcheckbox]:visible";

/** How long a scroll waits for content the page loads as it is scrolled to. */
export const SCROLL_SETTLE_MS = 400;

/** `wait_for`'s default. */
export const WAIT_DEFAULT_MS = 5_000;

/** A limit an option sets: a number, the workspace's (a setting it reads, which failing reads as the default), or the default. */
export async function limitOf(
  option: number | ((workspaceId: string) => number | Promise<number>) | undefined,
  workspaceId: string,
  fallback: number,
): Promise<number> {
  if (typeof option === "number") return option;
  if (option === undefined) return fallback;
  return Promise.resolve()
    .then(() => option(workspaceId))
    .catch(() => fallback);
}

/** Scrolls the page, run in it, and answers where it ended. The window is duck-typed: this package has no DOM types. */
export function scrollPage(where: string): {
  readonly y: number;
  readonly height: number;
  readonly view: number;
  readonly x?: number;
  readonly width?: number;
} {
  const page = globalThis as PageGlobals<{
    readonly documentElement: { readonly scrollHeight: number; readonly scrollWidth?: number };
  }> & { readonly innerWidth?: number; readonly scrollX?: number };
  const height = page.document?.documentElement.scrollHeight ?? 0;
  const width = page.document?.documentElement.scrollWidth ?? 0;
  if (where === "top") page.scrollTo?.(0, 0);
  else if (where === "bottom") page.scrollTo?.(0, height);
  else if (where === "left" || where === "right")
    page.scrollBy?.((where === "left" ? -1 : 1) * Math.round((page.innerWidth ?? 0) * 0.85), 0);
  else page.scrollBy?.(0, (where === "up" ? -1 : 1) * Math.round((page.innerHeight ?? 0) * 0.85));
  return { y: page.scrollY ?? 0, height, view: page.innerHeight ?? 0, x: page.scrollX ?? 0, width };
}

/** Scrolls an element or its nearest scrollable container along `where`, run in the page. */
export function scrollElement(el: unknown, where: string): { readonly offset: number; readonly span: number } {
  interface ScrollableNode {
    scrollLeft?: number;
    scrollTop?: number;
    readonly scrollWidth?: number;
    readonly clientWidth?: number;
    readonly scrollHeight?: number;
    readonly clientHeight?: number;
    readonly parentElement?: ScrollableNode | null;
    scrollBy?(x: number, y: number): void;
  }
  const start = el as ScrollableNode | null;
  if (start === null || start === undefined) return { offset: 0, span: 0 };
  const horizontal = where === "left" || where === "right";
  let target: ScrollableNode = start;
  for (let node: ScrollableNode | null | undefined = start; node !== null && node !== undefined; node = node.parentElement) {
    if (horizontal) {
      if ((node.scrollWidth ?? 0) > (node.clientWidth ?? 0) + 1) {
        target = node;
        break;
      }
    } else if ((node.scrollHeight ?? 0) > (node.clientHeight ?? 0) + 1) {
      target = node;
      break;
    }
  }
  if (horizontal) {
    const step = (where === "left" ? -1 : 1) * Math.max(100, Math.round(((target.clientWidth ?? 0) || 300) * 0.85));
    if (typeof target.scrollBy === "function") target.scrollBy(step, 0);
    else if (typeof target.scrollLeft === "number") target.scrollLeft = Math.max(0, target.scrollLeft + step);
    return { offset: target.scrollLeft ?? 0, span: target.scrollWidth ?? 0 };
  }
  const maxScroll = target.scrollHeight ?? 0;
  if (where === "top") {
    if (typeof target.scrollTop === "number") target.scrollTop = 0;
  } else if (where === "bottom") {
    if (typeof target.scrollTop === "number") target.scrollTop = maxScroll;
  } else {
    const step = (where === "up" ? -1 : 1) * Math.max(100, Math.round(((target.clientHeight ?? 0) || 300) * 0.85));
    if (typeof target.scrollBy === "function") target.scrollBy(0, step);
    else if (typeof target.scrollTop === "number") target.scrollTop = Math.max(0, target.scrollTop + step);
  }
  return { offset: target.scrollTop ?? 0, span: maxScroll };
}

/** How long a navigation waits for `load` once the document itself has loaded. */
export const NAVIGATE_LOAD_GRACE_MS = 2_000;

/** How long a click's destination may take to load before its outcome is reported anyway. */
export const CLICK_LOAD_TIMEOUT_MS = 10_000;

/**
 * Playwright throws a plain (non-`TaviError`) error when the page/context
 * closes mid-action — there is no typed exception class for this, only
 * message text ("Target page, context or browser has been closed" and
 * close variants). Matching on that text is a heuristic, not a guarantee
 * (a future Playwright version could reword it), but it is the only
 * signal available; a write-kind action that hits this converts to
 * `TaviError("UNAVAILABLE", ...)` so `dispatchBrowserAction`
 * (`@tavi/contracts`) can report it `"uncertain"` rather than letting a
 * raw Playwright error escape untyped. Only submit/upload/download call
 * this — `dispatchBrowserAction`'s softening applies to
 * `BROWSER_WRITE_ACTION_KINDS` only, matching `click`/`type` staying
 * unsoftened by design.
 */
export const CLOSED_TARGET_PATTERN = /target (page|frame|closed)|has been closed|target closed/i;

export async function runWriteAction<T>(kind: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && CLOSED_TARGET_PATTERN.test(error.message)) {
      throw new TaviError("UNAVAILABLE", `Browser session was lost mid-${kind}: ${error.message}`);
    }
    throw error;
  }
}
