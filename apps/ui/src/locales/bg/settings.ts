import type { CatalogFor } from "@tavi/contracts/i18n";

import type { settings as en } from "../en/settings.js";

/** The words of features/settings, in Bulgarian. */
export const settings = {
  "settings.language.label": "Език",
  "settings.language.hint": "На този език Tavi ти говори в уеб интерфейса, в чатовете и в каналите ти.",
} as const satisfies CatalogFor<typeof en>;
