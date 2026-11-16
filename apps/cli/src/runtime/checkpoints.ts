import type { CheckpointReceiptRepositoryPort } from "@tavi/contracts";
import type { DatabaseClient } from "@tavi/runtime";

/**
 * Composition root for the CLI launcher.
 *
 * This is the only module that knows both the runtime kernel and the concrete
 * core plugins; `@tavi/runtime` never imports `@tavi/agent-host`.
 */
/**
 * Tasks examined per restart reconciliation.
 *
 * A bound is required: reconciliation must not load an unbounded history. Hitting
 * it is reported so a truncated check is never mistaken for a complete one.
 */
export const RECONCILIATION_TASK_LIMIT = 1000;

/**
 * Count recorded checkpoints.
 *
 * A data directory where no graph has run yet has no saver tables at all, so the
 * saver-owned table is probed before it is queried.
 */
export async function countCheckpoints(store: DatabaseClient): Promise<number> {
  return await store.countCheckpoints();
}

/**
 * Reconcile the application's receipts with the saver's checkpoints.
 *
 * Run before admissions open on restart. Two directions matter:
 *
 *  - a checkpoint the application never recorded is a **missing receipt**: the
 *    application must observe it rather than assume progress did not happen;
 *  - a recorded receipt with no checkpoint behind it is a **dangling receipt**,
 *    which means the saver lost or never wrote it and the task must not be
 *    treated as having progressed.
 */
export interface ReconciliationReport {
  readonly observed: readonly { readonly taskId: string; readonly checkpointId: string }[];
  readonly dangling: readonly { readonly taskId: string; readonly checkpointId: string }[];
}

export async function reconcileCheckpointReceipts(input: {
  readonly tasks: readonly { readonly taskId: string; readonly threadId: string }[];
  readonly receipts: CheckpointReceiptRepositoryPort;
  /** Full descriptor, so the receipt records the namespace the graph wrote. */
  readonly latestCheckpoint: (
    threadId: string,
  ) =>
    | Promise<{ readonly checkpointId: string; readonly checkpointNamespace: string } | undefined>
    | { readonly checkpointId: string; readonly checkpointNamespace: string }
    | undefined;
  readonly now: () => string;
  /**
   * False when no checkpoint reader is available.
   *
   * Without a reader a task looks unreceipted, so reporting it as dangling would
   * manufacture a data-loss report out of a missing dependency.
   */
  readonly canReadCheckpoints?: boolean;
}): Promise<ReconciliationReport> {
  if (input.canReadCheckpoints === false) {
    return { observed: [], dangling: [] };
  }

  const observed: { taskId: string; checkpointId: string }[] = [];
  const dangling: { taskId: string; checkpointId: string }[] = [];

  for (const task of input.tasks) {
    const checkpoint = await input.latestCheckpoint(task.threadId);
    const receipt = await input.receipts.latestForTask(task.taskId);

    if (checkpoint === undefined) {
      // Progress was claimed in application storage but the saver has nothing:
      // report it rather than silently trusting either side.
      if (receipt !== undefined) dangling.push({ taskId: task.taskId, checkpointId: receipt.checkpointId });
      continue;
    }

    // Comparing only presence would miss the case this gate exists for: the
    // process died after a newer checkpoint became durable but before its receipt
    // was written, leaving an older receipt on record.
    if (receipt === undefined || receipt.checkpointId !== checkpoint.checkpointId) {
      await input.receipts.record({
        taskId: task.taskId,
        threadId: task.threadId,
        checkpointNamespace: checkpoint.checkpointNamespace,
        checkpointId: checkpoint.checkpointId,
        // No admission observed this: reconciliation did.
        admissionId: null,
        source: "reconcile",
        now: { fixed: input.now() },
      });
      observed.push({ taskId: task.taskId, checkpointId: checkpoint.checkpointId });
    }
  }
  return { observed, dangling };
}
