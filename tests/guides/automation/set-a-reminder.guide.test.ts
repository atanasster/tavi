import { expect } from "vitest";

import { inDays, SEED_ZONE } from "../support/automation.js";
import { dismissChecklist, lastAnswer, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Reminder {
  readonly reminderId: string;
  readonly text: string;
  readonly status: string;
  readonly when: { readonly kind: string; readonly times?: readonly string[]; readonly daysOfWeek?: readonly number[] };
}

const reminders = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<{ reminders: Reminder[] }>("reminders", "list").reminders;
const named = (walk: { taviJson<T>(...args: string[]): T }, text: RegExp) => reminders(walk).find((reminder) => text.test(reminder.text));

walkGuide("automation/set-a-reminder", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-one-in-a-chat": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(page, "Remind me to take my pills every evening at 9.");
      // Made without an approval card: the workspace's reminders rule allows it.
      await expect(page.getByText("Needs your approval").count()).resolves.toBe(0);
      const pills = named(walk, /pill/i);
      expect(pills?.when).toMatchObject({ kind: "repeat", times: ["21:00"] });
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text")] });
    },
    "add-an-appointment-from-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi reminders add",
        args: ["reminders", "add", "Dentist appointment", "--event", `${inDays(17)} 10:00`],
        lines: 4,
      });
      expect(screen.join("\n")).toContain("I'll remind you");
      expect(named(walk, /^Dentist appointment$/)?.when.kind).toBe("event");
    },
    "make-a-repeating-one-in-schedule": async (walk) => {
      const page = await walk.open("/center/schedule");
      await page.getByRole("button", { name: "New reminder" }).click();
      const form = page.getByRole("form", { name: "New reminder" });
      await form.getByLabel("Remind me to").fill("Stretch");
      await form.getByRole("radio", { name: "Repeat" }).check();
      await form.getByRole("radio", { name: "On days of the week" }).check();
      await form.getByRole("button", { name: "Weekdays" }).click();
      await form.getByLabel("Time", { exact: true }).fill("10:00");
      await form.getByRole("button", { name: "Add a time" }).click();
      await form.getByLabel("Time 2").fill("15:00");
      // The next three runs come from the owner's scheduler a moment after the last change.
      await form.locator(".cadence-preview ol li").nth(2).waitFor();
      await form.scrollIntoViewIfNeeded();
      await page.setViewportSize({ width: 1280, height: 1100 });
      await walk.shot(form);
      await page.setViewportSize({ width: 1280, height: 800 });
      await form.getByRole("button", { name: "Save reminder" }).click();
      await expect
        .poll(() => named(walk, /^Stretch$/)?.when, { timeout: 15_000 })
        .toMatchObject({
          kind: "repeat",
          times: ["10:00", "15:00"],
          daysOfWeek: [1, 2, 3, 4, 5],
        });
    },
    "snooze-pause-or-delete-it": async (walk) => {
      const stretch = named(walk, /^Stretch$/);
      const page = await walk.open(`/center/schedule/reminders/${stretch?.reminderId}`);
      const pause = page.getByRole("button", { name: "Pause", exact: true });
      await pause.waitFor();
      await walk.shot();
      await pause.click();
      await expect.poll(() => named(walk, /^Stretch$/)?.status, { timeout: 15_000 }).toBe("paused");
      await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    },
  },
});
