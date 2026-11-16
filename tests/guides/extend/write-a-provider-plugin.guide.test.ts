import { expect } from "vitest";

import { guideCode, plugin, pluginFolder, ready, validate } from "../support/extend.js";
import { dismissChecklist, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

const ID = "acme.ideas";
const KEY = "productivity.acme-weekly-review";
/** The code the page shows: what the reader saves, and what the walk runs. */
const code = guideCode("extend/write-a-provider-plugin");

interface Ideas {
  readonly ideas: readonly { readonly key: string; readonly title: string }[];
}

walkGuide("extend/write-a-provider-plugin", {
  // The plugin's ideas need no model: nothing in this walk talks to one.
  configured: true,
  steps: {
    "see-which-provider-is-in-use": async (walk) => {
      const screen = await walk.terminal({ title: "tavi ideas provider", args: ["ideas", "provider"] });
      expect(screen.join("\n")).toMatch(/^\* tavi\.ideasagent/m);
    },
    "write-the-provider": async (walk) => {
      const folder = pluginFolder("write-a-provider-plugin", "acme-ideas");
      folder.write("json", code.manifest);
      folder.write("js", code.module);
      expect(validate(folder.dir)).toMatchObject({ problems: [], registered: expect.objectContaining({ ideas: { generate: true } }) });
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", folder.dir] });
      expect(screen.join("\n")).toContain("installed acme.ideas@0.1.0 (proposed)");
    },
    "approve-it-to-run-in-tavi-s-own-process": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins approve", args: ["plugins", "approve", ID, "0.1.0", "--in-process"] });
      expect(screen.join("\n")).toContain("runs UNSANDBOXED in the owner's process");
      walk.tavi("plugins", "enable", ID);
      await restartOwner(walk.dataDir, []);
      await ready(walk, ID);
    },
    "select-it": async (walk) => {
      const screen = await walk.terminal({ title: "tavi ideas provider", args: ["ideas", "provider", ID] });
      expect(screen.join("\n")).toContain("Ideas now come from acme.ideas");
      expect(walk.tavi("ideas", "provider")).toMatch(/^\* acme\.ideas/m);
    },
    "see-its-ideas": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page.getByRole("navigation", { name: "pages" }).getByRole("button", { name: "Ideas" }).click();
      await page.getByRole("heading", { name: "Ideas", level: 1 }).waitFor();
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect
        .poll(() => walk.taviJson<Ideas>("ideas", "list").ideas.map((idea) => idea.key), { timeout: 60_000, interval: 2_000 })
        .toEqual([KEY]);
      await page.getByRole("article", { name: "I can run your weekly review", exact: true }).waitFor({ timeout: 30_000 });
      expect(plugin(walk, ID)?.phase).toBe("ready");
      // When it last looked changes with every walk.
      await walk.shot(undefined, { mask: [page.getByText(/^Last looked/)] });
    },
  },
});
