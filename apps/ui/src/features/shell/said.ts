import type { CanvasCoreKey } from "@tavi/contracts/locales/core-canvas-en";

import { translateCore, translateNow } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";

/**
 * Module-level tables of words that other views read (`ROUTES`, the status
 * words): each word is said in the page's language when it is read, never
 * when the module loads, so the tables stay plain strings to their readers
 * and follow a change of language when read again: views under
 * `AppProviders` remount on one, and a memo above it must list the locale
 * in its deps.
 */

/** `rest`, with a `label` in the page's language at the time it is read. */
export function said<Rest extends object>(key: UiKey, rest: Rest): Rest & { readonly label: string } {
  return {
    ...rest,
    get label() {
      return translateNow(key);
    },
  };
}

/**
 * A table entry: `value`, and its `label` in the page's language at the time it is read. The label is a `core`
 * word naming a place in the canvas (a route, a Settings view, a Command Center section) that messages from the
 * owner name in their menu paths too ("Settings → Models"), so both read one key.
 */
export function saidCoreEntry<Value extends string>(value: Value, key: CanvasCoreKey): { readonly value: Value; readonly label: string } {
  return {
    value,
    get label() {
      return translateCore(key);
    },
  };
}

/** A record of words by name, each said in the page's language at the time it is read. */
export function saidRecord<Name extends string>(keys: Readonly<Record<Name, UiKey>>): Readonly<Record<Name, string>> {
  const words = {} as Record<Name, string>;
  for (const [name, key] of Object.entries(keys) as [Name, UiKey][])
    Object.defineProperty(words, name, { enumerable: true, get: () => translateNow(key) });
  return words;
}
