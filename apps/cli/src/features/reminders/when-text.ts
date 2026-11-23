import { formatReminderTime, localDateTime } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

import { zonedClock, zonedShortDay } from "../channels/channel-words.js";

/**
 * "Mon 5 Oct 10:00" in `t`'s words, the year said when it is not this one;
 * English as `formatReminderTime` says it. A channel's reminder and the
 * terminal's reminder list both say a time this way.
 */
export function reminderWhenText(instant: Date, timezone: string, t: CoreT): string {
  if (t === coreEnglish) return formatReminderTime(instant, timezone);
  const year = localDateTime(instant, timezone).year;
  return t("channel.reminder.when", {
    day: zonedShortDay(instant, timezone, t),
    year: year === localDateTime(new Date(), timezone).year ? "" : ` ${year}`,
    time: zonedClock(instant, timezone),
  });
}
