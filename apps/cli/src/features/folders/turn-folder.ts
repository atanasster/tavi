import {
  isPlumbingOrigin,
  type ChatFolder,
  type InvocationContext,
  type TaskOrigin,
  type TaskRecord,
  type TurnChannel,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { ChatFolders } from "@tavi/runtime";

export interface TurnFolderDependencies {
  readonly folders: Pick<ChatFolders, "resolve" | "managedPath">;
  readonly notices: {
    postFolderBudget(taskId: string, warning: string): Promise<void>;
  };
  readonly space: { crossing(managed: string, taskId?: string): Promise<string | undefined> };
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
}

export type TurnFolder = (
  invocation: InvocationContext,
  turn: {
    readonly heldChannel?: TurnChannel | undefined;
    readonly tainted: boolean;
    readonly origin?: TaskOrigin | undefined;
    /** The task's row as its admission read it: its creation facts are not read again. */
    readonly task?: TaskRecord | undefined;
  },
) => Promise<ChatFolder | undefined>;

/**
 * The chat's working folder, once per admission: a worker's is its
 * root chat's, a held turn's the managed folder only. A chat whose own folder has just
 * crossed 80% of its budget is told once per crossing.
 * Every turn resolves it this way — a routine's fires too, each its own —
 * except a heartbeat tick's, which has none.
 */
export function createTurnFolder(deps: TurnFolderDependencies): TurnFolder {
  return async (invocation, turn) => {
    // A heartbeat tick, or an idea's prepared step, has no folder: one per run would be created, backed up,
    // and orphaned once its task is pruned. Nothing under chats/ is made for it, and the file tools refuse without one.
    if (isPlumbingOrigin(turn.origin)) return undefined;
    // A worker's first turn may run before its delegation is recorded: its spawn names its chat.
    const folder = await deps.folders.resolve(
      { workspaceId: invocation.workspaceId, principalId: invocation.principalId },
      invocation.runId,
      { ...turn, delegatedFrom: invocation.chatTaskId },
    );
    // In the chat that owns the folder, never a worker's (whose folder is its root chat's).
    // Measured off the turn's path: the notice is for the person, and the walk can be long.
    if (folder.managed === deps.folders.managedPath(invocation.workspaceId, invocation.runId)) {
      void deps.space
        .crossing(folder.managed, invocation.runId)
        .then(async (warning) => {
          if (warning !== undefined) await deps.notices.postFolderBudget(invocation.runId, warning);
        })
        .catch((error: unknown) =>
          deps.warn("a chat's folder budget could not be measured", { taskId: invocation.runId, error: errorMessage(error) }),
        );
    }
    return folder;
  };
}
