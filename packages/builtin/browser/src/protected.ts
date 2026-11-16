import { TaviError, protectedFieldClass, protectedFieldRefusal, protectedValueClass } from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";
import type { Frame, Locator, Page } from "playwright";

import { withIsolatedWorld } from "./cdp-world.js";
import { SECRET_FIELD_PATTERN } from "./secrets.js";

/**
 * Protected fields in the page: before typing into, picking in, checking
 * or drawing on a field, what the field says of itself and whether a person
 * can see it. A protected field is refused whatever the observation called
 * it, and so is a field the page hides (a honeypot such as Workday's
 * `beecatcher`).
 *
 * Read where the page's own script cannot reach: by reference through
 * Playwright's utility world (accessible names, attributes, visibility), and
 * by sight through an isolated world of the browser's own (CDP), so a page
 * that rewrites `getAttribute` or `getComputedStyle` changes nothing here.
 */
export interface FieldFacts {
  /** What the field says of itself: its name, id, aria-label, placeholder, accessible name, labels and legend. */
  readonly texts: readonly string[];
  /** Whether it is a field at all: one a person types into, picks in, checks or signs. */
  readonly field: boolean;
  readonly visible: boolean;
  /** Whether the field holds a secret (password, one-time code, PIN, card field). */
  readonly secret?: boolean;
}

/** Roles a person fills, picks or checks. */
const FIELD_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "spinbutton",
  "slider",
  "menuitemcheckbox",
  "menuitemradio",
]);
const CHECK_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const SECRET_REGEX = new RegExp(SECRET_FIELD_PATTERN, "i");
const ATTRIBUTES = ["name", "id", "aria-label", "placeholder", "title", "autocomplete", "data-automation-id"] as const;
const STEP_MS = 2_000;
const SECRET_FIELD_REFUSAL = "This is a password/code/card field: ask the person to fill it (`browser.request_handoff`)";

/**
 * The roles and names an aria snapshot gives, one per line: `- checkbox "I agree"`. A line whose name holds
 * ": " is quoted whole, YAML's way (`- 'checkbox "Health declaration: none"'`, a quote doubled inside), and is
 * read the same once unwrapped: otherwise a protected field's label with a colon would go unread.
 */
export function snapshotEntries(snapshot: string): { readonly role: string; readonly name: string }[] {
  return snapshot.split("\n").flatMap((raw) => {
    const quoted = /^(\s*-\s+)'((?:[^']|'')*)'/.exec(raw);
    const line = quoted === null ? raw : `${quoted[1] ?? ""}${(quoted[2] ?? "").replace(/''/g, "'")}`;
    const found = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
    return found === null ? [] : [{ role: found[1] ?? "", name: (found[2] ?? "").replace(/\\"/g, '"') }];
  });
}

/** Extracted match index when `locator` is an `nth` match from `scanElements`. */
export function locatorMatchIndex(locator: Locator): number | undefined {
  const selector = (locator as { readonly _selector?: unknown })._selector;
  if (typeof selector !== "string") return undefined;
  const match = />> nth=(\d+)$/.exec(selector);
  return match === null ? undefined : Number(match[1]);
}

/** What a field reached by reference says of itself, read in an isolated world when available, else Playwright's utility world. */
export async function factsOfLocator(locator: Locator, frame?: Frame): Promise<FieldFacts> {
  const index = locatorMatchIndex(locator);
  const page = typeof locator.page === "function" ? locator.page() : undefined;
  if (
    index !== undefined &&
    page !== undefined &&
    typeof page.context === "function" &&
    typeof page.context().newCDPSession === "function"
  ) {
    const isolated = await isolatedFieldFacts(page, { index }, frame);
    if (isolated !== "unknown") return isolated;
  }
  const texts: string[] = [];
  let field = false;
  let checkRole = false;
  let passwordType = false;
  const add = (value: string | null | undefined): void => {
    if (typeof value === "string" && value.trim() !== "") texts.push(value.trim().slice(0, 500));
  };
  const read = async (target: Locator): Promise<void> => {
    for (const entry of snapshotEntries(await target.ariaSnapshot({ timeout: STEP_MS }).catch(() => ""))) {
      if (FIELD_ROLES.has(entry.role)) field = true;
      if (CHECK_ROLES.has(entry.role)) checkRole = true;
      add(entry.name);
    }
    const typeAttr = (await target.getAttribute("type", { timeout: STEP_MS }).catch(() => null))?.toLowerCase();
    if (typeAttr === "password") {
      field = true;
      passwordType = true;
    } else if (typeAttr === "checkbox" || typeAttr === "radio" || typeAttr === "file") {
      checkRole = true;
    }
    // An attribute not read in time adds nothing; the other facts still decide.
    for (const name of ATTRIBUTES) add(await target.getAttribute(name, { timeout: STEP_MS }).catch(() => null));
  };
  await read(locator);
  // What holds it: a checkbox's wrapper role, a custom option's list, a fieldset's legend.
  const owner = locator.locator(
    "xpath=ancestor::*[@role='checkbox' or @role='radio' or @role='switch' or @role='option' or @role='listbox'][1]",
  );
  if ((await owner.count()) > 0) await read(owner.first());
  const listbox = locator.locator("xpath=ancestor-or-self::*[@role='listbox'][1]");
  // An attribute not read in time adds nothing; the other facts still decide.
  const listboxId =
    (await listbox.count()) > 0
      ? await listbox
          .first()
          .getAttribute("id", { timeout: STEP_MS })
          .catch(() => null)
      : null;
  const root = locator.locator("xpath=/*");
  if (listboxId !== null && listboxId !== "") {
    const combobox = root.locator(`[aria-controls=${JSON.stringify(listboxId)}], [aria-owns=${JSON.stringify(listboxId)}]`);
    if ((await combobox.count()) > 0) await read(combobox.first());
  }
  // A label clicked for its control, wrapping it or naming it by `for`.
  const forId = await locator.getAttribute("for", { timeout: STEP_MS }).catch(() => null);
  if (forId !== null && forId !== "") {
    const control = root.locator(`[id=${JSON.stringify(forId)}]`);
    if ((await control.count()) > 0) await read(control.first());
  }
  const wrapped = locator.locator("xpath=self::label//*[self::input or self::select or self::textarea]");
  if ((await wrapped.count()) > 0) await read(wrapped.first());
  const legend = locator.locator("xpath=ancestor::fieldset[1]/legend");
  // An attribute not read in time adds nothing; the other facts still decide.
  if ((await legend.count()) > 0)
    add(
      await legend
        .first()
        .textContent({ timeout: STEP_MS })
        .catch(() => null),
    );
  // A signature pad is a canvas that says so.
  if ((await locator.locator("xpath=self::canvas").count()) > 0) {
    // An attribute not read in time adds nothing; the other facts still decide.
    add(await locator.getAttribute("class", { timeout: STEP_MS }).catch(() => null));
    field = true;
  }
  // No box read: the element counts as not shown.
  const box = await locator.boundingBox({ timeout: STEP_MS }).catch(() => null);
  const visible =
    (await locator.isVisible().catch(() => false)) &&
    box !== null &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width > 0 &&
    box.y + box.height > 0;
  const secret = field && !checkRole && (passwordType || SECRET_REGEX.test(texts.join(" ")));
  return { texts, field, visible, ...(secret ? { secret: true } : {}) };
}

/**
 * Run in the browser's isolated world (its own `document` wrappers and
 * prototypes, the page's DOM): the field at a point, or the focused one,
 * through open shadow roots and same-origin frames; `"unknown"` for one in a
 * frame it cannot read (another origin's). JavaScript source, since this
 * package has no DOM types.
 */
export const GATHER_FIELD_FACTS = `(at) => {
  let doc = document;
  let element = null;
  if (typeof at === "object" && at !== null && typeof at.index === "number") {
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
    let x = at === "focused" ? 0 : at.x;
    let y = at === "focused" ? 0 : at.y;
    element = at === "focused" ? doc.activeElement : doc.elementFromPoint(x, y);
    for (let depth = 0; element && depth < 8; depth += 1) {
      if (element.shadowRoot) {
        const inner = at === "focused" ? element.shadowRoot.activeElement : element.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === element) break;
        element = inner;
        continue;
      }
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
            focused: at === "focused" || Boolean(at && at.focused),
          };
        }
        x -= rect.left;
        y -= rect.top;
        doc = inner;
        element = at === "focused" ? inner.activeElement : inner.elementFromPoint(x, y);
        continue;
      }
      break;
    }
  }
  if (!element || element === doc.body || element === doc.documentElement) return { texts: [], field: false, visible: true };
  // The control a label, a wrapper role or a part of one stands for.
  const label = element.closest("label");
  const root = (element.getRootNode && element.getRootNode()) || doc;
  const forId = (label && label.getAttribute("for")) || element.getAttribute("for");
  const forControl = forId ? (root.getElementById ? root.getElementById(forId) : doc.getElementById(forId)) : null;
  const owner = element.closest("[role=checkbox],[role=radio],[role=switch],[role=option],[role=listbox]");
  const control = (label && label.control) || forControl || owner || element;
  const tag = control.tagName.toLowerCase();
  const role = (control.getAttribute("role") || "").toLowerCase();
  const type = (control.getAttribute("type") || "").toLowerCase();
  const canvas = tag === "canvas";
  const buttonInput = tag === "input" && ["submit", "button", "reset", "image", "hidden"].includes(type);
  const field = ((tag === "input" && !buttonInput) || tag === "select" || tag === "textarea") || control.isContentEditable === true || ["textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "spinbutton", "slider", "menuitemcheckbox", "menuitemradio"].includes(role) || canvas;
  const texts = [];
  const add = (value) => { if (typeof value === "string" && value.trim() !== "") texts.push(value.trim().slice(0, 500)); };
  for (const name of ["name", "id", "aria-label", "placeholder", "title", "autocomplete", "data-automation-id"]) add(control.getAttribute(name));
  if (control !== element) {
    for (const name of ["name", "id", "aria-label", "placeholder", "title", "autocomplete", "data-automation-id"]) add(element.getAttribute(name));
  }
  if (["checkbox", "radio", "switch", "option", "menuitemcheckbox", "menuitemradio"].includes(role)) add(control.textContent);
  if (canvas) add(control.getAttribute("class"));
  for (const each of Array.from(control.labels || [])) add(each.textContent);
  if (label) add(label.textContent);
  for (const id of (control.getAttribute("aria-labelledby") || "").split(/\\s+/)) if (id !== "") { const named = (root.getElementById && root.getElementById(id)) || doc.getElementById(id); add(named && named.textContent); }
  const fieldset = control.closest("fieldset");
  const legend = fieldset && fieldset.querySelector("legend");
  add(legend && legend.textContent);
  // A custom option speaks for its list, and the list for the combobox that opens it.
  const list = control.closest("[role=listbox]");
  if (list) {
    add(list.getAttribute("aria-label"));
    const id = list.getAttribute("id");
    const queryRoot = list.getRootNode && list.getRootNode() && list.getRootNode().querySelector ? list.getRootNode() : doc;
    const opener = id ? queryRoot.querySelector("[aria-controls=" + JSON.stringify(id) + "], [aria-owns=" + JSON.stringify(id) + "]") : null;
    if (opener) for (const name of ["aria-label", "name", "id"]) add(opener.getAttribute(name));
  }
  const view = doc.defaultView;
  const box = control.getBoundingClientRect();
  let visible = box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0;
  for (let node = control; visible && node && view; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") visible = false;
  }
  // A text field made transparent with nothing to show for it is a trap; a styled checkbox shows through its label.
  if (visible && view && tag === "input" && !["checkbox", "radio"].includes(type) && Number(view.getComputedStyle(control).opacity) === 0 && Array.from(control.labels || []).every((each) => each.getBoundingClientRect().width === 0)) visible = false;
  const checkRole = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role) || ["checkbox", "radio", "file"].includes(type);
  const secret = field && !canvas && !checkRole && (type === "password" || new RegExp(${JSON.stringify(SECRET_FIELD_PATTERN)}, "i").test(texts.join(" ")));
  return { texts, field, visible, ...(secret ? { secret: true } : {}) };
}`;

/** What the browser's isolated world reads of the field at a point, by match index, or the focused one. */
export async function isolatedFieldFacts(
  page: Page,
  at: { readonly x: number; readonly y: number } | { readonly index: number } | "focused",
  frame?: Frame,
): Promise<FieldFacts | "unknown"> {
  return withIsolatedWorld<FieldFacts>(page, frame, at, {
    worldName: "tavi-protected-fields",
    expression: (currentAt) => `(${GATHER_FIELD_FACTS})(${JSON.stringify(currentAt)})`,
  });
}

/** How long reading a field may take before the action is refused. */
export const FIELD_FACTS_TIMEOUT_MS = 3_000;

/**
 * A field's facts, or a refusal when they cannot be read in time: a check that
 * fails closed, since an unread field may be a protected one.
 */
export async function readFieldFacts<T extends FieldFacts | "unknown">(reading: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reading,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), FIELD_FACTS_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    throw new TaviError("NOT_AUTHORIZED", "browser refused: the field could not be checked for whether only the person may fill it", {
      details: { protected: "unread", cause: clip(errorMessage(error), 200) },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Refuses filling, picking or checking a protected field, or one the page
 * hides; `value` is what would be typed, read only as an attestation. A field
 * it cannot read by sight (in another origin's frame) is refused: by
 * reference, the agent can still act on it.
 */
export function requireUnprotected(facts: FieldFacts | "unknown" | undefined, value?: string): void {
  if (facts === "unknown")
    throw new TaviError(
      "NOT_AUTHORIZED",
      "browser refused: the field is in a frame or component Tavi cannot read; hand the page to a person (browser.request_handoff) or act on an observed element ref",
      { details: { protected: "unknown" } },
    );
  if (facts === undefined || !facts.field) {
    const typed = protectedValueClass(value);
    if (typed !== undefined)
      throw new TaviError("NOT_AUTHORIZED", `browser refused: ${protectedFieldRefusal(typed)}`, { details: { protected: typed } });
    return;
  }
  if (!facts.visible)
    throw new TaviError("NOT_AUTHORIZED", "browser refused: the page hides this field from a person (a honeypot), so it is never filled", {
      details: { protected: "hidden" },
    });
  if (facts.secret === true)
    throw new TaviError("NOT_AUTHORIZED", `browser refused: ${SECRET_FIELD_REFUSAL}`, { details: { protected: "secret" } });
  const kind = protectedFieldClass(facts.texts) ?? protectedValueClass(value);
  if (kind !== undefined)
    throw new TaviError("NOT_AUTHORIZED", `browser refused: ${protectedFieldRefusal(kind)}`, { details: { protected: kind } });
}
