import { expect } from "vitest";

import { completedCalls, firstAccount, googleAccountSignedIn } from "../../support/apps.js";
import { promptAnswered, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { account } from "../../support/user.js";
import { walkGuide } from "../../support/walk.js";

import type { Page } from "../../../../scripts/docs/browser.mjs";

const GUIDE = "everyday/life-admin/morning-brief";

let page: Page;

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "ask-for-it": async (walk) => {
      // Before you start: the Google account connected, its calendar on and its mailbox readable, in one sign-in.
      walk.needsUser("google");
      await googleAccountSignedIn(walk, GUIDE, `${account("googleEmail")}, ticking every box, Gmail's included`, { mailbox: true });
      await expect.poll(() => firstAccount(walk, "gmail").health, { timeout: 60_000 }).toBe("ready");
      expect(firstAccount(walk, "gmail").mailbox).toBe("read");
      page = await promptAnswered(walk, recipePrompt("productivity.morning-brief", {}));
    },
    "read-your-brief": async (walk) => {
      // The brief read both: the calendar's events and the mailbox.
      expect(completedCalls(walk, /^gmail\..+\.list_events$/), "the calendar was read").toBeGreaterThanOrEqual(1);
      expect(completedCalls(walk, /^gmail\..+\.(search|read|thread)$/), "the mailbox was read").toBeGreaterThanOrEqual(1);
      // It only reads: nothing was drafted or sent.
      expect(completedCalls(walk, /^gmail\..+\.(draft|send_draft)$/)).toBe(0);
      await wholeAnswer(walk, page);
    },
  },
});
