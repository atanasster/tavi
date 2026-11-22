import type { CatalogFor } from "@tavi/contracts/i18n";

import type { ideas as en } from "../en/ideas.js";

/** The words of features/ideas, in Bulgarian. */
export const ideas = {} as const satisfies CatalogFor<typeof en>;
