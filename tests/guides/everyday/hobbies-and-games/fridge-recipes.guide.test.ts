import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { footOf, readFromTheTop, recipePrompt, shotAlone } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A drawn fridge of labelled food, each with a tag saying how long it has: nobody's kitchen. */
const fridge = join(root, "tests/guides/everyday/hobbies-and-games/fixtures/fridge.gif");

let page: Page;

walkGuide("everyday/hobbies-and-games/fridge-recipes", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("health-home.fridge-recipes", { "list or photo": "this picture" });
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(fridge);
      await page.getByRole("list", { name: "Attached files" }).getByText("fridge.gif").waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-result": async (walk) => {
      const answer = await lastAnswer(page);
      const text = (await answer.textContent()) ?? "";
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("artifacts.view_image");
      // What the picture's tags say goes first comes first: the two "use today"s lead, before the long-keeping cheddar.
      expect(text).toMatch(/spinach/i);
      expect(text).toMatch(/rice/i);
      expect(text).toMatch(/chicken/i);
      expect(text.search(/spinach/i)).toBeLessThan(text.search(/cheddar|$/i));
      // Ends where a recipe's method ends, not partway down the next recipe's ingredients.
      const foot = await footOf(answer, ".markdown ol, .markdown > ul", 880);
      expect(foot).toBeGreaterThan(300);
      await readFromTheTop(walk, page, foot);
    },
  },
});
