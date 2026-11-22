import type { CatalogFor } from "../../i18n.js";

import type { channels as en } from "../en/channels.js";

/** The `core` words for replies, digests, buttons and receipts sent to chat apps, in Bulgarian. */
export const channels = {} as const satisfies CatalogFor<typeof en>;
