import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, readFromTheTop, recipePrompt } from "../../support/recipes.js";
import { chats, lastAnswer, turnEnded } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/learning/tech-roadmap", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(
        walk,
        recipePrompt("learning.tech-roadmap", {
          "where I am": "knowing basic Python",
          goal: "building and publishing a small web app",
        }),
      );
    },
    "read-the-result": async (walk) => {
      await turnEnded(page);
      // It looked them up, and each step can be followed: the answer links out.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      const answer = await lastAnswer(page);
      await expect.poll(() => answer.locator('a[href^="http"]').count()).toBeGreaterThanOrEqual(3);
      await readFromTheTop(walk, page);
    },
  },
});
