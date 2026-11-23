import { CORE_CANVAS_EN } from "./core-canvas-en.js";
import { channels } from "./en/channels.js";
import { terminal } from "./en/terminal.js";
import { plugins } from "./en/plugins.js";
import { presets } from "./en/presets.js";
import { setup } from "./en/setup.js";
import { pages } from "./en/pages.js";

/**
 * The `core` namespace in English: words every surface shares (the canvas,
 * the terminal, the owner's messages), starting with the calendar's, and the
 * server's own (the terminal's, the chat apps', setup's narration, the
 * owner's pages, the presets and the built-in plugins'). Every other
 * language's `core` catalogue matches it key for key.
 *
 * Names are spelled here rather than asked of `Intl`, whose month
 * abbreviations differ between ICU versions ("Sep" / "Sept"); a heading must
 * read the same on every machine.
 */
export const CORE_EN = {
  ...CORE_CANVAS_EN,
  ...channels,
  ...terminal,
  ...plugins,
  ...presets,
  ...setup,
  ...pages,
} as const;

export type CoreKey = keyof typeof CORE_EN;
