import { join } from "node:path";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { APPLICATION_TABLES, SAVER_TABLES } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

const directories = temporaryDirectories();

afterEach(() => directories.cleanup());

describe("single-database ownership", () => {
  it("shares one database file with the pinned saver without a table collision", async () => {
    const directory = directories.create("tavi-ownership-");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });

    // Touching a saver table is what forces the pinned DDL to run.
    const saver = new SqliteSaver(store.handle);
    for await (const _ of saver.list({ configurable: { thread_id: "probe", checkpoint_ns: "" } })) {
      // no checkpoints yet
    }

    expect([...(await store.listSaverTables())].sort()).toEqual([...SAVER_TABLES].sort());
    expect(await store.listTables()).toEqual(expect.arrayContaining([...APPLICATION_TABLES]));
    // Ownership is disjoint: no saver table carries the application prefix.
    for (const table of SAVER_TABLES) expect(table.startsWith("tavi_")).toBe(false);
    store.close();
  });
});
