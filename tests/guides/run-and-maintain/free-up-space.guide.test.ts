import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import { stopOwner } from "../support/skills.js";
import { walkGuide } from "../support/walk.js";

/** A prune and a reset delete: only ever in the walk's own throwaway data directory. */
const throwaway = (dataDir: string) => expect(realpathSync(dataDir)).toMatch(new RegExp(`^${realpathSync(tmpdir())}/tavi-docs-`));

walkGuide("run-and-maintain/free-up-space", {
  configured: true,
  // Something to start over from: a to-do and a setting of your own.
  seed: [
    ["todos", "add", "Book the boiler service"],
    ["config", "set", "operator.name", "Robin"],
  ],
  steps: {
    "keep-fewer-model-requests": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config set",
        args: ["config", "set", "models.keptRequests", "3"],
        lines: 4,
      });
      expect(screen.join("\n")).toContain("models.keptRequests = 3");
      expect(walk.taviJson<{ effective: { keptModelRequests: number } }>("config", "get").effective.keptModelRequests).toBe(3);
    },
    "see-what-a-prune-would-delete": async (walk) => {
      await stopOwner(walk.dataDir);
      throwaway(walk.dataDir);
      const screen = await walk.terminal({ title: "tavi prune --dry-run", args: ["prune", "--older-than", "7", "--dry-run"], lines: 8 });
      expect(screen.join("\n")).toMatch(/^would delete \d+ row/m);
    },
    "prune-now": async (walk) => {
      throwaway(walk.dataDir);
      const screen = await walk.terminal({ title: "tavi prune", args: ["prune", "--older-than", "7"], lines: 8 });
      expect(screen.join("\n")).toMatch(/^deleted \d+ row/m);
      // The audit trail stays: the to-do is still listed.
      expect(walk.tavi("todos", "list")).toContain("Book the boiler service");
    },
    "tidy-the-chats-folders": async (walk) => {
      throwaway(walk.dataDir);
      const screen = await walk.terminal({
        title: "tavi tasks folders prune --dry-run",
        args: ["tasks", "folders", "prune", "--dry-run"],
        lines: 6,
      });
      expect(screen.join("\n")).toMatch(/runs' folders/);
    },
    "start-over": async (walk) => {
      throwaway(walk.dataDir);
      const screen = await walk.terminal({ title: "tavi reset --yes", args: ["reset", "--yes"], cols: 140, lines: 8 });
      expect(screen.join("\n")).toMatch(/^reset .*deleted /m);
      expect(existsSync(join(walk.dataDir, "tavi.sqlite"))).toBe(false);
      // As a fresh install: no setting of yours, no to-do.
      expect(walk.taviJson<{ settings: Record<string, unknown> }>("config", "get").settings).toEqual({});
      expect(walk.tavi("todos", "list")).not.toContain("Book the boiler service");
    },
  },
});
