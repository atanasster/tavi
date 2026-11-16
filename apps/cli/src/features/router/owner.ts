import {
  RouterPayloadSchema,
  TaviError,
  pluginRunningVersion,
  routerProviderSettings,
  type ModelPriceSheet,
  type RouterPayload,
  type RouterPort,
  type RouterRepositoryPort,
  type RouterSettings,
} from "@tavi/contracts";
import type { ModelAccounting, PluginLiveStatus, PluginRegistry, RouterProviderSlot } from "@tavi/runtime";

import { BUILTIN_ROUTER_PROVIDERS, builtinRouterProvider } from "../plugins/catalog.js";

/**
 * Whether the selected routing provider can answer here. `running` only in an
 * owner that has it bound; offline, the registry says `enabled` or `disabled`.
 */
export interface RouterProviderState {
  readonly state: "running" | "failed" | "enabled" | "disabled" | "not-installed";
  readonly error?: string;
}

export async function routerProviderState(
  registry: PluginRegistry,
  providerId: string,
  live?: PluginLiveStatus & { readonly providers: Pick<RouterProviderSlot, "get"> },
): Promise<RouterProviderState> {
  if (live?.providers.get(providerId) !== undefined) return { state: "running" };
  let enabled: boolean;
  try {
    enabled = (await registry.show(providerId)).enabled;
  } catch (error) {
    if (error instanceof TaviError && error.code === "NOT_FOUND") return { state: "not-installed" };
    throw error;
  }
  const phase = live?.status(providerId);
  if (phase?.phase === "failed") return { state: "failed", ...(phase.error === undefined ? {} : { error: phase.error }) };
  return { state: enabled ? "enabled" : "disabled" };
}

type RouterPricing = { readonly connectionId: string; readonly model: string };

/** The price sheet a provider is charged under: its running binding's, else its manifest's. */
export async function routerProviderPricing(
  registry: PluginRegistry,
  providerId: string,
  providers?: Pick<RouterProviderSlot, "get">,
): Promise<RouterPricing | undefined> {
  const builtin = builtinRouterProvider(providerId);
  if (builtin !== undefined) return builtin.pricing;
  const running = providers?.get(providerId)?.pricing;
  if (running !== undefined) return running;
  try {
    return pluginRunningVersion(await registry.show(providerId))?.router?.pricing;
  } catch (error) {
    if (error instanceof TaviError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

/** Whether the pinned price revision prices this provider; the guard abstains with `budget` otherwise. */
export function routerPriceReady(price: ModelPriceSheet | undefined, priceRevision: string | undefined, providerId: string): boolean {
  return price !== undefined && price.revision === priceRevision && (builtinRouterProvider(providerId)?.priceUsable(price) ?? true);
}

/** A running provider's own readiness report, for `status` in an owner. */
export function runningProviderReadiness(
  providers: Pick<RouterProviderSlot, "get">,
): NonNullable<RouterCommandDependencies["providerReadiness"]> {
  return async (providerId, settings) => providers.get(providerId)?.status?.(settings.providerSettings[providerId] ?? {});
}

/** Whether a plugin can be selected as the routing provider, and whether it is enabled. */
export type RouterProviderCandidate = { readonly ok: true; readonly enabled: boolean } | { readonly ok: false; readonly reason: string };

export async function routerProviderCandidate(registry: PluginRegistry, providerId: string): Promise<RouterProviderCandidate> {
  let enabled: boolean;
  try {
    enabled = (await registry.show(providerId)).enabled;
  } catch (error) {
    if (error instanceof TaviError && error.code === "NOT_FOUND") return { ok: false, reason: `${providerId} is not installed` };
    throw error;
  }
  if (builtinRouterProvider(providerId) !== undefined) return { ok: true, enabled };
  const view = await registry.show(providerId);
  if (!view.versions.some((version) => version.reviewState === "approved" && version.router !== undefined))
    return { ok: false, reason: `${providerId} has no approved version that declares a routing provider` };
  // Enabled as a router only when the version that runs declares one.
  return {
    ok: true,
    enabled: enabled && view.versions.some((version) => version.version === view.activeVersion && version.router !== undefined),
  };
}

export interface RouterCommandDependencies {
  readonly repository: RouterRepositoryPort;
  /** The owner's router: `disable` cancels pending work; its `configuration` is the effective one. */
  readonly service?: Pick<RouterPort, "disable"> & Partial<Pick<RouterPort, "configuration">>;
  readonly accounting: ModelAccounting;
  readonly readSecret: (reference: string) => Promise<string | null>;
  readonly now: () => string;
  /** The selected provider's state for `status`; unknown when absent. */
  readonly providerState?: (providerId: string) => Promise<RouterProviderState>;
  /** Whether `set-provider` may select a plugin; only built-in providers when absent. */
  readonly providerCandidate?: (providerId: string) => Promise<RouterProviderCandidate>;
  /** The price sheet identity of a provider that is not built in; unknown price readiness when absent. */
  readonly providerPricing?: (providerId: string) => Promise<RouterPricing | undefined>;
  /** A non-built-in provider's own readiness for `status`, when it is running here. */
  readonly providerReadiness?: (
    providerId: string,
    settings: RouterSettings,
  ) => Promise<Readonly<Record<string, string | boolean>> | undefined>;
}

/** Operator-only surface shared by authenticated IPC and the directory owner CLI. */
export async function routerCommand(deps: RouterCommandDependencies, raw: RouterPayload): Promise<unknown> {
  const input = RouterPayloadSchema.parse(raw);
  const scope = { workspaceId: input.workspaceId, principalId: input.principalId };
  const current = await deps.repository.configuration(scope);
  const priceReady = async (settings: RouterSettings): Promise<boolean | undefined> => {
    const pricing = builtinRouterProvider(settings.provider)?.pricing ?? (await deps.providerPricing?.(settings.provider));
    return pricing === undefined
      ? undefined
      : routerPriceReady(
          await deps.accounting.price(pricing.connectionId, pricing.model, deps.now()),
          settings.priceRevision,
          settings.provider,
        );
  };
  if (input.action === "configure" || input.action === "set-mode" || input.action === "set-provider") {
    // A configuration that names no provider keeps the current one.
    const configured =
      input.action === "configure" ? { ...input.settings, provider: input.settings.provider ?? current.settings.provider } : undefined;
    // A provider selected by set-provider, or changed by a whole configuration, is checked the same way.
    const selected =
      input.action === "set-provider"
        ? input.providerId
        : configured !== undefined && configured.provider !== current.settings.provider
          ? configured.provider
          : undefined;
    const candidate =
      selected === undefined
        ? undefined
        : ((await deps.providerCandidate?.(selected)) ??
          (builtinRouterProvider(selected) === undefined
            ? { ok: false, reason: `${selected} is not a built-in routing provider` }
            : { ok: true, enabled: true }));
    if (candidate?.ok === false) throw new TaviError("INVALID_INPUT", candidate.reason);
    // Each built-in provider's settings parsed by its own schema; any other provider's entry must be empty.
    const settings = routerProviderSettings(
      input.action === "set-mode"
        ? { ...current.settings, modes: { ...current.settings.modes, [input.feature]: input.mode } }
        : input.action === "set-provider"
          ? { ...current.settings, provider: input.providerId }
          : (configured ?? current.settings),
      BUILTIN_ROUTER_PROVIDERS,
    );
    const updated = await deps.repository.configureWithPrices(
      scope,
      settings,
      input.expectedRevision,
      input.action === "configure" ? input.priceSheets : [],
    );
    // Abort pending work on every policy revision; late answers cannot commit.
    deps.service?.disable();
    const warnings =
      selected === undefined
        ? []
        : [
            ...(candidate?.ok === true && !candidate.enabled
              ? [`${selected} is not enabled; routing stays off until it is enabled and the owner restarts.`]
              : []),
            ...((await priceReady(updated.settings)) === false
              ? [
                  `No price sheet for ${selected} matches priceRevision ${updated.settings.priceRevision ?? "(unset)"}; its decisions abstain until one is installed with configure.`,
                ]
              : []),
          ];
    return {
      configuration: updated,
      liveCredentialValidity: "not-tested",
      ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
    };
  }
  if (input.action === "explain") {
    const route = await deps.repository.route(scope, input.taskId); // authorizes task before reading accounting
    const receipts = await deps.repository.receipts(scope, input.taskId);
    const projections = await deps.repository.contextProjections(scope, input.taskId);
    // Totals are summed in the database and only the newest 20 attempts are
    // read, as summaries: a long chat's attempts each carry a whole request.
    const totals = await deps.accounting.costTotals(input.taskId);
    const attempts = await deps.accounting.summaries(input.taskId, { last: 20 });
    const result = {
      taskId: input.taskId,
      configuration: current,
      route: route ?? null,
      routeBehavior: route === undefined ? "default-or-baseline" : "saved-target-and-fallback-preserved",
      routerReservedOrSpentUsd: await deps.repository.spent(scope, input.taskId),
      cost: {
        complete: totals.priced === totals.attempts && totals.attempts > 0,
        knownEstimatedUsd: totals.usd,
        unknownAttempts: totals.attempts - totals.priced,
        attempts: totals.attempts,
      },
      receipts: await receipts.slice(-20),
      contextProjections: projections.slice(-5).map((projection) => ({
        ...projection,
        memoryExposed: projection.memoryExposed.slice(0, 32),
        recommendedSkills: projection.recommendedSkills.slice(0, 32),
        exposedSkills: projection.exposedSkills.slice(0, 32),
        totals: {
          memoryExposed: projection.memoryExposed.length,
          recommendedSkills: projection.recommendedSkills.length,
          exposedSkills: projection.exposedSkills.length,
        },
      })),
      attempts: [...attempts],
      truncated: { receipts: receipts.length > 20, contextProjections: projections.length > 5, attempts: totals.attempts > 20 },
      note: "No receipt can mean routing was off, excluded, or refused before dispatch. Skill exposure does not establish application.",
    };
    // Escaped IDs can be several bytes per character. Count the serialized
    // response and retain headroom for the IPC envelope, rather than only rows.
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024) {
      if (result.receipts.length > 0) await result.receipts.shift();
      else if (result.contextProjections.length > 0) result.contextProjections.shift();
      else if (result.attempts.length > 0) result.attempts.shift();
      else throw new TaviError("INVALID_INPUT", "Router explanation metadata exceeds its response bound");
    }
    result.truncated = {
      receipts: receipts.length > result.receipts.length,
      contextProjections: projections.length > result.contextProjections.length,
      attempts: totals.attempts > result.attempts.length,
    };
    return result;
  }
  const providerId = current.settings.provider;
  const provider = { id: providerId, ...((await deps.providerState?.(providerId)) ?? { state: "unknown" }) };
  // Readiness makes no provider request. A built-in provider's is known
  // offline too, at the top level; another provider reports its own only while
  // it runs here, nested so it cannot overwrite host fields.
  const builtin = builtinRouterProvider(providerId);
  const readiness =
    builtin !== undefined
      ? await builtin.readiness(current.settings.providerSettings[providerId] ?? {}, {
          readSecret: deps.readSecret,
          price: async (connectionId, model, at) => await deps.accounting.price(connectionId, model, at),
          priceRevision: current.settings.priceRevision,
          requestTokenCap: current.settings.requestTokenCap,
          now: deps.now(),
        })
      : {
          priceReady: (await priceReady(current.settings)) ?? "unknown",
          readiness: await Promise.resolve(deps.providerReadiness?.(providerId, current.settings)).then(
            (reported) => reported ?? "unknown",
            () => "unavailable",
          ),
        };
  return {
    configuration: current,
    provider,
    ...readiness,
    workspaceReservedOrSpentUsd: await deps.repository.spent(scope),
    // Routing runs only behind a running provider; offline it is never running.
    // The guard's view where it runs: features the provider does not declare are off too.
    effectiveModes:
      current.settings.enabled && provider.state === "running"
        ? ((await deps.service?.configuration?.(scope)) ?? current).settings.modes
        : { model: "off", memory: "off", tools: "off", skills: "off" },
    activation: "operator-controlled; evaluation required before rollout",
  };
}
