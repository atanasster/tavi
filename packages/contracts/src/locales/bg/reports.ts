import type { CatalogFor } from "../../i18n.js";

import type { reports as en } from "../en/reports.js";

/** The `core` words for summaries, idea rewording and routine reports, in Bulgarian. */
export const reports = {} as const satisfies CatalogFor<typeof en>;
