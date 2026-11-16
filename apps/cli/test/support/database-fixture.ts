import { join } from "node:path";
import { afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient, type OpenDatabaseOptions } from "@tavi/runtime";
import { SqliteStore as InternalStore } from "../../../../packages/runtime/src/persistence/store.js";
import { loadBetterSqlite3, type Database } from "../../../../packages/runtime/src/persistence/sqlite-loader.js";

const directories = temporaryDirectories({ prefix: "tavi-async-fixture-" });
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  directories.cleanup();
});

/** Independent SQL inspection is confined to fixtures that inject or verify durable faults. */
export function inspectDatabase(client: DatabaseClient): Database {
  if (client.databasePath === ":memory:") throw new Error("SQL inspection requires a file-backed fixture");
  const db = new (loadBetterSqlite3())(client.databasePath);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  return db;
}

export type SqliteStore = DatabaseClient & Pick<InternalStore, "handle" | "transaction" | "transactionImmediate">;
export const SqliteStore = {
  async open(options: OpenDatabaseOptions): Promise<SqliteStore> {
    const directory = options.inMemory === true || options.databasePath === ":memory:" ? directories.create() : undefined;
    const { inMemory: _inMemory, ...fileOptions } = options;
    const client = await DatabaseClient.open({
      ...fileOptions,
      databasePath: directory === undefined ? options.databasePath : join(directory, "db.sqlite"),
    });
    const sql = new InternalStore({ ...fileOptions, databasePath: client.databasePath });
    const originalClose = client.close.bind(client);
    const close = async (): Promise<void> => {
      sql.close();
      await originalClose();
    };
    cleanup.push(close);
    return Object.assign(client, {
      handle: sql.handle,
      transaction: sql.transaction.bind(sql),
      transactionImmediate: sql.transactionImmediate.bind(sql),
      close,
    });
  },
};
