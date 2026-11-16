import { describe, expect, it } from "vitest";

import { TaviError } from "../src/errors.js";
import { reminderFireDisposition } from "../src/reminders.js";
import { RoutineTriggerSchema, routineCadenceLookback, routineDeliveryWindowNotice, routineTriggerNext } from "../src/routines.js";
import {
  MISSED_RUN_GRACE_MS,
  ON_TIME_TOLERANCE_MS,
  fireDisposition,
  instantForLocalTime,
  localDateTime,
  shiftLocalDate,
} from "../src/schedule-time.js";
import {
  ScheduleSpecSchema,
  nextOccurrence,
  parseScheduleWindow,
  scheduleFinished,
  schedulePausedText,
  scheduleSpecText,
  scheduleWatchSentence,
  type ScheduleSpec,
} from "../src/schedules.js";

/**
 * One cadence engine: schedules, routine triggers, reminders and the agenda
 * all read `reminderOccurrenceSeries`. Every shape a schedule could be stored
 * in before it (a time, a zone, a weekday mask) must fire at the same instants
 * through it, which the oracle below — the calculator schedules had of their
 * own, kept verbatim — holds it to.
 */

/** The trigger calculator schedules used before they shared the reminders' engine. */
function oracleNextOccurrence(
  spec: { readonly at: string; readonly timezone: string; readonly daysOfWeek?: readonly number[] },
  after: Date,
): Date {
  const [hour, minute] = spec.at.split(":").map((part) => Number.parseInt(part, 10)) as [number, number];
  const start = localDateTime(after, spec.timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = shiftLocalDate(start, offset);
    if (spec.daysOfWeek !== undefined && !spec.daysOfWeek.includes(date.weekday)) continue;
    const candidate = instantForLocalTime({ ...date, hour, minute }, spec.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`no next occurrence for ${spec.at} ${spec.timezone}`);
}

/** A small seeded generator, so a failing case is the same case on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ZONES = [
  "UTC",
  "Europe/Sofia",
  "Europe/Berlin",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "America/St_Johns",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "Australia/Lord_Howe",
  "Australia/Sydney",
  "Asia/Kolkata",
  "Asia/Tehran",
  "Africa/Casablanca",
] as const;
/** Times on and around the hours clocks change at, and ordinary ones. */
const TIMES = [
  "00:00",
  "00:30",
  "01:00",
  "01:30",
  "02:00",
  "02:15",
  "02:30",
  "03:00",
  "03:30",
  "04:00",
  "07:00",
  "12:00",
  "23:30",
  "23:59",
];
const MASKS: readonly (readonly number[] | undefined)[] = [undefined, [1, 2, 3, 4, 5], [0, 6], [3], [0], [1, 3, 5], [0, 1, 2, 3, 4, 5, 6]];
/** Weeks with a clock change somewhere among the zones, and ordinary ones. */
const WINDOWS = [
  "2026-03-06",
  "2026-03-27",
  "2026-04-03",
  "2026-09-04",
  "2026-09-25",
  "2026-10-23",
  "2026-10-30",
  "2027-01-15",
  "2027-06-10",
];

describe("one cadence engine", () => {
  it("fires every shape stored before it at the same instants as the calculator it replaced, in many zones and across clock changes", () => {
    const random = seeded(20261028);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    let compared = 0;
    for (let index = 0; index < 240; index += 1) {
      const spec: ScheduleSpec = {
        at: pick(TIMES),
        timezone: pick(ZONES),
        ...(() => {
          const mask = pick(MASKS);
          return mask === undefined ? {} : { daysOfWeek: [...mask] };
        })(),
      };
      expect(ScheduleSpecSchema.safeParse(spec).success).toBe(true);
      const start = Date.parse(`${pick(WINDOWS)}T00:00:00.000Z`) + Math.floor(random() * 9 * 86_400_000);
      let after = new Date(start);
      for (let step = 0; step < 12; step += 1) {
        const expected = oracleNextOccurrence(
          { at: spec.at as string, timezone: spec.timezone, ...(spec.daysOfWeek === undefined ? {} : { daysOfWeek: spec.daysOfWeek }) },
          after,
        );
        const actual = nextOccurrence(spec, after);
        expect(actual?.toISOString(), `${JSON.stringify(spec)} after ${after.toISOString()}`).toBe(expected.toISOString());
        after = expected;
        compared += 1;
      }
    }
    expect(compared).toBe(240 * 12);
  });

  it("fires several times a day, each once, and two times one gap swallows as one", () => {
    const spec: ScheduleSpec = { times: ["19:00", "07:00"], timezone: "Europe/Sofia" };
    const first = nextOccurrence(spec, new Date("2026-01-14T12:00:00.000Z"));
    expect(first?.toISOString()).toBe("2026-01-14T17:00:00.000Z");
    expect(nextOccurrence(spec, first as Date)?.toISOString()).toBe("2026-01-15T05:00:00.000Z");
    // New York skips 02:00–02:59 on 2026-03-08: 02:15 and 02:45 are both 03:00 EDT, one fire.
    const gap: ScheduleSpec = { times: ["02:15", "02:45"], timezone: "America/New_York" };
    const inGap = nextOccurrence(gap, new Date("2026-03-07T12:00:00.000Z"));
    expect(inGap?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(nextOccurrence(gap, inGap as Date)?.toISOString()).toBe("2026-03-09T06:15:00.000Z");
  });

  it("steps every few hours through its window by the wall clock, the day the clocks change too", () => {
    const series = (spec: ScheduleSpec, from: string, count: number) => {
      const fires: string[] = [];
      let after = new Date(from);
      for (let index = 0; index < count; index += 1) {
        const next = nextOccurrence(spec, after);
        if (next === undefined) break;
        fires.push(next.toISOString());
        after = next;
      }
      return fires;
    };
    const workday: ScheduleSpec = { everyHours: 4, between: { from: "08:00", to: "18:00" }, timezone: "UTC", daysOfWeek: [1, 2, 3, 4, 5] };
    // Friday 2026-10-30, then Monday.
    expect(series(workday, "2026-10-30T00:00:00.000Z", 4)).toEqual([
      "2026-10-30T08:00:00.000Z",
      "2026-10-30T12:00:00.000Z",
      "2026-10-30T16:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
    ]);
    // New York repeats 01:00–01:59 on 2026-11-01: 01:00 is its first reading; 02:00 is EST.
    expect(
      series({ everyHours: 1, between: { from: "00:00", to: "03:00" }, timezone: "America/New_York" }, "2026-11-01T03:00:00.000Z", 4),
    ).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
    // No window: from midnight through the day.
    expect(series({ everyHours: 12, timezone: "UTC" }, "2026-10-30T00:00:00.000Z", 3)).toEqual([
      "2026-10-30T12:00:00.000Z",
      "2026-10-31T00:00:00.000Z",
      "2026-10-31T12:00:00.000Z",
    ]);
  });

  it("fires monthly on a day or an nth weekday, and yearly on a date a short year lacks on its last day", () => {
    const at = (spec: ScheduleSpec, after: string) => nextOccurrence(spec, new Date(after))?.toISOString();
    expect(at({ at: "09:00", timezone: "UTC", monthly: { dayOfMonth: 31 } }, "2027-02-01T00:00:00.000Z")).toBe("2027-02-28T09:00:00.000Z");
    expect(at({ at: "09:00", timezone: "UTC", monthly: { nth: -1, weekday: 5 } }, "2026-10-01T00:00:00.000Z")).toBe(
      "2026-10-30T09:00:00.000Z",
    );
    expect(at({ at: "09:00", timezone: "UTC", monthly: { nth: 2, weekday: 2 } }, "2026-10-14T00:00:00.000Z")).toBe(
      "2026-11-10T09:00:00.000Z",
    );
    expect(at({ at: "09:00", timezone: "Europe/Sofia", yearly: { month: 2, day: 29 } }, "2026-03-01T00:00:00.000Z")).toBe(
      "2027-02-28T07:00:00.000Z",
    );
    expect(at({ at: "09:00", timezone: "Europe/Sofia", yearly: { month: 2, day: 29 } }, "2027-03-01T00:00:00.000Z")).toBe(
      "2028-02-29T07:00:00.000Z",
    );
  });

  it("ends a once date and an until date: nothing after the last run, and a finished schedule says so", () => {
    const once: ScheduleSpec = { times: ["09:00", "17:00"], timezone: "Europe/Berlin", once: "2026-11-05" };
    expect(nextOccurrence(once, new Date("2026-10-28T12:00:00.000Z"))?.toISOString()).toBe("2026-11-05T08:00:00.000Z");
    expect(nextOccurrence(once, new Date("2026-11-05T08:00:00.000Z"))?.toISOString()).toBe("2026-11-05T16:00:00.000Z");
    expect(nextOccurrence(once, new Date("2026-11-05T16:00:00.000Z"))).toBeUndefined();
    const until: ScheduleSpec = { at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1], until: "2026-11-02" };
    expect(nextOccurrence(until, new Date("2026-10-28T12:00:00.000Z"))?.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(nextOccurrence(until, new Date("2026-11-02T05:00:00.000Z"))).toBeUndefined();
    expect(scheduleFinished(until, new Date("2026-11-02T05:00:00.000Z"))).toBe(true);
    expect(scheduleFinished(until, new Date("2026-10-28T12:00:00.000Z"))).toBe(false);
    expect(schedulePausedText({ enabled: false, spec: until }, new Date("2026-11-03T00:00:00.000Z"))).toMatch(/^finished/);
    expect(schedulePausedText({ enabled: false, spec: until }, new Date("2026-10-28T00:00:00.000Z"))).toBe("paused");
    // A spec that goes on is never finished, whatever its state.
    expect(scheduleFinished({ at: "07:00", timezone: "UTC" }, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("refuses an unknown zone as the operator's input", () => {
    try {
      nextOccurrence({ at: "07:00", timezone: "Europe/Sofija" }, new Date("2026-01-14T12:00:00.000Z"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TaviError);
      expect((error as TaviError).code).toBe("INVALID_INPUT");
    }
  });
});

describe("a schedule's spec", () => {
  it("reads every row stored before the new shapes, a repeated day included", () => {
    for (const stored of [
      { at: "07:00", timezone: "Europe/Sofia" },
      { at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1, 2, 3, 4, 5] },
      { at: "21:00", timezone: "Europe/Berlin", daysOfWeek: [1, 1] },
    ]) {
      expect(ScheduleSpecSchema.parse(stored)).toEqual(stored);
    }
  });

  it("is one cadence: one way to say the times, one day pattern, and no end on a once", () => {
    const problems = (spec: Record<string, unknown>) => {
      const parsed = ScheduleSpecSchema.safeParse({ timezone: "UTC", ...spec });
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
    };
    expect(problems({ at: "07:00", times: ["08:00", "09:00"] })).toEqual(["at"]);
    expect(problems({})).toEqual(["at"]);
    expect(problems({ times: ["07:00", "07:00"] })).toEqual(["times"]);
    expect(problems({ at: "07:00", between: { from: "08:00", to: "18:00" } })).toEqual(["between"]);
    expect(problems({ everyHours: 2, between: { from: "18:00", to: "08:00" } })).toEqual(["between"]);
    expect(problems({ at: "07:00", daysOfWeek: [1], monthly: { dayOfMonth: 1 } })).toEqual(["monthly"]);
    expect(problems({ at: "07:00", once: "2026-11-05", until: "2026-11-06" })).toEqual(["until"]);
    expect(problems({ at: "07:00", yearly: { month: 4, day: 31 } })).toEqual(["yearly"]);
    expect(problems({ everyHours: 0 })).not.toEqual([]);
    expect(problems({ everyHours: 13 })).not.toEqual([]);
    expect(problems({ times: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] })).not.toEqual([]);
    expect(
      problems({ everyHours: 3, between: { from: "08:00", to: "17:00" }, monthly: { nth: -1, weekday: 5 }, until: "2027-01-01" }),
    ).toEqual([]);
  });

  it("says when it runs as it said before for the shapes it had, and the new ones alike", () => {
    expect(scheduleSpecText({ at: "07:00", timezone: "Europe/Sofia" })).toBe("every day at 07:00 (Europe/Sofia)");
    expect(scheduleSpecText({ at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1, 2, 3, 4, 5] })).toBe(
      "every Mon–Fri at 07:00 (Europe/Sofia)",
    );
    expect(scheduleSpecText({ at: "21:00", timezone: "Europe/Berlin" }, "label")).toBe("Daily 21:00 · Europe/Berlin");
    expect(scheduleSpecText({ at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] }, "label")).toBe(
      "Mon–Fri 07:00 · Europe/Berlin",
    );
    expect(scheduleSpecText({ times: ["07:00", "12:00", "19:00"], timezone: "UTC", until: "2026-12-31" })).toBe(
      "every day at 07:00, 12:00 and 19:00 (UTC) until 2026-12-31",
    );
    expect(scheduleSpecText({ everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC", daysOfWeek: [1, 2, 3, 4, 5] })).toBe(
      "every Mon–Fri, every 2 hours from 08:00 to 18:00 (UTC)",
    );
    expect(scheduleSpecText({ everyHours: 1, timezone: "UTC" }, "label")).toBe("Daily hourly 00:00–23:59 · UTC");
    expect(scheduleSpecText({ at: "09:00", timezone: "UTC", monthly: { dayOfMonth: 1 } }, "label")).toBe("Monthly on the 1st, 09:00 · UTC");
    expect(scheduleSpecText({ at: "09:00", timezone: "UTC", yearly: { month: 12, day: 25 } })).toBe("every year on 25 Dec at 09:00 (UTC)");
    expect(scheduleSpecText({ at: "09:00", timezone: "UTC", once: "2026-11-05" }, "label")).toBe("Once on 2026-11-05, 09:00 · UTC");
  });
});

describe("a routine's triggers", () => {
  it("take every recurring shape a schedule has, but a once date, which is a one-off trigger", () => {
    const daily = { id: "t", kind: "daily", timezone: "Europe/Sofia" };
    for (const shape of [
      { at: "07:00" },
      { times: ["07:00", "19:00"], daysOfWeek: [1, 2, 3, 4, 5] },
      { everyHours: 4, between: { from: "08:00", to: "20:00" } },
      { at: "09:00", monthly: { nth: 1, weekday: 1 }, until: "2027-06-30" },
      { at: "09:00", yearly: { month: 3, day: 1 } },
    ]) {
      expect(RoutineTriggerSchema.safeParse({ ...daily, ...shape }).success, JSON.stringify(shape)).toBe(true);
    }
    expect(RoutineTriggerSchema.safeParse({ ...daily, at: "07:00", once: "2026-11-05" }).success).toBe(false);
    expect(RoutineTriggerSchema.safeParse({ ...daily, at: "07:00", times: ["08:00"] }).success).toBe(false);
    expect(RoutineTriggerSchema.safeParse({ ...daily, at: "07:00", timezone: "Europe/Sofija" }).success).toBe(false);
  });

  it("fire through the same engine: a recurring one's next run, a one-off's time, and none once either has ended", () => {
    const now = new Date("2026-10-28T12:00:00.000Z");
    expect(routineTriggerNext({ id: "t", kind: "daily", times: ["07:00", "19:00"], timezone: "Europe/Sofia" }, now)).toBe(
      "2026-10-28T17:00:00.000Z",
    );
    expect(routineTriggerNext({ id: "t", kind: "daily", at: "07:00", timezone: "Europe/Sofia", until: "2026-10-28" }, now)).toBeNull();
    expect(routineTriggerNext({ id: "o", kind: "once", runAt: "2026-10-29T08:00:00.000Z" }, now)).toBe("2026-10-29T08:00:00.000Z");
    expect(routineTriggerNext({ id: "o", kind: "once", runAt: "2026-10-27T08:00:00.000Z" }, now)).toBeNull();
  });
});

describe("a routine's report window", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  it("covers the time between runs: a day for a daily routine, the week for a weekly one", () => {
    expect(routineCadenceLookback([{ id: "d", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }], now)).toEqual({
      lookbackHours: 24,
      widenLookbackMaxHours: 72,
    });
    // Once a week: 168 hours, widening a day past it, so a weekly run reads its week rather than reporting a gap.
    expect(routineCadenceLookback([{ id: "w", kind: "daily", at: "09:00", daysOfWeek: [1], timezone: "Europe/Sofia" }], now)).toEqual({
      lookbackHours: 168,
      widenLookbackMaxHours: 192,
    });
  });

  it("keeps the day for one-off triggers, and never passes the ceiling", () => {
    expect(routineCadenceLookback([{ id: "o", kind: "once", runAt: "2026-10-29T08:00:00.000Z" }], now)).toEqual({
      lookbackHours: 24,
      widenLookbackMaxHours: 72,
    });
    const monthly = routineCadenceLookback(
      [{ id: "m", kind: "daily", at: "09:00", monthly: { nth: 1, weekday: 1 }, timezone: "UTC" }],
      now,
    );
    expect(monthly).toEqual({ lookbackHours: 192, widenLookbackMaxHours: 192 });
  });
});

describe("how late a fire is", () => {
  it("is judged alike for schedules and reminders, a reminder six hours late being missed where a schedule's fire still runs", () => {
    expect(fireDisposition(ON_TIME_TOLERANCE_MS)).toBe("on-time");
    expect(fireDisposition(ON_TIME_TOLERANCE_MS + 1)).toBe("late");
    expect(fireDisposition(MISSED_RUN_GRACE_MS)).toBe("late");
    expect(fireDisposition(MISSED_RUN_GRACE_MS + 1)).toBe("missed");
    expect(reminderFireDisposition(ON_TIME_TOLERANCE_MS)).toBe("on-time");
    expect(reminderFireDisposition(MISSED_RUN_GRACE_MS - 1)).toBe("late");
    expect(reminderFireDisposition(MISSED_RUN_GRACE_MS)).toBe("missed");
  });
});

describe("an everyHours window as typed", () => {
  it("reads two wall-clock times, and nothing else", () => {
    expect(parseScheduleWindow(" 08:00-18:00 ")).toEqual({ from: "08:00", to: "18:00" });
    for (const text of ["8-18", "25:00-26:00", "08:00-18:60", "08:00", "08:00-12:00-18:00", "08:00 - 18:00"])
      expect(parseScheduleWindow(text)).toBeUndefined();
  });
});

describe("a trigger outside the delivery window", () => {
  const delivery = {
    targetIds: ["chat"],
    format: "pdf" as const,
    allowResend: false,
    window: { start: "09:00", end: "18:00", timezone: "UTC" },
    outsideWindow: "in_app_only" as const,
    expiryHours: 24,
  };
  const at = new Date("2026-10-28T12:00:00.000Z");

  it("is named by its time when one run is outside, and by its cadence when several are", () => {
    const early = { id: "early", kind: "daily" as const, at: "07:00", timezone: "UTC" };
    const hourly = { id: "hourly", kind: "daily" as const, everyHours: 1, timezone: "UTC" };
    expect(routineDeliveryWindowNotice({ triggers: [early], delivery }, at)).toMatch(
      /^The trigger at 07:00 is outside the delivery window/,
    );
    expect(routineDeliveryWindowNotice({ triggers: [hourly], delivery }, at)).toMatch(
      /^The trigger Daily hourly 00:00–23:59 · UTC has runs outside the delivery window \(09:00–18:00 UTC\)/,
    );
    expect(routineDeliveryWindowNotice({ triggers: [early, hourly], delivery }, at)).toMatch(
      /^The triggers at 07:00, Daily hourly 00:00–23:59 · UTC have runs outside/,
    );
  });
});

describe("a watcher in words", () => {
  it("says what it watches, how often, and that it runs only on a change; a file also soon after it changes", () => {
    const every = { everyHours: 1, timezone: "UTC" };
    expect(scheduleWatchSentence({ spec: every, precheck: { kind: "page-changed", target: "https://example.com/" } })).toBe(
      "watches the page https://example.com/ every hour; runs only when it changes",
    );
    expect(
      scheduleWatchSentence({
        spec: { everyHours: 3, between: { from: "08:00", to: "20:00" }, timezone: "UTC" },
        precheck: { kind: "feed-has-new", target: "https://example.com/feed.xml" },
      }),
    ).toBe("watches the feed https://example.com/feed.xml every 3 hours from 08:00 to 20:00; runs only when it has new items");
    expect(scheduleWatchSentence({ spec: { at: "07:00", timezone: "UTC" }, precheck: { kind: "file-changed", target: "/notes.md" } })).toBe(
      "watches the file /notes.md at 07:00, and soon after it changes while tavi serve runs; runs only when it changes",
    );
    expect(scheduleWatchSentence({ spec: every })).toBeUndefined();
  });
});
