import { expect } from "vitest";

import { keptWith, memoryPane, newChat, proposeFromChat, turnCards, waiting } from "../support/memory.js";
import { walkGuide } from "../support/walk.js";

const THREE =
  "Remember these three facts about me, one memory each: I prefer metric units. I work from home on Fridays. My cat is called Miso.";
const TWO = "Also remember, one memory each: I'm learning Portuguese, and I run on Sunday mornings.";
const EDITED = "Works from home every Friday";

walkGuide("memory-and-skills/review-memories", {
  configured: true,
  model: true,
  steps: {
    "tell-tavi-a-few-things-at-once": async (walk) => {
      const page = await walk.open("/");
      // A card of three, open for editing, is taller than the space an 800-pixel window leaves the transcript.
      await page.setViewportSize({ width: 1280, height: 1200 });
      await newChat(page);
      const card = await proposeFromChat(page, THREE);
      await expect.poll(() => card.locator("li.memory-card-item").count(), { timeout: 30_000 }).toBe(3);
      expect(waiting(walk).length).toBe(3);
      await walk.shot(card);
    },
    "edit-one-before-you-keep-it": async (walk) => {
      const page = await walk.page();
      const card = turnCards(page).last();
      const fridays = card.locator("li.memory-card-item").filter({ hasText: /Friday/i });
      await fridays.getByRole("button", { name: /^Edit: / }).click();
      const box = fridays.locator("textarea");
      await box.fill(EDITED);
      await walk.shot(card);
      await fridays.getByRole("button", { name: "Save and keep" }).click();
      await expect.poll(() => keptWith(walk, EDITED)?.status, { timeout: 15_000 }).toBe("approved");
    },
    "keep-or-discard-the-rest": async (walk) => {
      const page = await walk.page();
      const card = turnCards(page).last();
      await card
        .locator("li.memory-card-item")
        .filter({ hasText: /metric/i })
        .getByRole("button", { name: /^Keep: / })
        .click();
      await card.locator('li.memory-card-item[data-state="saved"]').nth(1).waitFor();
      await card
        .locator("li.memory-card-item")
        .filter({ hasText: /Miso/i })
        .getByRole("button", { name: /^Discard: / })
        .click();
      await card.locator('li.memory-card-item[data-state="discarded"]').waitFor();
      expect(waiting(walk)).toEqual([]);
      expect(keptWith(walk, "metric")).toBeDefined();
      expect(keptWith(walk, "Miso"), "a discarded suggestion is not kept").toBeUndefined();
      await walk.shot(card);
    },
    "leave-some-for-later": async (walk) => {
      const page = await walk.page();
      const card = await proposeFromChat(page, TWO);
      await expect.poll(() => card.locator("li.memory-card-item").count(), { timeout: 30_000 }).toBe(2);
      expect(waiting(walk).length).toBe(2);
      await walk.shot(card);
    },
    "review-them-in-the-command-center": async (walk) => {
      const page = await walk.open("/center/identity");
      const proposals = memoryPane(page).locator("section.memory-proposals");
      await proposals.locator("li.memory-proposal").nth(1).waitFor();
      await proposals.scrollIntoViewIfNeeded();
      await walk.shot(proposals);
      await proposals
        .locator("li.memory-proposal")
        .filter({ hasText: /Portuguese/i })
        .getByRole("button", { name: "Keep", exact: true })
        .click();
      await expect.poll(() => keptWith(walk, "Portuguese")?.status, { timeout: 15_000 }).toBe("approved");
    },
    "review-the-rest-in-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi memory review",
        args: ["memory", "review"],
        tty: true,
        input: [
          { until: "q quit", wait: 30 },
          { text: "k\r", wait: 1 },
          { until: "kept 1", wait: 30 },
        ],
      });
      expect(screen.join("\n")).toMatch(/Sunday/i);
      expect(waiting(walk)).toEqual([]);
      expect(keptWith(walk, "Sunday")?.status).toBe("approved");
    },
  },
});
