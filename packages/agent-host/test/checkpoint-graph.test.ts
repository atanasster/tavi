import Database from "better-sqlite3";
import { join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { type BaseCheckpointSaver, ERROR, INTERRUPT, RESUME, emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { AsyncCheckpointSaver } from "../src/workflow/checkpoint.js";
import { DatabaseClient } from "../../runtime/src/persistence/client.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const blobCount = (native: Database.Database) =>
  (native.prepare("SELECT COUNT(*) AS n FROM tavi_checkpoint_blobs").get() as { n: number }).n;
/** The pinned saver's refusal of a per-channel row: its type is not one the serializer knows. */
const REFUSED = /Unknown serialization type/;

it.each([
  ["pinned-to-worker", false],
  ["worker-to-pinned", false],
  ["pinned-to-worker", true],
  ["worker-to-pinned", true],
] as const)("resumes an interrupted graph %s (per-channel checkpoints: %s)", async (direction, channelBlobs) => {
  const directory = directories.create("tavi-graph-compat-");
  const path = join(directory, "db.sqlite");
  const client = await DatabaseClient.open({ databasePath: path });
  const native = new Database(path);
  const pinned = new SqliteSaver(native);
  const worker = new AsyncCheckpointSaver(client.checkpoints, undefined, { channelBlobs });
  try {
    const state = Annotation.Root({ prompt: Annotation<string>(), answer: Annotation<string>() });
    let prepared = 0;
    const graph = (saver: BaseCheckpointSaver) =>
      new StateGraph(state)
        .addNode("prepare", () => {
          prepared++;
          return {};
        })
        .addNode("ask", () => ({ answer: interrupt("Choose a colour") as string }))
        .addEdge(START, "prepare")
        .addEdge("prepare", "ask")
        .addEdge("ask", END)
        .compile({ checkpointer: saver });
    const first = direction === "pinned-to-worker" ? pinned : worker;
    const second = direction === "pinned-to-worker" ? worker : pinned;
    const config = { configurable: { thread_id: "conversation" } };
    const stopped = await graph(first).invoke({ prompt: "private" }, config);
    if (!("__interrupt__" in stopped)) throw new Error("graph did not interrupt");
    expect(stopped.__interrupt__).toHaveLength(1);
    expect(prepared).toBe(1);
    if (channelBlobs && direction === "worker-to-pinned") {
      // The pinned saver cannot rejoin per-channel rows: it refuses them rather than resuming with empty state.
      expect(blobCount(native)).toBeGreaterThan(0);
      await expect(pinned.getTuple(config)).rejects.toThrow(REFUSED);
      return;
    }
    const loaded = await second.getTuple(config);
    expect(loaded?.pendingWrites?.some((write) => write[1] === INTERRUPT)).toBe(true);
    const resumed = await graph(second).invoke(new Command({ resume: "blue" }), config);
    expect(resumed).toMatchObject({ prompt: "private", answer: "blue" });
    expect(prepared).toBe(1);
    expect(blobCount(native) > 0).toBe(channelBlobs);
    // The worker resumed the pinned saver's thread per channel: the pinned saver now refuses its newest row.
    const reader = channelBlobs ? worker : first;
    if (channelBlobs) await expect(pinned.getTuple(config)).rejects.toThrow(REFUSED);
    const readBack = await reader.getTuple(config);
    expect(readBack?.checkpoint.channel_values["answer"]).toBe("blue");
    expect(readBack?.checkpoint.channel_values["prompt"]).toBe("private");
    expect((await graph(reader).getState(config)).next).toEqual([]);
  } finally {
    await worker.close();
    await client.close();
    native.close();
  }
});

it.each([false, true])("preserves special write overwrite rules in both directions (per-channel checkpoints: %s)", async (channelBlobs) => {
  const directory = directories.create("tavi-writes-compat-");
  const path = join(directory, "db.sqlite");
  const client = await DatabaseClient.open({ databasePath: path });
  const native = new Database(path);
  const pinned = new SqliteSaver(native);
  const worker = new AsyncCheckpointSaver(client.checkpoints, undefined, { channelBlobs });
  // The pinned saver refuses per-channel rows; a saver with the flag off reads them.
  const reader = channelBlobs ? new AsyncCheckpointSaver(client.checkpoints) : pinned;
  try {
    for (const [index, first] of [pinned, worker].entries()) {
      const second = first === pinned ? worker : reader;
      // Identical thread/checkpoint IDs must not merge namespace state or writes.
      for (const namespace of ["left", "right"]) {
        const config = await first.put(
          { configurable: { thread_id: `isolated-${index}`, checkpoint_ns: namespace } },
          { ...emptyCheckpoint(), id: "same", channel_values: { private: namespace }, channel_versions: { private: 1 } },
          { source: "loop", step: 1, parents: {} },
        );
        await first.putWrites(config, [["result", namespace]], "same-task");
      }
      for (const namespace of ["left", "right"]) {
        const loaded = await second.getTuple({
          configurable: { thread_id: `isolated-${index}`, checkpoint_ns: namespace, checkpoint_id: "same" },
        });
        expect(loaded?.checkpoint.channel_values).toEqual({ private: namespace });
        expect(loaded?.pendingWrites).toEqual([["same-task", "result", namespace]]);
      }
      const root = { configurable: { thread_id: `writes-${index}`, checkpoint_ns: "child" } };
      const parent = await first.put(root, { ...emptyCheckpoint(), id: "parent" }, { source: "input", step: 0, parents: {} });
      const config = await first.put(parent, { ...emptyCheckpoint(), id: "child" }, { source: "loop", step: 1, parents: {} });
      await first.putWrites(
        config,
        [
          [ERROR, "old-error"],
          [INTERRUPT, [{ value: "old" }]],
          [RESUME, "old-resume"],
        ],
        "special-task",
      );
      await first.putWrites(
        config,
        [
          [ERROR, "new-error"],
          [INTERRUPT, [{ value: "new" }]],
          [RESUME, "new-resume"],
        ],
        "special-task",
      );
      await first.putWrites(config, [["ordinary", "first"]], "ordinary-task");
      await first.putWrites(config, [["ordinary", "ignored"]], "ordinary-task");
      const expected = await first.getTuple(config);
      const loaded = await second.getTuple(config);
      expect(loaded).toEqual(expected);
      expect(loaded?.pendingWrites).toEqual(
        expect.arrayContaining([
          ["special-task", ERROR, "new-error"],
          ["special-task", RESUME, "new-resume"],
          ["ordinary-task", "ordinary", "first"],
        ]),
      );
    }
    // Puts without new versions: the worker answers the channels it lacks and the saver carries them on a second put.
    expect(blobCount(native) > 0).toBe(channelBlobs);
  } finally {
    await worker.close();
    if (reader instanceof AsyncCheckpointSaver) await reader.close();
    await client.close();
    native.close();
  }
});

it("refuses only the serializer's circular-reference marker, never a body of another length", async () => {
  const sentinel = new TextEncoder().encode(JSON.stringify("[unable to serialize, circular reference is too complex to analyze]"));
  let next = sentinel;
  const puts: unknown[] = [];
  const storage = { put: async (input: unknown) => void puts.push(input) } as unknown as ConstructorParameters<
    typeof AsyncCheckpointSaver
  >[0];
  const serde = {
    dumpsTyped: async () => ["json", next] as [string, Uint8Array],
    loadsTyped: async () => undefined,
  };
  const saver = new AsyncCheckpointSaver(storage, serde);
  const config = { configurable: { thread_id: "sentinel" } };
  try {
    await expect(saver.put(config, emptyCheckpoint(), { source: "input", step: -1, parents: {} })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(puts).toHaveLength(0);
    next = new TextEncoder().encode(JSON.stringify("[unable to serialize, circular reference is too complex to analyze]!"));
    await saver.put(config, emptyCheckpoint(), { source: "input", step: -1, parents: {} });
    expect(puts).toHaveLength(1);
  } finally {
    await saver.close();
  }
});

it("refuses an oversized checkpoint behind pending work and admits it alone", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const puts: unknown[] = [];
  const storage = {
    put: async (input: unknown) => {
      puts.push(input);
      if (puts.length === 1) await gate;
    },
  } as unknown as ConstructorParameters<typeof AsyncCheckpointSaver>[0];
  const serde = {
    dumpsTyped: async () => ["json", new Uint8Array([123, 125])] as [string, Uint8Array],
    loadsTyped: async () => undefined,
  };
  const saver = new AsyncCheckpointSaver(storage, serde);
  const config = { configurable: { thread_id: "budget" } };
  const metadata = { source: "input" as const, step: -1, parents: {} };
  const oversized = () => ({ ...emptyCheckpoint(), channel_values: { blob: new Uint8Array(33 * 1024 * 1024) } });
  try {
    const first = saver.put(config, emptyCheckpoint(), metadata);
    await expect(saver.put(config, oversized(), metadata)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    release();
    await first;
    // The queue's accounting settles a turn after the put resolves.
    await new Promise((resolve) => setImmediate(resolve));
    await saver.put(config, oversized(), metadata);
    expect(puts).toHaveLength(2);
  } finally {
    release();
    await saver.close();
  }
});

/** A chat shaped like the task graph: a model step appends to the conversation, a review step only moves the phase. */
function chatGraph(saver: BaseCheckpointSaver) {
  const state = Annotation.Root({
    conversation: Annotation<string[]>({ reducer: (left, right) => [...left, ...right], default: () => [] }),
    phase: Annotation<string>(),
    instructions: Annotation<string>(),
  });
  return new StateGraph(state)
    .addNode("model", (current) => ({ conversation: [`reply ${current.conversation.length}: ${"x".repeat(2_000)}`], phase: "review" }))
    .addNode("review", () => ({ phase: "done" }))
    .addEdge(START, "model")
    .addEdge("model", "review")
    .addEdge("review", END)
    .compile({ checkpointer: saver });
}

/** The client's checkpoint port, counting what each put carries and how often the worker answered `missing`. */
function measured(port: DatabaseClient["checkpoints"]) {
  const stats = { puts: 0, bytes: 0, missing: 0 };
  const storage: DatabaseClient["checkpoints"] = {
    ...port,
    put: async (input) => {
      stats.puts++;
      stats.bytes +=
        input.checkpoint.byteLength + input.metadata.byteLength + (input.blobs ?? []).reduce((sum, blob) => sum + blob.value.byteLength, 0);
      const result = await port.put(input);
      if (result !== undefined && result.missing.length > 0) stats.missing++;
      return result;
    },
  };
  return { storage, stats };
}

it("a thread flips between per-channel and inline storage turn by turn, and each saver reads and lists every row", async () => {
  const directory = directories.create("tavi-graph-flip-");
  const path = join(directory, "db.sqlite");
  const client = await DatabaseClient.open({ databasePath: path });
  const native = new Database(path);
  const on = measured(client.checkpoints);
  const perChannel = new AsyncCheckpointSaver(on.storage, undefined, { channelBlobs: true });
  const inline = new AsyncCheckpointSaver(client.checkpoints);
  try {
    const config = { configurable: { thread_id: "chat" } };
    for (let turn = 0; turn < 6; turn++) {
      const saver = turn % 2 === 0 ? perChannel : inline;
      const result = await chatGraph(saver).invoke({ conversation: [`prompt ${turn}`], instructions: "be brief" }, config);
      expect(result.conversation).toHaveLength(2 * (turn + 1));
      for (const reader of [perChannel, inline]) {
        const state = await chatGraph(reader).getState(config);
        expect(state.values).toEqual(result);
        expect(state.next).toEqual([]);
      }
    }
    // After an inline turn the per-channel saver carries what the worker lacks: `instructions` was never new to it.
    expect(on.stats.missing).toBeGreaterThan(0);
    expect(blobCount(native)).toBeGreaterThan(0);
    const listed = async (saver: BaseCheckpointSaver, options?: Parameters<BaseCheckpointSaver["list"]>[1]) => {
      const rows = [];
      for await (const row of saver.list(config, options))
        rows.push([row.config.configurable?.["checkpoint_id"], row.checkpoint.channel_values]);
      return rows;
    };
    const all = await listed(inline);
    expect(all.length).toBeGreaterThan(12);
    expect(await listed(perChannel)).toEqual(all);
    const before = { configurable: { thread_id: "chat", checkpoint_id: String(all[3]?.[0]) } };
    for (const options of [{ limit: 3 }, { before, limit: 2 }, { filter: { source: "input" } }, { before, filter: { step: 1 } }])
      expect(await listed(perChannel, options)).toEqual(await listed(inline, options));
    await perChannel.deleteThread("chat");
    expect(await perChannel.getTuple(config)).toBeUndefined();
    expect(blobCount(native)).toBe(0);
  } finally {
    await perChannel.close();
    await inline.close();
    await client.close();
    native.close();
  }
});

it("a saver with the flag off resumes an interrupt stored per channel", async () => {
  const directory = directories.create("tavi-graph-off-");
  const path = join(directory, "db.sqlite");
  const client = await DatabaseClient.open({ databasePath: path });
  const perChannel = new AsyncCheckpointSaver(client.checkpoints, undefined, { channelBlobs: true });
  const inline = new AsyncCheckpointSaver(client.checkpoints);
  try {
    const state = Annotation.Root({ prompt: Annotation<string>(), answer: Annotation<string>() });
    const graph = (saver: BaseCheckpointSaver) =>
      new StateGraph(state)
        .addNode("ask", () => ({ answer: interrupt("Choose a colour") as string }))
        .addEdge(START, "ask")
        .addEdge("ask", END)
        .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: "conversation" } };
    await graph(perChannel).invoke({ prompt: "private" }, config);
    expect((await inline.getTuple(config))?.pendingWrites?.some((write) => write[1] === INTERRUPT)).toBe(true);
    expect(await graph(inline).invoke(new Command({ resume: "blue" }), config)).toEqual({ prompt: "private", answer: "blue" });
    expect((await graph(perChannel).getState(config)).values).toEqual({ prompt: "private", answer: "blue" });
  } finally {
    await perChannel.close();
    await inline.close();
    await client.close();
  }
});

it("per-channel checkpoints send only the channels a step changed", async () => {
  const directory = directories.create("tavi-graph-bytes-");
  const client = await DatabaseClient.open({ databasePath: join(directory, "db.sqlite") });
  const runs = [];
  try {
    for (const channelBlobs of [false, true]) {
      const { storage, stats } = measured(client.checkpoints);
      const saver = new AsyncCheckpointSaver(storage, undefined, { channelBlobs });
      const config = { configurable: { thread_id: `long-${channelBlobs}` } };
      for (let turn = 0; turn < 30; turn++) await chatGraph(saver).invoke({ conversation: [`prompt ${turn}`] }, config);
      await saver.close();
      runs.push(stats);
    }
    const [inline, perChannel] = runs;
    expect(perChannel?.puts).toBe(inline?.puts);
    // Of a turn's four checkpoints, two change the conversation (the input applied, the model's reply): the input
    // checkpoint and the review step send only their versions and the small channels they moved.
    expect(perChannel?.bytes ?? Number.POSITIVE_INFINITY).toBeLessThan((inline?.bytes ?? 0) * 0.6);
  } finally {
    await client.close();
  }
});
