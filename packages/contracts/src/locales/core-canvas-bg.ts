import type { CatalogFor } from "../i18n.js";
import type { CORE_CANVAS_EN } from "./core-canvas-en.js";
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
import { apps } from "./bg/apps.js";

/** The `core` words the canvas says, in Bulgarian: its own chunk, loaded only when Bulgarian is chosen. */
export const CORE_CANVAS_BG = {
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
  ...apps,
} as const satisfies CatalogFor<typeof CORE_CANVAS_EN>;
