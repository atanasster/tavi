import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { completedCalls } from "../../support/apps.js";
import { newChat } from "../../support/browser-site.js";
import { allowCard, answered, onePagePdf, readFromTheTop, recipePrompt, shotCard } from "../../support/recipes.js";
import { dismissChecklist, restartOwner } from "../../support/steps.js";
import { type TestSite, testSite } from "../../support/test-site.js";
import { walkGuide } from "../../support/walk.js";

/** A made-up employer's careers site on this computer: one job, its application form, and the page a submit lands on. */
const field = (label: string, name: string, type = "text") => `<label>${label}<input name="${name}" type="${type}"></label>`;
const CAREERS = {
  name: "Harbour &amp; Pine Careers",
  colour: "#2f5d50",
  pages: {
    "/": {
      title: "Careers — Harbour & Pine",
      html: '<h2>Office Coordinator</h2><p>Full time, Leith.</p><p><a href="/apply">Apply now</a></p>',
    },
    "/apply": {
      title: "Apply: Office Coordinator — Harbour & Pine",
      html:
        '<h2>Apply: Office Coordinator</h2><form method="post" action="/submitted">' +
        field("Full name", "name") +
        field("Email", "email", "email") +
        field("Phone", "phone", "tel") +
        field("Current job title", "title") +
        field("Years of experience", "years", "number") +
        '<label>Why do you want this role?<textarea name="why" rows="4" style="font-size:22px;width:100%"></textarea></label>' +
        '<button type="submit">Submit application</button></form>',
    },
    "/submitted": { title: "Application received — Harbour & Pine", html: "<h2>Thank you</h2><p>Your application is in.</p>" },
  },
};

/** A made-up résumé: nobody's, its phone number from the range set aside for drama. */
const RESUME = await onePagePdf([
  ["Jordan Ellis", 18, "bold"],
  ["jordan.ellis@example.com  ·  01632 960 123  ·  Edinburgh", 11, "plain"],
  ["Experience", 13, "bold"],
  ["Administrative Assistant, Brightwater Lettings, 2021 to now", 11, "plain"],
  ["Run the front office for a team of twelve; book viewings; keep the supplier accounts.", 11, "plain"],
  ["Receptionist, Calton Dental Practice, 2019 to 2021", 11, "plain"],
  ["Skills", 13, "bold"],
  ["Scheduling, bookkeeping basics, spreadsheets, calm with a full waiting room.", 11, "plain"],
]);

const directories = temporaryDirectories();
const files = directories.create("tavi-recipe-application-");
afterAll(() => directories.cleanup());
writeFileSync(join(files, "resume.pdf"), RESUME);

let site: TestSite;
let page: Page;

walkGuide("everyday/work-and-career/application-prefill", {
  configured: true,
  model: true,
  timeoutMs: 1_200_000,
  steps: {
    "ask-for-it": async (walk) => {
      site = await testSite(CAREERS);
      // The site is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(join(files, "resume.pdf"));
      await page.getByRole("list", { name: "Attached files" }).getByText("resume.pdf").waitFor();
      await page.locator(".composer-box textarea").fill(recipePrompt("work.application-prefill", { link: `${site.origin}/apply` }));
      await walk.shot(page.locator("form").last());
    },
    "allow-the-browser": async (walk) => {
      let pictured = false;
      // Every card is allowed, the browser's first pictured: the form must still never be submitted.
      await answered(page, {
        timeoutMs: 900_000,
        quotesTheChat: true,
        onCard: async (card) => {
          if (!pictured && /browser/i.test((await card.textContent()) ?? "")) {
            await shotCard(walk, card);
            pictured = true;
          }
          await allowCard(card);
        },
      });
      expect(pictured, "the browser's card was pictured").toBe(true);
    },
    "check-each-answer": async (walk) => {
      // It read the résumé and opened the form, and nothing was submitted.
      expect(completedCalls(walk, "pdf.read"), "the résumé was read").toBeGreaterThanOrEqual(1);
      expect(site.requests).toContain("GET /apply");
      expect(site.requests).not.toContain("POST /submitted");
      await readFromTheTop(walk, page);
    },
  },
});
