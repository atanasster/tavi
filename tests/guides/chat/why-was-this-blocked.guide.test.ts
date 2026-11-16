import { expect } from "vitest";

import { allowOnce, chats, dismissChecklist } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Pending {
  readonly rows: readonly { readonly record: { readonly toolId: string }; readonly allowedScopes?: readonly string[] }[];
}
interface Reminders {
  readonly reminders: readonly unknown[];
}

/** The side chat that read the web. */
let chat = "";

walkGuide("chat/why-was-this-blocked", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "let-a-chat-read-the-web": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 6 },
          { text: "/side Search the web for the opening hours of the British Museum, in one sentence.", wait: 1 },
          { text: "\r" },
          { until: "Done\\.", wait: 180 },
        ],
      });
      const text = screen.join("\n");
      expect(text).toContain("web_search");
      // A finished turn says only Done: the side chat is the one chat besides Home.
      chat = chats(walk.tavi).find((row) => row.chatKind !== "home")?.taskId ?? "";
      expect(chat).not.toBe("");
    },
    "ask-for-something-that-lasts": async (walk) => {
      // The reader is still in the side chat; the walk's new terminal follows it again.
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat", "--attach", chat],
        tty: true,
        input: [
          { wait: 6 },
          { text: "Set a reminder for tomorrow at 9:00 to visit the British Museum.", wait: 1 },
          { text: "\r" },
          { until: "y approves it, n rejects", wait: 180 },
          { wait: 2 },
          { text: "/taint", wait: 1 },
          { text: "\r" },
          { until: "does not trust:", wait: 30 },
          { wait: 2 },
        ],
      });
      const text = screen.join("\n");
      expect(text).toContain("Why am I asked?");
      expect(text).toMatch(/does not trust:\s+search results/);
      const pending = walk.taviJson<Pending>("approvals", "list").rows;
      expect(pending.map((row) => row.record.toolId)).toEqual(["reminders.create"]);
      expect(pending[0]?.allowedScopes).toEqual(["once"]);
    },
    "spot-it-on-the-canvas": async (walk) => {
      const page = await walk.open(`/tasks/${chat}`);
      await dismissChecklist(page);
      await page.locator(".taint-chip").waitFor();
      const card = page.locator("section.round").last();
      await card.getByText("Why am I asked?").waitFor();
      await expect(card.getByRole("button", { name: "Allow for this chat" }).count()).resolves.toBe(0);
      await card.scrollIntoViewIfNeeded();
      await walk.shot();
      // The chip opens what the chat read under itself, inside the window, and closes again.
      const chip = page.locator(".taint-chip");
      await chip.click();
      const panel = page.locator(".taint-panel");
      await panel.waitFor();
      const [chipBox, panelBox] = [await chip.boundingBox(), await panel.boundingBox()];
      const width = page.viewportSize()?.width ?? 0;
      expect(panelBox !== null && chipBox !== null && panelBox.y >= chipBox.y + chipBox.height - 1).toBe(true);
      expect(panelBox !== null && panelBox.x >= 0 && panelBox.x + panelBox.width <= width).toBe(true);
      await chip.click();
      await panel.waitFor({ state: "hidden" });
    },
    "allow-it-once-if-it-is-right": async (walk) => {
      const page = await walk.page();
      await allowOnce(page);
      expect(walk.taviJson<Reminders>("reminders", "list").reminders).toHaveLength(1);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "start-a-clean-chat": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 6 },
          { text: "/home", wait: 1 },
          { text: "\r", wait: 2 },
          { text: "Set a reminder for Friday at 18:00 to call Sam.", wait: 1 },
          { text: "\r" },
          { until: "Done\\.", wait: 180 },
        ],
      });
      // Set without a round: nothing waited on you.
      expect(screen.join("\n")).not.toMatch(/needs approval/);
      expect(walk.taviJson<Reminders>("reminders", "list").reminders).toHaveLength(2);
    },
    "check-the-setting": async (walk) => {
      const page = await walk.open("/settings/permissions");
      const section = page.locator('section[aria-label="untrusted content"]');
      await expect(section.getByLabel("taint mode").textContent()).resolves.toContain("Ask (enforce)");
      expect(walk.tavi("permissions", "taint")).toContain("enforce");
      await walk.shot(section);
    },
  },
});
