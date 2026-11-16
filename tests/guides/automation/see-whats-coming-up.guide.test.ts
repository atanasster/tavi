import { expect } from "vitest";

import { inDays, SEED_ZONE, spanning } from "../support/automation.js";
import { walkGuide } from "../support/walk.js";

interface Agenda {
  readonly items: readonly { readonly kind: string; readonly title: string; readonly at: string }[];
}

/** An event far enough off to be under Later, and one this week. */
const farOff = `${inDays(16)} 10:00`;
const soon = `${inDays(2)} 10:00`;

walkGuide("automation/see-whats-coming-up", {
  configured: true,
  seed: [
    SEED_ZONE,
    ["reminders", "add", "Take your pills", "--repeat", "21:00"],
    ["reminders", "add", "Stretch", "--repeat", "10:00,15:00", "--days", "mon-fri"],
    ["reminders", "add", "Dentist appointment", "--event", soon],
    ["reminders", "add", "Car service", "--event", farOff],
    [
      ...["schedules", "add", "--name", "morning-brief", "--at", "07:30", "--days", "1,2,3,4,5"],
      ...["--timezone", "Europe/London", "--prompt", "Give me one short motivational quote for the day.", "--deliver-to", "home"],
    ],
  ],
  steps: {
    "list-the-week-in-the-terminal": async (walk) => {
      const items = walk.taviJson<Agenda>("schedules", "agenda").items;
      expect(new Set(items.map((item) => item.kind))).toEqual(new Set(["reminder", "schedule"]));
      // The far-off event is not in the week; the one in two days is.
      expect(items.some((item) => item.title === "Car service")).toBe(false);
      expect(items.some((item) => item.title === "Dentist appointment")).toBe(true);
      const screen = await walk.terminal({
        title: "tavi schedules agenda",
        args: ["schedules", "agenda", "--limit", "12"],
        cols: 150,
        lines: 16,
      });
      expect(screen.join("\n")).toContain("morning-brief");
    },
    "open-coming-up-in-the-canvas": async (walk) => {
      const page = await walk.open("/center/schedule");
      const heading = page.getByRole("heading", { name: /^Coming up/ });
      await heading.waitFor();
      await page.locator("section.schedule-day").first().waitFor();
      // The heading and the first two days, as a reader sees them on opening the section.
      const days = page.locator("section.schedule-day");
      await expect(days.count()).resolves.toBeGreaterThanOrEqual(2);
      await page.setViewportSize({ width: 1280, height: 1000 });
      await heading.scrollIntoViewIfNeeded();
      await walk.shot();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "narrow-the-repeating-ones": async (walk) => {
      const page = await walk.page();
      const chips = page.getByRole("group", { name: "Show" });
      await chips.getByRole("button", { name: /^Reminders/ }).click();
      const list = page.locator(".schedule-recurring-list").first();
      await list.getByText("Take your pills").waitFor();
      await expect(list.getByText("morning-brief").count()).resolves.toBe(0);
      const head = page.locator(".schedule-recurring-head");
      await head.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const span = await spanning(page, head, list);
      await walk.shot(span.box);
      await span.remove();
    },
    "see-what-s-further-off": async (walk) => {
      const page = await walk.page();
      const later = page.getByRole("heading", { name: /^Later/ });
      await later.waitFor();
      const list = later.locator("xpath=following-sibling::ul[1]");
      await list.getByText("Car service").waitFor();
      await later.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const span = await spanning(page, later, list);
      await walk.shot(span.box);
      await span.remove();
    },
    "check-from-the-terminal-chat": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [{ wait: 4 }, { text: "/schedules", wait: 1 }, { text: "\r" }, { until: "morning-brief", wait: 15 }],
        lines: 16,
      });
      expect(screen.join("\n")).toContain("morning-brief");
    },
  },
});
