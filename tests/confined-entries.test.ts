import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The built entries that run confined: the plugin worker reads only its own
 * folder, and the PDF and video children only their run directory and their own
 * package. A workspace package (`@tavi/contracts`, its `util`) is outside what
 * they may read, so an import of one fails at load, before the child can report
 * anything. Each entry's static graph imports Node built-ins, its own chunks and
 * its own package's dependencies, never a `@tavi/` package.
 */
const CONFINED = [
  "packages/builtin/worker/dist/worker.mjs",
  "packages/builtin/pdf/dist/child.mjs",
  "packages/builtin/pdf/dist/ocr-child.mjs",
  "packages/video-pose/dist/child.mjs",
  "packages/video-transcribe/dist/child.mjs",
];

/** The static and literal dynamic import specifiers of a built module. */
function specifiersOf(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** The `@tavi/` packages a built file reaches through its relative imports, itself included. */
function workspaceImportsOf(start: string): string[] {
  const pending = [start];
  const visited = new Set<string>();
  const found: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    expect(existsSync(file), `Missing built module: ${file}; run the build`).toBe(true);
    visited.add(file);
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
      else if (specifier.startsWith("@tavi/")) found.push(`${file.slice(root.length + 1)} imports ${specifier}`);
    }
  }
  return found;
}

describe("confined entries", () => {
  it.each(CONFINED)("%s loads no workspace package", (entry) => {
    expect(workspaceImportsOf(join(root, entry))).toEqual([]);
  });

  it("finds a workspace import, statically or by a literal dynamic import, through a chunk", () => {
    expect(specifiersOf('import { a } from "./chunk.mjs";\nimport("@tavi/contracts/util");\nexport * from "node:fs";')).toEqual([
      "./chunk.mjs",
      "@tavi/contracts/util",
      "node:fs",
    ]);
  });
});
