import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTemporaryDirectories, temporaryDirectories, temporaryDirectory, type TemporaryDirectories } from "../src/temporary.js";

/** Directories whose removal a test makes fail: `rmSync` refuses them until they are taken off the list. */
const refused = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (path: string, options?: Parameters<typeof actual.rmSync>[1]) => {
      if (refused.has(path)) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: "EBUSY" });
      actual.rmSync(path, options);
    },
  };
});

const lists: TemporaryDirectories[] = [];
function list(options: Parameters<typeof temporaryDirectories>[0] = {}): TemporaryDirectories {
  const made = temporaryDirectories(options);
  lists.push(made);
  return made;
}

afterEach(() => {
  refused.clear();
  vi.restoreAllMocks();
  while (lists.length > 0) lists.pop()?.cleanup();
  removeTemporaryDirectories();
});

describe("temporaryDirectories", () => {
  it("creates owner-only directories under the system temporary directory, named by the prefix", () => {
    const temporary = list();
    const made = temporary.create("tavi-support-");
    expect(dirname(made)).toBe(tmpdir().replace(/\/$/, ""));
    expect(basename(made)).toMatch(/^tavi-support-.{6}$/);
    expect(statSync(made).mode & 0o777).toBe(0o700);
    expect(basename(temporary.create())).toMatch(/^tavi-test-/);
  });

  it("applies a mode, its own or the list's", () => {
    const temporary = list({ mode: 0o750, prefix: "tavi-mode-" });
    expect(statSync(temporary.create()).mode & 0o777).toBe(0o750);
    expect(statSync(temporary.create(undefined, { mode: 0o711 })).mode & 0o777).toBe(0o711);
  });

  it("removes every directory it made, contents and all, and only those", () => {
    const temporary = list();
    const first = temporary.create("tavi-cleanup-");
    const second = temporary.create("tavi-cleanup-");
    writeFileSync(join(first, "file.txt"), "kept until cleanup");
    expect(temporary.paths).toEqual([first, second]);
    temporary.cleanup();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(temporary.paths).toEqual([]);
    // Cleaning again is a no-op, and a directory removed already is not an error.
    const third = temporary.create("tavi-cleanup-");
    temporary.cleanup();
    temporary.cleanup();
    expect(existsSync(third)).toBe(false);
  });

  it("removes the rest when one cannot be, then throws naming the failures", () => {
    const temporary = list();
    const stuck = temporary.create("tavi-stuck-");
    const other = temporary.create("tavi-stuck-");
    refused.add(stuck);
    let thrown: unknown;
    try {
      temporary.cleanup();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe("1 temporary directory could not be removed");
    expect((thrown as AggregateError).errors.map(String)).toEqual([expect.stringContaining(stuck)]);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(stuck)).toBe(true);
    // Off the list once tried: removed after the test by hand.
    expect(temporary.paths).toEqual([]);
    lists.push({ paths: [], create: () => stuck, cleanup: () => removeDirectory(stuck) });
  });

  it("only warns about leftovers when asked to", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const temporary = list({ leftovers: "warn" });
    const stuck = temporary.create("tavi-warned-");
    refused.add(stuck);
    expect(() => temporary.cleanup()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`temporary directory left behind: ${stuck}`));
    lists.push({ paths: [], create: () => stuck, cleanup: () => removeDirectory(stuck) });
  });

  it("keeps the module's own list for temporaryDirectory, which only warns", () => {
    const made = temporaryDirectory("tavi-shared-", 0o700);
    expect(existsSync(made)).toBe(true);
    removeTemporaryDirectories();
    expect(existsSync(made)).toBe(false);
  });
});

/** Removes `path` with a fresh list's cleanup, once `rmSync` no longer refuses it. */
function removeDirectory(path: string): void {
  refused.delete(path);
  const sweep = temporaryDirectories();
  (sweep.paths as string[]).push(path);
  sweep.cleanup();
}
