import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { allowTheSchedule, promptSent, readFromTheTop, recipePrompt, searchedTheWeb } from "../../support/recipes.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("people.tour-radar", { city: "Manchester", artists: "Elbow and Arctic Monkeys" });

let page: Page;

walkGuide("everyday/friends-and-culture/tour-radar", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptSent(walk, PROMPT);
    },
    "make-it-recurring": (walk) => allowTheSchedule(walk, page),
    "read-the-result": async (walk) => {
      await searchedTheWeb(page);
      await readFromTheTop(walk, page);
    },
  },
});
