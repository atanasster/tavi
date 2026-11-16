import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { allowUntilEnded, promptSent, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

let page: Page;

walkGuide("everyday/hobbies-and-games/cut-list", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptSent(
        walk,
        recipePrompt("learning.cut-list", {
          list: "2 sides at 900 mm, 4 shelves at 560 mm and 1 top at 600 mm",
          "board sizes": "2400 mm boards of the same width, allowing 3 mm for the saw after every part",
        }),
      );
    },
    "read-the-cut-list": async (walk) => {
      await allowUntilEnded(page, 240_000);
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("sandbox.run");
      const text = (await (await lastAnswer(page)).textContent()) ?? "";
      // Worked by hand. Only one layout fits two boards: 900 + 900 + 560 and 3 cuts is 2369, leaving 31;
      // 600 + 560 + 560 + 560 and 4 cuts is 2292, leaving 108. 900 + 900 + 600 would need 2406.
      expect(text).toMatch(/\b(2|two) boards\b/i);
      expect(text).toMatch(/2,?369/);
      expect(text).toMatch(/\b31\b/);
      expect(text).toMatch(/2,?292/);
      expect(text).toMatch(/\b108\b/);
      await wholeAnswer(walk, page);
    },
  },
});
