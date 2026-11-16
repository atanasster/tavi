import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { keptWith, newChat, slash } from "../../support/memory.js";
import { allowUntilEnded, promptSent, readFromTheTop, recipePrompt, shotAlone } from "../../support/recipes.js";
import { chats, lastAnswer, restartOwner } from "../../support/steps.js";
import { type TestSite, testSite } from "../../support/test-site.js";
import { walkGuide } from "../../support/walk.js";

/** One store's page for the flask: what it costs, and what it adds on the way to a UK address. */
const flask = (from: string, rows: readonly (readonly [string, string])[]) => ({
  "/": {
    title: "Harlow 1 litre steel flask",
    html:
      `<h2>Harlow 1 litre steel flask</h2><p>Keeps drinks hot for 24 hours. In stock, ships from ${from}.</p>` +
      `<h3>Cost delivered to the UK</h3><table>${rows.map(([what, cost]) => `<tr><td>${what}</td><td>${cost}</td></tr>`).join("")}</table>`,
  },
});

/** Two made-up stores: the one with the lower price is the dearer one delivered, £30.95 against £39.78. */
const STORES = [
  {
    name: "Kestrel Ridge Outfitters",
    colour: "#2f5d50",
    pages: flask("Leeds, UK", [
      ["Price", "£27.00"],
      ["Shipping", "£3.95"],
      ["Duty and import VAT", "None: ships from the UK"],
    ]),
  },
  {
    name: "Bergwald Supply",
    colour: "#7a4b2a",
    pages: flask("Munich, Germany", [
      ["Price", "£19.90"],
      ["Shipping", "£9.50"],
      ["Duty and import VAT", "£5.88, paid to the carrier on delivery"],
      ["Carrier's clearance fee", "£4.50"],
    ]),
  },
];

let page: Page;
let sites: readonly TestSite[];

/** What the walk tells Tavi, as the page says to. */
const stores = ([kestrel, bergwald]: readonly TestSite[]) =>
  `The stores I use are Kestrel Ridge Outfitters (${kestrel?.origin}/) and Bergwald Supply (${bergwald?.origin}/). Deliver to me in Leeds, UK.`;

/** The newest card, or nothing once the turn is over. */
const card = (page: Page) => page.locator("section.round").last();

walkGuide("everyday/shopping-and-style/landed-cost", {
  configured: true,
  model: true,
  search: true,
  timeoutMs: 720_000,
  steps: {
    "tell-tavi-your-stores": async (walk) => {
      sites = await Promise.all(STORES.map((store) => testSite(store)));
      // The stores are on this computer: the browser may open them only once the owner lists them.
      await restartOwner(
        walk.dataDir,
        sites.flatMap((site) => ["--browser-allow-host", site.host]),
      );
      page = await walk.open("/");
      await newChat(page);
      const said = await slash(page, `/remember ${stores(sites)}`);
      await expect(said.textContent()).resolves.toContain("Saved");
      // A chat with no turn yet has nowhere to post the card: the note above the box says it, and the owner has it.
      expect(keptWith(walk, "stores I use")?.status).toBe("approved");
      await shotAlone(walk, said);
    },
    "ask-for-it": async (walk) => {
      page = await promptSent(walk, recipePrompt("shopping.landed-cost", { product: "a Harlow 1 litre steel flask" }));
    },
    "let-it-open-the-stores": async (walk) => {
      // The memory reaches a chat when its words fit: asked which stores instead, the walk names them, as the page says.
      const allow = card(page).getByRole("button", { name: "Allow for this chat" });
      const answers = page.getByRole("button", { name: "Copy response" });
      await expect
        .poll(async () => (await allow.isVisible()) || (await answers.count()) > 0, { timeout: 180_000, interval: 1_000 })
        .toBe(true);
      if (!(await allow.isVisible())) {
        const box = page.locator(".composer-box textarea");
        await box.fill(stores(sites));
        await box.press("Enter");
      }
      await allow.waitFor({ timeout: 180_000 });
      await expect(card(page).textContent()).resolves.toContain("This chat wants to use the browser on");
      await shotAlone(walk, card(page));
      await allowUntilEnded(page, 420_000);
    },
    "read-the-result": async (walk) => {
      // It went to both stores, and did the sum: the store with the lower price is the dearer one delivered.
      for (const site of sites) expect(site.requests.join(" "), site.origin).toContain("GET /");
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("browser.");
      const answer = (await lastAnswer(page)).locator(".markdown").last();
      await expect(answer.textContent()).resolves.toMatch(/30\.95/);
      await expect(answer.textContent()).resolves.toMatch(/39\.78/);
      await expect(answer.textContent()).resolves.toMatch(/Kestrel/);
      await readFromTheTop(walk, page);
    },
  },
});
