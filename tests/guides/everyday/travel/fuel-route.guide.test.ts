import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { allowUntilAnswered, newestTask, toolCalls } from "../../support/browser-site.js";
import { addThePlacesApp, promptInTheBox, readFromTheTop, recipePrompt } from "../../support/recipes.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("travel.fuel-route", { A: "Lyon", B: "Bordeaux" });

let page: Page;

walkGuide("everyday/travel/fuel-route", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "add-the-places-app": addThePlacesApp,
    "ask-for-it": async (walk) => {
      page = await promptInTheBox(walk, PROMPT);
      const before = await page.getByRole("button", { name: "Copy response" }).count();
      await page.locator(".composer-box textarea").press("Enter");
      await allowUntilAnswered(page, before);
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      expect(
        tools.some((call) => call.toolName === "places.open.route_stops"),
        "the stops came from the route tool",
      ).toBe(true);
      await readFromTheTop(walk, page);
    },
  },
});
