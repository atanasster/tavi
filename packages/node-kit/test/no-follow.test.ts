import { chmodSync, closeSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NoFollowReadError,
  openDirectoryNoFollow,
  openDirectoryNoFollowSync,
  openNoFollow,
  openNoFollowSync,
  readNoFollow,
  readNoFollowSync,
  windowsPathRefusal,
} from "../src/index.js";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tavi-no-follow-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const code = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as NoFollowReadError).reason;
  }
};

const asyncCode = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as NoFollowReadError).reason;
  }
};

/** Running as root reads past every mode, so the permission cases cannot be shown there. */
const asRoot = process.getuid?.() === 0;

// Windows's rules, run on this host: the lstat check and the identity check run as they do there.
describe.each(["win32", process.platform] as const)("no-follow opens on %s's rules", (platform) => {
  it("opens a file to read, write, create and append, and refuses a link with ELOOP", async () => {
    const file = join(directory, "file");
    writeFileSync(file, "x");
    for (const how of ["read", "write", "append"] as const) closeSync(openNoFollowSync(file, how, { platform }));
    closeSync(openNoFollowSync(join(directory, "new"), "create", { platform }));
    expect(code(() => openNoFollowSync(join(directory, "new"), "create", { platform }))).toBe("EEXIST");
    const link = join(directory, "link");
    symlinkSync(file, link);
    expect(code(() => openNoFollowSync(link, "read", { platform }))).toBe("ELOOP");
    expect(await asyncCode(() => openNoFollow(link, "write", { platform }))).toBe("ELOOP");
    await (await openNoFollow(file, "read", { platform })).close();
  });

  it("opens a directory, and refuses a link to one or a file", async () => {
    const inner = join(directory, "inner");
    mkdirSync(inner);
    symlinkSync(inner, join(directory, "to-inner"));
    writeFileSync(join(directory, "file"), "x");
    const fd = openDirectoryNoFollowSync(inner, { platform });
    if (platform === "win32") expect(fd).toBeUndefined();
    else if (fd !== undefined) closeSync(fd);
    await (await openDirectoryNoFollow(inner, { platform }))?.close();
    expect(code(() => openDirectoryNoFollowSync(join(directory, "to-inner"), { platform }))).toMatch(/^(ELOOP|ENOTDIR)$/);
    expect(code(() => openDirectoryNoFollowSync(join(directory, "file"), { platform }))).toBe("ENOTDIR");
    expect(await asyncCode(() => openDirectoryNoFollow(join(directory, "file"), { platform }))).toBe("ENOTDIR");
  });

  it.skipIf(asRoot)("throws a permission error rather than answering absent", async () => {
    const locked = join(directory, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "secret"), "x");
    chmodSync(locked, 0o000);
    try {
      expect(code(() => readNoFollowSync(join(locked, "secret"), { platform }))).toBe("EACCES");
      expect(await asyncCode(() => readNoFollow(join(locked, "secret"), { platform }))).toBe("EACCES");
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe("windowsPathRefusal", () => {
  it("refuses what Windows reads as another file, and only on Windows", () => {
    expect(windowsPathRefusal("C:\\Users\\a\\notes.txt", "win32")).toBeUndefined();
    expect(windowsPathRefusal("..\\a\\.\\b", "win32")).toBeUndefined();
    expect(windowsPathRefusal("C:notes.txt", "win32")).toMatch(/drive-relative/);
    expect(windowsPathRefusal("C:\\a\\notes.txt::$DATA", "win32")).toMatch(/alternate data stream/);
    expect(windowsPathRefusal("C:\\a\\notes.txt:hidden", "win32")).toMatch(/alternate data stream/);
    expect(windowsPathRefusal("C:\\a\\package.json.", "win32")).toMatch(/dot or a space/);
    expect(windowsPathRefusal("C:\\a\\name ", "win32")).toMatch(/dot or a space/);
    expect(windowsPathRefusal("C:\\a\\NUL", "win32")).toMatch(/reserved/);
    expect(windowsPathRefusal("C:\\a\\com1.txt", "win32")).toMatch(/reserved/);
    expect(windowsPathRefusal("C:\\a\\console.txt", "win32")).toBeUndefined();
    expect(windowsPathRefusal("\\\\?\\C:\\a", "win32")).toMatch(/device path/);
    expect(windowsPathRefusal("\\??\\GLOBALROOT\\Device\\x", "win32")).toMatch(/device path/);
    expect(windowsPathRefusal("/home/a/notes.txt:x.", "linux")).toBeUndefined();
  });

  it("is refused by the opens on Windows", () => {
    expect(code(() => openNoFollowSync(join(directory, "trailing."), "create", { platform: "win32" }))).toBe("path-form");
    expect(code(() => readNoFollowSync(join(directory, "NUL"), { platform: "win32" }))).toBe("path-form");
  });
});

describe.runIf(process.platform === "win32")("on Windows itself", () => {
  it("refuses a junction exactly where it refuses a symlink", async () => {
    const target = join(directory, "target");
    mkdirSync(target);
    writeFileSync(join(target, "file"), "x");
    const junction = join(directory, "junction");
    symlinkSync(target, junction, "junction");
    expect(code(() => openDirectoryNoFollowSync(junction))).toBe("ELOOP");
    await expect(readNoFollow(junction)).rejects.toBeInstanceOf(NoFollowReadError);
  });
});
