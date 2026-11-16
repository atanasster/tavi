import { expect, it } from "vitest";

import { withDataDir } from "../scripts/docs/session.mjs";

/**
 * Every tavi command a guide walk runs gets the walk's own data directory. A command that hands the rest of its line
 * to another program (`tavi mcp add notes -- node server.mjs`) must get the flag before `--`, or tavi never sees it
 * and runs on the reader's real data directory.
 */

it("adds the data directory at the end of a plain command", () => {
  expect(withDataDir(["memory", "list"], "/tmp/d")).toEqual(["memory", "list", "--data-dir", "/tmp/d"]);
});

it("adds the data directory before the arguments another program gets", () => {
  expect(withDataDir(["mcp", "add", "notes", "--", "node", "server.mjs", "--", "x"], "/tmp/d")).toEqual([
    "mcp",
    "add",
    "notes",
    "--data-dir",
    "/tmp/d",
    "--",
    "node",
    "server.mjs",
    "--",
    "x",
  ]);
});
