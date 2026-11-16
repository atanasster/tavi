import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { allowUntilEnded, recipePrompt, sendThroughCards, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { dismissChecklist, homeId, lastAnswer, restartOwner, useRealTmpdir } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

useRealTmpdir();

/** Generated pictures of nothing, each with EXIF of its own: two days in Lisbon, two in Bath, and a scan with no location. */
const PHOTOS = ["IMG_0412.jpg", "IMG_0098.jpg", "DSC_2231.jpg", "IMG_0100.jpg", "scan_07.jpg"];
const fixtures = join(root, "tests/guides/everyday/hobbies-and-games/fixtures");

/** The reader's pictures, made for the walk in a folder of their own. */
const directories = temporaryDirectories();
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
const pictures = join(directories.create("tavi-recipe-photo-organise-"), "Pictures");
const holiday = join(pictures, "holiday");
mkdirSync(holiday, { recursive: true });
for (const name of PHOTOS) copyFileSync(join(fixtures, `photos-${name}`), join(holiday, name));

/** Every file under the folder, by its path there. */
const filesNow = (): string[] =>
  readdirSync(holiday, { recursive: true, encoding: "utf8" }).filter((path) => statSync(join(holiday, path)).isFile());

/** The chat's newest card, once it waits. */
async function waitingCard(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Allow once" }).last().waitFor({ timeout: 240_000 });
  return page.locator("section.round").last();
}

let page: Page;

walkGuide("everyday/hobbies-and-games/photo-organise", {
  configured: true,
  model: true,
  timeoutMs: 900_000,
  steps: {
    "attach-the-folder": async (walk) => {
      await restartOwner(walk.dataDir, ["--fs-root", pictures]);
      // A reader has talked to Home before: the picture shows Home's own folders beside the one attached.
      walk.tavi("run", "--home", "Say hello in two words.");
      page = await walk.open(`/tasks/${homeId(walk.tavi)}`);
      await dismissChecklist(page);
      // The panel hangs to the right of the chip: a wide window shows it whole.
      await page.setViewportSize({ width: 1920, height: 1000 });
      const chip = page.locator(".folder-chip:visible").last();
      await chip.click();
      const panel = page.locator(".folder-panel");
      await panel.getByRole("button", { name: /^Attach a folder/ }).click();
      await panel.getByRole("button", { name: "Open Pictures" }).click();
      await panel.getByRole("button", { name: "Attach read-write: holiday" }).click();
      await panel.getByRole("button", { name: "Detach holiday" }).waitFor();
      expect(walk.tavi("tasks", "folder", homeId(walk.tavi))).toMatch(/holiday \(read-write\)/);
      await shotAlone(walk, panel);
      await chip.click();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "ask-for-it": async (walk) => {
      const box = page.locator(".composer-box");
      await box.locator("textarea").fill(recipePrompt("productivity.photo-organise", {}));
      await shotAlone(walk, box.locator(".."));
      await sendThroughCards(page, recipePrompt("productivity.photo-organise", {}));
    },
    "read-the-plan": async (walk) => {
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("sandbox.run");
      const text = (await (await lastAnswer(page)).textContent()) ?? "";
      // It read the dates and places out of the files, and nothing has moved.
      expect(text).toMatch(/2026-07-14|20260714/);
      expect(text).toMatch(/2026-04-03|20260403/);
      expect(text).toMatch(/Lisbon/);
      expect(text).toMatch(/Bath/);
      expect(text).toMatch(/scan_07/);
      expect(filesNow().sort()).toEqual([...PHOTOS].sort());
      await wholeAnswer(walk, page);
    },
    "allow-the-moves": async (walk) => {
      const box = page.locator(".composer-box textarea");
      await box.fill("Go ahead.");
      await box.press("Enter");
      const card = await waitingCard(page);
      await shotAlone(walk, card);
      expect(filesNow().sort()).toEqual([...PHOTOS].sort());
      await allowUntilEnded(page, 240_000);
    },
    "check-the-folder": async (walk) => {
      const now = filesNow();
      // Five files still, none lost, none under its old name but the one with no place it may leave; the bytes moved with them.
      expect(now.length).toBe(5);
      expect(now.filter((path) => /2026[-_/]?07/.test(path)).length).toBe(2);
      expect(now.filter((path) => /2026[-_/]?04/.test(path)).length).toBe(2);
      expect(now.filter((path) => /lisbon/i.test(path)).length).toBe(2);
      expect(now.filter((path) => /bath/i.test(path)).length).toBe(2);
      const sizes = now.map((path) => readFileSync(join(holiday, path)).length).sort();
      expect(sizes).toEqual(PHOTOS.map((name) => statSync(join(fixtures, `photos-${name}`)).size).sort());
      await wholeAnswer(walk, page);
    },
  },
});
