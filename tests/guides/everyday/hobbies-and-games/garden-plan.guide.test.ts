import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, footOf, readFromTheTop, recipePrompt, searchedTheWeb, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** An RHS rating says how much cold a plant stands: a town has none, and it is no USDA zone. */
function ratesNoPlace(text: string): void {
  expect(text, "no RHS rating").not.toMatch(/\bH[1-7][a-c]?\b/);
  expect(text, "no RHS rating as a USDA zone").not.toMatch(
    /RHS[^.]{0,60}(correspond|equivalent|equal|map)|(correspond|equivalent|equal|map)[^.]{0,60}RHS/i,
  );
}

let page: Page;

walkGuide("everyday/hobbies-and-games/garden-plan", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("learning.garden-plan", { location: "Bristol, UK", "bed sizes": "two raised beds, each 2 m by 1 m" });
      page = await askForIt(walk, `${prompt} Give my zone as a USDA zone: RHS ratings are for plants, not places.`);
    },
    "read-the-plan": async (walk) => {
      await searchedTheWeb(page);
      const answer = await lastAnswer(page);
      // Its words alone: the search results above them may well quote the RHS's own table.
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      // Bristol sits in USDA zones 8 to 9; a zone a reader would plant by, with where it came from.
      expect(text).toMatch(/zones? *(8|9)[ab]?\b/i);
      ratesNoPlace(text);
      expect(text).toMatch(/compan/i);
      const foot = await footOf(answer, ".markdown > ul, .markdown > ol", 860);
      expect(foot).toBeGreaterThan(300);
      await readFromTheTop(walk, page, foot);
    },
    "get-the-calendar-as-a-table": async (walk) => {
      await sendThroughCards(
        page,
        "Put the sowing calendar in one table, with a row for each crop and the months to sow it, and link the page you took my hardiness zone from.",
      );
      const answer = await lastAnswer(page);
      const rows = answer.locator("table tr");
      await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(5);
      await expect.poll(() => answer.locator('a[href^="http"]').count()).toBeGreaterThanOrEqual(1);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      // Tomatoes start indoors in spring, whatever else the table holds.
      const tomatoes =
        (await rows
          .filter({ hasText: /tomato/i })
          .first()
          .textContent()) ?? "";
      expect(tomatoes).toMatch(/feb|mar|apr/i);
      expect(text).toMatch(/mar/i);
      ratesNoPlace(text);
      await wholeAnswer(walk, page);
    },
  },
});
