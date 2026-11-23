import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The duplication gate: jscpd (settings in `.jscpd.json`) over `apps`,
 * `packages`, `examples`, `evals`, `scripts` and the root `tests`, its clones
 * split into test clones (both sides under a `test/` or `tests/` folder) and
 * source clones (every other, a test that copies source logic included), each
 * count held at or below a committed ceiling. A new copy-pasted block fails
 * here; reach for the shared home instead (docs/DEVELOPMENT.md, "Shared code").
 *
 * Re-measure by setting a ceiling to 0 (the source one is checked first) and
 * running `npx vitest run tests/duplication.test.ts`: the failure reports the
 * count (`received`) and lists that ceiling's clones (`pnpm exec jscpd
 * --config .jscpd.json apps packages examples evals scripts tests` prints them
 * all, unsplit). Lower a ceiling whenever clones are removed so the gain is kept;
 * raise one only for a reviewed reason. The scan takes about a second once the
 * jscpd binary has run once.
 */
const SOURCE_CLONE_CEILING = 95;
const TEST_CLONE_CEILING = 905;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories = temporaryDirectories({ prefix: "tavi-jscpd-" });
afterAll(() => directories.cleanup());

interface CloneSide {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}
interface Report {
  readonly duplicates: readonly { readonly firstFile: CloneSide; readonly secondFile: CloneSide }[];
}

const SCANNED = ["apps", "packages", "examples", "evals", "scripts", "tests"] as const;
const IN_TESTS = /(^|\/)tests?\//;

describe("code duplication", () => {
  it("keeps source and test clones at or below their ceilings", () => {
    const output = directories.create();
    const launcher = fileURLToPath(import.meta.resolve("jscpd/run-jscpd.js"));
    execFileSync(
      process.execPath,
      [launcher, "--config", ".jscpd.json", "--absolute", "--reporters", "json", "--output", output, ...SCANNED],
      // macOS's syspolicyd can hold the first exec of a freshly installed
      // binary (jscpd's, after every `pnpm install`) for 20-60 s; the bound
      // keeps a hung binary from blocking the worker, which Vitest cannot interrupt.
      { cwd: root, stdio: "pipe", timeout: 75_000 },
    );
    const report = JSON.parse(readFileSync(join(output, "jscpd-report.json"), "utf8")) as Report;
    const describeSide = (side: CloneSide): string => `${relative(root, side.name)}:${side.start}-${side.end}`;
    const isTest = (side: CloneSide): boolean => IN_TESTS.test(relative(root, side.name).split(sep).join("/"));
    const source: string[] = [];
    const test: string[] = [];
    for (const clone of report.duplicates) {
      const line = `${describeSide(clone.firstFile)} = ${describeSide(clone.secondFile)}`;
      (isTest(clone.firstFile) && isTest(clone.secondFile) ? test : source).push(line);
    }
    expect(report.duplicates.length, "jscpd found no clones at all: is the scan reading the workspace?").toBeGreaterThan(0);
    expect(source.length, `source clones above the ceiling of ${SOURCE_CLONE_CEILING}:\n${source.join("\n")}`).toBeLessThanOrEqual(
      SOURCE_CLONE_CEILING,
    );
    expect(test.length, `test clones above the ceiling of ${TEST_CLONE_CEILING}:\n${test.join("\n")}`).toBeLessThanOrEqual(
      TEST_CLONE_CEILING,
    );
  }, 90_000);
});
