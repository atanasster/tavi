import { expect } from "vitest";

import { completedCalls, firstAccount, googleAccountSignedIn } from "../../support/apps.js";
import { allowCard, answered, promptInTheBox, readFromTheTop, recipePrompt, shotCard } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { account } from "../../support/user.js";
import { walkGuide } from "../../support/walk.js";

import type { Page } from "../../../../scripts/docs/browser.mjs";

const GUIDE = "everyday/life-admin/inbox-triage";

let page: Page;

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "ask-for-it": async (walk) => {
      // Before you start: the Google account connected, its mailbox set to read and draft, in one sign-in.
      walk.needsUser("google");
      await googleAccountSignedIn(walk, GUIDE, `${account("googleEmail")}, ticking every box, Gmail's included`, { mailbox: true });
      await expect.poll(() => firstAccount(walk, "gmail").health, { timeout: 60_000 }).toBe("ready");
      // Read and draft only: the account offers no send at all.
      expect(firstAccount(walk, "gmail").mailbox).toBe("read");
      const prompt = recipePrompt("productivity.inbox-triage", {});
      page = await promptInTheBox(walk, prompt);
    },
    "approve-each-draft": async (walk) => {
      let pictured = false;
      await answered(page, {
        timeoutMs: 600_000,
        quotesTheChat: true,
        onCard: async (card) => {
          const text = (await card.textContent()) ?? "";
          // Nothing is ever sent from a walk: a send's card ends it.
          if (/send_draft/.test(text)) throw new Error("a send was asked for: the walk never allows one");
          if (!pictured && /\.draft\b/.test(text)) {
            await shotCard(walk, card);
            pictured = true;
          }
          // Allow once, or Allow selected; deny unchecked when several drafts share the card (all are checked).
          await allowCard(card);
        },
      });
      expect(pictured, "a draft's card was pictured").toBe(true);
      expect(completedCalls(walk, /^gmail\..+\.draft$/), "a reply was drafted").toBeGreaterThanOrEqual(1);
    },
    "read-the-triage": async (walk) => {
      expect(completedCalls(walk, /^gmail\..+\.(search|read|thread)$/), "the mailbox was read").toBeGreaterThanOrEqual(1);
      // The picture ends where "can wait" starts: what waits is the account's other mail, a test account's or not,
      // and stays out of the picture; what needs you is the test mail the walks sent.
      const answer = await lastAnswer(page);
      const waits = await answer.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const heading = [...element.querySelectorAll(".markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown p")].find((block) =>
          /can wait/i.test(block.textContent ?? ""),
        );
        return heading === undefined ? undefined : heading.getBoundingClientRect().top - top;
      });
      expect(waits, "the triage parts what can wait from what needs you").toBeDefined();
      await readFromTheTop(walk, page, Math.floor((waits as number) - 8));
    },
  },
});
