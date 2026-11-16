import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { importedBy } from "./support/imports.js";
import { workspacePackageDirectories } from "./support/dependency-rules.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = workspacePackageDirectories(root).map((directory) => ({
  directory: join(root, directory),
  manifest: JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as { name: string; exports?: Record<string, unknown> },
}));
function importTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  if ("import" in value) return importTarget(value.import);
  if ("default" in value) return importTarget(value.default);
  return undefined;
}

it("keeps native database drivers outside the built application import graph", () => {
  const pending = [join(root, "apps/cli/dist/executable.mjs"), join(root, "packages/runtime/dist/index.mjs")];
  const visited = new Set<string>();
  const forbidden = new Set(["better-sqlite3", "node:sqlite", "@langchain/langgraph-checkpoint-sqlite"]);
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    expect(existsSync(file), `Missing built module: ${file}`).toBe(true);
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...importedBy(source),
      ...[...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? ""),
    ];
    for (const specifier of specifiers) {
      expect(forbidden.has(specifier), `${file} imports ${specifier} on the agent thread`).toBe(false);
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
      else {
        const workspace = workspaces.find((item) => specifier === item.manifest.name || specifier.startsWith(`${item.manifest.name}/`));
        if (workspace === undefined) continue;
        const key = specifier === workspace.manifest.name ? "." : `.${specifier.slice(workspace.manifest.name.length)}`;
        const target = importTarget(workspace.manifest.exports?.[key]);
        expect(target, `No published import target for ${specifier}`).toBeDefined();
        if (target !== undefined) pending.push(resolve(workspace.directory, target));
      }
    }
  }
  expect(visited.has(join(root, "packages/runtime/dist/index.mjs"))).toBe(true);
  expect([...visited].some((file) => file.endsWith("/database-worker.mjs"))).toBe(false);
  expect([...visited].some((file) => file.endsWith("/ownership-worker.mjs"))).toBe(false);
});
