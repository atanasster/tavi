import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/**
 * Per-action browser timing benchmark against the local mini-web fixture server.
 *
 * Measures p50 and p95 wall-clock latency (in milliseconds) for each browser
 * action kind:
 *   - navigate
 *   - observe
 *   - click (in-page button click)
 *   - navigating_click (click that navigates to another page)
 *   - fill (type into a text field)
 *   - keys (type into a field key by key, `mode: "keys"`, with no suggestions)
 *   - select (choose an option of a native drop-down, `kind: "select"`)
 *   - scroll (scroll the viewport)
 *   - capture (capture a screenshot artifact)
 *
 * CI records the numbers without hard-failing on wall-clock jitter; `compareWithBaseline`
 * highlights any action whose p50 regresses by more than 15% against the baseline.
 *
 * Erasable TypeScript only so `node evals/browser/timing.ts` runs directly after `pnpm build`.
 */

export type TimingActionKind = "navigate" | "observe" | "click" | "navigating_click" | "fill" | "keys" | "select" | "scroll" | "capture";

export const TIMING_ACTION_KINDS: readonly TimingActionKind[] = [
  "navigate",
  "observe",
  "click",
  "navigating_click",
  "fill",
  "keys",
  "select",
  "scroll",
  "capture",
];

/**
 * Baseline p50 wall times (ms): `node evals/browser/timing.ts --iterations 5`
 * on macOS (darwin, Apple silicon), headless Chromium, 2026-10-27, after d9bd3a3, every action accepted.
 * Re-record on the machine the comparison runs on: these are wall-clock times.
 */
export const BASELINE_P50_MS: Readonly<Record<TimingActionKind, number>> = {
  navigate: 675,
  observe: 10,
  click: 211,
  navigating_click: 237,
  fill: 10,
  keys: 1221,
  select: 28,
  scroll: 413,
  capture: 16,
};

export interface ActionTimingStats {
  readonly kind: TimingActionKind;
  readonly samples: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

export interface TimingBenchReport {
  readonly recordedAt: string;
  readonly iterations: number;
  readonly actions: Readonly<Record<TimingActionKind, ActionTimingStats>>;
  readonly regressions: readonly {
    readonly kind: TimingActionKind;
    readonly baselineP50Ms: number;
    readonly p50Ms: number;
    readonly deltaRatio: number;
  }[];
}

export function percentile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const clamped = Math.min(1, Math.max(0, q));
  const index = Math.ceil(clamped * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))] ?? 0;
}

export function computeActionTimingStats(kind: TimingActionKind, rawMs: readonly number[]): ActionTimingStats {
  const sorted = [...rawMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const round = (n: number): number => Math.round(n * 100) / 100;
  return {
    kind,
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    meanMs: sorted.length === 0 ? 0 : round(sum / sorted.length),
  };
}

export function buildTimingBenchReport(
  samplesByKind: Readonly<Record<TimingActionKind, readonly number[]>>,
  iterations: number,
  baselineP50: Readonly<Record<TimingActionKind, number>> = BASELINE_P50_MS,
  regressionThresholdRatio = 0.15,
): TimingBenchReport {
  const actions = {} as Record<TimingActionKind, ActionTimingStats>;
  const regressions: {
    readonly kind: TimingActionKind;
    readonly baselineP50Ms: number;
    readonly p50Ms: number;
    readonly deltaRatio: number;
  }[] = [];

  for (const kind of TIMING_ACTION_KINDS) {
    const stats = computeActionTimingStats(kind, samplesByKind[kind] ?? []);
    actions[kind] = stats;
    const base = baselineP50[kind];
    if (base > 0 && stats.samples > 0) {
      const deltaRatio = (stats.p50Ms - base) / base;
      if (deltaRatio > regressionThresholdRatio) {
        regressions.push({
          kind,
          baselineP50Ms: base,
          p50Ms: stats.p50Ms,
          deltaRatio: Math.round(deltaRatio * 1000) / 1000,
        });
      }
    }
  }

  return {
    recordedAt: new Date().toISOString(),
    iterations,
    actions,
    regressions,
  };
}

export function formatTimingBenchReport(report: TimingBenchReport): string {
  const lines = [
    `Browser per-action timing benchmark (${report.iterations} iterations)`,
    "kind              | p50 (ms) | p95 (ms) | min (ms) | max (ms) | baseline p50 (ms)",
    "------------------+----------+----------+----------+----------+------------------",
  ];
  for (const kind of TIMING_ACTION_KINDS) {
    const stat = report.actions[kind];
    const base = BASELINE_P50_MS[kind];
    lines.push(
      `${kind.padEnd(17)} | ${stat.p50Ms.toFixed(1).padStart(8)} | ${stat.p95Ms.toFixed(1).padStart(8)} | ${stat.minMs.toFixed(1).padStart(8)} | ${stat.maxMs.toFixed(1).padStart(8)} | ${base.toFixed(1).padStart(16)}`,
    );
  }
  if (report.regressions.length > 0) {
    lines.push("");
    lines.push("Notes (p50 > +15% vs baseline):");
    for (const reg of report.regressions) {
      lines.push(`  - ${reg.kind}: ${reg.p50Ms.toFixed(1)}ms vs ${reg.baselineP50Ms.toFixed(1)}ms (+${Math.round(reg.deltaRatio * 100)}%)`);
    }
  }
  return lines.join("\n");
}

async function measureMs(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

export async function runTimingBench(iterations = 5): Promise<TimingBenchReport> {
  const { startMiniWebServer } = (await import(
    new URL("./fixtures/server.ts", import.meta.url).href
  )) as typeof import("./fixtures/server.js");
  const { createPlaywrightBrowser } = (await import(
    new URL("../../packages/builtin/browser/dist/playwright.mjs", import.meta.url).href
  )) as typeof import("../../packages/builtin/browser/src/playwright.js");
  const stagingDirectory = await mkdtemp(join(tmpdir(), "tavi-timing-"));
  const miniWeb = await startMiniWebServer();
  const browser = createPlaywrightBrowser({
    stagingDirectory,
    artifacts: {
      putArtifact: async (input) => ({
        artifactId: "art-timing",
        workspaceId: input.workspaceId,
        runId: input.runId ?? null,
        relativePath: "art-timing",
        contentType: input.contentType,
        byteSize: typeof input.body === "string" ? input.body.length : input.body.byteLength,
        sha256: "0",
        reviewState: "approved",
        reviewedBy: null,
        reviewedAt: null,
      }),
      getArtifact: async () => undefined,
      readArtifactBody: async () => undefined,
      derivedPreviewExists: async () => false,
      listPendingReview: async () => [],
      setReviewState: async () => undefined,
    },
  });

  const samples: Record<TimingActionKind, number[]> = {
    navigate: [],
    observe: [],
    click: [],
    navigating_click: [],
    fill: [],
    keys: [],
    select: [],
    scroll: [],
    capture: [],
  };

  /** One action, timed: it must land (a refused or uncertain action is no sample), and the epoch it leaves is returned. */
  const timedAct = async (action: Parameters<typeof browser.act>[0]): Promise<{ readonly ms: number; readonly epoch?: number }> => {
    let outcome: Awaited<ReturnType<typeof browser.act>> | undefined;
    const ms = await measureMs(async () => {
      outcome = await browser.act(action);
    });
    if (outcome?.status !== "accepted")
      throw new Error(`${action.kind} was not accepted: ${outcome?.detail ?? outcome?.status ?? "no outcome"}`);
    return { ms, ...(outcome.page === undefined ? {} : { epoch: outcome.page.epoch }) };
  };

  try {
    const { sessionId } = await browser.createSession({ workspaceId: "ws-timing" });
    try {
      for (let i = 0; i < iterations; i += 1) {
        samples.navigate.push(await measureMs(() => browser.navigate(sessionId, `${miniWeb.origin}/spa`)));
        let spaObs = await browser.observe(sessionId);
        // Every observation moves the epoch: the click acts on the one just timed.
        samples.observe.push(
          await measureMs(async () => {
            spaObs = await browser.observe(sessionId);
          }),
        );

        const alpha = spaObs.elements.find((el) => el.text === "Alpha");
        if (alpha !== undefined) {
          samples.click.push((await timedAct({ sessionId, kind: "click", ref: alpha.ref, epoch: spaObs.epoch })).ms);
        }

        const formsObs = await browser.navigate(sessionId, `${miniWeb.origin}/submits`);
        const country = formsObs.elements.find((el) => el.role === "combobox" && el.text === "Country");
        if (country !== undefined) {
          samples.select.push((await timedAct({ sessionId, kind: "select", ref: country.ref, epoch: formsObs.epoch, value: "Spain" })).ms);
        }

        const stepObs = await browser.navigate(sessionId, `${miniWeb.origin}/wizard/step1`);
        const recipient = stepObs.elements.find((el) => el.text?.includes("Recipient"));
        const cont = stepObs.elements.find((el) => el.text === "Continue to review");
        if (recipient !== undefined) {
          // An action that answers with the page moves the epoch: the next one acts on that page's.
          let epoch = stepObs.epoch;
          const timed = async (action: Parameters<typeof browser.act>[0]): Promise<number> => {
            const result = await timedAct(action);
            epoch = result.epoch ?? epoch;
            return result.ms;
          };
          samples.fill.push(await timed({ sessionId, kind: "type", ref: recipient.ref, epoch, value: "Ada" }));
          // Key by key replaces what the field holds: the whole value, typed again.
          samples.keys.push(await timed({ sessionId, kind: "type", ref: recipient.ref, epoch, value: "Ada Lovelace", mode: "keys" }));
          if (cont !== undefined) {
            samples.navigating_click.push(await timed({ sessionId, kind: "click", ref: cont.ref, epoch }));
          }
        }

        const loopObs = await browser.navigate(sessionId, `${miniWeb.origin}/loops`);
        samples.scroll.push((await timedAct({ sessionId, kind: "scroll", epoch: loopObs.epoch, value: "down" })).ms);
        samples.capture.push(await measureMs(() => browser.capture(sessionId)));
      }
    } finally {
      await browser.close(sessionId);
    }
  } finally {
    await browser.dispose?.();
    await miniWeb.close();
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  // A kind with no samples means a fixture changed under the bench: say so, never report it as fast.
  const unmeasured = TIMING_ACTION_KINDS.filter((kind) => samples[kind].length === 0);
  if (unmeasured.length > 0) throw new Error(`the bench measured nothing for ${unmeasured.join(", ")}: a fixture page changed`);
  return buildTimingBenchReport(samples, iterations);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const iterationsArg = process.argv.indexOf("--iterations");
  const iterations = iterationsArg !== -1 ? Number(process.argv[iterationsArg + 1] ?? "5") : 5;
  runTimingBench(Number.isFinite(iterations) && iterations > 0 ? iterations : 5).then(
    (report) => {
      if (process.argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatTimingBenchReport(report)}\n`);
      }
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
