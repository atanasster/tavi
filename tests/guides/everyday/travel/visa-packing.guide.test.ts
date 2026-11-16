import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE, spanning } from "../../support/automation.js";
import { promptAnswered, readFromTheTop, recipePrompt, refuseTheBrowser } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("travel.visa-packing", {
  country: "Japan",
  dates: "10 to 24 April 2027",
  nationality: "British",
});

let page: Page;

interface Reminder {
  readonly text: string;
  readonly status: string;
  readonly when: Readonly<Record<string, unknown>>;
}

walkGuide("everyday/travel/visa-packing", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT, { onCard: refuseTheBrowser, timeoutMs: 300_000 });
    },
    "read-the-rules": async (walk) => {
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      await expect(page.locator("main .markdown").last().textContent()).resolves.toMatch(/visa/i);
      // A fee the model read can be an old one, and a page keeps it for good. What it says of medicines can read as
      // always allowed with permission, and some can't come in at all: the picture stops before either, and the page
      // sends the reader to the embassy.
      const answer = await lastAnswer(page);
      const start = await answer.boundingBox();
      const before = async (words: RegExp): Promise<number | undefined> => {
        const at = await answer
          .locator(".markdown li, .markdown p")
          .filter({ hasText: words })
          .first()
          .boundingBox({ timeout: 2_000 })
          .catch(() => null);
        return at === null ? undefined : Math.ceil(at.y - (start?.y ?? 0)) - 2;
      };
      const medicines = await before(/medic/i);
      expect(medicines === undefined || medicines > 400, "the entry rules come before the medicines").toBe(true);
      const stops = [await before(/[$£€¥]\s?\d/), medicines].filter((stop) => stop !== undefined && stop > 400);
      await readFromTheTop(walk, page, stops.length === 0 ? undefined : Math.min(...(stops as number[])));
    },
    "check-your-reminders": async (walk) => {
      const { reminders } = walk.taviJson<{ reminders: Reminder[] }>("reminders", "list");
      expect(reminders.length, "a reminder exists").toBeGreaterThan(0);
      for (const reminder of reminders) {
        expect(reminder.status).toBe("active");
        // Each deadline falls before the trip ends and is still to come.
        for (const [date] of JSON.stringify(reminder.when).matchAll(/\d{4}-\d{2}-\d{2}/g)) {
          expect(date > "2026-11-05" && date <= "2027-04-24", `${reminder.text}: ${date}`).toBe(true);
        }
      }
      const schedule = await walk.open("/center/schedule");
      await schedule
        .getByText(reminders[0]?.text ?? "")
        .first()
        .waitFor();
      // Tall enough for every one-off reminder under **Later**, and that part alone: the window's foot would cut a line.
      await schedule.setViewportSize({ width: 1280, height: 1400 });
      // **Later** and its list: only a reminder the agent made says where it was added from, so that can't end the picture.
      const later = schedule.getByRole("heading", { name: /^Later/ });
      const span = await spanning(schedule, later, later.locator("xpath=following-sibling::*[1]"));
      await walk.shot(span.box);
      await span.remove();
      await schedule.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
