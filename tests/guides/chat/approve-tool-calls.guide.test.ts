import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { askForApproval as ask, dismissChecklist, turnEnded as finished } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Pending {
  readonly rows: readonly { readonly record: { readonly taskId: string; readonly toolId: string } }[];
}
interface History {
  readonly items: readonly Record<string, unknown>[];
}
interface Rules {
  readonly rules: readonly { readonly ruleId: string; readonly toolPattern: string; readonly decision: string; readonly source: string }[];
}

/** The chat the canvas steps work in, once its first call is waiting. */
let taskId = "";

const history = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<History>("approvals", "history").items;

walkGuide("chat/approve-tool-calls", {
  configured: true,
  model: true,
  steps: {
    "ask-for-a-change": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page
        .getByRole("button", { name: /^New (side )?chat$/ })
        .first()
        .click();
      await ask(page, "Write a file called notes.txt in this chat's folder containing the line: Buy milk.");
      const pending = walk.taviJson<Pending>("approvals", "list").rows;
      expect(pending.map((row) => row.record.toolId)).toEqual(["fs.write"]);
      taskId = pending[0]?.record.taskId ?? "";
      const card = page.locator("section.round").last();
      await expect(card.getByRole("button", { name: "Allow for this chat" }).isVisible()).resolves.toBe(true);
      await walk.shot(card);
    },
    "check-what-it-will-do": async (walk) => {
      const page = await walk.page();
      const card = page.locator("section.round").last();
      await card.getByText("Details", { exact: true }).click();
      await expect(card.locator(".call-command").textContent()).resolves.toContain("Buy milk");
      // Nothing is written while the card waits.
      expect(existsSync(join(walk.dataDir, "chats/default", taskId, "notes.txt"))).toBe(false);
      // The open card is taller than the space above the message box: a taller window shows all of it.
      await page.setViewportSize({ width: 1280, height: 1200 });
      await card.scrollIntoViewIfNeeded();
      await walk.shot(card);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "allow-it-once": async (walk) => {
      const page = await walk.page();
      await page.locator("section.round").last().getByRole("button", { name: "Allow once" }).click();
      await finished(page);
      expect(existsSync(join(walk.dataDir, "chats/default", taskId, "notes.txt"))).toBe(true);
      expect(history(walk).some((item) => item["state"] === "granted" && item["scope"] === "once")).toBe(true);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "allow-it-for-the-rest-of-the-chat": async (walk) => {
      const page = await walk.page();
      await ask(page, "Add a second line to notes.txt: Call the plumber.");
      const card = page.locator("section.round").last();
      // The picture is the card as the reader decides it.
      await walk.shot(card);
      await card.getByRole("button", { name: "Allow for this chat" }).click();
      await finished(page);
      const grants = walk.taviJson<{ grants: readonly { taskId: string }[] }>("permissions", "grants").grants;
      expect(grants.some((grant) => grant.taskId === taskId)).toBe(true);
    },
    "deny-it-with-a-reason": async (walk) => {
      const page = await walk.page();
      await ask(page, "Also write shopping.txt with: Eggs, bread.");
      const card = page.locator("section.round").last();
      await card.getByRole("button", { name: "Deny…" }).click();
      await card.getByLabel(/Why deny/).fill("Not now, I'll do the shopping list myself.");
      await walk.shot(card);
      await card.getByRole("button", { name: "Deny", exact: true }).click();
      await finished(page);
      expect(existsSync(join(walk.dataDir, "chats/default", taskId, "shopping.txt"))).toBe(false);
      expect(history(walk).some((item) => item["state"] === "denied")).toBe(true);
    },
    "decide-in-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 4 },
          { text: "Write a file called todo.txt in this chat's folder containing the line: Water the plants.", wait: 1 },
          { text: "\r" },
          { until: "a always", wait: 180 },
          { text: "a", wait: 2 },
          { until: "Done\\.", wait: 180 },
        ],
      });
      expect(screen.join("\n")).toMatch(/approved/);
      const rules = walk.taviJson<Rules>("permissions", "list").rules;
      expect(rules.some((rule) => rule.source === "operator" && rule.decision === "allow" && rule.toolPattern === "fs.write")).toBe(true);
    },
    "look-back-in-the-command-center": async (walk) => {
      const page = await walk.open("/center/approvals");
      await page.getByRole("heading", { name: "History" }).waitFor();
      await page.getByRole("table").waitFor();
      expect(history(walk).length).toBeGreaterThanOrEqual(4);
      await walk.shot();
    },
    "remove-an-always-allow-rule": async (walk) => {
      const page = await walk.open("/settings/permissions");
      // The rule the terminal's `a` saved: an allow of yours for fs.write (Tavi ships one of yours for reminders too).
      const rule = walk
        .taviJson<Rules>("permissions", "list")
        .rules.find((entry) => entry.source === "operator" && entry.decision === "allow" && entry.toolPattern === "fs.write");
      expect(rule).toBeDefined();
      const row = page.locator(`#rule-${rule?.ruleId}`);
      await row.getByRole("button", { name: "Remove" }).waitFor();
      await row.scrollIntoViewIfNeeded();
      await walk.shot(row);
      await row.getByRole("button", { name: "Remove" }).click();
      await expect
        .poll(() => walk.taviJson<Rules>("permissions", "list").rules.some((entry) => entry.ruleId === rule?.ruleId), { timeout: 15_000 })
        .toBe(false);
    },
  },
});
