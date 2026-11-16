import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, readFromTheTop, recipePrompt, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/learning/mix-practice", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(
        walk,
        recipePrompt("learning.mix-practice", {
          instrument: "piano",
          level: "beginner level",
          goal: "playing a simple waltz with both hands",
        }),
      );
    },
    "read-the-plan": async (walk) => {
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/week|monday|day 1/i);
      await readFromTheTop(walk, page);
    },
    "find-free-lessons-to-go-with-it": async (walk) => {
      await sendThroughCards(page, "Search the web for two free beginner lessons that fit this plan, and give me their links.");
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      const answer = await lastAnswer(page);
      await expect.poll(() => answer.locator('a[href^="http"]').count()).toBeGreaterThanOrEqual(2);
      await wholeAnswer(walk, page);
    },
  },
});
