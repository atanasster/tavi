import { BROWSER_PAGE_MOVED } from "@tavi/contracts";

import { SECRET_FIELD_PATTERN } from "./secrets.js";

/**
 * What an action changed (after Agent-E's
 * "change observation"): the page is sampled before and after, and the
 * difference said in words. A date picker that silently reset a field, a
 * suggestion list that opened, a dialog that closed — each is a line, so the
 * model knows what happened without observing again, and a click that did
 * nothing says so by saying nothing.
 */

/** What `PAGE_STATE_SCRIPT` reads of a page: enough to tell what an action changed. */
export interface PageState {
  readonly url: string;
  readonly title: string;
  /** The focused element, described ("textbox Where from?"); empty when it is the page. */
  readonly focus: string;
  /** Each form field's value by a stable label. Never a secret field's (a password, a one-time code, a card's number). */
  readonly fields: Readonly<Record<string, string>>;
  /** Each visible dialog, list box, menu, alert or status, described with what it holds. */
  readonly overlays: readonly string[];
}

/** The most fields and overlays a sample keeps. */
const STATE_LIMIT = 60;

/** Sampled in the page: a string, since this package has no DOM types. */
export const PAGE_STATE_SCRIPT = `(() => {
  const secret = new RegExp(${JSON.stringify(SECRET_FIELD_PATTERN)}, "i");
  const squeeze = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const shown = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  // A label wrapped round its field holds the field's own text (a select's options) too: only the label's is its name.
  const labelText = (element) => {
    const label = element.labels && element.labels[0] ? element.labels[0].innerText || "" : "";
    const own = element.innerText || "";
    return own !== "" && label.includes(own) ? label.replace(own, "") : label;
  };
  const labelOf = (element) => squeeze(labelText(element) || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.id || "");
  const describe = (element) => {
    if (!element || element === document.body || element === document.documentElement) return "";
    const role = element.getAttribute("role") || (element.tagName === "INPUT" ? (element.type === "checkbox" || element.type === "radio" ? element.type : "textbox") : element.tagName.toLowerCase());
    return squeeze(role + " " + (labelOf(element) || element.innerText || ""));
  };
  const fields = {};
  const counts = {};
  for (const element of document.querySelectorAll("input, select, textarea")) {
    if (Object.keys(fields).length >= ${STATE_LIMIT}) break;
    const type = (element.type || "").toLowerCase();
    if (type === "hidden" || type === "password" || !shown(element)) continue;
    // Never what a secret field holds: one a "show password" switch made plain, a one-time code, a card's number or code.
    const naming = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label"), element.getAttribute("placeholder"), labelText(element)].join(" ");
    if (secret.test(naming)) continue;
    const base = labelOf(element) || element.tagName.toLowerCase();
    counts[base] = (counts[base] || 0) + 1;
    const key = counts[base] === 1 ? base : base + " #" + counts[base];
    fields[key] = type === "checkbox" || type === "radio" ? (element.checked ? "checked" : "unchecked")
      : element.tagName === "SELECT" ? squeeze(element.selectedOptions && element.selectedOptions[0] ? element.selectedOptions[0].text : "")
      : squeeze(element.value);
  }
  const overlays = [...document.querySelectorAll("[role=dialog], [role=alertdialog], [role=listbox], [role=menu], [role=alert], [role=status], dialog[open]")]
    .filter(shown)
    .slice(0, ${STATE_LIMIT})
    .map((element) => {
      const role = element.getAttribute("role") || "dialog";
      const name = squeeze(element.getAttribute("aria-label") || "");
      const options = element.querySelectorAll("[role=option], [role=menuitem]").length;
      const text = role === "alert" || role === "status" ? squeeze(element.innerText) : "";
      return squeeze(role + (name ? " " + JSON.stringify(name) : "") + (options > 0 ? " (" + options + " options)" : "") + (text ? ": " + text : ""));
    });
  return { url: location.href, title: squeeze(document.title), focus: describe(document.activeElement), fields, overlays };
})()`;

/** A sample read back from the page, checked: `undefined` when it is not one. */
export function pageStateOf(value: unknown): PageState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state = value as Record<string, unknown>;
  const fields = state["fields"];
  const overlays = state["overlays"];
  if (typeof state["url"] !== "string" || typeof fields !== "object" || fields === null || !Array.isArray(overlays)) return undefined;
  return {
    url: state["url"],
    title: typeof state["title"] === "string" ? state["title"] : "",
    focus: typeof state["focus"] === "string" ? state["focus"] : "",
    fields: Object.fromEntries(
      Object.entries(fields as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    overlays: overlays.filter((overlay): overlay is string => typeof overlay === "string"),
  };
}

/** The most lines a change summary says: past them, a count of the rest. */
export const MAX_CHANGE_LINES = 10;

const quoted = (value: string): string => (value === "" ? "empty" : JSON.stringify(value));

/**
 * What changed from `before` to `after`, a line each, page first; empty when
 * nothing visible did. `withholdValues`: a person held the page, so a field
 * that changed is named without what it held or holds.
 */
export function describeChanges(before: PageState, after: PageState, withholdValues = false): string[] {
  const lines: string[] = [];
  if (after.url !== before.url) lines.push(`${BROWSER_PAGE_MOVED} ${after.url}`);
  else if (after.title !== before.title && after.title !== "") lines.push(`the title is now ${quoted(after.title)}`);
  const sameDocument = after.url === before.url;
  if (sameDocument) {
    for (const [field, value] of Object.entries(after.fields)) {
      const was = before.fields[field];
      if (was !== undefined && was !== value)
        lines.push(withholdValues ? `${field} changed` : `${field}: ${quoted(was)} → ${quoted(value)}`);
    }
    const appeared = after.overlays.filter((overlay) => !before.overlays.includes(overlay));
    const gone = before.overlays.filter((overlay) => !after.overlays.includes(overlay));
    for (const overlay of appeared) lines.push(`appeared: ${overlay}`);
    for (const overlay of gone) lines.push(`closed: ${overlay}`);
  }
  if (after.focus !== before.focus && after.focus !== "") lines.push(`focus is on ${after.focus}`);
  if (lines.length <= MAX_CHANGE_LINES) return lines;
  return [...lines.slice(0, MAX_CHANGE_LINES - 1), `and ${lines.length - (MAX_CHANGE_LINES - 1)} more changes`];
}
