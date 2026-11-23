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
import { terminal } from "./bg/terminal.js";
import { plugins } from "./bg/plugins.js";
import { apps } from "./bg/apps.js";
import { presets } from "./bg/presets.js";
import { setup } from "./bg/setup.js";
import { pages } from "./bg/pages.js";

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
  ...terminal,
  ...plugins,
  ...apps,
  ...presets,
  ...setup,
  ...pages,
} as const satisfies CatalogFor<typeof CORE_EN>;
