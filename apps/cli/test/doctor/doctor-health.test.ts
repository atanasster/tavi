import { CenterSummaryAnswerSchema } from "@tavi/contracts";
import { MemoryService } from "@tavi/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const handleCount = vi.hoisted(() => vi.fn<() => number | undefined>());
vi.mock("@tavi/node-kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tavi/node-kit")>()),
  processHandleCount: handleCount,
}));

import { EXIT, main } from "../../src/main.js";
import {
  createHealthWatch,
  HEALTH_SAMPLE_INTERVAL_MS,
  healthGrowth,
  sampleHealth,
  type HealthSample,
} from "../../src/features/doctor/health.js";
import { centerCommand } from "../../src/server/center.js";
import { SqliteStore } from "../support/database-fixture.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * The owner's health watch: resident memory, open descriptors and children
 * sampled every 10 minutes into a bounded ring; sustained growth (more than 2x
 * over 6 hours) warned of in `doctor` and on the Command Center; and `doctor`'s
 * quick integrity check, `--deep` for the full one.
 */

const MB = 1024 * 1024;
const start = Date.parse("2026-10-29T00:00:00.000Z");

/** Samples every 10 minutes from `start`, one per entry of `rss` (in MB). */
const series = (rss: readonly number[], extra: Partial<HealthSample> = {}): HealthSample[] =>
  rss.map((value, index) => ({
    at: new Date(start + index * HEALTH_SAMPLE_INTERVAL_MS).toISOString(),
    rssBytes: value * MB,
    openFds: 40,
    children: 1,
    ...extra,
  }));

/** `rss` after an hour of warm-up samples at its first value: the window may not start in the owner's first hour. */
const settled = (rss: readonly number[], extra: Partial<HealthSample> = {}): HealthSample[] =>
  series([...Array.from({ length: 6 }, () => rss[0] ?? 0), ...rss], extra);

describe("healthGrowth", () => {
  it("says nothing before the owner has run 6 hours", () => {
    expect(healthGrowth(series(Array.from({ length: 36 }, () => 1000))).growth).toEqual([]);
    expect(healthGrowth(series([100, 100, 1000, 1000, 1000])).growth).toEqual([]);
  });

  it("warns when memory more than doubled over 6 hours and stayed there", () => {
    // 37 samples after warm-up: the first is exactly 6 hours before the newest.
    const rss = [...Array.from({ length: 34 }, () => 200), 450, 460, 455];
    const { windowStart, growth } = healthGrowth(settled(rss));
    expect(windowStart?.rssBytes).toBe(200 * MB);
    expect(growth).toHaveLength(1);
    expect(growth[0]).toMatchObject({ metric: "rssBytes", from: 200 * MB, to: 450 * MB, factor: 2.3 });
    expect(growth[0]?.warning).toContain("memory (RSS) grew 2.3x in 6 hours (200 MB to 450 MB)");
  });

  it("ignores a spike, growth under 2x, and doubling too small to matter", () => {
    expect(healthGrowth(settled([...Array.from({ length: 35 }, () => 200), 900, 200])).growth).toEqual([]);
    expect(healthGrowth(settled([...Array.from({ length: 34 }, () => 200), 390, 390, 390])).growth).toEqual([]);
    // 10 MB to 30 MB is threefold, but under the 64 MB floor.
    expect(healthGrowth(settled([...Array.from({ length: 34 }, () => 10), 30, 30, 30])).growth).toEqual([]);
    // From one child to three: ordinary (an MCP server started on first use).
    const children = settled(Array.from({ length: 37 }, () => 200)).map((sample, index) => ({ ...sample, children: index < 40 ? 1 : 3 }));
    expect(healthGrowth(children).growth).toEqual([]);
  });

  it("warns on descriptors and children too, and skips a metric the platform does not report", () => {
    const leaking = settled(Array.from({ length: 37 }, () => 200)).map((sample, index) =>
      index < 40 ? sample : { ...sample, openFds: 400, children: 12 },
    );
    expect(healthGrowth(leaking).growth.map((entry) => entry.metric)).toEqual(["openFds", "children"]);
    const noFds = leaking.map(({ openFds: _fds, ...sample }) => sample);
    expect(healthGrowth(noFds).growth.map((entry) => entry.metric)).toEqual(["children"]);
  });

  it("on Windows counts handles instead of descriptors, warning only on growth in the hundreds", async () => {
    const windows = settled(
      Array.from({ length: 37 }, () => 200),
      { openHandles: 300 },
    ).map(({ openFds: _fds, ...sample }) => sample);
    const leaking = windows.map((sample, index) => (index < 40 ? sample : { ...sample, openHandles: 900 }));
    const growth = healthGrowth(leaking).growth;
    expect(growth.map((entry) => entry.metric)).toEqual(["openHandles"]);
    expect(growth[0]?.warning).toMatch(/open handles grew 3x/);
    // Doubling from a few handles is ordinary.
    const small = settled(
      Array.from({ length: 37 }, () => 200),
      { openHandles: 10 },
    ).map((sample, index) => (index < 40 ? sample : { ...sample, openHandles: 200 }));
    expect(healthGrowth(small).growth).toEqual([]);
    // Asked only of Windows: off it the sample has none.
    expect((await sampleHealth(new Date(), "linux")).openHandles).toBeUndefined();
    // On Windows the count comes from Windows, with no descriptor listing beside it; a count Windows refuses drops only that measure.
    handleCount.mockReturnValueOnce(731);
    const sampled = await sampleHealth(new Date(), "win32");
    expect(sampled.openHandles).toBe(731);
    expect(sampled.openFds).toBeUndefined();
    handleCount.mockImplementationOnce(() => {
      throw new Error("no koffi");
    });
    const refused = await sampleHealth(new Date(), "win32");
    expect(refused.openHandles).toBeUndefined();
    expect(refused.rssBytes).toBeGreaterThan(0);
  });

  it("does not take the owner's first hour, while it warms up, as the window's start", () => {
    // 120 MB at start, 300 MB once its first chats have loaded, flat after that.
    const warmUp = series([120, 120, 300, ...Array.from({ length: 40 }, () => 300)]);
    expect(healthGrowth(warmUp).growth).toEqual([]);
    expect(healthGrowth(warmUp).windowStart?.rssBytes).toBe(300 * MB);
  });

  it("warns of children leaking from none", () => {
    const leaking = settled(
      Array.from({ length: 37 }, () => 200),
      { children: 0 },
    ).map((sample, index) => (index < 40 ? sample : { ...sample, children: 12 }));
    expect(healthGrowth(leaking).growth).toMatchObject([{ metric: "children", from: 0, to: 12, factor: 12 }]);
  });
});

describe("createHealthWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("samples at once and on every interval into a bounded ring, until its signal aborts", async () => {
    vi.useFakeTimers();
    let taken = 0;
    const watch = createHealthWatch({
      limit: 3,
      sample: async () => ({ at: new Date(start + taken * HEALTH_SAMPLE_INTERVAL_MS).toISOString(), rssBytes: ++taken, children: 0 }),
    });
    const stop = new AbortController();
    watch.start(stop.signal);
    await vi.advanceTimersByTimeAsync(4 * HEALTH_SAMPLE_INTERVAL_MS);
    expect(taken).toBe(5);
    expect(watch.samples().map((sample) => sample.rssBytes)).toEqual([3, 4, 5]);
    stop.abort();
    await vi.advanceTimersByTimeAsync(3 * HEALTH_SAMPLE_INTERVAL_MS);
    expect(taken).toBe(5);
    // The trend takes a fresh sample that is not kept.
    const trend = await watch.trend();
    expect(trend).toMatchObject({ intervalMinutes: 10, samples: 3, now: { rssBytes: 6 }, growth: [] });
    expect(watch.samples()).toHaveLength(3);
  });

  it("keeps sampling after a failed sample", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const watch = createHealthWatch({
      sample: async () => {
        calls += 1;
        if (calls === 1) throw new Error("unreadable");
        return { at: new Date().toISOString(), rssBytes: calls, children: 0 };
      },
    });
    const stop = new AbortController();
    watch.start(stop.signal);
    await vi.advanceTimersByTimeAsync(HEALTH_SAMPLE_INTERVAL_MS);
    stop.abort();
    expect(watch.samples().map((sample) => sample.rssBytes)).toEqual([2]);
  });

  it("reads this process's own counters", async () => {
    const sample = await sampleHealth();
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.children).toBeGreaterThanOrEqual(0);
    if (process.platform === "darwin" || process.platform === "linux") expect(sample.openFds).toBeGreaterThan(0);
  });
});

describe("the Center summary's health", () => {
  const stores: SqliteStore[] = [];
  afterEach(async () => {
    while (stores.length > 0) await stores.pop()?.close();
  });

  async function summary(healthWarnings?: () => readonly string[]) {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    stores.push(store);
    const answer = await centerCommand(
      {
        repositories: store.asPort().repositories,
        memory: new MemoryService(store.asPort()),
        principalOf: () => "operator",
        now: () => new Date("2026-10-29T09:00:00.000Z"),
        ...(healthWarnings === undefined ? {} : { healthWarnings }),
      },
      { action: "summary" },
    );
    if (!answer.ok) throw new Error(answer.error.message);
    return CenterSummaryAnswerSchema.parse(answer.result);
  }

  it("carries the owner's growth warnings, and nothing while it is healthy", async () => {
    expect((await summary(() => ["the owner's memory (RSS) grew 2.3x in 6 hours"])).health).toEqual([
      "the owner's memory (RSS) grew 2.3x in 6 hours",
    ]);
    expect((await summary(() => [])).health).toBeUndefined();
    expect((await summary()).health).toBeUndefined();
  });
});

const owners = useAttachedOwners("tavi-doctor-health-");

async function doctor(argv: readonly string[]): Promise<Record<string, unknown>> {
  const out = capture();
  expect(await main(["doctor", ...argv], { io: out.io }), out.stderr()).toBe(EXIT.ok);
  return JSON.parse(out.stdout()) as Record<string, unknown>;
}

describe("tavi doctor: integrity and health", ATTACHED, () => {
  it("runs the quick check by default, the full one with --deep, and says the trend is the owner's", async () => {
    const directory = owners.tempDirectory();
    const quick = await doctor(["--data-dir", directory]);
    expect(quick["integrity"]).toEqual({ checked: true, mode: "quick", ok: true, problems: [] });
    expect(quick["health"]).toMatchObject({ running: false });
    expect((await doctor(["--deep", "--data-dir", directory]))["integrity"]).toEqual({
      checked: true,
      mode: "full",
      ok: true,
      problems: [],
    });
  });

  it("an attached doctor skips the check and reports the owner's samples", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const report = await doctor(["--data-dir", directory]);
    expect(report["integrity"]).toEqual({ checked: false, ok: null, problems: [] });
    expect(report["health"]).toMatchObject({ intervalMinutes: 10, samples: 1, growth: [] });
    expect((report["health"] as { now: HealthSample }).now.rssBytes).toBeGreaterThan(0);
  });

  it("says in text that the owner answering runs, and marks the database it holds as not checked, not failed", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const out = capture();
    await main(["doctor", "--format", "text", "--data-dir", directory], { io: out.io });
    expect(out.stdout()).toContain("✓ The owner is running");
    expect(out.stdout()).not.toContain("No owner is running");
    expect(out.stdout()).toContain("– Database: not checked (the owner holds it)");
  });

  it("refuses --deep on tavi tasks", async () => {
    const out = capture();
    expect(await main(["tasks", "--deep"], { io: out.io })).toBe(EXIT.usage);
  });
});
