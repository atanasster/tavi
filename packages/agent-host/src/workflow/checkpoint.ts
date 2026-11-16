import { captureCheckpoint, captureCheckpointWithFootprint } from "./checkpoint-snapshot.js";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  CHECKPOINT_BLOBS_KEY,
  TaviError,
  type CheckpointStoragePort,
  type StoredCheckpoint,
  type StoredCheckpointBlob,
  type StoredCheckpointTuple,
} from "@tavi/contracts";

const MAX_PENDING = 128;
const MAX_SERIALIZED_BYTES = 32 * 1024 * 1024;
const SENTINEL = JSON.stringify("[unable to serialize, circular reference is too complex to analyze]");
const SENTINEL_BYTES = new TextEncoder().encode(SENTINEL);

/** The serializer's circular-reference marker; only a body of exactly its length is decoded. */
function isSerializationSentinel(bytes: Uint8Array): boolean {
  return bytes.byteLength === SENTINEL_BYTES.byteLength && new TextDecoder().decode(bytes) === SENTINEL;
}

export interface AsyncCheckpointSaverOptions {
  /**
   * Store each checkpoint per channel (`TAVI_CHECKPOINT_BLOBS=1`; off by default): a put serializes and sends only the
   * values of channels whose version changed since the parent, and the body keeps every channel's version. Reads
   * rejoin the values in the worker, so a saver with the flag off, and every reader of `CheckpointStoragePort`, reads
   * either format; the pinned saver refuses a per-channel row. Channel versions become unique numbers (the next
   * integer plus a random fraction), so a value is never stored under a version another branch of the thread used
   * while the flag was on. A saver with the flag off bumps by one and keeps the fraction, so this assumes a thread is
   * not forked from a checkpoint written with the flag off (tavi forks no thread).
   * Relies on LangGraph bumping a channel's version whenever its value changes, which holds for the `"sync"` and
   * `"async"` durabilities tavi runs with (`"exit"` skips the bumps between steps; do not combine the two).
   */
  readonly channelBlobs?: boolean;
}

type Captured = { readonly checkpoint: Checkpoint; readonly metadata: CheckpointMetadata; readonly newVersions: ChannelVersions };

/** Checkpoint-sqlite 1.0.4 serialization semantics with worker-owned SQL. */
export class AsyncCheckpointSaver extends BaseCheckpointSaver {
  readonly #storage: CheckpointStoragePort;
  readonly #channelBlobs: boolean;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #cursors = new Set<string>();
  #pending = 0;
  #bytes = 0;
  #closed = false;
  #serial: Promise<void> = Promise.resolve();
  readonly #reads = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #cleanupError: unknown;

  constructor(storage: CheckpointStoragePort, serde?: SerializerProtocol, options: AsyncCheckpointSaverOptions = {}) {
    super(serde);
    this.#storage = storage;
    this.#channelBlobs = options.channelBlobs === true;
  }

  override getNextVersion(current: number | undefined): number {
    if (!this.#channelBlobs || (current !== undefined && typeof current !== "number")) return super.getNextVersion(current);
    // Still ordered after `current`; the fraction keeps two branches from one checkpoint off each other's values.
    return ((Math.floor(current ?? 0) + 1) * 1_000_000_000 + Math.floor(Math.random() * 999_999_999 + 1)) / 1_000_000_000;
  }

  #enqueue<I, T>(threadId: string, input: I, run: (captured: I) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new TaviError("UNAVAILABLE", "Checkpoint saver is closing"));
    if (this.#pending >= MAX_PENDING) return Promise.reject(new TaviError("BUDGET_EXCEEDED", "Checkpoint serialization queue is full"));
    let bytes: number;
    let captured: I;
    try {
      // One walk copies and counts. Oversized values use the exclusive path; they never accumulate behind another
      // serializer, so with work pending the walk stops as soon as it passes the remaining byte budget.
      ({ value: captured, bytes } = captureCheckpointWithFootprint(
        input,
        this.#pending > 0 ? MAX_SERIALIZED_BYTES - this.#bytes : Number.POSITIVE_INFINITY,
      ));
    } catch (error) {
      return Promise.reject(error);
    }
    this.#pending++;
    this.#bytes += bytes;
    const result = this.#serial.then(() => run(captured));
    const tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.#pending--;
        this.#bytes -= bytes;
        if (this.#tails.get(threadId) === tail) this.#tails.delete(threadId);
      });
    this.#tails.set(threadId, tail);
    this.#serial = tail;
    return result;
  }

  #read<T>(run: () => Promise<T>): Promise<T> {
    const result = run();
    this.#reads.add(result);
    void result.then(
      () => this.#reads.delete(result),
      () => this.#reads.delete(result),
    );
    return result;
  }

  override put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = String(config.configurable?.["thread_id"] ?? "");
    if (threadId === "") return Promise.reject(new Error("Missing thread_id field in config.configurable"));
    const namespace = String(config.configurable?.["checkpoint_ns"] ?? "");
    const parentId = config.configurable?.["checkpoint_id"] === undefined ? null : String(config.configurable["checkpoint_id"]);
    return this.#enqueue(threadId, { checkpoint, metadata, newVersions: newVersions ?? {} }, async (captured) => {
      const row = { threadId, namespace, checkpointId: captured.checkpoint.id, parentId };
      if (!this.#channelBlobs || !(await this.#putPerChannel(row, captured))) await this.#putInline(row, captured);
      return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: captured.checkpoint.id } };
    });
  }

  async #putInline(row: Pick<StoredCheckpoint, "threadId" | "namespace" | "checkpointId" | "parentId">, captured: Captured): Promise<void> {
    const [type, body] = await this.serde.dumpsTyped(captured.checkpoint);
    const [metadataType, meta] = await this.serde.dumpsTyped(captured.metadata);
    if ((type === "json" && isSerializationSentinel(body)) || (metadataType === "json" && isSerializationSentinel(meta))) {
      throw new TaviError("INVALID_INPUT", "Checkpoint serialization failed");
    }
    if (type !== metadataType) throw new Error("Checkpoint and metadata must serialize to the same type");
    await this.#storage.put({ ...row, type, checkpoint: body, metadata: meta });
  }

  /** The named channels' values as JSON blobs at their versions; `undefined` when one does not serialize to JSON. */
  async #blobs(checkpoint: Checkpoint, channels: readonly string[]): Promise<StoredCheckpointBlob[] | undefined> {
    const blobs: StoredCheckpointBlob[] = [];
    for (const channel of channels) {
      const [type, value] = await this.serde.dumpsTyped(checkpoint.channel_values[channel]);
      if (type !== "json") return undefined;
      if (isSerializationSentinel(value)) throw new TaviError("INVALID_INPUT", "Checkpoint serialization failed");
      blobs.push({ channel, version: String(checkpoint.channel_versions[channel]), type, value });
    }
    return blobs;
  }

  /**
   * Store the checkpoint per channel: the body keeps only the values of channels without a version (LangGraph's task
   * queue) and names in `tavi_blobs` the versioned channels that hold one, and the values of those whose version is
   * new travel beside it. A channel the worker does not hold at its version (the thread was stored inline before) is
   * sent on a second put. Answers false, having written nothing, when a value does not serialize to JSON; the caller
   * then stores the checkpoint inline.
   */
  async #putPerChannel(
    row: Pick<StoredCheckpoint, "threadId" | "namespace" | "checkpointId" | "parentId">,
    captured: Captured,
  ): Promise<boolean> {
    const { channel_values: values, ...rest } = captured.checkpoint;
    const versioned = (channel: string) => ["number", "string"].includes(typeof rest.channel_versions[channel]);
    const channels = Object.keys(values).filter(versioned);
    const unversioned = Object.fromEntries(Object.entries(values).filter(([channel]) => !versioned(channel)));
    const changed = await this.#blobs(
      captured.checkpoint,
      channels.filter((channel) => Object.hasOwn(captured.newVersions, channel)),
    );
    if (changed === undefined) return false;
    const [type, body] = await this.serde.dumpsTyped({ ...rest, channel_values: unversioned, [CHECKPOINT_BLOBS_KEY]: channels });
    const [metadataType, meta] = await this.serde.dumpsTyped(captured.metadata);
    if (type !== "json" || metadataType !== "json") return false;
    if (isSerializationSentinel(body) || isSerializationSentinel(meta))
      throw new TaviError("INVALID_INPUT", "Checkpoint serialization failed");
    const stored = { ...row, type, checkpoint: body, metadata: meta };
    const first = await this.#storage.put({ ...stored, blobs: changed });
    if (first === undefined || first.missing.length === 0) return true;
    const carried = await this.#blobs(captured.checkpoint, first.missing);
    if (carried === undefined) return false;
    const second = await this.#storage.put({ ...stored, blobs: [...changed, ...carried] });
    if (second !== undefined && second.missing.length > 0) throw new TaviError("CONFLICT", "Checkpoint channel values could not be stored");
    return true;
  }

  override putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = String(config.configurable?.["thread_id"] ?? "");
    const checkpointId = String(config.configurable?.["checkpoint_id"] ?? "");
    const namespace = String(config.configurable?.["checkpoint_ns"] ?? "");
    if (threadId === "" || checkpointId === "") return Promise.reject(new Error("Missing thread_id or checkpoint_id"));
    return this.#enqueue(threadId, writes, async (captured) => {
      const encoded = [];
      for (const [index, [channel, value]] of captured.entries()) {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        encoded.push({ taskId, channel, index: WRITES_IDX_MAP[channel] ?? index, type, value: bytes });
      }
      await this.#storage.putWrites({
        threadId,
        namespace,
        checkpointId,
        replace: captured.every(([channel]) => channel in WRITES_IDX_MAP),
        writes: encoded,
      });
    });
  }

  override deleteThread(threadId: string): Promise<void> {
    return this.#enqueue(threadId, undefined, async () => this.#storage.deleteThread(threadId));
  }

  async #decode(row: StoredCheckpointTuple, config?: RunnableConfig): Promise<CheckpointTuple> {
    const checkpoint: Checkpoint = await this.serde.loadsTyped(row.type, row.checkpoint);
    const pendingWrites = await Promise.all(
      row.writes.map(
        async (write) => [write.taskId, write.channel, await this.serde.loadsTyped(write.type, write.value)] as [string, string, unknown],
      ),
    );
    return {
      checkpoint,
      config: config ?? { configurable: { thread_id: row.threadId, checkpoint_ns: row.namespace, checkpoint_id: row.checkpointId } },
      metadata: await this.serde.loadsTyped(row.type, row.metadata),
      ...(row.parentId
        ? { parentConfig: { configurable: { thread_id: row.threadId, checkpoint_ns: row.namespace, checkpoint_id: row.parentId } } }
        : {}),
      pendingWrites,
    };
  }

  override getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (this.#closed) return Promise.reject(new TaviError("UNAVAILABLE", "Checkpoint saver is closing"));
    const captured = captureCheckpoint(config);
    const threadId = String(captured.configurable?.["thread_id"] ?? "");
    const checkpointId = captured.configurable?.["checkpoint_id"];
    const tail = this.#tails.get(threadId);
    return this.#read(async () => {
      await tail;
      const row = await this.#storage.get({
        threadId,
        namespace: String(captured.configurable?.["checkpoint_ns"] ?? ""),
        ...(checkpointId ? { checkpointId: String(checkpointId) } : {}),
      });
      return row === undefined ? undefined : this.#decode(row, checkpointId ? captured : undefined);
    });
  }

  /** A thread's newest checkpoint in any namespace, as `list` with `limit: 1` finds it: its id and namespace, in one read. */
  latest(threadId: string): Promise<{ readonly checkpointId: string; readonly checkpointNamespace: string } | undefined> {
    if (this.#closed) return Promise.reject(new TaviError("UNAVAILABLE", "Checkpoint saver is closing"));
    const tails = [...this.#tails.values()];
    return this.#read(async () => {
      await Promise.all(tails);
      const latest = await this.#storage.latest(threadId);
      return latest === undefined ? undefined : { checkpointId: latest.checkpointId, checkpointNamespace: latest.namespace };
    });
  }

  override async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    if (this.#closed) throw new TaviError("UNAVAILABLE", "Checkpoint saver is closing");
    const threadId = config.configurable?.["thread_id"];
    const namespace = config.configurable?.["checkpoint_ns"];
    const before = options?.before?.configurable?.["checkpoint_id"];
    const selection = captureCheckpoint({
      ...(threadId ? { threadId: String(threadId) } : {}),
      ...(namespace == null ? {} : { namespace: String(namespace) }),
      ...(before === undefined ? {} : { before: String(before) }),
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
      ...(options?.filter === undefined ? {} : { filter: options.filter }),
    });
    const tails = [...this.#tails.values()];
    const cursor = await this.#read(async () => {
      await Promise.all(tails);
      if (this.#closed) return undefined;
      const id = await this.#storage.openCursor(selection);
      if (this.#closed) {
        try {
          await this.#storage.closeCursor(id);
        } catch (error) {
          this.#cleanupError = error;
          this.#cursors.add(id);
          throw error;
        }
        return undefined;
      }
      this.#cursors.add(id);
      return id;
    });
    if (cursor === undefined) return;
    try {
      while (!this.#closed) {
        const page = await this.#read(async () => {
          const page = await this.#storage.nextCursor(cursor);
          const rows = [];
          for (const row of page.rows) rows.push(await this.#decode(row));
          return { rows, done: page.done };
        });
        // The storage closes a cursor itself when it answers its last page: nothing is left to close.
        if (page.done) this.#cursors.delete(cursor);
        for (const row of page.rows) {
          if (this.#closed) return;
          yield row;
        }
        if (page.done) return;
      }
    } finally {
      if (this.#cursors.has(cursor))
        await this.#read(async () => {
          try {
            await this.#storage.closeCursor(cursor);
            this.#cursors.delete(cursor);
          } catch (error) {
            this.#cleanupError = error;
            throw error;
          }
        });
    }
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await this.#serial;
      while (this.#reads.size > 0) await Promise.allSettled([...this.#reads]);
      const cursors = [...this.#cursors];
      await Promise.all(
        cursors.map(async (cursor) => {
          await this.#storage.closeCursor(cursor);
          this.#cursors.delete(cursor);
        }),
      );
      if (this.#cleanupError !== undefined) throw this.#cleanupError;
    })();
    return this.#closing;
  }
}
