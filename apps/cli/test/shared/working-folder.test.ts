import { capture } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/** A `process.cwd` whose folder was moved to the Trash or deleted under the shell. */
function failingCwd(code: string): () => string {
  return () => {
    throw Object.assign(new Error(`${code}: operation failed, uv_cwd`), { code });
  };
}

describe("an unreadable working folder", () => {
  it.each([
    ["EPERM", "it cannot be read"],
    ["ENOENT", "it no longer exists"],
  ])("refuses to start on %s and names the folder, not the model target", async (code, reason) => {
    const captured = capture();
    expect(await main(["serve", "--data-dir", "/nonexistent/tavi"], { io: captured.io, cwd: failingCwd(code) })).toBe(EXIT.unavailable);
    expect(captured.stderr()).toBe(
      `tavi serve cannot start in this folder: ${reason} (it may have been moved to the Trash or deleted). ` +
        "Change to another folder, for example `cd ~`, and run it again.\n",
    );
    expect(captured.stderr()).not.toContain("model target");
  });

  it("still answers --version and --help", async () => {
    const version = capture();
    expect(await main(["--version"], { io: version.io, cwd: failingCwd("EPERM") })).toBe(EXIT.ok);
    const help = capture();
    expect(await main(["--help"], { io: help.io, cwd: failingCwd("EPERM") })).toBe(EXIT.ok);
  });
});
