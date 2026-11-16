import type { ContentLabel } from "../content-label.js";

/** Disposable read/query surface over the pinned LangGraph saver tables. */
export type CheckpointQueryPort = {
  /** Most recent checkpoint for a thread, when one exists. */
  latest(threadId: string): Promise<CheckpointDescriptor | undefined>;
  /**
   * Newest-first checkpoints for a thread.
   *
   * The namespace is returned per descriptor rather than as one scalar: the
   * saver stores it per row, so a single field would misreport as soon as a
   * non-default namespace exists.
   */
  listCheckpoints(threadId: string, limit: number): Promise<readonly CheckpointDescriptor[]>;
  /**
   * The newest epoch summary in a thread's checkpointed conversation,
   * if it rolled over; what a side chat opened from it begins with. Absent
   * on a port that cannot read conversations.
   */
  latestEpochSummary?(threadId: string): Promise<string | undefined>;
  /**
   * The context label a thread's checkpointed state holds: what a worker's
   * result carries to its parent. Undefined when
   * the thread has no checkpoint; absent on a port that cannot read state.
   * A caller reads either as an agent's words, untrusted.
   */
  contextLabel?(threadId: string): Promise<ContentLabel | undefined>;
  /**
   * The URLs a thread's conversation knows, as the
   * outbound disarm of its replies reads them: its `knownUrls` channel
   * and its person's messages. Undefined when the thread has no checkpoint;
   * absent on a port that cannot read state. A caller reads either as none.
   */
  knownUrls?(threadId: string): Promise<ReadonlySet<string> | undefined>;
};

export interface CheckpointDescriptor {
  readonly threadId: string;
  readonly checkpointId: string;
  readonly parentCheckpointId: string | null;
  readonly checkpointNamespace: string;
  readonly createdAt: string | null;
}
