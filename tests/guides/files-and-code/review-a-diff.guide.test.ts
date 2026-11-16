import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { homeId, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

interface Pending {
  readonly rows: readonly { readonly record: { readonly taskId: string; readonly toolId: string } }[];
}

/** Home, where the walk's plan.md is. */
let home = "";

const plan = (dataDir: string): string => readFileSync(join(dataDir, "chats/default", home, "plan.md"), "utf8");

/** The newest approval card, once its decision buttons are there. */
async function card(page: Page): Promise<Locator> {
  await page.getByText("Needs your approval").last().waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Allow once" }).last().waitFor();
  return page.locator("section.round").last();
}

/** Opens the card's Details and shows the diff to its end: the box scrolls, and the change is at its bottom. */
async function openDiff(page: Page, round: Locator): Promise<Locator> {
  await round.getByText("Details", { exact: true }).click();
  const diff = round.locator(".call-command").first();
  await diff.waitFor();
  // The open card is taller than the space above the message box: a taller window shows all of it.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await diff.evaluate((box) => {
    box.scrollTop = box.scrollHeight;
  });
  await round.scrollIntoViewIfNeeded();
  return diff;
}

/** Until the chat's turn has ended: its header says ready (Home) or completed (any other chat). */
async function finished(page: Page): Promise<void> {
  await page
    .locator("main .task-header")
    .getByText(/^(ready|completed)$/)
    .first()
    .waitFor({ timeout: 180_000 });
}

walkGuide("files-and-code/review-a-diff", {
  configured: true,
  model: true,
  steps: {
    "ask-for-a-change": async (walk) => {
      // The file the guide starts from, written in Home as a reader would have asked for it.
      walk.tavi(
        "run",
        "--home",
        "--approval",
        "approve",
        "Write a file called plan.md in this chat's folder with three lines: Monday: gym, Tuesday: swim, Wednesday: rest.",
      );
      home = homeId(walk.tavi);
      expect(plan(walk.dataDir)).toContain("Tuesday: swim");
      const page = await walk.open(`/tasks/${home}`);
      const composer = page.locator(".composer-box textarea");
      await composer.fill("In plan.md, change Tuesday: swim to Tuesday: run.");
      await composer.press("Enter");
      const round = await card(page);
      expect(walk.taviJson<Pending>("approvals", "list").rows.map((row) => row.record.toolId)).toEqual(["fs.edit"]);
      await walk.shot(round);
    },
    "read-the-diff": async (walk) => {
      const page = await walk.page();
      const round = page.locator("section.round").last();
      const diff = await openDiff(page, round);
      await expect(diff.textContent()).resolves.toMatch(/-Tuesday: swim\n\+Tuesday: run/);
      // Nothing is written while the card waits.
      expect(plan(walk.dataDir)).toContain("Tuesday: swim");
      await walk.shot(round);
    },
    "deny-a-wrong-change-with-a-reason": async (walk) => {
      const page = await walk.page();
      const round = page.locator("section.round").last();
      await round.getByRole("button", { name: "Deny…" }).click();
      await round.getByLabel(/Why deny/).fill("Not run: make Tuesday yoga instead.");
      await walk.shot(round);
      await round.getByRole("button", { name: "Deny", exact: true }).click();
      await expect.poll(() => walk.taviJson<History>("approvals", "history").items.some((item) => item["state"] === "denied")).toBe(true);
      expect(plan(walk.dataDir)).toContain("Tuesday: swim");
    },
    "allow-the-right-one": async (walk) => {
      const page = await walk.page();
      await page.setViewportSize({ width: 1280, height: 800 });
      // The model reads the reason and proposes the change again; if it only answers, it is asked once more.
      const next = await card(page).catch(async () => {
        const composer = page.locator(".composer-box textarea");
        await composer.fill("Change Tuesday: swim to Tuesday: yoga in plan.md.");
        await composer.press("Enter");
        return card(page);
      });
      const diff = await openDiff(page, next);
      await expect(diff.textContent()).resolves.toMatch(/\+Tuesday: yoga/);
      await walk.shot(next);
      await next.getByRole("button", { name: "Allow once" }).click();
      await finished(page);
      expect(plan(walk.dataDir)).toContain("Tuesday: yoga");
    },
    "see-what-was-changed": async (walk) => {
      const page = await walk.open(`/tasks/${home}`);
      const call = page.locator("main .tools").filter({ hasText: "fs.edit" }).last();
      await call.getByText("fs.edit", { exact: true }).click();
      await call.getByText('"replaced": 1').waitFor();
      await call.scrollIntoViewIfNeeded();
      await walk.shot(call);
    },
    "check-a-change-from-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        cols: 140,
        input: [
          { wait: 5 },
          { text: "In plan.md, change Wednesday: rest to Wednesday: walk.", wait: 1 },
          { text: "\r" },
          { until: "needs approval:[^⏸]*fs\\.edit", wait: 180 },
          { wait: 2 },
        ],
      });
      expect(screen.join("\n")).toMatch(/Edit plan\.md/);
      // The live card shows the diff's first lines; the call's full input is in approvals show.
      expect(screen.join("\n")).toMatch(/-Wednesday: rest[\s\S]*\+Wednesday: walk/);
      const shown = walk.tavi("approvals", "show", home);
      expect(shown).toContain("Wednesday: walk");
      expect(plan(walk.dataDir)).toContain("Wednesday: rest");
    },
  },
});

interface History {
  readonly items: readonly Record<string, unknown>[];
}
