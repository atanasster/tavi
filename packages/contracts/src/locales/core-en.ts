import { date } from "./en/date.js";
import { labels } from "./en/labels.js";
import { safety } from "./en/safety.js";
import { schedule } from "./en/schedule.js";
import { connect } from "./en/connect.js";
import { errors } from "./en/errors.js";
import { notices } from "./en/notices.js";
import { onboarding } from "./en/onboarding.js";
import { nav } from "./en/nav.js";

/**
 * The `core` namespace in English: words every surface shares (the canvas,
 * the terminal, the owner's messages), starting with the calendar's. Every
 * other language's `core` catalogue matches it key for key.
 *
 * Names are spelled here rather than asked of `Intl`, whose month
 * abbreviations differ between ICU versions ("Sep" / "Sept"); a heading must
 * read the same on every machine.
 */
export const CORE_EN = { ...date, ...labels, ...safety, ...schedule, ...connect, ...errors, ...notices, ...onboarding, ...nav } as const;

export type CoreKey = keyof typeof CORE_EN;
