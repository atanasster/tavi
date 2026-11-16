import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/health-and-fitness/thought-record", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt("health-home.thought-record", { situation: "a tense work meeting I had yesterday" }));
    },
    "say-what-happened": async (walk) => {
      await wholeAnswer(walk, page);
    },
    "weigh-the-evidence": async (walk) => {
      await send(
        page,
        "In yesterday's team meeting my manager questioned my project timeline in front of everyone. I thought: they think I'm not up to this job. I felt anxious, about 7 out of 10.",
      );
      await wholeAnswer(walk, page);
    },
    "read-the-balanced-thought": async (walk) => {
      await send(
        page,
        "For it: she questioned the timeline in front of everyone. Against it: she asked about the dates, not about me, she gave me this project herself, and she thanked me afterwards. Now write out the finished thought record as a short list, with a more balanced thought.",
      );
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/balanced|alternative/i);
      await wholeAnswer(walk, page);
    },
  },
});
