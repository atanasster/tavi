import { describe, expect, it } from "vitest";

import {
  ReminderWhenSchema,
  SnoozeReminderInputSchema,
  nextReminderFire,
  reminderReadBack,
  type ReminderSchedule,
} from "../src/reminders.js";

/** Monthly and yearly reminders: a month's last day for a day it lacks, an nth or last weekday, and 29 February. */
describe("monthly and yearly reminders", () => {
  const schedule = (when: ReminderSchedule["when"]): ReminderSchedule => ({ when, timezone: "UTC" }) as ReminderSchedule;
  const next = (when: ReminderSchedule["when"], after: string) => nextReminderFire(schedule(when), new Date(after))?.at.toISOString();

  it("fires on a day of the month, on the last day of a shorter month", () => {
    const rent = { kind: "repeat" as const, times: ["09:00"], monthly: { dayOfMonth: 31 } };
    expect(next(rent, "2027-01-31T10:00:00Z")).toBe("2027-02-28T09:00:00.000Z");
    expect(next(rent, "2027-03-01T00:00:00Z")).toBe("2027-03-31T09:00:00.000Z");
    expect(next({ kind: "repeat", times: ["09:00"], monthly: { dayOfMonth: 1 } }, "2027-01-15T00:00:00Z")).toBe("2027-02-01T09:00:00.000Z");
  });

  it("fires on the nth or the last weekday of a month", () => {
    // The second Tuesday of February 2027 is the 9th; the last Friday of January 2027 the 29th.
    expect(next({ kind: "repeat", times: ["08:00"], monthly: { nth: 2, weekday: 2 } }, "2027-02-01T00:00:00Z")).toBe(
      "2027-02-09T08:00:00.000Z",
    );
    expect(next({ kind: "repeat", times: ["08:00"], monthly: { nth: -1, weekday: 5 } }, "2027-01-01T00:00:00Z")).toBe(
      "2027-01-29T08:00:00.000Z",
    );
  });

  it("fires once a year, 29 February on the 28th in a year without one", () => {
    const birthday = { kind: "repeat" as const, times: ["07:00"], yearly: { month: 2, day: 29 } };
    expect(next(birthday, "2027-01-01T00:00:00Z")).toBe("2027-02-28T07:00:00.000Z");
    expect(next(birthday, "2027-03-01T00:00:00Z")).toBe("2028-02-29T07:00:00.000Z");
  });

  it("repeats on weekdays, monthly or yearly, one at a time, and says which", () => {
    expect(ReminderWhenSchema.safeParse({ kind: "repeat", times: ["09:00"], daysOfWeek: [1], monthly: { dayOfMonth: 1 } }).success).toBe(
      false,
    );
    const read = reminderReadBack(
      schedule({ kind: "repeat", times: ["09:00"], monthly: { dayOfMonth: 31 } }),
      new Date("2027-01-01T00:00:00Z"),
    );
    expect(read).toContain("every month on the 31st (the last day in shorter months) at 09:00");
  });

  it("takes 29 February for a yearly date, and refuses a day its month never has", () => {
    const yearly = (month: number, day: number) =>
      ReminderWhenSchema.safeParse({ kind: "repeat", times: ["09:00"], yearly: { month, day } }).success;
    expect(yearly(2, 29)).toBe(true);
    expect(yearly(4, 31)).toBe(false);
    expect(yearly(2, 30)).toBe(false);
  });

  it("snoozes by any span up to a week", () => {
    expect(SnoozeReminderInputSchema.safeParse({ reminderId: "r1", minutes: 1440, now: "2027-01-01T00:00:00.000Z" }).success).toBe(true);
    expect(SnoozeReminderInputSchema.safeParse({ reminderId: "r1", minutes: 10_081, now: "2027-01-01T00:00:00.000Z" }).success).toBe(false);
  });
});
