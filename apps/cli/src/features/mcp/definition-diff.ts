import type { McpToolDefinition } from "@tavi/contracts";
import { isRecord } from "@tavi/contracts/util";

import { canonicalJson } from "./jcs.js";
import { cleanServerText } from "./results.js";

/**
 * What changed in a tool's definition between the one the operator
 * approved (`approved_def_json`) and the one the server lists now
 * (`observed_def_json`), field by field, for the review: the hashes only say
 * that something changed; this says what. Objects are walked key by key, so
 * a changed property's type reads `inputSchema.properties.to.type`; arrays
 * (a `required` list, an `enum`) and every other value are compared whole.
 * Every path and value is the server's own text: cleaned, on one line, and
 * cut, before anyone is shown it.
 */

/** One changed field: absent `before`, the field is new; absent `after`, it is gone. */
export interface McpDefinitionChange {
  /** Where in the definition: `description`, `annotations.readOnlyHint`, `inputSchema.properties.to.type`. */
  readonly field: string;
  readonly before?: string;
  readonly after?: string;
}

/** The changed fields, at most `MAX_CHANGES` of them, and how many more were left out. */
export interface McpDefinitionDiff {
  readonly fields: readonly McpDefinitionChange[];
  readonly more: number;
}

/** Fields listed before the rest are counted as `more`. */
const MAX_CHANGES = 40;
/** A value's characters as shown; a longer one is cut with `…`. */
const MAX_VALUE = 300;
/** A path's characters as shown. */
const MAX_FIELD = 160;
/** Nesting walked key by key; anything deeper is compared whole. */
const MAX_DEPTH = 12;

/** A value on one line: a string as quoted text, anything else as its canonical JSON; cleaned and cut. */
function shownValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? JSON.stringify(cleanServerText(value).replace(/\s+/g, " ").trim()) : canonicalJson(value);
  } catch {
    text = String(value);
  }
  text = cleanServerText(text).replace(/\s+/g, " ");
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/** `a.b` for a plain key, `a["odd key"]` for any other. */
function joined(path: string, key: string): string {
  const step = /^[A-Za-z_$][\w$-]*$/.test(key) ? `${path === "" ? "" : "."}${key}` : `[${JSON.stringify(key)}]`;
  return `${path}${step}`;
}

const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

/** Every field that differs between the approved definition and the one listed now. */
export function definitionDiff(approved: McpToolDefinition, observed: McpToolDefinition): McpDefinitionDiff {
  const fields: McpDefinitionChange[] = [];
  let count = 0;
  const visit = (path: string, before: unknown, after: unknown, depth: number): void => {
    if (same(before, after)) return;
    if (isRecord(before) && isRecord(after) && depth < MAX_DEPTH) {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      for (const key of keys) visit(joined(path, key), before[key], after[key], depth + 1);
      return;
    }
    count += 1;
    if (fields.length >= MAX_CHANGES) return;
    const field = cleanServerText(path).replace(/\s+/g, " ").slice(0, MAX_FIELD);
    fields.push({
      field,
      ...(before === undefined ? {} : { before: shownValue(before) }),
      ...(after === undefined ? {} : { after: shownValue(after) }),
    });
  };
  visit("", approved, observed, 0);
  return { fields, more: count - fields.length };
}

/** One change as a line of text: `field: before → after`, `(none)` for a side that has no value. */
export function definitionChangeLine(change: McpDefinitionChange): string {
  return `${change.field}: ${change.before ?? "(none)"} → ${change.after ?? "(none)"}`;
}
