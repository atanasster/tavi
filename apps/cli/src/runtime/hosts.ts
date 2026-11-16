import {
  TaviError,
  type ChatFolder,
  mcpSlugOf,
  hostTimeZone,
  type HeartbeatOptions,
  type HeartbeatToolChoice,
  heartbeatOptionsFor,
  HEARTBEAT_PRODUCTION_OPTIONS,
  mcpServerAllowed,
  pluginRunningVersion,
} from "@tavi/contracts";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { flightToolsSilentIn } from "../features/flights/host.js";
import { HeartbeatProviderRegistry, HeartbeatProviderStates, HeartbeatSignalRegistry } from "@tavi/agent-host/heartbeat-host";
import { IdeasHost, IdeasProviderRegistry } from "@tavi/agent-host/ideas-host";
import { OnboardingProviderRegistry } from "@tavi/agent-host/onboarding-host";
import {
  accountCensusTools,
  ideasCensus,
  ideasContinueChat,
  ideasMemoryContext,
  ideasModelTurn,
  ideasPrepareRun,
  ideasRecentTasks,
  ideasTaskExcerpt,
} from "../features/ideas/sources.js";
import { ideasDigestSender } from "../features/ideas/slash.js";
import { registerHeartbeatTools } from "../features/heartbeat/tools.js";
import { EARLIER_CHAT_KINDS } from "../features/tasks/notices.js";
import { recordCancellation } from "../features/tasks/mutations.js";
import { withoutLocalOrigin } from "../features/models/local-chats.js";
import type { FoldersContext } from "./folders.js";

/** The heartbeat, ideas and onboarding provider registries, the ideas host and the heartbeat tools. */
export function composeHosts(composed: FoldersContext) {
  const {
    access,
    chatFolders,
    chatsAreLocal,
    clock,
    localChatModels,
    taskRouting,
    folderSpace,
    late,
    logger,
    mcpHost,
    memory,
    memorySettings,
    messaging,
    modelAccounting,
    modelAdapter,
    modelConnectionLocality,
    overrides,
    persistencePort,
    pluginRegistry,
    resolvedPlugins,
    store,
    tools,
  } = composed;
  // The heartbeat: its providers are installed by their plugins; its host
  // runs in `serve` only, as the `tavi.heartbeat` plugin, and is what Check now and the IPC reach.
  const heartbeatProviders = new HeartbeatProviderRegistry(() => new Date(clock.now()));
  const heartbeatSignals = new HeartbeatSignalRegistry();
  // Ideas: the built-in provider installs below as a plugin, any approved one through the loader.
  const ideasProviders = new IdeasProviderRegistry();
  // Onboarding: the built-in flow installs as a plugin, any approved one through the loader.
  const onboardingProviders = new OnboardingProviderRegistry();
  // Read per workspace as each census is taken: MCP servers and mailbox tools are registered for every workspace and
  // answer only where they are allowed or connected, so what is enabled now, and allowed here, is what counts.
  const ideasCensusOf = async (workspaceId: string) => {
    const settings = (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings;
    const presets = new Map<string, string>();
    for (const plugin of await pluginRegistry.list()) {
      const slug = mcpSlugOf(plugin.id);
      const preset = pluginRunningVersion(plugin)?.mcp?.preset;
      if (plugin.enabled && slug !== undefined && preset !== undefined && mcpServerAllowed(settings, plugin.id)) presets.set(slug, preset);
    }
    const connections = (await persistencePort.repositories.messagingConnections.list(workspaceId)).filter(
      (connection) => connection.enabled,
    );
    // Memory paused recalls nothing (memory invariant 13): no idea is offered on what it would remember.
    const recalls = (await memorySettings(workspaceId)).enabled;
    const census = ideasCensus(
      tools.list().map((tool) => ({ id: tool.id, ...(tool.proves === undefined ? {} : { proves: tool.proves }) })),
      {
        silentTools: flightToolsSilentIn(settings),
        presets,
        // A mailbox or a calendar is proven by a signed-in account's tools only.
        ...accountCensusTools(connections),
        channels: [...new Set(connections.map((connection) => connection.providerId))].map(
          (providerId) => channelDescriptorOf(providerId)?.proves ?? [],
        ),
      },
    );
    return recalls ? census : census.filter((capability) => capability !== "memory");
  };
  // The empty chat's "Continue" chip: the person's newest own chat summarised in three days.
  const ideasContinueChatOf = async (workspaceId: string) => {
    const principalId = access.resolveWorkspace(workspaceId)?.principalId;
    return principalId === undefined
      ? undefined
      : ideasContinueChat(
          (await store.listTaskSessions({ workspaceId, principalId, chatKinds: [...EARLIER_CHAT_KINDS], limit: 10 })).rows,
          new Date(clock.now()),
        );
  };
  // Which provider's idea each prepared step runs: that plugin's hooks pass the step over.
  const preparedProviders = new Map<string, string>();
  // Ideas are written on the `fast` model: on a remote one they read no local chat, nor anything a local chat wrote.
  const ideasFastIsLocal = async (workspaceId: string): Promise<boolean> => {
    const fast = (await persistencePort.repositories.modelConfig.listRoleBindings(workspaceId)).find(
      (binding) => binding.role === "fast",
    )?.target;
    return fast !== undefined && (await modelConnectionLocality(fast.connectionId)) === "local";
  };
  const ideasHost = new IdeasHost({
    repositories: persistencePort.repositories,
    providers: ideasProviders,
    census: ideasCensusOf,
    memoryOn: async (workspaceId) => (await memorySettings(workspaceId)).enabled,
    memory: async (workspaceId) => {
      const principalId = access.resolveWorkspace(workspaceId)?.principalId;
      if (principalId === undefined) return [];
      return await ideasMemoryContext(
        (await ideasFastIsLocal(workspaceId)) ? memory : withoutLocalOrigin(memory),
        { workspaceId, principalId },
        new Date(clock.now()).toISOString(),
      );
    },
    // The person's own chats in this workspace, most recently touched first, as the earlier-chats notice reads them.
    tasks: async (workspaceId) => {
      const principalId = access.resolveWorkspace(workspaceId)?.principalId;
      if (principalId === undefined) return [];
      const listed = (await store.listTaskSessions({ workspaceId, principalId, chatKinds: [...EARLIER_CHAT_KINDS], limit: 40 })).rows;
      const fastLocal = await ideasFastIsLocal(workspaceId);
      // Unknown is local: a chat that cannot be judged is left out of what a remote model reads.
      const local = fastLocal
        ? undefined
        : await chatsAreLocal(
            workspaceId,
            listed.map((row) => row.taskId),
          );
      const rows = local === undefined ? listed : listed.filter((row) => local.get(row.taskId) === false);
      return await Promise.all(
        ideasRecentTasks(rows).map(async (task) => {
          if (task.summary === undefined) return task;
          const threadId = (await persistencePort.repositories.tasks.get(task.taskId))?.threadId;
          return ideasTaskExcerpt(task, threadId === undefined ? undefined : await late.workflow?.checkpoints.contextLabel?.(threadId));
        }),
      );
    },
    timezone: async (workspaceId) =>
      (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
    // The morning after setup is finished has ideas of its own: setup's completion is per install.
    freshSince: async () => (await persistencePort.repositories.onboarding.install()).completedAt,
    // A provider's turn: one tool-less call on the workspace's fast model, as its owner, recorded under the
    // ideas run. Its words are the person's memory and chats read again, so the ledger keeps its usage only.
    turn: ideasModelTurn({
      principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
      fastTarget: async (workspaceId) =>
        (await persistencePort.repositories.modelConfig.listRoleBindings(workspaceId)).find((binding) => binding.role === "fast")?.target,
      models: modelAdapter,
      newId: () => clock.newId("attempt"),
      now: () => new Date(clock.now()).toISOString(),
    }),
    // An idea's first step run ahead of time: unattended, under the `ideas` origin
    // (plumbing: no folder, no memory, never a chat), offered only the read-only tools its uses prove, once a day per idea.
    prepare: ideasPrepareRun({
      principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
      tools: () => tools.list(),
      workflow: () => late.workflow,
      cancel: async (taskId, reason) => {
        await recordCancellation(store, { taskId, reason, operator: "ideas" }, () => clock.now());
      },
      tokensOf: async (taskId) =>
        (await modelAccounting.summaries(taskId)).reduce(
          (total, attempt) => total + (attempt.usage.totalTokens ?? (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0)),
          0,
        ),
      providers: preparedProviders,
      now: () => new Date(clock.now()).toISOString(),
      // An idea written from local chats and records takes its first step on a local model.
      localModel: {
        target: localChatModels.ideaModel,
        choose: async (scope, taskId, target) => {
          if (taskRouting.choose === undefined) throw new TaviError("UNAVAILABLE", "no chat model can be kept");
          return await taskRouting.choose(scope, taskId, target);
        },
      },
    }),
    // The weekly digest: only to the operator's own authorized chat on the chosen connection.
    sendDigest: ideasDigestSender({
      principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
      operatorTargets: async (workspaceId, principalId) => await late.reminderTargets.operatorTargets(workspaceId, principalId),
      messaging,
      log: (message, fields) => logger.warn(message, fields),
    }),
    workspaces: async () => access.workspaceIds(),
    now: () => new Date(clock.now()),
    newId: () => clock.newId("idea"),
    log: (message, fields) => logger.warn(message, fields),
  });
  const heartbeatProviderStates = new HeartbeatProviderStates();
  /**
   * A loaded plugin's registered read-only tools (`<plugin>.<name>`), and an MCP server's approved read-only ones
   * from the bridge: what `extraTools` may name. Read when asked,
   * after the plugins load and the servers register; a mutating MCP tool is never a choice.
   */
  const heartbeatToolChoices = (): readonly HeartbeatToolChoice[] => {
    const plugins = resolvedPlugins.flatMap((plugin) => (plugin.ok ? [plugin.record.pluginId] : []));
    return [
      ...tools.list().filter((tool) => tool.effect === "read-only" && plugins.some((pluginId) => tool.id.startsWith(`${pluginId}.`))),
      ...mcpHost.bridge.readOnlyTools(),
    ].map((tool) => ({ id: tool.id, description: tool.description.slice(0, 300) }));
  };
  const heartbeatOptions: HeartbeatOptions = heartbeatOptionsFor(
    overrides.heartbeatTiming?.intervalFloorMs ?? HEARTBEAT_PRODUCTION_OPTIONS.floorMs,
  );
  // Configuring the heartbeat by chat: the operator's, and never a heartbeat turn's.
  registerHeartbeatTools(tools, {
    repositories: persistencePort.repositories,
    principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
    options: heartbeatOptions,
    now: () => new Date(clock.now()),
  });
  /**
   * A chat's scratch is emptied when its own turn ends:
   * never a worker's turn, whose folder is its root chat's and whose chat may
   * still be working. `.home/` is kept. Best effort.
   */
  const scratchAtTurnEnd = async (ended: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly folder?: ChatFolder | undefined;
  }): Promise<void> => {
    const folder = ended.folder;
    if (folder === undefined || folder.managed !== chatFolders.managedPath(ended.workspaceId, ended.taskId)) return;
    await folderSpace.emptyScratch(folder.managed);
  };
  return {
    heartbeatOptions,
    heartbeatProviderStates,
    heartbeatProviders,
    heartbeatSignals,
    heartbeatToolChoices,
    ideasCensusOf,
    ideasContinueChatOf,
    ideasHost,
    ideasProviders,
    onboardingProviders,
    preparedProviders,
    scratchAtTurnEnd,
  };
}

export type HostsContext = FoldersContext & ReturnType<typeof composeHosts>;
