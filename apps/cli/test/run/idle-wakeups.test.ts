import { setTimeout as realDelay } from "node:timers/promises";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHealthWatch } from "../../src/features/doctor/health.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntimeOptions, TaviRuntimeOverrides } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * How often an idle owner wakes, with every background loop `serve` starts
 * and no UI tab open: each worker call and each timer callback is a wakeup a
 * laptop pays for. Measured over ten minutes of a faked clock, after the
 * start-up sweeps, as database wakeups (seconds in which any call was made),
 * worker calls, and timer callbacks (each `setTimeout`/`setInterval` callback
 * the process ran).
 *
 * The same owner with the timers it had before event-driven wakeups — every
 * sweep each 30 s, task summaries each 5 s, the heartbeat's need poll and the
 * memory jobs each minute, ungated, each on a timer of its own — is measured
 * beside it for comparison. When this landed the idle owner made 0.4 database
 * wakeups, 3.5 calls and 1 timer callback a minute (2 with a deadline planned)
 * against 12 wakeups, 53 calls and 26 timer callbacks with the old timers.
 */

const directories = temporaryDirectories({ prefix: "tavi-idle-wakeups-" });
afterEach(() => {
  vi.useRealTimers();
  directories.cleanup();
});

/** Lets the worker answer what the timers just asked: real time, not the faked clock. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await realDelay(5);
}

const SERVE_LOOPS: Partial<TaviRuntimeOptions> = {
  reminderSweepEnabled: true,
  heartbeatEnabled: true,
  ideasEnabled: true,
  memoryHostEnabled: true,
  workerResultSweepEnabled: true,
  grantSweepEnabled: true,
  taskSummariesEnabled: true,
  scheduleWatchersEnabled: true,
};

interface IdleCost {
  /** Seconds a minute in which the owner called its database worker. */
  readonly wakeups: number;
  /** Worker calls a minute. */
  readonly operations: number;
  /** Timer callbacks a minute. */
  readonly timers: number;
  readonly top: string;
}

/**
 * Fakes the timers, counting each callback the faked `setTimeout` and `setInterval` run while `counting()`; answers
 * the count and the restore.
 */
function countTimerCallbacks(counting: () => boolean): { readonly fired: () => number; readonly restore: () => void } {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const faked = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
  let fired = 0;
  const counted =
    (arm: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown) =>
    (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      arm(
        (...passed: unknown[]) => {
          if (counting()) fired += 1;
          callback(...passed);
        },
        ms,
        ...args,
      );
  globalThis.setTimeout = counted(faked.setTimeout as never) as unknown as typeof setTimeout;
  globalThis.setInterval = counted(faked.setInterval as never) as unknown as typeof setInterval;
  return {
    fired: () => fired,
    restore: () => {
      globalThis.setTimeout = faked.setTimeout;
      globalThis.setInterval = faked.setInterval;
    },
  };
}

async function measureIdle(
  options: Partial<TaviRuntimeOptions>,
  overrides: TaviRuntimeOverrides = {},
  idleSetup?: (runtime: Awaited<ReturnType<typeof composeTaviRuntime>>) => Promise<void>,
): Promise<IdleCost> {
  let counting = false;
  const timers = countTimerCallbacks(() => counting);
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create(), { ...SERVE_LOOPS, ...options }), {
    modelOverride: createFixtureModel({ turns: [] }),
    ...overrides,
  });
  // `serve`'s own sampling of itself, on the owner's timer as `serve` starts it.
  const serving = new AbortController();
  createHealthWatch({
    every: runtime.every,
    sample: async () => ({ at: new Date().toISOString(), rssBytes: 1, children: 0 }),
  }).start(serving.signal);
  try {
    await idleSetup?.(runtime);
    // Past start: every first sweep and catch-up has run.
    for (let second = 0; second < 120; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
    }
    runtime.store.resetOperationCounts();
    counting = true;
    let wakeups = 0;
    for (let second = 0; second < 600; second += 1) {
      const before = runtime.store.operationCounts().total;
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      if (runtime.store.operationCounts().total > before) wakeups += 1;
    }
    counting = false;
    const counts = runtime.store.operationCounts();
    const top = Object.entries(counts.byOperation)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([operation, count]) => `${operation}=${count}`)
      .join(", ");
    return { wakeups: wakeups / 10, operations: counts.total / 10, timers: timers.fired() / 10, top };
  } finally {
    serving.abort();
    timers.restore();
    vi.useRealTimers();
    await runtime.close();
  }
}

describe("idle wakeups", () => {
  it("an idle owner calls its database and runs a timer about once a minute, not every few seconds", async () => {
    const idle = await measureIdle({});
    const timers = await measureIdle(
      { reminderSweepIntervalMs: 30_000, agentWaitSweepIntervalMs: 30_000, scheduleSweepIntervalMs: 30_000, taskSummaryIntervalMs: 5_000 },
      { heartbeatTiming: { sweepMs: 30_000, needPollMs: 60_000 }, memoryTiming: { tickMs: 60_000 } },
    );
    console.info(
      `idle wakeups a minute: ${idle.wakeups} (${idle.operations} worker calls, ${idle.timers} timer callbacks; ${idle.top}); ` +
        `with the old timers ${timers.wakeups} (${timers.operations} worker calls, ${timers.timers} timer callbacks)`,
    );
    expect(idle.wakeups).toBeLessThanOrEqual(1);
    expect(idle.operations).toBeLessThanOrEqual(6);
    expect(idle.timers).toBeLessThanOrEqual(2);
    expect(timers.operations).toBeGreaterThan(idle.operations * 5);
    expect(timers.timers).toBeGreaterThan(idle.timers * 3);
  }, 180_000);

  it("wakes at most twice a minute with a deadline planned, where the clock is compared on its grid", async () => {
    // A reminder tomorrow: nothing falls due in the window, but the planner holds a deadline, so its timer compares
    // the wall clock with it on the grid that bounds how late due work is after the machine sleeps.
    const idle = await measureIdle({}, {}, async (runtime) => {
      await runtime.store.asPort().repositories.reminders.create({
        reminderId: "rem-tomorrow",
        workspaceId: "default",
        principalId: "operator",
        text: "Water the plants",
        when: { kind: "once", at: new Date(Date.now() + 24 * 3_600_000).toISOString() },
        timezone: "UTC",
        deliverTo: { kind: "app" },
        createdBy: "user",
        operationKey: "op-tomorrow",
        now: new Date().toISOString(),
      });
    });
    console.info(`idle with a deadline planned: ${idle.timers} timer callbacks, ${idle.operations} worker calls a minute`);
    expect(idle.timers).toBeLessThanOrEqual(2);
    expect(idle.operations).toBeLessThanOrEqual(6);
  }, 180_000);

  it("still fires due work on time: a reminder written while idle is swept at its instant", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create(), SERVE_LOOPS), {
      modelOverride: createFixtureModel({ turns: [] }),
    });
    try {
      for (let second = 0; second < 60; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
      }
      const repositories = runtime.store.asPort().repositories;
      const due = new Date(Date.now() + 90_000).toISOString();
      await repositories.reminders.create({
        reminderId: "rem-idle",
        workspaceId: "default",
        principalId: "operator",
        text: "Stretch",
        when: { kind: "once", at: due },
        timezone: "UTC",
        deliverTo: { kind: "app" },
        createdBy: "user",
        operationKey: "op-idle",
        now: new Date().toISOString(),
      });
      const fired = async () => await repositories.reminders.fires({ workspaceId: "default", reminderId: "rem-idle", limit: 5 });
      for (let second = 0; second < 89; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
      }
      expect(await fired()).toEqual([]);
      for (let second = 0; second < 3; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
      }
      // Within seconds of its instant, where the old 30 s sweep could be half a minute late.
      const [fire] = await fired();
      expect(fire?.fireAt).toBe(due);
      expect(Date.parse(fire?.firedAt ?? "") - Date.parse(due)).toBeLessThanOrEqual(3_000);
    } finally {
      vi.useRealTimers();
      await runtime.close();
    }
  }, 60_000);
});
