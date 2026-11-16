import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { delay, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { changedSensitiveFiles, sensitiveFilesNow } from "../../src/features/sandbox/sandbox-folders.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

describe("files the host runs on purpose", () => {
  it("names a file a run made, changed or removed, once, though it puts the old size and time back", async () => {
    const root = temp.create("tavi-sensitive-");
    writeFileSync(join(root, "Makefile"), "all:\n\techo a\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    const before = sensitiveFilesNow([root]);
    // One file, whatever a case-insensitive filesystem calls it.
    expect([...before.keys()].filter((path) => path.toLowerCase().endsWith("makefile"))).toHaveLength(1);
    const { atime, mtime } = statSync(join(root, "Makefile"));
    await delay(20);
    // Same size, same modification time: only its change time moves.
    writeFileSync(join(root, "Makefile"), "all:\n\techo b\n");
    utimesSync(join(root, "Makefile"), atime, mtime);
    writeFileSync(join(root, "AGENTS.md"), "x\n");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{}\n");
    expect(changedSensitiveFiles(before, sensitiveFilesNow([root]))).toEqual([join(root, "AGENTS.md"), join(root, "Makefile")]);
  });
});
