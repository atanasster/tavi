import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { ownedRefusal } from "../../src/cli/store.js";
import { EXIT, main } from "../../src/main.js";

/**
 * A command that needs the data directory to itself, refused because another
 * process holds it, says so in one wording: who holds it (`tavi serve` and its
 * pid when it is serve), what this command would have done, and how to free it
 * — never the internal `CONFLICT:` code.
 */
const directories = temporaryDirectories({ prefix: "tavi-owned-refusal-" });
afterEach(() => directories.cleanup());

describe("the refusal when another process owns the data directory", () => {
  it("names tavi serve and its pid, what the command would do, and how to stop it", () => {
    expect(ownedRefusal("/d", { pid: 42, sessionId: "serve-1" }, "restoring would replace the database it is using")).toBe(
      "`tavi serve` (pid 42) already owns /d; restoring would replace the database it is using. " +
        "Stop it first (Ctrl-C where it runs, or stop the launchd/systemd unit you installed with `tavi service unit`), then run this again.",
    );
    expect(ownedRefusal("/d", { pid: 7, sessionId: "cli-7" })).toBe(
      "Another tavi command (pid 7) already owns /d; this command needs it to itself. Wait for it to finish, then run this again.",
    );
    expect(ownedRefusal("/d", undefined)).toBe(
      "Another process already owns /d; this command needs it to itself. Stop it first (Ctrl-C where `tavi serve` runs, or stop the launchd/systemd unit you installed with `tavi service unit`), then run this again.",
    );
  });

  it("reads the same for restore, prune and reset, with no CONFLICT code and exit 5", async () => {
    const directory = directories.create();
    const { acquireDataDirectoryOwnership } = await import("@tavi/runtime");
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "cli-holder" });
    const snapshot = directories.create("tavi-owned-refusal-snapshot-");
    try {
      for (const [argv, prefix] of [
        [["restore", "--from", snapshot], "restore command failed"],
        [["prune", "--older-than", "7", "--dry-run"], "prune command failed"],
        [["reset", "--yes"], "reset command failed"],
      ] as const) {
        const captured = capture();
        const code = await main([...argv, "--data-dir", directory], { io: captured.io });
        expect(code, argv.join(" ")).toBe(EXIT.alreadyOwned);
        expect(captured.stderr(), argv.join(" ")).toMatch(
          new RegExp(
            `^${prefix}: Another tavi command \\(pid ${process.pid}\\) already owns ${directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; [^\\n]+\\. Wait for it to finish, then run this again\\.\\n$`,
          ),
        );
      }
    } finally {
      await owner.release();
    }
  });
});
