import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { DatabaseClient } from "../src/persistence/client.js";
import { loadBetterSqlite3 } from "../src/persistence/sqlite-loader.js";

const clients: DatabaseClient[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  directories.cleanup();
});

async function open() {
  const databasePath = join(directories.create("tavi-blobs-"), "db.sqlite");
  const db = await DatabaseClient.open({ databasePath });
  clients.push(db);
  const blobs = (threadId: string) => {
    const native = new (loadBetterSqlite3())(databasePath, { readonly: true });
    try {
      return (
        native
          .prepare("SELECT channel, version FROM tavi_checkpoint_blobs WHERE thread_id = ? ORDER BY channel, version")
          .all(threadId) as { channel: string; version: string }[]
      ).map((row) => `${row.channel}@${row.version}`);
    } finally {
      native.close();
    }
  };
  return { db, blobs };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
/** A per-channel body: the checkpoint without `channel_values`, naming the channels that hold one. */
const body = (id: string, versions: Record<string, number>, channels = Object.keys(versions)) =>
  json({ v: 4, id, ts: "2026-10-29T00:00:00.000Z", channel_versions: versions, versions_seen: {}, tavi_blobs: channels });
const blob = (channel: string, version: number, value: unknown) => ({
  channel,
  version: String(version),
  type: "json",
  value: json(value),
});
const row = (threadId: string, checkpointId: string, parentId: string | null) => ({
  threadId,
  namespace: "",
  checkpointId,
  parentId,
  type: "json",
  metadata: json({ source: "loop", step: 1 }),
});
const values = (checkpoint: Uint8Array) =>
  (JSON.parse(Buffer.from(checkpoint).toString("utf8")) as { channel_values: unknown; tavi_blobs?: unknown }).channel_values;

it("stores each channel once per version and rejoins them on every read", async () => {
  const { db, blobs } = await open();
  await db.checkpoints.put({
    ...row("t", "c1", null),
    checkpoint: body("c1", { messages: 1, phase: 1 }),
    blobs: [blob("messages", 1, ["hi"]), blob("phase", 1, "model")],
  });
  // Only the changed channel travels; the unchanged one is rejoined from the parent's version.
  expect(
    await db.checkpoints.put({
      ...row("t", "c2", "c1"),
      checkpoint: body("c2", { messages: 2, phase: 1 }),
      blobs: [blob("messages", 2, ["hi", "there"])],
    }),
  ).toBeUndefined();
  expect(blobs("t")).toEqual(["messages@1", "messages@2", "phase@1"]);
  const latest = await db.checkpoints.get({ threadId: "t", namespace: "" });
  expect(latest?.type).toBe("json");
  expect(JSON.parse(Buffer.from(latest?.checkpoint ?? []).toString("utf8"))).toEqual({
    v: 4,
    id: "c2",
    ts: "2026-10-29T00:00:00.000Z",
    channel_versions: { messages: 2, phase: 1 },
    versions_seen: {},
    channel_values: { messages: ["hi", "there"], phase: "model" },
  });
  const cursor = await db.checkpoints.openCursor({ threadId: "t" });
  const page = await db.checkpoints.nextCursor(cursor);
  expect(page.rows.map((tuple) => values(tuple.checkpoint))).toEqual([
    { messages: ["hi", "there"], phase: "model" },
    { messages: ["hi"], phase: "model" },
  ]);
});

it("answers the channels it does not hold at their version and writes nothing until they are carried", async () => {
  const { db, blobs } = await open();
  // An inline parent (another saver, or the flag off) leaves no values behind in the blob table.
  await db.checkpoints.put({ ...row("t", "c1", null), checkpoint: json({ v: 4, id: "c1", channel_values: { phase: "model" } }) });
  const next = { ...row("t", "c2", "c1"), checkpoint: body("c2", { messages: 2, phase: 1 }), blobs: [blob("messages", 2, ["x"])] };
  expect(await db.checkpoints.put(next)).toEqual({ missing: ["phase"] });
  expect(blobs("t")).toEqual([]);
  expect((await db.checkpoints.get({ threadId: "t", namespace: "" }))?.checkpointId).toBe("c1");
  expect(await db.checkpoints.put({ ...next, blobs: [...next.blobs, blob("phase", 1, "model")] })).toBeUndefined();
  expect(values((await db.checkpoints.get({ threadId: "t", namespace: "" }))?.checkpoint ?? Buffer.from("{}"))).toEqual({
    messages: ["x"],
    phase: "model",
  });
  // A channel without a value at all (`tavi_blobs` leaves it out) needs nothing stored.
  expect(
    await db.checkpoints.put({ ...row("t", "c3", "c2"), checkpoint: body("c3", { messages: 2, phase: 3 }, ["messages"]), blobs: [] }),
  ).toBeUndefined();
  expect(values((await db.checkpoints.get({ threadId: "t", namespace: "" }))?.checkpoint ?? Buffer.from("{}"))).toEqual({
    messages: ["x"],
  });
  await expect(db.checkpoints.put({ ...row("t", "c4", "c3"), checkpoint: json({ id: "c4" }), blobs: [] })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});

it("prunes the values no kept checkpoint names, and deleting the thread takes them all", async () => {
  const { db, blobs } = await open();
  await db.checkpoints.put({
    ...row("t", "c0", null),
    checkpoint: body("c0", { messages: 0, phase: 0 }),
    blobs: [blob("messages", 0, []), blob("phase", 0, "model")],
  });
  for (let index = 1; index < 5; index += 1)
    await db.checkpoints.put({
      ...row("t", `c${index}`, `c${index - 1}`),
      checkpoint: body(`c${index}`, { messages: index, phase: 0 }),
      blobs: [blob("messages", index, [index])],
    });
  await db.checkpoints.put({ ...row("other", "c0", null), checkpoint: body("c0", { messages: 0 }), blobs: [blob("messages", 0, [])] });
  expect(await db.checkpoints.pruneThread({ threadId: "t", keep: 2 })).toBe(3);
  // The kept checkpoints still name `phase` at the version the first one stored.
  expect(blobs("t")).toEqual(["messages@3", "messages@4", "phase@0"]);
  expect(values((await db.checkpoints.get({ threadId: "t", namespace: "", checkpointId: "c3" }))?.checkpoint ?? Buffer.from("{}"))).toEqual(
    {
      messages: [3],
      phase: "model",
    },
  );
  await db.checkpoints.deleteThread("t");
  expect(blobs("t")).toEqual([]);
  expect(blobs("other")).toEqual(["messages@0"]);
});
