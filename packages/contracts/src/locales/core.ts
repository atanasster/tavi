import { createTranslator, type Locale, type Translate } from "../i18n.js";
import { CORE_EN, type CoreKey } from "./core-en.js";

export type { CoreKey };

/** Menu paths inside a catalogue's own messages, in any language: `navPathIn(words, ...places)`. */
export { navPathIn, strayMenuPaths, type NavWords } from "./nav-path.js";

/**
 * The `core` words as a function: what every shared label and formatter in
 * this package takes as its last parameter, so the canvas passes its own
 * (Bulgarian loaded only when chosen) and the owner one for the workspace's
 * language. Left out, a helper speaks English, as it always has.
 */
export type CoreT = Translate<CoreKey>;

/** The `core` words in English: every helper's default. */
export const coreEnglish: CoreT = createTranslator({ en: CORE_EN }, "en");

/** Each language's name key: a language added to `SUPPORTED_LOCALES` without one fails to compile. */
const LANGUAGE_NAME_KEYS: { readonly [L in Locale]: CoreKey } = { en: "reports.language.en", bg: "reports.language.bg" };

/**
 * `locale`'s name in `t`'s language. Left as English, it is what a model is
 * told to write in ("Bulgarian"): its instructions are English whatever the workspace's language.
 */
export function languageName(locale: Locale, t: CoreT = coreEnglish): string {
  return t(LANGUAGE_NAME_KEYS[locale]);
}
