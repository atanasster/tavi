import { DEFAULT_WORKSPACE_ID, TaviError, type ModelConnection, type ModelSkip, type ModelTarget } from "@tavi/contracts";
import type { ModelConfigPort as ModelConfigService } from "@tavi/contracts";

/**
 * The model target a run resolves:
 * one function for `tavi run`, `tavi serve`'s startup target, and the restart
 * a `models` write simulates, so the three cannot drift.
 *
 * - `--connection` and `--model`: exactly that target, no fallback.
 * - `--connection` alone: that connection, its model the workspace default's
 *   when the default names the same connection, else the connection's own
 *   default model; no fallback. Role bindings are not consulted: the
 *   connection is the operator's.
 * - `--model` alone: the connection role `main` names first (its binding's
 *   target, else the default's), with that model — not passed over for what
 *   the catalog says of the configured model, and not failed over: an
 *   operator's explicit model is run where it was configured to run.
 * - Neither: role `main` through `resolveRole` — its binding's first usable
 *   target and the fallback after it, else the workspace default.
 *
 * A workspace configuring neither a `main` binding nor a default resolves in
 * the default workspace, which is the one `tavi models set-default` writes.
 */

/** The `details.reason` of the refusal for a connection with no model to run. */
const CONNECTION_WITHOUT_MODEL = "connection-without-model";

/** Whether `error` is the refusal for a connection with no model: the operator's to name with `--model`. */
export const isConnectionWithoutModel = (error: unknown): error is TaviError =>
  error instanceof TaviError && error.code === "INVALID_INPUT" && error.details?.["reason"] === CONNECTION_WITHOUT_MODEL;

/** Where the target came from. */
export type RunTargetSource = "flags" | "connection" | "role" | "default";

export interface RunTarget {
  readonly source: RunTargetSource;
  readonly target: ModelTarget;
  /** The stored connection, when there is one (a flags-only target may name none). */
  readonly connection?: ModelConnection;
  /** The fallback after `target`, in order, each with its connection: only a role binding has one. */
  readonly fallback: readonly { readonly target: ModelTarget; readonly connection: ModelConnection }[];
  /** Candidates resolution passed over — before `target`, then in its fallback — and why. */
  readonly skipped: readonly ModelSkip[];
}

export interface RunTargetRequest {
  readonly workspaceId: string;
  readonly connectionId?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Resolve the target; `undefined` when nothing is configured at all. A
 * configuration that resolves to nothing usable — every target skipped, or a
 * connection with no model — throws the typed refusal.
 */
export async function resolveRunTarget(service: ModelConfigService, request: RunTargetRequest): Promise<RunTarget | undefined> {
  const stored = async (connectionId: string): Promise<ModelConnection | undefined> =>
    (await service.listConnections()).find((connection) => connection.connectionId === connectionId);
  if (request.connectionId !== undefined && request.model !== undefined) {
    const connection = await stored(request.connectionId);
    return {
      source: "flags",
      target: { connectionId: request.connectionId, model: request.model },
      ...(connection === undefined ? {} : { connection }),
      fallback: [],
      skipped: [],
    };
  }
  if (request.connectionId !== undefined) {
    // Unknown connections are refused (`NOT_FOUND`), as they always were.
    const connection = await service.getConnection(request.connectionId);
    const own = await service.getWorkspaceDefault(request.workspaceId);
    const inherited =
      own ?? (request.workspaceId === DEFAULT_WORKSPACE_ID ? undefined : await service.getWorkspaceDefault(DEFAULT_WORKSPACE_ID));
    const model =
      (inherited?.target.connectionId === connection.connectionId ? inherited.target.model : undefined) ?? connection.defaultModel;
    if (model === undefined) {
      throw new TaviError("INVALID_INPUT", `connection ${connection.connectionId} has no default model: pass --model`, {
        details: { connectionId: connection.connectionId, reason: CONNECTION_WITHOUT_MODEL },
      });
    }
    return { source: "connection", target: { connectionId: connection.connectionId, model }, connection, fallback: [], skipped: [] };
  }
  if (request.model !== undefined) {
    // The configured connection, the operator's model: what the catalog says
    // of the configured model is no reason to move it to another connection.
    const configured =
      (await firstConfigured(service, request.workspaceId)) ??
      (request.workspaceId === DEFAULT_WORKSPACE_ID ? undefined : await firstConfigured(service, DEFAULT_WORKSPACE_ID));
    if (configured === undefined) return undefined;
    const connection = await service.getConnection(configured.target.connectionId);
    return {
      source: configured.source,
      target: { connectionId: connection.connectionId, model: request.model },
      connection,
      fallback: [],
      skipped: [],
    };
  }
  const resolved =
    (await resolveMain(service, request.workspaceId)) ??
    (request.workspaceId === DEFAULT_WORKSPACE_ID ? undefined : await resolveMain(service, DEFAULT_WORKSPACE_ID));
  if (resolved === undefined) return undefined;
  // A fallback is passed over as resolution passes over a primary: its
  // connection gone, or its model one the catalog marks unavailable — so a
  // failover never lands on a target resolution would have refused, and ends
  // the turn there with the rest of the chain untried.
  const passedOver: ModelSkip[] = [];
  const fallback = (
    await Promise.all(
      resolved.fallback.map(async (target) => {
        const connection = await stored(target.connectionId);
        if (connection === undefined) {
          passedOver.push({ target, reason: "missing-connection" });
          return [];
        }
        const entry = (await service.listCatalog(target.connectionId)).find((candidate) => candidate.modelId === target.model);
        if (entry?.state === "unavailable") {
          passedOver.push({ target, reason: "unavailable-model" });
          return [];
        }
        return [{ target, connection }];
      }),
    )
  ).flat();
  return {
    source: resolved.source === "role-override" ? "role" : "default",
    target: resolved.target,
    connection: resolved.connection,
    fallback,
    skipped: [...resolved.skipped, ...passedOver],
  };
}

/**
 * `resolveRunTarget` as a running owner reads it at each turn and command:
 * `undefined` when stored configuration resolves nothing usable —
 * none at all, a connection with no model, every target unusable — and the
 * owner runs what it started with.
 */
export async function resolveLiveTarget(service: ModelConfigService, request: RunTargetRequest): Promise<RunTarget | undefined> {
  try {
    return await resolveRunTarget(service, request);
  } catch (error) {
    if (isConnectionWithoutModel(error)) return undefined;
    if (error instanceof TaviError && ["NOT_CONFIGURED", "CAPABILITY_MISSING", "NOT_FOUND"].includes(error.code)) return undefined;
    throw error;
  }
}

/** Role `main`'s first configured target in `workspaceId` — its binding's, else the default's — unchecked. */
async function firstConfigured(
  service: ModelConfigService,
  workspaceId: string,
): Promise<{ readonly source: RunTargetSource; readonly target: ModelTarget } | undefined> {
  const binding = (await service.listRoleBindings(workspaceId)).find((candidate) => candidate.role === "main");
  if (binding !== undefined) return { source: "role", target: binding.target };
  const fallback = await service.getWorkspaceDefault(workspaceId);
  return fallback === undefined ? undefined : { source: "default", target: fallback.target };
}

/**
 * Role `main` in `workspaceId`, or `undefined` when that workspace configures
 * neither a binding nor a default. A configuration that names targets but none
 * usable is not "unconfigured": its refusal is thrown.
 */
async function resolveMain(service: ModelConfigService, workspaceId: string) {
  try {
    return await service.resolveRole({ workspaceId, role: "main" });
  } catch (error) {
    // Unconfigured, as opposed to every target unusable: resolution names what it skipped only for the latter.
    if (error instanceof TaviError && error.code === "NOT_CONFIGURED" && error.details?.["skipped"] === undefined) return undefined;
    throw error;
  }
}
