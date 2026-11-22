import { createTranslator, type Translate } from "../i18n.js";
import { CORE_EN, type CoreKey } from "./core-en.js";

export type { CoreKey };

/**
 * The `core` words as a function: what every shared label and formatter in
 * this package takes as its last parameter, so the canvas passes its own
 * (Bulgarian loaded only when chosen) and the owner one for the workspace's
 * language. Left out, a helper speaks English, as it always has.
 */
export type CoreT = Translate<CoreKey>;

/** The `core` words in English: every helper's default. */
export const coreEnglish: CoreT = createTranslator({ en: CORE_EN }, "en");
