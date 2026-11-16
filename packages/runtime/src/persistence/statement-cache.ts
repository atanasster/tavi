import type BetterSqlite3 from "better-sqlite3";

import type { Database } from "./sqlite-loader.js";

/** What `db.prepare(sql)` returns with no type arguments. */
type Statement = BetterSqlite3.Statement<unknown[]>;

/**
 * At most this many statements are kept per connection; the least recently
 * used goes first. The repositories that use the cache hold about two hundred
 * fixed SQL strings, so the bound only bites if dynamic SQL is passed by mistake.
 */
export const STATEMENT_CACHE_LIMIT = 512;

/** Per connection, so a closed or replaced handle takes its statements with it. */
const caches = new WeakMap<Database, Map<string, Statement>>();

/**
 * A prepared statement for `sql` on `db`, prepared once per connection.
 *
 * For fixed SQL only: text that is a literal, or built from module constants
 * or a choice between a few literals. SQL whose text varies with the input (an
 * `IN (…)` list sized by its values) keeps calling `db.prepare`, or it would
 * churn the cache.
 *
 * A cached statement is shared, so callers never change its mode (`pluck`,
 * `raw`, `expand`, `safeIntegers`, `bind`). A statement that is busy — an
 * outer `.iterate()` still walking it — is not reentrant, so a call that
 * meets one gets a fresh, uncached statement instead.
 */
export function stmt(db: Database, sql: string): Statement {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  const cached = cache.get(sql);
  if (cached !== undefined) {
    if (cached.busy) return db.prepare(sql);
    // Map order is insertion order: move the hit to the end, so eviction takes the least recently used.
    cache.delete(sql);
    cache.set(sql, cached);
    return cached;
  }
  const statement = db.prepare(sql);
  if (cache.size >= STATEMENT_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(sql, statement);
  return statement;
}

/** Forgets `db`'s statements; called when the connection closes. */
export function clearStatements(db: Database): void {
  caches.delete(db);
}

/** How many statements `db` holds (tests). */
export function cachedStatementCount(db: Database): number {
  return caches.get(db)?.size ?? 0;
}
