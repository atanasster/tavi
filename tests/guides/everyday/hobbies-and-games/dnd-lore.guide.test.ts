import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { keptWith, proposeFromChat } from "../../support/memory.js";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { askInChat, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** The reader's notes have the messenger arrive, too late: an answer that has her still on the road has it wrong. */
const NOT_ARRIVED =
  /\b(overdue|delayed)\s+(\S+\s+)?messenger|ahead of (\S+\s+){0,3}messenger|before (\S+\s+){0,3}messenger (has|arrives|reaches|gets|comes)|messenger (\S+\s+){0,4}(not yet|yet to|en route|on (her|his|its|the) way|expected|missing|overdue|delayed)/i;

const fitsTheNotes = (text: string): void => expect(text.replace(/\s+/g, " "), "the messenger arrived").not.toMatch(NOT_ARRIVED);

let page: Page;

walkGuide("everyday/hobbies-and-games/dnd-lore", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(
        walk,
        recipePrompt("learning.dnd-lore", {
          campaign: "Ember Vale",
          notes:
            "the party freed the miller Odo Brask from the goblins at Thorn Bridge, Odo gave them a silver key and would not say what it opens, the ranger Pell stayed behind to guard the bridge, and Lady Sefa's messenger reached them after they had crossed into her land, too late to stop them",
        }),
      );
    },
    "read-the-world-state": async (walk) => {
      const text = (await (await lastAnswer(page)).textContent()) ?? "";
      expect(text).toMatch(/Odo/);
      expect(text).toMatch(/Pell/);
      expect(text).toMatch(/Sefa/);
      expect(text).toMatch(/silver key/i);
      expect(text).toMatch(/thread/i);
      expect(text).toMatch(/messenger[^.]*(too late|after)|(too late|after)[^.]*messenger/i);
      fitsTheNotes(text);
      await wholeAnswer(walk, page);
    },
    "keep-it-for-next-time": async (walk) => {
      const card = await proposeFromChat(
        page,
        "Remember the state of our Ember Vale campaign and its open threads, and that her messenger reached them too late, for our next session.",
      );
      await card.getByRole("button", { name: /^Keep: / }).waitFor();
      await walk.shot(card);
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      const kept = keptWith(walk, "Ember Vale");
      expect(kept, "the campaign is kept").toBeDefined();
      expect(`${kept?.title ?? ""} ${kept?.body ?? ""}`).toMatch(/silver key/i);
      fitsTheNotes(`${kept?.title ?? ""} ${kept?.body ?? ""}`);
    },
    "pick-it-up-next-session": async (walk) => {
      const text = (await askInChat(walk, "Where did we leave our Ember Vale campaign, and what threads are open?")).join("\n");
      expect(text).toMatch(/silver\s+key/i);
      expect(text).toMatch(/Pell/);
      fitsTheNotes(text);
      // Home has a recap of earlier chats: the line says this came from what was kept.
      expect(text).toMatch(/memory: 1 (used|looked through) · \/why/);
    },
  },
});
