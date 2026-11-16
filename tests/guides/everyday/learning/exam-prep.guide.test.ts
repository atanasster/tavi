import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const KEY = "learning.exam-prep";
const EXAM = "my driving theory test";
const reminders = (walk: { taviJson<T>(...args: string[]): T }) =>
  walk.taviJson<{ reminders: { readonly text: string }[] }>("reminders", "list").reminders;

let page: Page;

walkGuide("everyday/learning/exam-prep", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt(KEY, { exam: EXAM, date: "the first Saturday of next month" }));
    },
    "take-the-quiz": async (walk) => {
      await wholeAnswer(walk, page);
    },
    "get-your-study-plan": async (walk) => {
      await send(
        page,
        "Honestly I'd have to guess at all of those. Road signs and stopping distances are what I find hardest. Plan my study sessions around those two now, and set a reminder for each session.",
      );
      await expect.poll(() => reminders(walk).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
      await wholeAnswer(walk, page);
    },
    "check-the-reminders": async (walk) => {
      const screen = await walk.terminal({ title: "tavi reminders list", args: ["reminders", "list"] });
      expect(screen.join("\n")).toMatch(/\S/);
      expect(reminders(walk).length).toBeGreaterThanOrEqual(2);
    },
  },
});
