import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { browserUntilEnded, signInYourself, untilHandoff } from "../../support/browser-site.js";
import { promptInTheBox, readFromTheTop, recipePrompt, shotCard } from "../../support/recipes.js";
import { restartOwner } from "../../support/steps.js";
import { type TestSite, testSite } from "../../support/test-site.js";
import { walkGuide } from "../../support/walk.js";

/** A made-up streaming service on this computer: a sign-in, the account page, and a cancellation in three pages. */
const STREAMBOX = {
  name: "StreamBox",
  colour: "#8a2be2",
  nav: '<a href="/account">Account</a><a href="/help">Help</a>',
  signIn: { landing: "/account" },
  pages: {
    "/account": {
      title: "Your account — StreamBox",
      html: '<h2>Your account</h2><p>Plan: <strong>StreamBox Standard</strong>, £9.99 a month, renews 1 December.</p><p><a href="/cancel">Cancel membership</a></p>',
    },
    "/help": { title: "Help — StreamBox", html: "<h2>Help</h2><p>Questions about your plan? Write to us.</p>" },
    "/cancel": {
      title: "Before you go — StreamBox",
      html: '<h2>Before you go</h2><p>Tell us why you are leaving, if you like.</p><form method="post" action="/cancel/why"><label><input type="radio" name="why" value="use" style="width:auto"> I don\'t watch enough</label><label><input type="radio" name="why" value="price" style="width:auto"> It costs too much</label><button type="submit">Continue</button></form>',
    },
    "/cancel/why": {
      title: "Confirm cancellation — StreamBox",
      html: '<h2>Confirm cancellation</h2><p>Your membership will end on 1 December. You can watch until then.</p><form method="post" action="/cancel/done"><button type="submit">Confirm cancellation</button></form>',
    },
    "/cancel/done": { title: "Cancelled — StreamBox", html: "<h2>Cancelled</h2><p>Your membership ends on 1 December.</p>" },
  },
};

/** What the reader says when Tavi stops at the account page, as the page gives it. */
const GO_ON = "Go on and stage the StreamBox cancellation, stopping before the final step.";

let site: TestSite;
let page: Page;

walkGuide("everyday/life-admin/subscriptions", {
  configured: true,
  model: true,
  timeoutMs: 1_200_000,
  steps: {
    "ask-for-it": async (walk) => {
      site = await testSite(STREAMBOX);
      // The site is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      const list =
        `StreamBox, £9.99 a month, watched twice this year, account at ${site.origin}/account; a gym, £35 a month, I go every week; ` +
        "cloud photo storage, £2.49 a month, holds all my photos. StreamBox needs a sign-in: hand me the browser and I'll sign in myself";
      page = await promptInTheBox(walk, recipePrompt("productivity.subscriptions", { list }));
      await page.locator(".composer-box textarea").press("Enter");
    },
    "allow-the-browser": async (walk) => {
      // The browser's card, pictured; untilHandoff allows it and those after for this chat, until Tavi asks for you.
      const card = page
        .locator("section.round")
        .filter({ has: page.getByRole("button", { name: "Allow for this chat" }) })
        .last();
      await card.waitFor({ timeout: 240_000 });
      await shotCard(walk, card);
      await untilHandoff(page, 1);
    },
    "sign-in-yourself": async (walk) => {
      await signInYourself(page, site, () => walk.shot());
    },
    "make-the-last-click-yourself": async (walk) => {
      // Every page's button asks; the final one is refused, should it ever be asked for.
      await browserUntilEnded(page, { refuse: /Confirm cancellation/ });
      // Stopped at the account page, it is told to go on, as the page says a reader may.
      if (!site.requests.includes("GET /cancel")) {
        await page.locator(".composer-box textarea").fill(GO_ON);
        await page.locator(".composer-box textarea").press("Enter");
        await page.waitForTimeout(3_000);
        await browserUntilEnded(page, { refuse: /Confirm cancellation/ });
      }
      // It went as far as the last page, and never made the final click.
      expect(site.requests, site.requests.join(", ")).toContain("POST /cancel/why");
      expect(site.requests).not.toContain("POST /cancel/done");
      await readFromTheTop(walk, page);
    },
  },
});
