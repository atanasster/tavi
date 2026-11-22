import type { CatalogFor } from "../i18n.js";
import type { CORE_EN } from "./core-en.js";
import { date } from "./bg/date.js";
import { labels } from "./bg/labels.js";
import { safety } from "./bg/safety.js";
import { schedule } from "./bg/schedule.js";
import { connect } from "./bg/connect.js";
import { errors } from "./bg/errors.js";
import { notices } from "./bg/notices.js";
import { onboarding } from "./bg/onboarding.js";
import { nav } from "./bg/nav.js";
import { agent } from "./bg/agent.js";
import { reports } from "./bg/reports.js";
import { channels } from "./bg/channels.js";

/** The `core` namespace in Bulgarian: weekdays and months are lowercase, and a day reads "вт, 29 сеп". */
export const CORE_BG = {
  ...date,
  ...labels,
  ...safety,
  ...schedule,
  ...connect,
  ...errors,
  ...notices,
  ...onboarding,
  ...nav,
  ...agent,
  ...reports,
  ...channels,
} as const satisfies CatalogFor<typeof CORE_EN>;
