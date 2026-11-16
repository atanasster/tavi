import { describe, expect, it } from "vitest";

import { sameIdentity } from "../src/index.js";

describe("whether two statuses are of one file", () => {
  const file = { dev: 7, ino: 2 ** 60, birthtimeMs: 1_700_000_000_000.5 };

  it("is the same device and inode, and on Windows the same creation time too", () => {
    expect(sameIdentity(file, { ...file }, "linux")).toBe(true);
    expect(sameIdentity(file, { ...file, dev: 8 }, "linux")).toBe(false);
    // Off Windows an inode is exact, and a creation time is not always kept.
    expect(sameIdentity(file, { ...file, birthtimeMs: 0 }, "linux")).toBe(true);
    // On Windows a 64-bit file id read as a number can match another file's: its creation time tells them apart.
    expect(2 ** 60 + 1 === 2 ** 60).toBe(true);
    expect(sameIdentity(file, { ...file, birthtimeMs: file.birthtimeMs + 1 }, "win32")).toBe(false);
    expect(sameIdentity(file, { ...file }, "win32")).toBe(true);
  });
});
