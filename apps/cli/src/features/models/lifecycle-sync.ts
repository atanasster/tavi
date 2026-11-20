import {
  LIFECYCLE_LEVELS,
  lifecycleWarnings,
  lifecycleWarningText,
  type LifecycleLevel,
  worstLifecycleLevel,
  type LifecycleWarning,
  type ModelCatalogEntry,
  type ModelConnection,
  type ModelLifecycle,
  type ModelLifecycleEntry,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { TaviRuntime } from "../../runtime/types.js";
import {
  LOCAL_RUNTIMES,
  lifecycleOfOffering,
  listOfferings,
  offeringKey,
  rhumbCall,
  rhumbKeyOf,
  rhumbModelId,
  rhumbProviderOf,
  rhumbUrlOf,
  type RhumbCall,
} from "./rhumb-client.js";
import { modelTargetsInUse, targetSourcesOf, type ModelTargetInUse, type ModelTargetsInUse, type ModelUse } from "./targets-in-use.js";

/**
 * The model lifecycle sync: what Rhumb says of each model a cloud connection
 * offers or tavi uses, kept per connection, and the warnings the models in use
 * give today. One `/v1/models` listing per sync, by provider names only: which
 * models a connection uses never leaves the machine. It never changes a model.
 */

/** How often `serve` syncs: Rhumb's catalog changes daily. */
export const LIFECYCLE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Rhumb's catalog version when a listing gave none: the field is required, and tavi still records when it looked. */
const CATALOG_VERSION_UNKNOWN = "unknown";

export interface LifecycleSyncSources {
  readonly connections: () => Promise<readonly ModelConnection[]>;
  readonly catalog: (connectionId: string) => Promise<readonly ModelCatalogEntry[]>;
  readonly inUse: () => Promise<ModelTargetsInUse>;
  readonly stored: () => Promise<readonly ModelLifecycleEntry[]>;
  readonly replace: (connectionId: string, entries: readonly ModelLifecycleEntry[]) => Promise<void>;
}

export interface LifecycleSyncedConnection {
  readonly connectionId: string;
  /** Rhumb's name for its provider; absent when it was skipped. */
  readonly provider?: string;
  /** Models whose lifecycle is now stored. */
  readonly models: number;
  /** Why it was not checked: a custom endpoint, or one on this computer. */
  readonly skipped?: string;
}

export interface LifecycleInUseWarning {
  readonly target: ModelTargetInUse;
  readonly warnings: readonly LifecycleWarning[];
}

export interface LifecycleSyncResult {
  readonly catalogVersion?: string;
  /** Whether Rhumb's listing was read to its end; when not, a model it did not list keeps what was stored. */
  readonly complete: boolean;
  readonly connections: readonly LifecycleSyncedConnection[];
  /** The models in use that warn today, worst first. */
  readonly warnings: readonly LifecycleInUseWarning[];
  /** Sources of models in use that could not be read. */
  readonly unread: readonly string[];
}

/** The sources from a runtime: its model configuration and every model it refers to. */
export function lifecycleSyncSourcesOf(
  runtime: Pick<TaviRuntime, "store" | "access" | "routines" | "routerRepository">,
): LifecycleSyncSources {
  const service = runtime.store.services.modelConfig;
  return {
    connections: async () => await service.listConnections(),
    catalog: async (connectionId) => await service.listCatalog(connectionId),
    inUse: () => modelTargetsInUse(targetSourcesOf(runtime)),
    stored: async () => await service.listModelLifecycle(),
    replace: async (connectionId, entries) => {
      await service.replaceModelLifecycle(connectionId, entries);
    },
  };
}

/** The connection's provider in Rhumb's names, or why it is not checked. */
function providerOf(connection: ModelConnection): { readonly provider: string } | { readonly skipped: string } {
  const provider = rhumbProviderOf(connection.baseUrl);
  if (provider === undefined) return { skipped: "a custom endpoint Rhumb does not know" };
  if (connection.localOnly || LOCAL_RUNTIMES.has(provider)) return { skipped: "runs on this computer, where nothing retires" };
  return { provider };
}

/**
 * Reads Rhumb once, stores each cloud connection's lifecycle rows, and says
 * which models in use warn on `now`'s date. A source of models in use that
 * fails is named; any other failure throws, and connections already written
 * keep their new rows. Once `signal` aborts, nothing more is written.
 */
export async function syncModelLifecycle(
  sources: LifecycleSyncSources,
  call: RhumbCall,
  now: Date,
  signal?: AbortSignal,
): Promise<LifecycleSyncResult> {
  const connections = await sources.connections();
  const inUse = await sources.inUse();
  const checked = connections.map((connection) => ({ connection, ...providerOf(connection) }));
  const providers = [...new Set(checked.flatMap((entry) => ("provider" in entry ? [entry.provider] : [])))].sort();
  if (providers.length === 0)
    return {
      complete: true,
      connections: checked.map(({ connection, ...rest }) => ({ connectionId: connection.connectionId, models: 0, ...rest })),
      warnings: [],
      unread: inUse.unread,
    };

  const listing = await listOfferings(call, providers, { includeRetired: true });
  const catalogVersion = listing.catalogVersion ?? CATALOG_VERSION_UNKNOWN;
  const checkedAt = now.toISOString();
  const stored = new Map((await sources.stored()).map((entry) => [`${entry.connectionId}\u0000${entry.modelId}`, entry.lifecycle]));
  const lifecycles = new Map<string, ModelLifecycle>();

  const results: LifecycleSyncedConnection[] = [];
  for (const entry of checked) {
    const { connectionId } = entry.connection;
    if (!("provider" in entry)) {
      results.push({ connectionId, models: 0, skipped: entry.skipped });
      continue;
    }
    const { provider } = entry;
    const models = new Set<string>([
      ...inUse.targets.filter((target) => target.connectionId === connectionId).map((target) => target.model),
      ...(await sources.catalog(connectionId)).map((row) => row.modelId),
    ]);
    const entries: ModelLifecycleEntry[] = [];
    for (const modelId of [...models].sort()) {
      const key = `${connectionId}\u0000${modelId}`;
      const offering = listing.offerings.get(offeringKey(provider, rhumbModelId(provider, modelId)));
      // Not on the pages read is not the same as not listed: keep what was known.
      const lifecycle =
        offering === undefined && !listing.complete ? stored.get(key) : lifecycleOfOffering(offering, catalogVersion, checkedAt);
      if (lifecycle === undefined) continue;
      lifecycles.set(key, lifecycle);
      entries.push({ connectionId, modelId, lifecycle });
    }
    signal?.throwIfAborted();
    await sources.replace(connectionId, entries);
    results.push({ connectionId, provider, models: entries.length });
  }

  return {
    ...(listing.catalogVersion === undefined ? {} : { catalogVersion: listing.catalogVersion }),
    complete: listing.complete,
    connections: results,
    warnings: inUseWarnings(inUse.targets, lifecycles, checkedAt.slice(0, 10)),
    unread: inUse.unread,
  };
}

/** The models in use whose lifecycle warns on `today`, worst first, then by connection and model. */
export function inUseWarnings(
  targets: readonly ModelTargetInUse[],
  lifecycles: ReadonlyMap<string, ModelLifecycle>,
  today: string,
): LifecycleInUseWarning[] {
  return targets
    .flatMap((target) => {
      const lifecycle = lifecycles.get(`${target.connectionId}\u0000${target.model}`);
      const warnings = lifecycle === undefined ? [] : lifecycleWarnings(lifecycle, today);
      return warnings.length === 0 ? [] : [{ target, warnings }];
    })
    .sort(
      (left, right) =>
        rank(left.warnings) - rank(right.warnings) ||
        left.target.connectionId.localeCompare(right.target.connectionId) ||
        left.target.model.localeCompare(right.target.model),
    );
}

function rank(warnings: readonly LifecycleWarning[]): number {
  const level = worstLifecycleLevel(warnings);
  return level === undefined ? LIFECYCLE_LEVELS.length : LIFECYCLE_LEVELS.indexOf(level);
}

/** Rhumb's deadline per page: a sync runs in the background, and five pages at most. */
const RHUMB_SYNC_TIMEOUT_MS = 15_000;

/** A sync's answer as `tavi models sync` prints it and the owner sends it: each warning in words. */
export interface LifecycleSyncReport {
  readonly catalogVersion?: string;
  readonly complete: boolean;
  readonly connections: readonly LifecycleSyncedConnection[];
  readonly warnings: readonly {
    readonly connectionId: string;
    readonly model: string;
    readonly level: LifecycleLevel;
    readonly usedBy: readonly ModelUse[];
    readonly says: readonly string[];
  }[];
  readonly unread: readonly string[];
}

/** No Rhumb key: nothing was asked and nothing changed. */
export interface LifecycleSyncNoKey {
  readonly skipped: "no-key";
  readonly hint: string;
}

export const RHUMB_KEY_HINT = "Set RHUMB_KEY to a Rhumb key (free at https://rhumbdata.com) to check which models retire.";

/** The report of a sync, in words. */
export function lifecycleSyncReport(result: LifecycleSyncResult): LifecycleSyncReport {
  return {
    ...(result.catalogVersion === undefined ? {} : { catalogVersion: result.catalogVersion }),
    complete: result.complete,
    connections: result.connections,
    warnings: result.warnings.map(({ target, warnings }) => ({
      connectionId: target.connectionId,
      model: target.model,
      level: worstLifecycleLevel(warnings) ?? "info",
      usedBy: target.usedBy,
      says: warnings.map(lifecycleWarningText),
    })),
    unread: result.unread,
  };
}

/** Syncs this runtime's models with Rhumb, or says no key is set. */
export async function syncRuntimeModelLifecycle(
  runtime: Pick<TaviRuntime, "store" | "access" | "routines" | "routerRepository">,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetchImpl?: typeof globalThis.fetch;
    readonly now?: () => Date;
    readonly signal?: AbortSignal;
  } = {},
): Promise<LifecycleSyncReport | LifecycleSyncNoKey> {
  const env = options.env ?? process.env;
  const key = rhumbKeyOf(env);
  if (key === undefined) return { skipped: "no-key", hint: RHUMB_KEY_HINT };
  const call = rhumbCall(key, rhumbUrlOf(env), options.fetchImpl ?? globalThis.fetch, RHUMB_SYNC_TIMEOUT_MS, {
    fresh: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const now = (options.now ?? (() => new Date()))();
  return lifecycleSyncReport(await syncModelLifecycle(lifecycleSyncSourcesOf(runtime), call, now, options.signal));
}

/** One line for the owner's log: the models in use that warn, or that none do. */
export function lifecycleSyncLogLine(report: LifecycleSyncReport): string {
  if (report.warnings.length === 0) return "model lifecycle: no model in use is retiring or redirected";
  const each = report.warnings.map((warning) => `${warning.connectionId}/${warning.model} ${warning.says.join("; ")}`);
  return `model lifecycle: ${each.join(" | ")} (tavi models sync for details)`;
}

/**
 * Syncs at start and every {@link LIFECYCLE_SYNC_INTERVAL_MS} until `signal`
 * aborts, on a timer that never keeps the process alive. A failed sync is
 * logged and the next one tries again; stored rows stand meanwhile.
 */
export function startLifecycleSync(
  logger: Pick<TaviRuntime["logger"], "info" | "warn">,
  /** One sync, e.g. {@link syncRuntimeModelLifecycle} on the owner's runtime, cancelled by the signal it is given. */
  sync: (signal: AbortSignal) => Promise<LifecycleSyncReport | LifecycleSyncNoKey>,
  signal: AbortSignal,
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly intervalMs?: number } = {},
): void {
  if (rhumbKeyOf(options.env ?? process.env) === undefined) return;
  let pending: Promise<void> | undefined;
  const tick = (): void => {
    if (pending !== undefined || signal.aborted) return;
    pending = sync(signal)
      .then((report) => {
        if (!("skipped" in report)) logger.info(lifecycleSyncLogLine(report));
      })
      .catch((error: unknown) => {
        if (!signal.aborted) logger.warn("model lifecycle sync failed", { error: errorMessage(error) });
      })
      .finally(() => {
        pending = undefined;
      });
  };
  tick();
  const handle = setInterval(tick, options.intervalMs ?? LIFECYCLE_SYNC_INTERVAL_MS);
  const unref = (handle as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(handle);
  signal.addEventListener("abort", () => clearInterval(handle), { once: true });
}
