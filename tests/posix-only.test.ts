import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { POSIX_ONLY } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

/**
 * The tests Windows skips are named in one list, `POSIX_ONLY`, each with its
 * reason, and its length is held here: once the first Windows run has named
 * every file, lowered as each case is brought over to Windows, never raised.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Provisional until the `windows` job's first run names every file that needs POSIX (its workspace tests
// do not fail the job until then); from that run on, this only comes down.
const MAX_POSIX_ONLY = 11;

const testFiles = execFileSync("git", ["ls-files", "-z", "--", "*.test.ts"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "" && existsSync(join(root, file)));

describe("the tests Windows skips", () => {
  it("are at most as many as before", () => {
    expect(POSIX_ONLY.length).toBeLessThanOrEqual(MAX_POSIX_ONLY);
  });

  it("are each listed once, with a reason, and ask through needsPosix", () => {
    const files = POSIX_ONLY.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    for (const entry of POSIX_ONLY) {
      expect(entry.reason.trim(), entry.file).not.toBe("");
      expect(existsSync(join(root, entry.file)), entry.file).toBe(true);
      expect(readFileSync(join(root, entry.file), "utf8"), entry.file).toContain("needsPosix(import.meta.url)");
    }
  });

  it("are skipped only through the list, never by a test's own platform check", () => {
    const own = /(?:skipIf\([^)]*process\.platform === "win32"|process\.platform === "win32"[^\n]*\.skip\()/;
    expect(testFiles.filter((file) => own.test(readFileSync(join(root, file), "utf8")))).toEqual([]);
  });
});
