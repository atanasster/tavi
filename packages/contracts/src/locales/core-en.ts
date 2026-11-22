/**
 * The `core` namespace in English: words every surface shares (the canvas,
 * the terminal, the owner's messages), starting with the calendar's. Every
 * other language's `core` catalogue matches it key for key.
 *
 * Names are spelled here rather than asked of `Intl`, whose month
 * abbreviations differ between ICU versions ("Sep" / "Sept"); a heading must
 * read the same on every machine.
 */
export const CORE_EN = {
  "date.weekday.0": "Sunday",
  "date.weekday.1": "Monday",
  "date.weekday.2": "Tuesday",
  "date.weekday.3": "Wednesday",
  "date.weekday.4": "Thursday",
  "date.weekday.5": "Friday",
  "date.weekday.6": "Saturday",
  "date.weekdayShort.0": "Sun",
  "date.weekdayShort.1": "Mon",
  "date.weekdayShort.2": "Tue",
  "date.weekdayShort.3": "Wed",
  "date.weekdayShort.4": "Thu",
  "date.weekdayShort.5": "Fri",
  "date.weekdayShort.6": "Sat",
  "date.month.1": "January",
  "date.month.2": "February",
  "date.month.3": "March",
  "date.month.4": "April",
  "date.month.5": "May",
  "date.month.6": "June",
  "date.month.7": "July",
  "date.month.8": "August",
  "date.month.9": "September",
  "date.month.10": "October",
  "date.month.11": "November",
  "date.month.12": "December",
  "date.monthShort.1": "Jan",
  "date.monthShort.2": "Feb",
  "date.monthShort.3": "Mar",
  "date.monthShort.4": "Apr",
  "date.monthShort.5": "May",
  "date.monthShort.6": "Jun",
  "date.monthShort.7": "Jul",
  "date.monthShort.8": "Aug",
  "date.monthShort.9": "Sep",
  "date.monthShort.10": "Oct",
  "date.monthShort.11": "Nov",
  "date.monthShort.12": "Dec",
  /** "31 Dec". */
  "date.dayMonth": "{day} {monthShort}",
  /** "Tue 29 Sep". */
  "date.shortDay": "{weekdayShort} {day} {monthShort}",
  /** "Wednesday 30 Sep". */
  "date.longDay": "{weekday} {day} {monthShort}",
  /** A day out of this year: "Tue 29 Sep 2025". */
  "date.withYear": "{date} {year}",
  /** A day and a time: "Tue 29 Sep 14:30". */
  "date.dayTime": "{date} {time}",
  /** A month heading: "November 2026". */
  "date.monthYear": "{month} {year}",
} as const;

export type CoreKey = keyof typeof CORE_EN;
