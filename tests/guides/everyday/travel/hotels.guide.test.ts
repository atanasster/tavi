import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { footOf, promptAnswered, readFromTheTop, recipePrompt, searchedTheWeb } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("travel.hotels", {
  city: "Lisbon",
  dates: "12 to 15 January 2027",
  "what matters to me": "a quiet room and a metro stop close by",
});

let page: Page;

walkGuide("everyday/travel/hotels", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT);
    },
    "read-the-result": async (walk) => {
      await searchedTheWeb(page);
      await expect(page.locator("main .markdown").last().textContent()).resolves.toMatch(/guests?|reviews?/i);
      // Ends after a whole hotel, what guests say included: it's the page's whole point.
      const foot = await footOf(await lastAnswer(page), ".markdown > ul, .markdown > ol > li", 800);
      expect(foot, "a whole hotel fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
  },
});
