import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { allowTheSchedule, promptSent, readFromTheTop, recipePrompt } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("health-home.rental-watch", {
  area: "Leeds",
  budget: "£1,000 a month",
  "must-haves": "two bedrooms and a garden",
});

let page: Page;

walkGuide("everyday/home-family-and-pets/rental-watch", {
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
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/Leeds/);
      await readFromTheTop(walk, page);
    },
  },
});
