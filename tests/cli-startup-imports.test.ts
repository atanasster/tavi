import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importedBy, staticallyImportedBy } from "./support/imports.js";

/**
 * What a CLI command loads before its own code runs: the static import graph of
 * the built entry, and of the chunk each light command's handler is loaded from.
 *
 * `tavi --version` used to load one 3.84 MB chunk holding the owner runtime, the
 * workflow and the plugins, because `main.ts` imported every command handler
 * (and the owner's `serve.ts`) statically. Each handler is now loaded by its own
 * `case`, and what only one path needs is loaded on that path. A static import
 * that drags one of these back in fails here, before it reaches anyone's start-up.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps/cli/dist");
const runtimeDist = join(root, "packages/runtime/dist");

/** The packages no light path may load up front. */
const HEAVY = [
  "@tavi/agent-host/workflow",
  "@tavi/runtime",
  "@tavi/plugin-browser",
  "@tavi/plugin-pdf",
  "@tavi/plugin-video",
  "@tavi/plugin-sandbox",
  "rolldown",
];
/** The host allowlist language alone: a pure module with no runtime behind it, which the CLI's flag check needs. */
const ALLOWED = new Set(["@tavi/runtime/host-policy"]);

function heavy(specifier: string): boolean {
  if (ALLOWED.has(specifier)) return false;
  return HEAVY.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** Each heavy package a built file reaches through static imports, with the chunk that imports it. */
function heavyReachedFrom(start: string): string[] {
  return staticGraphOf(start).flatMap((file) =>
    staticallyImportedBy(readFileSync(file, "utf8"))
      .filter(heavy)
      .map((specifier) => `${specifier} (from ${file.slice(dist.length + 1)})`),
  );
}

/** The sources a built CLI file was bundled from, read from its source map. */
function sourcesOf(file: string): string[] {
  return (JSON.parse(readFileSync(`${file}.map`, "utf8")) as { sources: string[] }).sources;
}

/** The built chunk a source module was bundled into, read from the chunks' source maps. */
function chunkOf(source: string): string {
  const chunks = readdirSync(dist).filter(
    (file) =>
      file.endsWith(".mjs.map") && sourcesOf(join(dist, file.replace(/\.map$/, ""))).some((path) => path.endsWith(`/src/${source}`)),
  );
  expect(chunks, `the chunk that holds src/${source}`).toHaveLength(1);
  return join(dist, (chunks[0] ?? "").replace(/\.map$/, ""));
}

/** Every built file a file reaches through static imports, itself included. */
function staticGraphOf(start: string): string[] {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    expect(existsSync(file), `Missing built module: ${file}; run the build`).toBe(true);
    visited.add(file);
    for (const specifier of staticallyImportedBy(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier));
    }
  }
  return [...visited];
}

describe("CLI start-up imports", () => {
  it("loads no owner runtime, workflow, plugin or bundler for --version and --help", () => {
    // The executable imports `main` only after its Node.js check, so the check runs on a Node.js too old for the rest.
    expect(staticGraphOf(join(dist, "executable.mjs"))).not.toContain(join(dist, "main.mjs"));
    expect(heavyReachedFrom(join(dist, "executable.mjs"))).toEqual([]);
    expect(heavyReachedFrom(join(dist, "main.mjs"))).toEqual([]);
  });

  // `tavi tasks` and an attached `tavi run` ask the owner over IPC; `tavi chat` is the
  // TUI over the owner. What their offline paths need is loaded when they take them.
  it.each([
    ["tasks", "features/tasks/client.ts"],
    ["run", "features/run/client.ts"],
    ["chat", "tui/index.ts"],
  ])("loads none of them up front for `tavi %s`", (_command, source) => {
    expect(heavyReachedFrom(chunkOf(source))).toEqual([]);
  });

  // Attaching asks for the discovery files, the ownership probe and the IPC client
  // alone: `@tavi/runtime/owner-attach`, never the runtime's root, whose import
  // loads the SQLite loader and every repository and service.
  it("attaches to a live owner without loading the runtime's root", () => {
    for (const source of ["cli/live-owner.ts", "cli/owner-connection.ts"]) {
      const runtime = new Set(
        importedBy(readFileSync(chunkOf(source), "utf8")).filter((specifier) => specifier.startsWith("@tavi/runtime")),
      );
      expect([...runtime], `what src/${source}'s chunk loads from @tavi/runtime`).toEqual(["@tavi/runtime/owner-attach"]);
    }
    // The runtime ships no source maps, so the database client and the SQLite loader are found by their definitions.
    for (const file of staticGraphOf(join(runtimeDist, "owner-attach.mjs"))) {
      const text = readFileSync(file, "utf8");
      const loaded = importedBy(text).filter((specifier) => specifier === "better-sqlite3" || specifier.startsWith("@tavi/runtime"));
      expect(loaded, `what ${file} loads`).toEqual([]);
      expect(text, `${file} defines the database client`).not.toMatch(/\bDatabaseClient = class\b|\bclass DatabaseClient\b/u);
      expect(text, `${file} defines the SQLite loader`).not.toMatch(/\bfunction loadBetterSqlite3\b/u);
    }
  });
});
