import * as fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { createSnapshot, isPluginCache } from "../src/persistence/administration.js";
import { SqliteStore } from "../src/persistence/store.js";

/** A plugin worker's home in a backup: its data travels, its cache does not. */

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function temporary(prefix: string): string {
  return directories.create(prefix);
}

describe("a backup of plugins' worker homes", () => {
  it("copies a plugin's home data and version folders, and leaves its home/cache out", () => {
    const directory = temporary("tavi-snapshot-plugins-");
    new SqliteStore({ databasePath: join(directory, "tavi.sqlite") }).close();
    const plugin = join(directory, "plugins", "jobs.finder");
    fs.mkdirSync(join(plugin, "1.0.0"), { recursive: true });
    fs.writeFileSync(join(plugin, "1.0.0", "index.mjs"), "export {}");
    fs.mkdirSync(join(plugin, "home", "cache", "adzuna"), { recursive: true });
    fs.writeFileSync(join(plugin, "home", "jobs.db"), "the person's pipeline");
    fs.writeFileSync(join(plugin, "home", "cache", "adzuna", "page-1.json"), "{}");
    // Only the home's own cache folder is left out: a folder named cache elsewhere is data.
    fs.mkdirSync(join(plugin, "home", "notes", "cache"), { recursive: true });
    fs.writeFileSync(join(plugin, "home", "notes", "cache", "kept.txt"), "kept");
    const out = join(temporary("tavi-snapshot-out-"), "snap");
    const manifest = createSnapshot({
      dataDirectory: directory,
      outDirectory: out,
      buildId: "test",
      now: "2026-10-16T00:00:00.000Z",
      includeArtifacts: false,
      includeCredentials: false,
      force: false,
    });
    expect(manifest.includes.plugins).toBe(true);
    expect(manifest.excluded).toContain("plugins/*/home/cache/");
    const copied = join(out, "plugins", "jobs.finder");
    expect(fs.readFileSync(join(copied, "home", "jobs.db"), "utf8")).toBe("the person's pipeline");
    expect(fs.existsSync(join(copied, "1.0.0", "index.mjs"))).toBe(true);
    expect(fs.existsSync(join(copied, "home", "notes", "cache", "kept.txt"))).toBe(true);
    expect(fs.existsSync(join(copied, "home", "cache"))).toBe(false);
  });

  it("snapshots a plugin's SQLite store while its worker writes it, with what its WAL holds and no sidecar files", () => {
    const directory = temporary("tavi-snapshot-plugin-db-");
    new SqliteStore({ databasePath: join(directory, "tavi.sqlite") }).close();
    const home = join(directory, "plugins", "jobs.finder", "home");
    fs.mkdirSync(home, { recursive: true });
    // A writer still open, its rows only in the WAL (no checkpoint yet).
    const writer = new DatabaseSync(join(home, "jobs.db"));
    try {
      writer.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE applications (id TEXT); INSERT INTO applications VALUES ('a1'), ('a2');",
      );
      expect(fs.statSync(join(home, "jobs.db-wal")).size).toBeGreaterThan(0);
      const out = join(temporary("tavi-snapshot-out-"), "snap");
      createSnapshot({
        dataDirectory: directory,
        outDirectory: out,
        buildId: "test",
        now: "2026-10-16T00:00:00.000Z",
        includeArtifacts: false,
        includeCredentials: false,
        force: false,
      });
      const copied = join(out, "plugins", "jobs.finder", "home");
      expect(fs.existsSync(join(copied, "jobs.db-wal"))).toBe(false);
      expect(fs.existsSync(join(copied, "jobs.db-shm"))).toBe(false);
      const copy = new DatabaseSync(join(copied, "jobs.db"), { readOnly: true });
      try {
        expect(copy.prepare("SELECT id FROM applications ORDER BY id").all()).toEqual([{ id: "a1" }, { id: "a2" }]);
      } finally {
        copy.close();
      }
    } finally {
      writer.close();
    }
  });

  it("names only a plugin's home/cache and what is in it", () => {
    const plugins = "/data/plugins";
    expect(isPluginCache(plugins, "/data/plugins/jobs.finder/home/cache")).toBe(true);
    expect(isPluginCache(plugins, "/data/plugins/jobs.finder/home/cache/a/b.json")).toBe(true);
    expect(isPluginCache(plugins, "/data/plugins/jobs.finder/home")).toBe(false);
    expect(isPluginCache(plugins, "/data/plugins/jobs.finder/home/jobs.db")).toBe(false);
    expect(isPluginCache(plugins, "/data/plugins/jobs.finder/1.0.0/home/cache")).toBe(false);
    expect(isPluginCache(plugins, "/data/plugins")).toBe(false);
  });

  it("lists no plugin cache as left out when there are no plugins", () => {
    const directory = temporary("tavi-snapshot-noplugins-");
    new SqliteStore({ databasePath: join(directory, "tavi.sqlite") }).close();
    const manifest = createSnapshot({
      dataDirectory: directory,
      outDirectory: join(temporary("tavi-snapshot-out-"), "snap"),
      buildId: "test",
      now: "2026-10-16T00:00:00.000Z",
      includeArtifacts: false,
      includeCredentials: false,
      force: false,
    });
    expect(manifest.includes.plugins).toBe(false);
    expect(manifest.excluded).not.toContain("plugins/*/home/cache/");
  });
});
