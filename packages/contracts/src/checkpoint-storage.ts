/** Serialized checkpoint data; LangGraph objects are encoded by the adapter before RPC. */
export interface StoredCheckpoint {
  readonly threadId: string;
  readonly namespace: string;
  readonly checkpointId: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly checkpoint: Uint8Array;
  readonly metadata: Uint8Array;
  /**
   * Present when the checkpoint is stored per channel (`AsyncCheckpointSaver`'s `channelBlobs`): its body's
   * `channel_values` then holds only channels without a version, and `tavi_blobs` names the versioned channels that
   * hold a value, each kept once per version in `tavi_checkpoint_blobs`. Carries the values of the channels whose
   * version changed since the parent; may be empty.
   */
  readonly blobs?: readonly StoredCheckpointBlob[];
}
/** The body field of a per-channel checkpoint that names the channels holding a value. */
export const CHECKPOINT_BLOBS_KEY = "tavi_blobs";
/** One channel's serialized value at one version. */
export interface StoredCheckpointBlob {
  readonly channel: string;
  readonly version: string;
  readonly type: string;
  readonly value: Uint8Array;
}
/**
 * What a per-channel put answers: the channels the body lists whose value at its version is neither stored nor
 * carried (a thread written inline before, by another saver or with the flag off). Nothing was written; the caller
 * puts again carrying them.
 */
export interface CheckpointPutResult {
  readonly missing: readonly string[];
}
export interface StoredCheckpointWrite {
  readonly taskId: string;
  readonly index: number;
  readonly channel: string;
  readonly type: string;
  readonly value: Uint8Array;
}
/** As read: always one inline body (a per-channel checkpoint's channels rejoined by version), never `blobs`. */
export interface StoredCheckpointTuple extends StoredCheckpoint {
  readonly writes: readonly StoredCheckpointWrite[];
}
export interface CheckpointSelection {
  readonly threadId?: string;
  readonly namespace?: string;
  readonly before?: string;
  readonly limit?: number;
  readonly filter?: Readonly<Record<string, unknown>>;
}
/** How many checkpoints a thread keeps when it is pruned: a resume reads only the newest. */
export const CHECKPOINTS_KEPT = 20;

export interface CheckpointStoragePort {
  get(input: {
    readonly threadId: string;
    readonly namespace: string;
    readonly checkpointId?: string;
  }): Promise<StoredCheckpointTuple | undefined>;
  /** Answers `missing` only for a per-channel put that lacks a value; it then wrote nothing. */
  put(input: StoredCheckpoint): Promise<CheckpointPutResult | undefined>;
  putWrites(input: {
    readonly threadId: string;
    readonly namespace: string;
    readonly checkpointId: string;
    readonly replace: boolean;
    readonly writes: readonly StoredCheckpointWrite[];
  }): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  /** Keep a thread's newest `keep` checkpoints in each namespace, and their writes; answers how many were removed. */
  pruneThread(input: { readonly threadId: string; readonly keep: number }): Promise<number>;
  /**
   * A thread's newest checkpoint in any namespace, as `openCursor` with `limit: 1`
   * orders them: its id and namespace only, in one read.
   */
  latest(threadId: string): Promise<{ readonly checkpointId: string; readonly namespace: string } | undefined>;
  openCursor(input: CheckpointSelection): Promise<string>;
  /** A page of rows; `done` answers the last one, and the cursor is closed with it (as on a failed read). */
  nextCursor(cursorId: string): Promise<{ readonly rows: readonly StoredCheckpointTuple[]; readonly done: boolean }>;
  closeCursor(cursorId: string): Promise<void>;
}
