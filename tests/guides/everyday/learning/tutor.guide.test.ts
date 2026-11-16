import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

import type { Page } from "../../../../scripts/docs/browser.mjs";

let page: Page;

walkGuide("everyday/learning/tutor", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt("learning.tutor", { topic: "how vaccines work" }));
    },
    "answer-its-question": async (walk) => {
      await wholeAnswer(walk, page);
    },
    "work-it-out-together": async (walk) => {
      await send(page, "I think the body remembers the shape of the germ somehow?");
      await wholeAnswer(walk, page);
    },
  },
});
