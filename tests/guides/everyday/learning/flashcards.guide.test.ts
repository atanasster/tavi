import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { onePagePdf, type PdfLine, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A made-up textbook chapter, one page: its words are nobody's book. */
const CHAPTER: readonly PdfLine[] = [
  ["Chapter 3: The water cycle", 16, "bold"],
  ["Water moves between the sea, the air and the land in a cycle that has no start or end.", 11, "plain"],
  ["Evaporation: the sun's heat turns liquid water from seas and lakes into water vapour.", 11, "plain"],
  ["Transpiration: plants release water vapour through small pores in their leaves.", 11, "plain"],
  ["Condensation: rising vapour cools and turns into tiny droplets, which form clouds.", 11, "plain"],
  ["Precipitation: droplets join until they are heavy enough to fall as rain, sleet, hail or snow.", 11, "plain"],
  ["Infiltration: some of the water soaks into the ground and is stored as groundwater.", 11, "plain"],
  ["Runoff: water that cannot soak in flows over the land into rivers and back to the sea.", 11, "plain"],
  ["Why it matters", 13, "bold"],
  ["About 97 per cent of the Earth's water is salt water in the oceans.", 11, "plain"],
  ["Evaporation leaves the salt behind, so the cycle is what gives the land fresh water.", 11, "plain"],
];

/** The reader's file, made for the walk in a folder of its own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-recipe-flashcards-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(files, "water-cycle.pdf"), await onePagePdf(CHAPTER));

let page: Page;

walkGuide("everyday/learning/flashcards", {
  configured: true,
  model: true,
  steps: {
    "attach-the-chapter": async (walk) => {
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(join(files, "water-cycle.pdf"));
      await page.getByRole("list", { name: "Attached files" }).getByText("water-cycle.pdf").waitFor();
      const prompt = recipePrompt("learning.flashcards", { "chapter or article": "chapter", "file or link": "water-cycle.pdf" });
      await page.locator(".composer-box textarea").fill(prompt);
      await walk.shot(page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-cards": async (walk) => {
      // It read the file, and the cards come from it.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("pdf.read");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/transpiration/i);
      await wholeAnswer(walk, page);
    },
    "get-them-ready-for-anki": async (walk) => {
      await send(
        page,
        "Shorten every back to eight words at most, then give me the cards as plain text in one code block: one card per line, the front and the back separated by a tab, with no heading line.",
      );
      const answer = await lastAnswer(page);
      const block = answer.locator("pre").first();
      await block.waitFor();
      // Each line is a card Anki can import: a front, a tab, a back.
      const lines = ((await block.textContent()) ?? "").split("\n").filter((text) => text.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines.filter((text) => text.split("\t").length === 2).length).toBe(lines.length);
      await wholeAnswer(walk, page);
    },
  },
});
