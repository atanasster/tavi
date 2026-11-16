import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { addThePlacesApp, promptAnswered, recipePrompt, refuseTheBrowser, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("health-home.neighbourhood", { address: "Union Square, New York" });

let page: Page;

walkGuide("everyday/local-services/neighbourhood", {
  configured: true,
  model: true,
  timeoutMs: 600_000,
  seed: [SEED_ZONE],
  steps: {
    "add-the-places-app": addThePlacesApp,
    "ask-for-it": async (walk) => {
      const answering = { onCard: refuseTheBrowser, timeoutMs: 360_000 };
      page = await promptAnswered(walk, PROMPT, answering);
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      const ran = new Set(tools.map((call) => call.toolName));
      expect(ran, "what's nearby came from the places search").toContain("places.open.search");
      expect(ran, "the noise came from the open data").toContain("places.open.area_report");
      const text = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/noise/i);
      // The numbers a reader may act on are the open data's, not the model's own.
      const report = JSON.stringify(tools.filter((call) => call.toolName === "places.open.area_report"));
      const counts = [...report.matchAll(/count\\*":(\d+)/g)].map(([, count]) => count ?? "");
      expect(
        counts.some((count) => text.includes(count)),
        "a count from the report",
      ).toBe(true);
      expect(text, "no business's phone").not.toMatch(/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/);
      await wholeAnswer(walk, page);
    },
  },
});
