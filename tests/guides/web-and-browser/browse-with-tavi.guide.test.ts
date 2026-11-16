import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { chats, restartOwner } from "../support/steps.js";
import { type TestSite, testSite } from "../support/test-site.js";
import { newChat } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

/** A made-up public library's site, served by the walk on this computer. */
const LIBRARY = {
  name: "Greenfield Library",
  colour: "#2f5d50",
  nav: '<a href="/">Home</a><a href="/events">Events</a><a href="/hours">Opening hours</a>',
  pages: {
    "/": {
      title: "Greenfield Library",
      html: "<h2>Welcome</h2><p>Greenfield Library is the town's public library on Mill Lane.</p><p>See what's on this week under <a href=\"/events\">Events</a>.</p>",
    },
    "/hours": {
      title: "Opening hours — Greenfield Library",
      html: "<h2>Opening hours</h2><table><tr><td>Monday to Friday</td><td>9:00–18:00</td></tr><tr><td>Saturday</td><td>10:00–14:00</td></tr><tr><td>Sunday</td><td>Closed</td></tr></table>",
    },
    "/events": {
      title: "Events — Greenfield Library",
      html: "<h2>Events this week</h2><ul><li><strong>Book club</strong>, Thursday 18:30: this month, <em>The Remains of the Day</em></li><li><strong>Story time for under-fives</strong>, Saturday 10:30</li><li><strong>Repair café</strong>, Saturday 11:00–13:00</li></ul>",
    },
  },
};

let site: TestSite;

/** The newest decision card in the transcript, once its buttons are there. */
async function card(page: Page): Promise<ReturnType<Page["locator"]>> {
  const round = page.locator("section.round").last();
  await round.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 180_000 });
  return round;
}

walkGuide("web-and-browser/browse-with-tavi", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-look-something-up-on-a-site": async (walk) => {
      site = await testSite(LIBRARY);
      // The site is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      const page = await walk.open("/");
      await newChat(page);
      const composer = page.locator(".composer-box textarea");
      await composer.fill(`Use the browser to open ${site.origin}/ and tell me what's on at the library this week.`);
      await composer.press("Enter");
      const round = await card(page);
      await expect(round.textContent()).resolves.toContain(`This chat wants to use the browser on ${site.host}`);
      await walk.shot(round);
    },
    "watch-it-in-the-chat-panel": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Show this chat's panel" }).click();
      const first = page.locator("section.round", { hasText: "Use the browser to open" }).last();
      await first.getByRole("button", { name: "Allow once" }).click();
      const panel = page.locator('aside[aria-label="this chat"]');
      const view = panel.frameLocator("iframe").first();
      await view.getByText("Live", { exact: true }).waitFor({ timeout: 90_000 });
      // The next step asks again: the strip shows the page while that card waits.
      const next = page.locator("section.round", { hasNotText: "Use the browser to open" }).last();
      await next.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 180_000 });
      await view.getByText("Greenfield Library").first().waitFor();
      // Frames arrive a few a second: let the page draw.
      await page.waitForTimeout(3_000);
      await walk.shot();
    },
    "let-it-carry-on": async (walk) => {
      const page = await walk.page();
      await (await card(page)).getByRole("button", { name: "Allow for this chat" }).click();
      // Any later step on the same site goes ahead without a card.
      await page
        .locator("main .task-header")
        .getByText(/^(ready|completed)$/)
        .first()
        .waitFor({ timeout: 240_000 });
      const panel = page.locator('aside[aria-label="this chat"]');
      await panel.frameLocator("iframe").first().getByText("Ended", { exact: true }).waitFor({ timeout: 30_000 });
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(chat?.status).toBe("completed");
      await page.waitForTimeout(1_500);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "check-whether-it-was-signed-in": async (walk) => {
      const page = await walk.page();
      const transcript = page.locator("main");
      await transcript
        .locator("summary", { hasText: /Worked/ })
        .first()
        .click();
      const call = transcript.locator("details", { has: page.locator("summary", { hasText: "browser.create_session" }) }).last();
      await call.locator("summary").first().click();
      await expect.poll(async () => (await call.textContent()) ?? "", { timeout: 10_000 }).toContain("ephemeral");
      // The call's output is long: the picture is the transcript with the call at its top.
      await call
        .locator("summary")
        .first()
        .evaluate((summary) => summary.scrollIntoView({ block: "start" }));
      await walk.shot(page.locator("main"));
    },
    "forget-what-the-browser-kept": async (walk) => {
      const page = await walk.open("/settings/general");
      const clear = page.getByRole("button", { name: /^Clear browser profile/ });
      await clear.scrollIntoViewIfNeeded();
      await clear.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Clear profile" }).waitFor();
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "Clear profile" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(walk.tavi("browser", "history", "--live")).not.toContain(site.host);
    },
  },
});
