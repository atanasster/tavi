import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { createSnapshot } from "../src/persistence/administration.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * A backup taken while chats run: a chat's shell
 * may remove a file between the copy's listing and its copy of that file.
 * The names below make the wrapped calls remove the file first, as such a
 * shell would, or fail the way an unreadable file does.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const removeFirst = (path: fs.PathLike, name: string): void => {
    if (String(path).endsWith(name)) actual.rmSync(path, { force: true });
  };
  return {
    ...actual,
    lstatSync: vi.fn((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      removeFirst(path, "gone-before-stat.txt");
      return actual.lstatSync(path, options);
    }),
    openSync: vi.fn((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      removeFirst(path, "gone-before-copy.txt");
      if (String(path).endsWith("unreadable.txt")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      // A shell swapping the entry between its look and its copy: for a link, a FIFO or a plain file.
      const swapped = swaps.get(String(path));
      if (swapped !== undefined) {
        swaps.delete(String(path));
        actual.rmSync(swapped.replace, { recursive: true, force: true });
        if (swapped.with === "fifo") execFileSync("mkfifo", [swapped.replace]);
        else if (swapped.with === "file") actual.writeFileSync(swapped.replace, "a file now");
        else actual.symlinkSync(swapped.with, swapped.replace);
      }
      return actual.openSync(path, flags, mode);
    }),
  };
});

/** The entries a "shell" swaps for a link to `with` (or a FIFO, or a plain file) just before the backup opens `path`. */
const swaps = new Map<string, { readonly replace: string; readonly with: string }>();

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function temporary(prefix: string): string {
  return directories.create(prefix);
}

/** A data directory with a database and one chat's folder holding the named files. */
function dataDirectory(files: readonly string[]): { readonly directory: string; readonly folder: string } {
  const directory = temporary("tavi-snapshot-chats-");
  new SqliteStore({ databasePath: join(directory, "tavi.sqlite") }).close();
  const folder = join(directory, "chats", "default", "t1");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const name of ["kept.txt", ...files]) fs.writeFileSync(join(folder, name), name);
  return { directory, folder };
}

const snapshot = (directory: string, out: string) =>
  createSnapshot({
    dataDirectory: directory,
    outDirectory: out,
    buildId: "test",
    now: "2026-10-10T00:00:00.000Z",
    includeArtifacts: false,
    includeCredentials: false,
    force: false,
  });

describe("a backup of the chats' folders while chats run", () => {
  it("skips a file removed before it is looked at or copied, and copies the rest", () => {
    const { directory } = dataDirectory(["gone-before-stat.txt", "gone-before-copy.txt"]);
    const out = join(temporary("tavi-snapshot-out-"), "snap");
    const manifest = snapshot(directory, out);
    expect(manifest.includes.chats).toBe(true);
    expect(fs.readdirSync(join(out, "chats", "default", "t1")).sort()).toEqual(["kept.txt"]);
    expect(fs.existsSync(join(out, "manifest.json"))).toBe(true);
  });

  it("still fails on any other error, writing no manifest", () => {
    const { directory } = dataDirectory(["unreadable.txt"]);
    const out = join(temporary("tavi-snapshot-out-"), "snap");
    expect(() => snapshot(directory, out)).toThrow(/permission denied/);
    expect(fs.existsSync(join(out, "manifest.json"))).toBe(false);
  });

  it("never copies what a link swapped in between an entry's look and its copy points at, a file's or a folder's (I-nofollow)", () => {
    const { directory, folder } = dataDirectory(["notes.txt"]);
    fs.mkdirSync(join(folder, "sub"));
    fs.writeFileSync(join(folder, "sub", "inner.txt"), "the chat's");
    const secrets = temporary("tavi-snapshot-secret-");
    fs.writeFileSync(join(secrets, "id_ed25519"), "SECRET KEY");
    fs.writeFileSync(join(secrets, "inner.txt"), "SECRET INNER");
    const real = fs.realpathSync.native(folder);
    // The file itself, then a folder above a file: each swapped once its entry was looked at.
    swaps.set(join(real, "notes.txt"), { replace: join(real, "notes.txt"), with: join(secrets, "id_ed25519") });
    swaps.set(join(real, "sub", "inner.txt"), { replace: join(real, "sub"), with: secrets });
    const out = join(temporary("tavi-snapshot-out-"), "snap");
    snapshot(directory, out);
    expect(swaps.size).toBe(0);
    const copied = fs.readdirSync(join(out, "chats"), { recursive: true }).map(String);
    for (const name of copied) {
      const path = join(out, "chats", name);
      if (fs.lstatSync(path).isFile()) expect(fs.readFileSync(path, "utf8"), name).not.toMatch(/SECRET/);
    }
    expect(fs.readFileSync(join(out, "chats", "default", "t1", "kept.txt"), "utf8")).toBe("kept.txt");
  });

  it("skips a file swapped for a FIFO, never waiting on it, and a folder swapped for a file, copying the rest", () => {
    const { directory, folder } = dataDirectory(["piped.txt"]);
    fs.mkdirSync(join(folder, "sub"));
    fs.writeFileSync(join(folder, "sub", "inner.txt"), "the chat's");
    const real = fs.realpathSync.native(folder);
    swaps.set(join(real, "piped.txt"), { replace: join(real, "piped.txt"), with: "fifo" });
    swaps.set(join(real, "sub"), { replace: join(real, "sub"), with: "file" });
    const out = join(temporary("tavi-snapshot-out-"), "snap");
    expect(snapshot(directory, out).includes.chats).toBe(true);
    expect(swaps.size).toBe(0);
    expect(fs.readdirSync(join(out, "chats", "default", "t1")).sort()).toEqual(["kept.txt"]);
  });
});
