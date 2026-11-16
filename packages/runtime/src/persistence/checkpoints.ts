import { rmSync } from "node:fs";
import { join } from "node:path";
import { workerTempDirectory } from "./temporary-files.js";
import { serialize } from "node:v8";
/*! @license
The MIT License

Copyright (c) 2024 LangChain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.*/
/**
 * SQL format compatibility: @langchain/langgraph-checkpoint-sqlite 1.0.4.
 * Adapted from LangChain's MIT-licensed saver; its licence is the `@license` block above.
 */
import { randomUUID } from "node:crypto";
import {
  CHECKPOINT_BLOBS_KEY,
  TaviError,
  type CheckpointPutResult,
  type CheckpointSelection,
  type CheckpointStoragePort,
  type StoredCheckpoint,
  type StoredCheckpointTuple,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { loadBetterSqlite3, type Database } from "./sqlite-loader.js";
import { clearStatements, stmt } from "./statement-cache.js";
import { noteErasure } from "./erasure.js";
import { SAVER_EXPECTED_COLUMNS, SAVER_SCHEMA_VERSION, SAVER_SCHEMA_VERSION_KEY } from "./migrations.js";
import { DATABASE_LIMITS } from "./protocol.js";
import type { SqliteStore } from "./store.js";

type Row = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Buffer;
  metadata: Buffer;
};
type WriteRow = { task_id: string; idx: number; channel: string; type: string | null; value: Buffer };
interface Cursor {
  readonly reader?: Database;
  readonly iterator?: IterableIterator<Row>;
  readonly snapshotDirectory?: string;
  buffered?: StoredCheckpointTuple;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The `type` of a `checkpoints` row stored per channel: a JSON body whose versioned channels' values are in
 * `tavi_checkpoint_blobs`. A reader that does not
 * know it (the pinned saver) refuses the row ("Unknown serialization type") rather than resuming with empty state.
 */
const BLOB_CHECKPOINT_TYPE = "json+blobs";

/**
 * A per-channel body read: its head, the values it holds inline (channels without a version), and the channels it
 * names in `tavi_blobs`, each with its version as the blob table keys it.
 */
function blobReferences(body: Uint8Array): {
  readonly head: Record<string, unknown>;
  readonly inline: Record<string, unknown>;
  readonly refs: readonly [string, string][];
} {
  let head: unknown;
  try {
    head = JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"));
  } catch {
    throw new TaviError("INVALID_INPUT", "A per-channel checkpoint body must be JSON");
  }
  if (typeof head !== "object" || head === null || Array.isArray(head))
    throw new TaviError("INVALID_INPUT", "Malformed per-channel checkpoint");
  const record = head as Record<string, unknown>;
  const names = record[CHECKPOINT_BLOBS_KEY];
  const versions = record["channel_versions"];
  const inline = record["channel_values"] ?? {};
  if (
    !Array.isArray(names) ||
    typeof versions !== "object" ||
    versions === null ||
    typeof inline !== "object" ||
    inline === null ||
    Array.isArray(inline)
  )
    throw new TaviError("INVALID_INPUT", "Malformed per-channel checkpoint");
  const refs: [string, string][] = [];
  for (const name of names) {
    const version = typeof name === "string" && Object.hasOwn(versions, name) ? (versions as Record<string, unknown>)[name] : undefined;
    if (typeof name !== "string" || (typeof version !== "number" && typeof version !== "string") || Object.hasOwn(inline, name))
      throw new TaviError("INVALID_INPUT", "A per-channel checkpoint names a channel without a version, or one it holds inline");
    refs.push([name, String(version)]);
  }
  return { head: record, inline: inline as Record<string, unknown>, refs };
}

const COMMA = Buffer.from(",");

/**
 * A per-channel row's body made inline again: its head with `channel_values` holding its inline values and, spliced
 * in as stored, each named channel's blob at its version.
 */
function rejoin(db: Database, row: Row): Buffer {
  const { head, inline, refs } = blobReferences(row.checkpoint);
  delete head[CHECKPOINT_BLOBS_KEY];
  delete head["channel_values"];
  const prefix = JSON.stringify(head);
  const entries = Object.entries(inline).map(([channel, value]) => `${JSON.stringify(channel)}:${JSON.stringify(value)}`);
  const parts: Buffer[] = [Buffer.from(`${prefix === "{}" ? "{" : `${prefix.slice(0, -1)},`}"channel_values":{${entries.join(",")}`)];
  const read = stmt(db, "SELECT type,blob FROM tavi_checkpoint_blobs WHERE thread_id=? AND checkpoint_ns=? AND channel=? AND version=?");
  for (const [index, [channel, version]] of refs.entries()) {
    const blob = read.get(row.thread_id, row.checkpoint_ns, channel, version) as { type: string; blob: Buffer } | undefined;
    if (blob === undefined || blob.type !== "json")
      throw new TaviError(
        "UNAVAILABLE",
        `Checkpoint ${row.checkpoint_id} is missing its stored value of channel ${JSON.stringify(channel)}`,
      );
    if (index > 0 || entries.length > 0) parts.push(COMMA);
    parts.push(Buffer.from(`${JSON.stringify(channel)}:`), blob.blob);
  }
  parts.push(Buffer.from("}}"));
  return Buffer.concat(parts);
}

function tuple(db: Database, row: Row): StoredCheckpointTuple {
  const blobs = row.type === BLOB_CHECKPOINT_TYPE;
  const writes = stmt(
    db,
    "SELECT task_id,idx,channel,type,value FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_id,idx",
  ).all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as WriteRow[];
  return {
    threadId: row.thread_id,
    namespace: row.checkpoint_ns,
    checkpointId: row.checkpoint_id,
    parentId: row.parent_checkpoint_id,
    type: blobs ? "json" : (row.type ?? "json"),
    checkpoint: blobs ? rejoin(db, row) : row.checkpoint,
    metadata: row.metadata,
    writes: writes.map((write) => ({
      taskId: write.task_id,
      index: write.idx,
      channel: write.channel,
      type: write.type ?? "json",
      value: write.value,
    })),
  };
}

export class WorkerCheckpoints {
  readonly #store: SqliteStore;
  readonly #cursors = new Map<string, Cursor>();

  constructor(store: SqliteStore, mode?: "inspect") {
    this.#store = store;
    const version = store.getMeta(SAVER_SCHEMA_VERSION_KEY);
    if (mode === "inspect") {
      const tables = new Set(store.listTables());
      // Initialize a fresh directory, but never repair evidence of an existing
      // saver schema while doctor is inspecting it (including missing tables).
      if (version !== undefined || Object.keys(SAVER_EXPECTED_COLUMNS).some((table) => tables.has(table))) return;
    }
    if (version !== undefined && version !== String(SAVER_SCHEMA_VERSION))
      throw new TaviError("CONFLICT", "Unsupported checkpoint schema version");
    store.transactionImmediate(() => {
      store.handle.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
        PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
        CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
        PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));`);
      for (const [table, columns] of Object.entries(SAVER_EXPECTED_COLUMNS)) {
        const present = (store.handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
        if (columns.some((column) => !present.includes(column))) throw new TaviError("CONFLICT", `Incompatible checkpoint table: ${table}`);
      }
      store.setMeta(SAVER_SCHEMA_VERSION_KEY, String(SAVER_SCHEMA_VERSION), nowTimestamp());
    });
  }

  get(input: Parameters<CheckpointStoragePort["get"]>[0]): StoredCheckpointTuple | undefined {
    return this.#store.transaction(() => {
      const args = [input.threadId, input.namespace];
      if (input.checkpointId) args.push(input.checkpointId);
      const row = stmt(
        this.#store.handle,
        `SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ${input.checkpointId ? "AND checkpoint_id=?" : "ORDER BY checkpoint_id DESC LIMIT 1"}`,
      ).get(...args) as Row | undefined;
      return row === undefined ? undefined : tuple(this.#store.handle, row);
    });
  }

  put(input: StoredCheckpoint): CheckpointPutResult | undefined {
    const row = (type: string) =>
      stmt(
        this.#store.handle,
        "INSERT OR REPLACE INTO checkpoints(thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata) VALUES(?,?,?,?,?,?,?)",
      ).run(input.threadId, input.namespace, input.checkpointId, input.parentId, type, input.checkpoint, input.metadata);
    const blobs = input.blobs;
    if (blobs === undefined) {
      row(input.type);
      return undefined;
    }
    if (input.type !== "json" || blobs.some((blob) => blob.type !== "json"))
      throw new TaviError("INVALID_INPUT", "A per-channel checkpoint is stored as JSON");
    const { refs } = blobReferences(input.checkpoint);
    return this.#store.transactionImmediate(() => {
      // A channel's value is kept once per version: what the parent already stored is not carried again. Anything
      // the body names that is neither stored nor carried is answered, and nothing is written.
      const carried = new Set(blobs.map((blob) => `${blob.channel}\u0000${blob.version}`));
      const stored = stmt(
        this.#store.handle,
        "SELECT 1 FROM tavi_checkpoint_blobs WHERE thread_id=? AND checkpoint_ns=? AND channel=? AND version=?",
      );
      const missing = refs
        .filter(
          ([channel, version]) =>
            !carried.has(`${channel}\u0000${version}`) && stored.get(input.threadId, input.namespace, channel, version) === undefined,
        )
        .map(([channel]) => channel);
      if (missing.length > 0) return { missing };
      const insert = stmt(
        this.#store.handle,
        "INSERT OR IGNORE INTO tavi_checkpoint_blobs(thread_id,checkpoint_ns,channel,version,type,blob) VALUES(?,?,?,?,?,?)",
      );
      for (const blob of blobs) insert.run(input.threadId, input.namespace, blob.channel, blob.version, blob.type, blob.value);
      row(BLOB_CHECKPOINT_TYPE);
      return undefined;
    });
  }

  putWrites(input: Parameters<CheckpointStoragePort["putWrites"]>[0]): void {
    this.#store.transactionImmediate(() => {
      const statement = stmt(
        this.#store.handle,
        `INSERT OR ${input.replace ? "REPLACE" : "IGNORE"} INTO writes(thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value) VALUES(?,?,?,?,?,?,?,?)`,
      );
      for (const write of input.writes)
        statement.run(
          input.threadId,
          input.namespace,
          input.checkpointId,
          write.taskId,
          write.index,
          write.channel,
          write.type,
          write.value,
        );
    });
  }

  deleteThread(threadId: string): void {
    this.#store.transactionImmediate(() => {
      noteErasure(this.#store.handle);
      stmt(this.#store.handle, "DELETE FROM checkpoints WHERE thread_id=?").run(threadId);
      stmt(this.#store.handle, "DELETE FROM writes WHERE thread_id=?").run(threadId);
      stmt(this.#store.handle, "DELETE FROM tavi_checkpoint_blobs WHERE thread_id=?").run(threadId);
    });
  }

  /** Drop the channel values no remaining checkpoint of this thread and namespace names. */
  #collectBlobs(threadId: string, namespace: string): void {
    const handle = this.#store.handle;
    const kept = new Set<string>();
    const bodies = stmt(handle, "SELECT checkpoint FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND type=?").all(
      threadId,
      namespace,
      BLOB_CHECKPOINT_TYPE,
    ) as { checkpoint: Buffer }[];
    for (const { checkpoint } of bodies)
      for (const [channel, version] of blobReferences(checkpoint).refs) kept.add(`${channel}\u0000${version}`);
    const blobs = stmt(handle, "SELECT channel,version FROM tavi_checkpoint_blobs WHERE thread_id=? AND checkpoint_ns=?").all(
      threadId,
      namespace,
    ) as { channel: string; version: string }[];
    const remove = stmt(handle, "DELETE FROM tavi_checkpoint_blobs WHERE thread_id=? AND checkpoint_ns=? AND channel=? AND version=?");
    for (const blob of blobs)
      if (!kept.has(`${blob.channel}\u0000${blob.version}`)) remove.run(threadId, namespace, blob.channel, blob.version);
  }

  pruneThread(input: { readonly threadId: string; readonly keep: number }): number {
    return this.#store.transactionImmediate(() => {
      let removed = 0;
      const namespaces = stmt(this.#store.handle, "SELECT DISTINCT checkpoint_ns AS ns FROM checkpoints WHERE thread_id=?").all(
        input.threadId,
      ) as { ns: string }[];
      for (const { ns } of namespaces) {
        // Ordered as the cursor reads them: newest checkpoint id first; all but the newest `keep` go, with their writes.
        const older =
          "SELECT checkpoint_id FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT -1 OFFSET ?";
        const keep = Math.max(1, input.keep);
        stmt(this.#store.handle, `DELETE FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id IN (${older})`).run(
          input.threadId,
          ns,
          input.threadId,
          ns,
          keep,
        );
        removed += stmt(
          this.#store.handle,
          `DELETE FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id IN (${older})`,
        ).run(input.threadId, ns, input.threadId, ns, keep).changes;
      }
      // Per-channel values go with the last checkpoint naming them; a thread stored inline has none to look at.
      const blobNamespaces = stmt(
        this.#store.handle,
        "SELECT DISTINCT checkpoint_ns AS ns FROM tavi_checkpoint_blobs WHERE thread_id=?",
      ).all(input.threadId) as { ns: string }[];
      for (const { ns } of blobNamespaces) this.#collectBlobs(input.threadId, ns);
      return removed;
    });
  }

  latest(threadId: string): { readonly checkpointId: string; readonly namespace: string } | undefined {
    const row = stmt(
      this.#store.handle,
      "SELECT checkpoint_id, checkpoint_ns FROM checkpoints WHERE thread_id=? ORDER BY checkpoint_id DESC,thread_id DESC,checkpoint_ns DESC LIMIT 1",
    ).get(threadId) as { checkpoint_id: string; checkpoint_ns: string } | undefined;
    return row === undefined ? undefined : { checkpointId: row.checkpoint_id, namespace: row.checkpoint_ns };
  }

  openCursor(input: CheckpointSelection): string {
    if (this.#cursors.size >= DATABASE_LIMITS.cursors) throw new TaviError("BUDGET_EXCEEDED", "Checkpoint cursor limit reached");
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (input.threadId) {
      where.push("thread_id=?");
      args.push(input.threadId);
    }
    if (input.namespace !== undefined) {
      where.push("checkpoint_ns=?");
      args.push(input.namespace);
    }
    if (input.before !== undefined) {
      where.push("checkpoint_id<?");
      args.push(input.before);
    }
    for (const [key, value] of Object.entries(input.filter ?? {})) {
      if (value === undefined) continue;
      where.push("jsonb(CAST(metadata AS TEXT))->? = ?");
      args.push(`$.${key}`, JSON.stringify(value));
    }
    let sql = `SELECT * FROM checkpoints ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY checkpoint_id DESC,thread_id DESC,checkpoint_ns DESC`;
    if (input.limit) {
      sql += " LIMIT ?";
      args.push(Math.trunc(input.limit));
    }
    const id = randomUUID();
    const timer = setTimeout(() => this.closeCursor(id), DATABASE_LIMITS.cursorLifetimeMs);
    timer.unref();
    let reader: Database | undefined;
    let iterator: IterableIterator<Row> | undefined;
    let snapshotDirectory: string | undefined;
    try {
      let path = this.#store.databasePath;
      if (path === ":memory:") {
        snapshotDirectory = workerTempDirectory();
        path = join(snapshotDirectory, "snapshot.sqlite");
        this.#store.handle.prepare("VACUUM INTO ?").run(path);
      }
      reader = new (loadBetterSqlite3())(path, { readonly: true });
      reader.pragma("query_only = ON");
      // As the worker's own connection: reads through the shared map, sorts in memory.
      reader.pragma("mmap_size = 268435456");
      reader.pragma("temp_store = MEMORY");
      reader.exec("BEGIN");
      iterator = reader.prepare(sql).iterate(...args) as IterableIterator<Row>;
      const first = iterator.next();
      this.#cursors.set(id, {
        reader,
        iterator,
        timer,
        ...(snapshotDirectory === undefined ? {} : { snapshotDirectory }),
        ...(first.done ? {} : { buffered: tuple(reader, first.value) }),
      });
      return id;
    } catch (error) {
      clearTimeout(timer);
      iterator?.return?.();
      if (reader !== undefined) clearStatements(reader);
      reader?.close();
      if (snapshotDirectory !== undefined) rmSync(snapshotDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  nextCursor(id: string): Awaited<ReturnType<CheckpointStoragePort["nextCursor"]>> {
    const cursor = this.#cursors.get(id);
    if (cursor === undefined) throw new TaviError("NOT_FOUND", "Checkpoint cursor is closed or expired");
    const rows: StoredCheckpointTuple[] = [];
    let bytes = 0;
    try {
      for (;;) {
        let row = cursor.buffered;
        delete cursor.buffered;
        if (row === undefined && cursor.iterator !== undefined && cursor.reader !== undefined) {
          const next = cursor.iterator.next();
          if (!next.done) row = tuple(cursor.reader, next.value);
        }
        if (row === undefined) {
          this.closeCursor(id);
          return { rows, done: true };
        }
        const size = serialize(row).byteLength;
        if (rows.length > 0 && bytes + size > DATABASE_LIMITS.messageBytes) {
          cursor.buffered = row;
          return { rows, done: false };
        }
        rows.push(row);
        bytes += size;
        if (bytes >= DATABASE_LIMITS.messageBytes) return { rows, done: false };
      }
    } catch (error) {
      this.closeCursor(id);
      throw error;
    }
  }

  closeCursor(id: string): void {
    const cursor = this.#cursors.get(id);
    if (cursor === undefined) return;
    this.#cursors.delete(id);
    clearTimeout(cursor.timer);
    cursor.iterator?.return?.();
    if (cursor.reader !== undefined) clearStatements(cursor.reader);
    cursor.reader?.close();
    if (cursor.snapshotDirectory !== undefined) rmSync(cursor.snapshotDirectory, { recursive: true, force: true });
  }

  close(): void {
    for (const id of this.#cursors.keys()) this.closeCursor(id);
  }
}
