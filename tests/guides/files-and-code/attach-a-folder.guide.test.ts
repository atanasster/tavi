import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

/** The reader's `~/code`, made by the walk. */
let code = "";
/** The chat started in `~/code/site`. */
let taskId = "";

/** What `tavi tasks folder` prints for the chat, as the guide shows it. */
const folderOf = (walk: { tavi(...args: string[]): string }): string => walk.tavi("tasks", "folder", taskId);

/** The chat's folder panel, opened from its header's chip: it hangs to the right of the chip, so the window is wide enough to show it whole. */
async function openPanel(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.locator(".folder-chip:visible").last().click();
  await page.locator(".folder-panel").waitFor();
}

walkGuide("files-and-code/attach-a-folder", {
  configured: true,
  model: true,
  steps: {
    "name-the-folders-tavi-may-use": async (walk) => {
      code = projectsFolder("attach-a-folder", {
        "site/README.md": "# Site\n\nThe team's web site.\n",
        "site/index.html": "<h1>Hello</h1>\n",
        "reference/style-guide.md": "# Style guide\n\nShort sentences.\n",
      });
      await restartOwner(walk.dataDir, ["--fs-root", code]);
      // A reader has talked to Home before: the walk starts it with one short message.
      walk.tavi("run", "--home", "Say hello in two words.");
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        // Wide enough that no path is broken across lines.
        cols: 140,
        input: [{ wait: 4 }, { text: "/folder", wait: 1 }, { text: "\r" }, { until: "budget", wait: 15 }],
      });
      expect(screen.join("\n")).toMatch(/code \(read-only\)/);
    },
    "start-a-chat-in-your-project": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", join(code, "site"), "List the files here."],
      });
      expect(screen.join("\n")).toContain("fs.list");
      taskId = chats(walk.tavi).find((chat) => chat.chatKind === "run")?.taskId ?? "";
      expect(taskId).not.toBe("");
      expect(folderOf(walk)).toMatch(/this chat works in \S+\/code\/site\n/);
    },
    "see-where-a-chat-works": async (walk) => {
      const screen = await walk.terminal({ title: "tavi tasks folder", args: ["tasks", "folder", taskId] });
      expect(screen.join("\n")).toMatch(/this chat works in .*site/);
    },
    "attach-a-second-folder": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi tasks folder attach",
        args: ["tasks", "folder", taskId, "attach", join(code, "reference")],
      });
      expect(screen.join("\n")).toMatch(/reference \(read-only\)/);
      expect(folderOf(walk)).toMatch(/reference \(read-only\)/);
    },
    "change-folders-on-the-canvas": async (walk) => {
      const page = await walk.open(`/tasks/${taskId}`);
      await openPanel(page);
      const panel = page.locator(".folder-panel");
      // Read-only becomes read-write: detach the folder, then attach it again read-write.
      await panel.getByRole("button", { name: "Detach reference" }).click();
      await expect.poll(() => folderOf(walk), { timeout: 15_000 }).not.toMatch(/reference \(/);
      await panel.getByRole("button", { name: /^Attach a folder/ }).click();
      await panel.getByRole("button", { name: "Open code" }).click();
      await panel.getByRole("button", { name: "Attach read-write: reference" }).click();
      await expect.poll(() => folderOf(walk), { timeout: 15_000 }).toMatch(/reference \(read-write\)/);
      await panel.getByRole("button", { name: "Detach reference" }).waitFor();
      await walk.shot(panel);
    },
    "go-back-to-chat-files": async (walk) => {
      const page = await walk.page();
      const panel = page.locator(".folder-panel");
      await panel.getByRole("button", { name: "Reset…" }).click();
      await panel.getByText("No file is deleted").waitFor();
      // The picture is the question, before it is answered.
      await walk.shot(panel);
      await panel.getByRole("button", { name: "Reset", exact: true }).click();
      await expect.poll(() => folderOf(walk), { timeout: 15_000 }).toMatch(/works in its own folder/);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
