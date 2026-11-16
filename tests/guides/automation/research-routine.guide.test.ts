import { expect } from "vitest";

import { fillNewRoutine, routineActive, routineIdOf, routineRunEnded, saveRoutine, SEED_ZONE, spanning } from "../support/automation.js";
import { walkGuide } from "../support/walk.js";

const NAME = "Battery watch";

walkGuide("automation/research-routine", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  // The setup check alone may take fifteen minutes, and the run a few more.
  timeoutMs: 45 * 60_000,
  steps: {
    "say-what-to-follow": async (walk) => {
      const page = await walk.open("/center/schedule");
      const dialog = await fillNewRoutine(page, {
        name: NAME,
        objective: "Find the latest news on solid-state batteries for electric cars.",
      });
      await page.setViewportSize({ width: 1280, height: 1100 });
      await walk.shot(dialog);
      await page.setViewportSize({ width: 1280, height: 800 });
      await saveRoutine(dialog);
      expect(routineIdOf(walk)).toMatch(/\S/);
    },
    "wait-for-its-setup-check": async (walk) => {
      const page = await walk.page();
      // Saving opened the routine's page.
      await page.locator("h2.page-title", { hasText: NAME }).waitFor();
      await routineActive(page);
      await page.getByRole("heading", { name: "Overview" }).waitFor();
      await page.setViewportSize({ width: 1280, height: 1000 });
      await walk.shot();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "run-it-now": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Run now", exact: true }).click();
      const ended = await routineRunEnded(page);
      // The guide shows a run that published its report (degraded only marks its caveats).
      expect(ended).toMatch(/succeeded|degraded/);
      const summary = page.getByRole("heading", { name: "Summary" });
      const title = page.locator("h2.page-title", { hasText: /^Run / });
      await title.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, title, page.locator("section, .card").filter({ has: summary }).last());
      await walk.shot(span.box, { mask: [page.locator("dl dd")] });
      await span.remove();
    },
    "read-the-report": async (walk) => {
      const page = await walk.page();
      const heading = page.getByRole("heading", { name: "Report", exact: true });
      await heading.scrollIntoViewIfNeeded();
      const section = page.locator("section, .card").filter({ has: heading }).last();
      await section.locator(".routine-report").waitFor();
      await page.setViewportSize({ width: 1280, height: 1200 });
      await section.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await walk.shot(section, { mask: [section.locator(".routine-report")] });
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
