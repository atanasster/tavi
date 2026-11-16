import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { needsPosix, removeTemporaryDirectories, temporaryDirectory } from "@tavi/test-support";

import {
  ADD_ONS,
  ADD_ON_ONLY,
  HEADLESS_FORBIDDEN,
  headlessPackageDirectories,
  installedClosure,
  licenceAllowed,
  requiredFrameworkPeers,
  violations,
  type DependencyManifest,
} from "./support/dependency-rules.js";
import { chatRecording } from "./support/chat-recording.js";
import { importedBy } from "./support/imports.js";
import { run } from "./support/process.js";
import { directorySize, walk } from "./support/tree.js";
import { underTerminal } from "./support/terminal.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/**
 * Headless release packaging and install isolation.
 *
 * Two gates live here that no package-local suite can check:
 *
 *  - **the packed artifacts are the release** (always run, hermetic): only built
 *    output ships, the published `exports` map has no source condition, workspace
 *    ranges are concrete, every declared export target exists, and the dependency
 *    closure that a consumer actually resolves contains no desktop or browser
 *    package;
 *  - **a clean install runs** (opt-in, `TAVI_RELEASE_INSTALL=1` or
 *    `pnpm run test:release`): the tarballs are installed into a tree outside the
 *    repository with the ordinary installer, and the installed CLI composes its
 *    runtime there — which exercises the shipped entry points, the migrations and
 *    the native SQLite binding in a tree that never saw the monorepo.
 *
 * The install half needs the public registry, an `npm` on `PATH` and POSIX `tar`,
 * so it is not part of the default suite: `pnpm check` must pass offline. When it
 * is skipped it says so, loudly, because a packaging gate that silently does not
 * run is worse than one that fails.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installGateEnabled = process.env["TAVI_RELEASE_INSTALL"] === "1";
if (!installGateEnabled) {
  // Loud on purpose: a packaging gate that silently does not run is worse than
  // one that fails, so the skip is visible in the default suite's output.
  console.warn(
    "release install gate skipped: run `pnpm run test:release` (TAVI_RELEASE_INSTALL=1) to install " +
      "the packed artifacts and run the installed CLI",
  );
}

interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  tarball?: string;
}

/**
 * Everything a `tavi` install needs, packed: every workspace package but the
 * web canvas (whose build ships inside `@tavi/cli`), read from the tree as the
 * workspace gate reads it. That includes the private built-in plugin
 * packages (`packages/builtin/*`), which exist nowhere but here (an install
 * of the CLI alone would ask the registry for them), and the client front
 * ends share.
 */
const packages: WorkspacePackage[] = headlessPackageDirectories(repositoryRoot).map((directory) => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, directory, "package.json"), "utf8")) as Record<string, unknown>;
  return { directory, name: String(manifest["name"]), manifest };
});

/** Entry stems each pack must not ship: test-only surfaces. */
const TEST_ONLY: Readonly<Record<string, readonly string[]>> = {
  "@tavi/channel-kit": ["conformance"],
  "@tavi/plugin-kit": ["heartbeat/conformance", "ideas/conformance", "memory/conformance", "onboarding/conformance"],
};

/**
 * What `tavi chat --stats` writes, as far as the gate reads it: the twin of
 * `ChatStats` in `apps/cli/src/tui/index.ts`, restated because the gate reads
 * the installed artifact, not the workspace's source.
 */
interface ChatStats {
  readonly events: number;
  readonly deltas: number;
  readonly treeUpdates: number;
  readonly renders: number;
  readonly committedLines: number;
  readonly peakRssBytes: number;
  readonly heapUsedBytes: number;
  readonly collected: boolean;
  readonly reactBuild: "production" | "development" | "unknown";
  readonly rows: number;
  readonly columns: number;
}

/** Ink's full-terminal clear, scrollback included (Ink issue #990); `apps/cli/test/support/fake-tty.ts` has its twin. */
const CLEAR_SCROLLBACK = `${String.fromCharCode(27)}[3J`;

/**
 * `tavi chat`'s memory budgets, over a baseline of about 150 MiB
 * that the CLI's own start costs. Measured on the installed CLI at 190 MiB
 * peak and 48 MiB retained for 10,000 deltas, and 4 MiB more retained for
 * 100,000; the development reconciler alone would retain ~148 MiB.
 */
const CHAT_PEAK_RSS_BUDGET = 400 * 2 ** 20;
const CHAT_HEAP_BUDGET = 96 * 2 ** 20;
const CHAT_HEAP_SLOPE_BUDGET = 24 * 2 ** 20;

/** Development-only tooling a release consumer must not receive. */
// The upstream checkpoint saver is a test oracle only; it would also install a second native better-sqlite3.
const DEV_ONLY = ["tsdown", "typescript", "vitest", "turbo", "@langchain/langgraph-checkpoint-sqlite"];

let packDirectory = "";

function tarballPath(entry: WorkspacePackage): string {
  if (entry.tarball === undefined) throw new Error(`${entry.name} was not packed`);
  return entry.tarball;
}

function packedExports(entry: WorkspacePackage): Record<string, unknown> {
  return (entry.manifest["publishConfig"] as { readonly exports?: Record<string, unknown> } | undefined)?.exports ?? {};
}

/** The entries of a packed artifact. */
// Each tarball is read once: every test walks every pack, and a `tar` per package per test is slow.
const entriesByTarball = new Map<string, readonly string[]>();
const manifestByTarball = new Map<string, Record<string, unknown>>();

function tarballEntries(tarball: string): readonly string[] {
  let entries = entriesByTarball.get(tarball);
  if (entries === undefined) {
    // Windows's bsdtar ends its lines with CRLF.
    entries = run("tar", ["-tzf", tarball], { encoding: "utf8", cwd: repositoryRoot })
      .split(/\r?\n/)
      .filter((line) => line !== "");
    entriesByTarball.set(tarball, entries);
  }
  return entries;
}

/** The manifest exactly as a consumer receives it. */
function packedManifest(tarball: string): Record<string, unknown> {
  let manifest = manifestByTarball.get(tarball);
  if (manifest === undefined) {
    manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8", cwd: repositoryRoot })) as Record<
      string,
      unknown
    >;
    manifestByTarball.set(tarball, manifest);
  }
  return manifest;
}

/** One installed package, as the tree resolved it. */
interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
}

/**
 * Every package `node_modules` contains at any depth.
 *
 * The whole tree is walked, not just its top level: a forbidden or dev-only
 * package nested under a dependency is exactly what a top-level scan misses, and
 * nested copies are how a native module ends up installed twice.
 */
function installedPackages(nodeModulesRoot: string): readonly InstalledPackage[] {
  const found: InstalledPackage[] = [];
  for (const entry of walk(nodeModulesRoot)) {
    if (!entry.isDirectory) continue;
    // A package directory sits directly in `node_modules`, or in a scope folder
    // inside it — which is why the check is on the parent's own name.
    const parentName = basename(dirname(entry.path));
    if (parentName !== "node_modules" && !parentName.startsWith("@")) continue;
    const manifestPath = join(entry.path, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      readonly name?: string;
      readonly version?: string;
    };
    if (manifest.name === undefined) continue;
    found.push({
      name: manifest.name,
      version: manifest.version ?? "unknown",
      directory: entry.path,
    });
  }
  return found;
}

/** Node's own lookup: the nearest installed `<name>` at or above `from`. */
function resolveInstalled(installed: readonly InstalledPackage[], name: string, from: string): InstalledPackage {
  let directory = from;
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    const match = installed.find((entry) => entry.directory === candidate);
    if (match !== undefined) return match;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`${name} is not installed at or above ${from}`);
}

function readInstalledManifest(entry: InstalledPackage): DependencyManifest {
  return JSON.parse(readFileSync(join(entry.directory, "package.json"), "utf8")) as DependencyManifest;
}

/** Everything `root` reaches: its dependencies, its required peers, and the optional ones installed. */
function closureOf(installed: readonly InstalledPackage[], root: InstalledPackage): Map<string, InstalledPackage> {
  const seen = new Map<string, InstalledPackage>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current.directory)) continue;
    seen.set(current.directory, current);
    const manifest = readInstalledManifest(current);
    const required = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => manifest.peerDependenciesMeta?.[name]?.optional !== true),
    ];
    for (const name of required) queue.push(resolveInstalled(installed, name, current.directory));
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      try {
        queue.push(resolveInstalled(installed, name, current.directory));
      } catch {
        // Not installed on this platform: an optional dependency may be absent.
      }
    }
  }
  return seen;
}

beforeAll(() => {
  // The artifacts are what is under test, so build them once (turbo-cached).
  run(process.execPath, [join(repositoryRoot, "scripts", "pnpmw.mjs"), "run", "build"], {
    encoding: "utf8",
    cwd: repositoryRoot,
  });
  packDirectory = temporaryDirectory("tavi-release-pack-");
  for (const entry of packages) {
    const before = new Set(readdirSync(packDirectory));
    run(
      process.execPath,
      [join(repositoryRoot, "scripts", "pnpmw.mjs"), "--filter", `./${entry.directory}`, "pack", "--pack-destination", packDirectory],
      {
        encoding: "utf8",
        cwd: repositoryRoot,
      },
    );
    // Discover what packing produced and confirm it by manifest, rather than
    // reconstructing pnpm's filename format (which does not round-trip a
    // prerelease or build-metadata version).
    const produced = readdirSync(packDirectory)
      .filter((name) => !before.has(name) && name.endsWith(".tgz"))
      .map((name) => join(packDirectory, name));
    const mine = produced.filter((tarball) => packedManifest(tarball)["name"] === entry.name);
    const [tarball] = mine;
    if (mine.length !== 1 || tarball === undefined) {
      throw new Error(`packing ${entry.name} produced ${mine.length} tarballs: ${produced.join(", ")}`);
    }
    entry.tarball = tarball;
  }
}, 600_000);

afterAll(() => {
  removeTemporaryDirectories();
});

// Windows 10 and later ship bsdtar as `tar`, and pnpm runs through node, so this half runs everywhere.
describe("packed release artifacts", { timeout: 60_000 }, () => {
  it("ships only built output", () => {
    for (const entry of packages) {
      const entries = tarballEntries(tarballPath(entry));
      expect(entries).toContain("package/package.json");
      // pnpm packs the repository's MIT licence into each package, so its notice travels with every copy.
      expect(entries, entry.name).toContain("package/LICENSE");
      for (const path of entries) {
        // The prefix check is the real guard; no sources, tests, fixtures or
        // installed dependencies may ship.
        // The CLI also ships the web canvas's build, beside `dist/`:
        // its page and tab icon, hashed scripts, stylesheet and bundled font
        // assets (KaTeX's stylesheet references woff2, woff and ttf faces, so
        // all three ship), plus the built-in UI plugins' built files under
        // `plugins/<id>/`.
        const canvas =
          entry.name === "@tavi/cli" &&
          (path === "package/ui-dist/index.html" ||
            path === "package/ui-dist/favicon.svg" ||
            path === "package/ui-dist/THIRD-PARTY-NOTICES.txt" ||
            /^package\/ui-dist\/assets\/[^/]+\.(js|css|woff2|woff|ttf)$/.test(path) ||
            /^package\/ui-dist\/plugins\/[^/]+\/[^/]+\.(html|js|css|svg)$/.test(path));
        // The PDF writer's core font ships as data, with its licence.
        const font =
          entry.name === "@tavi/plugin-pdf" &&
          (path === "package/assets/NotoSans-Regular.ttf" || path === "package/assets/NotoSans-OFL.txt");
        // The confined browser's wrapper and shim run as they are, as Playwright's executable and inside the sandbox.
        const browserBin =
          entry.name === "@tavi/plugin-browser" &&
          (path === "package/bin/confined-chromium.mjs" || path === "package/bin/chromium-shim.mjs");
        // Desktop control's helper ships as its Swift source, compiled on the Mac it runs on: never a binary built here.
        const desktopHelper = entry.name === "@tavi/plugin-desktop" && path === "package/native/helper.swift";
        expect(
          path === "package/package.json" ||
            path === "package/LICENSE" ||
            path.startsWith("package/dist/") ||
            canvas ||
            font ||
            browserBin ||
            desktopHelper,
          `${entry.name}: ${path}`,
        ).toBe(true);
        expect(path).not.toContain("node_modules");
      }
    }
  });

  it("ships what a package bundles with its notices, and PDFium's wasm beside the PDF parser", () => {
    // Bundled code is not installed, so its licences ship in the build.
    for (const entry of packages) {
      const manifest = packedManifest(tarballPath(entry));
      if (!Array.isArray(manifest["taviBundled"])) continue;
      const entries = tarballEntries(tarballPath(entry));
      expect(entries, entry.name).toContain("package/dist/THIRD-PARTY-NOTICES.txt");
      for (const name of manifest["taviBundled"] as string[])
        expect(Object.keys((manifest["dependencies"] ?? {}) as Record<string, string>), `${entry.name} bundles ${name}`).not.toContain(
          name,
        );
    }
    const pdf = packages.find((entry) => entry.name === "@tavi/plugin-pdf");
    if (pdf === undefined) throw new Error("@tavi/plugin-pdf was not packed");
    expect(tarballEntries(tarballPath(pdf))).toEqual(
      expect.arrayContaining(["package/dist/child.mjs", "package/dist/pdfium.wasm", "package/assets/NotoSans-Regular.ttf"]),
    );
    // The pose add-on packs its child and its (empty) list of bundled assets, and nothing outside dist/.
    const pose = packages.find((entry) => entry.name === "@tavi/video-pose");
    if (pose === undefined) throw new Error("@tavi/video-pose was not packed");
    expect(tarballEntries(tarballPath(pose))).toEqual(
      expect.arrayContaining(["package/dist/child.mjs", "package/dist/index.mjs", "package/dist/assets.json"]),
    );
    const transcribe = packages.find((entry) => entry.name === "@tavi/video-transcribe");
    if (transcribe === undefined) throw new Error("@tavi/video-transcribe was not packed");
    expect(tarballEntries(tarballPath(transcribe))).toEqual(
      expect.arrayContaining(["package/dist/child.mjs", "package/dist/index.mjs", "package/dist/assets.json"]),
    );
    // Everything else a video add-on packs under dist/ is an asset its list names: a weight or a binary
    // dropped there without its licence fails here.
    for (const addOn of [pose, transcribe]) {
      const listed = new Set(
        (
          JSON.parse(readFileSync(join(repositoryRoot, "packages", addOn.name.replace("@tavi/", ""), "dist", "assets.json"), "utf8")) as {
            readonly assets: readonly { readonly file: string }[];
          }
        ).assets.map((asset) => `package/dist/${asset.file}`),
      );
      const unlisted = tarballEntries(tarballPath(addOn)).filter(
        (path) =>
          path.startsWith("package/dist/") && !/\.(mjs|d\.mts|map)$/.test(path) && path !== "package/dist/assets.json" && !listed.has(path),
      );
      expect(unlisted, addOn.name).toEqual([]);
    }
  });

  it("ships the LangChain-derived checkpoint saver with LangChain's licence", () => {
    // `packages/runtime/src/persistence/checkpoints.ts` is adapted from LangChain's MIT saver. Whichever pack's
    // build carries it must carry LangChain's notice too: in the same file (`/*! @license` survives bundling) or
    // in that pack's `dist/THIRD-PARTY-NOTICES.txt`.
    const marker = "Adapted from LangChain's MIT-licensed saver";
    const notice = "Copyright (c) 2024 LangChain";
    const carriers: string[] = [];
    for (const entry of packages) {
      const tarball = tarballPath(entry);
      const entries = tarballEntries(tarball);
      const read = (path: string): string => run("tar", ["-xzOf", tarball, path], { encoding: "utf8", cwd: repositoryRoot });
      const notices = entries.includes("package/dist/THIRD-PARTY-NOTICES.txt") ? read("package/dist/THIRD-PARTY-NOTICES.txt") : "";
      for (const path of entries.filter((candidate) => /^package\/dist\/.+\.mjs$/.test(candidate))) {
        const built = join(repositoryRoot, entry.directory, path.slice("package/".length));
        if (!existsSync(built) || !readFileSync(built, "utf8").includes(marker)) continue;
        const shipped = read(path);
        expect(shipped.includes(notice) || notices.includes(notice), `${entry.name}: ${path} ships without LangChain's licence`).toBe(true);
        carriers.push(`${entry.name}:${path}`);
      }
    }
    expect(carriers, "the adapted saver ships in some pack").not.toEqual([]);
  });

  it("ships the web canvas inside the CLI's pack, and nowhere else", () => {
    const cli = packages.find((entry) => entry.name === "@tavi/cli");
    if (cli === undefined) throw new Error("@tavi/cli was not packed");
    const entries = tarballEntries(tarballPath(cli));
    const builtRoot = join(repositoryRoot, "apps/ui/dist");
    const builtFiles = [...walk(builtRoot)]
      .filter((entry) => !entry.isDirectory)
      .map((entry) => `package/ui-dist/${relative(builtRoot, entry.path).split("\\").join("/")}`)
      .sort();
    expect(entries.filter((path) => path.startsWith("package/ui-dist/")).sort()).toEqual(builtFiles);
    expect(entries).toContain("package/ui-dist/index.html");
    expect(entries, "the canvas carries its bundled packages' notices").toContain("package/ui-dist/THIRD-PARTY-NOTICES.txt");
    expect(entries.some((path) => /^package\/ui-dist\/assets\/[^/]+\.js$/.test(path))).toBe(true);
    expect(packages.map((entry) => entry.name)).not.toContain("@tavi/ui");
  });

  it("ships no test-only surface in any pack", () => {
    for (const entry of packages) {
      const entries = tarballEntries(tarballPath(entry));
      for (const stem of TEST_ONLY[entry.name] ?? []) {
        expect(
          entries.filter((path) => path.startsWith(`package/dist/${stem}.`)),
          `${entry.name} ships ${stem}`,
        ).toEqual([]);
        expect(Object.keys(packedExports(entry)), `${entry.name} exports ./${stem}`).not.toContain(`./${stem}`);
      }
    }
    // The shared fakes live in the private test-support package, which is never packed or depended on.
    for (const entry of packages) {
      const manifest = packedManifest(tarballPath(entry));
      expect(
        tarballEntries(tarballPath(entry)).filter((path) => /^package\/dist\/fixture\./.test(path)),
        `${entry.name} ships a fixture`,
      ).toEqual([]);
      for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys((manifest[section] ?? {}) as Record<string, string>), `${entry.name} ${section}`).not.toContain(
          "@tavi/test-support",
        );
      }
    }
    const agentHost = packages.find((entry) => entry.name === "@tavi/agent-host");
    if (agentHost === undefined) throw new Error("agent-host package missing");
    const agentHostEntries = tarballEntries(tarballPath(agentHost));
    expect(agentHostEntries).toEqual(expect.arrayContaining(["package/dist/models.mjs", "package/dist/workflow.mjs"]));
    expect(agentHostEntries.filter((path) => /^package\/dist\/(testing|messaging-testing)\./.test(path))).toEqual([]);
  });

  // It reads every pack with `tar`: with every package packed, past the default 5 s.
  it("publishes exactly the workspace publishConfig exports, and every target exists", () => {
    for (const entry of packages) {
      const manifest = packedManifest(tarballPath(entry));
      // The packed map *is* the publishConfig map: equality catches a dropped
      // entry (the `./package.json` regression), an added source path, or a map
      // that drifted between the working tree and the artifact.
      expect(manifest["exports"], entry.name).toEqual(packedExports(entry));
      expect(manifest["exports"], entry.name).toHaveProperty(["./package.json"]);

      // `publishConfig` is a publishing instruction, not artifact content: pnpm
      // derives the map above and strips the instruction.
      expect(manifest["publishConfig"], entry.name).toBeUndefined();

      const entries = tarballEntries(tarballPath(entry));
      for (const [key, value] of Object.entries(packedExports(entry))) {
        if (typeof value === "string") {
          expect(entries, `${entry.name} ${key}`).toContain(`package/${value.replace("./", "")}`);
          continue;
        }
        for (const target of Object.values(value as Record<string, string>)) {
          // A map pointing at an entry the build did not emit is the mismatch
          // this gate exists to catch.
          expect(entries, `${entry.name} ${key} -> ${target}`).toContain(`package/${target.replace("./", "")}`);
        }
      }
    }
  }, 60_000);

  it("publishes every workspace export but the test-only ones, with the same conditions", () => {
    // In the workspace its `exports` map is in force; pnpm swaps in
    // `publishConfig.exports` only when packing. A subpath missing from the
    // latter therefore resolves in every workspace build and test, and fails
    // only in an install: the CLI importing `@tavi/agent-host/schedule-scheduler`
    // failed there with ERR_PACKAGE_PATH_NOT_EXPORTED.
    for (const entry of packages) {
      const workspace = (entry.manifest["exports"] ?? {}) as Record<string, string | Record<string, string>>;
      const published = packedExports(entry);
      const testOnly = new Set((TEST_ONLY[entry.name] ?? []).map((stem) => `./${stem}`));
      for (const key of testOnly) {
        expect(Object.keys(workspace), `${entry.name}: TEST_ONLY names ${key}, which the workspace does not export`).toContain(key);
      }
      for (const [key, value] of Object.entries(workspace)) {
        if (testOnly.has(key)) continue;
        // `development` points at source and must never ship; every other condition must.
        const { development: _source, ...conditions } = typeof value === "string" ? { default: value } : value;
        expect(published[key], `${entry.name} does not publish ${key} as the workspace declares it`).toEqual(
          typeof value === "string" ? value : conditions,
        );
      }
    }
  });

  // Every file of every packed tarball is read: seconds alone, longer beside the full suite.
  it("resolves every @tavi import in a packed file against the packed exports", () => {
    // From the artifacts, not the manifests: shipped code importing a subpath
    // that is not published (a test-only one, say) fails here, offline.
    const published = new Map(
      packages.map((entry) => [entry.name, (packedManifest(tarballPath(entry))["exports"] ?? {}) as Record<string, unknown>]),
    );
    let checked = 0;
    for (const entry of packages) {
      const unpacked = temporaryDirectory("tavi-release-unpacked-");
      run("tar", ["-xzf", tarballPath(entry), "-C", unpacked], { encoding: "utf8", cwd: repositoryRoot });
      for (const file of walk(join(unpacked, "package", "dist"))) {
        if (file.isDirectory || !/\.(mjs|d\.mts)$/.test(file.path)) continue;
        const condition = file.path.endsWith(".d.mts") ? "types" : "import";
        for (const specifier of importedBy(readFileSync(file.path, "utf8")).filter((name) => name.startsWith("@tavi/"))) {
          const [scope, name, ...rest] = specifier.split("/");
          const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
          const target = published.get(`${scope}/${name}`)?.[subpath];
          const where = `${entry.name} ${file.path.slice(unpacked.length)} imports ${specifier}`;
          expect(target, `${where}, which is not published`).toBeDefined();
          expect(typeof target === "object" && target !== null && condition in target, `${where}, published without ${condition}`).toBe(
            true,
          );
          checked += 1;
        }
      }
    }
    expect(checked, "the packed files import one another").toBeGreaterThan(0);
  }, 60_000);

  it("declares concrete versions in every dependency section", () => {
    for (const entry of packages) {
      const manifest = packedManifest(tarballPath(entry));
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const declared = (manifest[section] ?? {}) as Record<string, string>;
        for (const [name, range] of Object.entries(declared)) {
          // A protocol only the workspace's installer understands fails `npm install`.
          expect(range, `${entry.name} ${section} -> ${name}`).not.toMatch(/^(workspace|catalog|link|file|portal):/);
        }
      }
    }
  });

  it("keeps each packed manifest to the workspace's dependency rules", () => {
    // The same table the workspace gate reads, applied to what a consumer receives.
    for (const entry of packages) {
      expect(violations(entry.name, packedManifest(tarballPath(entry)) as DependencyManifest), entry.name).toEqual([]);
    }
  });

  it("packs exactly the CLI's @tavi closure", () => {
    // Hermetic: followed through the packed manifests, so a package the CLI
    // needs but nothing packs fails here rather than 404ing in the install half.
    const byName = new Map(packages.map((entry) => [entry.name, packedManifest(tarballPath(entry))]));
    const reached = new Set<string>();
    const queue = ["@tavi/cli"];
    while (queue.length > 0) {
      const name = queue.pop();
      if (name === undefined || reached.has(name)) continue;
      reached.add(name);
      const manifest = byName.get(name);
      expect(manifest, `${name} is depended on but not packed`).toBeDefined();
      for (const dependency of Object.keys((manifest?.["dependencies"] ?? {}) as Record<string, string>)) {
        if (dependency.startsWith("@tavi/")) queue.push(dependency);
      }
    }
    // Nothing packed that the CLI does not reach, but the add-ons: an unreachable package is one no install uses.
    expect([...byName.keys()].filter((name) => !ADD_ONS.includes(name)).sort()).toEqual([...reached].sort());
    for (const name of ADD_ONS) expect(byName.has(name), `${name} is packed`).toBe(true);
  });

  it("keeps the CLI entry point and its declared dependencies", () => {
    const cli = packages.find((entry) => entry.name === "@tavi/cli");
    if (cli === undefined) throw new Error("cli package missing");
    const manifest = packedManifest(tarballPath(cli));
    expect(manifest["bin"]).toEqual({ tavi: "./dist/executable.mjs" });
    // The bin target must exist in the artifact, or the shim is broken on install.
    expect(tarballEntries(tarballPath(cli))).toContain("package/dist/executable.mjs");
    // And it must start with a shebang: the installer links `.bin/tavi` at this
    // file and makes it executable, so without one the shim fails with ENOEXEC.
    const executableEntry = run("tar", ["-xzOf", tarballPath(cli), "package/dist/executable.mjs"], {
      encoding: "utf8",
      cwd: repositoryRoot,
    });
    expect(executableEntry.split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(Object.keys((manifest["dependencies"] ?? {}) as Record<string, string>)).toEqual(
      expect.arrayContaining([
        "@tavi/contracts",
        "@tavi/agent-host",
        "@tavi/runtime",
        "@tavi/plugin-browser",
        "@tavi/plugin-router",
        "@tavi/plugin-defaults",
        "@tavi/plugin-local",
        "@tavi/plugin-mailgun",
        "@tavi/plugin-sandbox",
        "@tavi/plugin-telegram",
      ]),
    );
    // The Node the CLI needs travels with it, as the workspace declares it.
    const workspaceEngines = (
      JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
        readonly engines: { readonly node: string };
      }
    ).engines;
    expect((manifest["engines"] as { readonly node?: string } | undefined)?.node).toBe(workspaceEngines.node);
  });
});

describe.skipIf(posixOnly)("clean core-only install", () => {
  /** The tree the packed artifacts are installed into, once, for every test below. */
  let installDirectory = "";

  beforeAll(() => {
    if (!installGateEnabled) return;
    installDirectory = temporaryDirectory("tavi-release-install-");
    writeFileSync(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ name: "tavi-release-install", private: true, version: "0.0.0" }, null, 2)}\n`,
    );

    // The ordinary installer a user would run, against the ordinary registry
    // for the external graph. `npm_config_cache` is redirected because this
    // sandbox cannot write to the default cache location.
    run("npm", ["install", "--no-audit", "--no-fund", ...packages.map((entry) => tarballPath(entry))], {
      encoding: "utf8",
      cwd: installDirectory,
      env: {
        ...process.env,
        npm_config_cache: join(installDirectory, ".npm-cache"),
        npm_config_update_notifier: "false",
      },
    });
  }, 900_000);

  it.skipIf(!installGateEnabled)(
    "installs the artifacts outside the repository and runs the CLI from them",
    () => {
      const nodeModules = join(installDirectory, "node_modules");
      const installed = installedPackages(nodeModules);
      const names = installed.map((entry) => entry.name);

      // The headless graph must not pull a desktop shell, a renderer or a
      // browser, at any depth — and must not install our development tooling.
      for (const forbidden of [...HEADLESS_FORBIDDEN, ...DEV_ONLY]) {
        expect(
          names.filter((name) => name === forbidden),
          `${forbidden} must not be installed`,
        ).toEqual([]);
      }

      // A package only an add-on may hold is installed inside that add-on's own tree, if at all.
      for (const [name, addOn] of Object.entries(ADD_ON_ONLY)) {
        for (const copy of installed.filter((entry) => entry.name === name))
          expect(copy.directory, `${name} outside ${addOn}`).toContain(join("node_modules", ...addOn.split("/"), "node_modules"));
      }

      // Native staging: the pinned SQLite binding must be present exactly once, and nothing
      // may install a second copy beside it.
      const sqlite = installed.filter((entry) => entry.name === "better-sqlite3");
      // The packed manifest names the version pnpm resolved from the catalog.
      const runtimePackage = packages.find((entry) => entry.name === "@tavi/runtime");
      if (runtimePackage === undefined) throw new Error("@tavi/runtime was not packed");
      const pinnedSqlite =
        (packedManifest(tarballPath(runtimePackage)) as { readonly dependencies?: Record<string, string> }).dependencies?.[
          "better-sqlite3"
        ] ?? "";
      expect(pinnedSqlite, "the runtime must declare a better-sqlite3 pin").not.toBe("");
      const versions = sqlite.map((entry) => entry.version).sort();
      expect(versions).toEqual([pinnedSqlite]);
      // How each copy reached this platform is part of the evidence, not an
      // implementation detail: a prebuilt binary needs no compiler on the target
      // machine, a `build/Release` binary means one was invoked here.
      const binding = `${process.platform}-${process.arch}.node`;
      const staging = sqlite.map((copy) => {
        const prebuilt = existsSync(join(copy.directory, "prebuilds", binding));
        const compiled = existsSync(join(copy.directory, "build", "Release", "better_sqlite3.node"));
        expect(prebuilt || compiled, `${copy.name}@${copy.version} has no binding for ${binding}`).toBe(true);
        return `${copy.version}=${prebuilt ? "prebuilt" : "compiled"}`;
      });

      // The canvas `tavi ui` serves, where the installed CLI looks for it: beside its `dist/`.
      expect(existsSync(join(nodeModules, "@tavi/cli", "ui-dist", "index.html")), "the web canvas is installed").toBe(true);

      for (const entry of packages) {
        const installedPackage = join(nodeModules, entry.name);
        expect(existsSync(installedPackage), `${entry.name} is installed`).toBe(true);
        expect(existsSync(join(installedPackage, "src")), `${entry.name} ships src`).toBe(false);
        // Every package manifest must resolve from the installed tree: the
        // published map without `./package.json` broke exactly this.
        const resolvedManifest = run(
          process.execPath,
          ["--input-type=module", "-e", `console.log(import.meta.resolve('${entry.name}/package.json'))`],
          { encoding: "utf8", cwd: installDirectory },
        ).trim();
        expect(resolvedManifest).toContain(`/node_modules/${entry.name}/package.json`);
      }

      // The installed tree resolves through `exports` to `dist`, with no
      // `--conditions development` and no source files present.
      const resolved = run(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@tavi/runtime'))"], {
        encoding: "utf8",
        cwd: installDirectory,
      }).trim();
      expect(resolved).toContain("/node_modules/@tavi/runtime/dist/index.mjs");

      // The dependency closure a consumer actually resolves, followed
      // transitively from the CLI through the installed tree rather than seeded
      // from the workspace list.
      const reachable = new Map<string, InstalledPackage>();
      const queue: InstalledPackage[] = [resolveInstalled(installed, "@tavi/cli", installDirectory)];
      while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined || reachable.has(current.directory)) continue;
        reachable.set(current.directory, current);
        const manifest = JSON.parse(readFileSync(join(current.directory, "package.json"), "utf8")) as {
          readonly dependencies?: Record<string, string>;
        };
        for (const name of Object.keys(manifest.dependencies ?? {})) {
          const dependency = resolveInstalled(installed, name, current.directory);
          if (!reachable.has(dependency.directory)) queue.push(dependency);
        }
      }
      const reachableNames = [...reachable.values()].map((entry) => entry.name);
      // The add-ons are installed beside the CLI, not reached from it (`ADD_ONS`).
      for (const entry of packages.filter((candidate) => !ADD_ONS.includes(candidate.name))) {
        expect(reachableNames, `${entry.name} must be reachable from @tavi/cli`).toContain(entry.name);
      }
      for (const forbidden of HEADLESS_FORBIDDEN) {
        expect(
          reachableNames.filter((name) => name === forbidden),
          `${forbidden} reachable`,
        ).toEqual([]);
      }
      // `react` may be installed for the CLI's TUI, and for nothing else: no
      // other package of ours may reach it — through a dependency, a required
      // peer or an installed optional one — and before the CLI declares it,
      // nothing may install it at all.
      const cli = [...reachable.values()].find((installedPackage) => installedPackage.name === "@tavi/cli");
      const cliDeclaresReact = cli !== undefined && "react" in (readInstalledManifest(cli).dependencies ?? {});
      if (!cliDeclaresReact) expect(names, "react is installed with no declared consumer").not.toContain("react");
      const ours = [...reachable.values()].filter((candidate) => candidate.name.startsWith("@tavi/") && candidate.name !== "@tavi/cli");
      for (const entry of ours) {
        const closure = [...closureOf(installed, entry).values()].map((candidate) => candidate.name);
        expect(closure, `${entry.name} reaches react`).not.toContain("react");
      }
      // Everything the CLI reaches, as the workspace gate walks it (dependencies, required peers, installed
      // optional ones, the TUI stack left to its own rule): no UI framework is a required peer anywhere, and
      // every shipped dependency is permissively licensed, read from the
      // packed install.
      for (const candidate of installedClosure(installDirectory, [join("node_modules", "@tavi", "cli")], { bundled: "skip" })) {
        const name = candidate.manifest.name ?? candidate.directory;
        expect(requiredFrameworkPeers(candidate.manifest), name).toEqual([]);
        if (!name.startsWith("@tavi/"))
          expect(
            licenceAllowed(name, candidate.manifest.license),
            `${name}@${candidate.manifest.version}: ${JSON.stringify(candidate.manifest.license)}`,
          ).toBe(true);
      }

      // Running the installed CLI composes the runtime, opens SQLite through the
      // shipped native binding and applies the migrations. `doctor` proves the
      // plugin composition; `tasks` proves a real file-backed database, since
      // doctor deliberately falls back to an in-memory store.
      const dataDirectory = temporaryDirectory("tavi-release-data-", 0o700);
      const workerProbe = run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { DatabaseClient, AsyncDataDirectoryOwner } from '@tavi/runtime';
        import { join } from 'node:path';
        const owner = await AsyncDataDirectoryOwner.acquire({ dataDirectory: process.argv[1], sessionId: 'release-worker-probe' });
        try {
          const db = await DatabaseClient.open({ databasePath: join(process.argv[1], 'tavi.sqlite') });
          try {
            await db.call('meta.set', { key: 'release.worker', value: 'verified', now: new Date().toISOString() });
            console.log(await db.call('meta.get', { key: 'release.worker' }));
          } finally { await db.close(); }
        } finally {
          const result = await owner.release();
          if (!result.released) throw new Error(result.error);
        }
      `,
          dataDirectory,
        ],
        { encoding: "utf8", cwd: installDirectory },
      );
      expect(workerProbe.trim()).toBe("verified");
      const executable = join(nodeModules, "@tavi", "cli", "dist", "executable.mjs");
      const output = run(process.execPath, [executable, "doctor", "--data-dir", dataDirectory], {
        encoding: "utf8",
        cwd: installDirectory,
      });
      const report = JSON.parse(output) as {
        readonly admissionOpen: boolean;
        readonly plugins: readonly { readonly id: string; readonly phase: string }[];
      };
      expect(report.admissionOpen).toBe(true);
      // Every composed plugin must be ready; "at least one" would pass a
      // half-started runtime.
      expect(report.plugins.filter((plugin) => plugin.phase !== "ready")).toEqual([]);
      expect(report.plugins.length).toBeGreaterThanOrEqual(4);

      expect(report.plugins.some((plugin) => plugin.id === "tavi.router")).toBe(true);
      const routerStatus = JSON.parse(
        run(process.execPath, [executable, "router", "status", "--data-dir", dataDirectory], { encoding: "utf8", cwd: installDirectory }),
      );
      expect(routerStatus).toMatchObject({
        configuration: {
          revision: 0,
          settings: { enabled: false, egress: { taskText: false, memoryExcerpts: false, toolDescriptions: false, skillMetadata: false } },
        },
        provider: { id: "tavi.router", state: "enabled" },
        effectiveModes: { model: "off", memory: "off", tools: "off", skills: "off" },
        credentialPresence: "not-configured",
        liveCredentialValidity: "not-tested",
      });
      const pluginList = JSON.parse(
        run(process.execPath, [executable, "plugins", "list", "--format", "json", "--data-dir", dataDirectory], {
          encoding: "utf8",
          cwd: installDirectory,
        }),
      ) as { plugins: { id: string; core: boolean; kind: string }[] };
      expect(pluginList.plugins.find((plugin) => plugin.id === "tavi.router")).toMatchObject({ kind: "builtin", core: false });

      // The installed `bin` shim, not the file path: that is what a consumer runs.
      const binShim = join(nodeModules, ".bin", "tavi");
      const tasksOutput = run(binShim, ["tasks", "--data-dir", dataDirectory], {
        encoding: "utf8",
        cwd: installDirectory,
      });
      const tasks = JSON.parse(tasksOutput) as {
        readonly dataDirectory: string;
        readonly tasks: readonly unknown[];
      };
      expect(tasks.dataDirectory).toBe(dataDirectory);
      expect(tasks.tasks).toEqual([]);
      // The migrations ran against a real file in the installed tree.
      expect(existsSync(join(dataDirectory, "tavi.sqlite"))).toBe(true);

      const packedBytes = packages.reduce((total, entry) => total + statSync(tarballPath(entry)).size, 0);
      // Measured, not budgeted. The external graph has no lockfile in this tree,
      // so the installed footprint is a function of registry state; the resolved
      // set is logged so a later reader can diff it.
      console.log(
        `release packaging: packed ${(packedBytes / 1024).toFixed(0)} KiB, installed ${(directorySize(nodeModules) / (1024 * 1024)).toFixed(
          1,
        )} MiB, ${installed.length} installed package directories`,
      );
      console.log(`native SQLite copies: ${staging.join(", ")}`);
      console.log(
        `resolved external graph: ${[...new Set(names)]
          .sort()
          .map((name) => `${name}@${installed.find((entry) => entry.name === name)?.version ?? "?"}`)
          .join(", ")}`,
      );
      expect(packedBytes).toBeGreaterThan(0);
    },
    900_000,
  );

  it.skipIf(!installGateEnabled)(
    "runs `tavi chat` from the install in a terminal: frames not events, no scrollback clear, bounded memory",
    () => {
      const nodeModules = join(installDirectory, "node_modules");
      // Ink's layout engine, WebAssembly and all, resolves from the install:
      // the CLI's Ink, wherever npm placed it, and that Ink's `yoga-layout`.
      const resolveFrom = (directory: string, specifier: string): string =>
        run(process.execPath, ["--input-type=module", "-e", `console.log(import.meta.resolve('${specifier}'))`], {
          encoding: "utf8",
          cwd: directory,
        }).trim();
      const ink = fileURLToPath(resolveFrom(join(nodeModules, "@tavi", "cli"), "ink"));
      const yoga = resolveFrom(dirname(ink), "yoga-layout");
      // Against the real path: the temporary directory may sit behind a symlink (`/var` on macOS).
      expect(yoga.startsWith(pathToFileURL(realpathSync(nodeModules)).href), yoga).toBe(true);

      const work = temporaryDirectory("tavi-release-chat-");
      const shim = join(nodeModules, ".bin", "tavi");
      // As a shell with leftovers would start it: `NODE_ENV=development`,
      // which `tavi chat` must override — React's development build retains
      // ~148 MiB — and the collector exposed so `--stats` measures what the
      // session retained, not garbage. `CI` set, as a CI runner sets it: Ink
      // would then print only the last frame, and `tavi chat` must still draw
      // the stream as it plays.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "development",
        NODE_OPTIONS: "--expose-gc",
        TERM: "xterm-256color",
        CI: "true",
      };
      const replay = (deltas: number, lineEvery: number): { stats: ChatStats; transcript: string } => {
        const fixture = join(work, `run-${deltas}.ndjson`);
        writeFileSync(fixture, chatRecording(deltas, lineEvery));
        const statsFile = join(work, `stats-${deltas}.json`);
        const { transcript } = underTerminal([shim, "chat", "--replay", fixture, "--stats", statsFile], {
          rows: 20,
          columns: 60,
          cwd: installDirectory,
          env,
        });
        return { stats: JSON.parse(readFileSync(statsFile, "utf8")) as ChatStats, transcript };
      };

      // The fixture: 10,000 deltas, a line every 40.
      const { stats, transcript } = replay(10_000, 40);
      expect(stats).toMatchObject({ events: 10_002, deltas: 10_000, committedLines: 250, rows: 20, columns: 60 });
      // The reconciler that ran, not the variable: the development build would
      // also retain ~148 MiB, which the heap budget below refuses too.
      expect(stats.reactBuild).toBe("production");
      expect(stats.collected).toBe(true);
      // Frames, not events: the tree hears of the stream about once a frame
      // (a replay plays 250 events a frame), and Ink draws a bounded few per update.
      expect(stats.treeUpdates).toBeGreaterThan(10);
      expect(stats.treeUpdates).toBeLessThanOrEqual(60);
      expect(stats.renders).toBeLessThanOrEqual(stats.treeUpdates * 3);
      // Ink 7.1.1 never cleared the terminal's scrollback (#990), and every
      // line reached it: each ends on a word numbered by 40.
      expect(transcript).not.toContain(CLEAR_SCROLLBACK);
      for (let word = 40; word <= 10_000; word += 40) expect(transcript).toContain(`w${word}`);
      expect(transcript).toContain("✓ completed task-1.");
      expect(stats.peakRssBytes).toBeLessThan(CHAT_PEAK_RSS_BUDGET);
      expect(stats.heapUsedBytes).toBeLessThan(CHAT_HEAP_BUDGET);

      // The long run: ten times the stream, in short lines, so the transcript,
      // the committed lines and Ink's measuring caches all grow. What the
      // session retains may grow by the transcript it holds, not with time.
      const long = replay(100_000, 8);
      expect(long.stats).toMatchObject({ events: 100_002, committedLines: 12_500, collected: true, reactBuild: "production" });
      expect(long.stats.treeUpdates).toBeLessThanOrEqual(Math.ceil(100_002 / 250) * 1.5);
      expect(long.stats.renders).toBeLessThanOrEqual(long.stats.treeUpdates * 3);
      expect(long.transcript).not.toContain(CLEAR_SCROLLBACK);
      expect(long.stats.peakRssBytes).toBeLessThan(CHAT_PEAK_RSS_BUDGET);
      const slope = long.stats.heapUsedBytes - stats.heapUsedBytes;
      expect(slope, `retained heap grew ${(slope / 2 ** 20).toFixed(1)} MiB over 90,000 more deltas`).toBeLessThan(CHAT_HEAP_SLOPE_BUDGET);
      console.log(
        `tavi chat (installed): 10k deltas ${stats.treeUpdates} tree updates, ${stats.renders} renders, peak RSS ` +
          `${(stats.peakRssBytes / 2 ** 20).toFixed(0)} MiB, retained heap ${(stats.heapUsedBytes / 2 ** 20).toFixed(1)} MiB; ` +
          `100k deltas peak RSS ${(long.stats.peakRssBytes / 2 ** 20).toFixed(0)} MiB, retained heap ` +
          `${(long.stats.heapUsedBytes / 2 ** 20).toFixed(1)} MiB`,
      );
    },
    300_000,
  );
});
