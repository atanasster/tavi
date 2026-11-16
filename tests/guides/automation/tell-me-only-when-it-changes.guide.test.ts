import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";

import { fireRecorded, homeNoticeShot, SEED_ZONE, scheduleFires, scheduleShown, spanning } from "../support/automation.js";
import { chats, dismissChecklist, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const NAME = "library-hours";
/** A run whose words never change, so the second result is the same as the first. */
const SAME = "Reply with exactly this line and nothing else: The library is open 9 to 5 today.";
const QUIET =
  "Read this note: 'The library is open as usual.' If it says the library is closed, say so in one line. Otherwise there is nothing to tell.";

/** Runs it from its row in Recurring and waits until `count` of its runs have ended. */
async function runNow(walk: { taviJson<T>(...args: string[]): T; page(): Promise<Page> }, count: number): Promise<void> {
  const page = await walk.page();
  await page.getByRole("button", { name: `Run now: ${NAME}` }).click();
  await expect
    .poll(
      () =>
        scheduleShown(walk, NAME).recentFires.filter((fire) => fire.taskId !== null && !/^manual run: running/.test(fire.outcome)).length,
      {
        timeout: 180_000,
        interval: 3_000,
      },
    )
    .toBe(count);
}

walkGuide("automation/tell-me-only-when-it-changes", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "choose-when-it-tells-you": async (walk) => {
      // Before you start: a first message in Home, where the results go.
      const home = await walk.open("/");
      await dismissChecklist(home);
      if (!chats(walk.tavi).some((chat) => chat.chatKind === "home")) await send(home, "Hello! Just say hi back in a few words.");
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: "New schedule" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Schedule name").fill(NAME);
      await dialog.getByLabel("Schedule prompt").fill(SAME);
      await dialog.getByLabel("Time", { exact: true }).fill("08:00");
      await dialog.getByRole("combobox", { name: "Deliver result to" }).click();
      await page.getByRole("option", { name: "Home" }).click();
      await dialog.getByRole("combobox", { name: "Schedule notify" }).click();
      await page.getByRole("option", { name: "Only when the result changed" }).click();
      await page.setViewportSize({ width: 1280, height: 1200 });
      const from = dialog.locator("label").filter({ hasText: "Deliver result to" }).first();
      await from.scrollIntoViewIfNeeded();
      const to = dialog.locator("label").filter({ hasText: "Tell me" }).locator("xpath=following-sibling::p[1]");
      const span = await spanning(page, from, to);
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog.getByRole("button", { name: "Save schedule" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(scheduleShown(walk, NAME)).toMatchObject({ notify: "if-changed" });
    },
    "see-the-first-result": async (walk) => {
      await runNow(walk, 1);
      expect(scheduleShown(walk, NAME).recentFires[0]?.outcome).toMatch(/completed$/);
      await homeNoticeShot(walk, NAME, dismissChecklist);
    },
    "run-it-again": async (walk) => {
      await walk.open("/center/schedule");
      await runNow(walk, 2);
      const fire = scheduleShown(walk, NAME).recentFires[0];
      expect(fire?.outcome).toMatch(/completed quietly.*unchanged/);
      const fires = await scheduleFires(walk, scheduleShown(walk, NAME).scheduleId, 2);
      await walk.shot(fires.box);
      await fires.remove();
    },
    "let-the-run-decide": async (walk) => {
      walk.tavi("schedules", "update", NAME, "--notify", "when-sent", "--prompt", QUIET);
      const screen = await walk.terminal({ title: "tavi schedules show", args: ["schedules", "show", NAME], lines: 16 });
      expect(screen.join("\n")).toMatch(/notifies/);
      expect(scheduleShown(walk, NAME)).toMatchObject({ notify: "when-sent" });
    },
    "check-a-quiet-run": async (walk) => {
      const screen = await walk.terminal({ title: "tavi schedules run-now", args: ["schedules", "run-now", NAME], lines: 12 });
      const fire = await fireRecorded(walk, NAME, (each) => /completed quietly/.test(each.outcome) && !/unchanged/.test(each.outcome));
      expect(fire.taskId).not.toBeNull();
      expect(screen.join("\n")).toMatch(/nothing to report/);
      expect(scheduleShown(walk, NAME).consecutiveFailures).toBe(0);
    },
  },
});
