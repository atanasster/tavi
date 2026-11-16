import { describe, expect, it } from "vitest";

import {
  reminderRetryDecision,
  REMINDER_DEFAULT_NOTIFY,
  REMINDER_MAX_TIMES_PER_DAY,
  RemindersPayloadSchema,
  ReminderWhenSchema,
  checkReminderSchedule,
  describeReminderOffset,
  formatReminderOffset,
  nextReminderFire,
  normalizeReminderWhen,
  parseReminderOffset,
  reminderFireDisposition,
  reminderOccurrences,
  reminderReadBack,
  formatReminderTime,
  upcomingReminderFires,
  type ReminderSchedule,
} from "../src/index.js";

/** Reminders' contract: the notice grammar and the occurrence math. */

const BERLIN = "Europe/Berlin";
const iso = (values: readonly { at: Date }[]) => values.map((value) => value.at.toISOString());

describe("notice offsets", () => {
  it("parses and formats each form", () => {
    expect(parseReminderOffset("-15m")).toEqual({ amount: 15, unit: "m" });
    expect(parseReminderOffset("-2h")).toEqual({ amount: 2, unit: "h" });
    expect(parseReminderOffset("-1d")).toEqual({ amount: 1, unit: "d" });
    expect(parseReminderOffset("-1d@20:00")).toEqual({ amount: 1, unit: "d", at: "20:00" });
    for (const text of ["-15m", "-2h", "-1d", "-1d@20:00", "-30d@07:05"]) {
      expect(formatReminderOffset(parseReminderOffset(text)!)).toBe(text);
    }
    expect(describeReminderOffset(parseReminderOffset("-1d@20:00")!)).toBe("1 day before at 20:00");
    expect(describeReminderOffset(parseReminderOffset("-15m")!)).toBe("15 minutes before");
  });

  it("refuses zero, positive, hours with a time, unknown units and more than 30 days", () => {
    for (const text of ["-0m", "15m", "+1h", "-1h@20:00", "-1w", "-31d", "-721h", "-43201m", "-1d@24:00", "-01h", ""]) {
      expect(parseReminderOffset(text)).toBeUndefined();
    }
    expect(parseReminderOffset("-30d")).toBeDefined();
    expect(parseReminderOffset("-720h")).toBeDefined();
    expect(parseReminderOffset("-43200m")).toBeDefined();
  });
});

describe("reminder schedules", () => {
  it("accepts an instant without seconds, and stores it in UTC", () => {
    const when = ReminderWhenSchema.parse({ kind: "event", at: "2026-10-05T10:00+02:00", notify: [...REMINDER_DEFAULT_NOTIFY] });
    expect(normalizeReminderWhen(when)).toEqual({ kind: "event", at: "2026-10-05T08:00:00.000Z", notify: ["-1d@20:00", "-1h"] });
    expect(ReminderWhenSchema.safeParse({ kind: "once", at: "2026-10-05T10:00" }).success).toBe(false);
  });

  it("refuses more than six times a day, repeated times and repeated notices with a person's message", () => {
    const times = ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00"];
    const tooMany = ReminderWhenSchema.safeParse({ kind: "repeat", times });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0]?.message).toBe(`Reminders can repeat at most ${REMINDER_MAX_TIMES_PER_DAY} times a day`);
    expect(ReminderWhenSchema.safeParse({ kind: "repeat", times: ["08:00", "08:00"] }).error?.issues[0]?.message).toBe(
      "Each time may be named only once",
    );
    expect(ReminderWhenSchema.safeParse({ kind: "event", at: "2026-10-05T10:00Z", notify: ["-1h", "-1h"] }).success).toBe(false);
    expect(
      ReminderWhenSchema.safeParse({ kind: "event", at: "2026-10-05T10:00Z", notify: ["-1h", "-2h", "-3h", "-4h", "-5h", "-6h"] }).success,
    ).toBe(false);
  });

  it("fires a once reminder at its time only", () => {
    const reminder: ReminderSchedule = { when: { kind: "once", at: "2026-10-05T08:00:00.000Z" }, timezone: BERLIN };
    expect(iso(reminderOccurrences(reminder, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-10T00:00:00Z")))).toEqual([
      "2026-10-05T08:00:00.000Z",
    ]);
    expect(nextReminderFire(reminder, new Date("2026-10-05T08:00:00.000Z"))).toBeNull();
    expect(nextReminderFire(reminder, new Date("2026-10-05T07:59:59.000Z"))).toMatchObject({ occurrence: "once" });
  });

  it("fires an event's notices, not the event itself, with -1d@20:00 on the previous local day across the DST change", () => {
    // Sunday 25 October 2026, 10:00 in Berlin: the clocks went back at 03:00 that morning (UTC+1 from then).
    const reminder: ReminderSchedule = {
      when: { kind: "event", at: "2026-10-25T09:00:00.000Z", notify: ["-1d@20:00", "-1d", "-1h", "-15m"] },
      timezone: BERLIN,
    };
    const fires = reminderOccurrences(reminder, new Date("2026-10-20T00:00:00Z"), new Date("2026-10-30T00:00:00Z"));
    expect(fires.map((fire) => [fire.at.toISOString(), fire.noticeOffset])).toEqual([
      // Saturday 24 October, 10:00 CEST (UTC+2): the same local time a calendar day before, 25 hours earlier.
      ["2026-10-24T08:00:00.000Z", "-1d"],
      // Saturday 24 October, 20:00 CEST.
      ["2026-10-24T18:00:00.000Z", "-1d@20:00"],
      ["2026-10-25T08:00:00.000Z", "-1h"],
      ["2026-10-25T08:45:00.000Z", "-15m"],
    ]);
    expect(fires.every((fire) => fire.occurrence === "notice")).toBe(true);
  });

  it("fires the evening-before notice after the spring change at 20:00 local too", () => {
    // Monday 30 March 2026, 09:00 CEST; the clocks went forward on Sunday 29 March.
    const reminder: ReminderSchedule = { when: { kind: "event", at: "2026-03-30T07:00:00.000Z", notify: ["-1d@20:00"] }, timezone: BERLIN };
    expect(iso(upcomingReminderFires(reminder, new Date("2026-03-01T00:00:00Z"), 5))).toEqual(["2026-03-29T18:00:00.000Z"]);
  });

  it("repeats each time on matching days until its last date, in the zone and across DST", () => {
    const reminder: ReminderSchedule = {
      // Weekdays (Mon–Fri), at 21:00 and 08:00, through Tuesday 27 October.
      when: { kind: "repeat", times: ["21:00", "08:00"], daysOfWeek: [1, 2, 3, 4, 5], until: "2026-10-27" },
      timezone: BERLIN,
    };
    // Thursday 22 October 12:00Z onwards.
    const fires = reminderOccurrences(reminder, new Date("2026-10-22T12:00:00.000Z"), new Date("2026-11-05T00:00:00.000Z"));
    expect(iso(fires)).toEqual([
      "2026-10-22T19:00:00.000Z", // Thu 21:00 CEST
      "2026-10-23T06:00:00.000Z", // Fri 08:00 CEST
      "2026-10-23T19:00:00.000Z", // Fri 21:00 CEST
      // Saturday and Sunday are not in the mask; winter time from Sunday.
      "2026-10-26T07:00:00.000Z", // Mon 08:00 CET
      "2026-10-26T20:00:00.000Z",
      "2026-10-27T07:00:00.000Z", // Tue, the last day
      "2026-10-27T20:00:00.000Z",
    ]);
    expect(fires.every((fire) => fire.occurrence === "repeat")).toBe(true);
    expect(nextReminderFire(reminder, new Date("2026-10-27T20:00:00.000Z"))).toBeNull();
  });

  it("fires a time the spring change skips at the first minute that exists, and two times in the gap once", () => {
    // Sunday 29 March 2026: Berlin's clocks jump from 02:00 to 03:00 CEST.
    const reminder: ReminderSchedule = { when: { kind: "repeat", times: ["01:30", "02:30", "03:00"] }, timezone: BERLIN };
    const fires = reminderOccurrences(reminder, new Date("2026-03-28T12:00:00.000Z"), new Date("2026-03-30T00:00:00.000Z"));
    expect(iso(fires)).toEqual([
      "2026-03-29T00:30:00.000Z", // 01:30 CET
      "2026-03-29T01:00:00.000Z", // 02:30 does not exist: 03:00 CEST, the same instant as 03:00 itself
      "2026-03-29T23:30:00.000Z", // Monday 01:30 CEST
    ]);
    expect(fires.map((fire) => fire.time)).toEqual(["01:30", "02:30", "01:30"]);
  });

  it("repeats every day without a mask or an end", () => {
    const reminder: ReminderSchedule = { when: { kind: "repeat", times: ["21:00"] }, timezone: "UTC" };
    expect(nextReminderFire(reminder, new Date("2026-10-01T21:00:00.000Z"))?.at.toISOString()).toBe("2026-10-02T21:00:00.000Z");
    expect(upcomingReminderFires(reminder, new Date("2026-10-01T00:00:00.000Z"), 3)).toHaveLength(3);
  });
});

describe("checkReminderSchedule", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");

  it("reports notices already past and fires the rest", () => {
    const check = checkReminderSchedule(
      { when: { kind: "event", at: "2026-10-02T06:00:00.000Z", notify: ["-1d@20:00", "-1d", "-1h"] }, timezone: BERLIN },
      now,
    );
    // -1d is 1 October 08:00 CEST, before now.
    expect(check.skippedNotices).toEqual(["-1d"]);
    expect(check.first).toMatchObject({ occurrence: "notice", noticeOffset: "-1d@20:00" });
    expect(check.first.at.toISOString()).toBe("2026-10-01T18:00:00.000Z");
  });

  it("refuses the past, too far ahead, all notices past, an ended repeat and an unknown zone in a person's words", () => {
    const refused = (schedule: ReminderSchedule) => {
      try {
        checkReminderSchedule(schedule, now);
      } catch (error) {
        return { code: (error as { code?: string }).code, message: (error as Error).message };
      }
      return undefined;
    };
    expect(refused({ when: { kind: "once", at: "2026-10-01T11:00:00.000Z" }, timezone: "UTC" })).toEqual({
      code: "INVALID_INPUT",
      message: "That time is in the past",
    });
    expect(refused({ when: { kind: "once", at: "2028-12-01T11:00:00.000Z" }, timezone: "UTC" })?.message).toBe(
      "Reminders can be set at most 2 years ahead",
    );
    expect(refused({ when: { kind: "event", at: "2026-10-01T12:30:00.000Z", notify: ["-1h"] }, timezone: "UTC" })?.message).toMatch(
      /already in the past/,
    );
    expect(refused({ when: { kind: "repeat", times: ["08:00"], until: "2026-09-30" }, timezone: "UTC" })?.message).toBe(
      "That repeat ends before it starts",
    );
    expect(refused({ when: { kind: "once", at: "2026-10-05T08:00:00.000Z" }, timezone: "Mars/Olympus" })?.code).toBe("INVALID_INPUT");
    expect(refused({ when: { kind: "repeat", times: ["08:00"], until: "2026-10-01" }, timezone: "UTC" })?.message).toBe(
      "That reminder would never fire",
    );
  });
});

describe("missed fires", () => {
  it("delivers within tolerance on time, within six hours late, and records older ones missed", () => {
    expect(reminderFireDisposition(30_000)).toBe("on-time");
    expect(reminderFireDisposition(3 * 3_600_000)).toBe("late");
    expect(reminderFireDisposition(6 * 3_600_000)).toBe("missed");
  });
});

describe("reminders payload", () => {
  it("parses each action and refuses a snooze outside a minute to a week", () => {
    expect(RemindersPayloadSchema.safeParse({ action: "list" }).success).toBe(true);
    expect(
      RemindersPayloadSchema.safeParse({ action: "create", text: "Take your pills", when: { kind: "repeat", times: ["21:00"] } }).success,
    ).toBe(true);
    expect(RemindersPayloadSchema.safeParse({ action: "snooze", reminderId: "r", minutes: 60 }).success).toBe(true);
    expect(RemindersPayloadSchema.safeParse({ action: "snooze", reminderId: "r", minutes: 15 }).success).toBe(true);
    expect(RemindersPayloadSchema.safeParse({ action: "snooze", reminderId: "r", minutes: 10_080 }).success).toBe(true);
    expect(RemindersPayloadSchema.safeParse({ action: "snooze", reminderId: "r", minutes: 0 }).success).toBe(false);
    expect(RemindersPayloadSchema.safeParse({ action: "snooze", reminderId: "r", minutes: 10_081 }).success).toBe(false);
    expect(RemindersPayloadSchema.safeParse({ action: "snooze", reminderId: "r", minutes: 1.5 }).success).toBe(false);
    expect(RemindersPayloadSchema.safeParse({ action: "fires", status: "unseen" }).success).toBe(true);
    expect(RemindersPayloadSchema.safeParse({ action: "acknowledge", reminderId: "r" }).success).toBe(false);
  });
});

describe("the read-back", () => {
  it("says the event and its notices in the reminder's zone, by weekday within the week", () => {
    const now = new Date("2026-10-01T10:00:00.000Z"); // Thursday
    // Monday 5 October, 10:00 in Berlin.
    expect(
      reminderReadBack({ when: { kind: "event", at: "2026-10-05T08:00:00.000Z", notify: ["-1d@20:00", "-1h"] }, timezone: BERLIN }, now),
    ).toBe("Mon 5 Oct 10:00 Europe/Berlin; I'll remind you Sun 20:00 and Mon 09:00");
    expect(reminderReadBack({ when: { kind: "once", at: "2026-10-02T07:00:00.000Z" }, timezone: BERLIN }, now)).toBe(
      "Fri 2 Oct 09:00 Europe/Berlin; I'll remind you then",
    );
    expect(reminderReadBack({ when: { kind: "repeat", times: ["21:00", "08:00"], daysOfWeek: [1, 3] }, timezone: BERLIN }, now)).toBe(
      "every Mon, Wed at 08:00 and 21:00 Europe/Berlin; next Mon 5 Oct 08:00",
    );
    expect(
      reminderReadBack({ when: { kind: "event", at: "2026-11-20T08:00:00.000Z", notify: ["-1d@20:00"] }, timezone: BERLIN }, now),
    ).toBe("Fri 20 Nov 09:00 Europe/Berlin; I'll remind you Thu 19 Nov 20:00");
    expect(formatReminderTime(new Date("2026-10-05T08:00:00.000Z"), "UTC")).toBe("Mon 5 Oct 08:00");
  });

  it('spells September "Sep", as the rest of the app does, whatever the ICU version', () => {
    expect(formatReminderTime(new Date("2026-09-30T19:00:00.000Z"), BERLIN)).toBe("Wed 30 Sep 21:00");
    expect(
      reminderReadBack({ when: { kind: "once", at: "2026-09-30T19:00:00.000Z" }, timezone: BERLIN }, new Date("2026-09-29T10:00:00.000Z")),
    ).toBe("Wed 30 Sep 21:00 Europe/Berlin; I'll remind you then");
  });
});

describe("a failed chat delivery", () => {
  it("is retried with doubling backoff, capped and inside the window the first failure opened, then delivered in the app", () => {
    const now = Date.parse("2026-10-01T13:00:00.000Z");
    expect(reminderRetryDecision({}, now)).toEqual({ outcome: "retry", retryAt: "2026-10-01T13:00:30.000Z" });
    expect(reminderRetryDecision({ attempts: 2, retryUntil: "2026-10-01T13:15:00.000Z" }, now)).toEqual({
      outcome: "retry",
      retryAt: "2026-10-01T13:02:00.000Z",
    });
    expect(reminderRetryDecision({ attempts: 8, retryUntil: "2026-10-01T13:15:00.000Z" }, now)).toEqual({
      outcome: "retry",
      retryAt: "2026-10-01T13:05:00.000Z",
    });
    expect(reminderRetryDecision({ attempts: 3, retryUntil: "2026-10-01T13:01:00.000Z" }, now)).toEqual({
      outcome: "retry",
      retryAt: "2026-10-01T13:01:00.000Z",
    });
    expect(reminderRetryDecision({ attempts: 6, retryUntil: "2026-10-01T13:00:00.000Z" }, now)).toEqual({ outcome: "delivered-in-app" });
  });
});

describe("a reminder's date in another year", () => {
  const now = new Date("2026-11-05T09:00:00.000Z");
  it("says its year, and only then", () => {
    expect(formatReminderTime(new Date("2028-08-27T08:00:00.000Z"), "Europe/London", now)).toBe("Sun 27 Aug 2028 09:00");
    expect(formatReminderTime(new Date("2026-12-01T09:00:00.000Z"), "Europe/London", now)).toBe("Tue 1 Dec 09:00");
    expect(reminderReadBack({ when: { kind: "once", at: "2028-08-27T08:00:00.000Z" }, timezone: "Europe/London" }, now)).toBe(
      "Sun 27 Aug 2028 09:00 Europe/London; I'll remind you then",
    );
  });
});
