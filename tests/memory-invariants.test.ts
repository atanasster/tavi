import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Every memory invariant has a test: docs/MEMORY.md's "Invariants" section
 * numbers them, and each is named by a test titled `memory invariant <n>:`
 * somewhere in the suite.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const self = relative(root, fileURLToPath(import.meta.url))
  .split("\\")
  .join("/");
const TITLE = /memory invariant (\d+):/g;

/** The numbers of the Invariants section's numbered items. */
function invariants(): number[] {
  const doc = readFileSync(join(root, "docs/MEMORY.md"), "utf8");
  const start = doc.indexOf("\n## Invariants");
  expect(start, "docs/MEMORY.md has an Invariants section").toBeGreaterThan(-1);
  const end = doc.indexOf("\n## ", start + 1);
  return doc
    .slice(start, end < 0 ? undefined : end)
    .split("\n")
    .flatMap((line) => {
      const item = /^(\d+)\. /.exec(line);
      return item === null ? [] : [Number(item[1])];
    });
}

function testFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** Every invariant number some test file names in a `memory invariant <n>:` title. */
function tested(): Set<number> {
  const numbers = new Set<number>();
  for (const file of ["apps", "packages", "tests"].flatMap((group) => testFiles(join(root, group)))) {
    if (relative(root, file).split("\\").join("/") === self) continue;
    for (const match of readFileSync(file, "utf8").matchAll(TITLE)) numbers.add(Number(match[1]));
  }
  return numbers;
}

it("memory invariant guard: the invariants are numbered 1 to n, in order", () => {
  const numbers = invariants();
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1));
});

it("memory invariant guard: every invariant has a test titled with its number", () => {
  const found = tested();
  const missing = invariants().filter((number) => !found.has(number));
  expect(missing, `add a test titled "memory invariant <n>:" for: ${missing.join(", ")}`).toEqual([]);
});
