import { constants, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { restartOwner } from "./steps.js";

/**
 * The video guides' setup, as a reader's: the models they downloaded put in `<data>/video/models`, named in
 * `<data>/video/analyzers.json`, and `tavi serve` restarted to read it.
 */

/** Where the walks keep the models a reader downloads themselves (whisper.cpp's ggml-base.bin, RTMPose and RTMDet). */
const models = process.env["TAVI_GUIDE_VIDEO_MODELS"] ?? join(homedir(), ".cache/tavi-video-models");

/** Copies `files` from the walks' models folder into the data directory, writes `analyzers`, and restarts the owner. */
export async function installAnalyzers(dataDir: string, files: readonly string[], analyzers: unknown): Promise<void> {
  const into = join(dataDir, "video/models");
  mkdirSync(into, { recursive: true });
  for (const file of files) {
    const from = join(models, file);
    if (!existsSync(from)) throw new Error(`no ${from}: download it there (or set TAVI_GUIDE_VIDEO_MODELS)`);
    // A clone where the disk allows it: the models are tens to hundreds of MB.
    copyFileSync(from, join(into, file), constants.COPYFILE_FICLONE);
  }
  writeFileSync(join(dataDir, "video/analyzers.json"), `${JSON.stringify(analyzers)}\n`);
  await restartOwner(dataDir, []);
}

/** Settings → Models → Video analysers, checked, once `analyser` shows in it: the card. */
export async function checkedAnalyzers(page: Page, analyser: RegExp): Promise<Locator> {
  const card = page.getByRole("region", { name: "Video analysers" });
  await card.getByRole("button", { name: "Check" }).click();
  await expect.poll(() => card.textContent(), { timeout: 30_000 }).toMatch(analyser);
  await card.scrollIntoViewIfNeeded();
  return card;
}
