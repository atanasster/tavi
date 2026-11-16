#!/usr/bin/env node
// Renders the documentation's brand images from scripts/docs/banner.html:
// docs/assets/brand/banner-light.png and banner-dark.png, at twice the size
// they are shown. Run from the repository root after `pnpm install`:
//
//   node scripts/docs/render-assets.mjs
//
// The fonts are the canvas's self-hosted faces; the browser is the browser
// plugin's Playwright (scripts/docs/browser.mjs).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { launchBrowser, root } from "./browser.mjs";

const fromCanvas = createRequire(join(root, "apps/ui/package.json"));
const font = (pkg, file) => pathToFileURL(join(dirname(fromCanvas.resolve(`${pkg}/package.json`)), "files", file)).href;
const html = readFileSync(join(root, "scripts/docs/banner.html"), "utf8")
  .replace("{{BRICOLAGE}}", font("@fontsource-variable/bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2"))
  .replace("{{INTER}}", font("@fontsource-variable/inter", "inter-latin-wght-normal.woff2"));

const out = join(root, "docs/assets/brand");
mkdirSync(out, { recursive: true });
// The filled page holds absolute paths into node_modules: it is drawn from a scratch folder, never from the docs.
const scratch = mkdtempSync(join(tmpdir(), "tavi-banner-"));
try {
  const page = join(scratch, "banner.html");
  writeFileSync(page, html);
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 320 }, deviceScaleFactor: 2 });
    const tab = await context.newPage();
    await tab.goto(pathToFileURL(page).href);
    for (const theme of ["light", "dark"]) {
      await tab.evaluate((value) => {
        document.documentElement.dataset["theme"] = value;
      }, theme);
      await tab.evaluate(() => document.fonts.ready);
      await tab.screenshot({ path: join(out, `banner-${theme}.png`) });
      console.log(`docs/assets/brand/banner-${theme}.png`);
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
