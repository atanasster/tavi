import type { RunnableConfig } from "@langchain/core/runnables";
import { type ExecutionRepositoryPort, TaviError } from "@tavi/contracts";

/** Thread id from a runnable config; observers are keyed by it. */
export function threadIdOf(config: RunnableConfig | undefined): string {
  const configurable = (config?.configurable ?? {}) as { thread_id?: unknown };
  return typeof configurable.thread_id === "string" ? configurable.thread_id : "";
}

/** Execution lease carried in the runnable config, not in mutable adapter state. */
export function executionLeaseOf(
  config: RunnableConfig | undefined,
): { readonly taskId: string; readonly generation: number; readonly admissionId: string } | undefined {
  const configurable = (config?.configurable ?? {}) as {
    executionLease?: { taskId: string; generation: number; admissionId: string };
  };
  return configurable.executionLease;
}

/**
 * Refuse to write without a current execution lease.
 *
 * A node reached without a lease means this invocation does not own the task, so
 * the safe answer is to stop rather than to write.
 */
export async function assertLeaseCurrent(
  options: { readonly executions: ExecutionRepositoryPort; readonly ownerSession: string },
  config: RunnableConfig | undefined,
): Promise<void> {
  const lease = executionLeaseOf(config);
  if (lease === undefined) {
    throw new TaviError("CONFLICT", "invocation reached a write boundary without an execution lease");
  }
  await options.executions.assertCurrentGeneration(lease.taskId, lease.generation, options.ownerSession);
}
