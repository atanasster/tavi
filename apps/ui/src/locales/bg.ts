import type { CatalogFor } from "@tavi/contracts/i18n";

import type { en } from "./en.js";

/** The canvas's words in Bulgarian, loaded in its own chunk only when the workspace speaks it. */
export const bg = {
  "settings.language.label": "Език",
  "settings.language.hint": "На този език Tavi ти говори в уеб интерфейса, в чатовете и в каналите ти.",
} as const satisfies CatalogFor<typeof en>;
