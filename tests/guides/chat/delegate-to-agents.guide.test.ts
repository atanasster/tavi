import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { type Chat, chats, homeId, showChats } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const PERSONA = "You look things up and answer in three short bullets, from what you already know. Never use the browser or the web.";
const REQUEST =
  "Start a background worker with the researcher agent to list three things to pack for Lisbon in October, and tell me once it has started.";
/** Said once more when the model answered itself instead of starting the worker. */
const AGAIN = "Please start it as a background worker with the researcher agent rather than answering yourself.";

/** The worker a chat started, once there is one. */
const worker = (tavi: (...args: string[]) => string): Chat | undefined => chats(tavi).find((chat) => chat.chatKind === "worker");

/** How many turns a chat's saved history holds (`tavi tasks history`). */
const turns = (tavi: (...args: string[]) => string, taskId: string): number =>
  (tavi("tasks", "history", taskId).match(/^#+ Turn \d+/gm) ?? []).length;

/** The chat's answers so far: one Copy response per finished answer. */
const answers = (page: Page) => page.getByRole("button", { name: "Copy response" });
/**
 * Home's recorded turns once the worker's answer is in, at least: those before the worker was allowed, the turn that
 * allowed it, and the answer's own. Counted before Allow once, so a fast worker's answer is never missed.
 */
let homeTurnsWithAnswer = 0;

walkGuide("chat/delegate-to-agents", {
  configured: true,
  model: true,
  steps: {
    "define-an-agent": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi agents add",
        args: [
          "agents",
          "add",
          "researcher",
          "--name",
          "Researcher",
          "--prompt",
          PERSONA,
          "--description",
          "Looks things up and sums them up",
        ],
      });
      expect(screen.join("\n")).toMatch(/researcher\s+Researcher\s+enabled/);
      expect(walk.tavi("agents", "list")).toMatch(/^researcher\s/m);
    },
    "ask-a-chat-to-hand-work-to-it": async (walk) => {
      const page = await walk.open("/");
      await showChats(page);
      const box = page.locator(".composer-box textarea");
      await box.fill(REQUEST);
      await box.press("Enter");
      const card = page.getByText("Start a worker as researcher").first();
      // A model now and then answers itself; asked once more, as a reader would, it starts the worker.
      const asked = await card.waitFor({ timeout: 90_000 }).then(
        () => true,
        () => false,
      );
      if (!asked) {
        await box.fill(AGAIN);
        await box.press("Enter");
        await card.waitFor({ timeout: 120_000 });
      }
      await page.getByRole("button", { name: "Allow once" }).waitFor();
      await card.scrollIntoViewIfNeeded();
      await walk.shot();
    },
    "allow-it": async (walk) => {
      const page = await walk.page();
      // Home's turns before the worker can start: its answer may come back before the walk reaches the last step.
      homeTurnsWithAnswer = turns(walk.tavi, homeId(walk.tavi)) + 2;
      await page.getByRole("button", { name: "Allow once" }).click();
      await expect.poll(() => answers(page).count(), { timeout: 120_000, interval: 1_000 }).toBeGreaterThan(0);
      expect(worker(walk.tavi), "a worker was started").toBeDefined();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "follow-its-tree": async (walk) => {
      const page = await walk.page();
      // The picture shows the worker once it has ended, with its answer, as a reader who comes back to it sees it.
      await expect.poll(() => worker(walk.tavi)?.status, { timeout: 180_000, interval: 2_000 }).toBe("completed");
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      const row = page.getByRole("button", { name: /^researcher — task-/ });
      const completed = page.getByRole("button", { name: /^Completed \(\d+\)$/ });
      await expect.poll(async () => (await row.count()) + (await completed.count()), { timeout: 60_000 }).toBeGreaterThan(0);
      if ((await row.count()) === 0) await completed.click();
      await row.first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("main").getByText(/^Here|^-|^\*|^1\./)] });
    },
    "open-the-worker": async (walk) => {
      const page = await walk.page();
      await page
        .getByRole("button", { name: /^researcher — task-/ })
        .first()
        .click();
      await page.getByText("Worker researcher — view only").waitFor();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "read-its-answer": async (walk) => {
      const before = await walk.page();
      await before.getByRole("button", { name: "Close", exact: true }).click();
      await before.getByRole("button", { name: "Transcript", exact: true }).click();
      // The worker's answer gives the chat a turn of its own: the owner records it, and the open page shows it as it
      // happens, with no reload.
      const home = homeId(walk.tavi);
      await expect.poll(() => turns(walk.tavi, home), { timeout: 180_000, interval: 2_000 }).toBeGreaterThanOrEqual(homeTurnsWithAnswer);
      const page = before;
      await expect.poll(() => answers(page).count(), { timeout: 60_000 }).toBeGreaterThan(1);
      await answers(page).last().scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
  },
});
