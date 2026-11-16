import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { keptWith, proposeFromChat } from "../../support/memory.js";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

interface Reminder {
  readonly text: string;
  readonly status: string;
}

walkGuide("everyday/vehicles/bike-wear", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(walk, recipePrompt("travel.bike-wear", { distance: "80 km" }));
    },
    "read-the-result": async (walk) => {
      await expect(page.locator("main .markdown").last().textContent()).resolves.toMatch(/chain/i);
      await wholeAnswer(walk, page);
    },
    "have-it-remember-your-bike": async (walk) => {
      const card = await proposeFromChat(page, "Remember that I ride about 80 km a week and that I fitted a new chain this month.");
      await card.getByRole("button", { name: /^Keep: / }).waitFor();
      await walk.shot(card);
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      expect(keptWith(walk, "80 km"), "the bike is kept").toBeDefined();
    },
    "get-a-reminder-to-check-it": async (walk) => {
      await send(page, "Remind me to check my chain wear on the first Saturday of next month at 10:00.");
      // Made without an approval card: the workspace's reminders rule allows it.
      await expect(page.getByText("Needs your approval").count()).resolves.toBe(0);
      const reminders = walk.taviJson<{ reminders: Reminder[] }>("reminders", "list").reminders;
      expect(reminders.find((reminder) => /chain/i.test(reminder.text))?.status).toBe("active");
      await wholeAnswer(walk, page);
    },
  },
});
