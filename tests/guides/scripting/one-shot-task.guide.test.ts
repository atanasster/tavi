import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { NOTES } from "../support/scripting.js";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

/** The reader's `~/code/notes`. */
let notes = "";
/** The run that edited the list. */
let edited = "";

const runs = (tavi: (...args: string[]) => string) => chats(tavi).filter((chat) => chat.chatKind === "run");

walkGuide("scripting/one-shot-task", {
  configured: true,
  model: true,
  steps: {
    "ask-one-thing": async (walk) => {
      // A run with nothing to ask exits by itself: no keys typed.
      const screen = await walk.terminal({ title: "tavi run", args: ["run", "In two sentences, what is a git rebase?"], tty: true });
      expect(screen.join("\n").trim()).not.toBe("");
      expect(runs(walk.tavi).map((chat) => chat.status)).toEqual(["completed"]);
    },
    "point-it-at-a-folder": async (walk) => {
      notes = join(projectsFolder("one-shot-task", NOTES), "notes");
      await restartOwner(walk.dataDir, ["--fs-root", join(notes, "..")]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", notes, "How many items are in todo.txt? Answer with the number only."],
        tty: true,
        cols: 120,
      });
      expect(screen.join("\n")).toMatch(/\[tool\] fs\.read/);
      expect(runs(walk.tavi)[0]?.status).toBe("completed");
    },
    "approve-a-change": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", notes, "Add '- buy milk' as a new last line of todo.txt."],
        tty: true,
        cols: 120,
        input: [
          { until: "\\[y/s/a/N\\]", wait: 180 },
          { text: "y\r", wait: 1 },
          { until: "\\[tool\\] fs\\.(edit|write) →", wait: 120 },
          { wait: 10 },
        ],
      });
      expect(screen.join(""), "the prompt, answered y").toMatch(/\[y\/s\/a\/N\] ?y/);
      expect(readFileSync(join(notes, "todo.txt"), "utf8")).toMatch(/- buy milk\s*$/);
      const run = runs(walk.tavi)[0];
      expect(run?.status).toBe("completed");
      edited = run?.taskId ?? "";
    },
    "pick-the-run-up-in-a-chat": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat --attach",
        args: ["chat", "--attach", edited],
        tty: true,
        cols: 120,
        input: [{ until: "Done\\.", wait: 30 }, { wait: 2 }, { text: "\u0003", wait: 2 }],
      });
      const text = screen.join("\n");
      expect(text).toContain("Add '- buy milk' as a new last line of todo.txt.");
      expect(text).toMatch(/fs\.(edit|write)\(/);
      expect(text).toMatch(/Done\. Type to continue it/);
    },
  },
});
