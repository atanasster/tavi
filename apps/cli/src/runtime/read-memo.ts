import type { AgentDelegationRepositoryPort, PersistencePort, WorkspaceSettingsRepositoryPort } from "@tavi/contracts";
import type { DatabaseClient } from "@tavi/runtime";
import { SettledMemo } from "../features/models/locality-memo.js";

/**
 * The owner's memos of reads a turn makes many times over: none guards a race
 * (a lease's generation, a cancellation, a checkpoint stay fresh reads), and
 * each is dropped when a write that could change it settles on this client,
 * as the chat-locality memos (`locality-memo.ts`) are.
 *
 * - A workspace's settings: written only by `workspaceSettings.set`, so any
 *   `workspaceSettings` write drops them; a `tavi config set` still reaches the
 *   next model call. The security reads (`tools.redactResults`,
 *   `security.taint`, the injection detector) stay per call in
 *   `runtime/asking.ts`, so a failed read there still fails closed.
 * - A worker's delegation row: written once, by `agentDelegations.recordSpawn`
 *   (and gone with its task), so a spawn or a delete drops them — a chat that
 *   had none is asked again once a worker could have been recorded.
 * - A task's origin: fixed when the task is created, kept only once its row
 *   exists.
 */
export function createOwnerReadMemos(
  store: Pick<DatabaseClient, "onSettled">,
  repositories: PersistencePort["repositories"],
): OwnerReadMemos {
  const settingsMemo = new SettledMemo<string, Awaited<ReturnType<WorkspaceSettingsRepositoryPort["get"]>>>();
  const delegationMemo = new SettledMemo<string, Awaited<ReturnType<AgentDelegationRepositoryPort["getByWorkerTaskId"]>>>();
  const originMemo = new SettledMemo<string, { readonly exists: boolean; readonly origin: string | null | undefined }>();
  store.onSettled((operation) => {
    if (operation.startsWith("repository.workspaceSettings.") && !/\.(get|list)$/.test(operation)) settingsMemo.clear();
    if (operation === "repository.agentDelegations.recordSpawn" || /delete|remove|purge|reset/i.test(operation)) {
      delegationMemo.clear();
      originMemo.clear();
    }
  });
  // The repositories are plain objects of methods: spread, with the memoised read in place of the original.
  const workspaceSettings: WorkspaceSettingsRepositoryPort = {
    ...repositories.workspaceSettings,
    get: (workspaceId) => settingsMemo.read(workspaceId, () => repositories.workspaceSettings.get(workspaceId)),
  };
  const agentDelegations: AgentDelegationRepositoryPort = {
    ...repositories.agentDelegations,
    getByWorkerTaskId: (workerTaskId) =>
      delegationMemo.read(workerTaskId, () => repositories.agentDelegations.getByWorkerTaskId(workerTaskId)),
  };
  /** How a task was started (`TaskRecord.origin`); undefined for a task that does not exist. */
  const taskOrigin = async (taskId: string): Promise<string | null | undefined> =>
    (
      await originMemo.read(
        taskId,
        async () => {
          const task = await repositories.tasks.get(taskId);
          return { exists: task !== undefined, origin: task?.origin };
        },
        (read) => read.exists,
      )
    ).origin;
  return { workspaceSettings, agentDelegations, taskOrigin };
}

/** What `createOwnerReadMemos` answers. */
export interface OwnerReadMemos {
  readonly workspaceSettings: WorkspaceSettingsRepositoryPort;
  readonly agentDelegations: AgentDelegationRepositoryPort;
  readonly taskOrigin: (taskId: string) => Promise<string | null | undefined>;
}
