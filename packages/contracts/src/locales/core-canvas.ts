import { createTranslator, type Locale, type Translate } from "../i18n.js";
import { CORE_CANVAS_EN, type CanvasCoreKey } from "./core-canvas-en.js";

export type { CanvasCoreKey };

/** Menu paths inside a catalogue's own messages, in any language: `navPathIn(words, ...places)`. */
export { navPathIn, strayMenuPaths, type NavWords } from "./nav-path.js";

/**
 * The `core` words the canvas says, as a function: what every shared label
 * and formatter in this package takes as its last parameter, so the canvas
 * passes its own (Bulgarian loaded only when chosen) and the owner its whole
 * catalogue (`coreIn`) for the workspace's language. Left out, a helper speaks
 * English, as it always has.
 */
export type CanvasCoreT = Translate<CanvasCoreKey>;

/** The translators that are English by default (`canvasCoreEnglish`, and `coreEnglish` over the whole catalogue). */
const ENGLISH_DEFAULTS = new WeakSet<Translate<never>>();

/** `t`, known from now on as an English default (`isCoreEnglish`). */
export function englishDefault<T extends Translate<never>>(t: T): T {
  ENGLISH_DEFAULTS.add(t);
  return t;
}

/**
 * Whether `t` is the English a helper speaks when left out (`canvasCoreEnglish`
 * or the owner's `coreEnglish`), rather than a reader's language: where English
 * keeps the words it always had (a stored title as it is).
 */
export function isCoreEnglish(t: Translate<never>): boolean {
  return ENGLISH_DEFAULTS.has(t);
}

/** The canvas's `core` words in English: every shared helper's default. */
export const canvasCoreEnglish: CanvasCoreT = englishDefault(createTranslator({ en: CORE_CANVAS_EN }, "en"));

/** Each language's name key: a language added to `SUPPORTED_LOCALES` without one fails to compile. */
const LANGUAGE_NAME_KEYS: { readonly [L in Locale]: CanvasCoreKey } = { en: "reports.language.en", bg: "reports.language.bg" };

/**
 * `locale`'s name in `t`'s language. Left as English, it is what a model is
 * told to write in ("Bulgarian"): its instructions are English whatever the workspace's language.
 */
export function languageName(locale: Locale, t: CanvasCoreT = canvasCoreEnglish): string {
  return t(LANGUAGE_NAME_KEYS[locale]);
}
