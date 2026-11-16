import { expect } from "vitest";

import { guideCode, plugin, pluginFolder, ready, validate } from "../support/extend.js";
import { askForApproval, dismissChecklist, restartOwner, turnEnded, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

const ID = "acme.guard";
/** The code the page shows: what the reader saves, and what the walk runs. */
const code = guideCode("extend/write-a-mod");
/** The reader's `~/tavi-plugins/acme-guard`. */
let dir = "";

interface Pending {
  readonly rows: readonly { readonly record: { readonly toolId: string } }[];
}
interface Shown {
  readonly hookActivity?: { readonly recent: readonly { readonly kind: string; readonly event: string; readonly detail: string }[] };
}

walkGuide("extend/write-a-mod", {
  configured: true,
  model: true,
  steps: {
    "write-the-mod": async (walk) => {
      const folder = pluginFolder("write-a-mod", "acme-guard");
      folder.write("json", code.manifest);
      folder.write("js", code.module);
      dir = folder.dir;
      // What the page's code adds is what its manifest declares, with nothing to warn about.
      expect(validate(dir)).toMatchObject({ problems: [], warnings: [], registered: expect.objectContaining({ hookCount: 1 }) });
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", dir] });
      expect(screen.join("\n")).toContain("installed acme.guard@0.1.0 (proposed)");
    },
    "read-what-it-can-see": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins show", args: ["plugins", "show", ID], cols: 160 });
      const text = screen.join("\n");
      expect(text).toContain("Asks before shell commands that delete or overwrite files.");
      expect(text).toMatch(/tool\.check/);
    },
    "approve-and-enable-it": async (walk) => {
      walk.tavi("plugins", "approve", ID, "0.1.0");
      // On a terminal: the restart note goes to standard error.
      const screen = await walk.terminal({ title: "tavi plugins enable", args: ["plugins", "enable", ID], tty: true });
      expect(screen.join("\n")).toContain("acme.guard enabled at 0.1.0");
      await restartOwner(walk.dataDir, []);
      await ready(walk, ID);
    },
    "ask-for-a-destructive-command": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page
        .getByRole("button", { name: /^New (side )?chat$/ })
        .first()
        .click();
      await askForApproval(page, "Use the shell to run: rm -rf build");
      expect(walk.taviJson<Pending>("approvals", "list").rows.map((row) => row.record.toolId)).toEqual(["sandbox.run"]);
      const card = page.locator("section.round").last();
      await card.getByText("acme.guard: This command deletes files recursively.", { exact: false }).waitFor();
      await walk.shot(card);
    },
    "see-what-the-mod-decided": async (walk) => {
      const page = await walk.page();
      const card = page.locator("section.round").last();
      await card.getByRole("button", { name: "Deny…" }).click();
      await card.getByLabel(/Why deny/).fill("Keep the build folder.");
      await card.getByRole("button", { name: "Deny", exact: true }).click();
      await turnEnded(page);
      const recent = walk.taviJson<Shown>("plugins", "show", ID).hookActivity?.recent ?? [];
      expect(recent.some((row) => row.event === "tool.check" && /deletes files recursively/.test(row.detail))).toBe(true);
      await walk.open("/settings/plugins");
      const row = page.locator(`[id="plugin-row-${ID}"]`);
      await row.getByRole("button", { name: `Hook activity for ${ID}` }).click();
      await row.getByRole("list", { name: `Recent hook activity for ${ID}` }).waitFor();
      expect(plugin(walk, ID)?.enabled).toBe(true);
      // The decision's time changes with every walk.
      await walk.shot(row, { mask: [row.getByRole("list", { name: `Recent hook activity for ${ID}` })] });
    },
  },
});
