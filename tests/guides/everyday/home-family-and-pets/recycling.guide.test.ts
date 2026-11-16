import { join } from "node:path";

import { expect } from "vitest";

import { root, type Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { wholeAnswer, recipePrompt, sendThroughCards, shotAlone } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A drawn empty jar with a metal lid, saved as a GIF, the kind of picture the canvas takes: nobody's photo. */
const picture = join(root, "tests/guides/everyday/home-family-and-pets/fixtures/empty-jar.gif");

const PROMPT = recipePrompt("health-home.recycling", { city: "Bristol", "photo or description": "empty-jar.gif" });

let page: Page;

walkGuide("everyday/home-family-and-pets/recycling", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(picture);
      await page.getByRole("list", { name: "Attached files" }).getByText("empty-jar.gif").waitFor();
      await page.locator(".composer-box textarea").fill(PROMPT);
      await shotAlone(walk, page.locator(".composer-box").locator(".."));
    },
    "read-the-result": async (walk) => {
      // Once the chat holds a picture, a search can ask first.
      await sendThroughCards(page, PROMPT);
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      const history = walk.tavi("tasks", "history", chat?.taskId ?? "");
      expect(history).toContain("artifacts.view_image");
      expect(history).toContain("web_search");
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/jar/i);
      expect(text).toMatch(/bristol/i);
      await wholeAnswer(walk, page);
    },
  },
});
