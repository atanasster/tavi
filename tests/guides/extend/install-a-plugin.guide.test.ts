import { expect } from "vitest";

import { plugin, ready, toolsCalled } from "../support/extend.js";
import { chats, dismissChecklist, restartOwner, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const ID = "acme.units";

walkGuide("extend/install-a-plugin", {
  configured: true,
  model: true,
  steps: {
    "install-the-folder": async (walk) => {
      // The terminal runs at the repository's root, as the reader's copy of it.
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", "examples/plugins/acme-units"] });
      expect(screen.join("\n")).toContain("installed acme.units@0.1.0 (proposed)");
      expect(plugin(walk, ID)?.versions).toEqual([expect.objectContaining({ version: "0.1.0", reviewState: "proposed" })]);
    },
    "read-what-it-declares": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins show", args: ["plugins", "show", ID] });
      expect(screen.join("\n")).toMatch(/acme\.units\.convert\s+read-only/);
    },
    "approve-and-enable-it": async (walk) => {
      const page = await walk.open("/settings/plugins");
      const row = page.locator(`[id="plugin-row-${ID}"]`);
      await row.getByText("awaits review", { exact: true }).waitFor();
      await walk.shot(row);
      await row.getByRole("button", { name: `Approve 0.1.0 of ${ID}`, exact: true }).click();
      await expect.poll(() => plugin(walk, ID)?.versions[0]?.reviewState, { timeout: 15_000 }).toBe("approved");
      await row.getByRole("button", { name: `Enable ${ID}` }).click();
      await expect.poll(() => plugin(walk, ID)?.enabled, { timeout: 15_000 }).toBe(true);
    },
    "restart-tavi": async (walk) => {
      await restartOwner(walk.dataDir, []);
      await ready(walk, ID);
      const screen = await walk.terminal({ title: "tavi plugins show", args: ["plugins", "show", ID] });
      expect(screen.join("\n")).toContain("ready in the running owner");
    },
    "use-it-in-a-chat": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page
        .getByRole("button", { name: /^New (side )?chat$/ })
        .first()
        .click();
      await send(page, "How many miles is 42 km? Use the unit converter.");
      const taskId = chats(walk.tavi).find((chat) => chat.chatKind !== "home")?.taskId ?? "";
      expect(toolsCalled(walk, taskId)).toContain("acme.units.convert");
      // Read-only: nothing waited on you.
      expect(walk.taviJson<{ rows: readonly unknown[] }>("approvals", "list").rows).toEqual([]);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "turn-it-off-or-remove-it": async (walk) => {
      const page = await walk.open("/settings/plugins");
      const row = page.locator(`[id="plugin-row-${ID}"]`);
      await row.getByRole("button", { name: `Disable ${ID}` }).click();
      await expect.poll(() => plugin(walk, ID)?.enabled, { timeout: 15_000 }).toBe(false);
      await row.getByRole("button", { name: `Remove ${ID}` }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Remove", exact: true }).waitFor();
      await walk.shot(dialog);
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect.poll(() => plugin(walk, ID), { timeout: 15_000 }).toBeUndefined();
    },
  },
});
