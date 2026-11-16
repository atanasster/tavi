import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../../packages/runtime/src/persistence/store.js";

export interface DatabaseBaseline {
  readonly databasePath: string;
  readonly directory: string;
  connect(): Database.Database;
  saver(): SqliteSaver;
  application(): SqliteStore;
  close(): void;
}

/** File-backed fixture: independent connections observe the same WAL database. */
export function databaseBaseline(): DatabaseBaseline {
  const directory = mkdtempSync(join(tmpdir(), "tavi-db-baseline-"));
  const databasePath = join(directory, "fixture.sqlite");
  const connections: Database.Database[] = [];
  const stores: SqliteStore[] = [];
  const connect = () => {
    const db = new Database(databasePath);
    connections.push(db);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 0");
    return db;
  };
  return {
    databasePath,
    directory,
    connect,
    saver: () => new SqliteSaver(connect()),
    application() {
      const store = new SqliteStore({ databasePath, artifactsDirectory: join(directory, "artifacts") });
      stores.push(store);
      return store;
    },
    close() {
      for (const store of stores.reverse()) store.close();
      for (const db of connections.reverse()) if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Serialized shape accepted by the pinned SQLite saver, including binary values. */
export function baselineCheckpoint(id: string) {
  return {
    v: 4,
    id,
    ts: "2026-09-28T00:00:00.000Z",
    channel_values: { messages: ["baseline"], bytes: new Uint8Array([0, 127, 255]) },
    channel_versions: { messages: "1", bytes: "1" },
    versions_seen: {},
  };
}
