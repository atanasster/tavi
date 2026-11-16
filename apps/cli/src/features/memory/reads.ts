import type { InvocationContext, MemoryUsedRef } from "@tavi/contracts";

/**
 * What `memory.search` and `memory.get` returned to each task's running turn,
 * and apart from them what `memory.list` did, held until the turn is saved, when
 * `withRunEvents` takes it into the turn's `memoryUsed` beside the evidence
 * its model calls were given. Ids only. A delegated worker's reads are not
 * held: a worker records no memory use of its own.
 */

/** Tasks held at once: the oldest go first, as the memory cards' pending turns do. */
const HELD_TASKS_MAX = 1_024;
/** Revisions held per task: well past what a saved turn names (`MEMORY_USED_RECORDS_MAX`), so its `more` still counts. */
const HELD_READS_MAX = 1_000;

/** `read`: the model asked for these. `listed`: they came with a listing of everything kept. */
type MemoryReadKind = "read" | "listed";

export interface MemoryReads {
  note(context: InvocationContext, read: readonly MemoryUsedRef[], kind?: MemoryReadKind): void;
  take(taskId: string): { readonly records: readonly MemoryUsedRef[]; readonly listed: readonly MemoryUsedRef[] };
}

export function createMemoryReads(): MemoryReads {
  const held = new Map<string, Record<MemoryReadKind, MemoryUsedRef[]>>();
  return {
    note(context, read, kind = "read") {
      if (context.memoryScopeRestricted === true || read.length === 0) return;
      let reads = held.get(context.runId);
      if (reads === undefined) {
        reads = { read: [], listed: [] };
        held.set(context.runId, reads);
        if (held.size > HELD_TASKS_MAX) held.delete(held.keys().next().value as string);
      }
      for (const { recordId, revisionId } of read) {
        if (reads[kind].length >= HELD_READS_MAX) break;
        reads[kind].push({ recordId, revisionId });
      }
    },
    take(taskId) {
      const reads = held.get(taskId);
      held.delete(taskId);
      return { records: reads?.read ?? [], listed: reads?.listed ?? [] };
    },
  };
}
