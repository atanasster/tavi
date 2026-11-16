#!/usr/bin/env node
/**
 * `pnpm tavi <command>` from a checkout: the built CLI, rebuilt first when
 * `serve`, `ui`, `chat`, `onboard` or `setup` would otherwise start on a stale build.
 *
 * Stale means a file of any workspace package (its sources, configs and
 * manifest, not its tests or outputs) — or a root build input — changed after
 * the last build this launcher made, or the CLI or its canvas was never built.
 * The rebuild is turbo's (`build` of `@tavi/cli`, which takes its packages and
 * the UI with it), so only what changed is built again. `TAVI_NO_REBUILD=1`
 * skips the check.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { turboCommand } from "./turbo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const turbo = turboCommand(root);
const executable = join(root, "apps", "cli", "dist", "executable.mjs");
const canvas = join(root, "apps", "cli", "ui-dist", "index.html");
const stamp = join(root, "node_modules", ".cache", "tavi", "build-stamp");

/** The commands that run the built owner, canvas or TUI for a while: worth a fresh build. */
const REBUILT_FOR = new Set(["serve", "ui", "chat", "onboard", "setup"]);
/** Directories that are not build inputs. */
const SKIPPED = new Set(["node_modules", "dist", "ui-dist", ".turbo", "coverage", "test", "tests", "__tests__"]);
const ROOT_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "turbo.json"];

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Whether any file under `directory` changed after `since`. */
function changedSince(directory, since) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && changedSince(path, since)) return true;
    } else if ((mtime(path) ?? 0) > since) {
      return true;
    }
  }
  return false;
}

/** When the build last finished: the stamp this launcher writes, else the CLI's own output. */
function builtAt() {
  const outputs = [mtime(executable), mtime(canvas)];
  if (outputs.includes(undefined)) return undefined;
  return mtime(stamp) ?? Math.min(...outputs);
}

function stale() {
  const since = builtAt();
  if (since === undefined) return true;
  if (ROOT_INPUTS.some((name) => (mtime(join(root, name)) ?? 0) > since)) return true;
  return ["apps", "packages"].some((group) => changedSince(join(root, group), since));
}

const args = process.argv.slice(2);
if (REBUILT_FOR.has(args[0] ?? "") && process.env.TAVI_NO_REBUILD !== "1" && stale()) {
  process.stderr.write("tavi: sources changed since the last build — rebuilding…\n");
  const started = Date.now();
  const built = spawnSync(turbo[0], [...turbo[1], "run", "build", "--filter=@tavi/cli", "--output-logs=errors-only"], {
    cwd: root,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    process.stderr.write(
      `tavi: the build failed; not starting ${args[0]}. Fix it, or run with TAVI_NO_REBUILD=1 to start the last build.\n`,
    );
    process.exit(built.status ?? 1);
  }
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, new Date(started).toISOString());
  // Dated when the build began: a file saved while it ran still reads as newer.
  utimesSync(stamp, new Date(started), new Date(started));
  process.stderr.write(`tavi: rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

await import(pathToFileURL(executable).href);
