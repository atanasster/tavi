import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Each advisory `pnpm audit` is told to ignore (`auditConfig.ignoreGhsas` in
 * pnpm-workspace.yaml) is held to the package it was accepted for: once the
 * lockfile no longer has that package in the affected range, the exception is
 * stale and must go, so it cannot silently cover a later, different problem.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Each accepted advisory: the package and the versions it affects. A new ignore adds its line here. */
const ACCEPTED: Readonly<Record<string, { readonly name: string; readonly affected: (version: string) => boolean }>> = {
  // zod 3 under @anthropic-ai/sandbox-runtime: no patched 3.x.
  "GHSA-mrhx-c7xc-m3w5": { name: "zod", affected: (version) => version.startsWith("3.") },
};

function ignoredGhsas(): string[] {
  const workspace = read("pnpm-workspace.yaml");
  const block = /^auditConfig:\n {2}ignoreGhsas:\n((?:(?: {4}#.*| {4}- .*)\n)+)/m.exec(workspace)?.[1] ?? "";
  return [...block.matchAll(/^ {4}- (\S+)/gm)].map((match) => match[1] as string);
}

/** Every version of `name` the lockfile resolves (its `packages:` keys, `name@version`). */
function lockedVersions(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@(\\d[^':(]*)`, "gm");
  return [...new Set([...read("pnpm-lock.yaml").matchAll(pattern)].map((match) => match[1] as string))];
}

it("reads the ignored advisories", () => {
  expect(ignoredGhsas()).toContain("GHSA-mrhx-c7xc-m3w5");
});

it("names, for every ignored advisory, the package it was accepted for", () => {
  expect(ignoredGhsas().filter((ghsa) => ACCEPTED[ghsa] === undefined)).toEqual([]);
});

it("keeps an ignore only while the lockfile still has an affected version", () => {
  const stale = ignoredGhsas().filter((ghsa) => {
    const accepted = ACCEPTED[ghsa];
    return accepted !== undefined && !lockedVersions(accepted.name).some(accepted.affected);
  });
  // A stale entry: drop it from `auditConfig.ignoreGhsas` and from ACCEPTED above.
  expect(stale).toEqual([]);
});

it("finds a package's locked versions", () => {
  expect(lockedVersions("zod")).toContain("3.25.76");
  expect(lockedVersions("@anthropic-ai/sandbox-runtime")).toEqual([expect.stringMatching(/^\d+\.\d+\.\d+$/)]);
});
