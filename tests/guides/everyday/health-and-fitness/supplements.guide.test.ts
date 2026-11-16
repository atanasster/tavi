import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { promptInTheBox, recipePrompt, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

interface Reminder {
  readonly text: string;
  readonly when: { readonly kind: string; readonly times?: readonly string[] };
}

const list = "iron at 08:00, calcium at 08:00 and vitamin D at 19:00";

const PROMPT = recipePrompt("health-home.supplements", { list });

let page: Page;

walkGuide("everyday/health-and-fitness/supplements", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptInTheBox(walk, PROMPT);
    },
    "read-the-clashes": async (walk) => {
      // Once the chat has read the web, a reminder asks first.
      await sendThroughCards(page, PROMPT);
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/iron[\s\S]*calcium|calcium[\s\S]*iron/i);
      await wholeAnswer(walk, page);
    },
    "check-your-reminders": async (walk) => {
      const { reminders } = walk.taviJson<{ reminders: Reminder[] }>("reminders", "list");
      for (const supplement of [/iron/i, /calcium/i, /vitamin d/i]) {
        expect(
          reminders.some((reminder) => supplement.test(reminder.text)),
          `a reminder for ${supplement}`,
        ).toBe(true);
      }
      const schedule = await walk.open("/center/schedule");
      await schedule.getByText(/iron/i).first().waitFor();
      await walk.shot();
    },
  },
});
