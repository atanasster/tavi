import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { allowUntilEnded, footOf, promptSent, readFromTheTop, recipePrompt, shotAlone } from "../../support/recipes.js";
import { lastAnswer, restartOwner } from "../../support/steps.js";
import { type TestSite, testSite } from "../../support/test-site.js";
import { walkGuide } from "../../support/walk.js";

/**
 * Reviews that read as one writer: the same days, the same words, nothing about the thing itself. Each has its stars,
 * and the unhappy one comes after the rest: a model given neither made up "5-star" and a burst of praise that answered it.
 */
const REVIEWS = [
  ["A. Smith", "2 October", "5 out of 5", "Amazing product! Fast shipping! Highly recommend to everyone!"],
  ["J. Brown", "2 October", "5 out of 5", "Amazing product, fast shipping, highly recommend to everyone!!"],
  ["M. Jones", "2 October", "5 out of 5", "Amazing quality! Fast shipping! Would highly recommend!"],
  ["K. Taylor", "3 October", "5 out of 5", "Best product amazing price. Highly recommend to everyone."],
  ["S. Wilson", "3 October", "5 out of 5", "Amazing product! Fast shipping! Highly recommend!"],
  [
    "R. Davies",
    "24 October",
    "1 out of 5",
    "Stopped charging after a week, and the box said Sonix Bud Pro, not SonixBud. Seller did not reply.",
  ],
];

/** A made-up listing with what a careful buyer would doubt in it: nothing here is a real product or shop. */
const SHOP = {
  name: "Marketwise Deals",
  colour: "#9a3b26",
  pages: {
    "/": {
      title: "SonixBud Pro X9 wireless earbuds",
      html:
        "<h2>SonixBud Pro X9 wireless earbuds: 100% Genuine Original</h2>" +
        "<p><strong>£14.99</strong> <s>RRP £149.00</s>, 90% off today only. Rated 4.9 out of 5 from 2,431 reviews.</p>" +
        "<p>Sold by BestValue Trading 88, on Marketwise for 3 weeks. Ships from an address not shown. No returns on sale items.</p>" +
        `<h3>Customer reviews</h3><table>${REVIEWS.map(([who, when, stars, what]) => `<tr><td>${who}<br>${when}</td><td>${stars}</td><td>${what}</td></tr>`).join("")}</table>`,
    },
  },
};

let page: Page;
let site: TestSite;

walkGuide("everyday/shopping-and-style/review-check", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      site = await testSite(SHOP);
      // The shop is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      page = await promptSent(walk, recipePrompt("shopping.review-check", { link: `${site.origin}/` }));
    },
    "let-it-open-the-listing": async (walk) => {
      const round = page.locator("section.round").last();
      await round.getByRole("button", { name: "Allow for this chat" }).waitFor({ timeout: 180_000 });
      await expect(round.textContent()).resolves.toContain("This chat wants to use the browser on");
      await shotAlone(walk, round);
      await allowUntilEnded(page, 300_000);
    },
    "read-the-result": async (walk) => {
      // It read the listing itself, and doubts what is there to doubt.
      expect(site.requests).toContain("GET /");
      const answer = (await lastAnswer(page)).locator(".markdown").last();
      await expect(answer.textContent()).resolves.toMatch(/repetit|identical|same (words|phras|wording|day|date)|near-identical|copy/i);
      await expect(answer.textContent()).resolves.toMatch(/£14\.99|£149|90%/);
      // The page's cover must not tie the praise to the complaint in time: three weeks part them, and the praise came first.
      await expect(answer.textContent()).resolves.not.toMatch(
        /(immediately|right|shortly|directly|just) (after|before|following|preceding)/i,
      );
      await expect(answer.textContent()).resolves.not.toMatch(/september/i);
      // Nothing on the listing says a buyer was verified.
      await expect(answer.textContent()).resolves.not.toMatch(/\bverified (buyer|purchase|review)/i);
      const foot = await footOf(await lastAnswer(page), ".markdown > ul > li, .markdown > ol > li, .markdown > p, .markdown table", 840);
      expect(foot, "a whole block fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
  },
});
