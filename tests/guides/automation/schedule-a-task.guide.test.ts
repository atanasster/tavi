import { expect } from "vitest";

import { SEED_ZONE, spanning } from "../support/automation.js";
import { dismissChecklist, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Schedule {
  readonly scheduleId: string;
  readonly name: string;
  readonly deliverTo?: string;
  readonly spec: { readonly at?: string; readonly daysOfWeek?: readonly number[]; readonly everyHours?: number };
  readonly lastOutcome: string | null;
  readonly recentFires?: readonly { readonly reason?: string; readonly outcome?: string }[];
}

const show = (walk: { taviJson<T>(...args: string[]): T }, name: string) => walk.taviJson<Schedule>("schedules", "show", name);

walkGuide("automation/schedule-a-task", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "say-what-to-do-and-when": async (walk) => {
      // Before you start: a conversation in Home already, the Home the schedule's results go to.
      const home = await walk.open("/");
      await dismissChecklist(home);
      await send(home, "Hello! Just say hi back in a few words.");
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: "New schedule" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Schedule name").fill("morning-brief");
      await dialog.getByLabel("Schedule prompt").fill("Write one short motivational quote for my working day, with who said it.");
      await dialog.getByRole("radio", { name: "On days of the week" }).check();
      await dialog.getByRole("button", { name: "Weekdays" }).click();
      await dialog.getByLabel("Time", { exact: true }).fill("07:30");
      await dialog.locator(".cadence-preview ol li").nth(2).waitFor();
      await page.setViewportSize({ width: 1280, height: 1200 });
      const name = dialog.locator("label").filter({ hasText: "Name" }).first();
      await name.scrollIntoViewIfNeeded();
      const span = await spanning(page, name, dialog.locator("fieldset.cadence"));
      await walk.shot(span.box);
      await span.remove();
    },
    "choose-where-the-result-goes": async (walk) => {
      const page = await walk.page();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox", { name: "Deliver result to" }).click();
      await page.getByRole("option", { name: "Home" }).click();
      const deliver = dialog.locator("label").filter({ hasText: "Deliver result to" });
      await deliver.scrollIntoViewIfNeeded();
      const save = dialog.getByRole("button", { name: "Save schedule" });
      await save.scrollIntoViewIfNeeded();
      const span = await spanning(page, deliver, save);
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      await save.click();
      await dialog.waitFor({ state: "detached" });
      expect(show(walk, "morning-brief")).toMatchObject({ deliverTo: "home", spec: { at: "07:30", daysOfWeek: [1, 2, 3, 4, 5] } });
    },
    "try-it-now": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Run now: morning-brief" }).click();
      // The manual run is recorded in its fire history once it ends.
      await expect.poll(() => show(walk, "morning-brief").lastOutcome ?? "", { timeout: 180_000, interval: 3_000 }).toMatch(/ok|manual/);
      const { scheduleId } = show(walk, "morning-brief");
      const schedule = await walk.open(`/center/schedule/schedules/${scheduleId}`);
      const heading = schedule.getByRole("heading", { name: "Fires" });
      await heading.waitFor();
      const fires = schedule.locator("ol.schedule-fires");
      await fires
        .getByRole("link", { name: /Open its task/ })
        .first()
        .waitFor();
      await heading.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const span = await spanning(schedule, heading, fires);
      await walk.shot(span.box);
      await span.remove();
    },
    "read-the-result-in-home": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page.setViewportSize({ width: 1280, height: 1000 });
      const notice = page.locator("main").getByText("Scheduled run “morning-brief”").last();
      await notice.waitFor({ timeout: 30_000 });
      await notice.scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "add-another-from-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi schedules add",
        args: [
          ...["schedules", "add", "--name", "desk-check", "--every-hours", "2", "--between", "08:00-18:00", "--days", "1,2,3,4,5"],
          ...["--timezone", "Europe/London", "--prompt", "Remind me to stand up and stretch.", "--deliver-to", "home"],
        ],
        lines: 8,
      });
      expect(screen.join("\n")).toContain("desk-check");
      expect(show(walk, "desk-check").spec).toMatchObject({ everyHours: 2 });
    },
  },
});
