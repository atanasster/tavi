import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import { fireRecorded, homeNoticeShot, SEED_ZONE, scheduleFires, scheduleShown, spanning } from "../support/automation.js";
import { chats, dismissChecklist, projectsFolder, restartOwner, send, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

// The watched file's folder and the data directory are spelled as the owner stores them (macOS's /private/var).
useRealTmpdir();

const PRICES = "Apples 2.10 a kilo\nPears 2.40 a kilo\n";
const NEW_PRICES = "Apples 1.80 a kilo\nPears 2.40 a kilo\nPlums 3.00 a kilo\n";
let file = "";
/** When the last look at the file was recorded: the next waits a minute, the watcher's limit. */
let lastLook = 0;

walkGuide("automation/watch-a-page-or-feed", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "watch-a-file": async (walk) => {
      const folder = projectsFolder("watch-a-page-or-feed", { "prices.txt": PRICES });
      file = join(folder, "prices.txt");
      // Before you start: the owner serves the folder that holds the file.
      await restartOwner(walk.dataDir, ["--fs-root", folder]);
      walk.tavi(
        ...["schedules", "watch", "prices", "--file", file, "--folder", folder, "--deliver-to", "home"],
        ...["--prompt", "Tell me in one short line that prices.txt has changed."],
      );
      const screen = await walk.terminal({ title: "tavi schedules list", args: ["schedules", "list"] });
      expect(screen.join(" ")).toMatch(/watches the file/);
      // Its folder is the file's, so each run can read the file.
      expect(scheduleShown(walk, "prices")).toMatchObject({ watch: true, precheck: { kind: "file-changed" }, folder });
    },
    "change-the-file": async (walk) => {
      // Home, where the result goes, holds a first message, as a reader's does.
      const home = await walk.open("/");
      await dismissChecklist(home);
      if (!chats(walk.tavi).some((chat) => chat.chatKind === "home")) await send(home, "Hello! Just say hi back in a few words.");
      writeFileSync(file, NEW_PRICES);
      const fire = await fireRecorded(walk, "prices", (each) => each.reasonCode === "watch" && each.taskId !== null);
      expect(fire.outcome).not.toMatch(/failed|unchanged/);
      lastLook = Date.parse(fire.fireTime);
      const { scheduleId } = scheduleShown(walk, "prices");
      const fires = await scheduleFires(walk, scheduleId, 1);
      await fires.page
        .getByRole("link", { name: /Open its task/ })
        .first()
        .waitFor();
      await walk.shot(fires.box);
      await fires.remove();
    },
    "hear-about-it-in-home": async (walk) => {
      await homeNoticeShot(walk, "prices", dismissChecklist);
    },
    "save-it-without-a-change": async (walk) => {
      // The watcher looks at most once a minute.
      const wait = lastLook + 65_000 - Date.now();
      if (wait > 0) await delay(wait);
      writeFileSync(file, NEW_PRICES);
      await fireRecorded(walk, "prices", (each) => each.reasonCode === "watch" && /unchanged/.test(each.outcome));
      expect(scheduleShown(walk, "prices").recentFires.filter((each) => each.taskId !== null)).toHaveLength(1);
      const { scheduleId } = scheduleShown(walk, "prices");
      const fires = await scheduleFires(walk, scheduleId, 2);
      await walk.shot(fires.box);
      await fires.remove();
    },
    "watch-a-page-or-a-feed": async (walk) => {
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: "New schedule" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Schedule name").fill("opening-hours");
      await dialog.getByLabel("Schedule prompt").fill("Say in one line what changed in the library's opening hours.");
      await dialog.getByRole("combobox", { name: "Deliver result to" }).click();
      await page.getByRole("option", { name: "Home" }).click();
      await dialog.getByRole("combobox", { name: "Schedule pre-check" }).click();
      await page.getByRole("option", { name: "A page changed" }).click();
      await dialog.getByLabel("Schedule pre-check target").fill("https://example.com/opening-hours");
      await dialog.getByRole("combobox", { name: "Schedule watch mode" }).click();
      await page.getByRole("option", { name: /^Yes: check every hour/ }).click();
      await page.setViewportSize({ width: 1280, height: 1200 });
      const from = dialog.locator("label").filter({ hasText: "Only run when" }).first();
      await from.scrollIntoViewIfNeeded();
      const span = await spanning(
        page,
        from,
        dialog.locator("label").filter({ hasText: "Watch it" }).locator("xpath=following-sibling::p[1]"),
      );
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog.getByRole("button", { name: "Save schedule" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(scheduleShown(walk, "opening-hours")).toMatchObject({ watch: true, precheck: { kind: "page-changed" } });
    },
    "find-your-watchers": async (walk) => {
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: "Watchers", exact: true }).click();
      const heading = page.locator("h2.schedule-recurring-head");
      const list = page.locator("ul.schedule-recurring-list");
      await expect.poll(() => list.locator("li.schedule-recurring").count(), { timeout: 15_000 }).toBe(2);
      await heading.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, heading, list);
      await walk.shot(span.box);
      await span.remove();
      // The walk never lets the page watcher's first hourly look reach the real site.
      walk.tavi("schedules", "remove", "opening-hours");
    },
  },
});
