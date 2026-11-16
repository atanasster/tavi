import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { keptWith, proposeFromChat } from "../../support/memory.js";
import { promptInTheBox, recipePrompt, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

interface Reminder {
  readonly reminderId: string;
  readonly text: string;
  readonly status: string;
  readonly prompt?: string;
  readonly when: { readonly kind: string; readonly times?: readonly string[]; readonly daysOfWeek?: readonly number[] };
}

const reminders = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<{ reminders: Reminder[] }>("reminders", "list").reminders;

const PROMPT = recipePrompt("people.keep-in-touch", {
  people: "my old colleague Dana and my cousin Priya",
  interval: "week, on Sunday at 18:00,",
});

walkGuide("everyday/friends-and-culture/keep-in-touch", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptInTheBox(walk, PROMPT);
      // A reminder needs no card here, unless the model read a past chat first: then it asks, as the page says.
      await sendThroughCards(page, PROMPT);
    },
    "read-the-result": async (walk) => {
      const reminder = reminders(walk)[0];
      expect(reminder?.when).toMatchObject({ kind: "repeat", times: ["18:00"], daysOfWeek: [0] });
      // Each fire also starts a task, which is what suggests something to talk about.
      expect(reminder?.prompt).toMatch(/Dana/);
      await wholeAnswer(walk, page);
    },
    "tell-it-about-them": async (walk) => {
      const card = await proposeFromChat(
        page,
        "Remember that Dana has just moved to Lisbon and that Priya is training for a half marathon.",
      );
      await card.getByRole("button", { name: /^Keep: / }).waitFor();
      await walk.shot(card);
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      expect(keptWith(walk, "Lisbon"), "what you said is kept").toBeDefined();
    },
    "see-it-repeat": async (walk) => {
      const reminder = reminders(walk)[0];
      const shown = await walk.open(`/center/schedule/reminders/${reminder?.reminderId}`);
      await shown.getByRole("button", { name: "Pause", exact: true }).waitFor();
      await walk.shot();
    },
  },
});
