import type { CatalogFor } from "@tavi/contracts/i18n";

import type { apps as en } from "../en/apps.js";

/** The words of features/apps, in Bulgarian. */
export const apps = {} as const satisfies CatalogFor<typeof en>;
