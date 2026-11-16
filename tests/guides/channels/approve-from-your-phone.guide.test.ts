import { expect } from "vitest";

import { SEED_ZONE } from "../support/automation.js";
import { PLACEHOLDER_NAME, addBot, askToSend, pairByCode, telegram } from "../support/telegram.js";
import { askUser } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const SLUG = "channels/approve-from-your-phone";

type Walk = { taviJson<T>(...args: string[]): T };
interface Pending {
  readonly rows: readonly {
    readonly record: { readonly taskId: string; readonly toolId: string };
  }[];
}
interface Decision {
  readonly toolId?: string;
  readonly state: string;
  readonly via?: string;
  readonly scope?: string;
  readonly note?: string | null;
}
interface Schedule {
  readonly name: string;
  readonly spec: { readonly at?: string };
}

const waiting = (walk: Walk) => walk.taviJson<Pending>("approvals", "list").rows.map((row) => row.record);
const decided = (walk: Walk, tool: string) =>
  walk.taviJson<{ items: readonly Decision[] }>("approvals", "history").items.find((item) => item.toolId === tool);
const focusTip = (walk: Walk) => walk.taviJson<readonly Schedule[]>("schedules", "list").find((schedule) => schedule.name === "focus-tip");

/** Until the chat from Telegram waits on a card for `tool`: the model may read the schedules first, which never asks. */
async function cardFor(walk: Walk, tool: string): Promise<string> {
  await expect.poll(() => waiting(walk).map((row) => row.toolId), { timeout: 180_000, interval: 2_000 }).toEqual([tool]);
  return waiting(walk)[0]?.taskId as string;
}

walkGuide(SLUG, {
  configured: true,
  model: true,
  seed: [[...SEED_ZONE]],
  timeoutMs: 30 * 60_000,
  steps: {
    "ask-for-something-from-your-phone": async (walk) => {
      // Where the page starts: the person's bot, paired to them (Connect a Telegram bot), under the guides' name.
      await addBot(walk);
      await pairByCode(walk, SLUG, { name: PLACEHOLDER_NAME });
      await askToSend(walk, SLUG, "Every weekday at 8:00, send me one short tip for staying focused. Call it focus-tip.");
      const taskId = await cardFor(walk, "schedules.create");
      // The conversation in the canvas draws the same card, waiting.
      const page = await walk.open(`/tasks/${taskId}`);
      const card = page.locator("section.round").last();
      await card.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 30_000 });
      await walk.shot();
    },
    "approve-it-with-a-button": async (walk) => {
      const connection = telegram(walk).connectionId;
      await askUser(SLUG, "In Telegram, tap Once under the focus-tip card", () => decided(walk, "schedules.create") !== undefined);
      // Decided from Telegram, once, and the schedule saved as asked.
      expect(decided(walk, "schedules.create")).toMatchObject({ state: "granted", via: connection, scope: "once" });
      await expect.poll(() => focusTip(walk)?.spec.at, { timeout: 60_000 }).toBe("08:00");
      const page = await walk.open("/center/approvals");
      await page.getByRole("heading", { name: "History" }).waitFor();
      const row = page.getByRole("row").filter({ hasText: "schedules.create" }).first();
      await row.waitFor();
      await walk.shot(page.getByRole("table").first());
    },
    "deny-one-with-a-reason": async (walk) => {
      const connection = telegram(walk).connectionId;
      await askToSend(walk, SLUG, "Move focus-tip to 7:30.");
      await cardFor(walk, "schedules.update");
      await askUser(
        SLUG,
        "In Telegram, tap Deny under the focus-tip card, then send: keep it at 8",
        () => decided(walk, "schedules.update") !== undefined,
      );
      expect(decided(walk, "schedules.update")).toMatchObject({ state: "denied", via: connection });
      expect(decided(walk, "schedules.update")?.note ?? "").toMatch(/keep it at 8/i);
      const screen = await walk.terminal({ title: "tavi approvals history", args: ["approvals", "history", "--limit", "2"], cols: 140 });
      expect(screen.join("\n")).toMatch(/schedules\.update/);
    },
    "check-what-was-decided": async (walk) => {
      // The denied move changed nothing.
      expect(focusTip(walk)?.spec.at).toBe("08:00");
      const screen = await walk.terminal({ title: "tavi schedules list", args: ["schedules", "list"], cols: 160 });
      expect(screen.join("\n")).toMatch(/focus-tip/);
    },
  },
});
