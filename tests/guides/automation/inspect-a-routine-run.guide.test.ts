import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { fillNewRoutine, routineActive, routineIdOf, routineRunEnded, saveRoutine, SEED_ZONE, spanning } from "../support/automation.js";
import { walkGuide } from "../support/walk.js";

const NAME = "Battery watch";

/** The card a section's heading names on a run's page. */
const section = (page: Page, title: string): Locator =>
  page
    .locator("section, .card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .last();

/** Shows a section of the run's page at the top of a tall window, and pictures it. */
async function picture(
  walk: { shot(target?: Locator, options?: { mask?: readonly Locator[] }): Promise<void> },
  page: Page,
  title: string,
  mask: readonly Locator[] = [],
) {
  const card = section(page, title);
  await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await walk.shot(card, { mask });
}

walkGuide("automation/inspect-a-routine-run", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  timeoutMs: 45 * 60_000,
  steps: {
    "open-a-run-from-its-routine": async (walk) => {
      // Before you start: a research routine that has run once, made and run as the research-routine guide does.
      const page = await walk.open("/center/schedule");
      await saveRoutine(
        await fillNewRoutine(page, { name: NAME, objective: "Find the latest news on solid-state batteries for electric cars." }),
      );
      await routineActive(page);
      await page.getByRole("button", { name: "Run now", exact: true }).click();
      expect(await routineRunEnded(page)).toMatch(/succeeded|degraded/);
      // The step: from Schedule, the routine's page, its Runs.
      const routine = await walk.open(`/center/schedule/routines/${routineIdOf(walk)}`);
      const runs = section(routine, "Runs");
      await runs
        .getByRole("button", { name: /^Inspect the run of/ })
        .first()
        .waitFor();
      await page.setViewportSize({ width: 1280, height: 1000 });
      await runs.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await walk.shot(runs, { mask: [runs.locator(".item-meta")] });
      await runs
        .getByRole("button", { name: /^Inspect the run of/ })
        .first()
        .click();
    },
    "read-its-summary-and-report": async (walk) => {
      const page = await walk.page();
      const title = page.locator("h2.page-title", { hasText: /^Run / });
      await title.waitFor();
      await section(page, "Report").locator(".routine-report").waitFor();
      await title.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await walk.shot(undefined, { mask: [page.locator("dl dd"), page.locator(".routine-report")] });
    },
    "see-where-it-was-delivered": async (walk) => {
      const page = await walk.page();
      await expect(section(page, "Delivery and receipts").textContent()).resolves.toContain("No delivery requested");
      await picture(walk, page, "Delivery and receipts");
    },
    "check-the-pages-it-read": async (walk) => {
      const page = await walk.page();
      const evidence = section(page, "Fetched evidence");
      await evidence.locator(".evidence-row").first().waitFor();
      // The first few pages: the section can be longer than any window.
      const rows = evidence.locator(".evidence-row");
      const last = rows.nth(Math.min(2, (await rows.count()) - 1));
      await evidence.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, evidence, last);
      await walk.shot(span.box, { mask: [evidence.locator(".item-main")] });
      await span.remove();
    },
    "follow-each-step-it-took": async (walk) => {
      const page = await walk.page();
      const timeline = section(page, "Timeline and actual prompts");
      await timeline.locator(".item-row").first().waitFor();
      const rows = timeline.locator(".item-row");
      const last = rows.nth(Math.min(7, (await rows.count()) - 1));
      await timeline.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, timeline, last);
      await walk.shot(span.box, { mask: [timeline.locator(".item-meta")] });
      await span.remove();
    },
  },
});
