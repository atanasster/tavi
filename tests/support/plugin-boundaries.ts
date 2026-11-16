import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin packages, kits and add-ons, and the rules that keep each one
 * replaceable: what it may depend on, import and reach. Each rule is a pure
 * function over what it reads, so a test can hand it a planted violation and
 * see it caught.
 */

/** The packages a plugin is made of: the built-ins, the external plugins' sources and the engines' add-ons. */
export function pluginPackageDirectories(root: string): readonly string[] {
  const under = (directory: string): string[] =>
    readdirSync(join(root, directory))
      .filter((name) => existsSync(join(root, directory, name, "package.json")))
      .map((name) => `${directory}/${name}`);
  return [
    ...under("packages/builtin"),
    ...under("packages/external"),
    "packages/pdf-ocr",
    "packages/video-pose",
    "packages/video-transcribe",
  ];
}

/** The kits plugins are built with: shared by plugins, never one. */
export const PLUGIN_KITS: readonly string[] = [
  "packages/channel-kit",
  "packages/child-kit",
  "packages/domain-kit",
  "packages/jobs-kit",
  "packages/node-kit",
  "packages/places-kit",
  "packages/plugin-kit",
  "packages/plugin-types",
  "packages/trends-kit",
];

export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export interface PackageManifest {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export function readPackage(root: string, directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as PackageManifest;
}

/**
 * Every dependency field of `manifest` that names a plugin package other than itself: a plugin, kit or add-on that
 * depends on a plugin, by any field, is no longer replaceable on its own.
 */
export function manifestViolations(manifest: PackageManifest, pluginNames: ReadonlySet<string>): readonly string[] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(manifest[field] ?? {})
      .filter((name) => name !== manifest.name && pluginNames.has(name))
      .map((name) => `${field}: ${name}`),
  );
}

/** What no plugin, kit or add-on imports: another plugin, or Tavi's own host and applications. */
const HOST_PACKAGES: ReadonlySet<string> = new Set(["@tavi/cli", "@tavi/ui", "@tavi/agent-host", "@tavi/runtime"]);

/** The package a specifier names: its scope and name, without a subpath. */
export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * A source file's imports a plugin, kit or add-on may not make: another plugin package, the host or an
 * application, and the test support outside `test/`. `area` is the directory the file is under (`src`, `test`,
 * `scripts`).
 */
export function importViolations(
  imports: readonly string[],
  own: string,
  area: "src" | "test" | "scripts",
  pluginNames: ReadonlySet<string>,
): readonly string[] {
  return imports.filter((specifier) => {
    const named = packageOf(specifier);
    if (named === own) return false;
    if (named === "@tavi/test-support") return area !== "test";
    return pluginNames.has(named) || HOST_PACKAGES.has(named);
  });
}

/** Every source file under a package's `src/`, `test/` and `scripts/`, recursively, with the area it is in. */
export function sourceFiles(
  root: string,
  directory: string,
): readonly { readonly area: "src" | "test" | "scripts"; readonly path: string }[] {
  return (["src", "test", "scripts"] as const).flatMap((area) => {
    const base = join(root, directory, area);
    if (!existsSync(base)) return [];
    return (readdirSync(base, { recursive: true }) as string[])
      .filter((name) => /\.(?:[cm]?[jt]s|tsx)$/.test(name) && !name.split(/[\\/]/).includes("node_modules"))
      .map((name) => ({ area, path: `${area}/${name.split("\\").join("/")}` }));
  });
}

/**
 * A plugin-kit file's imports that leave its area: any of Tavi's but contracts, or a relative one that resolves out
 * of its own directory under `src/` (its kind, such as `src/memory/`) into anything but the kit's shared
 * `src/conformance/`. `path` is the file under the kit, such as `src/memory/conformance/recall.ts`; a file of the
 * shared `src/conformance/` itself may reach only into it.
 */
export function kindImportViolations(path: string, imports: readonly string[]): readonly string[] {
  const area = path.split("/").slice(0, 2).join("/");
  return imports.filter((specifier) => {
    if (specifier.startsWith("@tavi/")) return !specifier.startsWith("@tavi/contracts");
    if (!specifier.startsWith(".")) return false;
    const target = resolvedUnder(path, specifier);
    return target === undefined || !(target.startsWith(`${area}/`) || target.startsWith("src/conformance/"));
  });
}

/** `relative` resolved from the directory of `path` (both under one package root), or undefined once it leaves it. */
function resolvedUnder(path: string, relative: string): string | undefined {
  const at = path.split("/").slice(0, -1);
  for (const part of relative.split(/[\\/]/)) {
    if (part === "..") {
      if (at.length === 0) return undefined;
      at.pop();
    } else if (part !== "." && part !== "") at.push(part);
  }
  return at.join("/");
}

/**
 * The relative specifiers a file under a package (`path`, such as `src/a/b.ts`) uses that land outside the package:
 * code that reaches into a neighbour's files is no longer the package's own.
 */
export function escapingSpecifiers(path: string, specifiers: readonly string[]): readonly string[] {
  return specifiers.filter((specifier) => specifier.startsWith(".") && resolvedUnder(path, specifier) === undefined);
}

/** What a file names its own directory as: `import.meta.dirname`, `__dirname`, its `dirname(fileURLToPath(import.meta.url))`, or the `here` or `beside` it keeps it in. */
const OWN_DIRECTORY = String.raw`(?:import\.meta\.dirname|__dirname|dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|here|beside)`;

/**
 * The paths a file builds from its own directory that climb out of the package: `join` or `resolve` of its own
 * directory and string segments (`"..", "x"` or `"../x"`), and `new URL("…", import.meta.url)`. A path built from
 * another base (a test's temporary directory, an argument) is not the package's to keep in.
 */
export function escapingPaths(path: string, text: string): readonly string[] {
  const joined = [...text.matchAll(new RegExp(String.raw`\b(?:join|resolve)\(\s*${OWN_DIRECTORY}\s*((?:,\s*["'][^"'\n]*["']\s*)+)`, "g"))]
    .filter((match) => {
      const segments = [...(match[1] ?? "").matchAll(/["']([^"'\n]*)["']/g)].map((segment) => segment[1] ?? "");
      return resolvedUnder(path, `${segments.join("/")}/x`) === undefined;
    })
    .map((match) => match[0]);
  const urls = [...text.matchAll(/new URL\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g)]
    .filter((match) => (match[1] ?? "").startsWith(".") && resolvedUnder(path, match[1] ?? "") === undefined)
    .map((match) => match[0]);
  return [...joined, ...urls];
}

/** The scripts of a package's manifest whose command reaches a path outside the package. */
export function escapingScripts(manifest: PackageManifest): readonly string[] {
  return Object.entries(manifest.scripts ?? {})
    .filter(([, command]) => /(?:^|[\s="'])\.\.[\\/]|\bcd\s+\.\.(?:\s|$|[\\/;&])/.test(command))
    .map(([name]) => name);
}

/**
 * Who in `apps/cli/src` may import each plugin package: one owner module puts it together (its host), so every
 * other file sees only the ports. Each entry names the files and, where an owner takes only some of a package,
 * the subpaths it may.
 */
export interface CompositionOwner {
  readonly packages: readonly string[];
  readonly owners: Readonly<Record<string, readonly string[] | "any">>;
}

/**
 * Each import of a plugin package in `imports` (by file under `apps/cli/src`) that its table entry does not allow,
 * as `<file>: <specifier>`; a plugin package no entry names is never allowed.
 */
export function compositionViolations(
  imports: ReadonlyMap<string, readonly string[]>,
  table: readonly CompositionOwner[],
  pluginNames: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  for (const [file, specifiers] of imports)
    for (const specifier of specifiers) {
      const named = packageOf(specifier);
      if (!pluginNames.has(named)) continue;
      const entry = table.find((candidate) => candidate.packages.includes(named));
      const allowed = entry?.owners[file];
      const subpath = specifier.slice(named.length) || ".";
      if (allowed === undefined || (allowed !== "any" && !allowed.includes(subpath.replace(/^\//, "./"))))
        out.push(`${file}: ${specifier}`);
    }
  return out;
}

/** The source files a package's `tsdown.config.ts` builds: every `src/…` path its entries name. */
export function tsdownEntries(config: string): readonly string[] {
  return [...new Set([...config.matchAll(/["'](?:\.\/)?(src\/[^"']+\.(?:[cm]?ts|tsx))["']/g)].map((match) => match[1] ?? ""))].sort();
}

/** The source files a package's built `exports` are made from: each export with a built target, by its source. */
export function exportedSources(manifest: PackageManifest): readonly string[] {
  return Object.entries(manifest.exports ?? {})
    .flatMap(([subpath, target]) => {
      // A string export names a file shipped as written (`./package.json`, a script); one into `dist/` is built
      // output with no source to build it from.
      if (typeof target === "string") return target.startsWith("./dist/") ? [`unbuildable: ${subpath}`] : [];
      if (typeof target !== "object" || target === null) return [];
      const conditions = target as Record<string, unknown>;
      // A development-only export (a conformance suite, read by tests from its source) is not built.
      if (conditions["import"] === undefined) return [];
      const source = conditions["development"];
      return [typeof source === "string" ? source.replace(/^\.\//, "") : `unbuildable: ${subpath}`];
    })
    .sort();
}

/**
 * How a package's built entries differ from what it exports, `spawnOnly` aside (files spawned or loaded by path,
 * never imported): an entry nothing exports, or an export nothing builds.
 */
export function entryPointViolations(
  entries: readonly string[],
  exported: readonly string[],
  spawnOnly: readonly string[] = [],
): readonly string[] {
  return [
    ...entries.filter((entry) => !exported.includes(entry) && !spawnOnly.includes(entry)).map((entry) => `built, not exported: ${entry}`),
    ...exported.filter((source) => !entries.includes(source)).map((source) => `exported, not built: ${source}`),
    // A spawn-only file that is no longer built is a stale entry in the list.
    ...spawnOnly.filter((file) => !entries.includes(file)).map((file) => `spawned, not built: ${file}`),
  ];
}

/**
 * The statements of `text` that take something of `pkg` at run time: an import or re-export of it that is not
 * `import type` or `export type`. What should be types only stays types only.
 */
export function valueImportsOf(text: string, pkg: string): readonly string[] {
  const statement = new RegExp(
    String.raw`(?:^|\n)[ \t]*((?:import|export)\b[^;]*?\sfrom\s*["']${pkg.replace(/[/\-.]/g, (c) => `\\${c}`)}(?:\/[^"']*)?["'])`,
    "g",
  );
  return [...text.matchAll(statement)]
    .map((match) => (match[1] ?? "").trim())
    .filter((found) => !/^(?:import|export)\s+type\b/.test(found));
}
