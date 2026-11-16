import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { allowUntilAnswered, sendPrompt } from "../../support/browser-site.js";
import { askForIt, recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

useRealTmpdir();

/** The clutter, every file invented for the walk: never a real Downloads. The last two are the same notes twice. */
const CLUTTER: Readonly<Record<string, string>> = {
  "boiler-service-invoice-march.txt": "Larkfield Heating: annual boiler service, 3 March, 85.00 paid.\n",
  "council-tax-letter-2026.txt": "Made-up council: your council tax for 2026 to 2027 is 1,640.00.\n",
  "car-insurance-renewal.txt": "Made-up Mutual: your car insurance renews on 14 June.\n",
  "budget-2026.csv": "month,spent\njanuary,1210\nfebruary,1185\n",
  "flight-itinerary-lisbon.txt": "Flight to Lisbon, 12 May, seat 14C.\n",
  "hotel-booking-lisbon.txt": "Pensao Exemplo, Lisbon, 12 to 16 May.\n",
  "holiday-packing-list.txt": "Passport, sun hat, adaptor, walking shoes.\n",
  "banana-bread-recipe.txt": "Three ripe bananas, flour, butter, an hour at 170.\n",
  "pasta-bake-recipe.txt": "Pasta, tomatoes, mozzarella, thirty minutes at 200.\n",
  "tax-year-2025-summary.txt": "Made-up summary of the 2025 tax year.\n",
  "notes (1).txt": "Ring the plumber about the kitchen tap.\n",
  "notes (1) copy.txt": "Ring the plumber about the kitchen tap.\n",
};

/** The folder: made in the first step, deleted when the walk ends. */
let folder = "";

/** Each file under the folder, by where it is: what it holds. */
const contents = (): Map<string, string> => {
  const found = new Map<string, string>();
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.set(relative(folder, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return found;
};
/** The folder as the walk made it. */
let before = new Map<string, string>();

const PROMPT = recipePrompt("productivity.downloads-cleanup", {});

let page: Page;

/** The chat's folder panel, wide enough for it to show whole. */
async function openPanel(): Promise<ReturnType<Page["locator"]>> {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.locator(".folder-chip:visible").last().click();
  const panel = page.locator(".folder-panel");
  await panel.waitFor();
  return panel;
}

walkGuide("everyday/life-admin/downloads-cleanup", {
  configured: true,
  model: true,
  timeoutMs: 600_000,
  steps: {
    "ask-for-it": async (walk) => {
      const files = Object.entries(CLUTTER).map(([name, text]) => [`practice-downloads/${name}`, text]);
      folder = join(projectsFolder("downloads-cleanup", Object.fromEntries(files)), "practice-downloads");
      before = contents();
      await restartOwner(walk.dataDir, ["--fs-root", folder]);
      page = await askForIt(walk, PROMPT);
    },
    "read-the-plan": async (walk) => {
      expect(contents(), "the plan moved nothing").toEqual(before);
      await wholeAnswer(walk, page);
    },
    "open-the-folder-for-writing": async (walk) => {
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      const panel = await openPanel();
      await panel.getByRole("button", { name: "Detach practice-downloads" }).click();
      await expect.poll(() => walk.tavi("tasks", "folder", chat?.taskId ?? ""), { timeout: 15_000 }).not.toMatch(/practice-downloads \(/);
      await panel.getByRole("button", { name: /^Attach a folder/ }).click();
      await panel.getByRole("button", { name: "Attach read-write: practice-downloads" }).click();
      await expect
        .poll(() => walk.tavi("tasks", "folder", chat?.taskId ?? ""), { timeout: 15_000 })
        .toMatch(/practice-downloads \(read-write\)/);
      await panel.getByRole("button", { name: "Detach practice-downloads" }).waitFor();
      await panel.getByRole("button", { name: /^Attach a folder/ }).click();
      await panel.getByRole("button", { name: "practice-downloads", exact: true }).click();
      await panel.getByText("banana-bread-recipe.txt").waitFor();
      await shotAlone(walk, panel);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "approve-the-moves": async (walk) => {
      const answers = await sendPrompt(page, "OK, go ahead. Don't delete anything.");
      let shown = false;
      await allowUntilAnswered(page, answers, {
        onCard: async (card) => {
          if (!shown) {
            await page.setViewportSize({ width: 1280, height: 1300 });
            await shotAlone(walk, card);
            await page.setViewportSize({ width: 1280, height: 800 });
          }
          shown = true;
          await card.getByRole("button", { name: "Allow once" }).click({ timeout: 3_000 });
        },
      });
      expect(shown, "the moves asked first").toBe(true);
    },
    "check-the-folder": async (walk) => {
      const after = contents();
      const name = (path: string) => path.split("/").at(-1) ?? "";
      expect([...after.keys()].map(name).toSorted(), "every file is still there").toEqual([...before.keys()].toSorted());
      for (const [path, hash] of after) expect(hash, `${path} is unchanged`).toBe(before.get(name(path)));
      expect(
        [...after.keys()].every((path) => path.includes("/")),
        "every file is in a folder",
      ).toBe(true);
      const panel = await openPanel();
      await panel.getByRole("button", { name: "practice-downloads", exact: true }).first().click();
      await panel.getByRole("list", { name: "Files" }).getByRole("button").first().waitFor();
      await shotAlone(walk, panel);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
