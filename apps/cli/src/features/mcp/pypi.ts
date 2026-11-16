import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { childBaseEnv, findExecutable, sha256Hex, systemEnv } from "@tavi/node-kit";

/**
 * Fetching a Python MCP server for install (`--pypi`): `uv pip compile --generate-hashes` pins the exact version's
 * whole closure, each distribution by its hash, then `uv pip install
 * --require-hashes --only-binary :all: --target` installs wheels only — no
 * sdist is built, so no package code runs here. Public PyPI only. The
 * interpreter is one uv manages, pinned by path and SHA-256: `doctor` checks
 * that `uv` is there.
 */

/**
 * What `python -c` runs: the installed tree first on the path, then the
 * console script's `module:attribute` called, with the server's own argv.
 */
export const PYTHON_BOOTSTRAP =
  "import sys,importlib,functools;sys.path.insert(0,sys.argv[1]);m,_,a=sys.argv[2].partition(':');f=functools.reduce(getattr,a.split('.'),importlib.import_module(m));sys.argv=[sys.argv[2]]+sys.argv[3:];sys.exit(f())";

/** The public index, and the only one. */
const PYPI_INDEX = "https://pypi.org/simple";

/** Files that hold compiled code: listed at review. */
const NATIVE = /\.(?:so|pyd|dylib)(?:\.[0-9.]+)?$/;

export interface PypiFetchResult {
  readonly name: string;
  readonly version: string;
  /** The first of the server's own pinned wheel hashes, as `sha256:<hex>` (`requirements.txt` holds them all). */
  readonly integrity: string;
  readonly license: string;
  /** The console script's `module:attribute` the server runs. */
  readonly entry: string;
  readonly interpreter: { readonly path: string; readonly sha256: string; readonly version: string };
  /** Compiled files in the installed tree, relative to the package directory. */
  readonly native: readonly string[];
  /** Distributions installed, the server's own included. */
  readonly files: number;
}

export interface PypiFetchOptions {
  /** The `uv` to run; found on PATH by default. */
  readonly uv?: string;
  /** uv's own variables for its interpreters and cache (tests point them elsewhere); none of uv's config is read. */
  readonly uvEnv?: Readonly<Record<string, string>>;
}

/** `name==exact`: a PyPI name and an exact version (no range, no extra, no marker). */
export function parsePypiSpec(spec: string): { readonly name: string; readonly version: string } {
  const at = spec.indexOf("==");
  const name = at > 0 ? spec.slice(0, at) : "";
  const version = at > 0 ? spec.slice(at + 2) : "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name))
    throw new TaviError("INVALID_INPUT", `--pypi takes <package>==<exact version>, received ${JSON.stringify(spec)}`);
  if (!/^[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?(?:\.dev[0-9]+)?$/.test(version))
    throw new TaviError(
      "INVALID_INPUT",
      `${name} needs an exact version (such as ${name}==1.2.3), not ${JSON.stringify(version || "a range")}`,
    );
  return { name, version };
}

/** PEP 503's normal form of a project name. */
export const normalizePypiName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The `uv` on PATH, if any (`uv.exe` on Windows). */
export const findUv = (path: string = process.env["PATH"] ?? ""): string | undefined => findExecutable("uv", { path });

/** uv's environment: no config file, no index but PyPI's, no interpreter downloaded behind the operator's back. */
export function uvEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const keep = ["HOME", "PATH", "TMPDIR", "LANG", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR"];
  return {
    // On Windows also SystemRoot, TEMP and the profile folders, which uv and Python cannot start without.
    ...childBaseEnv(),
    ...Object.fromEntries(keep.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]]))),
    UV_NO_CONFIG: "1",
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_PYTHON_DOWNLOADS: "never",
    UV_NO_PROGRESS: "1",
    ...extra,
  };
}

/** Terminal colour codes in a program's words. */
const COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Runs uv (or the interpreter); its own words, cleaned, on failure. */
function runUv(uv: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(uv, [...args], { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (error, stdout, stderr) => {
      if (error === null) return resolve(stdout);
      const said = `${stderr}`.replace(COLOURS, "").replace(/\s+/g, " ").trim().slice(0, 600);
      reject(new TaviError("UNAVAILABLE", said === "" ? error.message.replace(/\s+/g, " ").trim() : said));
    });
  });
}

/**
 * The uv-managed interpreter: its resolved path, SHA-256 and version. Asked
 * from `cwd` (an empty directory, so no `.venv` or `.python-version` there
 * chooses), with `--system` (no virtual environment), and refused unless it
 * lies under uv's own interpreter directory.
 */
export async function managedInterpreter(
  uv: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<PypiFetchResult["interpreter"]> {
  let found: string;
  let managed: string;
  try {
    found = (await runUv(uv, ["python", "find", "--system"], cwd, env)).trim();
    managed = realpathSync((await runUv(uv, ["python", "dir"], cwd, env)).trim());
  } catch (error) {
    throw new TaviError(
      "NOT_CONFIGURED",
      `uv found no Python interpreter it manages (${errorMessage(error)}): run \`uv python install 3.12\`, then add the server again`,
    );
  }
  const path = realpathSync(found);
  if (!path.startsWith(`${managed}${sep}`))
    throw new TaviError(
      "NOT_CONFIGURED",
      `uv found ${path}, which it does not manage (${managed}): run \`uv python install 3.12\`, then add the server again`,
    );
  const version = (await runUv(path, ["-I", "-c", "import platform; print(platform.python_version())"], cwd, systemEnv())).trim();
  return { path, sha256: sha256Hex(readFileSync(path)), version };
}

/** The installed distributions' `.dist-info` directories under `site`. */
function distInfos(site: string): readonly string[] {
  return existsSync(site) ? readdirSync(site).filter((entry) => entry.endsWith(".dist-info")) : [];
}

/** The console script a package runs as a server: its only one, or the one named like the package. */
export function consoleScriptOf(name: string, entryPoints: string): string {
  const scripts: [string, string][] = [];
  let section = "";
  for (const raw of entryPoints.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) section = line;
    else if (section === "[console_scripts]" && line.includes("=")) {
      const at = line.indexOf("=");
      scripts.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  const chosen = scripts.length === 1 ? scripts[0] : scripts.find(([script]) => normalizePypiName(script) === normalizePypiName(name));
  if (chosen === undefined) {
    throw new TaviError(
      "UNSUPPORTED",
      scripts.length === 0
        ? `${name} names no program to run (no console script)`
        : `${name} has several programs (${scripts.map(([script]) => script).join(", ")}) and none is named like the package; give its argv with --dir instead`,
    );
  }
  const target = chosen[1].split("[")[0]?.trim() ?? "";
  if (!/^[A-Za-z_][\w.]*:[A-Za-z_][\w.]*$/.test(target))
    throw new TaviError("UNSUPPORTED", `${name}'s program ${chosen[1]} is not a module:function entry point`);
  return target;
}

/** Every compiled file under `directory`, relative to it. */
function nativeFiles(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...nativeFiles(directory, relative));
    else if (entry.isFile() && NATIVE.test(entry.name)) found.push(relative);
  }
  return found;
}

/**
 * Installs `name==version` into `packageDirectory/site` (the directory must
 * exist and be empty), pinned by `requirements.txt` beside it, and checks
 * it. On any refusal the caller removes the directory.
 */
export async function fetchPypiServer(
  spec: { readonly name: string; readonly version: string },
  packageDirectory: string,
  options: PypiFetchOptions = {},
): Promise<PypiFetchResult> {
  const uv = options.uv ?? findUv();
  if (uv === undefined)
    throw new TaviError(
      "CAPABILITY_MISSING",
      "uv was not found on PATH; it is needed to fetch a Python server (https://docs.astral.sh/uv/; `tavi doctor` checks it)",
    );
  const env = uvEnvironment(options.uvEnv);
  const interpreter = await managedInterpreter(uv, env, packageDirectory);
  await writeFile(join(packageDirectory, "requirements.in"), `${spec.name}==${spec.version}\n`);
  const index = ["--default-index", PYPI_INDEX, "--python", interpreter.path, "--only-binary", ":all:"];
  try {
    await runUv(
      uv,
      ["pip", "compile", "requirements.in", "--generate-hashes", "--no-header", "--no-annotate", "-o", "requirements.txt", ...index],
      packageDirectory,
      env,
    );
  } catch (error) {
    const said = errorMessage(error);
    // Wheels that exist, but not for this interpreter or platform: another Python is the fix.
    if (/with a matching (?:Python|platform|ABI)/i.test(said)) {
      throw new TaviError(
        "UNSUPPORTED",
        `${spec.name}==${spec.version} has no wheel for Python ${interpreter.version} on this platform; install a Python it ships wheels for with uv (${said})`,
      );
    }
    // A distribution with no wheel at all is an sdist to build, which would run its code here.
    if (
      /no wheels? (?:are )?(?:available|found|with a matching)|only-binary|has no usable wheels|no matching distribution|source distribution/i.test(
        said,
      )
    ) {
      throw new TaviError(
        "UNSUPPORTED",
        `${spec.name}==${spec.version} cannot be installed from wheels for Python ${interpreter.version}: a package in it publishes only a source distribution, which Tavi never builds (${said})`,
      );
    }
    throw new TaviError("UNAVAILABLE", `${spec.name}==${spec.version} could not be resolved: ${said}`);
  }
  await runUv(
    uv,
    ["pip", "install", "--require-hashes", "--no-deps", "--target", "site", "-r", "requirements.txt", ...index],
    packageDirectory,
    env,
  ).catch((error: unknown) => {
    const said = errorMessage(error);
    throw new TaviError(
      /hash/i.test(said) ? "CONFLICT" : "UNAVAILABLE",
      /hash/i.test(said)
        ? `a downloaded file's hash is not the one pinned: ${said}`
        : `${spec.name}==${spec.version} could not be installed: ${said}`,
    );
  });
  const site = join(packageDirectory, "site");
  const own = distInfos(site).find((entry) => normalizePypiName(entry.replace(/-[^-]+\.dist-info$/, "")) === normalizePypiName(spec.name));
  if (own === undefined) throw new TaviError("UNAVAILABLE", `uv did not install ${spec.name}`);
  const entryPoints = existsSync(join(site, own, "entry_points.txt")) ? await readFile(join(site, own, "entry_points.txt"), "utf8") : "";
  const metadata = existsSync(join(site, own, "METADATA")) ? await readFile(join(site, own, "METADATA"), "utf8") : "";
  const license = /^License-Expression: (.+)$/m.exec(metadata)?.[1] ?? /^License: (.+)$/m.exec(metadata)?.[1] ?? "UNLICENSED";
  // The pinned hash of the server's own wheel, from the requirements uv wrote.
  const pins = await readFile(join(packageDirectory, "requirements.txt"), "utf8");
  const block = pins
    .split(/\n(?=\S)/)
    .find((entry) => normalizePypiName(entry.split("==")[0]?.trim() ?? "") === normalizePypiName(spec.name));
  const hash = /--hash=(sha256:[0-9a-f]{64})/.exec(block ?? "")?.[1];
  if (hash === undefined) throw new TaviError("INVALID_INPUT", `no hash was pinned for ${spec.name}`);
  return {
    name: spec.name,
    version: spec.version,
    integrity: hash,
    license: license.trim().slice(0, 128),
    entry: consoleScriptOf(spec.name, entryPoints),
    interpreter,
    native: nativeFiles(packageDirectory).filter((file) => file.startsWith("site/")),
    files: distInfos(site).length,
  };
}
