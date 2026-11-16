import { AsyncWork, PluginHost, type ShutdownReport } from "@tavi/runtime";
import { forgetMemoryTaught, countMemoryTaught } from "../features/tasks/history-owner.js";
import { SHIPPED_TOOL_RULES, flagAllowRules, type PluginView } from "@tavi/contracts";
import { createVerifyGate } from "../features/onboard/owner.js";
import { errorMessage } from "@tavi/contracts/util";
import { forgetHeartbeatHistory } from "../features/heartbeat/owner.js";
import { reminderReplyTarget } from "../features/reminders/delivery.js";
import { folderReadScope } from "../features/folders/fs-tools.js";
import { videoAnalyzerFacts, videoDoctorFacts, videoFfmpeg } from "../features/video/host.js";
import { pruneMemoryVectors } from "../features/memory/vectors.js";
import { BUILD_ID } from "../build-id.js";
import { countCheckpoints, reconcileCheckpointReceipts, RECONCILIATION_TASK_LIMIT } from "./checkpoints.js";
import { messagingProfileRules } from "./messaging-rules.js";
import type { TaviRuntime } from "./types.js";
import type { ExternalPluginsContext } from "./external-plugins.js";

export class StartupCleanupIncomplete extends Error {
  constructor(cause: unknown) {
    super("Runtime startup failed and cleanup could not confirm all work stopped; ownership retained", { cause });
  }
}

/** Checkpoint reconciliation, the plugin host's start and close, and the runtime it returns. */
export async function composeLifecycle(composed: ExternalPluginsContext): Promise<TaviRuntime> {
  const {
    releaseBuiltinChannels,
    FRESH_CONTEXT_MARK,
    abortRegistry,
    access,
    admissions,
    browser,
    browserBoundary,
    browserHandoffs,
    cancelOpenPurges,
    channelApprovals,
    channelName,
    channelPurging,
    channels,
    chatFolders,
    chatGptSignIns,
    chatGrants,
    chatNotices,
    clock,
    configureRoutineBindings,
    duePlanner,
    connectWaits,
    currentCredentialRevision,
    devViews,
    disabledBuiltins,
    embeddings,
    externalInstances,
    externalPlugins,
    folderSpace,
    fsToolOptions,
    heartbeatOptions,
    heartbeatProviderStates,
    heartbeatProviders,
    heartbeatSignals,
    heartbeatToolChoices,
    ideasCensusOf,
    ideasContinueChatOf,
    ideasHost,
    ideasProviders,
    ingress,
    keptChatGpt,
    late,
    limits,
    liveHub,
    localMessaging,
    localChatModels,
    forgetLocality,
    logger,
    materializeArtifact,
    mcpHost,
    memory,
    memoryChannelCards,
    memoryJobsSlot,
    memoryProviderSync,
    memoryProviderUpkeep,
    memoryProviders,
    memoryRecallTimes,
    memorySettings,
    messaging,
    modelAccounting,
    modelSecret,
    oauthBroker,
    oauthCallbacks,
    oauthFlows,
    onboardingProviders,
    onboardingSignIns,
    onboardingTurns,
    options,
    overrides,
    ownerSession,
    ownership,
    pairings,
    persistencePort,
    pluginRegistry,
    plugins,
    providerLifetime,
    refreshBuiltinSearch,
    refreshPeople,
    registerSearch,
    reloadChannelsRef,
    rememberOpenAccounts,
    reminderTargets,
    roomInvitations,
    router,
    routerProviders,
    routerRepository,
    routineControl,
    routineDelivery,
    routineEvaluation,
    routineNews,
    routinePublication,
    routineRuns,
    routineWork,
    routineWorkflow,
    routines,
    runEventBus,
    sandbox,
    sandboxHost,
    scheduleDependencies,
    scheduleFireInFlight,
    fireScheduleManually,
    precheckFile,
    precheckSite,
    scheduleFolder,
    scheduleWatchers,
    scheduleFires,
    secretSource,
    secrets,
    stopDevWatches,
    store,
    taskRouting,
    tools,
    turnHooks,
    vectorWorkspaces,
    verifiedPlugins,
    videoAnalyzers,
    videoDecoderOf,
    videoOptions,
    wakeRoutines,
    workflow,
  } = composed;
  // Reconcile before admissions open: a checkpoint the application never observed
  // is recorded now, and a receipt with no checkpoint behind it is reported
  // rather than trusted.
  const reconciliationTasks = await store.listTasks(RECONCILIATION_TASK_LIMIT);
  const reconciliation = await reconcileCheckpointReceipts({
    tasks: reconciliationTasks.map((task) => ({ taskId: task.taskId, threadId: task.threadId })),
    receipts: persistencePort.repositories.receipts,
    latestCheckpoint: async (threadId) => {
      const descriptor = await workflow?.checkpoints.latest(threadId);
      return descriptor === undefined
        ? undefined
        : {
            checkpointId: descriptor.checkpointId,
            checkpointNamespace: descriptor.checkpointNamespace,
          };
    },
    now: () => clock.now(),
    canReadCheckpoints: workflow !== undefined,
  });
  if (
    reconciliation.observed.length > 0 ||
    reconciliation.dangling.length > 0 ||
    reconciliationTasks.length === RECONCILIATION_TASK_LIMIT
  ) {
    logger.warn("checkpoint receipts reconciled", {
      observed: reconciliation.observed.length,
      dangling: reconciliation.dangling.length,
      // A full page means older tasks were not examined; report it rather than
      // implying the whole history was checked.
      examinedTaskLimit: RECONCILIATION_TASK_LIMIT,
      possiblyTruncated: reconciliationTasks.length === RECONCILIATION_TASK_LIMIT,
    });
  }

  const host = new PluginHost(plugins, {
    buildId: options.buildId ?? BUILD_ID,
    ...(options.shutdownDeadlineMs === undefined ? {} : { shutdownDeadlineMs: options.shutdownDeadlineMs }),
  });
  let startup: Promise<void> = Promise.resolve();
  let closing: Promise<ShutdownReport> | undefined;
  let persistenceFailure: Error | undefined;
  const close = (): Promise<ShutdownReport> => {
    if (closing !== undefined) return closing;
    admissions.close();
    providerLifetime.abort(new Error("Runtime is shutting down"));
    for (const stop of stopDevWatches) stop();
    memoryProviderUpkeep.stop();
    memoryProviderSync.close();
    connectWaits.close();
    void late.pdfService?.close();
    // Best effort: the helper may already be gone; nothing waits on it.
    void late.desktopBridge?.dispose().catch(() => undefined);
    void late.videoDecoder?.then(
      (decoder) => decoder.close(),
      () => undefined,
    );
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    void videoAnalyzers.close().catch(() => undefined);
    routineWork.stop();
    routineRuns.stop();
    routineEvaluation.stop();
    routineDelivery.stop();
    closing = (async () => {
      // Shutdown waits for startup to settle, not to succeed: startup reports its own failure.
      await startup.catch(() => {});
      const drained = await admissions.idle(options.shutdownDeadlineMs ?? 10_000);
      if (!drained) {
        abortRegistry.abortAll(new Error("The runtime is shutting down"));
        await admissions.idle(1_000);
      }
      // A sandboxed run still going is cancelled and its cleanup waited for, so no placeholder outlives the owner.
      await sandbox.close?.();
      const routineDrain = new AsyncWork();
      // `idleWithin` below waits for it; `track` observes its rejection, so dropping the returned promise loses nothing.
      void routineDrain.track(Promise.all([routineWork.idle(), routineRuns.idle(), routineEvaluation.idle(), routineDelivery.idle()]));
      const routinesStopped = await routineDrain.idleWithin(options.shutdownDeadlineMs ?? 10_000);
      // A resend in flight finishes before the plugins and the store stop (each sync is bounded by its deadline).
      await memoryProviderUpkeep.running();
      const report = await host.stop();
      // A built-in channel whose plugin never started still held its descriptor from composition.
      releaseBuiltinChannels();
      await router.dispose();
      const failures = [...report.failures];
      if (!routinesStopped) failures.push({ pluginId: "tavi.routines", message: "Routine work did not stop; ownership retained" });
      if (admissions.active() !== 0)
        failures.push({ pluginId: "tavi.persistence", message: "Invocations did not stop; ownership retained" });
      if (persistenceFailure !== undefined) failures.push({ pluginId: "tavi.persistence", message: persistenceFailure.message });
      if (report.clean && failures.length === 0) {
        const released = await ownership?.release();
        if (released !== undefined && !released.released)
          failures.push({ pluginId: "tavi.persistence", message: released.error ?? "Ownership release failed" });
      }
      const result = { ...report, failures, clean: report.clean && failures.length === 0 };
      if (!result.clean) logger.error("Runtime disposal did not complete cleanly", { timedOut: result.timedOut, failures });
      return result;
    })();
    return closing;
  };
  const failed = (error: Error): void => {
    persistenceFailure ??= error;
    admissions.close();
    abortRegistry.abortAll(error);
    logger.error("Persistence worker failed; stopping runtime", { error });
    void close().catch((error) => logger.error("Runtime shutdown failed; ownership retained", { error }));
  };
  void store.failed.then(failed);
  if (ownership !== undefined) void ownership.failed.then(failed);
  startup = host.start();
  try {
    await startup;
    if (persistenceFailure !== undefined) throw persistenceFailure;
    // A `/new` the last owner stopped in the middle of — its epoch ended, what
    // its task waited on not yet withdrawn — is finished before any message is
    // admitted. Only the directory's owner does it.
    if (ownership !== undefined) await late.withdrawUnfinishedResets?.();
  } catch (error) {
    try {
      const report = await close();
      if (!report.clean) throw new StartupCleanupIncomplete(error);
    } catch (cleanupError) {
      if (cleanupError instanceof StartupCleanupIncomplete) throw cleanupError;
      throw new StartupCleanupIncomplete(cleanupError);
    }
    throw error;
  }

  const reloadChannels: TaviRuntime["reloadChannels"] = async (workspaceId) => {
    await channels.reload();
    await rememberOpenAccounts().catch((error: unknown) => logger.warn("connections' accounts could not be remembered", { error }));
    const purgeCancelled = await cancelOpenPurges(logger);
    await ingress.ensure();
    await configureRoutineBindings();
    return {
      failed: channels
        .list()
        .filter((view) => view.workspaceId === workspaceId && view.status.state === "failed")
        .map((view) => ({ connectionId: view.connectionId, detail: view.status.detail ?? "it could not be opened" })),
      purgeCancelled,
    };
  };
  reloadChannelsRef.current = reloadChannels;
  /** One refresh at a time, so an older one never lands after a newer one. */
  let providersRefresh: Promise<void> = Promise.resolve();
  const refreshProviders: TaviRuntime["refreshProviders"] = () => {
    // A key or a connection may have changed: a turn's verification reads its revision afresh,
    // and a chat's locality is judged again from what is configured now.
    onboardingTurns.invalidate();
    forgetLocality();
    // Ordering only: the previous refresh reported its own failure.
    const next = providersRefresh
      .catch(() => undefined)
      .then(async () => {
        // A provider that cannot be bound is logged and left out: the write that asked for this has already been made.
        await refreshBuiltinSearch((error, providerId) =>
          logger.warn("a search provider could not be activated; web_search does not ask it", { providerId, error: errorMessage(error) }),
        );
        await registerSearch();
        await configureRoutineBindings();
        // An evaluation left `setup-needed` stays pending: tried again now, not at the next sweep.
        wakeRoutines();
      });
    providersRefresh = next;
    return next;
  };
  return {
    dataDirectory: options.dataDirectory,
    sandboxHost,
    sandbox,
    limits,
    ...(options.sandboxLimits === undefined ? {} : { sandboxLimits: options.sandboxLimits }),
    ...(options.sandboxParentProxy === undefined ? {} : { sandboxParentProxy: options.sandboxParentProxy }),
    sandboxOptions: {
      ...(options.sandboxPinnedOff === true ? { pinnedOff: true } : {}),
      ...(options.sandboxNested === true ? { nested: true } : {}),
      ...(options.sandboxLocal?.pty === true ? { pty: true } : {}),
      ...(options.sandboxLocal?.localBind === true ? { localBind: true } : {}),
      ...(options.sandboxInspectTls === true ? { inspectTls: true } : {}),
      ...(options.sandboxCache === true ? { cache: true } : {}),
    },
    ...(options.pdf?.allowUnconfined === true ? { pdfAllowUnconfined: true } : {}),
    videoBinaries: {
      ...(options.video?.ffmpeg === undefined ? {} : { ffmpeg: options.video.ffmpeg }),
      ...(options.video?.ffprobe === undefined ? {} : { ffprobe: options.video.ffprobe }),
    },
    videoDoctor: async (sandbox) => {
      const found = videoFfmpeg(videoOptions);
      return {
        ...videoDoctorFacts(
          "missing" in found && overrides.videoDecoderOverride === undefined ? found : (await videoDecoderOf()).facts(),
          videoOptions,
          sandbox,
        ),
        analyzers: videoAnalyzerFacts(videoAnalyzers, options.dataDirectory),
      };
    },
    store,
    routines,
    routineControl,
    routineEvaluation,
    routineRuns,
    routineNews,
    routinePublication,
    routineDelivery,
    routineWorkflow,
    tools,
    memory,
    memoryProviders,
    memoryProviderSync,
    ...(overrides.memoryOverride === undefined ? {} : { memoryOverridden: true as const }),
    ...(options.taintPolicy === undefined ? {} : { taintPolicy: options.taintPolicy }),
    memoryChannelCards,
    memorySettings,
    reminderConversationAllowed: async (owner, connectionId, conversationId) =>
      (await reminderReplyTarget(reminderTargets, owner, connectionId, conversationId)) !== undefined,
    chatNotices,
    requestFreshContext: async (taskId) => {
      await persistencePort.repositories.transcripts.claimMemoryMark({ taskId, ...FRESH_CONTEXT_MARK, at: clock.now() });
    },
    withdrawHandoffs: async (taskId, by) => (browserHandoffs === undefined ? 0 : await browserHandoffs.withdraw(taskId, by)),
    connectWaits,
    access,
    clock,
    every: duePlanner.every,
    ownerSession,
    materializeArtifact,
    chatFolders,
    folderSpace,
    folderReads: folderReadScope(fsToolOptions),
    systemPromptExplicit: options.systemPrompt !== undefined,
    contextBudgetTokens: async (workspaceId) => (await memorySettings(workspaceId)).limits.contextTokens,
    logger,
    host,
    workflow,
    channelApprovals,
    forgetSenderNotes: async (principalId, taskIds) => {
      let forgotten = 0;
      for (const taskId of taskIds) {
        const task = await persistencePort.repositories.tasks.get(taskId);
        // Only their own chats: a room's task is its person's, and theirs to forget.
        if (task === undefined || task.principalId !== principalId) continue;
        const taught = await forgetMemoryTaught(
          memory,
          { principalId, workspaceId: task.workspaceId, caller: "retention", authority: "operator" },
          taskId,
          clock.now(),
          true,
        );
        forgotten += taught.proposals + taught.memories;
      }
      return forgotten;
    },
    countChatNotes: async (taskIds) => {
      let notes = 0;
      for (const taskId of taskIds) {
        const task = await persistencePort.repositories.tasks.get(taskId);
        if (task !== undefined)
          notes += await countMemoryTaught(
            memory,
            { principalId: task.principalId, workspaceId: task.workspaceId, caller: "retention", authority: "operator" },
            taskId,
          );
      }
      return notes;
    },
    channelPurging,
    toolRulesInForce: async (workspaceId) => [
      ...SHIPPED_TOOL_RULES,
      // What a group or another person's chat is held to; a flag's tools say where they are lifted.
      ...messagingProfileRules([], options.messagingAllowTools ?? []),
      ...flagAllowRules(options.approvalExemptTools ?? []),
      ...(await persistencePort.repositories.toolPolicy.listRules(workspaceId)),
    ],
    runEventBus,
    liveHub,
    browser,
    browserBoundary,
    abortRegistry,
    admissions,
    scheduleFires,
    readSecret: (credentialRef) => secrets.getSecret(credentialRef),
    modelCredential: modelSecret,
    builtinEnabled: (pluginId) => !disabledBuiltins.has(pluginId),
    externalSearchIds: (workspaceId) => externalInstances.ids("search", workspaceId),
    scheduleDependencies,
    scheduleFireInFlight,
    fireScheduleManually,
    precheckFile,
    precheckSite,
    scheduleFolder,
    scheduleWatchersChanged: () => scheduleWatchers.sync(),
    messaging,
    channels,
    applyIngress: () => ingress.ensure(),
    pairings,
    roomInvitations,
    oauthFlows,
    oauthCallbacks,
    oauthBroker,
    resolveSecret: (reference: string) => secrets.getSecret(reference),
    mcp: mcpHost,
    reloadChannels,
    refreshPeople: () => refreshPeople(),
    refreshProviders,
    channelName,
    localMessaging,
    chatGrants,
    secretSource,
    router,
    routerProviders,
    heartbeat: {
      providers: heartbeatProviders,
      signals: heartbeatSignals,
      providerStates: heartbeatProviderStates,
      toolChoices: heartbeatToolChoices,
      options: heartbeatOptions,
      host: () => late.heartbeatHost,
      forget: async (workspaceId, principalId) =>
        await forgetHeartbeatHistory(
          { ...persistencePort.repositories, providerStates: heartbeatProviderStates },
          { workspaceId, principalId, now: new Date(clock.now()) },
        ),
    },
    ideas: {
      providers: ideasProviders,
      host: ideasHost,
      census: ideasCensusOf,
      continueChat: ideasContinueChatOf,
      digestReachable: async (workspaceId, principalId, connectionId) =>
        (await reminderTargets.operatorTargets(workspaceId, principalId)).some((target) => target.connectionId === connectionId),
    },
    onboarding: {
      providers: onboardingProviders,
      credentialRevision: currentCredentialRevision,
      turns: onboardingTurns,
      verifyGate: createVerifyGate(),
      signIns: onboardingSignIns,
      chatGptSignIns,
      keptChatGpt,
    },
    routerRepository,
    taskRouting,
    localChats: localChatModels,
    modelAccounting,
    embeddings,
    memoryRecallTimes,
    memoryJobs: memoryJobsSlot.jobs,
    pruneMemoryVectors: async () =>
      await pruneMemoryVectors({
        memory: persistencePort.repositories.memory,
        embeddings,
        workspaces: vectorWorkspaces,
        memorySettings,
        log: (message, fields) => logger.info(message, fields),
      }),
    checkpointCount: async () => await countCheckpoints(store),
    turnHooks,
    plugins: {
      registry: pluginRegistry,
      status: (pluginId: string) => {
        const latency = turnHooks.latencyOf(pluginId);
        return { ...phaseOf(pluginId), ...(latency.length === 0 ? {} : { hookLatency: latency }) };
      },
      dev: () => [...devViews.values()],
    },
    close,
  };
  /** A plugin's phase in this owner, and why it failed when it did. */
  function phaseOf(pluginId: string): { readonly phase: NonNullable<PluginView["phase"]>; readonly error?: string } {
    const failure = externalPlugins.failures.get(pluginId);
    if (failure !== undefined) return { phase: "failed", error: failure };
    if (externalPlugins.withdrawn.has(pluginId)) return { phase: "stopped" };
    if (turnHooks.suspended(pluginId))
      return { phase: "degraded", error: "its hooks failed too often and are suspended until the owner restarts" };
    if (verifiedPlugins.has(pluginId)) return { phase: "verified" };
    const composed = host.status().find((status) => status.id === pluginId);
    return composed === undefined
      ? { phase: "not_composed" }
      : { phase: composed.phase, ...(composed.error === undefined ? {} : { error: String(composed.error) }) };
  }
}
