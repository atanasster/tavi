import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { expect } from "vitest";

import { events, NOTES, taviScript } from "../support/scripting.js";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

const COLOURS = "Name three primary colours as a JSON array of strings, nothing else.";
const KEY = "colours-2026-11-03";

/** The reader's `~/code/notes`. */
let notes = "";
/** The run streamed as JSON. */
let counted = "";

/** `jq <filter>` over `input`, as the guide's pipe runs it. */
const jq = (input: string, ...args: string[]) => execFileSync("jq", args, { input, encoding: "utf8" }).trim();

interface Listing {
  readonly tasks: readonly { readonly taskId: string; readonly creationOperationKey: string; readonly status: string }[];
}

walkGuide("scripting/json-pipelines", {
  configured: true,
  model: true,
  steps: {
    "pipe-the-answer-on": async (walk) => {
      notes = join(projectsFolder("json-pipelines", NOTES), "notes");
      await restartOwner(walk.dataDir, ["--fs-root", join(notes, "..")]);
      // What a pipe reads: standard output alone.
      const screen = await walk.terminal({ title: "tavi run --quiet", args: ["run", "--quiet", COLOURS] });
      expect(jq(screen.join("\n"), "length")).toBe("3");
    },
    "stream-the-run-as-json-lines": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi run --format json",
        args: ["run", "--format", "json", "--folder", notes, "How many items are in todo.txt? Answer with the number only."],
        cols: 140,
      });
      expect(screen.join("\n")).toContain('"kind":"task.completed"');
      counted = chats(walk.tavi).find((chat) => chat.chatKind === "run")?.taskId ?? "";
      // The same stream, whole: the picture's lines are wrapped at the terminal's width.
      const stream = walk.tavi("run", "--attach", counted, "--format", "json");
      const kinds = events(stream).map((event) => event.kind);
      expect(kinds[0]).toBe("run.started");
      expect(kinds.at(-1)).toBe("task.completed");
      expect(new Set(events(stream).map((event) => event.runId))).toEqual(new Set([counted]));
      // The filters step 3 shows.
      expect(jq(stream, "-r", 'select(.kind == "tool.started") | .toolName').split("\n")).toContain("fs.read");
      expect(jq(stream, "-r", 'select(.kind == "task.completed") | .finalText')).toMatch(/\b3\b/);
    },
    "pick-out-what-you-need": async (walk) => {
      const screen = await walk.terminal({ title: "tavi tasks", args: ["tasks", counted], lines: 24 });
      expect(screen.join("\n")).toContain(counted);
      const record = walk.taviJson<{ task: { status: string; finalText: string } }>("tasks", counted);
      expect(record.task.status).toBe("completed");
      expect(record.task.finalText).toMatch(/\b3\b/);
    },
    "make-a-retry-safe": async (walk) => {
      const first = taviScript(walk.dataDir, "run", "--operation-key", KEY, COLOURS);
      expect(first.status).toBe(0);
      const before = walk.taviJson<Listing>("tasks").tasks.length;
      const screen = await walk.terminal({ title: "tavi run --operation-key", args: ["run", "--operation-key", KEY, COLOURS], tty: true });
      expect(screen.join("\n")).toMatch(/no work was re-run/);
      const after = walk.taviJson<Listing>("tasks").tasks;
      expect(after).toHaveLength(before);
      expect(after.filter((task) => task.creationOperationKey === KEY)).toHaveLength(1);
    },
  },
});
