import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { deserialize, serialize } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "@tavi/node-kit";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient } from "../src/persistence/client.js";
import { copyMessageChunk, DATABASE_LIMITS, type WorkerRequest, type WorkerResponse } from "../src/persistence/protocol.js";
import { databaseWorkerEvents } from "../src/persistence/worker-channel.js";
import { serializeBounded } from "../src/persistence/serialization.js";
import { serveWorker } from "../src/persistence/worker-server.js";

const directories = temporaryDirectories();
const clients: DatabaseClient[] = [];
const holders: Database.Database[] = [];

afterEach(async () => {
  for (const db of holders.splice(0)) if (db.open) db.close();
  await Promise.all(clients.splice(0).map((client) => client.abort()));
  directories.cleanup();
});

function databasePath(): string {
  const directory = directories.create("tavi-worker-");
  return join(directory, "test.sqlite");
}

async function open(options: Parameters<typeof DatabaseClient.open>[0]): Promise<DatabaseClient> {
  const client = await DatabaseClient.open(options);
  clients.push(client);
  return client;
}

function lock(path: string): Database.Database {
  const holder = new Database(path);
  holders.push(holder);
  holder.exec("BEGIN IMMEDIATE");
  return holder;
}

const now = "2026-09-28T00:00:00.000Z";

describe("database worker channel", () => {
  it("checks serialization admission without invoking input accessors and preserves binary data", () => {
    let accessed = false;
    expect(() =>
      serializeBounded(
        {
          get value() {
            accessed = true;
            return "side effect";
          },
        },
        1024,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(accessed).toBe(false);
    expect(() => serializeBounded({ value: "x".repeat(1024) }, 256)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    const value = { bytes: Uint8Array.from([0, 255]), date: new Date(now), values: new Map([["key", undefined]]) };
    expect(deserialize(serializeBounded(value, 1024))).toEqual(value);
  });
  it("bounds the cloned backing allocation of each message chunk", async () => {
    const body = Buffer.alloc(4 * DATABASE_LIMITS.messageBytes + 73, 97);
    const { port1, port2 } = new MessageChannel();
    try {
      const received = new Promise<Uint8Array>((resolve) => port2.once("message", resolve));
      port1.postMessage(copyMessageChunk(body, DATABASE_LIMITS.messageBytes));
      const chunk = await received;
      expect(chunk.byteLength).toBe(DATABASE_LIMITS.messageBytes);
      expect(chunk.buffer.byteLength).toBe(DATABASE_LIMITS.messageBytes);
      expect(chunk[0]).toBe(97);
      const lastReceived = new Promise<Uint8Array>((resolve) => port2.once("message", resolve));
      port1.postMessage(copyMessageChunk(body, 4 * DATABASE_LIMITS.messageBytes));
      const last = await lastReceived;
      expect(last.byteLength).toBe(73);
      expect(last.buffer.byteLength).toBe(73);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("sends a body that owns its whole allocation without another copy", () => {
    const owned = new Uint8Array(64).fill(7);
    expect(copyMessageChunk(owned, 0)).toBe(owned);
    const view = new Uint8Array(owned.buffer, 8, 16);
    const copied = copyMessageChunk(view, 0);
    expect(copied).not.toBe(view);
    expect(copied.buffer.byteLength).toBe(16);
  });

  it("answers an inline request of at most one message in a single round trip", async () => {
    const { port1, port2 } = new MessageChannel();
    const replies: WorkerResponse[] = [];
    port1.on("message", (message: WorkerResponse) => replies.push(message));
    serveWorker(
      port2,
      (operation, input) => ({ operation, input }),
      () => {},
    );
    try {
      const body = serialize({ key: "inline" });
      const request: WorkerRequest = { type: "begin", id: 1, operation: "echo", bytes: body.byteLength, inline: copyMessageChunk(body, 0) };
      port1.postMessage(request);
      await vi.waitFor(() => expect(replies.map((reply) => reply.type)).toEqual(["ready", "started", "result"]));
      const result = replies[2];
      if (result?.type !== "result" || result.inline === undefined) throw new Error("expected an inline result");
      expect(result.inline.byteLength).toBe(result.bytes);
      expect(deserialize(result.inline)).toEqual({ operation: "echo", input: { key: "inline" } });
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("posts one message per operation at most one message long and chunks larger ones", async () => {
    const client = await open({ databasePath: ":memory:", inMemory: true });
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await client.call("meta.set", { key: "small", value: "value", now });
      expect(posted.mock.calls.map(([message]) => (message as WorkerRequest).type)).toEqual(["begin"]);
      expect(await client.call("meta.get", { key: "small" })).toBe("value");
      expect(posted).toHaveBeenCalledTimes(2);
      posted.mockClear();
      const large = "x".repeat(DATABASE_LIMITS.messageBytes + 1024);
      await client.call("meta.set", { key: "large", value: large, now });
      expect(posted.mock.calls.map(([message]) => (message as WorkerRequest).type)).toEqual(["begin", "chunk", "chunk"]);
      posted.mockClear();
      expect(await client.call("meta.get", { key: "large" })).toBe(large);
      expect(posted.mock.calls.map(([message]) => (message as WorkerRequest).type)).toEqual(["begin", "result-next", "result-next"]);
    } finally {
      posted.mockRestore();
    }
  });

  it("rejects configuration exceeding the worker envelope before opening a worker", async () => {
    await expect(
      DatabaseClient.open({
        databasePath: databasePath(),
        limits: {
          requests: 1,
          controlRequests: 1,
          bytes: DATABASE_LIMITS.bytes + 1,
          controlBytes: 1024,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("opens the migrated database in the packaged worker and persists across reopen", async () => {
    const path = databasePath();
    const client = await open({ databasePath: path });
    expect((await client.call("info", undefined)).tables).toContain("tavi_tasks");
    await client.call("meta.set", { key: "fixture", value: "persisted", now });
    await client.close();
    const reopened = await open({ databasePath: path });
    expect(await reopened.call("meta.get", { key: "fixture" })).toBe("persisted");
    expect(await reopened.call("tasks.get", { taskId: "missing" })).toBeUndefined();
  });

  it("tells each settled request, resolved or rejected, to its listeners until they unsubscribe", async () => {
    const client = await open({ databasePath: ":memory:", inMemory: true });
    const settled: [string, unknown][] = [];
    const stop = client.onSettled((operation, input) => settled.push([operation, input]));
    client.onSettled(() => {
      throw new Error("a listener's own failure");
    });
    await client.call("meta.set", { key: "fixture", value: "kept", now });
    await expect(client.services.accounting.finish("missing", "completed", {}, now)).rejects.toThrow();
    expect(settled).toEqual([
      ["meta.set", { key: "fixture", value: "kept", now }],
      ["service.accounting.finish", ["missing", "completed", {}, now]],
    ]);
    stop();
    await client.call("meta.get", { key: "fixture" });
    expect(settled).toHaveLength(2);
  });

  it("signals each request that changed rows, and never a read", async () => {
    const client = await open({ databasePath: ":memory:", inMemory: true });
    const wrote: string[] = [];
    const stop = client.onWrite((operation) => wrote.push(operation));
    await client.call("meta.get", { key: "fixture" });
    expect(await client.nextWakeups({ now, resumeGraceMs: 30_000, notifyWindowMs: 86_400_000 })).toEqual({
      reminders: null,
      schedules: null,
      agentWaits: null,
      approvals: null,
      heartbeats: null,
    });
    expect(wrote).toEqual([]);
    expect(client.writeCount).toBe(0);
    await client.call("meta.set", { key: "fixture", value: "kept", now });
    expect(wrote).toEqual(["meta.set"]);
    expect(client.writeCount).toBe(1);
    stop();
    await client.call("meta.set", { key: "fixture", value: "changed", now });
    expect(wrote).toEqual(["meta.set"]);
    expect(client.writeCount).toBe(2);
  });

  it("lets the main-thread timer release a lock while a worker write waits", async () => {
    const path = databasePath();
    const client = await open({ databasePath: path });
    const holder = lock(path);
    const started = Promise.withResolvers<void>();
    const observe = (event: unknown) => {
      if (typeof event === "object" && event !== null && "phase" in event && event.phase === "started") started.resolve();
    };
    databaseWorkerEvents.subscribe(observe);
    let settled = false;
    const write = client.call("meta.set", { key: "contended", value: "committed", now });
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await started.promise;
      await sleep(10);
      expect(settled).toBe(false);
      expect(await Promise.resolve("independent request")).toBe("independent request");
    } finally {
      databaseWorkerEvents.unsubscribe(observe);
      holder.exec("ROLLBACK");
    }
    await write;
    expect(await client.call("meta.get", { key: "contended" })).toBe("committed");
  });

  it("copies queued arguments, cancels only undispatched work and drains before close", async () => {
    const path = databasePath();
    const client = await open({ databasePath: path });
    const holder = lock(path);
    const write = client.call("meta.set", { key: "first", value: "first", now });
    const input = { key: "copied", value: "original", now };
    const copied = client.call("meta.set", input);
    input.value = "mutated";
    const controller = new AbortController();
    const cancelled = client.call("meta.set", { key: "cancelled", value: "wrong", now }, { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ code: "ABORTED", details: { mutationOutcome: "not-dispatched" } });
    controller.abort();
    const closing = client.close();
    await expect(client.call("meta.get", { key: "first" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    holder.exec("ROLLBACK");
    await Promise.all([write, copied, rejection, closing]);
    const reopened = await open({ databasePath: path });
    expect(await reopened.call("meta.get", { key: "copied" })).toBe("original");
    expect(await reopened.call("meta.get", { key: "cancelled" })).toBeUndefined();
  });

  it("reserves completion capacity when ordinary request slots are full", async () => {
    const path = databasePath();
    const client = await open({ databasePath: path, limits: { requests: 1, controlRequests: 1, bytes: 1024, controlBytes: 1024 } });
    const holder = lock(path);
    const ordinary = client.call("meta.set", { key: "ordinary", value: "1", now });
    await expect(client.call("meta.get", { key: "ordinary" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const receipt = client.call("meta.set", { key: "receipt", value: "1", now }, { control: true });
    const closing = client.close();
    holder.exec("ROLLBACK");
    await Promise.all([ordinary, receipt, closing]);
  });

  it("bounds payload bytes and transfers supported values across message boundaries", async () => {
    const path = databasePath();
    const small = await open({ databasePath: path, limits: { requests: 10, controlRequests: 2, bytes: 256, controlBytes: 256 } });
    await expect(small.call("meta.set", { key: "too-large", value: "x".repeat(1024), now })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { mutationOutcome: "not-dispatched" },
    });
    await small.close();
    const client = await open({ databasePath: path });
    const value = "x".repeat(1024 * 1024 + 73);
    await client.call("meta.set", { key: "large", value, now });
    expect(await client.call("meta.get", { key: "large" })).toBe(value);
  });

  it("settles active and queued callers distinctly after worker loss", async () => {
    const path = databasePath();
    const client = await open({ databasePath: path });
    const holder = lock(path);
    const active = client.call("meta.set", { key: "active", value: "1", now });
    const queued = client.call("meta.set", { key: "queued", value: "1", now });
    const activeFailure = expect(active).rejects.toMatchObject({ details: { mutationOutcome: "unknown" } });
    const queuedFailure = expect(queued).rejects.toMatchObject({ details: { mutationOutcome: "not-dispatched" } });
    const stopping = client.abort();
    holder.exec("ROLLBACK");
    await Promise.all([stopping, activeFailure, queuedFailure]);
    await expect(client.failed).resolves.toBeInstanceOf(Error);
    await expect(client.close()).rejects.toThrow();
  });

  it("reports initialization failure without leaving a running worker", async () => {
    const path = databasePath();
    await expect(DatabaseClient.open({ databasePath: dirname(path) })).rejects.toThrow();
    const client = await open({ databasePath: path });
    expect((await client.call("info", undefined)).databasePath).toBe(path);
  });
});
