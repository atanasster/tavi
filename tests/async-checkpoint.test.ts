import { afterEach, describe, expect, it } from "vitest";
import { AsyncCheckpointSaver } from "../packages/agent-host/src/workflow/checkpoint.js";
import { DatabaseClient } from "../packages/runtime/src/persistence/client.js";
import { baselineCheckpoint, databaseBaseline } from "./fixtures/database-baseline.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const baseline = databaseBaseline();
  cleanup.push(async () => baseline.close());
  const client = await DatabaseClient.open({ databasePath: baseline.databasePath });
  cleanup.push(() => client.close());
  const saver = new AsyncCheckpointSaver(client.checkpoints);
  cleanup.push(() => saver.close());
  return { baseline, client, saver };
}

describe("asynchronous checkpoint compatibility", () => {
  it("reads and writes the pinned saver format in both directions with messages and bytes", async () => {
    const { baseline, saver } = await fixture();
    const pinned = baseline.saver();
    const message = await pinned.serde.loadsTyped(
      "json",
      JSON.stringify({ lc: 1, type: "constructor", id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "Hello" } }),
    );
    const checkpoint = { ...baselineCheckpoint("first"), channel_values: { messages: [message], bytes: new Uint8Array([0, 255]) } };
    const first = await pinned.put({ configurable: { thread_id: "task", checkpoint_ns: "child" } }, checkpoint, {
      source: "input",
      step: 0,
      parents: {},
    });
    await pinned.putWrites(first, [["result", { ok: true }]], "worker");
    const loaded = await saver.getTuple(first);
    expect(loaded?.checkpoint.channel_values["bytes"]).toEqual(new Uint8Array([0, 255]));
    expect(loaded?.checkpoint.channel_values["messages"]).toEqual([message]);
    expect(loaded?.pendingWrites).toEqual([["worker", "result", { ok: true }]]);
    const next = await saver.put(first, { ...checkpoint, id: "second" }, { source: "loop", step: 1, parents: {} });
    await saver.putWrites(next, [["result", "reply"]], "worker");
    const reread = await pinned.getTuple(next);
    expect(reread?.checkpoint.channel_values).toEqual(checkpoint.channel_values);
    expect(reread?.pendingWrites).toEqual([["worker", "result", "reply"]]);
    expect(reread?.parentConfig).toEqual(first);
  });

  it("keeps checkpoint rows and pending writes stable across pages while the writer commits", async () => {
    const { client, saver } = await fixture();
    for (const namespace of ["a", "b", "c"]) {
      const config = await saver.put(
        { configurable: { thread_id: "task", checkpoint_ns: namespace } },
        { ...baselineCheckpoint("same-id"), channel_values: { body: "x".repeat(600_000) } },
        { source: "loop", step: 1, parents: {} },
      );
      await saver.putWrites(config, [["result", namespace]], "worker");
    }
    const cursor = await client.checkpoints.openCursor({ threadId: "task" });
    const first = await client.checkpoints.nextCursor(cursor);
    expect(first.rows).toHaveLength(1);
    expect(first.done).toBe(false);
    await saver.deleteThread("task");
    await saver.put({ configurable: { thread_id: "task", checkpoint_ns: "new" } }, baselineCheckpoint("later"), {
      source: "loop",
      step: 2,
      parents: {},
    });
    const rows = [...first.rows];
    for (;;) {
      const page = await client.checkpoints.nextCursor(cursor);
      rows.push(...page.rows);
      if (page.done) break;
    }
    expect(rows.map((row) => row.namespace).sort()).toEqual(["a", "b", "c"]);
    expect(rows.every((row) => row.checkpointId === "same-id" && row.writes.length === 1)).toBe(true);
    await expect(client.checkpoints.nextCursor(cursor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await saver.getTuple({ configurable: { thread_id: "task", checkpoint_ns: "new" } }))?.checkpoint.id).toBe("later");
  });

  it("orders thread deletion after delayed serialization and drains accepted work on close", async () => {
    const { client } = await fixture();
    const ordinary = new AsyncCheckpointSaver(client.checkpoints);
    const blocked = Promise.withResolvers<void>();
    let delaying = true;
    const saver = new AsyncCheckpointSaver(client.checkpoints, {
      dumpsTyped: async (value) => {
        if (delaying) await blocked.promise;
        return ordinary.serde.dumpsTyped(value);
      },
      loadsTyped: (type, bytes) => ordinary.serde.loadsTyped(type, bytes),
    });
    const put = saver.put({ configurable: { thread_id: "ordered" } }, baselineCheckpoint("delayed"), {
      source: "loop",
      step: 1,
      parents: {},
    });
    const deletion = saver.deleteThread("ordered");
    const closing = saver.close();
    delaying = false;
    blocked.resolve();
    await Promise.all([put, deletion, closing]);
    expect(await client.checkpoints.get({ threadId: "ordered", namespace: "" })).toBeUndefined();
    await expect(saver.deleteThread("ordered")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await ordinary.close();
  });

  it("releases a snapshot when iteration ends early", async () => {
    const { saver } = await fixture();
    await saver.put({ configurable: { thread_id: "early" } }, baselineCheckpoint("one"), { source: "loop", step: 1, parents: {} });
    for (let index = 0; index < 8; index++) {
      for await (const row of saver.list({ configurable: { thread_id: "early" } })) {
        expect(row.checkpoint.id).toBe("one");
        break;
      }
    }
  });
});

it("rejects serializer failure sentinels before acknowledging a persisted checkpoint", async () => {
  const { client, saver: ordinary } = await fixture();
  const saver = new AsyncCheckpointSaver(client.checkpoints, {
    dumpsTyped: async () => [
      "json",
      new TextEncoder().encode(JSON.stringify("[unable to serialize, circular reference is too complex to analyze]")),
    ],
    loadsTyped: (type, bytes) => ordinary.serde.loadsTyped(type, bytes),
  });
  cleanup.push(() => saver.close());
  await expect(
    saver.put({ configurable: { thread_id: "bad" } }, baselineCheckpoint("bad"), { source: "loop", step: 0, parents: {} }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await client.checkpoints.get({ threadId: "bad", namespace: "" })).toBeUndefined();
});

it("bounds abandoned cursors and releases their WAL snapshots at expiry", async () => {
  const { baseline, client, saver } = await fixture();
  await saver.put({ configurable: { thread_id: "expiry" } }, baselineCheckpoint("before"), { source: "loop", step: 1, parents: {} });
  const cursors = await Promise.all(Array.from({ length: 4 }, () => client.checkpoints.openCursor({ threadId: "expiry" })));
  await expect(client.checkpoints.openCursor({ threadId: "expiry" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  await saver.put({ configurable: { thread_id: "expiry" } }, baselineCheckpoint("after"), { source: "loop", step: 2, parents: {} });
  const observer = baseline.connect();
  expect(observer.pragma("wal_checkpoint(TRUNCATE)")).toMatchObject([{ busy: 1 }]);
  // Real worker timers must close the abandoned read transactions; advancing a
  // fake clock in the parent would not exercise that lifecycle.
  await new Promise((resolve) => setTimeout(resolve, 30_100));
  for (const cursor of cursors) await expect(client.checkpoints.nextCursor(cursor)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(observer.pragma("wal_checkpoint(TRUNCATE)")).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
  const replacements = await Promise.all(Array.from({ length: 4 }, () => client.checkpoints.openCursor({ threadId: "expiry" })));
  await expect(client.checkpoints.openCursor({ threadId: "expiry" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  await Promise.all(replacements.map((cursor) => client.checkpoints.closeCursor(cursor)));
  await saver.put({ configurable: { thread_id: "expiry" } }, baselineCheckpoint("last"), { source: "loop", step: 3, parents: {} });
  expect((await saver.getTuple({ configurable: { thread_id: "expiry", checkpoint_id: "last" } }))?.checkpoint.id).toBe("last");
}, 40_000);
