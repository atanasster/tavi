import { expect } from "vitest";

import { guideCode, plugin, pluginFolder, ready, stopOwner, toolsCalled, validate } from "../support/extend.js";
import { chats, dismissChecklist, restartOwner, send, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

const ID = "acme.tip";
/** The code the page shows: what the reader saves, and what the walk runs. */
const code = guideCode("extend/write-a-tool-plugin");
/** The reader's `~/tavi-plugins/acme-tip`. */
let folder: ReturnType<typeof pluginFolder>;

walkGuide("extend/write-a-tool-plugin", {
  configured: true,
  model: true,
  steps: {
    "describe-the-tool": async (walk) => {
      folder = pluginFolder("write-a-tool-plugin", "acme-tip");
      folder.write("json", code.manifest);
      await stopOwner(walk.dataDir);
      // It refuses to start, as the page says: on a terminal, so the picture has what it printed to either stream.
      const screen = await walk.terminal({
        title: "tavi serve --dev-plugin",
        args: ["serve", "--dev-plugin", folder.dir],
        tty: true,
        input: [{ until: "could not start", wait: 30 }],
      });
      expect(screen.join("\n")).toContain("index.mjs does not exist");
    },
    "write-the-handler": async (walk) => {
      folder.write("js", code.module);
      expect(validate(folder.dir)).toMatchObject({ problems: [], registered: expect.objectContaining({ tools: ["split"] }) });
      await restartOwner(walk.dataDir, ["--dev-plugin", folder.dir]);
      await ready(walk, ID);
      const screen = await walk.terminal({ title: "tavi plugins show", args: ["plugins", "show", ID], cols: 150 });
      expect(screen.join("\n")).toContain("loaded unapproved by tavi serve --dev-plugin");
    },
    "ask-for-it-in-a-chat": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await page
        .getByRole("button", { name: /^New (side )?chat$/ })
        .first()
        .click();
      await send(page, "Split a bill of 84.50 between 3 people with a 15% tip.");
      const taskId = chats(walk.tavi).find((chat) => chat.chatKind !== "home")?.taskId ?? "";
      expect(toolsCalled(walk, taskId)).toContain("acme.tip.split");
      expect(walk.taviJson<{ rows: readonly unknown[] }>("approvals", "list").rows).toEqual([]);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "install-it-for-good": async (walk) => {
      await restartOwner(walk.dataDir, []);
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", folder.dir] });
      expect(screen.join("\n")).toContain("installed acme.tip@0.1.0 (proposed)");
      // What the reader does next, as the install guide shows it: the same code, approved, loads.
      walk.tavi("plugins", "approve", ID, "0.1.0");
      walk.tavi("plugins", "enable", ID);
      await restartOwner(walk.dataDir, []);
      await ready(walk, ID);
      expect(plugin(walk, ID)?.activeVersion).toBe("0.1.0");
    },
  },
});
