import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, recipePrompt, searchedTheWeb, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/vehicles/car-code", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt("travel.car-code", { "car model and year": "2016 Toyota Corolla", code: "P0420" }));
    },
    "see-what-it-looked-up": async (walk) => {
      await searchedTheWeb(page);
      // Opened, the row lists what Tavi searched for.
      const worked = (await lastAnswer(page)).locator("details.tools").first();
      await worked.locator("summary").first().click();
      await worked.scrollIntoViewIfNeeded();
      await shotAlone(walk, worked);
      await worked.locator("summary").first().click();
    },
    "read-the-result": async (walk) => {
      await expect(page.locator("main .markdown").last().textContent()).resolves.toMatch(/catalytic|catalyst/i);
      await wholeAnswer(walk, page);
    },
  },
});
