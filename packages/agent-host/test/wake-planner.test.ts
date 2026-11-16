import { afterEach, describe, expect, it, vi } from "vitest";

import { createWakePlanner } from "../src/schedulers/sweep-loop.js";

/**
 * The due-work planner, on faked timers: a sweep runs when its stored
 * deadline comes, never twice inside the floor, and the deadlines are read
 * again after a write and after each round — not on a timer.
 */

afterEach(() => {
  vi.useRealTimers();
});

const START = Date.parse("2026-10-01T12:00:00.000Z");
const at = (ms: number): string => new Date(START + ms).toISOString();

function harness(initial: { reminders: string | null; schedules: string | null }) {
  vi.useFakeTimers({ now: START });
  const stored = { ...initial };
  let reads = 0;
  const swept: string[] = [];
  const planner = createWakePlanner<"reminders" | "schedules">({
    deadlines: async () => {
      reads += 1;
      return { ...stored };
    },
    floorMs: 30_000,
    settleMs: 1_000,
    recheckMs: 60_000,
    onError: (error) => {
      throw error;
    },
  });
  return { planner, stored, swept, reads: () => reads };
}

describe("the wake planner", () => {
  it("sweeps when a deadline comes, and reads nothing while idle", async () => {
    const { planner, stored, swept, reads } = harness({ reminders: at(45_000), schedules: null });
    planner.register("reminders", {
      sweep: async () => {
        swept.push("reminders");
        stored.reminders = null;
      },
    });
    planner.register("schedules", { sweep: async () => void swept.push("schedules") });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(swept).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(swept).toEqual(["reminders"]);
    const afterRound = reads();
    // Nothing due and nothing written: an hour passes with no read and no sweep.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(swept).toEqual(["reminders"]);
    expect(reads()).toBe(afterRound);
  });

  it("reads again after a write, and sweeps what the write made due", async () => {
    const { planner, stored, swept, reads } = harness({ reminders: null, schedules: null });
    planner.register("reminders", { sweep: async () => void swept.push("reminders") });
    await vi.advanceTimersByTimeAsync(40_000);
    const before = reads();
    stored.reminders = at(50_000);
    // Writes within the settle window are one read.
    planner.changed();
    planner.changed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(8_999);
    expect(swept).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(swept).toEqual(["reminders"]);
  });

  it("retries a deadline a sweep could not clear at the floor's pace, not in a loop", async () => {
    const { planner, swept } = harness({ reminders: at(0), schedules: null });
    planner.register("reminders", { sweep: async () => void swept.push("reminders") });
    await vi.advanceTimersByTimeAsync(90_000);
    // Its own first sweep ran at registration; then the planner sweeps at 30 s, 60 s and 90 s.
    expect(swept).toEqual(["reminders", "reminders", "reminders"]);
  });

  it("sweeps a busy kind at the floor's pace whatever is stored", async () => {
    const { planner, swept } = harness({ reminders: null, schedules: null });
    let busy = true;
    planner.register("schedules", { sweep: async () => void swept.push("schedules"), busy: () => busy });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(swept).toEqual(["schedules", "schedules"]);
    busy = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(swept).toHaveLength(2);
  });

  it("stops planning a kind once it is unregistered", async () => {
    const { planner, swept } = harness({ reminders: at(10_000), schedules: null });
    const unregister = planner.register("reminders", { sweep: async () => void swept.push("reminders") });
    await unregister();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(swept).toEqual([]);
  });

  it("is held back by at most one floor when the clock is set back", async () => {
    vi.useFakeTimers({ now: START });
    let clock = START;
    const swept: number[] = [];
    const planner = createWakePlanner<"reminders">({
      // Due 20 s after the instant the clock is about to be set back to.
      deadlines: async () => ({ reminders: new Date(START - 60 * 60_000 + 20_000).toISOString() }),
      floorMs: 30_000,
      settleMs: 1_000,
      recheckMs: 30_000,
      now: () => clock,
      onError: (error) => {
        throw error;
      },
    });
    planner.register("reminders", { sweep: async () => void swept.push(clock) });
    // Its last sweep was "now"; then the wall clock goes back an hour.
    clock -= 60 * 60_000;
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      clock += 15_000;
    }
    // Swept a floor after the jump, not an hour later when the clock is back where it was.
    expect(swept).toHaveLength(1);
    expect((swept[0] ?? Number.NaN) - (START - 60 * 60_000)).toBeLessThanOrEqual(45_000);
  });
});

describe("the wake planner's ticks", () => {
  function ticking() {
    vi.useFakeTimers({ now: START });
    let fires = 0;
    const planner = createWakePlanner<"reminders">({
      deadlines: async () => ({ reminders: null }),
      floorMs: 30_000,
      settleMs: 1_000,
      recheckMs: 30_000,
      onError: (error) => {
        throw error;
      },
    });
    // Counts the planner's own timer callbacks: the process wakeups it costs.
    const faked = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms?: number) =>
      faked(() => {
        fires += 1;
        callback();
      }, ms)) as typeof setTimeout;
    return { planner, fires: () => fires, restore: () => void (globalThis.setTimeout = faked) };
  }

  it("runs every periodic tick on one grid, so several cost one wakeup between them", async () => {
    const { planner, fires, restore } = ticking();
    try {
      const ran: { a: number[]; b: number[]; c: number[] } = { a: [], b: [], c: [] };
      planner.every(() => void ran.a.push(Date.now() - START), 60_000);
      await vi.advanceTimersByTimeAsync(7_000);
      planner.every(() => void ran.b.push(Date.now() - START), 60_000);
      await vi.advanceTimersByTimeAsync(11_000);
      planner.every(() => void ran.c.push(Date.now() - START), 10 * 60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 30_000 - 18_000);
      // Each tick runs at the first grid instant once due: never early, never more than a grid step late.
      expect(ran.a).toEqual([60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000, 480_000, 540_000, 600_000]);
      // b's first run is a period after it started, on the grid; then it falls in step with a.
      expect(ran.b.slice(0, 3)).toEqual([90_000, 120_000, 180_000]);
      // Due at 618 s, run at the grid instant after it.
      expect(ran.c).toEqual([630_000]);
      // Over 630 s three ticks wake the process at the ten minute marks, b's first run and c's: not the grid's 21.
      expect(fires()).toBe(12);
    } finally {
      restore();
    }
  });

  it("keeps a callback re-armed as its own work ends in step with the grid, not a step behind", async () => {
    const { planner, fires, restore } = ticking();
    try {
      const ran: number[] = [];
      const again = (): void => {
        ran.push(Date.now() - START);
        // Its work took a moment of wall time before it asks for the next.
        vi.setSystemTime(Date.now() + 200);
        planner.after(again, 60_000);
      };
      planner.after(again, 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(ran.slice(0, 3)).toEqual([60_000, 120_000, 180_000]);
      expect(fires()).toBe(ran.length);
    } finally {
      restore();
    }
  });

  it("with nothing planned and nothing ticking, runs no timer; a one-off callback runs once", async () => {
    const { planner, fires, restore } = ticking();
    try {
      planner.register("reminders", { sweep: async () => {} });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(fires()).toBe(0);
      let called = 0;
      planner.after(() => {
        called += 1;
      }, 45_000);
      const cancelled = planner.after(() => {
        called += 10;
      }, 45_000);
      cancelled();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(called).toBe(1);
      expect(fires()).toBe(1);
      const stop = planner.every(() => {
        called += 1;
      }, 60_000);
      stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(called).toBe(1);
    } finally {
      restore();
    }
  });

  it("while a deadline is planned, compares the clock on the grid, so due work is at most a grid step late after a sleep", async () => {
    vi.useFakeTimers({ now: START });
    let clock = START;
    const swept: number[] = [];
    const planner = createWakePlanner<"reminders">({
      deadlines: async () => ({ reminders: new Date(START + 60 * 60_000).toISOString() }),
      floorMs: 30_000,
      settleMs: 1_000,
      recheckMs: 30_000,
      now: () => clock,
      onError: (error) => {
        throw error;
      },
    });
    planner.register("reminders", { sweep: async () => void swept.push(clock) });
    await vi.advanceTimersByTimeAsync(10_000);
    clock += 10_000;
    // The machine sleeps for two hours: timers stand still, the wall clock does not.
    clock += 2 * 60 * 60_000;
    for (let step = 0; step < 6; step += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      clock += 5_000;
    }
    expect(swept).toHaveLength(1);
    expect((swept[0] ?? Number.NaN) - (START + 10_000 + 2 * 60 * 60_000)).toBeLessThanOrEqual(30_000);
  });
});
