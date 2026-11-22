import { createTranslator, DEFAULT_LOCALE, type Locale } from "../i18n.js";
import { CORE_BG } from "./core-bg.js";
import type { CoreT } from "./core.js";
import { CORE_EN } from "./core-en.js";

/**
 * The `core` words in `locale`, every language loaded up front: for the owner
 * and the terminal, which carry no bundle budget. The canvas never imports
 * this; it loads Bulgarian's catalogue only when Bulgarian is chosen.
 */
export function coreIn(locale: Locale = DEFAULT_LOCALE): CoreT {
  return createTranslator({ en: CORE_EN, bg: CORE_BG }, locale);
}
