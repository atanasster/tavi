import type { CatalogFor } from "../../i18n.js";

import type { errors as en } from "../en/errors.js";

/** The `core` words for errors a person reads, from every part of Tavi, in Bulgarian. */
export const errors = {} as const satisfies CatalogFor<typeof en>;
