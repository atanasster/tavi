import type { CatalogFor } from "../../i18n.js";

import type { notices as en } from "../en/notices.js";

/** The `core` words for notices posted to a chat or Home, in Bulgarian. */
export const notices = {} as const satisfies CatalogFor<typeof en>;
