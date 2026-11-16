import {
  TaviError,
  type InvocationContext,
  type ModelConfigPort,
  type ModelPort,
  type ModelTarget,
  type ModelUsage,
} from "@tavi/contracts";
import { connectionLocality, type ConnectionLocality } from "@tavi/agent-host/task-summarizer";

/**
 * The `embedding` model role, looked up and called.
 *
 * Only an explicit `embedding` binding counts: the workspace default names a
 * chat model, so it is never used to embed. Each answer says whether the
 * bound connection is local or remote (declared local-only, or
 * an endpoint on this machine), so a caller can apply the rule — a chat on
 * a local connection never sends its query to a remote embedding connection —
 * and `embed` applies it itself when asked to with `localOnly`. A failed call
 * is not failed over to another model (vectors from two models cannot be
 * compared); resolution may pick a listed fallback only when it passes over
 * the first target, and every answer names the target it used.
 */
interface EmbeddingRole {
  readonly target: ModelTarget;
  readonly locality: ConnectionLocality;
}

interface EmbeddingCall {
  /** The run the call is recorded against, and the authority it runs with. */
  readonly context: InvocationContext;
  readonly texts: readonly string[];
  readonly signal: AbortSignal;
  /** Refuse a remote embedding connection: the texts come from a chat on a local connection. */
  readonly localOnly?: boolean;
}

interface EmbeddingAnswer extends EmbeddingRole {
  /** One vector per text, in order, all of one dimension, as the model answered them. */
  readonly vectors: readonly Float32Array[];
  readonly usage: ModelUsage;
}

export interface EmbeddingRoleService {
  /** The bound role, or `NOT_CONFIGURED` when there is none (or `CAPABILITY_MISSING` / `NOT_CONFIGURED` when none of its targets is usable). */
  role(workspaceId: string): Promise<EmbeddingRole>;
  /** One metered embedding call on the bound role; any refusal or failure is a typed error. */
  embed(call: EmbeddingCall): Promise<EmbeddingAnswer>;
}

/** Every embedding attempt's id starts with this, so doctor finds memory's embedding spend in the ledger. */
export const MEMORY_EMBEDDING_ATTEMPT_PREFIX = "memory-embed-";

/** The `details.reason` of the refusal to send a local chat's texts to a remote embedding connection. */
export const REMOTE_EMBEDDING_REFUSED = "remote-embedding-for-local-chat";

export function createEmbeddingRole(deps: {
  readonly modelConfig: ModelConfigPort;
  /** The accounted model port: dispatch is checked and the attempt recorded there. */
  readonly models: ModelPort;
  readonly newId: () => string;
}): EmbeddingRoleService {
  const role = async (workspaceId: string): Promise<EmbeddingRole> => {
    const bound = (await deps.modelConfig.listRoleBindings(workspaceId)).some((binding) => binding.role === "embedding");
    if (!bound) {
      throw new TaviError(
        "NOT_CONFIGURED",
        `No embedding model is bound in workspace ${workspaceId}. Bind one with \`tavi models set-role embedding --connection <id> --model <id>\`.`,
        {
          details: { workspaceId, role: "embedding" },
        },
      );
    }
    // The binding's first usable target: the catalog's refusals (an unavailable model, a missing connection) are resolution's.
    const resolution = await deps.modelConfig.resolveRole({ workspaceId, role: "embedding" });
    return { target: resolution.target, locality: connectionLocality(resolution.connection) };
  };
  return {
    role,
    async embed(call) {
      // Pin the binding before reading locality: dispatch refuses any change after the pin, so the
      // connection checked below is the connection the texts are sent to.
      const first = await role(call.context.workspaceId);
      const pinned = await deps.models.resolveBinding?.(first.target, call.context);
      const bound = await role(call.context.workspaceId);
      if (call.localOnly === true && bound.locality === "remote") {
        throw new TaviError(
          "NOT_AUTHORIZED",
          `The embedding connection ${bound.target.connectionId} is remote, and these texts come from a chat on a local connection`,
          {
            details: { reason: REMOTE_EMBEDDING_REFUSED, connectionId: bound.target.connectionId },
          },
        );
      }
      if (deps.models.embed === undefined) throw new TaviError("CAPABILITY_MISSING", "This model transport cannot compute embeddings");
      const outcome = await deps.models.embed(
        {
          connectionId: bound.target.connectionId,
          model: bound.target.model,
          runId: call.context.runId,
          attemptId: `${MEMORY_EMBEDDING_ATTEMPT_PREFIX}${deps.newId()}`,
          texts: [...call.texts],
        },
        { signal: call.signal, context: call.context, ...(pinned === undefined ? {} : { expectedBindingHash: pinned.bindingHash }) },
      );
      if (outcome.status !== "completed") {
        throw new TaviError(
          outcome.status === "aborted" ? "ABORTED" : "MODEL_FAILED",
          outcome.error?.message ?? "The embedding call failed",
          {
            details: {
              connectionId: bound.target.connectionId,
              model: bound.target.model,
              ...(outcome.error === undefined ? {} : { modelError: outcome.error.code, retryable: outcome.error.retryable }),
            },
          },
        );
      }
      return { ...bound, vectors: outcome.vectors, usage: outcome.usage };
    },
  };
}
