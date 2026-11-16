import { DatabaseSync } from "node:sqlite";

/**
 * A domain plugin's own store (jobs, places, trends): one
 * SQLite file in its worker home, opened with `node:sqlite`, its schema
 * version in `PRAGMA user_version`. Migrations run forward only, each in its
 * own transaction, so a store is always at one version or the next.
 */
export interface DomainMigration {
  /** 1, 2, 3…: each migration's version is the one before it plus one. */
  readonly version: number;
  readonly sql: string;
}

/** The store's schema version, 0 for a new file. */
export function storeVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { readonly user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Brings `db` to the last of `migrations`. Refuses a list that skips or
 * repeats a version, and a store a newer plugin version wrote (its version
 * past the last one known here): that store is left as it is.
 */
export function migrate(db: DatabaseSync, migrations: readonly DomainMigration[]): number {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error(`migration ${String(index + 1)} is numbered ${String(migration.version)}: versions run 1, 2, 3… with none skipped`);
  }
  const latest = migrations.length;
  const current = storeVersion(db);
  if (current > latest)
    throw new Error(`the store is at version ${String(current)}, past this plugin's ${String(latest)}: a newer version wrote it`);
  for (const migration of migrations.slice(current)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      // `user_version` takes no bound parameter; the version is an integer this module checked.
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return latest;
}

/** Opens (creating it if needed) the store at `path` and migrates it. */
export function openDomainStore(path: string, migrations: readonly DomainMigration[]): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
