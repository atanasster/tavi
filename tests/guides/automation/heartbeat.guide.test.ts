import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { SEED_ZONE, spanning } from "../support/automation.js";
import { walkGuide } from "../support/walk.js";

interface Status {
  readonly config: {
    readonly enabled: boolean;
    readonly instructions: string;
    readonly activeHours: { readonly start: string; readonly end: string };
    readonly daysOfWeek?: readonly number[];
    readonly tellMe: string;
    readonly paused?: { readonly reason: string; readonly until?: string };
  };
}
interface Log {
  readonly ticks: readonly { readonly outcome: string; readonly wakeReason: string }[];
}

const heartbeat = (page: Page) => page.getByRole("region", { name: "Heartbeat", exact: true });

walkGuide("automation/heartbeat", {
  configured: true,
  model: true,
  seed: [[...SEED_ZONE]],
  steps: {
    "turn-it-on": async (walk) => {
      const page = await walk.open("/center/heartbeat");
      const region = heartbeat(page);
      await region.getByRole("switch", { name: "Heartbeat" }).click();
      await expect.poll(() => walk.taviJson<Status>("heartbeat", "status").config.enabled, { timeout: 15_000 }).toBe(true);
      await expect.poll(() => region.getByRole("button", { name: "Check now" }).isEnabled(), { timeout: 15_000 }).toBe(true);
      const span = await spanning(page, region.getByRole("heading", { name: "Heartbeat", level: 1 }), region.getByText(/^Last check/));
      await walk.shot(span.box);
      await span.remove();
    },
    "tell-it-what-to-keep-an-eye-on": async (walk) => {
      const page = await walk.page();
      const region = page.getByRole("region", { name: "What should I keep an eye on?" });
      for (const line of ["Approvals or questions waiting more than an hour", "Scheduled runs that fail"]) {
        await region.getByRole("button", { name: `+ ${line}` }).click();
        await region.getByRole("listitem").filter({ hasText: line }).first().waitFor();
      }
      await expect
        .poll(
          () =>
            walk
              .taviJson<Status>("heartbeat", "status")
              .config.instructions.split("\n")
              .filter((line) => line.trim() !== "").length,
          {
            timeout: 15_000,
          },
        )
        .toBe(2);
      await walk.shot(region);
    },
    "set-its-quiet-hours": async (walk) => {
      const page = await walk.page();
      const region = page.getByRole("region", { name: "When and how" });
      await region.getByRole("textbox", { name: "Active from" }).fill("08:30");
      await region.getByRole("textbox", { name: "to", exact: true }).fill("19:00");
      await region.getByRole("button", { name: "Weekdays" }).click();
      await expect
        .poll(
          () => {
            const { activeHours, daysOfWeek } = walk.taviJson<Status>("heartbeat", "status").config;
            return { ...activeHours, daysOfWeek };
          },
          { timeout: 15_000 },
        )
        .toEqual({ start: "08:30", end: "19:00", daysOfWeek: [1, 2, 3, 4, 5] });
      await region.getByRole("group", { name: "Days", exact: true }).scrollIntoViewIfNeeded();
      const span = await spanning(
        page,
        region.getByRole("heading", { name: "When and how" }),
        region.getByRole("group", { name: "Days", exact: true }),
      );
      await walk.shot(span.box);
      await span.remove();
    },
    "choose-how-it-nudges-you": async (walk) => {
      const page = await walk.page();
      const region = page.getByRole("region", { name: "When and how" });
      await region.getByRole("radio", { name: "Only the summary when your next window opens" }).click();
      await expect.poll(() => walk.taviJson<Status>("heartbeat", "status").config.tellMe, { timeout: 15_000 }).toBe("digest-only");
      const where = region.getByRole("group", { name: "Where" });
      await where.scrollIntoViewIfNeeded();
      const span = await spanning(page, region.getByRole("group", { name: "Tell me" }), where);
      await walk.shot(span.box);
      await span.remove();
    },
    "check-now-and-read-the-log": async (walk) => {
      const page = await walk.page();
      await heartbeat(page).getByRole("button", { name: "Check now" }).click();
      // The check is one short turn on the fast model; the page reads the heartbeat again every couple of seconds.
      await expect
        .poll(() => walk.taviJson<Log>("heartbeat", "log").ticks.filter((tick) => tick.wakeReason === "manual").length, {
          timeout: 180_000,
          interval: 2_000,
        })
        .toBe(1);
      const log = page.getByRole("region", { name: "Log" });
      await log.getByRole("listitem").first().waitFor({ timeout: 30_000 });
      await log.scrollIntoViewIfNeeded();
      await walk.shot(log);
    },
    "pause-it-from-a-chat": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [{ wait: 4 }, { text: "/heartbeat pause 2h", wait: 1 }, { text: "\r" }, { until: "[Pp]aused", wait: 30 }],
      });
      expect(screen.join("\n")).toMatch(/paused/i);
      const status = walk.taviJson<Status>("heartbeat", "status");
      expect(status.config.enabled).toBe(true);
      expect(status.config.paused?.until).toBeDefined();
    },
  },
});
