import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { restartOwner, send } from "../support/steps.js";
import { newChat } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

/** A folded group of a turn's calls: "Worked · 4 steps". */
const GROUP = /Work(ed|ing) · \d+ step/;

/** The newest call of `tool` in the transcript (a call's own row, not the group it is folded into). */
const call = (page: Page, tool: string): Locator =>
  page
    .locator("main details")
    .filter({ has: page.locator(":scope > summary", { hasText: tool }) })
    .filter({ hasNot: page.locator(":scope > summary", { hasText: GROUP }) })
    .last();

/** Opens every folded group of calls in the transcript, then the newest call of `tool`, scrolled to the top. */
async function openCall(page: Page, tool: string): Promise<Locator> {
  for (const group of await page
    .locator("main details")
    .filter({ has: page.locator(":scope > summary", { hasText: GROUP }) })
    .all()) {
    if ((await group.getAttribute("open")) === null) await group.locator(":scope > summary").click();
  }
  const found = call(page, tool);
  if ((await found.getAttribute("open")) === null) await found.locator(":scope > summary").click();
  await found.locator(":scope > summary").evaluate((summary) => summary.scrollIntoView({ block: "start" }));
  return found;
}

walkGuide("web-and-browser/research-with-sources", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-your-question": async (walk) => {
      // As the guide's reader may: Wikipedia's pages are read with web_fetch, without asking.
      await restartOwner(walk.dataDir, ["--http-allow-host", "en.wikipedia.org"]);
      const page = await walk.open("/");
      await newChat(page);
      await send(
        page,
        "When did the James Webb Space Telescope launch, and what is its main mirror made of? Search the web, and list your sources with their links.",
      );
      await expect(page.locator("main").textContent()).resolves.toContain("web_search");
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "see-what-it-searched-for": async (walk) => {
      const page = await walk.page();
      const search = await openCall(page, "web_search");
      await expect.poll(async () => (await search.textContent()) ?? "", { timeout: 10_000 }).toMatch(/"query"/);
      await expect(search.textContent()).resolves.toMatch(/https:\/\//);
      await walk.shot(page.locator("main"));
    },
    "check-the-sources": async (walk) => {
      const page = await walk.page();
      const answer = page.locator("main .markdown").last();
      await answer.scrollIntoViewIfNeeded();
      await expect.poll(() => answer.locator('a[href^="http"]').count()).toBeGreaterThan(0);
      // The answer is taller than the window: the whole window, with its sources (at its end) in the middle of it.
      await answer
        .locator('a[href^="http"]')
        .last()
        .evaluate((link) => link.scrollIntoView({ block: "center" }));
      await walk.shot(undefined, { mask: [answer] });
    },
    "have-it-read-a-page-in-full": async (walk) => {
      const page = await walk.page();
      await send(
        page,
        "Read the Wikipedia article on the James Webb Space Telescope with web_fetch, and tell me how many segments the main mirror has.",
      );
      const fetched = await openCall(page, "web_fetch");
      await expect(fetched.textContent()).resolves.toContain("en.wikipedia.org");
      // Read without a card: the site is on the owner's list.
      expect(walk.taviJson<{ rows: readonly unknown[] }>("approvals", "list").rows).toEqual([]);
      // The picture is the call's row, closed again, above the answer.
      await fetched.locator(":scope > summary").click();
      await page.locator("main .markdown").last().scrollIntoViewIfNeeded();
      await walk.shot(page.locator("main"), { mask: [page.locator("main .markdown")] });
    },
    "decide-about-other-sites": async (walk) => {
      const page = await walk.page();
      const composer = page.locator(".composer-box textarea");
      await composer.fill(
        "Now open NASA's Webb mission page, https://science.nasa.gov/mission/webb/, in the browser and tell me where it launched from.",
      );
      await composer.press("Enter");
      const round = page.locator("section.round").last();
      await round.getByRole("button", { name: "Allow for this chat" }).waitFor({ timeout: 180_000 });
      await expect(round.textContent()).resolves.toContain("This chat wants to use the browser on science.nasa.gov");
      await walk.shot(round);
      // The walk answers as a reader in a hurry might: no, and Tavi answers from what it has.
      await round.getByRole("button", { name: "Deny…" }).click();
      await round.getByRole("button", { name: "Deny", exact: true }).click();
      await expect.poll(async () => (await composer.getAttribute("placeholder")) ?? "", { timeout: 180_000 }).not.toMatch(/^Queue/);
    },
  },
});
