import { expect } from "vitest";

import { inDays, SEED_ZONE, spanning } from "../support/automation.js";
import { chats, dismissChecklist, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Schedule {
  readonly name: string;
  readonly enabled: boolean;
  readonly spec: { readonly at?: string; readonly daysOfWeek?: readonly number[] };
  readonly autoApproveTools: readonly string[];
  readonly deliverTo?: string;
  readonly nextRunAt?: string | null;
}

type Walk = { taviJson<T>(...args: string[]): T };
const digest = (walk: Walk): Schedule | undefined =>
  walk.taviJson<readonly Schedule[]>("schedules", "list").find((schedule) => schedule.name === "todo-digest");

const QUESTION = "What's on my to-do list? Answer in one short line.";

walkGuide("automation/repeat-this", {
  configured: true,
  model: true,
  // A few to-dos for the chat to read.
  seed: [
    [...SEED_ZONE],
    ["todos", "add", "Buy milk", "--list", "groceries"],
    ["todos", "add", "Renew the car insurance", "--due", inDays(10)],
  ],
  steps: {
    "ask-something-that-works": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page
        .getByRole("button", { name: /^New (side )?chat$/ })
        .first()
        .click();
      await dismissChecklist(page);
      await send(page, QUESTION);
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("todos.list");
      await page.getByText("todos.list").first().waitFor();
      // The setup checklist shows again above a new chat's transcript: dismissed, as a reader past Welcome has it.
      await dismissChecklist(page);
      await expect.poll(() => page.getByRole("region", { name: /Setup checklist/ }).count(), { timeout: 10_000 }).toBe(0);
      await walk.shot(undefined, { mask: [page.locator("main article .text")] });
    },
    "choose-repeat-this": async (walk) => {
      const page = await walk.page();
      const message = page.locator("article").filter({ hasText: QUESTION }).first();
      await message.hover();
      await message.getByRole("button", { name: "Repeat this…" }).click();
      const dialog = page.getByRole("dialog", { name: "Create schedule" });
      // Filled from the chat: the prompt, and the read-only tool it used.
      await expect.poll(() => dialog.getByRole("textbox", { name: "Schedule prompt" }).inputValue(), { timeout: 15_000 }).toBe(QUESTION);
      await dialog.getByRole("button", { name: "Remove tool todos.list" }).waitFor();
      await dialog.locator(".cadence-preview ol li").nth(2).waitFor();
      // The form is taller than the window: a tall one shows it from the top down to its tools, and to where the
      // result goes for the next step.
      await page.setViewportSize({ width: 1280, height: 2000 });
      const span = await spanning(
        page,
        dialog.getByText("Filled in from this chat"),
        dialog.getByRole("button", { name: "Remove tool todos.list" }),
      );
      await walk.shot(span.box);
      await span.remove();
    },
    "say-when-and-where-it-goes": async (walk) => {
      const page = await walk.page();
      const dialog = page.getByRole("dialog", { name: "Create schedule" });
      await dialog.getByRole("textbox", { name: "Schedule name" }).fill("todo-digest");
      await dialog.getByRole("button", { name: "Weekdays" }).click();
      await dialog.getByRole("textbox", { name: "Time", exact: true }).fill("08:00");
      await dialog.getByRole("combobox", { name: "Deliver result to" }).click();
      await page.getByRole("option", { name: "Home" }).click();
      await expect(dialog.getByRole("combobox", { name: "Deliver result to" }).textContent()).resolves.toContain("Home");
      await expect.poll(() => dialog.locator(".cadence-preview ol li").first().textContent(), { timeout: 15_000 }).toMatch(/08:00/);
      // The picture: the name, When with its preview, down to where the result goes.
      const span = await spanning(
        page,
        dialog.getByRole("textbox", { name: "Schedule name" }),
        dialog.getByRole("combobox", { name: "Deliver result to" }),
      );
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "save-it": async (walk) => {
      const page = await walk.page();
      const dialog = page.getByRole("dialog", { name: "Create schedule" });
      await dialog.getByRole("button", { name: "Save schedule" }).click();
      await dialog.waitFor({ state: "detached", timeout: 30_000 });
      expect(digest(walk)).toMatchObject({
        enabled: true,
        spec: { at: "08:00", daysOfWeek: [1, 2, 3, 4, 5] },
        autoApproveTools: ["todos.list"],
        deliverTo: "home",
      });
      const message = page.locator("article").filter({ hasText: QUESTION }).first();
      await message
        .getByText(/todo-digest/)
        .first()
        .waitFor({ timeout: 15_000 });
      await message.hover();
      await walk.shot(message);
    },
    "try-a-run-now": async (walk) => {
      const before = digest(walk)?.nextRunAt;
      const screen = await walk.terminal({ title: "tavi schedules run-now", args: ["schedules", "run-now", "todo-digest"] });
      expect(screen.join("\n")).toMatch(/milk|insurance/i);
      // A run now leaves the schedule's next run where it was.
      expect(digest(walk)?.nextRunAt).toBe(before);
    },
  },
});
