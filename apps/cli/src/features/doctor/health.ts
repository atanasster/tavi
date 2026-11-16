import { readdir } from "node:fs/promises";

import { processHandleCount } from "@tavi/node-kit";

import { type RepeatTimer, repeatEvery } from "@tavi/agent-host/schedule-scheduler";

/**
 * The owner's long-run health watch: every 10 minutes it samples the
 * process's resident memory, its open file descriptors (on Windows, its open
 * handles) and its live child
 * processes, and keeps the last day of samples in memory. `tavi doctor`
 * (attached) reports the trend, and the Command Center's Activity view warns
 * when one of them has grown more than twofold over 6 hours and stayed there.
 *
 * Nothing here touches the database or the persistence worker: a sample reads
 * the process's own counters and one directory listing, so an idle owner pays
 * one timer wakeup every 10 minutes and no worker round trip. Samples are not
 * kept across restarts; a restart is also what clears the leak they would show.
 */

/** How often the owner samples itself. */
export const HEALTH_SAMPLE_INTERVAL_MS = 10 * 60_000;
/** The window sustained growth is measured over. */
const HEALTH_GROWTH_WINDOW_MS = 6 * 3_600_000;
/** Growth beyond this factor over the window is warned about. */
const HEALTH_GROWTH_FACTOR = 2;
/** Samples kept: a day at one every 10 minutes. */
const HEALTH_SAMPLE_LIMIT = 144;
/** After the owner starts, how long its samples stay out of the window's start: lazy imports and first-use servers grow it once. */
const HEALTH_WARMUP_MS = 3_600_000;
/** The newest samples that must all be above the bound: one high sample is a spike, not growth. */
const SUSTAINED_SAMPLES = 3;

type HealthMetric = "rssBytes" | "openFds" | "openHandles" | "children";

/**
 * The least absolute growth worth a warning, per metric: doubling from a few
 * descriptors or one child (an MCP server started on first use) is ordinary.
 */
const MIN_GROWTH: Readonly<Record<HealthMetric, number>> = {
  rssBytes: 64 * 1024 * 1024,
  openFds: 32,
  // A Windows process holds hundreds of handles at rest (threads, events, registry keys): growth is counted in hundreds.
  openHandles: 256,
  children: 4,
};

const METRIC_NAMES: Readonly<Record<HealthMetric, string>> = {
  rssBytes: "memory (RSS)",
  openFds: "open file descriptors",
  openHandles: "open handles",
  children: "child processes",
};

export interface HealthSample {
  readonly at: string;
  readonly rssBytes: number;
  /** Absent where the platform offers no listing of a process's descriptors (Windows, which counts handles instead). */
  readonly openFds?: number;
  /** Windows only: the handles the process holds open, files and pipes among them. */
  readonly openHandles?: number;
  readonly children: number;
}

/** One metric that grew past the bound and stayed there. */
export interface HealthGrowth {
  readonly metric: HealthMetric;
  /** The value at the start of the window. */
  readonly from: number;
  /** The least of the newest samples: the level it stayed at. */
  readonly to: number;
  readonly factor: number;
  readonly since: string;
  readonly warning: string;
}

/** What `doctor` reports: the latest sample, the window's first, and any sustained growth. */
export interface HealthTrend {
  readonly intervalMinutes: number;
  readonly samples: number;
  /** When the oldest kept sample was taken. */
  readonly since?: string;
  /** A sample taken for this report, not kept. */
  readonly now: HealthSample;
  /** The sample at the start of the 6-hour window, once the owner has run that long. */
  readonly windowStart?: HealthSample;
  readonly growth: readonly HealthGrowth[];
}

/** Open descriptors from the process's own listing (`/proc/self/fd`, `/dev/fd`), less the one the listing holds. */
async function openFdCount(platform: NodeJS.Platform): Promise<number | undefined> {
  const directory = platform === "linux" ? "/proc/self/fd" : platform === "darwin" ? "/dev/fd" : undefined;
  if (directory === undefined) return undefined;
  try {
    return Math.max(0, (await readdir(directory)).length - 1);
  } catch {
    return undefined;
  }
}

/** Child processes Node holds a handle for: MCP servers, sandboxed runs, browsers and the like. */
function childCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "ProcessWrap").length;
}

/** On Windows, the handles this process holds; undefined elsewhere, or when Windows will not say. */
function openHandleCount(platform: NodeJS.Platform): number | undefined {
  if (platform !== "win32") return undefined;
  try {
    return processHandleCount();
  } catch {
    return undefined;
  }
}

export async function sampleHealth(now: Date = new Date(), platform: NodeJS.Platform = process.platform): Promise<HealthSample> {
  const openFds = await openFdCount(platform);
  const openHandles = openHandleCount(platform);
  return {
    at: now.toISOString(),
    rssBytes: process.memoryUsage.rss(),
    ...(openFds === undefined ? {} : { openFds }),
    ...(openHandles === undefined ? {} : { openHandles }),
    children: childCount(),
  };
}

const formatValue = (metric: HealthMetric, value: number): string =>
  metric === "rssBytes" ? `${String(Math.round(value / (1024 * 1024)))} MB` : String(value);

/**
 * Sustained growth in `samples` (oldest first): the window's first sample is
 * the last one taken at or before 6 hours before the newest and at least an
 * hour after the oldest (warm-up growth is not a leak), and every one of the
 * newest three must exceed twice its value (and by the metric's floor). A
 * metric at 0 is measured from 1, so the floor alone decides it. None while
 * the owner has run less than 7 hours.
 */
export function healthGrowth(samples: readonly HealthSample[]): { readonly windowStart?: HealthSample; readonly growth: HealthGrowth[] } {
  const newest = samples.at(-1);
  if (newest === undefined || samples.length < SUSTAINED_SAMPLES + 1) return { growth: [] };
  const bound = Date.parse(newest.at) - HEALTH_GROWTH_WINDOW_MS;
  const warm = Date.parse(samples[0]?.at ?? newest.at) + HEALTH_WARMUP_MS;
  const windowStart = samples.findLast((sample) => {
    const at = Date.parse(sample.at);
    return at <= bound && at >= warm;
  });
  if (windowStart === undefined) return { growth: [] };
  const recent = samples.slice(-SUSTAINED_SAMPLES);
  const growth: HealthGrowth[] = [];
  for (const metric of Object.keys(MIN_GROWTH) as HealthMetric[]) {
    const from = windowStart[metric];
    if (from === undefined) continue;
    const values = recent.map((sample) => sample[metric]);
    if (values.some((value) => value === undefined)) continue;
    const to = Math.min(...(values as number[]));
    const base = Math.max(from, 1);
    if (to > base * HEALTH_GROWTH_FACTOR && to - from >= MIN_GROWTH[metric]) {
      const factor = Math.round((to / base) * 10) / 10;
      growth.push({
        metric,
        from,
        to,
        factor,
        since: windowStart.at,
        warning: `the owner's ${METRIC_NAMES[metric]} grew ${String(factor)}x in 6 hours (${formatValue(metric, from)} to ${formatValue(metric, to)}) and stayed there; restart the owner (tavi serve, or its service) and report it if it recurs`,
      });
    }
  }
  return { windowStart, growth };
}

export interface HealthWatch {
  /** Starts sampling (one sample now, then every interval) until `signal` aborts. */
  start(signal: AbortSignal): void;
  /** The kept samples, oldest first. */
  samples(): readonly HealthSample[];
  /** The trend for `doctor`, with a fresh sample that is not kept. */
  trend(): Promise<HealthTrend>;
  /** Sustained growth over the kept samples alone, for the Activity view. */
  growth(): readonly HealthGrowth[];
}

export function createHealthWatch(
  options: {
    readonly intervalMs?: number;
    readonly limit?: number;
    readonly sample?: () => Promise<HealthSample>;
    /** Runs the sampling timer (the owner's due-work planner's); absent, `setInterval`. */
    readonly every?: RepeatTimer;
  } = {},
): HealthWatch {
  const intervalMs = options.intervalMs ?? HEALTH_SAMPLE_INTERVAL_MS;
  const limit = options.limit ?? HEALTH_SAMPLE_LIMIT;
  const sample = options.sample ?? (() => sampleHealth());
  const ring: HealthSample[] = [];
  const record = async (): Promise<void> => {
    try {
      ring.push(await sample());
      if (ring.length > limit) ring.splice(0, ring.length - limit);
    } catch {
      // A failed sample is a gap in the trend, never a fault in the owner.
    }
  };
  return {
    start(signal) {
      if (signal.aborted) return;
      void record();
      const stop = (options.every ?? repeatEvery)(() => void record(), intervalMs);
      signal.addEventListener("abort", () => stop(), { once: true });
    },
    samples: () => [...ring],
    growth: () => healthGrowth(ring).growth,
    async trend() {
      const { windowStart, growth } = healthGrowth(ring);
      return {
        intervalMinutes: Math.round(intervalMs / 60_000),
        samples: ring.length,
        ...(ring[0] === undefined ? {} : { since: ring[0].at }),
        now: await sample(),
        ...(windowStart === undefined ? {} : { windowStart }),
        growth,
      };
    },
  };
}
