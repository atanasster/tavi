import { useSyncExternalStore } from "react";

import {
  createTranslator,
  DEFAULT_LOCALE,
  isLocale,
  type CatalogFor,
  type Locale,
  type MessageParams,
  type Translate,
} from "@tavi/contracts/i18n";

import { en, type UiKey } from "../locales/en.js";
import { readStored, writeStored } from "./storage.js";

/**
 * The canvas's language: which one it speaks, its catalogues (English up
 * front; another language's from its own chunk, loaded when chosen, so a page
 * in English never downloads it), and the hooks a view reads its words with.
 *
 * One store for the whole page rather than a provider, so the startup screens
 * the shell has not mounted yet speak it too. The workspace's setting arrives
 * with the center summary; until then the language the page last showed
 * (kept in this browser) stands in, so a Bulgarian page does not flash English.
 */

type UiCatalog = CatalogFor<typeof en>;

/** The browser's convenience copy of the last language shown. */
export const LOCALE_STORAGE_KEY = "tavi.locale";

const loaders: { readonly [L in Exclude<Locale, "en">]: () => Promise<UiCatalog> } = {
  bg: () => import("../locales/bg.js").then((module) => module.bg),
};

const loaded: { [L in Exclude<Locale, "en">]?: UiCatalog } = {};
let locale: Locale = DEFAULT_LOCALE;
let translate: Translate<UiKey> = createTranslator({ en }, DEFAULT_LOCALE);
const listeners = new Set<() => void>();
let requested = 0;

function publish(next: Locale): void {
  locale = next;
  translate = createTranslator({ en, ...loaded }, next);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

/**
 * Speak `next` from now on: its catalogue loaded first (English meanwhile),
 * then every view re-rendered, `<html lang>` set, and the choice kept for the
 * next page load. A catalogue that fails to load leaves the page as it was.
 */
export async function setLocale(next: Locale): Promise<void> {
  // The latest choice wins: a slow catalogue that lands after a newer choice is kept, not shown.
  requested += 1;
  const request = requested;
  if (next !== "en" && loaded[next] === undefined) {
    try {
      loaded[next] = await loaders[next]();
    } catch {
      return;
    }
  }
  if (request !== requested) return;
  writeStored(LOCALE_STORAGE_KEY, next);
  publish(next);
}

/** The language the page showed last, from this browser's storage; English when none or unknown. */
export function storedLocale(): Locale {
  const stored = readStored(LOCALE_STORAGE_KEY);
  return isLocale(stored) ? stored : DEFAULT_LOCALE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The language the page speaks now. */
export function currentLocale(): Locale {
  return locale;
}

/** The page's words now, for code outside a component (a refusal built in `ipc.ts`). A view uses `useT`. */
export function translateNow(key: UiKey, params?: MessageParams): string {
  return translate(key, params);
}

/** The language the page speaks, re-rendering the view when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale);
}

/** The page's words in its language, re-rendering the view when the language changes. */
export function useT(): Translate<UiKey> {
  return useSyncExternalStore(
    subscribe,
    () => translate,
    () => translate,
  );
}
