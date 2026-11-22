// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatCount } from "../../src/lib/format.js";
import { setLocale } from "../../src/lib/i18n.js";
import {
  dayHeading,
  dayMonth,
  dayTime,
  localDay,
  longDay,
  monthName,
  monthYear,
  shortDay,
  weekdayName,
  weekdayShortName,
} from "../../src/lib/time.js";

/**
 * Days and counts in Bulgarian: weekdays and months lowercase, a comma after
 * the weekday, "г." after a year, and a count grouped with a space.
 */

beforeAll(async () => {
  await setLocale("bg");
});

afterAll(async () => {
  await setLocale("en");
});

describe("days in English", () => {
  it('spells months the same on every machine, never ICU\'s "Sept"', async () => {
    await setLocale("en");
    expect(localDay("2026-09-29T10:00:00.000Z", "UTC")).toBe("Tue 29 Sep");
    await setLocale("bg");
  });
});

describe("days and counts in Bulgarian", () => {
  it("names weekdays and months in lowercase", () => {
    expect(weekdayName(1)).toBe("понеделник");
    expect(weekdayShortName(0)).toBe("нд");
    expect(monthName(9)).toBe("септември");
  });

  it("writes a day the Bulgarian way, with the year only when it is not this year's", () => {
    expect(shortDay("2026-09-29", "2026-11-22")).toBe("вт, 29 сеп");
    expect(longDay("2026-09-30", "2026-11-22")).toBe("сряда, 30 септември");
    expect(shortDay("2025-09-29", "2026-11-22")).toBe("пн, 29 сеп 2025 г.");
    expect(dayMonth("2026-12-31")).toBe("31 дек");
    expect(monthYear(2026, 11)).toBe("ноември 2026 г.");
    expect(dayHeading("2026-11-15", "2026-11-22")).toEqual({ title: "Неделя", detail: "15 ное" });
    expect(dayMonth("2026-03-03")).toBe("3 март");
  });

  it("puts a comma between a day and its time", () => {
    expect(dayTime("2026-09-29T11:30:00.000Z", "Europe/Sofia", "2026-11-22")).toBe("вт, 29 сеп, 14:30");
  });

  it("groups a count with a space from five digits", () => {
    expect(formatCount(1000)).toBe("1000");
    expect(formatCount(20_000)).toBe("20 000");
  });
});
