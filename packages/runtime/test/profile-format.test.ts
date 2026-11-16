import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../src/persistence/store.js";
import { loadBetterSqlite3 } from "../src/persistence/sqlite-loader.js";
import { PROFILE_FORMAT, PROFILE_FORMAT_KEY } from "../src/persistence/profile-format.js";
import { MIGRATIONS } from "../src/persistence/migrations.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});
function path() {
  const directory = directories.create("tavi-format-");
  return join(directory, "tavi.sqlite");
}

it("refuses unversioned data before migration without changing its bytes", () => {
  const databasePath = path();
  const Database = loadBetterSqlite3();
  const old = new Database(databasePath);
  old.exec("CREATE TABLE old_data (value TEXT); INSERT INTO old_data VALUES ('preserve me');");
  old.close();
  const before = readFileSync(databasePath);
  expect(() => new SqliteStore({ databasePath })).toThrow(/separate data directory/);
  expect(readFileSync(databasePath)).toEqual(before);
});

it("reopens the versioned profile and refuses an unsupported format", () => {
  const databasePath = path();
  new SqliteStore({ databasePath }).close();
  const reopened = new SqliteStore({ databasePath });
  expect(reopened.getMeta(PROFILE_FORMAT_KEY)).toBe(PROFILE_FORMAT);
  reopened.setMeta(PROFILE_FORMAT_KEY, "future", nowTimestamp());
  reopened.close();
  const before = readFileSync(databasePath);
  expect(() => new SqliteStore({ databasePath })).toThrow(/Unsupported data profile/);
  expect(readFileSync(databasePath)).toEqual(before);
});

it("opens a new profile whose first run was interrupted mid-migration", () => {
  const databasePath = path();
  const interrupted = MIGRATIONS[Math.floor(MIGRATIONS.length / 2)]!;
  const failing = vi.spyOn(interrupted, "up").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  try {
    expect(() => new SqliteStore({ databasePath })).toThrow(/disk full/);
  } finally {
    failing.mockRestore();
  }
  const reopened = new SqliteStore({ databasePath });
  expect(reopened.getMeta(PROFILE_FORMAT_KEY)).toBe(PROFILE_FORMAT);
  reopened.close();
});

it("opens an empty database file as a new profile", () => {
  const databasePath = path();
  writeFileSync(databasePath, "");
  const opened = new SqliteStore({ databasePath });
  expect(opened.getMeta(PROFILE_FORMAT_KEY)).toBe(PROFILE_FORMAT);
  opened.close();
});
