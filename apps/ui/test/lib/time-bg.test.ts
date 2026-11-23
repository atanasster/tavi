// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { artifactMeta, formatBytes, formatCount } from "../../src/lib/format.js";
import { setLocale } from "../../src/lib/i18n.js";
import {
  dayHeading,
  dayMonth,
  dayTime,
  durationText,
  formatDuration,
  formatElapsed,
  greeting,
  localDay,
  longDay,
  monthName,
  monthYear,
  nearDay,
  relativeDay,
  relativeTime,
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
    // Counts in a time are written as they were, never grouped: "1200 h", not "1,200 h".
    expect(durationText(1_200 * 3_600_000)).toBe("1200 h");
    expect(durationText(20 * 3_600_000 + 1_200 * 60_000)).toBe("40 h");
    expect(formatElapsed(1_000 * 3_600_000)).toBe("1000h 00m");
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

/** A number and its unit stay together on a line. */
const NBSP = "\u00a0";

describe("relative days, times and spans in Bulgarian", () => {
  it("greets by the workspace's clock", () => {
    const utc = (time: string) => Date.parse(`2026-01-15T${time}:00Z`);
    expect(greeting("UTC", utc("08:00"))).toBe("Добро утро");
    expect(greeting("UTC", utc("13:00"))).toBe("Добър ден");
    expect(greeting("UTC", utc("20:00"))).toBe("Добър вечер");
  });

  it("says today, yesterday and tomorrow", () => {
    expect(relativeDay("2026-11-22", "2026-11-22", "past")).toBe("днес");
    expect(relativeDay("2026-11-21", "2026-11-22", "past")).toBe("вчера");
    expect(relativeDay("2026-11-23", "2026-11-22", "future")).toBe("утре");
    expect(nearDay("2026-11-25", "2026-11-22", "future")).toBe("ср, 25 ное");
    expect(dayHeading("2026-11-22", "2026-11-22").title).toBe("Днес");
    expect(dayHeading("2026-11-21", "2026-11-22").title).toBe("Вчера");
  });

  it("counts the time to an instant", () => {
    const now = Date.parse("2026-11-22T10:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(relativeTime(at(-1_000), now, "UTC")).toBe("сега");
    expect(relativeTime(at(30_000), now, "UTC")).toBe("след по-малко от минута");
    expect(relativeTime(at(5 * 60_000), now, "UTC")).toBe(`след 5${NBSP}мин`);
    expect(relativeTime(at(3 * 3_600_000), now, "UTC")).toBe(`след 3${NBSP}ч`);
    expect(relativeTime("2026-11-23T11:00:00Z", now, "UTC")).toBe(`след 1${NBSP}ден`);
    expect(relativeTime("2026-11-25T09:00:00Z", now, "UTC")).toBe(`след 3${NBSP}дни`);
  });

  it("writes spans with Bulgarian units and a decimal comma", () => {
    expect(durationText(45_000, { seconds: true })).toBe(`45${NBSP}сек`);
    expect(durationText(125 * 60_000)).toBe(`2${NBSP}ч 5${NBSP}мин`);
    expect(durationText(27 * 3_600_000, { days: true })).toBe(`1${NBSP}д 3${NBSP}ч`);
    expect(formatElapsed(1_400)).toBe(`1,4${NBSP}с`);
    expect(formatElapsed(125_000)).toBe(`2${NBSP}мин 05${NBSP}с`);
    expect(formatElapsed(3_720_000)).toBe(`1${NBSP}ч 02${NBSP}мин`);
    expect(formatDuration(340)).toBe(`340${NBSP}мс`);
    expect(formatDuration(1_200)).toBe(`1,2${NBSP}сек`);
  });

  it("writes sizes in байта, КБ and МБ", () => {
    expect(formatBytes(1)).toBe(`1${NBSP}байт`);
    expect(formatBytes(120)).toBe(`120${NBSP}байта`);
    expect(formatBytes(1536)).toBe(`1,5${NBSP}КБ`);
    expect(formatBytes(3 * 1024 * 1024)).toBe(`3,0${NBSP}МБ`);
    expect(artifactMeta({ contentType: "text/plain", byteSize: 120, reviewState: "pending" })).toBe(
      `text/plain, 120${NBSP}байта, чака преглед`,
    );
  });
});
