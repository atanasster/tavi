import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../support/automation.js";
import { allowOnce, askForApproval, dismissChecklist } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Schedule {
  readonly name: string;
  readonly enabled: boolean;
  readonly spec: { readonly at?: string; readonly daysOfWeek?: readonly number[] };
}
interface Pending {
  readonly rows: readonly { readonly record: { readonly toolId: string } }[];
}

type Walk = { taviJson<T>(...args: string[]): T };
const focusTip = (walk: Walk): Schedule | undefined =>
  walk.taviJson<readonly Schedule[]>("schedules", "list").find((schedule) => schedule.name === "focus-tip");
const waiting = (walk: Walk): string[] => walk.taviJson<Pending>("approvals", "list").rows.map((row) => row.record.toolId);

/** Asks in Home and waits for the card for `tool`: the model may read the schedules first, which never asks. */
async function askFor(page: Page, walk: Walk, text: string, tool: string): Promise<void> {
  await askForApproval(page, text);
  expect(waiting(walk)).toEqual([tool]);
}

const card = (page: Page) => page.locator("section.round").last();

/** The waiting card with its **Details** open, where it says when the schedule runs and what it does. */
async function shotDetails(page: Page, walk: { shot(target?: ReturnType<Page["locator"]>): Promise<void> }): Promise<void> {
  const round = card(page);
  await round.getByText("Details", { exact: true }).click();
  // The open card is taller than the space above the message box: a taller window shows all of it.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await round.scrollIntoViewIfNeeded();
  await expect(round.textContent()).resolves.toContain("focus-tip");
  await walk.shot(round);
  await page.setViewportSize({ width: 1280, height: 800 });
}

walkGuide("automation/manage-schedules-by-chatting", {
  configured: true,
  model: true,
  seed: [[...SEED_ZONE]],
  steps: {
    "ask-for-a-schedule": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await askFor(
        page,
        walk,
        "Every weekday at 8:00, give me one short tip for staying focused at work. Call it focus-tip.",
        "schedules.create",
      );
      await shotDetails(page, walk);
      await allowOnce(page);
      expect(focusTip(walk)).toMatchObject({ enabled: true, spec: { at: "08:00", daysOfWeek: [1, 2, 3, 4, 5] } });
    },
    "change-when-it-runs": async (walk) => {
      const page = await walk.page();
      await askFor(page, walk, "Move focus-tip to 7:30.", "schedules.update");
      await shotDetails(page, walk);
      await allowOnce(page);
      // Only the time moved: the days are kept.
      expect(focusTip(walk)).toMatchObject({ enabled: true, spec: { at: "07:30", daysOfWeek: [1, 2, 3, 4, 5] } });
    },
    "pause-it": async (walk) => {
      const page = await walk.page();
      await askFor(page, walk, "Pause focus-tip.", "schedules.pause");
      await allowOnce(page);
      expect(focusTip(walk)?.enabled).toBe(false);
      const screen = await walk.terminal({ title: "tavi schedules list", args: ["schedules", "list"], cols: 160 });
      expect(screen.join("\n")).toMatch(/focus-tip.*disabled/);
    },
    "cancel-it": async (walk) => {
      const page = await walk.page();
      await askFor(page, walk, "Cancel focus-tip.", "schedules.cancel");
      await shotDetails(page, walk);
      await allowOnce(page);
      expect(focusTip(walk)).toBeUndefined();
    },
  },
});
