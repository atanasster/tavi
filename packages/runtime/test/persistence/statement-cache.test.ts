import { describe, expect, it } from "vitest";

import { loadBetterSqlite3 } from "../../src/persistence/sqlite-loader.js";
import { cachedStatementCount, STATEMENT_CACHE_LIMIT, stmt } from "../../src/persistence/statement-cache.js";
import { SqliteStore } from "../../src/persistence/store.js";

/** The prepared-statement cache: one statement per connection and SQL text. */

function database() {
  const db = new (loadBetterSqlite3())(":memory:");
  db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3);");
  return db;
}

describe("stmt", () => {
  it("prepares a SQL text once per connection", () => {
    const db = database();
    const other = database();
    const first = stmt(db, "SELECT n FROM t WHERE n = ?");
    expect(stmt(db, "SELECT n FROM t WHERE n = ?")).toBe(first);
    expect(stmt(other, "SELECT n FROM t WHERE n = ?")).not.toBe(first);
    expect(first.get(2)).toEqual({ n: 2 });
    db.close();
    other.close();
  });

  it("hands a fresh statement to a call that meets one still being iterated", () => {
    const db = database();
    const sql = "SELECT n FROM t ORDER BY n";
    const outer = stmt(db, sql);
    const seen: number[] = [];
    for (const row of outer.iterate() as IterableIterator<{ n: number }>) {
      const inner = stmt(db, sql);
      expect(inner).not.toBe(outer);
      seen.push(row.n, (inner.all() as { n: number }[]).length);
    }
    expect(seen).toEqual([1, 3, 2, 3, 3, 3]);
    // The busy one stays cached, and is reused once the walk is over.
    expect(stmt(db, sql)).toBe(outer);
    db.close();
  });

  it("keeps at most the limit, dropping the least recently used", () => {
    const db = database();
    const kept = stmt(db, "SELECT 0");
    for (let index = 1; index < STATEMENT_CACHE_LIMIT; index += 1) stmt(db, `SELECT ${index}`);
    expect(cachedStatementCount(db)).toBe(STATEMENT_CACHE_LIMIT);
    // Touching the oldest makes `SELECT 1` the next to go.
    expect(stmt(db, "SELECT 0")).toBe(kept);
    const second = stmt(db, "SELECT 2");
    stmt(db, "SELECT -1");
    expect(cachedStatementCount(db)).toBe(STATEMENT_CACHE_LIMIT);
    expect(stmt(db, "SELECT 0")).toBe(kept);
    expect(stmt(db, "SELECT 2")).toBe(second);
    db.close();
  });

  it("is cleared when the store closes", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    store.getTask("missing");
    store.listTasks(5);
    expect(cachedStatementCount(store.handle)).toBe(2);
    store.getTask("missing");
    expect(cachedStatementCount(store.handle)).toBe(2);
    store.close();
    expect(cachedStatementCount(store.handle)).toBe(0);
  });
});
