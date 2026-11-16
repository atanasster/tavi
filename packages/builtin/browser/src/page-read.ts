import type { StructuredBlocks } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import type { Page } from "playwright";

import type { PageGlobals } from "./page-globals.js";
import { within } from "./timing.js";

/** How long reading a page's text may take before `read` gives up on it. */
export const READ_TIMEOUT_MS = 5_000;

/**
 * What a page shows of still loading, sampled before a read: its text's
 * length, and a visible busy or indeterminate progress indicator (one with a
 * value, like an article's reading progress, is not loading) or a short
 * "Loading…" line if it has one. A string, evaluated in the page: this package has no DOM types.
 */
const PAGE_ACTIVITY_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return null;
  const text = body.innerText || "";
  const shown = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  if ([...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]:not([aria-valuenow])')].some(shown)) return { length: text.length, loading: "a busy or progress indicator" };
  const line = text.split("\\n").map((entry) => entry.trim()).find((entry) => entry.length <= 40 && /^(loading|searching|please wait)\\b/i.test(entry));
  return { length: text.length, loading: line === undefined ? null : 'the text "' + line + '"' };
})()`;

/** How long `read` waits at most for a page to stop changing and show no sign of loading. */
export const READ_SETTLE_MAX_MS = 5_000;

/**
 * How much longer `read` waits, by itself, for a page that still showed it was
 * loading: a flight search's results take
 * longer than an article's. A model told `stillLoading` used to answer from the
 * spinner rather than read again.
 */
export const READ_EXTRA_SETTLE_MS = 10_000;

/** How long a navigation waits for its page to settle before observing it. */
export const NAVIGATE_SETTLE_MAX_MS = 3_000;

/** How long a page's text must stay unchanged, with no sign of loading, to count as settled. */
const READ_SETTLE_QUIET_MS = 600;

/** How often `read` samples the page while it waits. */
const READ_SETTLE_POLL_MS = 200;

/**
 * Wait, bounded, for a page that renders its content after it loads (a
 * search's results, a dashboard) to settle. Answers what the page still
 * showed of loading once the wait ran out, or `undefined` when it settled —
 * or could not be sampled, which leaves the read itself to report.
 */
export async function settlePage(page: Page, maxMs: number = READ_SETTLE_MAX_MS): Promise<string | undefined> {
  const deadline = Date.now() + maxMs;
  let length: number | undefined;
  let quietSince = Date.now();
  for (;;) {
    const sample = (await within(
      Promise.resolve().then(() => page.evaluate(PAGE_ACTIVITY_SCRIPT)),
      READ_SETTLE_POLL_MS * 5,
    )) as { length?: unknown; loading?: unknown } | null | undefined;
    if (typeof sample !== "object" || sample === null || typeof sample.length !== "number") return undefined;
    const loading = typeof sample.loading === "string" ? sample.loading : undefined;
    const now = Date.now();
    if (sample.length !== length) {
      length = sample.length;
      quietSince = now;
    } else if (loading === undefined && now - quietSince >= READ_SETTLE_QUIET_MS) {
      return undefined;
    }
    if (now >= deadline) return loading;
    await sleep(READ_SETTLE_POLL_MS);
  }
}

/**
 * The page's structured data as the browser holds it: each JSON-LD block's text, and the top-level microdata items with
 * their properties, nested items kept as items. Runs in the page through
 * `Page.evaluate`, so it is self-contained; it reads attributes and text and
 * runs none of the page's scripts. At most `maxChars` in all, 20 blocks and
 * 20 items.
 */
export function structuredBlocksOf(maxChars: number): StructuredBlocks {
  type Item = { types: string[]; properties: Record<string, (string | Item)[]> };
  /** The DOM's few members read here: this package declares no DOM types, and the function runs in the page. */
  interface Element {
    readonly tagName: string;
    readonly textContent: string | null;
    readonly parentElement: Element | null;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    closest(selector: string): Element | null;
    querySelectorAll(selector: string): ArrayLike<Element>;
  }
  const document = (globalThis as PageGlobals<{ querySelectorAll(selector: string): ArrayLike<Element> }>).document;
  if (document === undefined) return { jsonLd: [], microdata: [] };
  let budget = maxChars;
  const take = (text: string): string => {
    const kept = text.slice(0, Math.max(0, budget));
    budget -= kept.length;
    return kept;
  };
  const jsonLd: string[] = [];
  for (const script of Array.from(document.querySelectorAll("script")).slice(0, 200)) {
    if ((script.getAttribute("type") ?? "").trim().toLowerCase() !== "application/ld+json" || jsonLd.length >= 20 || budget <= 0) continue;
    jsonLd.push(take(script.textContent ?? ""));
  }
  const valueOf = (element: Element): string => {
    const attribute =
      element.getAttribute("content") ??
      element.getAttribute("datetime") ??
      (element.tagName === "A" || element.tagName === "LINK" ? element.getAttribute("href") : null) ??
      (element.tagName === "IMG" ? element.getAttribute("src") : null) ??
      (element.tagName === "META" ? "" : null);
    return take((attribute ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000));
  };
  const itemOf = (scope: Element, depth: number): Item => {
    const item: Item = {
      types: (scope.getAttribute("itemtype") ?? "")
        .split(/\s+/)
        .filter((type) => type !== "")
        .slice(0, 4),
      properties: {},
    };
    // A property belongs to the nearest item around it: its own scope's, not a nested item's.
    for (const element of Array.from(scope.querySelectorAll("[itemprop]")).slice(0, 200)) {
      if (element.parentElement?.closest("[itemscope]") !== scope || budget <= 0) continue;
      const value = element.hasAttribute("itemscope") && depth < 4 ? itemOf(element, depth + 1) : valueOf(element);
      for (const name of (element.getAttribute("itemprop") ?? "")
        .split(/\s+/)
        .filter((part) => part !== "")
        .slice(0, 4))
        (item.properties[name] ??= []).push(value);
    }
    return item;
  };
  const microdata = Array.from(document.querySelectorAll("[itemscope]:not([itemprop])"))
    .slice(0, 20)
    .map((scope) => itemOf(scope, 0));
  return { jsonLd, microdata };
}

/**
 * Runs in the page: the readable text and the http(s) links of an element
 * (`pageContentOf(element, limits)`, as `Locator.evaluate` calls it) or of the
 * page's main content (`pageContentOf(limits)`, as `Page.evaluate` does). The
 * main content is the largest of `main`, `[role=main]` and `article` when it
 * holds at least a quarter of the body's text — an article without the site's
 * navigation around it — and the body otherwise, so a listing whose
 * `<article>`s are small cards is read whole. It must use nothing from this
 * module's scope; the DOM is duck-typed.
 */
export function pageContentOf(
  first: unknown,
  second?: { readonly chars: number; readonly links: number },
): { readonly text: string; readonly links: { readonly text: string; readonly href: string }[]; readonly truncated: boolean } {
  const limits = second ?? (first as { readonly chars: number; readonly links: number });
  const root = second === undefined ? undefined : first;
  interface Node {
    readonly innerText?: string;
    readonly href?: unknown;
    querySelectorAll(selector: string): ArrayLike<Node>;
  }
  const document = (globalThis as PageGlobals<{ readonly body: Node | null } & Node>).document;
  let scope = root as Node | undefined;
  if (scope === undefined) {
    const body = document?.body ?? null;
    const whole = body?.innerText ?? "";
    let best: Node | undefined;
    for (const candidate of Array.from(document?.querySelectorAll("main, [role=main], article") ?? [])) {
      if ((candidate.innerText ?? "").length > (best?.innerText ?? "").length) best = candidate;
    }
    scope =
      best !== undefined && (best.innerText ?? "").length >= whole.length / 4 && (best.innerText ?? "").trim() !== ""
        ? best
        : (body ?? undefined);
  }
  const text = scope?.innerText ?? "";
  // One link per destination, with the first text any of its anchors has: an image beside a headline links to the same story.
  const seen = new Map<string, { text: string; href: string }>();
  const links: { text: string; href: string }[] = [];
  let truncated = text.length > limits.chars;
  for (const anchor of Array.from(scope?.querySelectorAll("a[href]") ?? [])) {
    const href = typeof anchor.href === "string" ? anchor.href : "";
    if (!/^https?:\/\//i.test(href) || href.length > 2048) continue;
    const label = (anchor.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const earlier = seen.get(href);
    if (earlier !== undefined) {
      if (earlier.text === "") earlier.text = label;
      continue;
    }
    if (links.length >= limits.links) {
      truncated = true;
      break;
    }
    const link = { text: label, href };
    seen.set(href, link);
    links.push(link);
  }
  return { text: text.slice(0, limits.chars), links, truncated };
}

/** Layout whitespace squeezed out: each line trimmed, runs of spaces and of blank lines collapsed. */
export function tidyPageText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
