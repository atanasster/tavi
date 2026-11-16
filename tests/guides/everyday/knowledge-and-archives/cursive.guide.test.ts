import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A letter drawn for the guide, in a joined-up hand with a blot over one word: its people and places are made up. */
const picture = join(root, "tests/guides/everyday/knowledge-and-archives/fixtures/letter.gif");

/** What the letter says, phrase by phrase, either side of the blot: the words a transcription must get right. */
const LETTER = [
  "marrow bridge",
  "14th march 1923",
  "my dear cousin tamsin",
  "the thaw came early this year and the river has risen over the lower meadow",
  "father sold the two grey ponies at easterby fair for nineteen pounds which pleased him greatly",
  "mother asks if you will come to us in may when the orchard is in blossom",
  "bring the blue shawl and your",
  "the plum cakes",
  "your loving cousin",
  "elspeth marchbank",
];

/** The follow-up, as the page gives it. */
const UNSURE =
  "Going by what you have already read, without opening the letter again, which words are you least sure of? For each, say what else it could be.";

/** Lower case, with only letters, digits and single spaces left, so line breaks and marks don't count. */
const plain = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

let page: Page;

walkGuide("everyday/knowledge-and-archives/cursive", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("learning.cursive", { image: "letter.gif" });
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(picture);
      await page.getByRole("list", { name: "Attached files" }).getByText("letter.gif").waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-transcription": async (walk) => {
      // It looked at the picture, and what it wrote down is what the letter says, word for word.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("artifacts.view_image");
      const answer = (await (await lastAnswer(page)).locator(".markdown").last().textContent()) ?? "";
      const read = plain(answer);
      expect(LETTER.filter((phrase) => !read.includes(phrase))).toEqual([]);
      // The blot is marked as a word it couldn't read, not filled in.
      expect(answer).toMatch(/\[[^\]]*(\?|illegible|unclear|blot|smudge|unreadable|obscured|ink)[^\]]*\]/i);
      await wholeAnswer(walk, page);
    },
    "ask-what-it-was-least-sure-of": async (walk) => {
      await send(page, UNSURE);
      const answer = (await (await lastAnswer(page)).locator(".markdown").last().textContent()) ?? "";
      expect(answer).toMatch(/blot|smudge|illegible|obscured|ink/i);
      await wholeAnswer(walk, page);
    },
  },
});
