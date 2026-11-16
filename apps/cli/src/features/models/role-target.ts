import type { InvocationContext, ModelRoleBinding, ModelTarget, ProviderAttemptSummary } from "@tavi/contracts";
import { chooseRoleTarget, type ConnectionLocality } from "@tavi/agent-host/task-summarizer";

/**
 * The workflow's `roleTarget`: the stage-2 summary on
 * `compaction`, the flush on `extraction`, else `fast` (`roleOrFast`). A role the workspace bound, never
 * the default, and never a remote one for a chat that used or runs on a local
 * connection (as the idle review applies it). Unbound or
 * skipped, the answer is `undefined` and the call stays on the turn's model.
 */
/**
 * A background call's bound model: its role's binding, else `fast`'s — a background call is never worth the
 * main model when a fast one is bound. `undefined`: neither is bound, and the call stays on the chat's own.
 */
export function roleOrFast(bindings: readonly ModelRoleBinding[], role: ModelRoleBinding["role"]): ModelTarget | undefined {
  return (bindings.find((binding) => binding.role === role) ?? bindings.find((binding) => binding.role === "fast"))?.target;
}

export function createRoleTarget(deps: {
  readonly roleBindings: (workspaceId: string) => readonly ModelRoleBinding[] | Promise<readonly ModelRoleBinding[]>;
  readonly attempts: (taskId: string) => Promise<readonly ProviderAttemptSummary[]>;
  readonly locality: (connectionId: string) => Promise<ConnectionLocality | undefined>;
}): (role: "compaction" | "extraction", invocation: InvocationContext, own: ModelTarget) => Promise<ModelTarget | undefined> {
  return async (role, invocation, own) => {
    const bound = roleOrFast(await deps.roleBindings(invocation.workspaceId), role);
    if (bound === undefined) return undefined;
    // A worker's words came from its chat: the chat's connections count as well as its own.
    const tasks = [...new Set([invocation.runId, invocation.chatTaskId ?? invocation.runId])];
    const used = (await Promise.all(tasks.map((taskId) => deps.attempts(taskId))))
      .flat()
      .filter((attempt) => attempt.purpose === "generation")
      .map((attempt) => attempt.connectionId);
    return await chooseRoleTarget({ own, bound, used, locality: deps.locality });
  };
}
