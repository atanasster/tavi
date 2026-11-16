import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { keptWith, proposeFromChat } from "../../support/memory.js";
import { askForIt, readFromTheTop, recipePrompt } from "../../support/recipes.js";
import { askInChat, homeId } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/friends-and-culture/recommendations", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await askForIt(
        walk,
        recipePrompt("people.recommendations", { "books, films or shows I loved": "The Martian, Arrival and Station Eleven" }),
      );
    },
    "read-the-result": async (walk) => {
      await readFromTheTop(walk, page);
    },
    "have-it-remember-your-taste": async (walk) => {
      const card = await proposeFromChat(page, "Remember that I love thoughtful science fiction about people solving problems.");
      await card.getByRole("button", { name: /^Keep: / }).waitFor();
      await walk.shot(card);
      await card.getByRole("button", { name: /^Keep: / }).click();
      await card.getByRole("button", { name: /^Undo: / }).waitFor();
      expect(keptWith(walk, "science fiction"), "the taste is kept").toBeDefined();
    },
    "ask-again-another-day": async (walk) => {
      // `tavi chat` is Home: it has a short recap of earlier chats, and what it keeps.
      const text = (await askInChat(walk, "Recommend one film for tonight that I haven't mentioned, from what you know I like.")).join(
        "\n",
      );
      expect(text).toMatch(/sci-?fi|science fiction|problem/i);
      const history = walk.tavi("tasks", "history", homeId(walk.tavi));
      expect(history).toMatch(/memory\.(search|list)/);
      // One thing kept, found by a search or by looking through what is kept: the line says which.
      expect(text).toMatch(/memory: 1 (used|looked through) · \/why/);
      // It may compare with a favourite; what it recommends is another film.
      expect(text).not.toMatch(/recommendation:?\W*(arrival|the martian)/i);
    },
  },
});
