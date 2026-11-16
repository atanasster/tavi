import {
  ModelConnectionSchema,
  ModelCatalogEntrySchema,
  ProviderBindingSchema,
  TaviError,
  type InvocationContext,
  type ModelPort,
  type LanguageModelProvider,
  type ModelConnection,
  type ModelCatalogEntry,
  type ResourceScope,
  type WebSearchProvider,
} from "@tavi/contracts";
import type { WebFetchProvider } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import {
  languageModelPort,
  observeFetch,
  providerRevision,
  type ProviderBindings,
  type ProviderFactoryRegistry,
  type ResolvedExternalPlugin,
  type ResolvedProvider,
} from "@tavi/runtime";

/** Composition owns these registries; application consumers only receive mediated calls. */
export interface ExternalProviderRegistries {
  search: { factories: ProviderFactoryRegistry<WebSearchProvider>; bindings: ProviderBindings<WebSearchProvider> };
  fetch: { factories: ProviderFactoryRegistry<WebFetchProvider>; bindings: ProviderBindings<WebFetchProvider> };
  model: { factories: ProviderFactoryRegistry<LanguageModelProvider>; bindings: ProviderBindings<ModelPort> };
}

export function externalProviderInstances(
  registries: ExternalProviderRegistries,
  options: {
    principalFor(workspaceId: string): string | undefined;
    /** Whether a principal acts in the workspace (its own, or a person allowed there). Without it, only the workspace's own principal does. */
    actsIn?(workspaceId: string, principalId: string): boolean;
    readSecret(reference: string): Promise<string | null>;
    publishModel?(connection: ModelConnection, catalog: readonly ModelCatalogEntry[]): Promise<void>;
    unpublishModel?(connectionId: string): Promise<void>;
    credentialRevision(reference: string, value: string | null): Promise<string>;
  },
) {
  const active = new Map<string, { kind: "search" | "fetch" | "model"; workspaceId: string; signal: AbortSignal }>();
  const published = new Map<string, Set<string>>();
  const unpublish = async (connectionIds: Iterable<string>) => {
    for (const connectionId of [...connectionIds]) await options.unpublishModel?.(connectionId);
  };
  const ids = (kind: "search" | "fetch" | "model", workspaceId: string) =>
    [...active].filter(([, item]) => item.kind === kind && item.workspaceId === workspaceId && !item.signal.aborted).map(([id]) => id);
  /**
   * An instance is the workspace's, bound to its principal; a person allowed
   * there uses it as theirs. It is resolved as the workspace's, then bound to
   * the person, so each dispatch check, and the ledger, names who called it.
   */
  const resolveFor = <Provider>(
    bindings: ProviderBindings<Provider>,
    context: Pick<InvocationContext, "workspaceId" | "principalId">,
    id: string,
  ): ResolvedProvider<Provider> => {
    const owner = options.principalFor(context.workspaceId);
    if (owner === undefined || owner === context.principalId || options.actsIn?.(context.workspaceId, context.principalId) !== true)
      return bindings.resolve(context, id);
    const resolved = bindings.resolve({ workspaceId: context.workspaceId, principalId: owner }, id);
    const binding = Object.freeze(ProviderBindingSchema.parse({ ...resolved.binding, principalId: context.principalId }));
    return { ...resolved, binding, bindingHash: providerRevision(binding) };
  };
  return {
    ids,
    hasModel: (id: string, context: Pick<InvocationContext, "workspaceId" | "principalId">) => {
      try {
        resolveFor(registries.model.bindings, context, id);
        return true;
      } catch {
        return false;
      }
    },
    resolveModel: (id: string, context: InvocationContext) => resolveFor(registries.model.bindings, context, id),
    resolveFetch: (id: string, context: InvocationContext) => resolveFor(registries.fetch.bindings, context, id),
    resolveSearch: (id: string, context: InvocationContext) => resolveFor(registries.search.bindings, context, id),
    /** Removes the model connections a withdrawn plugin published. */
    async unpublish(pluginId: string): Promise<void> {
      const connectionIds = published.get(pluginId);
      published.delete(pluginId);
      if (connectionIds !== undefined) await unpublish(connectionIds);
    },
    async activate(plugin: Extract<ResolvedExternalPlugin, { ok: true }>, scope: ResourceScope): Promise<void> {
      const connectionIds = new Set<string>();
      published.set(plugin.record.pluginId, connectionIds);
      try {
        await activateInstances(plugin, scope, connectionIds);
      } catch (error) {
        // A failed instance withdraws every contribution of this module, including its published connections.
        if (published.get(plugin.record.pluginId) === connectionIds) published.delete(plugin.record.pluginId);
        await unpublish(connectionIds);
        throw error;
      }
    },
  };

  async function activateInstances(
    plugin: Extract<ResolvedExternalPlugin, { ok: true }>,
    scope: ResourceScope,
    connectionIds: Set<string>,
  ): Promise<void> {
    for (const config of plugin.instances) {
      const declaration = plugin.record.manifest.capabilities.find((item) => item.id === config.factory);
      const principalId = options.principalFor(config.workspaceId);
      if (declaration === undefined || principalId === undefined)
        throw new TaviError("NOT_CONFIGURED", "Provider instance needs a declared factory and configured workspace");
      const instanceId = `${plugin.record.pluginId}.${config.id}`;
      const credentials = new Map<string, string | null>();
      const credentialRevisions: Record<string, string> = {};
      scope.defer(() => credentials.clear());
      for (const reference of Object.values(config.credentials)) {
        scope.signal.throwIfAborted();
        const value = await options.readSecret(reference);
        scope.signal.throwIfAborted();
        credentials.set(reference, value);
        credentialRevisions[reference] = await options.credentialRevision(reference, value);
      }
      scope.signal.throwIfAborted();
      const binding = ProviderBindingSchema.parse({
        kind: declaration.kind,
        instanceId,
        workspaceId: config.workspaceId,
        principalId,
        accountId: config.accountId,
        endpoint: config.settings["endpoint"] ?? config.settings["baseUrl"] ?? (declaration.kind === "fetch" ? "in-process" : undefined),
        implementationHash: plugin.record.contentHash,
        configRevision: providerRevision({ config, credentialRevisions }),
      });
      const input = {
        instanceId,
        settings: structuredClone(config.settings),
        credentials: config.credentials,
        readSecret: async (reference: string) => credentials.get(reference) ?? null,
        owner: scope,
      };
      const factory = `${plugin.record.pluginId}.${config.factory}`;
      // Preserve the type association between each factory and its binding registry.
      switch (declaration.kind) {
        case "model": {
          const instance = await registries.model.factories.create(factory, input);
          validateProvider(instance.get(), "model");
          const provider = instance.get();
          const models = provider.listModels(instanceId);
          if (!Array.isArray(models) || models.length > 500 || models.some((model) => model.provider !== instanceId))
            throw new TaviError("NOT_CONFIGURED", "Invalid provider model catalog");
          const port = languageModelPort(provider);
          registries.model.bindings.register(
            binding,
            {
              ...instance,
              get: () => {
                instance.get();
                return port;
              },
            },
            scope,
          );
          if (options.publishModel !== undefined) {
            const now = nowTimestamp();
            const credentialRef = Object.values(config.credentials)[0] ?? "provider.anonymous";
            connectionIds.add(instanceId);
            await options.publishModel(
              ModelConnectionSchema.parse({
                connectionId: instanceId,
                label: instanceId,
                kind: "openai-compatible",
                baseUrl: binding.endpoint,
                credentialRef,
                localOnly: false,
                createdAt: now,
                updatedAt: now,
                providerBinding: { instanceId, workspaceId: config.workspaceId, principalId, bindingHash: providerRevision(binding) },
                ...(models[0] === undefined ? {} : { defaultModel: models[0].id }),
              }),
              models.map((model) =>
                ModelCatalogEntrySchema.parse({
                  connectionId: instanceId,
                  modelId: model.id,
                  displayName: model.name,
                  provenance: "catalog",
                  state: "available",
                  capabilities: [],
                  discoveredAt: now,
                  ...(model.context === undefined ? {} : { contextWindow: model.context.contextWindow }),
                  ...(model.defaultMaxTokens === undefined ? {} : { maxTokens: model.defaultMaxTokens }),
                }),
              ),
            );
            scope.signal.throwIfAborted();
          }
          break;
        }
        case "search": {
          const instance = await registries.search.factories.create(factory, input);
          validateProvider(instance.get(), "search");
          registries.search.bindings.register(binding, instance, scope);
          break;
        }
        case "fetch": {
          const instance = await registries.fetch.factories.create(factory, { ...input, observeFetch });
          validateProvider(instance.get(), "fetch");
          registries.fetch.bindings.register(binding, instance, scope);
          break;
        }
      }
      const entry = { kind: declaration.kind, workspaceId: config.workspaceId, signal: scope.signal };
      active.set(instanceId, entry);
      scope.defer(() => {
        if (active.get(instanceId) === entry) active.delete(instanceId);
      });
    }
  }
}

function validateProvider(value: unknown, kind: "search" | "fetch" | "model"): void {
  if (typeof value !== "object" || value === null) throw new TaviError("NOT_CONFIGURED", `Invalid ${kind} provider object`);
  if (kind === "model") {
    for (const method of ["listModels", "resolveModel", "prepareCall"])
      if (typeof Reflect.get(value, method) !== "function") throw new TaviError("NOT_CONFIGURED", `Model provider requires ${method}()`);
    return;
  }
  const method = kind;
  if (!(method in value) || typeof Reflect.get(value, method) !== "function")
    throw new TaviError("NOT_CONFIGURED", `Provider requires ${method}()`);
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !("available" in value) ||
    typeof value.available !== "function" ||
    typeof value.available() !== "boolean"
  ) {
    throw new TaviError("NOT_CONFIGURED", `Invalid ${kind} provider identity or availability`);
  }
}
