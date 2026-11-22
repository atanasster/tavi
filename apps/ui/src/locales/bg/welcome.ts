import type { CatalogFor } from "@tavi/contracts/i18n";

import type { welcome as en } from "../en/welcome.js";

/** The words of features/welcome, in Bulgarian. */
export const welcome = {} as const satisfies CatalogFor<typeof en>;
