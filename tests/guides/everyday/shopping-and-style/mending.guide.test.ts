import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { footOf, readFromTheTop, recipePrompt, sendThroughCards, shotAlone } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A drawn pair of jeans with a tear at the knee, saved as a GIF: nobody's photo. */
const picture = join(root, "tests/guides/everyday/shopping-and-style/fixtures/torn-jeans.gif");

/** The follow-up, as the page gives it. */
const RESALE = "Search the web for what second-hand jeans with a torn knee sell for in the UK, and link what you find.";

let page: Page;

walkGuide("everyday/shopping-and-style/mending", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("shopping.mending", { garment: "my jeans" });
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(picture);
      await page.getByRole("list", { name: "Attached files" }).getByText("torn-jeans.gif").waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await sendThroughCards(page, prompt);
    },
    "read-the-repair": async (walk) => {
      // It looked at the picture: the repair is for the tear in it.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("artifacts.view_image");
      const answer = (await lastAnswer(page)).locator(".markdown").last();
      await expect(answer.textContent()).resolves.toMatch(/knee/i);
      await expect(answer.textContent()).resolves.toMatch(/patch|darn/i);
      // The picture ends on a whole way to mend it, before the rough prices, the next step's subject, and before it is
      // too tall for one picture. All measured from where `readFromTheTop` measures: the top of the turn, not of its words.
      const turn = await lastAnswer(page);
      const start = await turn.boundingBox();
      const resale = await answer
        .getByRole("heading", { name: /resale|resell|sell/i })
        .last()
        .boundingBox();
      expect(resale, "the answer has a part on reselling").not.toBeNull();
      const foot = await footOf(turn, ".markdown > ol, .markdown > ul > li", Math.min((resale?.y ?? 0) - (start?.y ?? 0) - 8, 880));
      expect(foot, "a whole way to mend it fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
    "check-the-resale-price": async (walk) => {
      // The model may price them from what it knows: asked to look, it searches, and says where its figures come from.
      await sendThroughCards(page, RESALE);
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      const answer = await lastAnswer(page);
      await expect(answer.locator(".markdown").last().textContent()).resolves.toMatch(/[£$€]\s?\d/);
      await expect.poll(() => answer.locator('a[href^="http"]').count()).toBeGreaterThanOrEqual(1);
      await readFromTheTop(walk, page);
    },
  },
});
