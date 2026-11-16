import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { allowUntilAnswered, newChat, sendPrompt } from "../support/browser-site.js";
import { plugin, ready, toolsCalled, validate } from "../support/extend.js";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { showFolderAs, walkGuide } from "../support/walk.js";

useRealTmpdir();

const ID = "acme.words";
const PROMPT =
  "Create a Tavi plugin in acme-words: id acme.words, version 0.1.0, one read-only tool, count, that counts the words and characters in a text.";

/** The reader's `~/tavi-plugins`, the folder the owner may write in. */
let folder = "";
/** The chat writing the plugin. */
let taskId = "";

walkGuide("extend/make-a-plugin-from-a-chat", {
  configured: true,
  model: true,
  timeoutMs: 900_000,
  steps: {
    "ask-for-the-plugin": async (walk) => {
      folder = projectsFolder("make-a-plugin-from-a-chat", {});
      // The page's plugins folder.
      showFolderAs(folder, "~/tavi-plugins");
      await restartOwner(walk.dataDir, ["--fs-root", folder]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", folder, PROMPT],
        tty: true,
        cols: 120,
        // It asks at the terminal; Ctrl-C leaves the call waiting for the canvas.
        input: [
          { until: "\\[y/s/a/N\\]", wait: 240 },
          { text: "\u0003", wait: 3 },
        ],
      });
      expect(screen.join("\n")).toMatch(/tavi-plugin\.json|index\.mjs/);
      taskId = chats(walk.tavi).find((chat) => chat.chatKind === "run")?.taskId ?? "";
      expect(taskId).not.toBe("");
    },
    "read-each-file-before-you-approve-it": async (walk) => {
      const page = await walk.open(`/tasks/${taskId}`);
      // The picture is the manifest's card: a look round the folder the model asks for first is allowed on the way.
      let card = page.locator("section.round").last();
      for (let asked = 0; ; asked++) {
        await page.getByText("Needs your approval").last().waitFor({ timeout: 180_000 });
        card = page.locator("section.round").last();
        await card.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 180_000 });
        if ((await card.getByText("tavi-plugin.json").count()) > 0) break;
        if (asked >= 4) throw new Error("Tavi never asked to write tavi-plugin.json");
        await card.getByRole("button", { name: "Allow once" }).click();
        await card.getByRole("button", { name: "Allow once" }).waitFor({ state: "detached", timeout: 30_000 });
      }
      await card.getByText("Details", { exact: true }).click();
      await card.locator(".call-command").first().waitFor();
      await page.setViewportSize({ width: 1280, height: 1200 });
      await card.scrollIntoViewIfNeeded();
      await walk.shot(card);
      await page.setViewportSize({ width: 1280, height: 800 });
      await card.getByRole("button", { name: "Allow once" }).click();
    },
    "let-it-check-what-it-wrote": async (walk) => {
      const page = await walk.page();
      await allowUntilAnswered(page, 0, { timeoutMs: 600_000 });
      const dir = join(folder, "acme-words");
      expect(existsSync(join(dir, "tavi-plugin.json")) && existsSync(join(dir, "index.mjs"))).toBe(true);
      // What Tavi wrote is a plugin install would take.
      expect(validate(dir).problems).toEqual([]);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "install-it-yourself": async (walk) => {
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", join(folder, "acme-words")] });
      expect(screen.join("\n")).toContain(`installed ${ID}@0.1.0 (proposed)`);
    },
    "approve-enable-and-restart": async (walk) => {
      walk.tavi("plugins", "approve", ID, "0.1.0");
      walk.tavi("plugins", "enable", ID);
      await restartOwner(walk.dataDir, ["--fs-root", folder]);
      await ready(walk, ID);
      const screen = await walk.terminal({ title: "tavi plugins show", args: ["plugins", "show", ID] });
      expect(screen.join("\n")).toMatch(/acme\.words\.count\s+read-only/);
      expect(plugin(walk, ID)?.enabled).toBe(true);
    },
    "use-it": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      const before = await sendPrompt(page, "Use acme.words to count the words in: The quick brown fox jumps over the lazy dog.");
      expect(await allowUntilAnswered(page, before)).toBe(0);
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home" && entry.taskId !== taskId)?.taskId ?? "";
      expect(toolsCalled(walk, chat)).toContain("acme.words.count");
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
  },
});
