import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { readFromTheTop, recipePrompt, shotAlone } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A drawn flat-lay of eight pieces of clothing, saved as a GIF: nobody's photo. */
const picture = join(root, "tests/guides/everyday/shopping-and-style/fixtures/wardrobe.gif");

let page: Page;

walkGuide("everyday/shopping-and-style/capsule", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("shopping.capsule", { "photos or list": "in this picture" });
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(picture);
      await page.getByRole("list", { name: "Attached files" }).getByText("wardrobe.gif").waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-result": async (walk) => {
      // It looked at the picture: the outfits are made of what is in it, and it names what to add.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("artifacts.view_image");
      const answer = (await lastAnswer(page)).locator(".markdown").last();
      await expect(answer.textContent()).resolves.toMatch(/blazer/i);
      await expect(answer.textContent()).resolves.toMatch(/jeans/i);
      await expect(answer.textContent()).resolves.toMatch(/add/i);
      await readFromTheTop(walk, page);
    },
  },
});
