// Sandbox-safe pnpm wrapper: keeps corepack's and pnpm's caches inside the
// workspace, so the monorepo builds where $HOME is not writable. A Node script,
// so it runs the same on Windows: callers start it as
// `process.execPath scripts/pnpmw.mjs <pnpm args>`.
//
// pnpm is corepack's cached copy of the pinned version when there is one, else
// the pnpm that started this process (`npm_execpath`), else `pnpm` on PATH.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pnpmCommand, pnpmOnPath } from "./pnpm-command.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  COREPACK_HOME: process.env.COREPACK_HOME ?? join(root, ".cache", "corepack"),
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(root, ".cache", "xdg"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};
// The version the workspace pins (`packageManager`), as corepack caches it.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager.split("@")[1];
const pnpm =
  pnpmCommand(join(env.COREPACK_HOME, "v1", "pnpm", version, "bin", "pnpm.mjs")) ?? pnpmCommand(process.env.npm_execpath) ?? pnpmOnPath();
if (pnpm === undefined) {
  process.stderr.write("pnpmw: no pnpm to run: install it (npm install -g pnpm), or run this through pnpm\n");
  process.exit(1);
}
const [command, leading] = pnpm;
const ran = spawnSync(command, [...leading, ...process.argv.slice(2)], { env, stdio: "inherit" });
if (ran.error !== undefined) {
  process.stderr.write(`pnpmw: ${ran.error.message}\n`);
  process.exit(1);
}
process.exit(ran.status ?? 1);
