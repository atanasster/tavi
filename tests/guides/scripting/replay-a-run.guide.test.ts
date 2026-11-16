import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { events, NOTES, taviScript } from "../support/scripting.js";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

/** The reader's `~/code`, with `notes/todo.txt`; the saved runs go beside it, at a path that is the same every walk. */
let code = "";
const notes = () => join(code, "notes");
const saved = (name: string) => join(code, name);

const latestRun = (tavi: (...args: string[]) => string) => chats(tavi).find((chat) => chat.chatKind === "run");

walkGuide("scripting/replay-a-run", {
  configured: true,
  model: true,
  steps: {
    "save-a-run-to-a-file": async (walk) => {
      code = projectsFolder("replay-a-run", NOTES);
      await restartOwner(walk.dataDir, ["--fs-root", code]);
      const screen = await walk.terminal({
        title: "tavi run --format json",
        args: ["run", "--format", "json", "--folder", notes(), "How many items are in todo.txt? Answer with the number only."],
        cols: 140,
      });
      expect(screen.join("\n")).toContain('"kind":"task.completed"');
      // The file the redirect writes: the run's whole stream (the picture's lines are wrapped).
      const run = latestRun(walk.tavi);
      expect(run?.status).toBe("completed");
      const stream = walk.tavi("run", "--attach", run?.taskId ?? "", "--format", "json");
      expect(events(stream).at(-1)?.kind).toBe("task.completed");
      writeFileSync(saved("count.ndjson"), stream);
    },
    "play-it-back": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat --replay count.ndjson",
        args: ["chat", "--replay", saved("count.ndjson")],
        tty: true,
        input: [{ until: "Done\\.", wait: 30 }],
      });
      const text = screen.join("\n");
      expect(text).toMatch(/fs\.read\(/);
      expect(text).toContain("Done.");
    },
    "save-a-run-you-didn-t-record": async (walk) => {
      // A run a script left waiting: no terminal, no --approval.
      const left = taviScript(walk.dataDir, "run", "--folder", notes(), "Delete the line 'book dentist' from todo.txt.");
      expect(left.status, left.stderr).toBe(3);
      const run = latestRun(walk.tavi);
      expect(run?.status).toBe("waiting");
      const attached = taviScript(walk.dataDir, "run", "--attach", run?.taskId ?? "", "--format", "json");
      expect(events(attached.stdout).map((event) => event.kind)).toContain("approval.required");
      writeFileSync(saved("waiting.ndjson"), attached.stdout);
      const screen = await walk.terminal({
        title: "tavi chat --replay waiting.ndjson",
        args: ["chat", "--replay", saved("waiting.ndjson")],
        tty: true,
        input: [{ until: "approval needed", wait: 30 }],
      });
      expect(screen.join("\n")).toContain(`tavi approvals approve|reject ${run?.taskId}`);
      // The replay decided nothing: the call still waits, and the file is as it was.
      expect(latestRun(walk.tavi)?.status).toBe("waiting");
      expect(readFileSync(join(notes(), "todo.txt"), "utf8")).toContain("book dentist");
    },
    "spot-a-damaged-file": async (walk) => {
      // Two lines of the saved run swapped, as a hand edit or a bad merge leaves them.
      const lines = readFileSync(saved("count.ndjson"), "utf8").trimEnd().split("\n");
      writeFileSync(saved("count-edited.ndjson"), `${[lines[1], lines[0], ...lines.slice(2)].join("\n")}\n`);
      const screen = await walk.terminal({
        title: "tavi chat --replay count-edited.ndjson",
        args: ["chat", "--replay", saved("count-edited.ndjson")],
        tty: true,
        input: [{ wait: 3 }],
      });
      const text = screen.join("");
      expect(text).toContain("count-edited.ndjson");
      // The file and its first wrong line, `<file>:<line>`.
      // (Lines are joined as drawn, so a space at a wrap may be gone.)
      expect(text).toMatch(/count-edited\.ndjson:2 ?is ?not ?one ?task's ?stream ?in ?order/);
    },
  },
});
