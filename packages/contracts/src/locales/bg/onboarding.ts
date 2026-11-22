import type { CatalogFor } from "../../i18n.js";

import type { onboarding as en } from "../en/onboarding.js";

/** The `core` words for the onboarding host's steps and their state, in Bulgarian. */
export const onboarding = {} as const satisfies CatalogFor<typeof en>;
