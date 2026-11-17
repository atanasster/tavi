import {
  type BrowserElementSummary,
  BROWSER_ELEMENT_TEXT_MAX_CHARS,
  REVIEW_STEP_HEADING_SOURCE,
  SEARCH_FIELD_WORD_SOURCE,
  SEARCH_FIELD_EXACT_SOURCE,
  DISQUALIFYING_SEARCH_FIELD_SOURCE,
  TaviError,
  compactBrowserElements,
} from "@tavi/contracts";
import type { Locator, Frame, Page } from "playwright";

import { SECRET_FIELD_PATTERN } from "./secrets.js";
import { isSearchFormIn } from "./search-form.js";
import type { PageGlobals } from "./page-globals.js";
import { SCOPE_TIMEOUT_MS, visibleChildFrames, refusedFrames } from "./frames.js";
import type { PlaywrightBrowserOptions } from "./options.js";
import type { StoredElementRef } from "./session-types.js";
import { SCAN_TIMEOUT_MS, beforeDeadline, within } from "./timing.js";

export const INTERACTIVE_SELECTOR = "a, button, input, select, textarea, summary, h1, h2, h3, [role]";

/** What the page-side scan keeps of one element; `index` is its place among the selector's matches. */
export interface ScannedElement {
  readonly index: number;
  readonly role?: string;
  readonly text?: string;
  readonly context?: string;
  readonly href?: string;
  /** In the site's navigation, header, footer or sidebar: see `BrowserScannedElement`. */
  readonly chrome?: true;
  /** A form field's value now; never a password's. */
  readonly value?: string;
  /** `checked`, `expanded`, `disabled`…: see `BrowserElementSummary.state`. */
  readonly state?: string;
  /** A control that submits its form: see `BrowserElementSummary.submitsForm`. */
  readonly submitsForm?: true;
  /** A field or control inside a strict search form: see `BrowserElementSummary.searchForm`. */
  readonly searchForm?: true;
  /** A searchbox or combobox in a form that is not a search form (Enter may submit it): see `BrowserElementSummary.inForm`. */
  readonly inForm?: true;
  /** A field that holds a password, one-time code, PIN or card detail: see `BrowserElementSummary.secret`. */
  readonly secret?: true;
  /** What makes it the element it is, across observations: its tag, role, id, name, type, label and link. */
  readonly key?: string;
  /** How many elements of the whole page with the same `key` came before it. */
  readonly occurrence?: number;
}

/** The DOM an element exposes to `scanPage`, duck-typed: this package has no DOM types. */
export interface ScannableElement {
  readonly tagName: string;
  readonly parentElement: ScannableElement | null;
  readonly isContentEditable?: boolean;
  readonly innerText?: string;
  readonly href?: unknown;
  readonly type?: unknown;
  readonly value?: unknown;
  readonly labels?: ArrayLike<{ readonly innerText?: string }> | null;
  readonly checked?: unknown;
  readonly disabled?: unknown;
  readonly selectedOptions?: ArrayLike<{ readonly text?: string }>;
  getAttribute(name: string): string | null;
  /** Its document, or the shadow root it is in: either hit-tests a point. */
  getRootNode(): {
    readonly host?: ScannableElement | null;
    elementFromPoint?(x: number, y: number): { contains?(other: unknown): boolean } | null;
  };
  getBoundingClientRect(): { readonly width: number; readonly height: number; readonly left?: number; readonly top?: number };
  contains?(other: unknown): boolean;
  closest(selector: string): ScannableElement | null;
  checkVisibility?(options: Readonly<Record<string, boolean>>): boolean;
  querySelector(selector: string): ScannableElement | null;
  querySelectorAll?(selector: string): ArrayLike<ScannableElement>;
}

interface ScanOptions {
  /** Stop once this many elements are kept: bounds the text taken from a very large page. */
  readonly limit: number;
  /** Text past this is not sent back from the page (the summary clips shorter still). */
  readonly textChars: number;
  /** A longer `href` is left out, never cut. */
  readonly hrefChars: number;
  /**
   * Keep only elements within this part of the page: an element (a ref's), or
   * the last shown match of a selector. Every element is still counted for its
   * identity's occurrence, so a scoped observation names each one as a whole
   * page's does.
   */
  readonly scope?: { readonly root?: unknown; readonly selector?: string };
  /** `SECRET_FIELD_PATTERN`: a field it names never has its value listed. */
  readonly secretPattern: string;
  /** `REVIEW_STEP_HEADING_SOURCE`: a form's buttons under such a heading submit it. */
  readonly reviewHeading: string;
  /** `SEARCH_FIELD_WORD_SOURCE`: search-like words in a field's name, id, label or placeholder. */
  readonly searchFieldWord: string;
  /** `SEARCH_FIELD_EXACT_SOURCE`: short search-like tokens (`q`, `from`, `to`, `city`) matched whole. */
  readonly searchFieldExact: string;
  /** `DISQUALIFYING_SEARCH_FIELD_SOURCE`: protected or personal field words that disqualify a search form. */
  readonly disqualifyingSearchField: string;
}

/**
 * `scanPage` as Playwright runs it in the page: Playwright sends a page
 * function's source, and this one's carries `isSearchFormIn` along with it.
 */
export const SCAN_PAGE: typeof scanPage = Object.assign(
  (elements: readonly ScannableElement[], options: ScanOptions) => scanPage(elements, options),
  {
    toString: () => `(elements, options) => (${scanPage.toString()})(elements, options, ${isSearchFormIn.toString()})`,
  },
);

/**
 * Runs in the page, over every element the selector matched (so it must use
 * nothing from this module's scope but `searchFormTest`, which `SCAN_PAGE` passes in). It keeps, in document order:
 *  - what the model can act on — a link, a button, a form field, an element
 *    whose role makes it one — with its text, or its label when it has none;
 *  - a leaf that is not actionable (a `role="status"`, a heading) with its text.
 * It leaves out whatever is not rendered (a closed menu, a zero-size
 * element — except a file input, which pages hide behind a styled label), a
 * hidden input, and a container role (`navigation`, `list`, `main`) whose
 * text is only its descendants', which are listed themselves. An element in
 * the site's chrome — a `nav`, an `aside`, a page-level `header` or `footer`,
 * or their landmark roles — is marked so, for the page's content to come first.
 */
function scanPage(
  elements: readonly ScannableElement[],
  options: ScanOptions,
  searchFormTest: typeof isSearchFormIn = isSearchFormIn,
): { readonly elements: ScannedElement[]; readonly scopeFound: boolean } {
  const actionableRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "combobox",
    "textbox",
    "searchbox",
    "slider",
    "spinbutton",
    "treeitem",
  ]);
  const fieldRoles = new Set(["combobox", "textbox", "searchbox", "slider", "spinbutton"]);
  const upOf = (element: ScannableElement): ScannableElement | null => element.parentElement ?? element.getRootNode().host ?? null;
  const squeeze = (value: unknown): string =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, options.textChars) : "";
  const contextOf = (el: ScannableElement, ownLabel: string): string => {
    const row = el.closest("li, tr, article, [role=row], [role=listitem], [role=article]");
    // A card is a class named "card" or ending in "-card" ("product-card"); never "card-body", "discard" or "scorecard".
    let card: ScannableElement | null = null;
    for (let up: ScannableElement | null = el; up !== null && up !== row; up = up.parentElement) {
      if (/(?:^|\s)(?:[\w-]+-)?card(?=\s|$)/i.test(up.getAttribute("class") ?? "")) {
        card = up;
        break;
      }
    }
    const container = card ?? row;
    if (container === null || container === (el as unknown)) return "";
    const heading = container.querySelector("h1, h2, h3, h4, [role=heading]");
    const headingText = typeof heading?.innerText === "string" ? heading.innerText.replace(/\s+/g, " ").trim() : "";
    const selfText = (typeof el.innerText === "string" ? el.innerText : "").replace(/\s+/g, " ").trim() || ownLabel;
    let raw = typeof container.innerText === "string" ? container.innerText : "";
    if (selfText !== "") {
      const idx = raw.lastIndexOf(selfText);
      if (idx !== -1) raw = `${raw.slice(0, idx)} ${raw.slice(idx + selfText.length)}`;
    }
    if (ownLabel !== "" && ownLabel !== selfText) {
      const idx = raw.lastIndexOf(ownLabel);
      if (idx !== -1) raw = `${raw.slice(0, idx)} ${raw.slice(idx + ownLabel.length)}`;
    }
    let cleaned = raw.replace(/\s+/g, " ").trim();
    if (headingText !== "" && headingText !== selfText && headingText !== ownLabel && !cleaned.startsWith(headingText)) {
      cleaned = cleaned === "" ? headingText : `${headingText} · ${cleaned}`;
    }
    if (cleaned === "" || cleaned === ownLabel || cleaned === selfText) return "";
    return cleaned.slice(0, 60).trimEnd();
  };
  const matched = new Set(elements);
  const containers = new Set<ScannableElement>();
  for (const element of elements) {
    for (let up = upOf(element); up !== null; up = upOf(up)) {
      if (matched.has(up)) {
        containers.add(up);
        break;
      }
    }
  }
  // The part of the page an observation keeps: a ref's element, else the last shown match of a named scope.
  const shownBox = (element: ScannableElement): boolean => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  let scopeRoot: ScannableElement | undefined;
  let scopeFound = true;
  if (options.scope !== undefined) {
    const document = (globalThis as PageGlobals<{ querySelectorAll(selector: string): ArrayLike<ScannableElement> }>).document;
    scopeRoot =
      (options.scope.root as ScannableElement | undefined) ??
      (options.scope.selector === undefined
        ? undefined
        : Array.from(document?.querySelectorAll(options.scope.selector) ?? [])
            .filter(shownBox)
            .at(-1));
    scopeFound = scopeRoot !== undefined;
  }
  const inScope = (element: ScannableElement): boolean => {
    if (options.scope === undefined) return true;
    for (let up: ScannableElement | null = element; up !== null; up = upOf(up)) if (up === scopeRoot) return true;
    return false;
  };
  // Every element's identity is counted over the whole page, kept or not, so its occurrence never depends on the scope.
  const occurrences = new Map<string, number>();
  const kept: ScannedElement[] = [];
  // A review step: a form's buttons under one submit it.
  const page = globalThis as PageGlobals<{
    querySelectorAll(selector: string): ArrayLike<{ readonly innerText?: string }>;
    querySelector(selector: string): unknown;
  }>;
  const headings = page.document?.querySelectorAll("h1, h2, h3, [role=heading]") ?? [];
  const review = new RegExp(options.reviewHeading, "iu");
  const reviewing = Array.from(headings).some((heading) => review.test(heading.innerText ?? ""));
  // On a page with forms, a review step commits through its form: a button outside one (a scroll to the form) does not.
  const pageHasForm = (page.document?.querySelector("form") ?? null) !== null;
  const searchFormPatterns = {
    searchWord: options.searchFieldWord,
    searchExact: options.searchFieldExact,
    disqualifyingField: options.disqualifyingSearchField,
    secret: options.secretPattern,
  };
  const searchForms = new Map<ScannableElement, boolean>();
  const isSearchForm = (form: ScannableElement | null): boolean => {
    if (form === null) return false;
    const cached = searchForms.get(form);
    if (cached !== undefined) return cached;
    const answer = searchFormTest(form, searchFormPatterns);
    searchForms.set(form, answer);
    return answer;
  };
  for (const [index, element] of elements.entries()) {
    const tag = element.tagName.toUpperCase();
    const explicitRole = (element.getAttribute("role") ?? "").trim();
    const roles = explicitRole.toLowerCase().split(/\s+/);
    const type = tag === "INPUT" ? String(element.type ?? "text").toLowerCase() : "";
    if (type === "hidden") continue;
    const rect = element.getBoundingClientRect();
    const rendered =
      rect.width > 0 && rect.height > 0 && (element.checkVisibility?.({ checkVisibilityCSS: true, visibilityProperty: true }) ?? true);
    if (!rendered && type !== "file") continue;
    const isLink = (tag === "A" || tag === "AREA") && element.getAttribute("href") !== null;
    const isField =
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      element.isContentEditable === true ||
      roles.some((role) => fieldRoles.has(role));
    const actionable = isField || isLink || tag === "BUTTON" || tag === "SUMMARY" || roles.some((role) => actionableRoles.has(role));
    if (!actionable && containers.has(element)) continue;
    const buttonInput = type === "submit" || type === "button" || type === "reset" || type === "image";
    // A label wrapped round its field (`<label>Cabin <select>…</select></label>`) holds the field's own text too: only the label's is its name.
    const own = typeof element.innerText === "string" ? element.innerText : "";
    const labelText = element.labels?.[0]?.innerText ?? "";
    const label =
      [
        isField && !buttonInput ? squeeze(own !== "" && labelText.includes(own) ? labelText.replace(own, "") : labelText) : "",
        isField && !buttonInput ? "" : squeeze(buttonInput ? element.value : element.innerText),
        squeeze(element.getAttribute("aria-label")),
        squeeze(element.getAttribute("placeholder")),
        squeeze(element.getAttribute("title")),
        squeeze(element.getAttribute("alt")),
        isLink || tag === "BUTTON" ? squeeze(element.querySelector("img[alt]")?.getAttribute("alt")) : "",
      ].find((candidate) => candidate !== "") ?? "";
    const rawHref = isLink ? element.href : undefined;
    const href = typeof rawHref === "string" && rawHref.length <= options.hrefChars && /^https?:\/\//i.test(rawHref) ? rawHref : undefined;
    if (label === "" && href === undefined && !actionable) continue;
    let role = explicitRole;
    if (role === "") {
      if (tag === "BUTTON" || buttonInput) role = "button";
      else if (tag === "H1" || tag === "H2" || tag === "H3") role = "heading";
      else if (type === "checkbox" || type === "radio" || type === "file") role = type;
      else if (type === "range") role = "slider";
      else if (type === "number") role = "spinbutton";
      else if (type === "search") role = "searchbox";
      else if (tag === "SELECT") role = "combobox";
      else if (tag === "INPUT" || tag === "TEXTAREA") role = "textbox";
    }
    // What a person sees a field hold, and its state: a typed value, a chosen option, a ticked box.
    // Never what a secret field holds: a password (or one a "show password" switch made plain), a one-time code, a card's number or code.
    const secret = new RegExp(options.secretPattern, "i");
    const naming = [
      element.getAttribute("autocomplete"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.labels?.[0]?.innerText,
    ]
      .filter((part) => typeof part === "string")
      .join(" ");
    const nonSecretRole = roles.some(
      (r) => r === "checkbox" || r === "radio" || r === "switch" || r === "menuitemcheckbox" || r === "menuitemradio",
    );
    const isSecretField =
      isField &&
      !buttonInput &&
      !nonSecretRole &&
      type !== "file" &&
      type !== "checkbox" &&
      type !== "radio" &&
      (type === "password" || secret.test(naming));
    let value = "";
    if (isField && !buttonInput && !nonSecretRole && type !== "file" && type !== "checkbox" && type !== "radio" && !isSecretField) {
      value =
        tag === "SELECT"
          ? squeeze(element.selectedOptions?.[0]?.text)
          : element.isContentEditable === true && tag !== "INPUT" && tag !== "TEXTAREA"
            ? ""
            : squeeze(element.value);
    }
    const states: string[] = [];
    const ariaChecked = element.getAttribute("aria-checked");
    if (type === "checkbox" || type === "radio") states.push(element.checked === true ? "checked" : "unchecked");
    else if (ariaChecked === "true" || ariaChecked === "false") states.push(ariaChecked === "true" ? "checked" : "unchecked");
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") states.push(expanded === "true" ? "expanded" : "collapsed");
    if (
      element.getAttribute("aria-selected") === "true" ||
      element.getAttribute("aria-current") === "true" ||
      element.getAttribute("aria-current") === "page"
    )
      states.push("selected");
    if (element.disabled === true || element.getAttribute("aria-disabled") === "true") states.push("disabled");
    const key = [
      tag,
      explicitRole,
      element.getAttribute("id") ?? "",
      element.getAttribute("name") ?? "",
      type,
      label,
      typeof rawHref === "string" ? rawHref : "",
    ].join("\u0001");
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (!inScope(element) || kept.length >= options.limit) continue;
    // Under something else where a click would land — a modal, a cookie banner, a sticky bar: a click reaches that instead.
    // Hit-tested in the element's own root: a document answers a shadow root's host for anything inside it.
    type HitTester = Pick<ReturnType<ScannableElement["getRootNode"]>, "elementFromPoint">;
    const view = globalThis as PageGlobals<HitTester>;
    const ownRoot = element.getRootNode();
    const tester = typeof ownRoot.elementFromPoint === "function" ? ownRoot : view.document;
    if (rendered && rect.left !== undefined && rect.top !== undefined && tester?.elementFromPoint !== undefined) {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x >= 0 && y >= 0 && x < (view.innerWidth ?? 0) && y < (view.innerHeight ?? 0)) {
        const hit = tester.elementFromPoint(x, y);
        const labels = Array.from(element.labels ?? []) as unknown[];
        if (
          hit !== null &&
          hit !== (element as unknown) &&
          element.contains?.(hit) !== true &&
          hit.contains?.(element) !== true &&
          !labels.some((label) => label === hit || (label as { contains?(other: unknown): boolean }).contains?.(hit) === true)
        ) {
          states.push("covered");
        }
      }
    }
    // What submits a form: a submit button in a form, a button of a form whose fields are filled, or one under a review step (in its form, when the page has one).
    const form = element.closest("form");
    const buttonish = tag === "BUTTON" || (tag === "INPUT" && (type === "submit" || type === "image")) || roles.includes("button");
    const filled =
      form !== null &&
      Array.from(form.querySelectorAll?.("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea") ?? []).some(
        (field) => typeof field.value === "string" && field.value.trim() !== "",
      );
    const submitsForm =
      buttonish &&
      ((form !== null &&
        ((tag === "BUTTON" && ["", "submit"].includes((element.getAttribute("type") ?? "").toLowerCase())) || tag === "INPUT" || filled)) ||
        (reviewing && (form !== null || !pageHasForm)));
    const inSearchForm = (isField || buttonish) && isSearchForm(form);
    // Only where Enter's meaning turns on it: a search-like field Enter would otherwise leave alone.
    const inOtherForm = form !== null && !inSearchForm && (role === "searchbox" || role === "combobox");
    const context = actionable ? contextOf(element, label) : "";
    const band = element.closest("header, footer");
    const chrome =
      element.closest("nav, aside, [role=banner], [role=navigation], [role=contentinfo], [role=complementary]") !== null ||
      (band !== null && band.closest("article, main, [role=main]") === null);
    kept.push({
      index,
      ...(role === "" ? {} : { role }),
      ...(label === "" ? {} : { text: label }),
      ...(context === "" ? {} : { context }),
      ...(href === undefined ? {} : { href }),
      ...(chrome ? { chrome: true as const } : {}),
      ...(value === "" ? {} : { value }),
      ...(states.length === 0 ? {} : { state: states.join(" ") }),
      ...(submitsForm ? { submitsForm: true as const } : {}),
      ...(inSearchForm ? { searchForm: true as const } : {}),
      ...(inOtherForm ? { inForm: true as const } : {}),
      ...(isSecretField ? { secret: true as const } : {}),
      key,
      occurrence,
    });
  }
  return { elements: kept, scopeFound };
}

/**
 * How many elements the page-side scan keeps before `compactBrowserElements`
 * drops repeats and applies the observation's own bounds: enough headroom that
 * a site's menus and tickers do not crowd out the content after them.
 */
export const SCAN_LIMIT = 500;

/** The longest `href` an element summary carries: past it the link is left out, never cut. */
export const MAX_HREF_LENGTH = 2_048;

/**
 * The refs a session has handed out: one
 * number per element identity (`ScannedElement.key`, with its occurrence), kept
 * across observations and never given to another. An element seen first takes
 * its place among the scan's matches, as refs always did, unless that number is
 * taken; after that it keeps it, so a page re-observed names the same element
 * by the same ref.
 */
export interface RefRegistry {
  readonly byKey: Map<string, number>;
  readonly used: Set<number>;
  next: number;
  /** The epoch it was started (or last started over) at: a ref from before it may name another element now. */
  since: number;
  readonly frames?: Map<string, RefRegistry> | undefined;
}

/** Past this many identities a session's registry starts over: a long session's refs stay short. */
const REF_REGISTRY_MAX = 5_000;

export function newRefRegistry(): RefRegistry {
  return { byKey: new Map(), used: new Set(), next: 0, since: 0, frames: new Map() };
}

export interface AutoRefreshOptions {
  readonly autoRefresh?: boolean | undefined;
  readonly urlChanged?: boolean | undefined;
  readonly bumpMinEpoch?: boolean | undefined;
  readonly preScanned?: Awaited<ReturnType<typeof scanElements>> | undefined;
}

export function cloneRefRegistry(registry: RefRegistry): RefRegistry {
  const frames = new Map<string, RefRegistry>();
  if (registry.frames !== undefined) {
    for (const [k, v] of registry.frames) frames.set(k, cloneRefRegistry(v));
  }
  return {
    byKey: new Map(registry.byKey),
    used: new Set(registry.used),
    next: registry.next,
    since: registry.since,
    frames,
  };
}

function refFor(registry: RefRegistry, key: string, index: number, framePrefix?: string): string {
  let number = registry.byKey.get(key);
  if (number === undefined) {
    number = registry.used.has(index) ? Math.max(registry.next, index + 1) : index;
    while (registry.used.has(number)) number += 1;
    registry.byKey.set(key, number);
    registry.used.add(number);
    registry.next = Math.max(registry.next, number + 1);
  }
  return framePrefix === undefined ? `el-${number}` : `${framePrefix}:el-${number}`;
}

/** Where an observation looks: the page, one element's part of it, its main content, its open dialog, or its form. */
export type ObserveScope = { readonly locator: Locator; readonly frame?: Frame | undefined } | "main" | "dialog" | "form" | undefined;

const SCOPE_SELECTORS: Readonly<Record<"main" | "dialog" | "form", string>> = {
  main: "main, [role=main]",
  dialog: "dialog[open], [role=dialog], [role=alertdialog]",
  form: "form",
};

interface ScanFramePolicy {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly isFrameHostAllowed?: PlaywrightBrowserOptions["isFrameHostAllowed"] | undefined;
}

export async function scanElements(
  page: Page,
  registry: RefRegistry,
  scope: ObserveScope = undefined,
  interactiveOnly = false,
  uncapped = false,
  epoch = 0,
  framePolicy?: ScanFramePolicy,
): Promise<{
  readonly summaries: readonly BrowserElementSummary[];
  readonly omitted: number;
  readonly refs: Map<string, StoredElementRef>;
  readonly scopeFound: boolean;
}> {
  // Started over between scans, never during one: one observation never lists two elements under one ref.
  if (registry.byKey.size >= REF_REGISTRY_MAX) {
    registry.byKey.clear();
    registry.used.clear();
    registry.next = 0;
    registry.since = epoch;
    registry.frames?.clear();
  }
  // One page query over every match, in the order `nth` resolves them (the
  // selector pierces open shadow roots, as a ref's locator does). A ref names
  // its element by its identity (`refFor`); the locator for this epoch is its
  // place among this scan's matches, so a page that changes after the scan
  // moves it — as the epoch rule already assumes. A dropped element's ref is never offered.
  // Always the whole page's matches, so every element's place and occurrence are the same whatever the scope.
  const scanTarget = typeof scope === "object" && scope.frame !== undefined ? scope.frame : page;
  const matches = scanTarget.locator(INTERACTIVE_SELECTOR);
  const scopeOption =
    scope === undefined
      ? {}
      : typeof scope === "string"
        ? { scope: { selector: SCOPE_SELECTORS[scope] } }
        : { scope: { root: await scope.locator.elementHandle({ timeout: SCOPE_TIMEOUT_MS }) } };
  const baseScanArgs = {
    limit: SCAN_LIMIT,
    textChars: BROWSER_ELEMENT_TEXT_MAX_CHARS * 2,
    hrefChars: MAX_HREF_LENGTH,
    secretPattern: SECRET_FIELD_PATTERN,
    reviewHeading: REVIEW_STEP_HEADING_SOURCE,
    searchFieldWord: SEARCH_FIELD_WORD_SOURCE,
    searchFieldExact: SEARCH_FIELD_EXACT_SOURCE,
    disqualifyingSearchField: DISQUALIFYING_SEARCH_FIELD_SOURCE,
  };
  // Bounded: Playwright gives a page script no deadline, and a page whose renderer is stuck (a document that never
  // arrives, a script that never yields) would hold the call until the tool's own timeout.
  const result = await beforeDeadline(
    matches.evaluateAll(SCAN_PAGE, { ...baseScanArgs, ...scopeOption }),
    SCAN_TIMEOUT_MS,
    () =>
      new TaviError(
        "UNAVAILABLE",
        `the page did not answer within ${String(SCAN_TIMEOUT_MS / 1000)}s: it may still be loading or stuck. Observe it again, read its text with browser.read, or open another page`,
      ),
  );
  // A test's fake page answers the elements alone.
  const { elements: scanned, scopeFound } = Array.isArray(result) ? { elements: result as ScannedElement[], scopeFound: true } : result;
  const seen = new Map<string, number>();
  const byRef = new Map<string, StoredElementRef>();
  const kept: (Omit<ScannedElement, "index" | "key" | "occurrence"> & { ref: string; frame?: string })[] = scanned
    .filter(
      (element) => !interactiveOnly || (element.role !== undefined && INTERACTIVE_ROLES.has(element.role)) || element.href !== undefined,
    )
    .map(({ index, key, occurrence: counted, ...element }) => {
      const identity = key ?? `index:${index}`;
      const occurrence = counted ?? seen.get(identity) ?? 0;
      seen.set(identity, occurrence + 1);
      const ref = refFor(registry, `${identity}\u0002${occurrence}`, index);
      byRef.set(ref, {
        locator: matches.nth(index),
        index,
        key,
        occurrence,
        role: element.role,
        label: element.text,
      });
      return { ref, ...element };
    });

  if (scope === undefined) {
    const pageUrl = page.url();
    const children = await visibleChildFrames(page);
    const policy = framePolicy?.isFrameHostAllowed;
    const refused = await refusedFrames(
      children,
      pageUrl,
      policy === undefined || framePolicy === undefined
        ? undefined
        : (frameOrigin) => policy(frameOrigin, pageUrl, framePolicy.workspaceId, framePolicy.sessionId),
    );
    for (const child of children) {
      if (refused.has(child.frame)) {
        kept.push({
          ref: `${child.prefix}:frame`,
          frame: `${child.host} (not allowed)`,
        });
        continue;
      }
      const frameKey = `${child.prefix}\u0000${child.origin}`;
      let frameRegistry = registry.frames?.get(frameKey);
      if (frameRegistry === undefined) {
        frameRegistry = newRefRegistry();
        registry.frames?.set(frameKey, frameRegistry);
      }
      if (frameRegistry.byKey.size >= REF_REGISTRY_MAX) {
        frameRegistry.byKey.clear();
        frameRegistry.used.clear();
        frameRegistry.next = 0;
        frameRegistry.since = epoch;
      }
      const frameMatches = child.frame.locator(INTERACTIVE_SELECTOR);
      const frameRaw = await within(
        frameMatches.evaluateAll(SCAN_PAGE, baseScanArgs).catch(() => ({ elements: [] as ScannedElement[], scopeFound: true })),
        SCOPE_TIMEOUT_MS,
      );
      if (frameRaw === undefined) continue;
      const frameScanned = Array.isArray(frameRaw) ? (frameRaw as ScannedElement[]) : frameRaw.elements;
      const frameSeen = new Map<string, number>();
      for (const { index, key, occurrence: counted, ...element } of frameScanned) {
        if (interactiveOnly && (element.role === undefined || !INTERACTIVE_ROLES.has(element.role)) && element.href === undefined) {
          continue;
        }
        const identity = key ?? `index:${index}`;
        const occurrence = counted ?? frameSeen.get(identity) ?? 0;
        frameSeen.set(identity, occurrence + 1);
        const ref = refFor(frameRegistry, `${identity}\u0002${occurrence}`, index, child.prefix);
        byRef.set(ref, {
          locator: frameMatches.nth(index),
          index,
          key,
          occurrence,
          role: element.role,
          label: element.text,
          frame: child.frame,
          frameOrigin: child.origin,
        });
        kept.push({ ref, frame: child.origin, ...element });
      }
    }
  }
  // Uncapped (`BrowserObserveOptions.all`): every element, each clipped as usual, none dropped for the observation's bounds.
  const { elements: summaries, omitted } = uncapped
    ? {
        elements: kept
          .map((element) => compactBrowserElements([element]).elements[0])
          .filter((element): element is BrowserElementSummary => element !== undefined),
        omitted: 0,
      }
    : compactBrowserElements(kept);
  const refs = new Map<string, StoredElementRef>();
  for (const summary of summaries) {
    const stored = byRef.get(summary.ref);
    if (stored !== undefined) {
      refs.set(summary.ref, {
        ...stored,
        role: summary.role ?? stored.role,
        label: summary.text ?? stored.label,
      });
    }
  }
  return { summaries, omitted, refs, scopeFound };
}

/** The roles a person acts on, for an observation filtered to them. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
  "treeitem",
  "file",
]);
