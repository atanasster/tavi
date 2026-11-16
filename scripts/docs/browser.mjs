// What the documentation's image scripts share: the repository root, a way
// to report a wait that missed, and a headless browser to draw with — the
// browser plugin's own Playwright, so the scripts add no dependency of their
// own.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Playwright's own Chromium, else the Google Chrome installed on this machine;
 * when neither starts, the error says both reasons and the install command.
 */
export async function launchBrowser() {
  const { chromium } = createRequire(join(root, "packages/builtin/browser/package.json"))("playwright");
  try {
    return await chromium.launch();
  } catch (first) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch (second) {
      throw new Error(
        `no browser to draw with. Install Playwright's Chromium with \`pnpm --filter @tavi/plugin-browser exec playwright install chromium\`, or install Google Chrome.\n  Chromium: ${first.message.split("\n")[0]}\n  Chrome: ${second.message.split("\n")[0]}`,
      );
    }
  }
}

/** A wait that did not see what it waited for: said, and the run exits 1 at the end. */
export function missed(what) {
  console.warn(`missed: ${what}`);
  process.exitCode = 1;
}
