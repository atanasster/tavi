import { expect } from "vitest";

import { completedCalls, googleAccountSignedIn } from "../../support/apps.js";
import { promptAnswered, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { account } from "../../support/user.js";
import { walkGuide } from "../../support/walk.js";

import type { Page } from "../../../../scripts/docs/browser.mjs";

const GUIDE = "everyday/life-admin/meeting-slots";

let page: Page;

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "ask-for-it": async (walk) => {
      // Before you start: the Google account connected with its calendar on.
      walk.needsUser("google");
      await googleAccountSignedIn(walk, GUIDE, account("googleEmail"));
      page = await promptAnswered(
        walk,
        recipePrompt("productivity.meeting-slots", { length: "30-minute", "time zones": "London and New York" }),
      );
    },
    "pick-a-slot": async (walk) => {
      // The slots come from the calendar: its events or its busy times were read.
      expect(completedCalls(walk, /^gmail\..+\.(list_events|free_busy|search_events)$/), "the calendar was read").toBeGreaterThanOrEqual(1);
      // It only suggests: nothing was booked.
      expect(completedCalls(walk, /^gmail\..+\.(create_event|update_event)$/)).toBe(0);
      await wholeAnswer(walk, page);
    },
  },
});
