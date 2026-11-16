import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Every reader through the port: no
 * code outside the built-in memory service and its store names a table the
 * service owns, so a caller reads memory through `MemoryServicePort` and an
 * embedder's replacement is never bypassed by SQL of its own.
 *
 * Allowed: the service (`packages/runtime/src/memory`), its store
 * (`store/memory.ts`), the migrations that create and alter the tables, the
 * backups that export them, and the memory cards' own rows, which settle by
 * their record's status inside the store's transaction. The chat cards'
 * (`tavi_memory_prompts`) and jobs' marks (`tavi_memory_marks`) tables are
 * the transcript repository's, and a chat's use list (`tavi_task_memory_use`)
 * is its own repository's: neither is guarded here.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The service's own tables, by name: records and everything derived from them. */
const SERVICE_TABLE =
  /\btavi_memory_(records|revisions|reviews|deletions|scope_generations|fts|fts_stem|fts_map|vectors|vector_failures)\b/;

const ALLOWED: readonly { readonly path: RegExp; readonly why: string }[] = [
  { path: /^packages\/runtime\/src\/memory\//, why: "the service" },
  { path: /^packages\/runtime\/src\/persistence\/store\/memory\.ts$/, why: "the service's store" },
  { path: /^packages\/runtime\/src\/persistence\/(migrations|baseline-schema)\.ts$/, why: "migrations (the baseline schema among them)" },
  {
    path: /^packages\/runtime\/src\/persistence\/[a-z-]+-migration\.ts$/,
    why: "migrations (the Center's change-feed triggers among them)",
  },
  { path: /^packages\/runtime\/src\/persistence\/administration\.ts$/, why: "backups" },
  { path: /^packages\/runtime\/src\/persistence\/transcript-repository\.ts$/, why: "memory cards' rows settle by their record's status" },
];

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, group))) {
      const src = join(root, group, name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // A package without sources.
      }
    }
  }
  return roots;
}

it("memory port guard: no source outside the memory service, its store, migrations and backups names a memory table", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of sourceRoots().flatMap(sources)) {
    const path = relative(root, file).split("\\").join("/");
    scanned += 1;
    if (ALLOWED.some((allowed) => allowed.path.test(path))) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (SERVICE_TABLE.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  expect(scanned).toBeGreaterThan(100);
  expect(offenders, `read memory through MemoryServicePort instead:\n${offenders.join("\n")}`).toEqual([]);
});

it("memory port guard: the Center and the session list read no memory table", () => {
  for (const path of ["packages/runtime/src/persistence/center.ts", "packages/runtime/src/persistence/task-list.ts"]) {
    expect(readFileSync(join(root, path), "utf8")).not.toMatch(/\btavi_memory_/);
  }
});
