/**
 * The schema a fresh data directory gets, pinned: every `sqlite_master` entry
 * (type, name, table, SQL text) and the rows a fresh database already holds.
 *
 * A migration that changes the schema changes this snapshot, so the change is
 * reviewed as a diff of the resulting schema rather than inferred from the
 * migration's code — and a change nobody meant (a statement edited in
 * `baseline-schema.ts`, a migration that does more than it says) fails here.
 *
 * Regenerate after an intended change, then review the diff of
 * `test/fixtures/schema-snapshot.json`:
 *
 *   cd packages/runtime && npx vitest run test/schema-snapshot.test.ts -u
 *
 * Timestamps are masked. The FTS5 shadow tables are left out: SQLite derives
 * them from each FTS5 table (`FTS_TABLES`), and their text and rows belong to the SQLite
 * build, not to a migration. So are the `sqlite_stat*` tables: planner
 * statistics that `PRAGMA optimize` gathers on open, which change with the data.
 */
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { FTS_SHADOW_TABLES, MIGRATIONS } from "../src/persistence/migrations.js";
import { loadBetterSqlite3 } from "../src/persistence/sqlite-loader.js";
import { SqliteStore } from "../src/persistence/store.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

const TIMESTAMP_COLUMNS = new Set(["applied_at", "updated_at"]);

/** The FTS5 tables themselves: kept in the snapshot, with their `CREATE VIRTUAL TABLE` text, but their rows are not read. */
const FTS_TABLES = new Set<string>(["tavi_memory_fts", "tavi_memory_fts_stem", "tavi_task_history_fts"]);

it("a fresh store's schema and seed rows match the committed snapshot", async () => {
  const directory = directories.create("tavi-schema-");
  const databasePath = join(directory, "tavi.sqlite");
  new SqliteStore({ databasePath }).close();

  const db = new (loadBetterSqlite3())(databasePath, { readonly: true, fileMustExist: true });
  try {
    const shadow = new Set<string>(FTS_SHADOW_TABLES.filter((name) => !FTS_TABLES.has(name)));
    const objects = (
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as {
        type: string;
        name: string;
        tbl_name: string;
        sql: string | null;
      }[]
    ).filter((object) => !shadow.has(object.tbl_name) && !object.tbl_name.startsWith("sqlite_stat"));
    const rows: Record<string, unknown[]> = {};
    for (const { name } of objects.filter((object) => object.type === "table" && !FTS_TABLES.has(object.name))) {
      const tableRows = (db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [column, TIMESTAMP_COLUMNS.has(column) && value !== null ? "<timestamp>" : value]),
        ),
      );
      if (tableRows.length > 0) rows[name] = tableRows;
    }
    expect(rows["tavi_schema_migrations"]).toHaveLength(MIGRATIONS.length);
    // FTS5 options live in the shadow `*_config` tables the snapshot leaves out; secure-delete is pinned here (invariant 9).
    for (const table of FTS_TABLES) {
      expect(db.prepare(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`).get()).toEqual({ v: 1 });
    }
    await expect(`${JSON.stringify({ objects, rows }, null, 2)}\n`).toMatchFileSnapshot("./fixtures/schema-snapshot.json");
  } finally {
    db.close();
  }
});
