import { createTranslator, type Translate } from "../i18n.js";
import { englishDefault } from "./core-canvas.js";
import { CORE_EN, type CoreKey } from "./core-en.js";

export type { CoreKey };

/** Menu paths inside a catalogue's own messages, in any language: `navPathIn(words, ...places)`. */
export { navPathIn, strayMenuPaths, type NavWords } from "./nav-path.js";

/** The words the canvas says too, the shared helpers' parameter (`CanvasCoreT`), and a language's name. */
export { isCoreEnglish, languageName, type CanvasCoreKey, type CanvasCoreT } from "./core-canvas.js";

/**
 * The whole `core` catalogue as a function, the server's own words included
 * (the terminal's, the chat apps', setup's narration): what the owner and the
 * terminal say with. The shared helpers take it wherever they take the
 * canvas's words (`CanvasCoreT`), which it holds too. The canvas never imports
 * this module; it says its words through `core-canvas.ts`.
 */
export type CoreT = Translate<CoreKey>;

/** The `core` words in English, the server's own included: the owner's and the terminal's default. */
export const coreEnglish: CoreT = englishDefault(createTranslator({ en: CORE_EN }, "en"));

/** Whether `key` is one of the whole `core` catalogue's, the server's own words included (`isCanvasCoreKey` for the canvas's). */
export function isCoreKey(key: string): key is CoreKey {
  return Object.hasOwn(CORE_EN, key);
}
