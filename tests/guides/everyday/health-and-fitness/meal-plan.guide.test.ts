import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { keptWith, newChat, proposeFromChat } from "../../support/memory.js";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/health-and-fitness/meal-plan", {
  configured: true,
  model: true,
  steps: {
    "tell-tavi-what-you-don-t-eat": async (walk) => {
      const home = await walk.open("/");
      await newChat(home);
      const card = await proposeFromChat(home, "Remember that I don't eat mushrooms.");
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      expect(keptWith(walk, "mushrooms")?.status).toBe("approved");
      await walk.shot(card);
    },
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt("health-home.meal-plan", { goal: "quick weeknight dinners" }));
    },
    "read-the-plan": async (walk) => {
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/shopping/i);
      expect(text).toMatch(/Mon/);
      // The fact it was told: a sentence may say it left them out, but none may put them in a meal.
      const named = text.split(/(?<=[.!?:])\s+|\n/).filter((line) => /mushroom/i.test(line));
      expect(
        named.filter(
          (line) => !/\b(no|not|zero|without|free|skip\w*|avoid\w*|omit\w*|exclud\w*|left out|don't|isn't|instead|swap\w*)\b/i.test(line),
        ),
      ).toEqual([]);
      await wholeAnswer(walk, page);
    },
  },
});
