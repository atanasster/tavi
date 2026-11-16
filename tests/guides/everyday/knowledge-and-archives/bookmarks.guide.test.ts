import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { promptSent, recipePrompt, shotCard, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer, projectsFolder, restartOwner, turnEnded, useRealTmpdir } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

useRealTmpdir();

/** A short bookmarks export of public sites, as a browser writes one: two of the sites have closed for good. */
const BOOKMARKS: readonly (readonly [address: string, title: string])[] = [
  ["https://www.gutenberg.org/", "Project Gutenberg"],
  ["https://en.wikipedia.org/wiki/Water_cycle", "Water cycle - Wikipedia"],
  ["https://www.nasa.gov/", "NASA"],
  ["https://www.rhs.org.uk/", "Royal Horticultural Society"],
  ["http://www.dmoz.org/", "DMOZ - the Open Directory Project"],
  ["https://posterous.com/", "Posterous"],
];

const exported = [
  "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  "<TITLE>Bookmarks</TITLE>",
  "<H1>Bookmarks</H1>",
  "<DL><p>",
  ...BOOKMARKS.map(([address, title]) => `    <DT><A HREF="${address}" ADD_DATE="1420070400">${title}</A>`),
  "</DL><p>",
  "",
].join("\n");

/** The sites Tavi may open: each bookmark's, and the archive's. */
const HOSTS = [...BOOKMARKS.map(([address]) => new URL(address).host), "archive.org", "web.archive.org"];

/** The bookmarks that still answer: none of them needs an archived copy. */
const LIVE = /gutenberg|wikipedia|nasa|rhs/;

/** What a card that lets the turn go on says on its button, for one call or for several. */
const ALLOW = /^(Allow once|Allow selected; deny unchecked)$/;

let page: Page;

walkGuide("everyday/knowledge-and-archives/bookmarks", {
  configured: true,
  model: true,
  search: true,
  timeoutMs: 640_000,
  steps: {
    "ask-for-it": async (walk) => {
      const saved = join(projectsFolder("recipe-bookmarks", { "bookmarks/bookmarks.html": exported }), "bookmarks");
      await restartOwner(walk.dataDir, ["--fs-root", saved, ...HOSTS.flatMap((host) => ["--http-allow-host", host])]);
      page = await promptSent(walk, recipePrompt("productivity.bookmarks", {}));
    },
    "allow-the-addresses": async (walk) => {
      const allow = page.getByRole("button", { name: ALLOW }).last();
      await allow.waitFor({ timeout: 120_000 });
      await shotCard(walk, page.locator("section.round").last());
      // Each card until the answer: the bookmarks, then the archive, in as many rounds as it takes.
      const answers = page.getByRole("button", { name: "Copy response" });
      await expect
        .poll(
          async () => {
            if (await allow.isVisible()) await allow.click({ timeout: 3_000 }).catch(() => undefined);
            return answers.count();
          },
          { timeout: 420_000, interval: 1_000 },
        )
        .toBeGreaterThan(0);
      await turnEnded(page);
    },
    "read-the-result": async (walk) => {
      // It opened the links, rather than going by what it knows of them.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toMatch(/http\.request|web_fetch/);
      const turn = await lastAnswer(page);
      const copies = await turn
        .locator('a[href*="web.archive.org/web/"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
      // A copy of each closed site, and of nothing that still answers.
      expect(copies.some((link) => link.includes("dmoz"))).toBe(true);
      expect(copies.some((link) => link.includes("posterous"))).toBe(true);
      expect(copies.filter((link) => LIVE.test(link))).toEqual([]);
      // Each copy is one the archive gave: a snapshot's date, seen in what Tavi read, not an address it made up.
      const read = (await page.locator("main").textContent()) ?? "";
      const stamps = copies.map((link) => /\/web\/(\d{8,14})/.exec(link)?.[1]);
      expect(stamps.filter((stamp) => stamp === undefined || !read.includes(`web/${stamp}`))).toEqual([]);
      await wholeAnswer(walk, page);
    },
  },
});
