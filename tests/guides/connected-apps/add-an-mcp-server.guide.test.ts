import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { addNotes, notesApp, notesHome, openNotesReview, toolStates } from "../support/mcp.js";
import { newChat } from "../support/browser-site.js";
import { allowOnce, askForApproval, chats, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Pending {
  readonly rows: readonly { readonly record: { readonly toolId: string } }[];
}

const logs = (walk: { tavi(...args: string[]): string }) => walk.tavi("mcp", "logs", "mcp.notes", "--lines", "60");

walkGuide("connected-apps/add-an-mcp-server", {
  configured: true,
  model: true,
  steps: {
    "add-the-server": async (walk) => {
      expect(addNotes(walk.dataDir)).toMatch(/added mcp\.notes@1\.0\.0 \(proposed\)/);
      // The picture is the review the add printed, as `tavi mcp show` prints it again.
      const screen = await walk.terminal({ title: "tavi mcp show mcp.notes", args: ["mcp", "show", "mcp.notes"] });
      expect(screen.join("\n")).toMatch(/sandbox: srt/);
      expect(toolStates(walk)).toEqual({ add_note: "pending", list_notes: "pending", read_note: "pending" });
    },
    "review-its-tools": async (walk) => {
      const page = await notesApp(walk);
      await page.setViewportSize({ width: 1280, height: 1000 });
      const dialog = await openNotesReview(page);
      await walk.shot(dialog);
    },
    "approve-it": async (walk) => {
      const page = await walk.page();
      await page.getByRole("dialog").getByRole("button", { name: "Approve 1.0.0" }).click();
      const turnOn = page.getByRole("button", { name: "Turn notes on" }).first();
      await turnOn.waitFor();
      expect(toolStates(walk)).toEqual({ add_note: "approved", list_notes: "approved", read_note: "approved" });
      await walk.shot(page.locator("header.apps-head"));
    },
    "turn-it-on": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Turn notes on" }).first().click();
      const section = page.getByRole("region", { name: "What it can do" });
      await page.getByText("Used in your chats in default.").waitFor();
      expect(walk.tavi("config", "get", "mcp.servers")).toContain("mcp.notes");
      await section.scrollIntoViewIfNeeded();
      await walk.shot(section);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "ask-about-your-notes": async (walk) => {
      const home = await walk.open("/");
      await newChat(home);
      await send(home, "Use my notes server: what does the plumber note say?");
      expect(logs(walk)).toMatch(/read_note/);
      // The chat opened afresh, as a reader comes back to it.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home")?.taskId ?? "";
      const page = await walk.open(`/tasks/${chat}`);
      await page
        .getByRole("button", { name: /^Copy response/ })
        .first()
        .waitFor();
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "approve-a-change-it-makes": async (walk) => {
      const page = await walk.page();
      await askForApproval(page, "Add a note called milk to my notes server: buy oat milk.");
      const pending = walk.taviJson<Pending>("approvals", "list").rows;
      expect(pending.map((row) => row.record.toolId)).toEqual(["mcp.notes.add_note"]);
      const card = page.locator("section.round").last();
      await walk.shot(card);
      await allowOnce(page);
      // The note is in the server's own home: the one folder its sandbox lets it write.
      expect(readFileSync(join(notesHome(walk.dataDir), "notes.json"), "utf8")).toMatch(/milk/);
    },
    "read-its-log": async (walk) => {
      const screen = await walk.terminal({ title: "tavi mcp logs", args: ["mcp", "logs", "mcp.notes", "--lines", "14"] });
      expect(screen.join("\n")).toMatch(/add_note/);
    },
  },
});
