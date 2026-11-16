import { expect } from "vitest";

import { fireRecorded, SEED_ZONE, scheduleFires, scheduleShown, spanning } from "../support/automation.js";
import { walkGuide } from "../support/walk.js";

const NAME = "news-digest";

interface Doctor {
  readonly scheduledWork?: { readonly tokens: number; readonly budget?: number; readonly percent?: number };
}

walkGuide("automation/cap-what-it-spends", {
  configured: true,
  model: true,
  seed: [
    SEED_ZONE,
    // Before you start: a schedule to cap.
    [
      ...["schedules", "add", "--name", NAME, "--at", "07:00", "--timezone", "Europe/London"],
      ...["--prompt", "Write a three-line digest of what a small allotment society might need to know this week."],
    ],
  ],
  steps: {
    "set-a-token-ceiling": async (walk) => {
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: `More actions for ${NAME}` }).click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Schedule token ceiling").fill("2000");
      await page.setViewportSize({ width: 1280, height: 1200 });
      const from = dialog.locator("label").filter({ hasText: "Run limit (minutes)" }).first();
      await from.scrollIntoViewIfNeeded();
      const to = dialog.locator("label").filter({ hasText: "Token ceiling" }).locator("xpath=following-sibling::p[1]");
      const span = await spanning(page, from, to);
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog.getByRole("button", { name: "Save schedule" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(scheduleShown(walk, NAME).maxTokens).toBe(2000);
    },
    "see-a-run-stop-at-it": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: `Run now: ${NAME}` }).click();
      const fire = await fireRecorded(walk, NAME, (each) => /over budget/.test(each.outcome));
      expect(fire.outcome).toMatch(/past its ceiling of 2,000 tokens/);
      const fires = await scheduleFires(walk, scheduleShown(walk, NAME).scheduleId, 1);
      await walk.shot(fires.box);
      await fires.remove();
    },
    "set-the-ceiling-you-mean": async (walk) => {
      walk.tavi("schedules", "update", NAME, "--max-tokens", "100000");
      const screen = await walk.terminal({ title: "tavi schedules show", args: ["schedules", "show", NAME], lines: 18 });
      expect(screen.join("\n")).toMatch(/tokens\s+.*100,000/);
      expect(scheduleShown(walk, NAME).maxTokens).toBe(100_000);
    },
    "set-a-monthly-budget": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config set",
        args: ["config", "set", "scheduled.monthlyTokenBudget", "500000"],
        lines: 4,
      });
      expect(screen.join("\n")).not.toBe("");
      expect(walk.taviJson<Doctor>("doctor").scheduledWork?.budget).toBe(500_000);
    },
    "see-what-scheduled-work-spent": async (walk) => {
      const work = walk.taviJson<Doctor>("doctor").scheduledWork;
      expect(work?.tokens ?? 0).toBeGreaterThan(0);
      const page = await walk.open("/center/schedule");
      const heading = page.locator("h2.schedule-recurring-head");
      const line = page.locator(".schedule-month");
      await expect(line.textContent()).resolves.toMatch(/500,000/);
      const row = page.locator("ul.schedule-recurring-list li.schedule-recurring").first();
      await row.waitFor();
      await heading.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, heading, row);
      await walk.shot(span.box);
      await span.remove();
    },
  },
});
