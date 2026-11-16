import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/learning/language", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(
        walk,
        recipePrompt("learning.language", { situation: "ordering breakfast in a café", language: "Spanish", level: "beginner level" }),
      );
    },
    "play-your-part": async (walk) => {
      // The role-play has begun: the answer is in Spanish, not about it.
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/\b(hola|buenos días|buenas|qué|desea|quiere|gustaría)\b/i);
      await wholeAnswer(walk, page);
    },
    "get-corrected-as-you-go": async (walk) => {
      // Two beginner's mistakes, on purpose: "yo querer" for "quiero", and "una café" for "un café".
      await send(page, "Yo querer una café con leche, por favor.");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/quiero/i);
      await wholeAnswer(walk, page);
    },
  },
});
