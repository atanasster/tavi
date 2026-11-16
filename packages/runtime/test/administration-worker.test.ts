import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../src/persistence/store.js";
import { createSnapshot, exportTables, readRecordedOwner } from "../src/persistence/administration-client.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});
function fixture() {
  const directory = directories.create("tavi-admin-worker-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite") });
  store.setMeta("fixture", "retained", "2026-09-28T00:00:00.000Z");
  store.close();
  return directory;
}

it("reports row counts from the completed SQLite snapshot and omits owner state", async () => {
  const directory = fixture();
  // Snapshot output must be outside the source directory.
  const external = directories.create("tavi-admin-snapshot-");
  const manifest = await createSnapshot({
    dataDirectory: directory,
    outDirectory: external,
    buildId: "test",
    now: nowTimestamp(),
    includeArtifacts: false,
    includeCredentials: false,
    force: false,
  });
  const db = new Database(join(external, "tavi.sqlite"), { readonly: true });
  try {
    for (const table of manifest.applicationTables)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()).toEqual({ n: manifest.rowCounts[table] });
  } finally {
    db.close();
  }
  expect(manifest.excluded).toContain("owner.process.json");
});

it("exports tables through a worker without opening or migrating the source on the caller", async () => {
  const directory = fixture();
  const external = directories.create("tavi-admin-export-");
  const exported = await exportTables({ dataDirectory: directory, outDirectory: external, force: false });
  const meta = exported.files.find((file) => file.table === "tavi_meta");
  expect(meta).toBeDefined();
  const body = readFileSync(join(external, "tavi_meta.ndjson"), "utf8");
  expect(body).toContain('"retained"');
  expect(Buffer.byteLength(body)).toBe(meta?.bytes);
});

it("reads the recorded owner through the administration worker", async () => {
  const directory = fixture();
  expect(await readRecordedOwner(directory)).toBeNull();
  const db = new Database(join(directory, "owner.lock"));
  db.exec("CREATE TABLE tavi_owner(session_id TEXT,pid INTEGER,acquired_at TEXT)");
  db.prepare("INSERT INTO tavi_owner VALUES(?,?,?)").run("owner", 123, "2026-09-28T00:00:00.000Z");
  db.close();
  expect(await readRecordedOwner(directory)).toEqual({ session_id: "owner", pid: 123, acquired_at: "2026-09-28T00:00:00.000Z" });
});

it("returns an unavailable owner observation without waiting for the live owner's lock", async () => {
  const directory = fixture();
  const holder = new Database(join(directory, "owner.lock"));
  holder.exec("CREATE TABLE tavi_owner(session_id TEXT,pid INTEGER,acquired_at TEXT); BEGIN EXCLUSIVE");
  try {
    expect(await readRecordedOwner(directory)).toBeNull();
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
}, 2_000);
