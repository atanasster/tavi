import { join } from "node:path";
import { serialize } from "node:v8";
import { afterEach, expect, it } from "vitest";
import { sha256Hex } from "@tavi/node-kit";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient } from "../src/persistence/client.js";
import { SqliteStore } from "../src/persistence/store.js";
const digest = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : sha256Hex(bytes));
const clients: DatabaseClient[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  directories.cleanup();
});
async function open() {
  const directory = directories.create("tavi-large-test-");
  const client = await DatabaseClient.open({ databasePath: join(directory, "db.sqlite") });
  clients.push(client);
  return client;
}
it("publishes and reads bytes larger than both RPC budgets, including existing artifacts", async () => {
  const db = await open();
  const body = Buffer.alloc(38 * 1024 * 1024, 0x5a);
  const input = { artifactId: "art-large-existing", workspaceId: "w", contentType: "application/octet-stream", body };
  const legacy = new SqliteStore({ databasePath: db.databasePath });
  try {
    legacy.putArtifact(input);
  } finally {
    legacy.close();
  }
  expect(digest(await db.readArtifactBody(input.artifactId))).toBe(digest(body));
  const created = await db.putArtifact({ ...input, artifactId: "art-large-worker" });
  expect(created.byteSize).toBe(body.byteLength);
  expect(digest(await db.readArtifactBody(created.artifactId))).toBe(digest(body));
  expect(await db.putArtifact({ ...input, artifactId: created.artifactId })).toEqual(created);
}, 30000);
it("stores and paginates a checkpoint larger than the response reserve", async () => {
  const db = await open();
  const body = Buffer.alloc(38 * 1024 * 1024, 0x61);
  const input = {
    threadId: "t",
    namespace: "",
    checkpointId: "c",
    parentId: null,
    type: "json",
    checkpoint: body,
    metadata: Buffer.from("{}"),
  };
  await db.checkpoints.put(input);
  expect(digest((await db.checkpoints.get({ threadId: "t", namespace: "" }))?.checkpoint)).toBe(digest(body));
  const cursor = await db.checkpoints.openCursor({ threadId: "t" });
  try {
    const page = await db.checkpoints.nextCursor(cursor);
    expect(digest(page.rows[0]?.checkpoint)).toBe(digest(body));
  } finally {
    await db.checkpoints.closeCursor(cursor);
  }
}, 30000);
it("keeps a large checkpoint write ahead of a later thread deletion", async () => {
  const db = await open();
  const write = db.checkpoints.put({
    threadId: "ordered",
    namespace: "",
    checkpointId: "large",
    parentId: null,
    type: "json",
    checkpoint: Buffer.alloc(1024 * 1024),
    metadata: Buffer.from("{}"),
  });
  const deletion = db.checkpoints.deleteThread("ordered");
  await Promise.all([write, deletion]);
  expect(await db.checkpoints.get({ threadId: "ordered", namespace: "" })).toBeUndefined();
});
it("counts each payload-transfer request and resets the counts", async () => {
  const db = await open();
  const input = {
    artifactId: "art-large-counted",
    workspaceId: "w",
    contentType: "application/octet-stream",
    body: Buffer.alloc(2 * 1024 * 1024 + 1, 0x63),
  };
  db.resetOperationCounts();
  await db.putArtifact(input);
  expect(digest(await db.readArtifactBody(input.artifactId))).toBe(digest(input.body));
  const counts = db.operationCounts().byOperation;
  expect(counts["payload.begin"]).toBe(1);
  expect(counts["payload.append"]).toBe(Math.ceil(serialize([input]).byteLength / (512 * 1024)));
  expect(counts["payload.read"]).toBeGreaterThanOrEqual(1);
  expect(counts["payload.close"]).toBe(2);
  expect(counts["repository.artifacts.putArtifact"]).toBe(1);
  expect(counts["store.readArtifactBody"]).toBe(1);
  db.resetOperationCounts();
  expect(db.operationCounts()).toEqual({ total: 0, byOperation: {} });
});
