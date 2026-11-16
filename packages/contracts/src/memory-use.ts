import type { AsyncRepository } from "./persistence-types.js";

/**
 * Which memories a chat's turns were given: each
 * record retrieved into a model call's context, once per chat, with when it
 * was first and last given. The chat panel lists them as "Used here".
 */
export interface TaskMemoryUse {
  readonly taskId: string;
  readonly recordId: string;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
  /** The turn that last used it. */
  readonly lastAdmissionId: string;
}

/** The most records one read of a chat's use returns. */
export const TASK_MEMORY_USE_MAX = 100;

interface TaskMemoryUseRepositoryPortDefinition {
  /** Note that a turn was given these records; a record already noted for the chat has its last use moved on. */
  record(input: {
    readonly taskId: string;
    readonly admissionId: string;
    readonly recordIds: readonly string[];
    readonly at: string;
  }): void;
  /** The chat's records, most recently used first, at most `limit` (bounded by `TASK_MEMORY_USE_MAX`). */
  list(taskId: string, limit: number): readonly TaskMemoryUse[];
}

export type TaskMemoryUseRepositoryPort = AsyncRepository<TaskMemoryUseRepositoryPortDefinition>;
