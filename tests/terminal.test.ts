import { afterAll, describe, expect, it } from "vitest";

import { needsPosix, removeTemporaryDirectories } from "@tavi/test-support";

import { pseudoTerminalAvailable, underTerminal } from "./support/terminal.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/**
 * The pseudo-terminal the release gate runs `tavi chat` under
 * (`tests/support/terminal.ts`), checked in the default suite: the
 * gate itself is opt-in, and a platform's `script(1)` differs — BSD's takes
 * the command as arguments, util-linux's as a string — so each platform's form
 * runs here, on every run, before a release depends on it.
 */

afterAll(() => {
  removeTemporaryDirectories();
});

const options = { rows: 20, columns: 60, cwd: process.cwd(), env: process.env };

// Skipped, not failed, where the environment forbids allocating a terminal: a
// sandbox that denies `openpty(3)` cannot exercise `script(1)` at all, and that
// says nothing about the command under it. `tests/release.test.ts` still refuses
// to certify a release it could not exercise.
describe.skipIf(posixOnly || !pseudoTerminalAvailable())("a command under a pseudo-terminal", () => {
  it("gets a terminal of the size asked for, on both its input and its output", () => {
    const { transcript } = underTerminal(["sh", "-c", "stty size; test -t 0 && test -t 1 && echo on-a-terminal"], options);
    expect(transcript).toContain("20 60");
    expect(transcript).toContain("on-a-terminal");
  });

  it("passes arguments through unmangled, and fails with the command's status", () => {
    expect(underTerminal(["printf", "[%s]", "it's a b"], options).transcript).toContain("[it's a b]");
    expect(() => underTerminal(["sh", "-c", "exit 3"], options)).toThrow(/status 3/);
  });
});
