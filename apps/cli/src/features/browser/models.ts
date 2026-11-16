import { DEFAULT_WORKSPACE_ID, TaviError, type ModelConfigPort, type ModelRole, type ModelTarget } from "@tavi/contracts";

/**
 * Which model each browsing role calls.
 * The browser worker runs on the run's own model — role `main`, as the router
 * routes the task — and the tools it calls pick theirs here:
 *
 * - reading a page (`browser.extract`, `browser.find`) is utility work: the
 *   workspace's `extraction` model, else its `fast` one, else `main`;
 * - acting by sight (`browser.vision_act`) wants the best model that reads
 *   images: `main` first, then its fallback, the workspace default and the
 *   other bound roles, the first of them that reads images.
 *
 * A chat that used or runs on a local connection keeps its pages on local
 * models: only the local candidates are used, and with none the tool refuses,
 * naming the role to bind a local model to.
 *
 * Each ends at the workspace default, then — when the workspace configures
 * neither its own roles nor a default — the default workspace's, as
 * `resolveRunTarget` inherits it, and only then the
 * target the process started with: on an owner started with no model that is
 * a placeholder no call can reach.
 */

export type BrowserModelConfig = Pick<ModelConfigPort, "listRoleBindings" | "getWorkspaceDefault">;

/** A connection's locality, for a chat that keeps its pages on local models. */
type ConnectionLocality = (connectionId: string) => Promise<"local" | "remote" | undefined>;

/** The roles utility calls try, in order. */
const UTILITY_ROLES: readonly ModelRole[] = ["extraction", "fast", "main"];

/** The targets reading pages may use in `workspaceId`, best first: each utility role's chain, then the default. */
async function utilityCandidates(config: BrowserModelConfig, workspaceId: string, started: ModelTarget): Promise<readonly ModelTarget[]> {
  const bindings = await config.listRoleBindings(workspaceId);
  const bound = UTILITY_ROLES.flatMap((role) => {
    const binding = bindings.find((entry) => entry.role === role);
    return binding === undefined ? [] : [binding.target, ...binding.fallback];
  });
  const own = (await config.getWorkspaceDefault(workspaceId))?.target;
  const rest =
    own !== undefined
      ? [own]
      : workspaceId === DEFAULT_WORKSPACE_ID
        ? [started]
        : await utilityCandidates(config, DEFAULT_WORKSPACE_ID, started);
  return [...bound, ...rest];
}

/** Only the local ones of `candidates`, for a chat on a local connection; refused, naming the role to bind, when there is none. */
async function localOnly(
  candidates: readonly ModelTarget[],
  locality: ConnectionLocality,
  role: "extraction" | "main",
  what: string,
): Promise<readonly [ModelTarget, ...ModelTarget[]]> {
  const local: ModelTarget[] = [];
  for (const target of candidates) if ((await locality(target.connectionId)) === "local") local.push(target);
  const [first, ...rest] = local;
  if (first === undefined) {
    throw new TaviError(
      "NOT_CONFIGURED",
      `This chat runs on a local model, so it reads pages only with local models, and none is bound for this. Bind a local ${what} to the \`${role}\` role (tavi models set-role ${role} --connection <id> --model <id>), or use a chat on a remote model.`,
    );
  }
  return [first, ...rest];
}

/**
 * The target for reading pages in `workspaceId`. With `localChat` (the chat
 * used or runs on a local connection) only a local connection is used.
 */
export async function utilityTarget(
  config: BrowserModelConfig,
  workspaceId: string,
  started: ModelTarget,
  localChat?: ConnectionLocality,
): Promise<ModelTarget> {
  const candidates = await utilityCandidates(config, workspaceId, started);
  const allowed = localChat === undefined ? candidates : await localOnly(candidates, localChat, "extraction", "model");
  return allowed[0] ?? started;
}

/**
 * The target for acting by sight in `workspaceId`: the first candidate that reads images, else `main`'s (the tool then refuses, naming it).
 * With `localChat` only a local connection is used.
 */
export async function visionTarget(
  config: BrowserModelConfig,
  workspaceId: string,
  started: ModelTarget,
  readsImages: (target: ModelTarget) => boolean,
  localChat?: ConnectionLocality,
): Promise<ModelTarget> {
  const bindings = await config.listRoleBindings(workspaceId);
  const own = (await config.getWorkspaceDefault(workspaceId))?.target;
  // Neither a `main` of its own nor a default: `main` and the default are the default workspace's.
  const inherits = workspaceId !== DEFAULT_WORKSPACE_ID && own === undefined && !bindings.some((binding) => binding.role === "main");
  const inherited = inherits ? await config.listRoleBindings(DEFAULT_WORKSPACE_ID) : [];
  const main = (inherits ? inherited : bindings).find((binding) => binding.role === "main");
  const fallback = inherits ? (await config.getWorkspaceDefault(DEFAULT_WORKSPACE_ID))?.target : own;
  const others = [...bindings, ...inherited]
    .filter((binding) => binding.role !== "main" && binding.role !== "embedding")
    .map((binding) => binding.target);
  const candidates = [
    ...(main === undefined ? [] : [main.target, ...main.fallback]),
    ...(fallback === undefined ? [] : [fallback]),
    ...others,
  ];
  if (localChat === undefined) return candidates.find(readsImages) ?? candidates[0] ?? started;
  const local = await localOnly([...candidates, started], localChat, "main", "model that reads images");
  return local.find(readsImages) ?? local[0];
}
