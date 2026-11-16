import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** The rulebook of a made-up game, written for this walk: the rule on its first page, the exception on its second. */
const RULEBOOK = [
  [
    "Hedgerow Harvest: rules",
    "1. Setup. Shuffle the deck and deal each player five cards. Put the Moon Token beside the deck.",
    "2. On your turn. Draw one card, then play up to two cards, then pass.",
    "3.1 Field cards are placed in front of you and score at the end of the game.",
    "3.2 Fox cards. A Fox card may not be played on the turn it was drawn.",
    "3.3 A Fox card takes one Field card from the player on your left.",
  ],
  [
    "4. The deck. When the deck runs out, shuffle the discards to make a new one, once only.",
    "5. Scoring. Each Field card scores the number printed on it.",
    "6. The end. The game ends when the second deck runs out.",
    "7.1 The Moon Token. The player holding the Moon Token may ignore rule 3.2 once, then returns the token.",
    "7.2 The token passes to the player with the fewest Field cards at the end of each round.",
  ],
] as const;

async function rulebook(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const lines of RULEBOOK) {
    const sheet = document.addPage([595, 842]);
    lines.forEach((text, line) => sheet.drawText(text, { x: 48, y: 780 - line * 24, size: 11, font }));
  }
  return document.save();
}

const FILE = "hedgerow-harvest-rules.pdf";
const directories = temporaryDirectories();
const folder = directories.create("tavi-recipe-rules-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(folder, FILE), await rulebook());

let page: Page;

walkGuide("everyday/hobbies-and-games/rules", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("learning.rules", {
        game: "Hedgerow Harvest",
        "the dispute": "my friend says a Fox card can be played on the turn it was drawn, and I say it can't",
        "rulebook file, if any": FILE,
      });
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(join(folder, FILE));
      await page.getByRole("list", { name: "Attached files" }).getByText(FILE).waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-ruling": async (walk) => {
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("pdf.read");
      const text = (await (await lastAnswer(page)).textContent()) ?? "";
      // It quotes the rule that decides it, and the exception on the other page.
      expect(text).toContain("A Fox card may not be played on the turn it was drawn");
      expect(text).toMatch(/3\.2/);
      expect(text).toMatch(/Moon Token/i);
      expect(text).toMatch(/7\.1/);
      await wholeAnswer(walk, page);
    },
  },
});
