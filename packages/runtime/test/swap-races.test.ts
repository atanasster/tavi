import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyScratch, removeTreeSync } from "../src/folder-retention.js";
import { hashPluginDirectory } from "../src/plugins/registry.js";

/**
 * A folder swapped for a link in the window between a check and the open
 * that follows it (I-nofollow). The swap is made from inside that window:
 * the open of the named path, here the only seam, runs it first, once.
 */

const swaps = new Map<string, () => void>();
const swapBefore = (path: string): void => {
  const swap = swaps.get(path);
  swaps.delete(path);
  swap?.();
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((path: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
    swapBefore(String(path));
    return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = ((path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    swapBefore(String(path));
    return (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(path, ...rest);
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  swaps.clear();
  while (cleanups.length > 0) cleanups.pop()?.();
});

function directory(prefix: string): string {
  const created = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => {
    chmodSync(created, 0o700);
    rmSync(created, { recursive: true, force: true });
  });
  return created;
}

/** A read-only folder with a file in it, as Go leaves its module cache: removing the file needs its folder made writable first. */
function readOnlyFolder(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "f.txt"), "x");
  chmodSync(path, 0o555);
}

/** The owner's folder a swapped-in link points at: read-only, and it must stay so. */
function ownersFolder(base: string): string {
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "the owner's");
  chmodSync(outside, 0o555);
  cleanups.push(() => chmodSync(outside, 0o700));
  return outside;
}

/** Swap `folder` for a link to `target` when it is next opened: the window between its check and making it writable. */
function swapForLinkOnOpen(folder: string, target: string): void {
  swaps.set(folder, () => {
    chmodSync(folder, 0o700);
    renameSync(folder, `${folder}-moved`);
    symlinkSync(target, folder);
  });
}

describe("making a folder writable to empty it (I-nofollow)", () => {
  it("never changes the mode of what a link swapped in for the folder points at, emptying .tmp/", async () => {
    const base = directory("tavi-swap-scratch-");
    const managed = join(base, "managed");
    const stuck = join(managed, ".tmp", "go-mod");
    readOnlyFolder(stuck);
    const outside = ownersFolder(base);
    swapForLinkOnOpen(stuck, outside);
    const failed = await emptyScratch(managed);
    expect(swaps.size).toBe(0);
    expect(failed.join("\n")).toMatch(/go-mod/);
    expect(statSync(outside).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("the owner's");
  });

  it("never changes the mode of what a link swapped in for the folder points at, removing a tree (reset, backup --force)", () => {
    const base = directory("tavi-swap-tree-");
    const tree = join(base, "chats");
    const stuck = join(tree, "default", "task-a", ".home", "go-mod");
    readOnlyFolder(stuck);
    const outside = ownersFolder(base);
    swapForLinkOnOpen(stuck, outside);
    expect(() => removeTreeSync(tree)).toThrow(/go-mod/);
    expect(swaps.size).toBe(0);
    expect(statSync(outside).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("the owner's");
  });
});

describe("reading a plugin's folder (plugins.validate)", () => {
  it("refuses a file whose folder was swapped for a link after the walk listed it, and reads nothing through the link", () => {
    const base = directory("tavi-swap-plugin-");
    const plugin = join(base, "plugin");
    mkdirSync(join(plugin, "lib"), { recursive: true });
    writeFileSync(join(plugin, "lib", "index.mjs"), "export default {};\n");
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "index.mjs"), "the owner's secret");
    swaps.set(join(plugin, "lib", "index.mjs"), () => {
      renameSync(join(plugin, "lib"), join(plugin, "lib-moved"));
      symlinkSync(outside, join(plugin, "lib"));
    });
    expect(() => hashPluginDirectory(plugin)).toThrow(/lib\/index\.mjs changed while it was being read/);
    expect(swaps.size).toBe(0);
    expect(existsSync(join(plugin, "lib-moved", "index.mjs"))).toBe(true);
  });
});
