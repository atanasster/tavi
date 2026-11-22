import type { CatalogFor } from "@tavi/contracts/i18n";

import type { routines as en } from "../en/routines.js";

/** The words of features/routines, in Bulgarian. */
export const routines = {} as const satisfies CatalogFor<typeof en>;
