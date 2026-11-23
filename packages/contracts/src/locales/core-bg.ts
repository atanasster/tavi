import type { CatalogFor } from "../i18n.js";
import { CORE_CANVAS_BG } from "./core-canvas-bg.js";
import type { CORE_EN } from "./core-en.js";
import { channels } from "./bg/channels.js";
import { terminal } from "./bg/terminal.js";
import { plugins } from "./bg/plugins.js";
import { presets } from "./bg/presets.js";
import { setup } from "./bg/setup.js";
import { pages } from "./bg/pages.js";

/** The `core` namespace in Bulgarian: weekdays and months are lowercase, and a day reads "вт, 29 сеп". */
export const CORE_BG = {
  ...CORE_CANVAS_BG,
  ...channels,
  ...terminal,
  ...plugins,
  ...presets,
  ...setup,
  ...pages,
} as const satisfies CatalogFor<typeof CORE_EN>;
