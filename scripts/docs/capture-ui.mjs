#!/usr/bin/env node
// Retakes the documentation's screenshots of the web canvas and the terminal.
//
//   node scripts/docs/capture-ui.mjs [--only <name,…>] [--model] [--api-key-file <path>]
//
// Each run starts from a new, empty data directory in the system's temporary
// folder, seeds it through the CLI (reminders, a schedule, to-dos, memory,
// web search, an example plugin awaiting review), starts its own `tavi serve` and `tavi ui` on free ports, and
// drives the canvas with Playwright, writing docs/assets/screens/<name>.png
// (and <name>-dark.png for a shot that has both). A terminal shot runs a
// command (under a pseudo-terminal, for a replay) and draws what it printed as
// docs/assets/terminal/<name>.svg, light and dark. The data directory is
// deleted at the end, and on Ctrl-C.
//
// The shots in scripts/docs/shots.mjs that need a model run only with
// --model: the owner then talks to OpenRouter with the key in the file
// --api-key-file names (by default the `openrouter` credential of your own
// data directory). The key is stored, from that file, in the throwaway
// directory's own credential store (0600, never the OS keychain), which is
// deleted when the run ends; it is never printed, logged or written into the
// repository.
//
// Build first (`pnpm run build`): this drives apps/cli/dist and the canvas it
// bundles. A wait that times out is reported, and the run exits 1.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchBrowser, root } from "./browser.mjs";
import { cleanUp, cleanUpOnSignals, cli, defaultKeyFile, keyFileProblem, openSession, settled, terminalLines } from "./session.mjs";
import { SEED, SHOTS } from "./shots.mjs";
import { svgOf } from "./terminal-svg.mjs";

const screens = join(root, "docs/assets/screens");
const terminals = join(root, "docs/assets/terminal");

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const only = flag("--only")?.split(",");
const withModel = args.includes("--model");
const keyFile = flag("--api-key-file") ?? defaultKeyFile();

const shots = SHOTS.filter((shot) => (only === undefined || only.includes(shot.name)) && (withModel || shot.model !== true));
if (shots.length === 0) {
  console.error("no shot to take (a model shot needs --model)");
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error("apps/cli/dist is missing: run pnpm run build first");
  process.exit(2);
}
const keyProblem = withModel ? keyFileProblem(keyFile) : undefined;
if (keyProblem !== undefined) {
  console.error(keyProblem);
  process.exit(2);
}

cleanUpOnSignals();

/** A command's output (under a pseudo-terminal for a TUI), drawn as an SVG window, light and dark. */
async function terminalShot(dataDir, shot) {
  const lines = await terminalLines(dataDir, shot.terminal, shot.name);
  mkdirSync(terminals, { recursive: true });
  for (const theme of ["light", "dark"]) {
    const file = join(terminals, `${shot.name}${theme === "dark" ? "-dark" : ""}.svg`);
    writeFileSync(file, svgOf(lines, { theme, title: shot.terminal.title, cols: shot.terminal.cols ?? 100 }));
    console.log(file.slice(root.length + 1));
  }
}

/**
 * One throwaway data directory, its owner and its canvas, and the shots taken
 * on it in order: a configured one (a model connection and the seed), or a
 * fresh one with nothing set up, for Welcome.
 */
async function session(browser, configured, list) {
  const { dataDir, openUi } = await openSession({ configured, withModel, keyFile, seed: SEED });
  for (const shot of list.filter((each) => each.terminal !== undefined)) await terminalShot(dataDir, shot);
  const pages = list.filter((each) => each.terminal === undefined);
  if (pages.length === 0) return;
  const { context, page, link } = await openUi(browser);
  try {
    await page.getByText("connected", { exact: true }).first().waitFor({ timeout: 30_000 });
    for (const shot of pages) {
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize(shot.viewport ?? { width: 1280, height: 800 });
      await page.goto(new URL(shot.route, link).href.replace(/#.*$/, ""));
      await page.waitForLoadState("networkidle");
      await settled(page, shot.name);
      if (shot.prepare !== undefined) await shot.prepare(page, shot.name);
      await page.waitForTimeout(shot.settle ?? 600);
      // No hover tooltip or focus ring left over from the steps: the picture shows the page at rest.
      await page.mouse.move(1, 1);
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
      mkdirSync(screens, { recursive: true });
      for (const theme of shot.dark === true ? ["light", "dark"] : ["light"]) {
        await page.emulateMedia({ colorScheme: theme });
        // The page's colours ease between themes: wait for them to finish.
        await page.waitForTimeout(900);
        const file = join(screens, `${shot.name}${theme === "dark" ? "-dark" : ""}.png`);
        await page.screenshot({ path: file });
        console.log(file.slice(root.length + 1));
      }
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await launchBrowser();
  try {
    const configured = shots.filter((shot) => shot.fresh !== true);
    const fresh = shots.filter((shot) => shot.fresh === true);
    if (configured.length > 0) await session(browser, true, configured);
    await cleanUp();
    if (fresh.length > 0) await session(browser, false, fresh);
  } finally {
    await browser.close();
    await cleanUp();
  }
}

await main();
