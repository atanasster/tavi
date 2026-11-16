import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import { SEED_ZONE, scheduleFires, scheduleShown, spanning } from "../support/automation.js";
import { dismissChecklist, homeId, lastAnswer, projectsFolder, restartOwner, send, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

// The watched file's folder and the data directory are spelled as the owner stores them (macOS's /private/var).
useRealTmpdir();

const NAME = "notes-digest";

walkGuide("automation/why-didnt-it-run", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  timeoutMs: 900_000,
  steps: {
    "find-the-failing-schedule": async (walk) => {
      // Before you start: a schedule that stopped telling you things. A watcher with a token ceiling too small for any
      // run fails each time its file changes, and the third failure in a row pauses it.
      const folder = projectsFolder("why-didnt-it-run", { "notes.txt": "Monday: water the beans.\n" });
      const file = join(folder, "notes.txt");
      await restartOwner(walk.dataDir, ["--fs-root", folder]);
      walk.tavi(
        ...["schedules", "watch", NAME, "--file", file, "--deliver-to", "home", "--max-tokens", "2000"],
        ...["--prompt", "Tell me in one short line that notes.txt has changed."],
      );
      for (const [index, line] of [
        "Tuesday: net the strawberries.",
        "Wednesday: sow the chard.",
        "Thursday: turn the compost.",
      ].entries()) {
        writeFileSync(file, `Monday: water the beans.\n${line}\n`);
        await expect
          .poll(
            () =>
              scheduleShown(walk, NAME).recentFires.filter((fire) => fire.reasonCode === "budget" || /over budget/.test(fire.outcome))
                .length,
            {
              timeout: 180_000,
              interval: 3_000,
            },
          )
          .toBe(index + 1);
        // The watcher looks at most once a minute.
        if (index < 2) await delay(62_000);
      }
      await expect.poll(() => scheduleShown(walk, NAME).enabled, { timeout: 30_000 }).toBe(false);
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: "Failing", exact: true }).click();
      const heading = page.locator("h2.schedule-recurring-head");
      const list = page.locator("ul.schedule-recurring-list");
      await list
        .getByText(/Paused after 3 failed runs/)
        .first()
        .waitFor();
      await heading.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, heading, list);
      await walk.shot(span.box);
      await span.remove();
    },
    "read-its-fires": async (walk) => {
      const shown = scheduleShown(walk, NAME);
      expect(shown.consecutiveFailures).toBe(3);
      expect(shown.recentFires[0]?.reasonCode).toBe("paused");
      const fires = await scheduleFires(walk, shown.scheduleId, 4);
      await walk.shot(fires.box);
      await fires.remove();
    },
    "read-it-in-the-terminal": async (walk) => {
      const screen = await walk.terminal({ title: "tavi schedules show", args: ["schedules", "show", NAME] });
      expect(screen.join("\n")).toMatch(/paused after 3 failed runs/);
    },
    "or-ask-in-a-chat": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(page, `Why didn't my ${NAME} schedule run? Check its history with schedules.history, and answer in two short lines.`);
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("schedules.history");
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text")] });
    },
    "fix-the-cause-and-resume": async (walk) => {
      walk.tavi("schedules", "update", NAME, "--max-tokens", "100000");
      const { scheduleId } = scheduleShown(walk, NAME);
      const page = await walk.open(`/center/schedule/schedules/${scheduleId}`);
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
      await expect.poll(() => scheduleShown(walk, NAME)).toMatchObject({ enabled: true, consecutiveFailures: 0, maxTokens: 100_000 });
      await page.setViewportSize({ width: 1280, height: 1100 });
      await walk.shot();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
