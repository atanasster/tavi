import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type BenchmarkReport, changedFrom, decide, parseCasesFile, runBenchmark } from "../evals/sandbox-usability/eval.js";

/**
 * The sandbox usability benchmark (evals/sandbox-usability): every case's
 * gate decision is pinned in `baseline.json`. A change that adds or removes a
 * prompt fails here until the baseline is rewritten on purpose with
 * `TAVI_UPDATE_SANDBOX_BASELINE=1 pnpm vitest run tests/sandbox-usability-eval.test.ts`.
 */

const folder = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "evals", "sandbox-usability");
const cases = parseCasesFile(JSON.parse(readFileSync(join(folder, "cases.json"), "utf8"))).cases;

describe("the sandbox usability benchmark", () => {
  it("reads its cases, refusing duplicates", () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(() =>
      parseCasesFile({
        version: 1,
        cases: [
          { id: "a", category: "x", line: "ls" },
          { id: "a", category: "x", line: "ls" },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("refuses what the hard-deny list refuses, tainted or not", () => {
    const fork = { id: "f", category: "escape", line: "rm -rf /" };
    expect(decide(fork, false).decision).toBe("deny");
    expect(decide(fork, true).decision).toBe("deny");
  });

  it("matches the pinned baseline", () => {
    const current = runBenchmark(cases);
    const path = join(folder, "baseline.json");
    if (process.env["TAVI_UPDATE_SANDBOX_BASELINE"] === "1") writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
    const baseline = JSON.parse(readFileSync(path, "utf8")) as BenchmarkReport;
    expect(changedFrom(baseline, current), "rewrite baseline.json on purpose when a change is intended").toEqual([]);
    expect(current.promptsPer100).toBe(baseline.promptsPer100);
    expect(current.untainted.askEveryTime).toBe(baseline.untainted.askEveryTime);
  });
});
