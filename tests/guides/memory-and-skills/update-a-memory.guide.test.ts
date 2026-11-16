import { expect } from "vitest";

import { kept, keptWith, memoryPane, newChat, proposeFromChat, rememberFact, turnCards, waiting } from "../support/memory.js";
import { askForApproval, turnEnded } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const CORRECTED = "Lives in Porto since November 2026";

walkGuide("memory-and-skills/update-a-memory", {
  configured: true,
  model: true,
  seed: [rememberFact("Home city", "Lives in Lisbon", "me.home_city"), rememberFact("Work", "Works at Acme as a designer", "me.employer")],
  steps: {
    "tell-tavi-what-changed": async (walk) => {
      const page = await walk.open("/");
      await page.setViewportSize({ width: 1280, height: 1000 });
      await newChat(page);
      const card = await proposeFromChat(page, "Remember that I've moved to Porto; I no longer live in Lisbon.");
      await card.getByRole("button", { name: /^Replace: / }).waitFor();
      await expect(card.textContent()).resolves.toMatch(/updates: Home city/);
      await walk.shot(card);
    },
    "replace-the-old-fact": async (walk) => {
      const page = await walk.page();
      const card = turnCards(page).last();
      const home = keptWith(walk, "Lisbon");
      await card.getByRole("button", { name: /^Replace: / }).click();
      await card.locator('li.memory-card-item[data-state="proposed"]').waitFor({ state: "detached" });
      // The kept record itself now says Porto: the same id, a new revision.
      await expect.poll(() => kept(walk).find((row) => row.recordId === home?.recordId)?.body, { timeout: 15_000 }).toMatch(/Porto/);
      expect(kept(walk).filter((row) => row.title === "Home city").length, "one Home city, not two").toBe(1);
      expect(waiting(walk)).toEqual([]);
      const center = await walk.open("/center/identity");
      const facts = memoryPane(center).locator("section.memory-group").filter({ hasText: /Porto/ });
      await facts.scrollIntoViewIfNeeded();
      await walk.shot(facts);
    },
    "keep-both-when-both-are-true": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      const card = await proposeFromChat(page, "Remember that I've also started working part-time at Globex as a designer.");
      const both = card.getByRole("button", { name: /^Keep both: / });
      await both.waitFor().catch(async (error: unknown) => {
        throw new Error(`no Keep both on the card: ${(await card.textContent()) ?? ""}`, { cause: error });
      });
      await walk.shot(card);
      await both.click();
      await expect.poll(() => keptWith(walk, "Globex")?.status, { timeout: 15_000 }).toBe("approved");
      expect(
        kept(walk).some((row) => row.body === "Works at Acme as a designer"),
        "the earlier fact stays as it was",
      ).toBe(true);
    },
    "correct-one-in-your-own-words": async (walk) => {
      const page = await walk.open("/center/identity");
      const row = memoryPane(page).locator("li.memory-row").filter({ hasText: /Porto/ });
      await row.getByRole("button", { name: "Correct" }).click();
      await row.getByLabel("Text").fill(CORRECTED);
      await row.scrollIntoViewIfNeeded();
      await walk.shot(row);
      await row.getByRole("button", { name: "Save correction" }).click();
      await expect.poll(() => keptWith(walk, CORRECTED)?.status, { timeout: 15_000 }).toBe("approved");
    },
    "ask-tavi-to-forget-one": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      await askForApproval(page, "Please forget that I work at Globex.");
      const card = page.locator("section.round").filter({ hasText: "memory.forget" }).last();
      await expect(card.textContent()).resolves.toMatch(/Globex/);
      await walk.shot(card);
      await card.getByRole("button", { name: "Allow once" }).click();
      await turnEnded(page);
      expect(keptWith(walk, "Globex"), "the memory is erased").toBeUndefined();
      expect(keptWith(walk, "Acme"), "only that one").toBeDefined();
    },
  },
});
