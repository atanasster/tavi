import {
  DISQUALIFYING_SEARCH_FIELD_SOURCE,
  REVIEW_STEP_HEADING,
  REVIEW_STEP_HEADING_SOURCE,
  SEARCH_FIELD_EXACT_SOURCE,
  SEARCH_FIELD_WORD_SOURCE,
  TaviError,
  isSearchFormFacts,
  pressRefusal,
  type BrowserActGuard,
  type PressFacts,
  type SearchFormFieldFacts,
} from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";
import type { Frame, Locator, Page } from "playwright";

import { frameCdpSession, isCrossOriginFrameHop, nextCdpChildFrame, withIsolatedWorld } from "./cdp-world.js";
import { GATHER_FIELD_FACTS, locatorMatchIndex, snapshotEntries, type FieldFacts } from "./protected.js";
import { isSearchFormIn } from "./search-form.js";
import { SECRET_FIELD_PATTERN } from "./secrets.js";

/**
 * The browser's own check before a press: the
 * control it is about to press is read again, whatever the observation said,
 * and a stage profile's final step is refused, as is a press that commits
 * when the call was not approved as one. Enter in a form's field submits the
 * form, so it is held to the form's submit control. Read where the page's
 * script cannot reach — by reference in Playwright's utility world, by sight
 * in an isolated world of the browser's own — and refused when it cannot be
 * read: the check fails closed.
 */

/** How a press acts: on the control itself, or as Enter, which in a form's field submits the form. */
export type PressMode = "press" | "enter";

const STEP_MS = 2_000;
/** A form's fields read for whether it holds answers. */
const FIELDS_READ_MAX = 20;
/** How long the check may take before the press is refused. */
const CHECK_TIMEOUT_MS = 3_000;
const PRESSABLE_XPATH =
  "self::button | self::a | self::input[@type='submit' or @type='image' or @type='button' or @type='reset'] | self::*[@role='button' or @role='link' or @role='menuitem']";
const SUBMIT_XPATH =
  "self::button[not(@type) or translate(@type,'SUBMIT','submit')='submit'] | self::input[@type='submit' or @type='image']";
const FORM_SUBMIT_XPATH =
  "xpath=.//button[not(@type) or translate(@type,'SUBMIT','submit')='submit'] | .//input[@type='submit' or @type='image']";
const FIELD_XPATH =
  "self::input[not(@type='submit' or @type='image' or @type='button' or @type='reset' or @type='checkbox' or @type='radio')] | self::textarea | self::select | self::*[@contenteditable='true' or @role='textbox' or @role='searchbox' or @role='combobox']";

/** The page's headings, in the utility world. */
async function headingsOf(page: Page): Promise<string[]> {
  return (await page.getByRole("heading").allTextContents())
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .slice(0, 40);
}

/** Whether `formLocator` is a strict search form, read in the utility world. */
async function utilityIsSearchForm(formLocator: Locator): Promise<boolean> {
  if ((await formLocator.count()) === 0) return false;
  const first = typeof formLocator.first === "function" ? formLocator.first() : formLocator;
  if (typeof first.evaluate !== "function") return false;
  try {
    const read = await first.evaluate(
      (
        form: {
          getAttribute?(name: string): string | null;
          querySelectorAll?(selector: string): ArrayLike<{
            readonly tagName?: string;
            readonly type?: unknown;
            readonly isContentEditable?: boolean;
            readonly labels?: ArrayLike<{ readonly innerText?: string }> | null;
            getAttribute?(name: string): string | null;
            getBoundingClientRect?(): { readonly width: number; readonly height: number };
            checkVisibility?(options: Readonly<Record<string, boolean>>): boolean;
          }>;
        },
        secretPattern: string,
      ) => {
        const secret = new RegExp(secretPattern, "i");
        const nodes = Array.from(
          form.querySelectorAll?.(
            "input, select, textarea, [contenteditable=true], [role=textbox], [role=searchbox], [role=combobox], [role=checkbox], [role=radio], [role=switch]",
          ) ?? [],
        );
        const fields: SearchFormFieldFacts[] = [];
        for (const node of nodes) {
          const tag = String(node.tagName ?? "").toUpperCase();
          const type = tag === "INPUT" ? String(node.type ?? "text").toLowerCase() : "";
          const role = (node.getAttribute?.("role") ?? "").trim().toLowerCase();
          if (type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "image") continue;
          const texts = [
            node.getAttribute?.("autocomplete") ?? null,
            node.getAttribute?.("name") ?? null,
            node.getAttribute?.("id") ?? null,
            node.getAttribute?.("aria-label") ?? null,
            node.getAttribute?.("placeholder") ?? null,
            node.getAttribute?.("title") ?? null,
            node.labels?.[0]?.innerText ?? null,
          ];
          const joined = texts.filter((part): part is string => typeof part === "string").join(" ");
          const rect = node.getBoundingClientRect?.() ?? { width: 0, height: 0 };
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            (typeof node.checkVisibility === "function"
              ? node.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
              : true);
          fields.push({
            tag: node.isContentEditable === true && tag !== "INPUT" ? "TEXTAREA" : tag,
            type,
            role,
            visible,
            secret: type === "password" || secret.test(joined),
            texts,
          });
        }
        return { formRole: form.getAttribute?.("role") ?? null, fields };
      },
      SECRET_FIELD_PATTERN,
    );
    return isSearchFormFacts(read.fields, read.formRole);
  } catch {
    return false;
  }
}

/**
 * The form `control` belongs to: the one its `form` attribute names, else the
 * one it is inside. A button or field may belong to a form it is not inside.
 */
async function ownerFormOf(control: Locator, page: Page): Promise<Locator> {
  const formId = await control.getAttribute("form", { timeout: STEP_MS }).catch(() => null);
  if (formId !== null && formId !== "") return page.locator(`form[id=${JSON.stringify(formId)}]`).first();
  return control.locator("xpath=ancestor::form[1]");
}

/** What one control is, read in the utility world. */
async function controlFacts(control: Locator, page: Page, guard: BrowserActGuard, headings: readonly string[]): Promise<PressFacts> {
  const snapshot = await control.ariaSnapshot({ timeout: STEP_MS });
  // A name with a colon comes YAML-quoted whole: read the same way as the protected fields are.
  const named = snapshotEntries(snapshot).find((entry) => entry.name !== "")?.name;
  const label = (named ?? (await control.textContent({ timeout: STEP_MS })) ?? "").replace(/\s+/g, " ").trim();
  const pressable = (await control.locator(`xpath=${PRESSABLE_XPATH}`).count()) > 0;
  const formLocator = await ownerFormOf(control, page);
  const inForm = (await formLocator.count()) > 0;
  const searchForm = inForm && (await utilityIsSearchForm(formLocator));
  const submitControl = (await control.locator(`xpath=${SUBMIT_XPATH}`).count()) > 0;
  const fields = formLocator.locator("xpath=.//input[not(@type='hidden' or @type='checkbox' or @type='radio')] | .//textarea");
  let filled = false;
  for (let index = 0; inForm && !filled && index < Math.min(await fields.count(), FIELDS_READ_MAX); index += 1) {
    filled = (await fields.nth(index).inputValue({ timeout: STEP_MS })).trim() !== "";
  }
  const root = control.locator("xpath=/*");
  let selectorMatched = false;
  for (const selector of guard.finalStep?.selectors ?? []) {
    // A selector that does not parse is taken to match: an unreadable rule refuses rather than passes.
    selectorMatched ||=
      (await control
        .and(root.locator(selector))
        .count()
        .catch(() => 1)) > 0;
  }
  // A review step commits through its form when the page has one: a button outside it (a scroll to the form) does not.
  const reviewing = headings.some((heading) => REVIEW_STEP_HEADING.test(heading)) && (inForm || (await page.locator("form").count()) === 0);
  return {
    pressable,
    label,
    submitsForm: pressable && ((inForm && (submitControl || filled)) || reviewing),
    ...(pressable && inForm && submitControl ? { sendsForm: true } : {}),
    ...(searchForm ? { searchForm: true } : {}),
    selectorMatched,
    headings,
    url: page.url(),
  };
}

/**
 * What a press by reference acts on. A click or a key on a control is that
 * control; Enter in a form's field is the form's submit control, or the
 * form's submission itself when it has none.
 */
export async function pressFactsOf(
  locator: Locator,
  page: Page,
  guard: BrowserActGuard,
  mode: PressMode,
  frame?: Frame,
): Promise<PressFacts> {
  const index = locatorMatchIndex(locator);
  if (index !== undefined && typeof page.context === "function" && typeof page.context().newCDPSession === "function") {
    const isolated = await pressFactsBySight(page, { index }, guard, mode, frame);
    if (isolated !== "unknown") return isolated;
  }
  const headings = await headingsOf(page);
  if (mode === "enter" && (await locator.locator(`xpath=${FIELD_XPATH}`).count()) > 0) {
    const formLocator = await ownerFormOf(locator, page);
    if ((await formLocator.count()) === 0)
      return { pressable: false, label: "", submitsForm: false, selectorMatched: false, headings, url: page.url() };
    const submit = formLocator.locator(FORM_SUBMIT_XPATH);
    if ((await submit.count()) > 0)
      return { ...(await controlFacts(submit.first(), page, guard, headings)), submitsForm: true, viaEnter: true, sendsForm: true };
    const searchForm = await utilityIsSearchForm(formLocator);
    return {
      pressable: true,
      label: "Submit",
      submitsForm: true,
      viaEnter: true,
      sendsForm: true,
      ...(searchForm ? { searchForm: true } : {}),
      selectorMatched: false,
      headings,
      url: page.url(),
    };
  }
  return controlFacts(locator, page, guard, headings);
}

/** What a key with no reference acts on: the focused element, or nothing when nothing has focus. */
export async function focusedPressFacts(page: Page, guard: BrowserActGuard, mode: PressMode): Promise<PressFacts> {
  if (typeof page.context === "function" && typeof page.context().newCDPSession === "function") {
    const isolated = await pressFactsBySight(page, "focused", guard, mode);
    if (isolated !== "unknown") return isolated;
  }
  const focused = page.locator("*:focus");
  if ((await focused.count()) === 0)
    return { pressable: false, label: "", submitsForm: false, selectorMatched: false, headings: await headingsOf(page), url: page.url() };
  return pressFactsOf(focused.first(), page, guard, mode);
}

/**
 * Run in the browser's isolated world: the control at a point, by match index, or the
 * focused one, and what holds it; Enter in a form's field is the form's
 * submit control. `"unknown"` for a control it cannot read: in another
 * origin's frame, or inside a custom element whose shadow root is closed.
 * JavaScript source; this package has no DOM types.
 */
const PRESS_FACTS_IN_PAGE = `(at) => {
  const review = new RegExp(at.review, "iu");
  let doc = document;
  let element = null;
  if (typeof at.index === "number") {
    const selector = "a, button, input, select, textarea, summary, h1, h2, h3, [role]";
    let seen = 0;
    const walk = (root) => {
      for (const node of root.querySelectorAll("*")) {
        if (node.matches(selector)) {
          if (seen === at.index) return node;
          seen += 1;
        }
        if (node.shadowRoot) {
          const inner = walk(node.shadowRoot);
          if (inner) return inner;
        }
      }
      return null;
    };
    element = walk(doc);
  } else {
    let x = at.x || 0;
    let y = at.y || 0;
    element = at.focused ? doc.activeElement : doc.elementFromPoint(x, y);
    for (let depth = 0; element && depth < 8; depth += 1) {
      if (element.shadowRoot) { const inner = at.focused ? element.shadowRoot.activeElement : element.shadowRoot.elementFromPoint(x, y); if (!inner || inner === element) break; element = inner; continue; }
      if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
        let inner = null;
        try { inner = element.contentDocument; } catch { inner = null; }
        const rect = element.getBoundingClientRect();
        if (!inner) {
          const iframes = Array.from(doc.querySelectorAll("iframe, frame"));
          return {
            __crossOriginFrame: true,
            iframeIndex: iframes.indexOf(element),
            src: typeof element.src === "string" && element.src !== "" ? element.src : (element.getAttribute("src") || ""),
            name: element.getAttribute("name") || "",
            x: x - rect.left,
            y: y - rect.top,
            focused: Boolean(at && at.focused),
          };
        }
        x -= rect.left; y -= rect.top; doc = inner; element = at.focused ? inner.activeElement : inner.elementFromPoint(x, y);
        continue;
      }
      break;
    }
  }
  const headings = Array.from(doc.querySelectorAll("h1, h2, h3, [role=heading]")).map((heading) => (heading.innerText || heading.textContent || "").trim()).filter((text) => text !== "").slice(0, 40);
  const nothing = { pressable: false, label: "", submitsForm: false, selectorMatched: false, headings, url: doc.location.href };
  if (!element || element === doc.body || element === doc.documentElement) return nothing;
  const isSearchForm = (form) => (${isSearchFormIn.toString()})(form, ${JSON.stringify({
    searchWord: SEARCH_FIELD_WORD_SOURCE,
    searchExact: SEARCH_FIELD_EXACT_SOURCE,
    disqualifyingField: DISQUALIFYING_SEARCH_FIELD_SOURCE,
    secret: SECRET_FIELD_PATTERN,
  })});
  const isField = (node) => node.matches("input:not([type=submit]):not([type=image]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true], [role=textbox], [role=searchbox], [role=combobox]");
  let control = element.closest("button, a, input[type=submit], input[type=image], input[type=button], input[type=reset], [role=button], [role=link], [role=menuitem]");
  let viaEnter = false;
  if (at.enter && isField(element)) {
    // Its form by the \`form\` attribute first: a field may belong to a form it is not inside.
    const form = element.form || element.closest("form");
    if (!form) return nothing;
    const searchForm = isSearchForm(form);
    viaEnter = true;
    // The form's own controls, wherever they sit: \`form.elements\` holds a submit button outside it too.
    control = Array.from(form.elements || []).find((node) => node.matches("button:not([type]), button[type=submit], input[type=submit], input[type=image]")) || null;
    if (!control) return { pressable: true, label: "Submit", submitsForm: true, viaEnter: true, sendsForm: true, ...(searchForm ? { searchForm: true } : {}), selectorMatched: false, headings, url: doc.location.href };
  }
  if (!control) {
    // A custom element with nothing to read by sight: its controls may be in a closed shadow root.
    if (typeof at.index !== "number" && element.tagName.includes("-") && (element.innerText || "").trim() === "") return "unknown";
    return nothing;
  }
  const tag = control.tagName.toLowerCase();
  const type = (control.getAttribute("type") || "").toLowerCase();
  const imgAlt = control.querySelector && control.querySelector("img[alt]") ? control.querySelector("img[alt]").getAttribute("alt") : "";
  const label = (control.getAttribute("aria-label") || control.innerText || control.textContent || (tag === "input" ? control.value : "") || control.getAttribute("title") || imgAlt || "").replace(/\\s+/g, " ").trim();
  if (typeof at.index !== "number" && label === "" && tag.includes("-")) return "unknown";
  const form = control.form || control.closest("form");
  const searchForm = isSearchForm(form);
  const submitControl = (tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image"));
  const filled = form !== null && Array.from(form.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea")).slice(0, 20).some((field) => String(field.value || "").trim() !== "");
  const reviewing = headings.some((heading) => review.test(heading)) && (form !== null || doc.querySelector("form") === null);
  let selectorMatched = false;
  for (const selector of at.selectors) { try { if (control.matches(selector)) selectorMatched = true; } catch { selectorMatched = true; } }
  return { pressable: true, label, submitsForm: (form !== null && (submitControl || filled)) || reviewing || (at.enter && form !== null), ...(form !== null && (submitControl || viaEnter) ? { sendsForm: true } : {}), ...(viaEnter ? { viaEnter: true } : {}), ...(searchForm ? { searchForm: true } : {}), selectorMatched, headings, url: doc.location.href };
}`;

/** What a press acts on, read in an isolated world: at a point, by match index, or the focused element for a key. */
export async function pressFactsBySight(
  page: Page,
  at: { readonly x: number; readonly y: number } | { readonly index: number } | "focused",
  guard: BrowserActGuard,
  mode: PressMode,
  frame?: Frame,
): Promise<PressFacts | "unknown"> {
  return withIsolatedWorld<PressFacts>(page, frame, at, {
    worldName: "tavi-press-guard",
    expression: (currentAt) => {
      const argument = {
        ...(currentAt === "focused"
          ? { focused: true }
          : "index" in currentAt
            ? { index: currentAt.index }
            : { x: currentAt.x, y: currentAt.y }),
        enter: mode === "enter",
        review: REVIEW_STEP_HEADING_SOURCE,
        selectors: guard.finalStep?.selectors ?? [],
      };
      return `(${PRESS_FACTS_IN_PAGE})(${JSON.stringify(argument)})`;
    },
    requireAnswer: true,
  });
}

/** Input to target identity verification at act time. */
export interface TargetCheckInput {
  readonly index: number;
  readonly key: string;
  readonly occurrence: number;
  readonly textChars: number;
}

/** Result of target identity verification at act time. */
export interface TargetCheckResult {
  readonly status: "ok" | "moved" | "missing" | "ambiguous";
  readonly index: number;
}

/**
 * Run in the browser's isolated world: checks whether the node at `target.index`
 * still has `target.key`, as the same one of the elements alike
 * (`target.occurrence`), and is rendered (or is a file input), shadow roots
 * included. If it moved, it is recovered only when it was the first element
 * with its key and is now the only one: with two alike (a "Delete" per row),
 * which one is meant cannot be told apart, so the act is refused as
 * ambiguous rather than guessed at.
 */
export const VERIFY_TARGET_IN_PAGE = `(target) => {
  const selector = "a, button, input, select, textarea, summary, h1, h2, h3, [role]";
  const elements = [];
  const walk = (root) => {
    for (const node of root.querySelectorAll("*")) {
      if (node.matches(selector)) elements.push(node);
      if (node.shadowRoot) walk(node.shadowRoot);
    }
  };
  walk(document);
  const fieldRoles = new Set(["combobox", "textbox", "searchbox", "slider", "spinbutton"]);
  const textChars = typeof target.textChars === "number" ? target.textChars : 240;
  const squeeze = (value) => (typeof value === "string" ? value.replace(/\\s+/g, " ").trim().slice(0, textChars) : "");
  const infoOf = (element) => {
    const tag = element.tagName.toUpperCase();
    const explicitRole = (element.getAttribute("role") || "").trim();
    const roles = explicitRole.toLowerCase().split(/\\s+/);
    const type = tag === "INPUT" ? String(element.type || "text").toLowerCase() : "";
    const rect = element.getBoundingClientRect();
    const rendered =
      rect.width > 0 &&
      rect.height > 0 &&
      (typeof element.checkVisibility === "function"
        ? element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
        : true);
    const visible = type !== "hidden" && (rendered || type === "file");
    const isLink = (tag === "A" || tag === "AREA") && element.getAttribute("href") !== null;
    const isField =
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      element.isContentEditable === true ||
      roles.some((role) => fieldRoles.has(role));
    const buttonInput = type === "submit" || type === "button" || type === "reset" || type === "image";
    const own = typeof element.innerText === "string" ? element.innerText : "";
    const labelText = (element.labels && element.labels[0] && element.labels[0].innerText) || "";
    const imgAlt =
      (isLink || tag === "BUTTON") && element.querySelector && element.querySelector("img[alt]")
        ? element.querySelector("img[alt]").getAttribute("alt")
        : "";
    const label =
      [
        isField && !buttonInput ? squeeze(own !== "" && labelText.includes(own) ? labelText.replace(own, "") : labelText) : "",
        isField && !buttonInput ? "" : squeeze(buttonInput ? element.value : element.innerText),
        squeeze(element.getAttribute("aria-label")),
        squeeze(element.getAttribute("placeholder")),
        squeeze(element.getAttribute("title")),
        squeeze(element.getAttribute("alt")),
        squeeze(imgAlt),
      ].find((candidate) => candidate !== "") || "";
    const rawHref = isLink ? (typeof element.href === "string" ? element.href : "") : "";
    const key = [
      tag,
      explicitRole,
      element.getAttribute("id") || "",
      element.getAttribute("name") || "",
      type,
      label,
      rawHref,
    ].join("\\u0001");
    return { visible, key, tag, type, rawHref };
  };
  const atIndex = target.index >= 0 && target.index < elements.length ? infoOf(elements[target.index]) : null;
  const matches = [];
  for (let i = 0; i < elements.length; i += 1) {
    const info = infoOf(elements[i]);
    if (info.visible && info.key === target.key) matches.push(i);
  }
  // Its place holds an element alike only if it is the same one of the alike: after a shift, the neighbour of
  // a "Delete" per row is alike too, and acting on it would act on the wrong row.
  const occurrence = typeof target.occurrence === "number" ? target.occurrence : 0;
  if (atIndex !== null && atIndex.visible && atIndex.key === target.key && matches.indexOf(target.index) === occurrence) {
    return { status: "ok", index: target.index };
  }
  const parts = String(target.key).split("\\u0001");
  if (
    matches.length === 0 &&
    atIndex !== null &&
    atIndex.visible &&
    parts.length === 7 &&
    parts[1] !== "" &&
    parts[1] === parts[2] &&
    parts[2] === parts[3] &&
    atIndex.tag === parts[0] &&
    atIndex.type === parts[4] &&
    atIndex.rawHref === parts[6]
  ) {
    return { status: "ok", index: target.index };
  }
  if (matches.length === 1 && target.occurrence === 0) {
    return { status: "moved", index: matches[0] };
  }
  return { status: matches.length === 0 ? "missing" : "ambiguous", index: target.index };
}`;

/**
 * Evaluate target identity verification, protected-field facts, and press-guard
 * facts in a single isolated-world round trip.
 */
export async function isolatedActionFacts(
  page: Page,
  at: { readonly index: number; readonly target?: TargetCheckInput | undefined } | "focused",
  options: {
    readonly needField: boolean;
    readonly guard?: BrowserActGuard | undefined;
    readonly mode?: PressMode | undefined;
  },
  frame?: Frame,
): Promise<{
  readonly verify?: TargetCheckResult | undefined;
  readonly field?: FieldFacts | "unknown" | undefined;
  readonly press?: PressFacts | "unknown" | undefined;
}> {
  const { cdp, node } = await frameCdpSession(page, frame);
  try {
    if (node === undefined) {
      // A target that cannot be found in its frame is missing: the caller refuses it rather than acting on the raw match.
      return {
        ...(at !== "focused" && at.target !== undefined ? { verify: { status: "missing" as const, index: at.target.index } } : {}),
        ...(options.needField ? { field: "unknown" as const } : {}),
        ...(options.guard !== undefined && options.mode !== undefined ? { press: "unknown" as const } : {}),
      };
    }
    let currentNode = node;
    for (let depth = 0; depth < 8; depth += 1) {
      const world = await cdp.send("Page.createIsolatedWorld", {
        frameId: currentNode.frame.id,
        worldName: "tavi-action-guard",
      });
      const verifyExpr =
        at !== "focused" && at.target !== undefined ? `(${VERIFY_TARGET_IN_PAGE})(${JSON.stringify(at.target)})` : "undefined";
      const fieldExpr = options.needField
        ? `(${GATHER_FIELD_FACTS})(${at === "focused" ? JSON.stringify("focused") : "{ index: resolvedIndex }"})`
        : "undefined";
      const pressExpr =
        options.guard !== undefined && options.mode !== undefined
          ? `(${PRESS_FACTS_IN_PAGE})({ ${at === "focused" ? "focused: true" : "index: resolvedIndex"}, enter: ${JSON.stringify(options.mode === "enter")}, review: ${JSON.stringify(REVIEW_STEP_HEADING_SOURCE)}, selectors: ${JSON.stringify(options.guard.finalStep?.selectors ?? [])} })`
          : "undefined";
      const expression = `(() => {
        const verify = ${verifyExpr};
        const resolvedIndex = verify ? verify.index : ${at === "focused" ? -1 : at.index};
        return { verify, field: ${fieldExpr}, press: ${pressExpr} };
      })()`;
      const answer = await cdp.send("Runtime.evaluate", {
        expression,
        contextId: world.executionContextId,
        returnByValue: true,
      });
      if (answer.exceptionDetails !== undefined || answer.result.value === undefined)
        throw new Error(answer.exceptionDetails?.text ?? "no answer from the page");
      const raw = answer.result.value as {
        readonly verify?: TargetCheckResult | undefined;
        readonly field?: unknown;
        readonly press?: unknown;
      };
      const hop = isCrossOriginFrameHop(raw.field) ? raw.field : isCrossOriginFrameHop(raw.press) ? raw.press : undefined;
      if (hop !== undefined && at === "focused") {
        const nextNode = nextCdpChildFrame(currentNode, hop);
        if (nextNode === undefined) {
          return {
            verify: raw.verify,
            ...(options.needField ? { field: "unknown" as const } : {}),
            ...(options.guard !== undefined && options.mode !== undefined ? { press: "unknown" as const } : {}),
          };
        }
        currentNode = nextNode;
        continue;
      }
      return {
        verify: raw.verify,
        field: isCrossOriginFrameHop(raw.field) ? "unknown" : (raw.field as FieldFacts | "unknown" | undefined),
        press: isCrossOriginFrameHop(raw.press) ? "unknown" : (raw.press as PressFacts | "unknown" | undefined),
      };
    }
    return {
      ...(options.needField ? { field: "unknown" as const } : {}),
      ...(options.guard !== undefined && options.mode !== undefined ? { press: "unknown" as const } : {}),
    };
  } finally {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await cdp.detach().catch(() => undefined);
  }
}

/** Refuses a press the guard does not allow; a control it cannot read is refused (the check fails closed). */
export async function requirePressAllowed(reading: Promise<PressFacts | "unknown">, guard: BrowserActGuard): Promise<void> {
  let facts: PressFacts | "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    facts = await Promise.race([
      reading,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    throw new TaviError("NOT_AUTHORIZED", "browser refused: the control could not be checked before it was pressed", {
      details: { guard: "unread", cause: clip(errorMessage(error), 200) },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (facts === "unknown")
    throw new TaviError(
      "NOT_AUTHORIZED",
      "browser refused: the control is in a frame or component Tavi cannot read; hand the page to a person (browser.request_handoff) or act on an observed element ref",
      { details: { guard: "unknown" } },
    );
  const refusal = pressRefusal(facts, guard);
  if (refusal !== undefined)
    throw new TaviError("NOT_AUTHORIZED", `browser refused: ${refusal.reason}`, {
      details: { guard: refusal.finalStep ? "final-step" : "commit", label: facts.label.slice(0, 80) },
    });
}
