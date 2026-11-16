import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished } from "vitest";

import { allowOnce, askForApproval as ask, chats, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

/** A project with nothing installed yet. */
const PROJECT = (name: string) => `{ "name": "${name}", "private": true, "version": "1.0.0" }\n`;
// The shell's tool always offers `requestDomains`, and a model may name a host even where the workspace never asks:
// the prompts say plainly when to ask for none.
const INSTALL = "Run npm install is-number@7.0.0 here once, asking for no hosts, and tell me what happened. Try nothing else.";

/** The reader's `~/code`, made by the walk. */
let code = "";
/** The chat that first tries the install. */
let taskId = "";

/**
 * The reader's `~/code`, with three projects that install nothing yet, in a folder of this walk's own (not the shared
 * projects folder, which another walk may be using), deleted when the walk ends.
 */
function projects(): string {
  const top = join(realpathSync(tmpdir()), "tavi-guide-network");
  rmSync(top, { recursive: true, force: true });
  for (const name of ["app", "tool", "notes"]) {
    mkdirSync(join(top, "code", name), { recursive: true });
    writeFileSync(join(top, "code", name, "package.json"), PROJECT(name));
  }
  onTestFinished(() => rmSync(top, { recursive: true, force: true }));
  return join(top, "code");
}

const installed = (project: string) => existsSync(join(code, project, "node_modules/is-number/package.json"));

walkGuide("files-and-code/let-a-build-reach-the-network", {
  configured: true,
  model: true,
  steps: {
    "see-the-install-blocked": async (walk) => {
      code = projects();
      await restartOwner(walk.dataDir, ["--fs-root", code]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", join(code, "app"), "--approval", "approve", INSTALL],
      });
      expect(screen.join("\n")).toMatch(/allow list|403/);
      expect(installed("app")).toBe(false);
      taskId = chats(walk.tavi).find((chat) => chat.chatKind === "run")?.taskId ?? "";
      expect(taskId).not.toBe("");
    },
    "let-a-run-ask-for-a-host": async (walk) => {
      walk.tavi("config", "set", "sandbox.network", "ask");
      const page = await walk.open(`/tasks/${taskId}`);
      await ask(page, "Try the install again, and ask me for the host it needs.");
      const card = page.locator("section.round").last();
      await expect(card.textContent()).resolves.toContain("reaching registry.npmjs.org");
      const pending = walk.taviJson<{ rows: readonly { risk: string; allowedScopes: readonly string[] }[] }>("approvals", "list").rows;
      expect(pending.map((row) => [row.risk, row.allowedScopes])).toEqual([["high", ["once"]]]);
      await walk.shot(card);
    },
    "allow-it-once": async (walk) => {
      const page = await walk.page();
      await allowOnce(page);
      expect(installed("app")).toBe(true);
      // What came back from the registry marks the chat.
      await page
        .getByRole("button", { name: /^Untrusted content/ })
        .first()
        .waitFor();
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "grant-the-package-registries": async (walk) => {
      const screen = await walk.terminal({ title: "tavi config set", args: ["config", "set", "sandbox.domains", "@registries"] });
      expect(screen.join("\n")).toContain("@registries");
      // Back to the default, so runs use the grant rather than ask for hosts.
      walk.tavi("config", "set", "sandbox.network", "granted");
    },
    "share-one-package-cache": async (walk) => {
      const cache = join(homedir(), ".cache/tavi-sandbox");
      // The shared cache is in your home folder: the walk removes it again unless it was there before.
      if (!existsSync(cache)) onTestFinished(() => rmSync(cache, { recursive: true, force: true }));
      await restartOwner(walk.dataDir, ["--fs-root", code, "--sandbox-cache"]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: [
          "run",
          "--folder",
          join(code, "tool"),
          "--approval",
          "approve",
          "Install the npm package is-number@7.0.0 here with npm install, asking for no hosts.",
        ],
      });
      expect(screen.join("\n")).toMatch(/added 1 package/);
      expect(installed("tool")).toBe(true);
      expect(existsSync(join(cache, "default/npm"))).toBe(true);
    },
    "install-from-the-cache-offline": async (walk) => {
      walk.tavi("config", "unset", "sandbox.domains");
      const screen = await walk.terminal({
        title: "tavi run",
        args: [
          "run",
          "--folder",
          join(code, "notes"),
          "--approval",
          "approve",
          "Install the npm package is-number@7.0.0 here with npm install --prefer-offline, asking for no hosts.",
        ],
      });
      expect(screen.join("\n")).toMatch(/added 1 package/);
      expect(installed("notes")).toBe(true);
    },
  },
});
