import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The resolved packages (`packages:` in `pnpm-lock.yaml`) whose registry entry is deprecated:
 * a dependency its own maintainers retired, or a version they withdrew, found at the bump that
 * brought it in rather than later.
 */
function deprecatedPackages(lockfile: string): string[] {
  const found: string[] = [];
  let current: string | undefined;
  for (const line of lockfile.split("\n")) {
    const entry = /^ {2}'?([^\s'][^']*?)'?:$/.exec(line);
    if (entry !== null) current = entry[1];
    else if (/^\S/.test(line)) current = undefined;
    else if (current !== undefined && line.startsWith("    deprecated:")) found.push(current);
  }
  return found;
}

it("resolves no deprecated package", () => {
  expect(deprecatedPackages(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"))).toEqual([]);
});

it("finds a deprecated entry by its package key", () => {
  const lockfile = [
    "packages:",
    "",
    "  katex@0.18.11:",
    "    resolution: {integrity: sha512-x}",
    "    deprecated: Accidentally published with breaking changes.",
    "",
    "  '@scope/name@1.0.0':",
    "    resolution: {integrity: sha512-y}",
    "",
    "snapshots:",
  ].join("\n");
  expect(deprecatedPackages(lockfile)).toEqual(["katex@0.18.11"]);
});
