import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { restartOwner } from "../support/steps.js";
import { type TestSite, testSite } from "../support/test-site.js";
import { clickPage, newChat, tab, takeover, typeSignIn, untilHandoff } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

/** A made-up tea shop on this computer, with a sign-in the walk makes up for each run. */
const SHOP = {
  name: "Northwind Tea",
  colour: "#7a3e1d",
  nav: '<a href="/account">Your account</a><a href="/basket">Basket</a>',
  signIn: { landing: "/account" },
  pages: {
    "/": { title: "Northwind Tea", html: "<p>Fine teas, delivered.</p>" },
    "/account": {
      title: "Your account — Northwind Tea",
      html: '<h2>Your account</h2><p>Last order: <strong>NW-20417</strong>, 2 × Assam breakfast tea, delivered 24 October.</p><p>Your basket has 1 item: <a href="/basket">check out</a>.</p>',
    },
    "/basket": {
      title: "Basket — Northwind Tea",
      html:
        "<h2>Basket</h2><table><tr><td>Darjeeling first flush, 250 g</td><td>£14.50</td></tr><tr><td>Delivery</td><td>£3.95</td></tr>" +
        '<tr><td><strong>Total</strong></td><td><strong>£18.45</strong></td></tr></table><form method="post" action="/order"><button type="submit">Place order</button></form>',
    },
    "/order": { title: "Order placed — Northwind Tea", html: "<h2>Thank you</h2><p>Order <strong>NW-20533</strong> is placed.</p>" },
  },
};

let site: TestSite;

/** Sends a message from the chat's composer. */
async function ask(page: Page, text: string): Promise<void> {
  const composer = page.locator(".composer-box textarea");
  await composer.fill(text);
  await composer.press("Enter");
}

walkGuide("web-and-browser/take-over-the-browser", {
  configured: true,
  model: true,
  steps: {
    "ask-for-something-behind-a-sign-in": async (walk) => {
      site = await testSite(SHOP);
      // The site is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      const page = await walk.open("/");
      await newChat(page);
      await ask(
        page,
        `Use the browser to open ${site.origin}/account and tell me my last order. The site needs a sign-in: hand the browser to me and I'll sign in myself.`,
      );
      await untilHandoff(page, 1);
      const card = page.locator(".handoff-card").last();
      await expect(card.getByRole("heading").textContent()).resolves.toBe("Tavi needs you in the browser");
      await walk.shot(card);
    },
    "take-control": async (walk) => {
      const page = await walk.page();
      await page.locator(".handoff-card").last().getByRole("button", { name: "Take control" }).click();
      await takeover(page);
      await walk.shot();
    },
    "sign-in-yourself": async (walk) => {
      const page = await walk.page();
      // The site is the walk's own, and so are its made-up test username and password. Past the two links in the
      // shop's header, Tab reaches the username.
      await clickPage(page);
      await tab(page, 3);
      await typeSignIn(page, site.user, site.password, () => walk.shot());
      // Signed in: the sign-in was posted, and the shop sent the browser on to the account page.
      await expect
        .poll(() => site.requests.slice(Math.max(0, site.requests.indexOf("POST /login"))).join("\n"), { timeout: 20_000 })
        .toMatch(/^POST \/login\n[\s\S]*GET \/account/);
    },
    "hand-the-browser-back": async (walk) => {
      const page = await walk.page();
      await page.waitForTimeout(1_500);
      await page.getByRole("button", { name: "Done — hand back" }).click();
      const note = page.getByLabel("Anything Tavi should know?");
      await note.fill("Signed in.");
      await walk.shot();
      await page.getByRole("button", { name: "Hand back", exact: true }).click();
      await page.getByText("You're in control — Tavi is paused").waitFor({ state: "hidden" });
    },
    "see-what-tavi-found": async (walk) => {
      const page = await walk.page();
      const transcript = page.locator("main");
      await transcript
        .getByText(/You controlled the browser for/)
        .first()
        .waitFor({ timeout: 30_000 });
      await transcript
        .locator(".task-header")
        .getByText(/^(ready|completed)$/)
        .first()
        .waitFor({ timeout: 240_000 });
      await expect(transcript.locator(".markdown").last().textContent()).resolves.toContain("NW-20417");
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "place-the-order-yourself": async (walk) => {
      const page = await walk.page();
      const answers = page.getByRole("button", { name: "Copy response" });
      const before = await answers.count();
      // A handed-back card keeps no Take control button: the new card is one more than are there now.
      const offered = await page.locator(".handoff-card").getByRole("button", { name: "Take control" }).count();
      await ask(page, "Open my basket and get it ready, but don't place the order: hand me the browser and I'll place it myself.");
      await untilHandoff(page, offered + 1);
      await page.locator(".handoff-card").last().getByRole("button", { name: "Take control" }).click();
      await takeover(page);
      expect(site.requests).toContain("GET /basket");
      expect(site.requests).not.toContain("POST /order");
      await walk.shot();
      // Placing the order is the reader's: the walk does it in the page, past the two links in the shop's header.
      await clickPage(page);
      await tab(page, 3);
      await page.keyboard.press("Enter");
      await expect.poll(() => site.requests.includes("POST /order"), { timeout: 20_000 }).toBe(true);
      await page.getByRole("button", { name: "Done — hand back" }).click();
      await page.getByRole("button", { name: "Hand back", exact: true }).click();
      await expect.poll(() => answers.count(), { timeout: 240_000, interval: 1_000 }).toBeGreaterThan(before);
    },
  },
});
