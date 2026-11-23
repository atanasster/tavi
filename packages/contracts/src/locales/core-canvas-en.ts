import { date } from "./en/date.js";
import { labels } from "./en/labels.js";
import { safety } from "./en/safety.js";
import { schedule } from "./en/schedule.js";
import { connect } from "./en/connect.js";
import { errors } from "./en/errors.js";
import { notices } from "./en/notices.js";
import { onboarding } from "./en/onboarding.js";
import { nav } from "./en/nav.js";
import { agent } from "./en/agent.js";
import { reports } from "./en/reports.js";
import { apps } from "./en/apps.js";

/**
 * The `core` words the canvas says, in English: the parts of the `core`
 * namespace every surface shares (the calendar's, labels, approvals, errors,
 * notices, …). The terminal's, the chat apps', setup's narration, the owner's
 * pages, the presets and the built-in plugins' words are the server's alone
 * (`core-en.ts` adds them), so the canvas's bundle never carries them.
 *
 * Every word stored for later (`textRef`, a keyed error) is one of these, so
 * whichever surface reads it back knows it. The shared helpers in this
 * package take these words (`CanvasCoreT`); the owner and the terminal pass
 * them the whole catalogue, which holds them too.
 */
export const CORE_CANVAS_EN = {
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
} as const;

export type CanvasCoreKey = keyof typeof CORE_CANVAS_EN;
