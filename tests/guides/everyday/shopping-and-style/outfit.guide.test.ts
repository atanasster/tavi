import { expect } from "vitest";

import { completedCalls, googleAccountSignedIn } from "../../support/apps.js";
import { keptWith, newChat, slash } from "../../support/memory.js";
import { allowCard, promptAnswered, readFromTheTop, recipePrompt, refuseTheBrowser, searchedTheWeb } from "../../support/recipes.js";
import { account } from "../../support/user.js";
import { walkGuide } from "../../support/walk.js";

import type { Page } from "../../../../scripts/docs/browser.mjs";

const GUIDE = "everyday/shopping-and-style/outfit";
/** Made up and ordinary: a town and a wardrobe, as the page gives them. */
const WARDROBE =
  "I live in Edinburgh. My wardrobe: navy blazer, white shirt, grey merino jumper, dark jeans, black trousers, waterproof jacket, white trainers, brown boots.";

let page: Page;

walkGuide(GUIDE, {
  configured: true,
  model: true,
  search: true,
  timeoutMs: 1_800_000,
  steps: {
    "tell-tavi-your-wardrobe-and-town": async (walk) => {
      // Before you start: the Google account connected with its calendar on.
      walk.needsUser("google");
      await googleAccountSignedIn(walk, GUIDE, account("googleEmail"));
      const chat = await walk.open("/");
      await newChat(chat);
      // In a chat with nothing in it yet, /remember answers on a line of its own: it is kept all the same.
      const answer = await slash(chat, `/remember ${WARDROBE}`);
      await expect.poll(() => keptWith(walk, "merino jumper")?.status, { timeout: 30_000 }).toBe("approved");
      await walk.shot(answer);
    },
    "ask-for-it": async (walk) => {
      // Searching asks no one, but a card may come up: the browser is refused, as the recipe does without it.
      page = await promptAnswered(walk, recipePrompt("shopping.outfit", {}), {
        timeoutMs: 360_000,
        onCard: (round) => refuseTheBrowser(round, allowCard),
      });
    },
    "read-the-suggestion": async (walk) => {
      await searchedTheWeb(page);
      expect(completedCalls(walk, /^gmail\..+\.(list_events|search_events)$/), "the calendar was read").toBeGreaterThanOrEqual(1);
      await readFromTheTop(walk, page);
    },
  },
});
