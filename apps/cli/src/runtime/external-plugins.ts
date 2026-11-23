import { BUILTIN_CHANNELS } from "../features/plugins/catalog.js";
import { devPluginView, snapshotDevPlugin, watchDevPlugin, type DevPluginLoad } from "../features/plugins/dev.js";
import { loadExternalPlugins, type ExternalChannelHost } from "../features/plugins/external.js";
import { pluginLanguage } from "../features/plugins/localized.js";
import {
  mcpSlugOf,
  createServiceToken,
  DEFAULT_WORKSPACE_ID,
  TaviError,
  type PluginDefinition,
  maskPluginText,
  redactToolOutput,
  PLUGIN_NOTICE_MAX_CHARS,
  PLUGIN_STATE_MAX_CHARS,
  PLUGIN_STATUS_MAX_CHARS,
  pluginSignalSourceLabel,
} from "@tavi/contracts";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { errorMessage } from "@tavi/contracts/util";
import { PersistenceService, SearchFactoriesService, FetchFactoriesService, ModelFactoriesService } from "@tavi/runtime";
import { createOwnerPluginIsolation } from "../features/sandbox/host.js";
import type { BuiltinPluginsContext } from "./builtin-plugins.js";

/** The external and dev plugins, loaded and watched, and the full plugin list. */
export async function composeExternalPlugins(composed: BuiltinPluginsContext) {
  const {
    access,
    accountPersonal,
    builtinPluginIds,
    builtinPlugins,
    channelServices,
    clock,
    configureRoutineBindings,
    devPluginIds,
    devPlugins,
    devSnapshots,
    disabledBuiltins,
    externalInstances,
    fixtureModel,
    hasModelTransport,
    heartbeatProviders,
    heartbeatSignals,
    ideasProviders,
    installChannel,
    keptFindings,
    late,
    limits,
    liveModelTarget,
    logger,
    mcpHost,
    memoryProviders,
    onboardingProviders,
    options,
    overrides,
    ownership,
    persistencePort,
    store,
    peopleChanged,
    peopleKey,
    providerLifetime,
    registerSearch,
    reloadChannelsRef,
    requireModelTransport,
    resolvedPlugins,
    router,
    routerProviders,
    routineEvaluation,
    routinePublication,
    routineRuns,
    runEventBus,
    secrets,
    tools,
    turnHooks,
    workerPeople,
    routineTemplates,
  } = composed;
  // The plugin registry: built-ins the operator disabled are left out,
  // and approved, enabled external plugins are loaded after their snapshot is
  // re-verified. A plugin that fails to load is reported, never fatal.
  /**
   * A channel plugin's channels: its reviewed descriptor
   * joins the catalog and its connector the messaging service, and the saved
   * connections of it open; when the plugin stops both are withdrawn, and its
   * connections show its channel as missing until it is back.
   */
  const pluginChannels: ExternalChannelHost = {
    register: (descriptor, definition, plugin) => {
      const withdraw = installChannel(descriptor, definition, plugin);
      // Every workspace's connections of it reopen (or close), not only the first workspace's.
      const reopen = (): Promise<void> =>
        Promise.all(options.workspaces.map(async (grant) => await reloadChannelsRef.current?.(grant.workspaceId)))
          .then(() => undefined)
          .catch((error: unknown) =>
            logger.error("channels could not be reloaded for a channel plugin", { providerId: descriptor.providerId, error }),
          );
      // Reinstalled within a removal's grace: the reload, or the owner's start, cancels the purge of each connection that opens again.
      void reopen();
      return async () => {
        await withdraw();
        void reopen();
      };
    },
    // A built-in channel's provider id is its plugin's while that plugin is enabled, installed yet or not; free once disabled.
    taken: (providerId) =>
      channelDescriptorOf(providerId) !== undefined ||
      BUILTIN_CHANNELS.some((channel) => channel.descriptor.providerId === providerId && !disabledBuiltins.has(channel.pluginId)),
    // The builtins' services, for a plugin's channels (channel ABI 2): its own fetch override in tests, else the global one.
    services: channelServices,
  };
  // The workspace's language, which plugins read live as `ctx.locale`: followed after each settings write.
  const language =
    options.externalPlugins === "verify"
      ? undefined
      : await pluginLanguage(persistencePort.repositories.workspaceSettings, DEFAULT_WORKSPACE_ID, (listener) => store.onWrite(listener));
  if (language !== undefined) providerLifetime.signal.addEventListener("abort", () => language.close(), { once: true });
  const externalPlugins =
    options.externalPlugins === "verify"
      ? {
          definitions: [],
          withdrawn: new Set<string>(),
          withdraw: async () => undefined,
          reload: async () => undefined,
          failures: new Map(resolvedPlugins.flatMap((plugin) => (plugin.ok ? [] : [[plugin.pluginId, plugin.error] as const]))),
        }
      : await loadExternalPlugins(
          resolvedPlugins,
          tools,
          logger,
          (reference) => secrets.getSecret(reference),
          routerProviders,
          externalInstances.activate,
          providerLifetime.signal,
          pluginChannels,
          turnHooks,
          // On the task's own stream, after its last attempt; never a channel's.
          (pluginId, taskId, message) => {
            const attemptId = runEventBus.lastAttempt(taskId);
            if (attemptId === undefined) return;
            if (message.kind === "state") {
              // A value for the plugin's own frame: masked as a tool's output is, keeping its shape — and measured again, since a mask can be longer than what it hides.
              const value = redactToolOutput(message.value).value;
              if (JSON.stringify(value).length > PLUGIN_STATE_MAX_CHARS)
                throw new TaviError("INVALID_INPUT", `a published value, once masked, is over ${PLUGIN_STATE_MAX_CHARS} characters`);
              runEventBus.publish(taskId, { kind: "plugin.state", runId: taskId, attemptId, pluginId, stateKey: message.key, value });
              return;
            }
            runEventBus.publish(
              taskId,
              message.kind === "status"
                ? {
                    kind: "plugin.status",
                    runId: taskId,
                    attemptId,
                    pluginId,
                    ...(message.text === undefined ? {} : { line: maskPluginText(message.text, PLUGIN_STATUS_MAX_CHARS) }),
                  }
                : {
                    kind: "plugin.notice",
                    runId: taskId,
                    attemptId,
                    pluginId,
                    notice: maskPluginText(message.text, PLUGIN_NOTICE_MAX_CHARS),
                  },
            );
          },
          // Heartbeat providers and signal sources: what a provider receives is its approved manifest's.
          {
            installProvider: (record, provider, signal) => {
              const declared = record.manifest.heartbeat;
              if (declared === undefined) throw new TaviError("INVALID_INPUT", `${record.pluginId} declares no heartbeat provider`);
              return heartbeatProviders.install(record.pluginId, {
                provider,
                kind: "plugin",
                receives: declared.receives,
                usesTurns: declared.usesTurns,
                maxTickSeconds: declared.maxTickSeconds,
                signal,
                ...(devPluginIds.has(record.pluginId) ? { dev: true } : {}),
              });
            },
            installSource: (record, source) =>
              heartbeatSignals.install(
                `${record.pluginId}.${source.id}`,
                source,
                "plugin",
                record.manifest.heartbeatSignals === undefined
                  ? undefined
                  : pluginSignalSourceLabel(record.manifest.name, source.id, record.manifest.heartbeatSignals),
              ),
          },
          // Memory providers: composition's registry, under the plugin's id, with its declaration.
          {
            installProvider: (record, provider) => {
              const declared = record.manifest.memory;
              if (declared === undefined) throw new TaviError("INVALID_INPUT", `${record.pluginId} declares no memory provider`);
              return memoryProviders.install(record.pluginId, { provider, kind: "plugin", declaration: declared });
            },
          },
          overrides.pluginIsolationOverride ??
            createOwnerPluginIsolation({
              dataDirectory: options.dataDirectory,
              fsRoots: options.fsRoots ?? [],
              devPlugins: options.devPlugins ?? [],
              sandboxRead: options.sandboxRead ?? [],
              limits,
              ...(options.sandboxNested === true ? { nested: true } : {}),
            }),
          // The household rule, as the MCP bridge reads it.
          {
            personal: accountPersonal,
            operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
          },
          // A plugin tool's taviFindings, kept with the task.
          { add: (input) => keptFindings.add(input), now: () => clock.now() },
          // Ideas providers: what a provider receives is its approved manifest's, narrowed by each workspace's switches.
          {
            installProvider: (record, provider, signal) => {
              const declared = record.manifest.ideas;
              if (declared === undefined) throw new TaviError("INVALID_INPUT", `${record.pluginId} declares no ideas provider`);
              return ideasProviders.install(record.pluginId, {
                provider,
                kind: "plugin",
                receives: declared.receives,
                maxRunSeconds: declared.maxRunSeconds,
                usesTurns: declared.usesTurns,
                signal,
                ...(declared.disclosure === undefined ? {} : { disclosure: declared.disclosure }),
              });
            },
          },
          // Onboarding flows: withdrawn with their plugin, so the host falls back to the built-in.
          {
            installProvider: (record, provider, signal) => {
              const declared = record.manifest.onboarding;
              if (declared === undefined) throw new TaviError("INVALID_INPUT", `${record.pluginId} declares no onboarding flow`);
              return onboardingProviders.install(record.pluginId, {
                provider,
                kind: "plugin",
                signal,
                ...(declared.disclosure === undefined ? {} : { disclosure: declared.disclosure }),
                ...(declared.receives?.includes("status-detail") === true ? { receivesDetail: true } : {}),
              });
            },
          },
          // Routine templates: offered while their plugin runs.
          routineTemplates,
          language,
        );
  late.withdrawnPlugins = () => externalPlugins.withdrawn;
  // MCP servers' tools, after every other tool is in (the budget counts them), offline changes included.
  if (options.externalPlugins !== "verify") await mcpHost.start();
  late.withdrawExternal = async (id, version) => {
    // An MCP server runs no code in the owner: its tools go and its process stops.
    if (mcpSlugOf(id) !== undefined) {
      mcpHost.bridge.withdraw(id);
      await mcpHost.supervisor.stop(id);
      return undefined;
    }
    // A built-in withdrawn live (a mod's hooks): gone now, and back at the next start once enabled.
    const live = late.liveBuiltinWithdrawals.get(id);
    if (live !== undefined) {
      late.liveBuiltinWithdrawals.delete(id);
      live();
      return undefined;
    }
    const bound = routerProviders.bound(id);
    if (bound !== undefined && (version === undefined || bound.version === undefined || bound.version === version)) router.disable();
    const warning = await externalPlugins.withdraw(id, version);
    if (externalPlugins.withdrawn.has(id)) await externalInstances.unpublish(id);
    return warning;
  };
  // Each dev plugin reloads after a save; a folder that no longer checks out keeps its last good load running.
  const devViews = new Map(devPlugins.map(({ source, load }) => [load.record.pluginId, devPluginView(load, source)]));
  const stopDevWatches = devPlugins.map(({ source, load }) => {
    let current = load;
    let reloading = Promise.resolve();
    const reload = async (): Promise<void> => {
      const pluginId = current.record.pluginId;
      let next: DevPluginLoad;
      try {
        next = snapshotDevPlugin(source, devSnapshots, builtinPluginIds, () => clock.now());
      } catch (error) {
        logger.warn("dev plugin not reloaded: its folder does not check out", { pluginId, source, error: errorMessage(error) });
        return;
      }
      if (next.record.pluginId !== pluginId) {
        logger.warn("dev plugin not reloaded: its id changed; restart the owner to load it", {
          pluginId,
          source,
          now: next.record.pluginId,
        });
        return;
      }
      if (next.record.contentHash === current.record.contentHash) return;
      // Stopped by the operator (`tavi plugins disable`): a save does not bring it back.
      if (externalPlugins.withdrawn.has(pluginId)) {
        logger.warn("dev plugin not reloaded: it was stopped; restart the owner to load it again", { pluginId, source });
        return;
      }
      const problem = await externalPlugins.reload(next);
      devViews.set(pluginId, devPluginView(next, source));
      // Only once it loaded cleanly: a load that failed is tried again by saving the same content.
      if (problem === undefined) current = next;
      if (problem === undefined) logger.info("dev plugin reloaded", { pluginId, version: next.record.version });
      else logger.warn("dev plugin reloaded with a problem", { pluginId, error: problem });
    };
    return watchDevPlugin(
      source,
      () => {
        reloading = reloading
          .then(reload)
          .catch((error: unknown) => logger.error("dev plugin reload failed", { pluginId: current.record.pluginId, error }));
      },
      (error) =>
        logger.warn("dev plugin no longer watched; restart the owner to reload it", {
          pluginId: current.record.pluginId,
          source,
          error: error.message,
        }),
    );
  });
  const verifiedPlugins = new Set(
    options.externalPlugins === "verify" ? resolvedPlugins.flatMap((plugin) => (plugin.ok ? [plugin.record.pluginId] : [])) : [],
  );
  const providersReady = createServiceToken<boolean>("tavi.providers.ready");
  const plugins: readonly PluginDefinition[] = [
    ...builtinPlugins
      .filter((plugin) => !disabledBuiltins.has(plugin.id))
      .map((plugin) =>
        ["tavi.providers", "tavi.logger", "tavi.persistence"].includes(plugin.id)
          ? plugin
          : { ...plugin, requires: [...plugin.requires, providersReady] },
      ),
    ...externalPlugins.definitions.map((plugin) => ({ ...plugin, requires: [...plugin.requires, PersistenceService] })),
    {
      id: "tavi.providerreadiness",
      version: "0.0.0",
      provides: [providersReady],
      requires: [
        SearchFactoriesService,
        FetchFactoriesService,
        ModelFactoriesService,
        ...externalPlugins.definitions.flatMap((plugin) => plugin.provides),
      ],
      start: async () => {
        // An owner started with no model and a live target has none to be ready yet: the first is added over IPC.
        const awaitsFirstModel = options.modelTargetUnconfigured === true && liveModelTarget !== undefined;
        if (
          (requireModelTransport || hasModelTransport) &&
          !awaitsFirstModel &&
          !options.workspaces.some(
            (workspace) =>
              options.providers.length > 0 ||
              fixtureModel !== undefined ||
              externalInstances.hasModel(options.defaultConnectionId, workspace),
          )
        ) {
          throw new TaviError("UNAVAILABLE", "No model provider connection is ready after external factory activation");
        }
        await registerSearch();
        await configureRoutineBindings();
        peopleChanged.current = configureRoutineBindings;
        // A change in Allowed people while routines were first configured is taken now, not lost.
        if (options.workspaces.some((grant) => workerPeople.get(grant.workspaceId) !== peopleKey(grant.workspaceId)))
          await configureRoutineBindings();
        if (ownership !== undefined) await routineRuns.recoverPreviousOwner();
        await routinePublication.recoverStages();
        // Routines still on the first model-call default get today's, once; their revisions evaluate below. A failure
        // is reported and tried again at the next start: it never keeps the owner from starting.
        if (ownership !== undefined)
          await routineRuns.routines
            .raiseLegacyModelCalls()
            .catch((error: unknown) =>
              logger.warn("routines' model-call budget was not raised; trying again at the next start", { error: errorMessage(error) }),
            );
        if (ownership !== undefined) await routineEvaluation.recover();
        return { [providersReady.id]: true };
      },
    },
  ];
  return { devViews, externalPlugins, plugins, stopDevWatches, verifiedPlugins };
}

export type ExternalPluginsContext = BuiltinPluginsContext & Awaited<ReturnType<typeof composeExternalPlugins>>;
