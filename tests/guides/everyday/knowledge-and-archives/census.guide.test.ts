import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { browserUntilEnded, signInYourself, untilHandoff } from "../../support/browser-site.js";
import { promptInTheBox, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { restartOwner } from "../../support/steps.js";
import { type TestSite, testSite } from "../../support/test-site.js";
import { walkGuide } from "../../support/walk.js";

/** One made-up census entry: the year, the address, and the household with the person in it. */
const entry = (year: string, address: string, rows: readonly (readonly [string, string, string, string])[]) => ({
  title: `${year} census, ${address} — Kinfolk Records`,
  html:
    `<h2>${year} census: ${address}</h2><table><tr><td><strong>Name</strong></td><td><strong>Relation</strong></td><td><strong>Age</strong></td><td><strong>Occupation</strong></td></tr>` +
    rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") +
    `</table><p>Born: Dundee, Forfarshire.</p>`,
});

/** A made-up census archive on this computer: a sign-in, a search, its results and three records of a made-up family. */
const ARCHIVE = {
  name: "Kinfolk Records",
  colour: "#5b4636",
  nav: '<a href="/search">Search</a><a href="/help">Help</a>',
  signIn: { landing: "/search" },
  pages: {
    "/help": { title: "Help — Kinfolk Records", html: "<p>Search by name, year of birth and place.</p>" },
    "/search": {
      title: "Search — Kinfolk Records",
      html:
        '<h2>Search the censuses</h2><form method="post" action="/results"><label>Name<input name="name"></label>' +
        '<label>Born around<input name="born"></label><label>Place<input name="place"></label><button type="submit">Search</button></form>',
    },
    "/results": {
      title: "Results — Kinfolk Records",
      html:
        "<h2>Results: Agnes Murray, born about 1872, Dundee</h2><table>" +
        '<tr><td><a href="/record/1881">1881, 4 Rosebank Street, Dundee</a></td><td>Agnes Murray, 9</td></tr>' +
        '<tr><td><a href="/record/1891">1891, 12 Hawkhill, Dundee</a></td><td>Agnes Murray, 19</td></tr>' +
        '<tr><td><a href="/record/1901">1901, 7 South Road, Lochee, Dundee</a></td><td>Agnes Lindsay, 29 (born Dundee)</td></tr>' +
        '<tr><td><a href="/record/1891b">1891, 3 Seagate, Dundee</a></td><td>Agnes Murray, 46</td></tr></table>',
    },
    "/record/1881": entry("1881", "4 Rosebank Street, Dundee", [
      ["James Murray", "Head", "41", "Flax dresser"],
      ["Margaret Murray", "Wife", "38", ""],
      ["Agnes Murray", "Daughter", "9", "Scholar"],
    ]),
    "/record/1891": entry("1891", "12 Hawkhill, Dundee", [
      ["Margaret Murray", "Head, widow", "48", "Washerwoman"],
      ["Agnes Murray", "Daughter", "19", "Jute weaver"],
    ]),
    "/record/1901": entry("1901", "7 South Road, Lochee, Dundee", [
      ["John Lindsay", "Head", "33", "Jute mill mechanic"],
      ["Agnes Lindsay", "Wife", "29", "Jute weaver"],
      ["Margaret Lindsay", "Daughter", "4", ""],
      ["Margaret Murray", "Mother-in-law, widow", "58", ""],
    ]),
    "/record/1891b": entry("1891", "3 Seagate, Dundee", [["Agnes Murray", "Head, single", "46", "Shopkeeper"]]),
  },
};

let site: TestSite;
let page: Page;

walkGuide("everyday/knowledge-and-archives/census", {
  configured: true,
  model: true,
  timeoutMs: 1_200_000,
  steps: {
    "ask-for-it": async (walk) => {
      site = await testSite(ARCHIVE);
      // The site is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      // The catalogue's prompt names no archive: one sentence says which, and that the reader signs in.
      const prompt =
        `${recipePrompt("learning.census", { "ancestor's name": "Agnes Murray", year: "1872", place: "Dundee" })} ` +
        `Use the archive at ${site.origin}/search; it needs a sign-in, so hand me the browser and I'll sign in myself.`;
      page = await promptInTheBox(walk, prompt);
      await page.locator(".composer-box textarea").press("Enter");
    },
    "sign-in-yourself": async (walk) => {
      await untilHandoff(page, 1);
      await signInYourself(page, site, () => walk.shot());
    },
    "read-the-trail": async (walk) => {
      await browserUntilEnded(page);
      // It searched, and opened the 1901 record, where she is under her married name.
      expect(site.requests).toContain("POST /results");
      expect(site.requests).toContain("GET /record/1901");
      const said = (await page.locator("main .markdown").last().textContent()) ?? "";
      expect(said).toMatch(/Lindsay/);
      // The whole trail, down to 1901 and the married name, which the page talks about.
      await wholeAnswer(walk, page);
    },
  },
});
