import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished } from "vitest";

import { stopOwner } from "../support/skills.js";
import { restartOwner } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

/**
 * The walk's own folder outside the data directory, at the same place every run (the pictures name the snapshot as
 * `/tmp/…`), deleted before and after. The upgrade itself is not walked: it would change the program installed here.
 */
const top = join(realpathSync(tmpdir()), "tavi-guide-upgrade");
const SNAPSHOT = join(top, "before-upgrade");
const PROMPT_FILE = join(top, "my-prompt.txt");

interface Prompt {
  readonly revision: number;
  readonly custom: { readonly text: string } | null;
  readonly shipped: { readonly text: string; readonly version: string };
}

walkGuide("run-and-maintain/upgrade", {
  configured: true,
  steps: {
    "stop-tavi": async (walk) => {
      rmSync(top, { recursive: true, force: true });
      mkdirSync(top, { recursive: true });
      onTestFinished(() => rmSync(top, { recursive: true, force: true }));
      // Ctrl-C in its terminal, as a reader stops theirs: the walk's own owner only.
      await stopOwner(walk.dataDir);
      walk.unwalked("launchctl bootout / systemctl --user stop: the walk's owner is not a service on this machine");
      const screen = await walk.terminal({ title: "tavi doctor --format text", args: ["doctor", "--format", "text"], lines: 5 });
      const text = screen.join("\n");
      expect(text).toContain("No owner is running");
      expect(text).toContain("Database: quick check, no problems");
    },
    "take-a-snapshot": async (walk) => {
      expect(SNAPSHOT.startsWith(walk.dataDir)).toBe(false);
      const screen = await walk.terminal({ title: "tavi backup", args: ["backup", "--out", SNAPSHOT], cols: 160 });
      expect(screen.join("\n")).toMatch(/^snapshot /m);
      expect(existsSync(join(SNAPSHOT, "tavi.sqlite"))).toBe(true);
      expect(existsSync(join(SNAPSHOT, "credentials"))).toBe(false);
    },
    "install-the-new-build": async (walk) => {
      walk.unwalked(
        "git pull, pnpm install and pnpm run build: they would change the Tavi this machine runs; the walk runs the current build",
      );
      const screen = await walk.terminal({ title: "tavi --version", args: ["--version"] });
      expect(screen.join("\n")).toMatch(/^tavi \d+\.\d+\.\d+ \([0-9a-f]{12}\)$/m);
    },
    "start-tavi-again": async (walk) => {
      await restartOwner(walk.dataDir, []);
      const screen = await walk.terminal({ title: "tavi doctor --format text", args: ["doctor", "--format", "text"], lines: 5 });
      const text = screen.join("\n");
      expect(text).toContain("The owner is running");
      expect(text).toMatch(/Migrations up to \d{4}_/);
    },
    "see-which-instructions-your-chats-use": async (walk) => {
      const screen = await walk.terminal({ title: "tavi system-prompt show", args: ["system-prompt", "show"], lines: 3 });
      expect(screen.join("\n")).toMatch(/^workspace default: shipped default tavi-default-\d+, revision 0$/m);
      expect(walk.taviJson<Prompt>("system-prompt", "show").custom).toBeNull();
    },
    "or-keep-your-own-across-upgrades": async (walk) => {
      // The reader's own copy: today's shipped text, kept as their override.
      const shipped = walk.taviJson<Prompt>("system-prompt", "show").shipped.text;
      writeFileSync(PROMPT_FILE, shipped);
      const screen = await walk.terminal({
        title: "tavi system-prompt set",
        args: ["system-prompt", "set", "--file", PROMPT_FILE],
        lines: 3,
      });
      expect(screen.join("\n")).toMatch(/^workspace default: custom override at revision 1 /m);
      const prompt = walk.taviJson<Prompt>("system-prompt", "show");
      expect(prompt.custom?.text).toBe(shipped);
    },
    "roll-back-with-your-snapshot": async (walk) => {
      // A restore writes: only ever into the walk's own throwaway data directory.
      expect(realpathSync(walk.dataDir)).toMatch(new RegExp(`^${realpathSync(tmpdir())}/tavi-docs-`));
      await stopOwner(walk.dataDir);
      walk.unwalked(
        "going back to the older build (git checkout, pnpm install, pnpm run build): it would change the Tavi this machine runs",
      );
      const screen = await walk.terminal({ title: "tavi restore", args: ["restore", "--from", SNAPSHOT], cols: 120 });
      expect(screen.join("\n")).toMatch(/^restored \d+ migration\(s\) from /m);
      expect(readdirSync(walk.dataDir).some((name) => name.startsWith("tavi.sqlite.pre-restore-"))).toBe(true);
      // The snapshot was taken before the override: the restored workspace follows the shipped instructions again.
      expect(walk.taviJson<Prompt>("system-prompt", "show").custom).toBeNull();
    },
  },
});
