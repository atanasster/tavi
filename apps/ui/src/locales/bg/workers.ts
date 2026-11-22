import type { CatalogFor } from "@tavi/contracts/i18n";

import type { workers as en } from "../en/workers.js";

/** The words of features/workers, in Bulgarian. */
export const workers = {} as const satisfies CatalogFor<typeof en>;
