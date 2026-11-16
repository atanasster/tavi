import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { DatabaseClient } from "../src/persistence/client.js";

const clients: DatabaseClient[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  directories.cleanup();
});

it("keeps a thread's newest checkpoints and their writes, and lets the older go", async () => {
  const directory = directories.create("tavi-prune-");
  const db = await DatabaseClient.open({ databasePath: join(directory, "db.sqlite") });
  clients.push(db);
  for (let index = 0; index < 5; index += 1) {
    const checkpointId = `c${index}`;
    await db.checkpoints.put({
      threadId: "t",
      namespace: "",
      checkpointId,
      parentId: index === 0 ? null : `c${index - 1}`,
      type: "json",
      checkpoint: Buffer.from(`{"n":${index}}`),
      metadata: Buffer.from("{}"),
    });
    await db.checkpoints.putWrites({
      threadId: "t",
      namespace: "",
      checkpointId,
      replace: false,
      writes: [{ taskId: "x", index: 0, channel: "c", type: "json", value: Buffer.from("1") }],
    });
  }
  await db.checkpoints.put({
    threadId: "other",
    namespace: "",
    checkpointId: "c0",
    parentId: null,
    type: "json",
    checkpoint: Buffer.from("{}"),
    metadata: Buffer.from("{}"),
  });
  expect(await db.checkpoints.pruneThread({ threadId: "t", keep: 2 })).toBe(3);
  const cursor = await db.checkpoints.openCursor({ threadId: "t" });
  try {
    const page = await db.checkpoints.nextCursor(cursor);
    expect(page.rows.map((row) => row.checkpointId)).toEqual(["c4", "c3"]);
    expect(page.rows.every((row) => row.writes.length === 1)).toBe(true);
  } finally {
    await db.checkpoints.closeCursor(cursor);
  }
  expect((await db.checkpoints.get({ threadId: "t", namespace: "" }))?.checkpointId).toBe("c4");
  expect(await db.checkpoints.get({ threadId: "other", namespace: "" })).toBeDefined();
  expect(await db.checkpoints.pruneThread({ threadId: "t", keep: 2 })).toBe(0);
});
