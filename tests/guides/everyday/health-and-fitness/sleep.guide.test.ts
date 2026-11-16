import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { keptWith, memoryCard, slash } from "../../support/memory.js";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const times = "Mon 00:40-06:50, Tue 01:10-06:50, Wed 00:20-06:50, Thu 01:30-06:50, Fri 02:00-09:30, Sat 02:15-10:00, Sun 01:00-07:30";

let page: Page;

walkGuide("everyday/health-and-fitness/sleep", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt("health-home.sleep", { times }));
    },
    "read-the-routine": async (walk) => {
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/routine|wake|bed/i);
      await wholeAnswer(walk, page);
    },
    "keep-what-you-re-trying": async (walk) => {
      await slash(page, "/remember I'm trying a fixed wake-up time of 06:50 for better sleep");
      const card = await memoryCard(page, 30_000);
      expect(keptWith(walk, "wake-up time")?.status).toBe("approved");
      await walk.shot(card);
    },
  },
});
