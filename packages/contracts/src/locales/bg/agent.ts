import type { CatalogFor } from "../../i18n.js";

import type { agent as en } from "../en/agent.js";

/** The `core` words for the agent's own words a person reads (reply language facts, sensitive-topic notes), in Bulgarian. */
export const agent = {} as const satisfies CatalogFor<typeof en>;
