import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Every sandbox flag `serve` accepts is documented in CLI.md, which owns the
 * flags (SANDBOX.md's Configuration table links there), and SANDBOX.md names
 * the srt version Tavi pins.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

it("documents every --sandbox-* flag serve accepts in CLI.md", () => {
  const flags = [...new Set(read("apps/cli/src/server/parse.ts").match(/--sandbox-[a-z-]+[a-z]/g) ?? [])];
  expect(flags.length).toBeGreaterThan(10);
  const cli = read("docs/CLI.md");
  expect(flags.filter((flag) => !cli.includes(`\`${flag}`))).toEqual([]);
});

it("names in SANDBOX.md the srt version the workspace pins", () => {
  // The workspace catalog pins it for every package.
  const pinned = /^\s*"@anthropic-ai\/sandbox-runtime":\s*(\S+)\s*$/m.exec(read("pnpm-workspace.yaml"))?.[1];
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  expect(read("docs/SANDBOX.md")).toContain(`\`@anthropic-ai/sandbox-runtime\` ${pinned ?? ""}`);
});
