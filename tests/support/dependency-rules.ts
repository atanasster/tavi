import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The headless closure's dependency rules, in one
 * place: the workspace gate (`boundaries.test.ts`) and the release gate
 * (`release.test.ts`) read the same table, so the two cannot drift.
 */

/**
 * Never in the headless closure: a desktop shell, a DOM renderer, a browser;
 * a native canvas, an AGPL PDF library, and a PDF parser that needs one;
 * and the PDF engine that requires UI frameworks as peers.
 */
export const HEADLESS_FORBIDDEN = [
  "electron",
  "react-dom",
  "playwright",
  "@playwright/test",
  "puppeteer",
  "chromium",
  "@napi-rs/canvas",
  "canvas",
  "mupdf",
  "pdf-parse",
  "@embedpdf/engines",
  "ffmpeg-static",
  "@ffmpeg-installer/ffmpeg",
  "@ffmpeg/ffmpeg",
  "@ffmpeg/core",
  "fluent-ffmpeg",
] as const;

/**
 * UI frameworks no package in the headless graph may require as a peer:
 * peers are declared per package, not per
 * export, so a library that requires one installs it whatever subpath is
 * used. The TUI's own stack (`TUI_STACK`, the CLI's alone) is ruled below.
 */
const FRAMEWORK_PEERS = ["react", "react-dom", "vue", "preact", "svelte"] as const;

/** The framework peers `manifest` requires (a peer is required unless marked optional). */
export function requiredFrameworkPeers(manifest: DependencyManifest): string[] {
  return Object.entries(manifest.peerDependencies ?? {})
    .map(([key, range]) => [key, declaredTarget(key, range)] as const)
    .filter(
      ([key, target]) => (FRAMEWORK_PEERS as readonly string[]).includes(target) && manifest.peerDependenciesMeta?.[key]?.optional !== true,
    )
    .map(([, target]) => target);
}

/**
 * Licences a shipped dependency may carry:
 * permissive ones, and OFL-1.1 for fonts. AGPL and GPL code comes only from
 * what a person installs themselves.
 */
const LICENCE_ALLOWLIST = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "OFL-1.1"] as const;

/** Per-package exceptions, each a decision: `name` → the licence string it ships under. */
const LICENCE_EXCEPTIONS: Readonly<Record<string, string>> = {};

/**
 * Whether an SPDX expression is allowed: a listed licence; an `OR` of which
 * one alternative is (the consumer may choose it); an `AND` whose every part
 * is. Parentheses nest, and `AND` binds tighter than `OR`. Anything
 * unparsed, absent or not a string is refused.
 */
export function licenceAllowed(name: string, licence: unknown): boolean {
  if (typeof licence !== "string") return false;
  if (LICENCE_EXCEPTIONS[name] === licence) return true;
  const tokens = licence.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  // or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := "(" or ")" | id
  const atom = (): boolean | undefined => {
    const token = tokens[at++];
    if (token === "(") {
      const inner = or();
      return tokens[at++] === ")" ? inner : undefined;
    }
    if (token === undefined || token === ")" || token === "AND" || token === "OR") return undefined;
    return (LICENCE_ALLOWLIST as readonly string[]).includes(token);
  };
  const and = (): boolean | undefined => {
    let result = atom();
    while (result !== undefined && tokens[at] === "AND") {
      at += 1;
      const next = atom();
      result = next === undefined ? undefined : result && next;
    }
    return result;
  };
  const or = (): boolean | undefined => {
    let result = and();
    while (result !== undefined && tokens[at] === "OR") {
      at += 1;
      const next = and();
      result = next === undefined ? undefined : result || next;
    }
    return result;
  };
  const allowed = or();
  return allowed === true && at === tokens.length;
}

export interface InstalledEntry {
  readonly directory: string;
  readonly manifest: DependencyManifest & {
    readonly version?: string;
    readonly license?: unknown;
    readonly private?: boolean;
    readonly taviBundled?: readonly string[];
  };
}

/** Node's lookup: the nearest `node_modules/<name>` at or above `from`, by its real path. */
function resolveFrom(from: string, name: string): string | undefined {
  let directory = from;
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * What the headless packages reach in the workspace's own install: their
 * dependencies, required peers and installed optional dependencies, at every
 * depth. A package's `taviBundled` development dependencies count as its
 * dependencies: their code ships inside its build (`@tavi/plugin-pdf`'s
 * child), so their licences and peers are the install's too. The CLI's TUI
 * stack is left out (it is ruled per package by `DEPENDENCY_EXCEPTIONS`), as
 * are other devDependencies. `bundled: "skip"` walks a packed install, where
 * bundled packages are not installed.
 */
export function installedClosure(
  root: string,
  directories: readonly string[],
  options: { readonly bundled: "walk" | "skip" } = { bundled: "walk" },
): InstalledEntry[] {
  const seen = new Map<string, InstalledEntry>();
  const queue = directories.map((directory) => realpathSync(join(root, directory)));
  while (queue.length > 0) {
    const directory = queue.pop() as string;
    if (seen.has(directory)) continue;
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as InstalledEntry["manifest"];
    seen.set(directory, { directory, manifest });
    const tui = manifest.name === "@tavi/cli" ? (TUI_STACK as readonly string[]) : [];
    const required = [
      ...Object.keys(manifest.dependencies ?? {}).filter((name) => !tui.includes(name)),
      // Bundled code is not installed from a packed artifact; the release gate checks its notices ship instead.
      ...(options.bundled === "walk" ? (manifest.taviBundled ?? []) : []),
      ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => manifest.peerDependenciesMeta?.[name]?.optional !== true),
    ];
    for (const name of required) {
      const found = resolveFrom(directory, name);
      if (found === undefined) throw new Error(`${name} (from ${manifest.name ?? directory}) is not installed`);
      queue.push(found);
    }
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const found = resolveFrom(directory, name);
      if (found !== undefined) queue.push(found);
    }
  }
  return [...seen.values()];
}

/**
 * The TUI's stack, ruled per package: `react`, and what only a React renderer
 * needs — Ink, and the reconciler under it. Ink's required peer is `react`, so
 * a package declaring Ink reaches React whatever its own manifest says.
 */
const TUI_STACK = ["react", "ink", "react-reconciler"] as const;

/** Every name the rules govern: the forbidden list, and the TUI's stack. */
const RULED: readonly string[] = [...HEADLESS_FORBIDDEN, ...TUI_STACK];

export const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
export type Section = (typeof SECTIONS)[number];

/** By package name, so the workspace manifests and the packed ones read the same table. */
const DEPENDENCY_EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, readonly Section[]>>>> = {
  // The TUI: React and Ink, in the CLI and nowhere else. The CLI
  // declares no reconciler of its own; Ink brings it.
  "@tavi/cli": { react: ["dependencies", "devDependencies"], ink: ["dependencies"] },
  // An optional peer npm does not install, and the tests' own copy.
  "@tavi/plugin-browser": { playwright: ["devDependencies", "peerDependencies"] },
};

/** Whether `pkg` may declare `dependency` in `section`. */
export function isAllowed(pkg: string, dependency: string, section: Section): boolean {
  if (!RULED.includes(dependency)) return true;
  return DEPENDENCY_EXCEPTIONS[pkg]?.[dependency]?.includes(section) === true;
}

/** The package a declared entry installs: its key, or an npm alias's target. */
export function declaredTarget(key: string, range: string): string {
  return /^npm:((?:@[^/@]+\/)?[^@/]+)(?:@|$)/.exec(range)?.[1] ?? key;
}

export interface DependencyManifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

/** Every declared entry the rules refuse, as `<name> in <section>`. */
export function violations(pkg: string, manifest: DependencyManifest): string[] {
  const found: string[] = [];
  for (const section of SECTIONS) {
    for (const [key, range] of Object.entries(manifest[section] ?? {})) {
      const target = declaredTarget(key, range);
      if (!isAllowed(pkg, target, section)) found.push(`${target} in ${section}`);
      if (TEST_SUPPORT_NAMES.includes(target) && section !== "devDependencies") found.push(`${target} in ${section}`);
      const only = ADD_ON_ONLY[target];
      if (only !== undefined && only !== pkg) found.push(`${target} outside ${only}`);
    }
  }
  // A peer is installed unless it is optional; an excepted forbidden peer must be.
  for (const [key, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const target = declaredTarget(key, range);
    if ((HEADLESS_FORBIDDEN as readonly string[]).includes(target) && manifest.peerDependenciesMeta?.[key]?.optional !== true) {
      found.push(`${target} as a required peer`);
    }
  }
  return found;
}

/** The workspace globs this module expands: `workspaceGlobs` must read exactly these. */
export const WORKSPACE_GLOBS = ["apps/*", "packages/*", "packages/builtin/*", "packages/external/*"] as const;

/**
 * The `packages` globs `pnpm-workspace.yaml` declares. Read so a glob added
 * there fails the gates (`boundaries.test.ts`) until this module expands it,
 * instead of leaving its packages outside both of them. It reads the block
 * list this repository writes (`packages:` then `- "glob"` lines); another
 * YAML layout reads as no globs and fails that test too, never passes it.
 */
export function workspaceGlobs(repositoryRoot: string): string[] {
  const yaml = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(yaml)?.[1] ?? "";
  return [...block.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((match) => match[1] ?? "");
}

/**
 * Every workspace package, from `pnpm-workspace.yaml`'s globs
 * (`WORKSPACE_GLOBS`): read from the tree, so a new package is inside both
 * gates unless someone decides otherwise.
 */
export function workspacePackageDirectories(repositoryRoot: string): string[] {
  const directories: string[] = [];
  for (const parent of WORKSPACE_GLOBS.map((glob) => glob.replace(/\/\*$/, ""))) {
    for (const entry of readdirSync(join(repositoryRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(repositoryRoot, parent, entry.name, "package.json"))) {
        directories.push(`${parent}/${entry.name}`);
      }
    }
  }
  return directories.sort();
}

/**
 * Workspace packages outside the headless closure, each listed deliberately,
 * never by omission: the web canvas (`apps/ui`) is a static
 * bundle `@tavi/cli`'s build copies into its `ui-dist/`. It is never packed or
 * installed, so its React DOM and Vite reach no consumer.
 */
export const NOT_HEADLESS: readonly string[] = ["apps/ui"];

/**
 * Add-ons a person installs beside `tavi`: packed
 * and held to every pack and licence rule, but no package depends on them, so
 * the CLI's closure does not reach them.
 */
export const ADD_ONS: readonly string[] = ["@tavi/pdf-ocr", "@tavi/video-pose", "@tavi/video-transcribe"];

/**
 * Packages only an add-on may hold: allowed
 * in that add-on's graph, refused in every other manifest, so the CLI's
 * closure never reaches them. Not `HEADLESS_FORBIDDEN`: the install gate
 * installs the add-ons too, and refuses a forbidden package at any depth.
 */
export const ADD_ON_ONLY: Readonly<Record<string, string>> = { "onnxruntime-node": "@tavi/video-pose" };

/**
 * The sources of the external plugins this repository ships (docs/JOBS.md, docs/TRENDS.md, docs/PLACES.md):
 * each built into one bundle a person installs with `tavi plugins install`,
 * its kits inside it. No `tavi` package depends on them, so a `tavi` install
 * neither packs nor reaches them; their licences are still checked.
 */
export const EXTERNAL_PLUGIN_SOURCES: readonly string[] = [
  "packages/domain-kit",
  "packages/jobs-kit",
  "packages/external/jobs",
  "packages/trends-kit",
  "packages/external/trends",
  "packages/external/discord",
  "packages/places-kit",
  "packages/external/places-open",
  "packages/external/places-care",
];

/**
 * Test code's own packages: private, never packed, and only ever a
 * devDependency (`violations` refuses one anywhere else), so no install
 * reaches them. Only test files import them.
 */
export const TEST_SUPPORT: readonly string[] = ["packages/test-support"];

/** `TEST_SUPPORT` by package name. */
export const TEST_SUPPORT_NAMES: readonly string[] = ["@tavi/test-support"];

/**
 * Packages nothing wires into the runtime yet (docs/DESKTOP.md): no `tavi`
 * package depends on them and no add-on installs them, so a release neither
 * packs nor reaches them. Their manifests and licences are still checked, and
 * the entry leaves this list in the change that makes a package depend on it.
 */
export const NOT_YET_WIRED: readonly string[] = [];

/**
 * The workspace packages a `tavi` install is made of: every one but `NOT_HEADLESS`, the external plugins' sources,
 * test support and the packages not yet wired.
 */
export function headlessPackageDirectories(repositoryRoot: string): string[] {
  return workspacePackageDirectories(repositoryRoot).filter(
    (directory) =>
      !NOT_HEADLESS.includes(directory) &&
      !EXTERNAL_PLUGIN_SOURCES.includes(directory) &&
      !TEST_SUPPORT.includes(directory) &&
      !NOT_YET_WIRED.includes(directory),
  );
}

export function readManifest(repositoryRoot: string, directory: string): DependencyManifest & Record<string, unknown> {
  return JSON.parse(readFileSync(join(repositoryRoot, directory, "package.json"), "utf8")) as DependencyManifest & Record<string, unknown>;
}
