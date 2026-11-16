import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE, inDays } from "../../support/automation.js";
import { promptInTheBox, recipePrompt, searchedTheWeb, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

interface Reminder {
  readonly text: string;
  readonly nextFireAt: string | null;
}

const PROMPT = recipePrompt("health-home.appliance-records", { "appliance, model or serial": "Bosch SMS4HVI33E dishwasher" });

let page: Page;

walkGuide("everyday/life-admin/appliance-records", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptInTheBox(walk, PROMPT);
      await sendThroughCards(page, PROMPT);
    },
    "read-the-result": async (walk) => {
      await searchedTheWeb(page);
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/warranty|guarantee/i);
      const links = await answer.locator(".markdown a").evaluateAll((all) => all.map((link) => (link as HTMLAnchorElement).href));
      expect(links.length, "the manual links to where it was found").toBeGreaterThan(0);
      await wholeAnswer(walk, page);
    },
    "check-the-reminders": async (walk) => {
      const { reminders } = walk.taviJson<{ reminders: Reminder[] }>("reminders", "list");
      expect(reminders.length, "the maintenance has reminders").toBeGreaterThan(0);
      for (const reminder of reminders) {
        expect(new Date(reminder.nextFireAt ?? 0).toISOString().slice(0, 10) >= inDays(0), reminder.text).toBe(true);
      }
      const screen = await walk.terminal({ title: "tavi reminders list", args: ["reminders", "list"] });
      expect(screen.join("\n")).toMatch(/dishwasher/i);
    },
  },
});
