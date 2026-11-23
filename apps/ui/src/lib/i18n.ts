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

import { CORE_CANVAS_EN, type CanvasCoreKey } from "@tavi/contracts/locales/core-canvas-en";

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

/**
 * A language's catalogues: the canvas's own and the `core` words it shares with every surface — the canvas's part of
 * `core` (`core-canvas`), never the server's own words (the terminal's, the chat apps', setup's narration), which it
 * never says.
 */
interface Catalogues {
  readonly ui: CatalogFor<typeof en>;
  readonly core: CatalogFor<typeof CORE_CANVAS_EN>;
}

/** The browser's convenience copy of the last language shown. */
export const LOCALE_STORAGE_KEY = "tavi.locale";

/**
 * Set to "1" in this browser's storage (then reload), the page stretches and
 * marks every word it says (`qps`): the overflow walk's longer-than-Bulgarian
 * pass, and a word still written inline shows unmarked.
 */
export const PSEUDO_STORAGE_KEY = "tavi.pseudoLocale";

const loaders: { readonly [L in Exclude<Locale, "en">]: () => Promise<Catalogues> } = {
  bg: async () => {
    const [ui, core] = await Promise.all([import("../locales/bg.js"), import("@tavi/contracts/locales/core-canvas-bg")]);
    return { ui: ui.bg, core: core.CORE_CANVAS_BG };
  },
};

const loaded: { [L in Exclude<Locale, "en">]?: Catalogues } = {};
let locale: Locale = DEFAULT_LOCALE;
let translate: Translate<UiKey> = createTranslator({ en }, DEFAULT_LOCALE);
let translateCoreWords: Translate<CanvasCoreKey> = createTranslator({ en: CORE_CANVAS_EN }, DEFAULT_LOCALE);
const listeners = new Set<() => void>();
let requested = 0;

function publish(next: Locale): void {
  locale = next;
  const languages = Object.entries(loaded) as [Exclude<Locale, "en">, Catalogues][];
  const options = { pseudo: readStored(PSEUDO_STORAGE_KEY) === "1" };
  translate = createTranslator(
    { en, ...Object.fromEntries(languages.map(([language, catalogues]) => [language, catalogues.ui])) },
    next,
    options,
  );
  translateCoreWords = createTranslator(
    { en: CORE_CANVAS_EN, ...Object.fromEntries(languages.map(([language, catalogues]) => [language, catalogues.core])) },
    next,
    options,
  );
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

/**
 * The `core` words now (the calendar's, shared with the terminal and the
 * owner), for the helpers in `time.ts` and `format.ts`. The shell remounts its
 * views on a change of language, so a view that shows them is drawn again.
 */
export function translateCore(key: CanvasCoreKey, params?: MessageParams): string {
  return translateCoreWords(key, params);
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
