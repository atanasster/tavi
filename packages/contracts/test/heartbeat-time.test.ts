import { describe, expect, it } from "vitest";

import { defaultHeartbeatConfig, type HeartbeatConfig } from "../src/heartbeat.js";
import {
  heartbeatJitterMs,
  heartbeatWindowAt,
  nextHeartbeatAt,
  nextHeartbeatWindow,
  previousHeartbeatWindow,
} from "../src/heartbeat-time.js";
import { localDateTime } from "../src/schedule-time.js";

/** When a heartbeat ticks. */

const MINUTE = 60_000;
const config = (overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig => ({ ...defaultHeartbeatConfig(), ...overrides });
const at = (iso: string): Date => new Date(iso);
const minutesOfDay = (instant: Date, timezone: string): number => {
  const local = localDateTime(instant, timezone);
  return local.hour * 60 + local.minute;
};

/** A deterministic stream of instants across a year, for the property checks. */
function* instants(count: number, seed = 7): Generator<Date> {
  let state = seed;
  const start = Date.UTC(2026, 0, 1);
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    yield new Date(start + (state % (366 * 24 * 60)) * MINUTE);
  }
}

describe("the jitter", () => {
  it("is fixed per principal, at most 10% of the interval and at most 3 minutes", () => {
    expect(heartbeatJitterMs(30 * MINUTE, "operator")).toBe(heartbeatJitterMs(30 * MINUTE, "operator"));
    for (const seed of ["a", "b", "operator", "someone-else"]) {
      expect(heartbeatJitterMs(30 * MINUTE, seed)).toBeLessThanOrEqual(3 * MINUTE);
      expect(heartbeatJitterMs(10 * MINUTE, seed)).toBeLessThanOrEqual(MINUTE);
      expect(heartbeatJitterMs(2_000, seed)).toBeLessThanOrEqual(200);
    }
  });

  it("spreads principals apart, and is zero for an interval under 10 ms", () => {
    const spread = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => heartbeatJitterMs(30 * MINUTE, seed)));
    expect(spread.size).toBeGreaterThan(4);
    expect(heartbeatJitterMs(9, "operator")).toBe(0);
  });
});

describe("the active window", () => {
  it("contains instants inside the hours and none outside", () => {
    const hours = config();
    expect(heartbeatWindowAt(hours, "Europe/Sofia", at("2026-10-10T06:00:00.000Z"))).toBeDefined(); // 09:00 Sofia
    expect(heartbeatWindowAt(hours, "Europe/Sofia", at("2026-10-10T20:30:00.000Z"))).toBeUndefined(); // 23:30 Sofia
  });

  it("crosses midnight: 22:00–02:00 holds 23:30 and 01:30, not 03:00", () => {
    const night = config({ activeHours: { start: "22:00", end: "02:00" } });
    const window = heartbeatWindowAt(night, "UTC", at("2026-10-11T01:30:00.000Z"));
    expect(window?.start.toISOString()).toBe("2026-10-10T22:00:00.000Z");
    expect(window?.end.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(heartbeatWindowAt(night, "UTC", at("2026-10-10T23:30:00.000Z"))).toBeDefined();
    expect(heartbeatWindowAt(night, "UTC", at("2026-10-11T03:00:00.000Z"))).toBeUndefined();
  });

  it("honours the day mask by the day a window starts", () => {
    const weekdays = config({ daysOfWeek: [1, 2, 3, 4, 5] });
    // 2026-10-10 is a Saturday: the next window is Monday's.
    expect(heartbeatWindowAt(weekdays, "UTC", at("2026-10-10T10:00:00.000Z"))).toBeUndefined();
    expect(nextHeartbeatWindow(weekdays, "UTC", at("2026-10-10T10:00:00.000Z")).start.toISOString()).toBe("2026-10-12T08:00:00.000Z");
    // Monday's window: the one before it was Friday's.
    expect(previousHeartbeatWindow(weekdays, "UTC", at("2026-10-12T08:00:00.000Z"))?.start.toISOString()).toBe("2026-10-09T08:00:00.000Z");
    // A window that crosses midnight: the one before tonight's began last night.
    expect(
      previousHeartbeatWindow(
        config({ activeHours: { start: "22:00", end: "02:00" } }),
        "UTC",
        at("2026-10-12T22:00:00.000Z"),
      )?.start.toISOString(),
    ).toBe("2026-10-11T22:00:00.000Z");
    // Across a DST change (Europe/Sofia moves back on 25 Oct 2026): the day before's 08:00 local, an hour apart in UTC.
    expect(previousHeartbeatWindow(config({}), "Europe/Sofia", at("2026-10-26T06:00:00.000Z"))?.start.toISOString()).toBe(
      "2026-10-25T06:00:00.000Z",
    );
  });
});

describe("the next tick", () => {
  it("is anchored to the window's start, spaced by the interval, plus the jitter", () => {
    const jitter = heartbeatJitterMs(30 * MINUTE, "operator");
    const next = nextHeartbeatAt(config(), "UTC", at("2026-10-10T08:10:00.000Z"), "operator");
    expect(next.getTime()).toBe(Date.parse("2026-10-10T08:30:00.000Z") + jitter);
  });

  it("moves to the next window's start after the last tick of the day", () => {
    const jitter = heartbeatJitterMs(30 * MINUTE, "operator");
    const next = nextHeartbeatAt(config(), "UTC", at("2026-10-10T21:59:00.000Z"), "operator");
    expect(next.getTime()).toBe(Date.parse("2026-10-11T08:00:00.000Z") + jitter);
  });

  it("follows the timezone: the same instant ticks at each zone's own window", () => {
    const now = at("2026-10-10T05:00:00.000Z"); // 08:00 in Sofia (UTC+3), before 08:00 UTC
    const jitter = heartbeatJitterMs(30 * MINUTE, "p");
    expect(nextHeartbeatAt(config(), "Europe/Sofia", now, "p").getTime()).toBe(Date.parse("2026-10-10T05:00:00.000Z") + jitter);
    expect(nextHeartbeatAt(config(), "UTC", now, "p").getTime()).toBe(Date.parse("2026-10-10T08:00:00.000Z") + jitter);
  });

  it("ticks every 2 s under a test floor", () => {
    const fast = config({ everyMs: 2_000, activeHours: { start: "00:00", end: "23:59" } });
    const first = nextHeartbeatAt(fast, "UTC", at("2026-10-10T10:00:00.000Z"), "p");
    const second = nextHeartbeatAt(fast, "UTC", first, "p");
    expect(second.getTime() - first.getTime()).toBe(2_000);
  });

  it("is always strictly later, inside active hours, and no further than one interval inside a window — across DST", () => {
    for (const timezone of ["Europe/Sofia", "America/New_York", "Australia/Sydney", "UTC"]) {
      for (const hours of [
        config(),
        config({ activeHours: { start: "22:00", end: "02:00" } }),
        config({ everyMs: 60 * MINUTE, daysOfWeek: [0, 6] }),
      ]) {
        for (const now of instants(100)) {
          const next = nextHeartbeatAt(hours, timezone, now, "operator");
          expect(next.getTime()).toBeGreaterThan(now.getTime());
          expect(heartbeatWindowAt(hours, timezone, next)).toBeDefined();
          const window = heartbeatWindowAt(hours, timezone, now);
          if (window !== undefined && next.getTime() < window.end.getTime()) {
            expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(hours.everyMs);
          }
        }
      }
    }
  }, 20_000);

  it("spaces ticks by the interval in real time on the day the clocks change", () => {
    // Sofia leaves summer time at 04:00 local on 2026-10-25, before the 08:00 window opens.
    const day = config({ activeHours: { start: "00:00", end: "06:00" }, everyMs: 60 * MINUTE });
    let tick = nextHeartbeatAt(day, "Europe/Sofia", at("2026-10-24T20:00:00.000Z"), "p");
    const ticks = [tick];
    for (let index = 0; index < 5; index += 1) {
      tick = nextHeartbeatAt(day, "Europe/Sofia", tick, "p");
      ticks.push(tick);
    }
    const gaps = ticks.slice(1).map((next, index) => next.getTime() - (ticks[index]?.getTime() ?? 0));
    expect(gaps.every((gap) => gap === 60 * MINUTE)).toBe(true);
  });

  it("handles a window crossing a spring-forward night, and skips a window the clocks skip", () => {
    // New York springs forward at 02:00 on 2026-03-08: 22:00–02:00 ends at 03:00 EDT, four real hours later.
    const night = nextHeartbeatWindow(
      config({ activeHours: { start: "22:00", end: "02:00" } }),
      "America/New_York",
      at("2026-03-07T12:00:00.000Z"),
    );
    expect(night.start.toISOString()).toBe("2026-03-08T03:00:00.000Z");
    expect(night.end.getTime() - night.start.getTime()).toBe(4 * 60 * MINUTE);
    // 02:30–03:00 does not exist that night: the next window is the following day's.
    const skipped = nextHeartbeatWindow(
      config({ activeHours: { start: "02:30", end: "03:00" } }),
      "America/New_York",
      at("2026-03-08T05:00:00.000Z"),
    );
    expect(skipped.start.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("keeps 08:00 local on both sides of a DST change", () => {
    // Sofia leaves summer time on 2026-10-25.
    for (const day of ["2026-10-24T12:00:00.000Z", "2026-10-26T12:00:00.000Z"]) {
      const window = nextHeartbeatWindow(config(), "Europe/Sofia", at(day));
      expect(minutesOfDay(window.start, "Europe/Sofia")).toBe(8 * 60);
      expect(minutesOfDay(window.end, "Europe/Sofia")).toBe(22 * 60);
    }
  });
});
