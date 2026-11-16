import { spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { findExecutable, joinPath, launchCommand, pathEntries, systemEnv } from "@tavi/node-kit";
import { readJsonBody } from "../../shared/json-body.js";

/**
 * Fetching an npm MCP server for install (`--npm`): the exact version, its whole dependency closure copied (never
 * bundled), no install script run anywhere in the tree, every lockfile entry
 * from the public registry with its integrity, and the top package's
 * integrity equal to what npm publishes. Prebuilt native code is allowed and
 * listed; deprecated packages warn; browser servers, which download a browser
 * at run time, and packages that need a missing peer are refused. No code of
 * the package runs here.
 */

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Packages that download a browser when they run: a server built on one is refused. */
const BROWSER_DOWNLOADERS = new Set([
  "puppeteer",
  "playwright",
  "playwright-core",
  "@playwright/test",
  "chrome-launcher",
  "selenium-webdriver",
]);

export interface NpmFetchResult {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly license: string;
  /** The server's entry, relative to the package directory (`node_modules/<name>/<bin>`). */
  readonly entry: string;
  /** Prebuilt native files (`.node`), listed at review. */
  readonly native: readonly string[];
  /** Deprecated packages, with npm's message. */
  readonly deprecated: readonly string[];
  readonly files: number;
}

export interface NpmFetchOptions {
  readonly registry?: string;
  readonly fetch?: typeof fetch;
}

/** `name@exact`: a scoped or plain name and an exact version (no range, no tag). */
export function parsePackageSpec(spec: string): { readonly name: string; readonly version: string } {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : "";
  const version = at > 0 ? spec.slice(at + 1) : "";
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new TaviError("INVALID_INPUT", `--npm takes <package>@<exact version>, received ${JSON.stringify(spec)}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
    throw new TaviError(
      "INVALID_INPUT",
      `${name} needs an exact version (such as ${name}@1.2.3), not ${JSON.stringify(version || "a tag or range")}`,
    );
  return { name, version };
}

interface LockEntry {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  /** An omitted peer (`--omit=peer`): recorded in the lockfile, never installed. */
  readonly peer?: boolean;
  readonly hasInstallScript?: boolean;
  readonly deprecated?: string;
  readonly license?: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly bin?: string | Readonly<Record<string, string>>;
}

/** The checks on the installed closure's lockfile; the problems, refusal first. */
export function lockfileProblems(
  packages: Readonly<Record<string, LockEntry>>,
  top: string,
  registry: string,
): { readonly refusals: readonly string[]; readonly deprecated: readonly string[] } {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const refusals: string[] = [];
  const deprecated: string[] = [];
  const nameOf = (key: string): string => key.replace(/^(?:.*\/)?node_modules\//, "");
  // What is installed: an omitted peer stays in the lockfile, marked `peer`, but is not there.
  const present = new Set(
    Object.entries(packages)
      .filter(([key, entry]) => key !== "" && entry.peer !== true)
      .map(([key]) => nameOf(key)),
  );
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || entry.link === true || entry.peer === true) continue;
    const name = nameOf(key);
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(base))
      refusals.push(`${name} was resolved from ${String(entry.resolved)}, outside the npm registry`);
    if (typeof entry.integrity !== "string" || entry.integrity === "") refusals.push(`${name} has no integrity in the lockfile`);
    if (entry.hasInstallScript === true)
      refusals.push(`${name} has an install script, which Tavi never runs; the server would be missing what it builds`);
    if (BROWSER_DOWNLOADERS.has(name))
      refusals.push(`${name} downloads a browser when it runs; browser servers are not supported (the browser agent covers them)`);
    for (const [peer] of Object.entries(entry.peerDependencies ?? {})) {
      if (entry.peerDependenciesMeta?.[peer]?.optional === true || present.has(peer)) continue;
      refusals.push(`${name} needs ${peer} installed beside it (a peer dependency), which it does not bring`);
    }
    if (typeof entry.deprecated === "string") deprecated.push(`${name}: ${entry.deprecated}`);
  }
  if (packages[`node_modules/${top}`] === undefined) refusals.unshift(`npm did not install ${top}`);
  return { refusals, deprecated };
}

/** Every `.node` file under `directory`, relative to it. */
async function nativeFiles(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await nativeFiles(directory, relative)));
    else if (entry.isFile() && entry.name.endsWith(".node")) found.push(relative);
  }
  return found;
}

/** The package's server entry: its only bin, the bin named like the package, or its main. */
function entryOf(name: string, manifest: { readonly bin?: unknown; readonly main?: unknown }): string {
  const bin = manifest.bin;
  const short = name.split("/").at(-1) as string;
  let path: string | undefined;
  if (typeof bin === "string") path = bin;
  else if (bin !== null && typeof bin === "object") {
    const bins = bin as Record<string, string>;
    const names = Object.keys(bins);
    path = names.length === 1 ? bins[names[0] as string] : (bins[short] ?? bins[name]);
    if (path === undefined)
      throw new TaviError(
        "UNSUPPORTED",
        `${name} has several programs (${names.join(", ")}) and none is named like the package; give its argv with --dir instead`,
      );
  } else if (typeof manifest.main === "string") path = manifest.main;
  if (path === undefined) throw new TaviError("UNSUPPORTED", `${name} names no program to run (no bin or main)`);
  const clean = path.replace(/^\.\//, "");
  if (clean.split("/").includes("..") || clean.startsWith("/"))
    throw new TaviError("INVALID_INPUT", `${name}'s program ${path} is outside the package`);
  return `node_modules/${name}/${clean}`;
}

/** The npm next to the running node, else the first on PATH (`npm.cmd` on Windows, through `PATHEXT`). */
const findNpmExecutable = (): string | undefined =>
  findExecutable("npm", { path: joinPath([dirname(process.execPath), ...pathEntries(process.env["PATH"])]) });

/**
 * `npm install` in `stagingDir` with every install script off, an empty user
 * and global config (no private registry, no proxy), npm's cache inside the
 * staging directory, and only the registry named. `extraArgs` adds flags (an
 * MCP server's install adds `--no-bin-links`).
 */
async function runNpmInstall(stagingDir: string, npmExe: string, npmRegistry: string, extraArgs: readonly string[] = []): Promise<void> {
  const emptyNpmrc = join(stagingDir, ".npmrc.empty");
  await writeFile(emptyNpmrc, "", "utf8");
  const emptyGlobalNpmrc = join(stagingDir, ".npmrc.global.empty");
  await writeFile(emptyGlobalNpmrc, "", "utf8");
  const npmCacheDir = join(stagingDir, "npm-cache");

  const args = [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--omit=peer",
    "--no-audit",
    "--no-fund",
    `--registry=${npmRegistry}`,
    `--userconfig=${emptyNpmrc}`,
    `--globalconfig=${emptyGlobalNpmrc}`,
    ...extraArgs,
  ];
  // npm found next to node runs `#!/usr/bin/env node`: put that node first on its PATH.
  const childPath = joinPath([dirname(process.execPath), ...pathEntries(process.env["PATH"])]);
  // On Windows npm is `npm.cmd`: run as this Node on npm's own entry.
  const launch = launchCommand(npmExe, args);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: stagingDir,
      ...(launch.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: true }),
      windowsHide: true,
      env: {
        ...systemEnv(),
        PATH: childPath,
        HOME: stagingDir,
        // On Windows npm reads its user config and temporary folder from these, not HOME: the staging folder too.
        ...(process.platform === "win32" ? { USERPROFILE: stagingDir, TEMP: stagingDir, TMP: stagingDir } : {}),
        npm_config_cache: npmCacheDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TaviError("UNAVAILABLE", "npm install timed out after 120s"));
    }, 120_000);

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 100_000) stderr += d.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else {
        reject(new TaviError("INVALID_INPUT", `npm install failed with exit code ${code}: ${stderr}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new TaviError("UNAVAILABLE", `Failed to run npm: ${err.message}`));
    });
  });
}

/**
 * Installs `name@version` into `packageDirectory` (which must exist and be
 * empty) and checks it. On any refusal the caller removes the directory.
 */
export async function fetchNpmServer(
  spec: { readonly name: string; readonly version: string },
  packageDirectory: string,
  options: NpmFetchOptions = {},
): Promise<NpmFetchResult> {
  const registry = options.registry ?? DEFAULT_NPM_REGISTRY;
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(`${registry.replace(/\/$/, "")}/${spec.name.replace("/", "%2f")}/${encodeURIComponent(spec.version)}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new TaviError(
      response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
      `npm has no ${spec.name}@${spec.version} (HTTP ${String(response.status)})`,
    );
  // A JSON `null` reads as an empty answer, refused below for its missing integrity.
  const published =
    ((await readJsonBody(response)) as {
      readonly dist?: { readonly integrity?: unknown };
      readonly license?: unknown;
      readonly deprecated?: unknown;
    } | null) ?? {};
  const integrity = published.dist?.integrity;
  if (typeof integrity !== "string" || integrity === "")
    throw new TaviError("INVALID_INPUT", `npm publishes no integrity for ${spec.name}@${spec.version}`);
  const npm = findNpmExecutable();
  if (npm === undefined)
    throw new TaviError("CAPABILITY_MISSING", "npm was not found next to node or on PATH; it is needed to fetch an npm server");
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "tavi-mcp-server", private: true, dependencies: { [spec.name]: spec.version } }, null, 2)}\n`,
  );
  await runNpmInstall(packageDirectory, npm, `${registry.replace(/\/$/, "")}/`, ["--no-bin-links", "--save-exact"]);
  // npm's own scratch is not the server's: only what runs, and the lockfile that pins it, are kept.
  for (const scratch of ["npm-cache", ".npmrc.empty", ".npmrc.global.empty"])
    await rm(join(packageDirectory, scratch), { recursive: true, force: true });
  const lock = JSON.parse(await readFile(join(packageDirectory, "package-lock.json"), "utf8")) as {
    readonly packages?: Record<string, LockEntry>;
  };
  const packages = lock.packages ?? {};
  const top = packages[`node_modules/${spec.name}`];
  if (top?.integrity !== integrity)
    throw new TaviError(
      "INVALID_INPUT",
      `${spec.name}'s integrity in the lockfile (${String(top?.integrity)}) is not what npm publishes (${integrity})`,
    );
  const { refusals, deprecated } = lockfileProblems(packages, spec.name, registry);
  if (refusals.length > 0)
    throw new TaviError(
      "UNSUPPORTED",
      `${spec.name}@${spec.version} cannot be installed: ${refusals.slice(0, 5).join("; ")}${refusals.length > 5 ? `; and ${String(refusals.length - 5)} more` : ""}`,
    );
  const manifest = JSON.parse(await readFile(join(packageDirectory, "node_modules", ...spec.name.split("/"), "package.json"), "utf8")) as {
    readonly bin?: unknown;
    readonly main?: unknown;
    readonly license?: unknown;
  };
  const native = await nativeFiles(packageDirectory);
  return {
    name: spec.name,
    version: spec.version,
    integrity,
    license:
      typeof manifest.license === "string" ? manifest.license : typeof published.license === "string" ? published.license : "UNLICENSED",
    entry: entryOf(spec.name, manifest),
    native,
    deprecated: typeof published.deprecated === "string" ? [`${spec.name}: ${published.deprecated}`, ...deprecated] : deprecated,
    files: Object.keys(packages).filter((key) => key !== "").length,
  };
}
