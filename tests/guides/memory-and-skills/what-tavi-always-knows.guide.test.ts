import { expect } from "vitest";

import { kept, keptWith, memoryPane, newChat, proposeFromChat, requestsSince } from "../support/memory.js";
import { chats, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const LESSON = "When I ask for a recipe, give quantities in grams.";

interface Why {
  readonly records: readonly unknown[];
}

walkGuide("memory-and-skills/what-tavi-always-knows", {
  configured: true,
  model: true,
  steps: {
    "tell-tavi-where-you-live": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      const card = await proposeFromChat(page, "Remember that I live in Lisbon.");
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      // A core fact about the person: its topic starts `me.`, which is what puts it in the profile.
      expect(keptWith(walk, "Lisbon")?.topicKey).toMatch(/^me\./);
      await walk.shot(card);
    },
    "teach-it-a-lesson": async (walk) => {
      const page = await walk.open("/center/identity");
      await memoryPane(page).getByRole("button", { name: "Remember" }).click();
      const form = page.getByRole("form", { name: "Remember" });
      await form.getByLabel("Kind").click();
      await page.getByRole("option", { name: /^Lesson/ }).click();
      await form.getByLabel("What to remember").fill(LESSON);
      // The form whole, with its Remember button: below the fold of an 800-pixel window.
      await page.setViewportSize({ width: 1280, height: 1100 });
      await form.scrollIntoViewIfNeeded();
      await walk.shot(form);
      await page.setViewportSize({ width: 1280, height: 800 });
      await form.getByRole("button", { name: "Remember", exact: true }).click();
      await expect.poll(() => kept(walk, "--kind", "lesson").map((row) => row.body), { timeout: 15_000 }).toContain(LESSON);
    },
    "ask-something-that-doesn-t-mention-it": async (walk) => {
      const since = new Date().toISOString();
      const page = await walk.open("/");
      await newChat(page);
      await send(page, "Plan a relaxed Saturday morning for me, in two lines.");
      // Every call of the chat was given the profile, though nothing in the question matches it.
      const requests = await requestsSince(walk.dataDir, since);
      expect(requests.length, "the chat's model calls were kept").toBeGreaterThan(0);
      const first = requests[0] ?? "";
      expect(first).toContain("About the person");
      expect(first).toContain("Lisbon");
      expect(first).toContain("quantities in grams");
      // …and it is no search hit: the answer names no memory.
      const why = walk.taviJson<Why>("memory", "why", chats(walk.tavi)[0]?.taskId ?? "");
      expect(why.records).toEqual([]);
      await expect(page.locator(".memory-used-chip").count()).resolves.toBe(0);
      await walk.shot();
    },
    "see-what-s-in-it": async (walk) => {
      const page = await walk.open("/center/identity");
      const pane = memoryPane(page);
      await pane.locator("section.memory-group").filter({ hasText: "grams" }).waitFor();
      await page.setViewportSize({ width: 1280, height: 1500 });
      const records = pane.locator("section.memory-group");
      await records.first().scrollIntoViewIfNeeded();
      await walk.shot(pane);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
