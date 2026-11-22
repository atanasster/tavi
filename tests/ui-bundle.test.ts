import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { run } from "./support/process.js";

/**
 * The web canvas's bundle budget: its first load (the entry chunk `index.html`
 * loads, the chunks it modulepreloads and the stylesheets it links) and all of
 * its JavaScript, gzipped, as `apps/ui/scripts/analyze.mjs` measures the build
 * in `apps/ui/dist`. A dependency or a static import that grows the first load
 * fails here rather than in someone's browser.
 *
 * Each budget is about 15% over the size measured when it was set (first load
 * 341 KiB: entry 313 KiB plus its stylesheet 28 KiB; all JavaScript 680 KiB;
 * on 2026-10-29), raised on 2026-11-22 for languages: the English catalogue
 * (every word the canvas says, which views used to carry inline in their own,
 * often lazy, chunks) is in the first load, about 75 KiB, and the Bulgarian one
 * is a chunk of its own, about 90 KiB, fetched only when Bulgarian is chosen
 * (first load then 437 KiB, all JavaScript 901 KiB). To re-measure: `pnpm --filter @tavi/ui analyze` prints every
 * chunk's size; raise a budget only for growth that is meant, and say what it
 * bought in the commit.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps/ui/dist");
const built = existsSync(join(dist, "index.html"));
if (!built && process.env["CI"]) {
  // In CI a missing build is a failure, not a skip: a skipped budget would leave the run green.
  throw new Error(`web bundle budget: ${dist} has no build in CI; build @tavi/ui before this suite`);
}
if (!built) {
  // Said, not silent: a budget that does not run should be visible in the suite's output.
  console.warn(`web bundle budget skipped: ${dist} has no build; run \`pnpm run build\` (or \`pnpm --filter @tavi/ui build\`)`);
}

const KIB = 1024;
const FIRST_LOAD_GZIP_BUDGET = 500 * KIB;
const TOTAL_JS_GZIP_BUDGET = 1040 * KIB;

interface BundleReport {
  readonly entry: string;
  readonly firstLoad: readonly string[];
  readonly firstLoadGzip: number;
  readonly totalJsGzip: number;
}

describe.skipIf(!built)("web canvas bundle budget", () => {
  // Measured in a hook, not while the suite is collected: a skipped suite's body still runs.
  let report: BundleReport;
  beforeAll(() => {
    report = JSON.parse(
      run(process.execPath, [join(root, "apps/ui/scripts/analyze.mjs"), "--json"], { encoding: "utf8", cwd: root }),
    ) as BundleReport;
  });

  it("keeps the first load within its gzipped budget", () => {
    const said = `${report.firstLoad.join(" + ")} is ${(report.firstLoadGzip / KIB).toFixed(1)} KiB gzipped`;
    expect(report.firstLoad, said).toContain(report.entry);
    expect(report.firstLoadGzip, said).toBeGreaterThan(0);
    expect(report.firstLoadGzip, said).toBeLessThanOrEqual(FIRST_LOAD_GZIP_BUDGET);
  });

  it("keeps all of the canvas's JavaScript within its gzipped budget", () => {
    expect(report.totalJsGzip, `all JavaScript is ${(report.totalJsGzip / KIB).toFixed(1)} KiB gzipped`).toBeLessThanOrEqual(
      TOTAL_JS_GZIP_BUDGET,
    );
  });
});
