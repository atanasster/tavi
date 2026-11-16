import {
  TaviError,
  type ModelConfigRepositoryPort,
  type ModelPriceSheet,
  type ModelTarget,
  type RouterPort,
  type RouterRepositoryPort,
  type RouterScope,
  type TaskRoute,
  type TaskRoutingPort,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { ProviderConnection } from "@tavi/agent-host/models";

export interface TaskRoutingOptions {
  readonly router: RouterPort;
  readonly repository: RouterRepositoryPort;
  readonly models: ModelConfigRepositoryPort;
  /** A connection as configured now: the store's, else one the owner was launched with. */
  readonly connection: (connectionId: string) => Promise<ProviderConnection | undefined>;
  readonly baseline: ModelTarget;
  readonly fallback: readonly ModelTarget[];
  /** The default chain as configured now; absent or `undefined`, `baseline` and `fallback`. */
  readonly liveBaseline?: (scope: RouterScope) => Promise<readonly ModelTarget[] | undefined>;
  readonly readSecret: (reference: string) => Promise<string | null>;
  readonly price: (target: ModelTarget, at: string) => Promise<ModelPriceSheet | undefined>;
  readonly now: () => string;
  readonly providerTarget?: (target: ModelTarget, scope: RouterScope) => Promise<boolean | undefined>;
  /**
   * A connection's locality. A chain that starts on a local connection keeps
   * only its local fallbacks, and a chat that starts on one never asks the router.
   */
  readonly locality?: (connectionId: string) => Promise<"local" | "remote" | undefined>;
  /** Whether a chat used, or runs on, a local connection: one with no saved route never moves onto a remote default. */
  readonly chatIsLocal?: (scope: RouterScope, taskId: string) => Promise<boolean>;
}
const key = (target: ModelTarget) => JSON.stringify([target.connectionId, target.model]);
const distinct = (targets: readonly ModelTarget[]) =>
  targets.filter((target, index) => targets.findIndex((other) => key(other) === key(target)) === index).slice(0, 4);

/** What a local chat says when no local model in its chain is left to answer. */
export const LOCAL_CHAIN_UNAVAILABLE =
  "This chat runs on a local model, and no local model in its chain is available. A local chat never falls back to a remote model: start the local model, add a local fallback, or choose a remote model for this chat yourself.";

/**
 * A chain as a local chat may run it: one that starts on a local connection
 * keeps only its local targets; any other is unchanged.
 */
async function keepLocalChain(
  chain: readonly ModelTarget[],
  locality: ((connectionId: string) => Promise<"local" | "remote" | undefined>) | undefined,
): Promise<readonly ModelTarget[]> {
  const first = chain[0];
  if (locality === undefined || first === undefined || (await locality(first.connectionId)) !== "local") return chain;
  const kept: ModelTarget[] = [first];
  for (const target of chain.slice(1)) if ((await locality(target.connectionId)) === "local") kept.push(target);
  return kept;
}

/**
 * A task's saved model route, replayed on every later turn. Host-owned and
 * independent of any routing provider: disabling routing never changes the
 * model an existing task was admitted with.
 */
function createSavedRoutes(options: Pick<TaskRoutingOptions, "repository" | "models" | "connection" | "providerTarget" | "locality">) {
  const usable = async (target: ModelTarget, scope: RouterScope): Promise<boolean> => {
    const provider = await options.providerTarget?.(target, scope);
    if (provider !== undefined) return provider;
    if ((await options.connection(target.connectionId)) === undefined) return false;
    return (await options.models.listCatalog(target.connectionId)).find((entry) => entry.modelId === target.model)?.state !== "unavailable";
  };
  const filterUsable = async (candidates: readonly ModelTarget[], scope: RouterScope): Promise<ModelTarget[]> => {
    const targets: ModelTarget[] = [];
    for (const target of candidates) if (await usable(target, scope)) targets.push(target);
    return targets;
  };
  const chain = async (route: TaskRoute, scope: RouterScope): Promise<TaskRoute> => {
    const saved = [route.target, ...route.fallback];
    const allowed = await keepLocalChain(saved, options.locality);
    const targets = await filterUsable(allowed, scope);
    const target = targets[0];
    if (target === undefined)
      throw new TaviError(
        "NOT_CONFIGURED",
        allowed.length < saved.length
          ? LOCAL_CHAIN_UNAVAILABLE
          : "The task's saved model route is unavailable; restore its connection or a saved fallback and retry",
      );
    return { ...route, target, fallback: targets.slice(1) };
  };
  return {
    usable,
    filterUsable,
    chain,
    async effectiveTarget(scope: RouterScope, taskId: string): Promise<ModelTarget | undefined> {
      const route = await options.repository.route(scope, taskId);
      return route === undefined ? undefined : (await chain(route, scope)).target;
    },
    /** The saved chain for a task that has one; undefined for a task admitted without a route. */
    async replay(input: {
      readonly scope: RouterScope;
      readonly taskId: string;
      readonly signal: AbortSignal;
      readonly isCurrent: () => boolean | Promise<boolean>;
    }): Promise<TaskRoute | undefined> {
      const prior = await options.repository.route(input.scope, input.taskId);
      if (prior === undefined) return undefined;
      if (!(await input.isCurrent()) || input.signal.aborted)
        throw new TaviError("UNAVAILABLE", "Task model route lost execution authority");
      return chain(prior, input.scope);
    },
  };
}

/** Only an explicit compatible fast binding may replace the ordinary configured target. */
export async function createTaskRouting(options: TaskRoutingOptions): Promise<TaskRoutingPort> {
  const saved = createSavedRoutes(options);
  const { usable } = saved;
  /**
   * What a person may choose: usable, and listed by the connection's catalog —
   * unless nothing was discovered on it yet — so a mistyped model is refused
   * when picked rather than failing every later turn at the provider.
   */
  const offered = async (target: ModelTarget, scope: RouterScope): Promise<boolean> => {
    if (!(await usable(target, scope))) return false;
    const catalog = await options.models.listCatalog(target.connectionId);
    return catalog.length === 0 || catalog.some((entry) => entry.modelId === target.model);
  };
  const currentBaseline = async (scope: RouterScope): Promise<readonly ModelTarget[]> =>
    (await options.liveBaseline?.(scope)) ?? [options.baseline, ...options.fallback];
  return {
    effectiveTarget: saved.effectiveTarget,
    // A local default keeps only its local fallbacks; the workflow's own chain is used when nothing changes.
    baseline: async (scope) => {
      const live = await options.liveBaseline?.(scope);
      const chain = live ?? [options.baseline, ...options.fallback];
      const kept = await keepLocalChain(chain, options.locality);
      return kept.length === chain.length ? live : kept;
    },
    accepts: (scope, target) => offered(target, scope),
    async choose(scope, taskId, target) {
      if (!(await offered(target, scope)))
        throw new TaviError(
          "NOT_CONFIGURED",
          `No configured connection offers ${target.connectionId}/${target.model}; add or test the connection in Settings → Models, then choose it again`,
        );
      return options.repository.chooseRoute(scope, taskId, target, options.now());
    },
    async prepare(input) {
      const prior = await saved.replay({
        scope: input.scope,
        taskId: input.fence.taskId,
        signal: input.signal,
        isCurrent: input.isCurrent,
      });
      if (prior !== undefined) return prior;
      if (!input.interactive) return undefined;
      const configured = distinct(await currentBaseline(input.scope));
      const local = configured[0] !== undefined && (await options.locality?.(configured[0].connectionId)) === "local";
      // A chat that ran on a local model, saved before chats on one kept their chain, never moves onto a remote default.
      if (!input.newTask && !local && (await options.chatIsLocal?.(input.scope, input.fence.taskId)) === true)
        throw new TaviError("NOT_CONFIGURED", LOCAL_CHAIN_UNAVAILABLE);
      if (!input.newTask && !local) return undefined;
      const config = await options.router.configuration(input.scope);
      const at = options.now();
      const allowed = await keepLocalChain(configured, options.locality);
      const usableBaseline = async () => {
        const [first, ...rest] = await saved.filterUsable(allowed, input.scope);
        if (first === undefined)
          throw new TaviError(
            "NOT_CONFIGURED",
            allowed.length < configured.length ? LOCAL_CHAIN_UNAVAILABLE : "No configured baseline model target is available",
          );
        return { target: first, fallback: rest };
      };
      // A chat that starts on a local model keeps its local chain from its first turn, whatever the router's state:
      // a default changed later to a remote model never takes its history there.
      if (local) {
        const kept = await usableBaseline();
        if (!(await input.isCurrent()) || input.signal.aborted)
          throw new TaviError("UNAVAILABLE", "Task model route became stale before execution");
        const route = await options.repository.saveRoute(input.scope, input.fence, {
          taskId: input.fence.taskId,
          target: kept.target,
          fallback: kept.fallback,
          origin: input.explicit ? "explicit" : "baseline",
          configRevision: config.revision,
          createdAt: at,
        });
        return saved.chain(route, input.scope);
      }
      // The router's effective configuration is off unless a provider is running.
      // While it is off, a new task saves no route, just as if routing were never configured.
      if (!config.settings.enabled) return undefined;
      const baseline = await usableBaseline();
      let target = baseline.target;
      let fallback = baseline.fallback;
      let origin: TaskRoute["origin"] = input.explicit ? "explicit" : "baseline";
      let decisionId: string | undefined;
      const binding = (await options.models.listRoleBindings(input.scope.workspaceId)).find((entry) => entry.role === "fast");
      // A chat on a local connection never sends its prompt to the router, nor moves to a remote `fast`.
      if (
        !input.explicit &&
        !local &&
        config.settings.enabled &&
        config.settings.modes.model !== "off" &&
        binding !== undefined &&
        key(binding.target) !== key(target)
      ) {
        const chain = distinct([binding.target, ...binding.fallback]);
        const revision = async () =>
          JSON.stringify({
            binding: (await options.models.listRoleBindings(input.scope.workspaceId)).find((entry) => entry.role === "fast"),
            targets: await Promise.all(
              [target, ...chain].map(async (entry) => ({
                entry,
                connection: await options.models.getConnection(entry.connectionId),
                catalog: await options.models.listCatalog(entry.connectionId),
                price: await options.price(entry, at),
              })),
            ),
          });
        const before = await revision();
        const current = async () => (await input.isCurrent()) && !input.signal.aborted && (await revision()) === before;
        const compatible = (
          await Promise.all(
            chain.map(async (entry) => {
              const catalog = (await options.models.listCatalog(entry.connectionId)).find((item) => item.modelId === entry.model);
              return (
                (await usable(entry, input.scope)) &&
                catalog?.state === "capable" &&
                ["tools", "streaming"].every((capability) => catalog.capabilities.includes(capability)) &&
                catalog.contextWindow !== undefined &&
                catalog.maxTokens !== undefined &&
                input.requestBytes + catalog.maxTokens <= catalog.contextWindow
              );
            }),
          )
        ).every(Boolean);
        const mainPrice = await options.price(target, at);
        const fastPrice = await options.price(binding.target, at);
        const dimensions = ["input", "output", "cacheRead", "cacheWrite"] as const;
        const cheaper =
          mainPrice !== undefined &&
          fastPrice !== undefined &&
          dimensions.every((dimension) => fastPrice[dimension] <= mainPrice[dimension]) &&
          dimensions.some((dimension) => fastPrice[dimension] < mainPrice[dimension]) &&
          (fastPrice.reasoning ?? fastPrice.output) <= (mainPrice.reasoning ?? mainPrice.output);
        const credentials = async (): Promise<boolean> => {
          try {
            return (
              await Promise.all(
                chain.map(async (entry) => {
                  const connection = await options.connection(entry.connectionId);
                  return connection !== undefined && Boolean(await options.readSecret(connection.credentialRef));
                }),
              )
            ).every(Boolean);
          } catch (error) {
            if (error instanceof TaviError && ["UNAVAILABLE", "NOT_CONFIGURED", "NOT_FOUND", "INVALID_INPUT"].includes(error.code))
              return false;
            throw error;
          }
        };
        if ((await current()) && compatible) {
          const receipt = await options.router.decide({
            scope: input.scope,
            fence: input.fence,
            operationId: `model-${input.turnId}`.slice(0, 128),
            turnId: input.turnId,
            feature: "model",
            permissionRevision: sha256Hex(before),
            prompt: input.prompt,
            candidates: [
              { id: "main", revision: "1", description: "Default model for difficult, uncertain or complex work" },
              { id: "fast", revision: "1", description: "Cheaper model for straightforward, well specified work" },
            ],
            signal: input.signal,
            isCurrent: current,
            beforeDecision: credentials,
          });
          decisionId = receipt.decisionId;
          if (
            receipt.mode === "active" &&
            receipt.selectedIds[0] === "fast" &&
            cheaper &&
            (await current()) &&
            (await options.router.configuration(input.scope)).revision === config.revision
          ) {
            target = binding.target;
            fallback = chain.slice(1);
            origin = "router";
          }
        }
      }
      if (!(await input.isCurrent()) || input.signal.aborted)
        throw new TaviError("UNAVAILABLE", "Task model route became stale before execution");
      const route = await options.repository.saveRoute(input.scope, input.fence, {
        taskId: input.fence.taskId,
        target,
        fallback,
        origin,
        configRevision: config.revision,
        ...(decisionId === undefined ? {} : { decisionId }),
        createdAt: at,
      });
      return saved.chain(route, input.scope);
    },
  };
}
