import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished } from "vitest";

import { stopOwner } from "../support/skills.js";
import { restartOwner } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const TODO = "Renew the passport";

interface Todos {
  readonly todos: readonly { readonly todoId: string; readonly text: string; readonly status: string }[];
}
const todos = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Todos>("todos", "list").todos;

/**
 * The walk's own folders outside the data directory, at the same place every run (the pictures name them, as
 * `/tmp/…`), deleted before and after.
 */
const top = join(realpathSync(tmpdir()), "tavi-guide-backups");
const SNAPSHOT = join(top, "2026-11-04");
const EXPORT = join(top, "export");

/** A restore writes: only ever into the walk's own throwaway data directory. */
const throwaway = (dataDir: string) => expect(realpathSync(dataDir)).toMatch(new RegExp(`^${realpathSync(tmpdir())}/tavi-docs-`));

walkGuide("run-and-maintain/back-up-and-restore", {
  configured: true,
  // Before you start: a to-do worth keeping.
  seed: [["todos", "add", TODO]],
  steps: {
    "take-a-backup": async (walk) => {
      rmSync(top, { recursive: true, force: true });
      mkdirSync(top, { recursive: true });
      onTestFinished(() => rmSync(top, { recursive: true, force: true }));
      expect(SNAPSHOT.startsWith(walk.dataDir)).toBe(false);
      const screen = await walk.terminal({ title: "tavi backup", args: ["backup", "--out", SNAPSHOT], cols: 160 });
      expect(screen.join("\n")).toMatch(/^snapshot /m);
      const manifest = JSON.parse(readFileSync(join(SNAPSHOT, "manifest.json"), "utf8")) as { includes: { credentials: boolean } };
      expect(manifest.includes.credentials).toBe(false);
      expect(existsSync(join(SNAPSHOT, "tavi.sqlite"))).toBe(true);
    },
    "export-to-plain-files": async (walk) => {
      const screen = await walk.terminal({ title: "tavi export", args: ["export", "--out", EXPORT], lines: 10 });
      expect(screen.join("\n")).toMatch(/^exported \d+ table/m);
      const files = readdirSync(EXPORT);
      expect(files.every((file) => file.endsWith(".ndjson"))).toBe(true);
      // The to-do is in there, as plain text.
      expect(files.some((file) => readFileSync(join(EXPORT, file), "utf8").includes(TODO))).toBe(true);
    },
    "stop-tavi-before-you-restore": async (walk) => {
      // The mistake the restore undoes: the to-do removed after the backup.
      const [todo] = todos(walk);
      walk.tavi("todos", "remove", todo?.todoId ?? "");
      expect(todos(walk)).toEqual([]);
      const screen = await walk.terminal({
        title: "tavi restore",
        args: ["restore", "--from", SNAPSHOT],
        tty: true,
        // Typed into, the refusal's exit status (5) is not a failed run: it is what the step shows.
        input: [{ until: "already owns", wait: 30 }],
        cols: 150,
      });
      // Read as one line: the terminal wraps it at its width.
      expect(screen.join("").replace(/\s+/g, " ")).toMatch(
        /`tavi serve` \(pid \d+\) already owns .*; restoring would replace the database it is using\. Stop it first/,
      );
      await stopOwner(walk.dataDir);
    },
    "restore-the-backup": async (walk) => {
      throwaway(walk.dataDir);
      const screen = await walk.terminal({ title: "tavi restore", args: ["restore", "--from", SNAPSHOT], cols: 150 });
      expect(screen.join("\n")).toMatch(/^restored \d+ migration/m);
      // The database it replaced was moved aside, not deleted.
      expect(readdirSync(walk.dataDir).some((name) => name.startsWith("tavi.sqlite.pre-restore-"))).toBe(true);
    },
    "start-tavi-and-check": async (walk) => {
      await restartOwner(walk.dataDir, []);
      const screen = await walk.terminal({ title: "tavi todos list", args: ["todos", "list"], cols: 120, lines: 4 });
      expect(screen.join("\n")).toContain(TODO);
      expect(todos(walk).map((todo) => [todo.text, todo.status])).toEqual([[TODO, "open"]]);
    },
  },
});
