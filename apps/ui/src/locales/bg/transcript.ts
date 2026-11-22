import type { CatalogFor } from "@tavi/contracts/i18n";

import type { transcript as en } from "../en/transcript.js";

/** The words of features/transcript, in Bulgarian. */
export const transcript = {} as const satisfies CatalogFor<typeof en>;
