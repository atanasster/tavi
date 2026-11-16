import { expect } from "vitest";

import { keptWith, memoryCard, memoryPane, newChat, proposeFromChat, slash, waiting } from "../support/memory.js";
import { walkGuide } from "../support/walk.js";

walkGuide("memory-and-skills/remember-and-forget", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-remember-something": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      const card = await proposeFromChat(page, "Remember that I'm vegetarian.");
      await card.getByRole("button", { name: /^Keep: / }).waitFor();
      expect(waiting(walk).length, "one proposal waits").toBe(1);
      await walk.shot(card);
    },
    "keep-it": async (walk) => {
      const page = await walk.page();
      const card = await memoryCard(page);
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      expect(keptWith(walk, "vegetarian"), "the fact is kept").toBeDefined();
      expect(waiting(walk)).toEqual([]);
      await walk.shot(card);
    },
    "save-one-in-your-own-words": async (walk) => {
      const page = await walk.page();
      await slash(page, "/remember I cycle to work every day");
      const card = await memoryCard(page, 30_000);
      await card.getByRole("button", { name: /^Undo: I cycle to work every day/ }).waitFor();
      expect(keptWith(walk, "cycle to work")?.status).toBe("approved");
      // The transcript stays where it was when the card is posted below (observation): scroll down to it, as a reader does.
      await page.locator(".runs").hover();
      await page.mouse.wheel(0, 600);
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "find-a-memory-to-forget": async (walk) => {
      const page = await walk.page();
      const answer = await slash(page, "/forget cycle");
      await expect(answer.textContent()).resolves.toMatch(/1\. .*cycle to work/);
      expect(keptWith(walk, "cycle to work"), "a listing forgets nothing").toBeDefined();
      await walk.shot(answer);
    },
    "forget-it": async (walk) => {
      const page = await walk.page();
      const answer = await slash(page, "/forget 1");
      await expect(answer.textContent()).resolves.toMatch(/Forgotten/);
      expect(keptWith(walk, "cycle to work"), "the memory is erased").toBeUndefined();
      await walk.shot(answer);
    },
    "forget-from-the-command-center": async (walk) => {
      const page = await walk.open("/center/identity");
      const pane = memoryPane(page);
      const row = pane
        .locator("li")
        .filter({ hasText: /vegetarian/i })
        .last();
      await row.getByRole("button", { name: "Forget" }).click();
      const confirm = pane.getByRole("button", { name: "Forget it" });
      await confirm.waitFor();
      await walk.shot(pane.locator("section.memory-group").filter({ hasText: /vegetarian/i }));
      await confirm.click();
      await expect.poll(() => keptWith(walk, "vegetarian"), { timeout: 15_000 }).toBeUndefined();
    },
  },
});
