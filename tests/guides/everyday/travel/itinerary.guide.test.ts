import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { addThePlacesApp, footOf, promptAnswered, readFromTheTop, recipePrompt, refuseTheBrowser } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("travel.itinerary", {
  city: "Porto",
  interests: "azulejo tiles and old bookshops",
  diet: "a vegetarian",
});

let page: Page;

walkGuide("everyday/travel/itinerary", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "add-the-places-app": addThePlacesApp,
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT, { onCard: refuseTheBrowser, timeoutMs: 300_000 });
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      expect(
        tools.some((call) => call.toolName === "places.open.search"),
        "the places came from the places search",
      ).toBe(true);
      // Only the start of the day: an address the model writes from memory can be wrong, and a page keeps it for good.
      const foot = await footOf(await lastAnswer(page), ".markdown > ul, .markdown > ol > li", 600);
      expect(foot, "a whole block fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
  },
});
