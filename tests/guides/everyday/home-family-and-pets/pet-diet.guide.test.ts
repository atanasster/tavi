import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE, inDays, spanning } from "../../support/automation.js";
import { promptInTheBox, recipePrompt, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

interface Reminder {
  readonly text: string;
  readonly nextFireAt: string | null;
  readonly when: { readonly kind: string; readonly at?: string; readonly times?: readonly string[] };
}

/** Made-up brands: nobody's dog, nobody's food. */
const PROMPT = recipePrompt("health-home.pet-diet", {
  pet: "dog",
  "old food": "Hillside Puppy Kibble",
  "new food": "Meadow Adult Kibble",
});

let page: Page;

/** What the chat's own folder holds of a symptom log: its first file with the word in its name, or nothing. */
function symptomLog(walk: { readonly dataDir: string; tavi(...args: string[]): string }): string {
  const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
  const folder = join(walk.dataDir, "chats/default", chat?.taskId ?? "");
  const file = readdirSync(folder, { recursive: true, encoding: "utf8" }).find((name) => /symptom/i.test(name));
  return file === undefined ? "" : readFileSync(join(folder, file), "utf8");
}

walkGuide("everyday/home-family-and-pets/pet-diet", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptInTheBox(walk, PROMPT);
      await sendThroughCards(page, PROMPT);
    },
    "read-the-plan": async (walk) => {
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/Meadow/i);
      expect(text).toMatch(/symptom/i);
      expect(symptomLog(walk), "the log is a file in the chat's folder").toMatch(/\S/);
      await wholeAnswer(walk, page);
    },
    "log-a-symptom": async (walk) => {
      await sendThroughCards(page, "Add to my symptom log: day 3, slightly loose stool, otherwise bright and eating well.");
      expect(symptomLog(walk)).toMatch(/loose/i);
      await wholeAnswer(walk, page);
    },
    "check-your-reminders": async (walk) => {
      const { reminders } = walk.taviJson<{ reminders: Reminder[] }>("reminders", "list");
      expect(reminders.length).toBeGreaterThanOrEqual(1);
      // The first one is ahead of today, not in a year the model guessed.
      const next = reminders
        .flatMap((reminder) => (reminder.nextFireAt ? [new Date(reminder.nextFireAt).toISOString().slice(0, 10)] : []))
        .sort()[0];
      expect(next !== undefined && next >= inDays(0) && next <= inDays(2), `the first reminder is on ${next}`).toBe(true);
      const schedule = await walk.open("/center/schedule");
      await schedule
        .getByText(/kibble|food/i)
        .first()
        .waitFor();
      const span = await spanning(
        schedule,
        schedule.getByRole("heading", { name: /^Coming up/ }),
        schedule.locator(".reminder-origin").first(),
      );
      await walk.shot(span.box);
      await span.remove();
    },
  },
});
