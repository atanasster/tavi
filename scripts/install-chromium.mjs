// Installs the Chromium the browser plugin's Playwright wants, as part of
// `pnpm install` (the root `postinstall`). Playwright's own install skips a
// revision already downloaded, so a later `pnpm install` costs a moment, and
// one that brings a newer Playwright brings its Chromium with it: before this,
// an update left the browser without one, and no chat was offered it.
//
// It never fails the install: offline, or with Playwright not installed, it
// says so and how to install Chromium later. Skipped in CI (the jobs that need
// Chromium install it with its system libraries) and when
// TAVI_SKIP_CHROMIUM=1 or PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is set.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALL_LATER = "pnpm --filter @tavi/plugin-browser exec playwright install chromium";

/** Why Chromium is not installed now, or `undefined` to install it. */
export function skipReason(env) {
  const on = (value) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  if (on(env.TAVI_SKIP_CHROMIUM)) return "TAVI_SKIP_CHROMIUM is set";
  if (on(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) return "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set";
  if (on(env.CI)) return "this is CI, whose browser jobs install it themselves";
  return undefined;
}

/** The browser plugin's Playwright command line, or `undefined` when Playwright is not installed. */
export function playwrightCli(root) {
  try {
    const require = createRequire(join(root, "packages", "builtin", "browser", "package.json"));
    return join(dirname(require.resolve("playwright/package.json")), "cli.js");
  } catch {
    return undefined;
  }
}

function main() {
  const say = (line) => process.stdout.write(`tavi: ${line}\n`);
  const reason = skipReason(process.env);
  if (reason !== undefined) {
    say(`not installing Chromium for the browser: ${reason}. Install it later with \`${INSTALL_LATER}\`.`);
    return;
  }
  const cli = playwrightCli(join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (cli === undefined) {
    say("Playwright is not installed, so the browser has no Chromium to install; Tavi runs without the browser's tools.");
    return;
  }
  say("installing the Chromium the browser uses (once per Playwright version)…");
  const ran = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  if (ran.status !== 0) {
    say(`Chromium could not be installed, so the browser's tools are not offered. Install it later with \`${INSTALL_LATER}\`.`);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
