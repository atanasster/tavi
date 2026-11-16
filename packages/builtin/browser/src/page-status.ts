import type { BrowserBlock, BrowserElementSummary, BrowserNetworkError, BrowserSessionState, BrowserActionDialog } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import type { Page } from "playwright";

import { PAGE_SIGNALS_SCRIPT, classifyPage, DECLINE_CONSENT_SCRIPT } from "./blocked.js";
import { type PageState, pageStateOf, PAGE_STATE_SCRIPT } from "./changes.js";
import { pdfBodyOf } from "./download-media.js";
import type { StoredElementRef } from "./session-types.js";
import { within } from "./timing.js";

/** How long the page may take to be sampled for a block, or to answer a consent banner. */
export const SIGNALS_TIMEOUT_MS = 1_500;

/** How long a declined consent banner may take to go, or its page to move on, before the page is read anyway. */
const CONSENT_SETTLE_MS = 5_000;

/** What blocks `page`, if anything: its URL, title, the start of its text and its frames, read in it, with its last status. */
export async function blockOf(page: Page, title: string | undefined, status: number | undefined): Promise<BrowserBlock | undefined> {
  const sampled = (await within(
    Promise.resolve().then(() => page.evaluate(PAGE_SIGNALS_SCRIPT)),
    SIGNALS_TIMEOUT_MS,
  )) as { text?: unknown; frames?: unknown; password?: unknown } | undefined;
  if (typeof sampled !== "object" || sampled === null || typeof sampled.text !== "string") return undefined;
  return classifyPage({
    url: page.url(),
    title,
    text: sampled.text,
    frames: Array.isArray(sampled.frames) ? sampled.frames.filter((src): src is string => typeof src === "string") : [],
    password: sampled.password === true,
    status,
  });
}

/**
 * What a page shows of having failed — "Oops, something went wrong", "Error
 * loading results" — and the control it offers to try again, said as what to
 * do next; `undefined` for a page with no such error. Run in the page: a string,
 * since this package has no DOM types.
 */
const RECOVERY_SCRIPT = `(() => {
  const text = document.body ? (document.body.innerText || "").slice(0, 5000) : "";
  // A short line of its own, as an error message is: an article that mentions errors is not one.
  const error = text.split("\\n").map((line) => line.trim()).find((line) => line.length <= 80 && /^(oops[,.!]?\\s*)?(something went wrong|an (unexpected )?error (has )?occurred|error loading\\b|(failed to|couldn.t|could not|unable to) load\\b)/i.test(line));
  if (!error) return null;
  const shown = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const control = [...document.querySelectorAll("button, [role=button], a")].filter(shown).find((element) => /^(reload|try again|retry|refresh|reload page)$/i.test((element.innerText || "").trim()));
  return { error: error.slice(0, 100), control: control ? (control.innerText || "").trim().slice(0, 40) : null };
})()`;

/**
 * What a failed page offers, said as the next step: its control by
 * ref when the latest observation of this page lists it, so it is one click.
 */
export async function recoveryOf(
  page: Page,
  latest?: { readonly url: string; readonly epoch: number; readonly elements: readonly BrowserElementSummary[] },
): Promise<string | undefined> {
  const found = (await within(
    Promise.resolve().then(() => page.evaluate(RECOVERY_SCRIPT)),
    SIGNALS_TIMEOUT_MS,
  )) as { error?: unknown; control?: unknown } | null | undefined;
  if (typeof found !== "object" || found === null || typeof found.error !== "string") return undefined;
  const error = JSON.stringify(found.error);
  if (typeof found.control !== "string" || found.control === "")
    return `the page shows an error (${error}): navigate to it again once, then look elsewhere`;
  const control = found.control;
  const listed =
    latest?.url === page.url()
      ? latest.elements.find((element) => element.text === control && (element.role === "button" || element.role === "link"))
      : undefined;
  return listed === undefined || latest === undefined
    ? `the page shows an error (${error}) and offers ${JSON.stringify(control)}: observe and click it, or navigate to the page again, before looking elsewhere`
    : `the page shows an error (${error}) and offers ${JSON.stringify(control)}: click ${listed.ref} (epoch ${latest.epoch}), or navigate to the page again, before looking elsewhere`;
}

/** The page's state for a change summary (`changes.ts`), when it can be read in time. */
export async function sampleState(page: Page): Promise<PageState | undefined> {
  return pageStateOf(
    await within(
      Promise.resolve().then(() => page.evaluate(PAGE_STATE_SCRIPT)),
      SIGNALS_TIMEOUT_MS,
    ),
  );
}

const AGENT_DIALOG_MESSAGE_MAX = 500;

/** The most dialogs one outcome reports: the latest, when a page raises more. */
const AGENT_DIALOGS_REPORTED_MAX = 10;

const MAX_NETWORK_ERRORS = 10;

const PAGE_ERROR_MAX_CHARS = 200;

/** Strips userinfo, query parameters, and fragments from a URL before surfacing it in `networkErrors`. */
export function scrubErrorUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 200);
    }
  } catch {
    // Fall through to query/hash stripping on raw string.
  }
  const cut = raw.split(/[?#]/, 1)[0] ?? raw;
  return cut.slice(0, 200);
}

/** The network errors a session met after it had met `seen` in all: what the action since then ran into. */
export function networkErrorsSince(
  record: { readonly recentErrors?: readonly BrowserNetworkError[] | undefined; readonly networkErrorsSeen?: number | undefined },
  seen: number,
): BrowserNetworkError[] {
  const kept = record.recentErrors ?? [];
  const added = Math.min(kept.length, Math.max(0, (record.networkErrorsSeen ?? 0) - seen));
  return added === 0 ? [] : kept.slice(-added);
}

function pushNetworkError(
  record: { recentErrors?: BrowserNetworkError[] | undefined; networkErrorsSeen?: number | undefined },
  entry: BrowserNetworkError,
): void {
  record.networkErrorsSeen = (record.networkErrorsSeen ?? 0) + 1;
  record.recentErrors ??= [];
  if (record.recentErrors.length >= MAX_NETWORK_ERRORS) {
    record.recentErrors.shift();
  }
  record.recentErrors.push(entry);
}

/**
 * Keep `record.lastStatus` as the HTTP status of the last main-frame
 * navigation of `page`, while it is the session's page: a navigate, a click or
 * submit that loads a page, a reload, a person's own navigation in a takeover.
 */
export function trackStatus(
  record: {
    state?: BrowserSessionState | undefined;
    lastStatus: number | undefined;
    page: Page;
    pages?: Page[] | undefined;
    openers?: Map<Page, Page> | undefined;
    trackedPages?: WeakSet<Page> | undefined;
    returnedFromPopup?: Page | undefined;
    onActivePageChanged?: ((next: Page) => void) | undefined;
    epoch: number;
    minValidEpoch?: number | undefined;
    elements: Map<string, StoredElementRef>;
    elementsByEpoch?: Map<number, Map<string, StoredElementRef>> | undefined;
    /** Pages whose dialogs a takeover answers (`ControlledSession.heldDialogPages`). */
    readonly heldDialogPages: Set<Page>;
    armedDialog?: { readonly accept: true; readonly promptText?: string | undefined; readonly message?: string | undefined } | undefined;
    lastDialog?: BrowserActionDialog | undefined;
    readonly unreportedDialogs: BrowserActionDialog[];
    pdfPage?:
      | { readonly url: string; readonly hostPageUrl: string; readonly text: string; readonly title?: string | undefined }
      | undefined;
    lastMainPdfBytes?: { readonly url: string; readonly bytes: Promise<Uint8Array | "over-cap" | undefined> } | undefined;
    recentErrors?: BrowserNetworkError[] | undefined;
    networkErrorsSeen?: number | undefined;
  },
  page: Page,
): void {
  if (record.trackedPages?.has(page)) return;
  record.trackedPages?.add(page);
  page.on("close", () => {
    const idx = record.pages?.indexOf(page) ?? -1;
    if (idx >= 0) record.pages?.splice(idx, 1);
    if (record.state === "closed" || record.page !== page) return;
    const opener = record.openers?.get(page);
    const next =
      opener !== undefined && record.pages?.includes(opener) === true && (opener as { isClosed?: () => boolean }).isClosed?.() !== true
        ? opener
        : record.pages?.findLast((candidate) => (candidate as { isClosed?: () => boolean }).isClosed?.() !== true);
    if (next !== undefined) {
      record.page = next;
      record.lastStatus = undefined;
      // The popup's refs are gone with it: an act on one is stale, not unknown.
      record.epoch += 1;
      record.minValidEpoch = record.epoch;
      record.elements = new Map();
      record.elementsByEpoch?.clear();
      record.returnedFromPopup = next;
      record.onActivePageChanged?.(next);
    }
  });
  // A new document or main-frame history navigation (pushState, replaceState): refs name elements of the old state, so they go stale.
  page.on("domcontentloaded", () => {
    if (record.page !== page) return;
    record.epoch += 1;
    record.minValidEpoch = record.epoch;
    record.elements = new Map();
    record.elementsByEpoch?.clear();
  });
  page.on("framenavigated", (frame) => {
    if (record.page !== page) return;
    if (typeof page.mainFrame === "function" && frame !== undefined && frame !== page.mainFrame()) return;
    record.epoch += 1;
    record.minValidEpoch = record.epoch;
    record.elements = new Map();
    record.elementsByEpoch?.clear();
  });
  page.on("dialog", (opened) => {
    // A page the person's takeover holds answers its own; every other dialog is answered here, or its page hangs.
    if (record.heldDialogPages.has(page)) return;
    const rawType = typeof opened.type === "function" ? opened.type() : "alert";
    if (record.page !== page) {
      // A background tab or the opener behind a popup: no action of the agent's raised it, so nothing armed applies.
      void (rawType === "alert" ? opened.accept() : opened.dismiss()).catch(() => undefined);
      return;
    }
    const type: BrowserActionDialog["type"] =
      rawType === "confirm" || rawType === "prompt" || rawType === "beforeunload" ? rawType : "alert";
    const message = (typeof opened.message === "function" ? opened.message() : "").slice(0, AGENT_DIALOG_MESSAGE_MAX);
    const armed = record.armedDialog;
    // Only an alert is accepted unasked: a confirm, a prompt and "leave with unsaved changes?" stay dismissed unless armed.
    // An accept armed for one dialog's message never accepts another the page raises instead; it is spent on the one it accepts.
    const armedAccepts =
      armed?.accept === true &&
      (type === "confirm" || type === "beforeunload") &&
      (armed.message === undefined || armed.message === message);
    if (armedAccepts) record.armedDialog = undefined;
    const accept = type === "alert" || armedAccepts;
    const handled: BrowserActionDialog["handled"] = accept ? "accepted" : "dismissed";
    record.lastDialog = { type, message, handled };
    record.unreportedDialogs.push(record.lastDialog);
    if (record.unreportedDialogs.length > AGENT_DIALOGS_REPORTED_MAX) record.unreportedDialogs.shift();
    if (accept) {
      void opened.accept().catch(() => undefined);
    } else {
      void opened.dismiss().catch(() => undefined);
    }
  });
  page.on("response", (response) => {
    if (record.page !== page) return;
    try {
      const status = typeof response.status === "function" ? response.status() : 200;
      const request = response.request();
      const resourceType =
        typeof (request as { readonly resourceType?: unknown }).resourceType === "function"
          ? request.resourceType().toLowerCase()
          : request.isNavigationRequest()
            ? "document"
            : "";
      if (status >= 400 && (resourceType === "fetch" || resourceType === "xhr" || resourceType === "document")) {
        const method = (typeof (request as { readonly method?: unknown }).method === "function" ? request.method() : "GET")
          .toUpperCase()
          .slice(0, 16);
        const rawUrl =
          typeof response.url === "function"
            ? response.url()
            : typeof (request as { readonly url?: unknown }).url === "function"
              ? request.url()
              : page.url();
        pushNetworkError(record, { status, method, url: scrubErrorUrl(rawUrl) });
      }
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        record.lastStatus = status;
        const headers = typeof response.headers === "function" ? response.headers() : {};
        const contentType = (headers["content-type"] ?? "").toLowerCase();
        const resUrl = typeof response.url === "function" ? response.url() : page.url();
        const hasBody = typeof (response as { readonly body?: unknown }).body === "function";
        if (hasBody && (contentType.includes("application/pdf") || /\.pdf(?:[?#]|$)/i.test(resUrl))) {
          record.lastMainPdfBytes = { url: resUrl, bytes: pdfBodyOf(headers, () => response.body()) };
        }
      }
    } catch {
      // A response with no frame (a service worker's) is not a navigation.
    }
  });
  page.on("pageerror", (error) => {
    if (record.page !== page) return;
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const clipped = raw.replace(/\s+/g, " ").trim().slice(0, PAGE_ERROR_MAX_CHARS);
    if (clipped !== "") {
      pushNetworkError(record, { pageError: clipped });
    }
  });
}

/**
 * Answer a cookie-consent banner by declining what is not essential, and let
 * the page move on: the button pressed, or `undefined` when there was none to
 * press (`DECLINE_CONSENT_SCRIPT`).
 */
/** The cookie banner declined (the button pressed), or one that covers the page with no way to decline (`wall`). */
export async function declineConsent(page: Page): Promise<{ readonly pressed?: string; readonly wall?: boolean }> {
  const answer = (await within(
    Promise.resolve().then(() => page.evaluate(DECLINE_CONSENT_SCRIPT)),
    SIGNALS_TIMEOUT_MS,
  )) as { pressed?: unknown; wall?: unknown } | null | undefined;
  if (typeof answer !== "object" || answer === null) return {};
  if (answer.wall === true) return { wall: true };
  if (typeof answer.pressed !== "string" || answer.pressed === "") return {};
  // A consent page redirects to the site; a banner just closes.
  await sleep(500);
  await within(page.waitForLoadState("load"), CONSENT_SETTLE_MS);
  return { pressed: answer.pressed };
}

/** A cookie banner over the page that offers only to accept: accepting is the person's choice. */
export const CONSENT_WALL: BrowserBlock = { kind: "consent", detail: "a cookie banner covering the page" };

export function hostOfUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
