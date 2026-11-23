import {
  createPublicFetchProvider,
  providerRevision,
  AccessPolicyService,
  ClockService,
  LoggerService,
  ModelService,
  PersistenceService,
  ToolRegistryService,
  SearchFactoriesService,
  FetchFactoriesService,
  ModelFactoriesService,
  WorkflowService,
} from "@tavi/runtime";
import {
  type MemoryPromptRow,
  DEFAULT_MEMORY_RETENTION_DAYS,
  MEMORY_PROMPT_KEEP_DAYS,
  hostTimeZone,
  seededReminderRule,
  seededProposalRules,
  seededTodoRule,
  seededWebSearchRule,
  PRIVATE_CHAT_KEEP_MS,
  SearchProviderConfigSchema,
  WEB_SEARCH_KINDS,
  type ResourceScope,
  JEV_PROVIDER_ID,
  TaviError,
  type DependencyBag,
  BUILTIN_HEARTBEAT_PROVIDER_ID,
  BUILTIN_IDEAS_PROVIDER_ID,
  conversationOfKey,
  BUILTIN_MEMORY_PROVIDER_ID,
  HEARTBEAT_LIMITS,
  type PluginDefinition,
  createServiceToken,
  type ServiceToken,
  BROWSER_CLOSE_REASON_RESTART,
  BROWSER_HISTORY_RETENTION_DAYS,
  GATE_OBSERVATION_RETENTION_MS,
  type WorkflowPort,
  LOCAL_PROVIDER_ID,
  localConnectionId,
} from "@tavi/contracts";
import { forgetChatHistory } from "../features/tasks/history-owner.js";
import { runDuePurges } from "../features/channels/purge.js";
import { workspaceLocaleOf } from "../features/channels/channel-words.js";
import { randomUUID } from "node:crypto";
import { startAgentWaitScheduler, type AgentWaitSchedulerHandle } from "@tavi/agent-host/agent-wait-scheduler";
import { repeatEvery, startScheduleScheduler, type ScheduleSchedulerHandle } from "@tavi/agent-host/schedule-scheduler";
import { startReminderScheduler } from "@tavi/agent-host/reminder-scheduler";
import { startHeartbeatHost } from "@tavi/agent-host/heartbeat-host";
import { createBuiltinHeartbeatProvider } from "@tavi/plugin-defaults/heartbeat";
import { createBuiltinIdeasProvider, ideaWordsIn } from "@tavi/plugin-defaults/ideas";
import { BUILTIN_ONBOARDING_PROVIDER_ID } from "@tavi/agent-host/onboarding-host";
import { createBuiltinOnboardingProvider } from "@tavi/plugin-defaults/onboarding";
import { ideasProviderViews } from "../features/ideas/owner.js";
import { IDEAS_COMMANDS, IDEAS_HOOKS, ideasDigestReplyHook, ideasSlashCommand } from "../features/ideas/slash.js";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { BUILTIN_MEMORY_DECLARATION, createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import { roomInvitationsSource } from "../features/channels/group-pairing.js";
import {
  builtinHeartbeatSources,
  heartbeatMemoryContext,
  managedChatFolders,
  storageSignalsSource,
  watchedPagesSource,
} from "../features/heartbeat/sources.js";
import { createHeartbeatDelivery } from "../features/heartbeat/delivery.js";
import { listNeeds } from "../features/approvals/inbox.js";
import { startHeartbeatEvents } from "../features/heartbeat/events.js";
import { HEARTBEAT_COMMANDS, heartbeatSlashCommand } from "../features/heartbeat/slash.js";
import { MEMORY_COMMANDS, MEMORY_PLUGIN_ID, memorySlashCommands } from "../features/memory/slash.js";
import { createMemoryDigest, startMemoryTick } from "../features/memory/digest.js";
import { createMemoryIdleReview } from "../features/memory/idle-review.js";
import { roleOrFast } from "../features/models/role-target.js";
import { createMemoryConsolidation } from "../features/memory/consolidation.js";
import { MemoryProvidersService, chatCaptureProviderOf } from "../features/memory/providers.js";
import { createHeartbeatTurnRunner } from "../features/heartbeat/turns.js";
import { chooseRoleTarget, connectionLocality, startTaskSummarizer } from "@tavi/agent-host/task-summarizer";
import { createReminderDelivery } from "../features/reminders/delivery.js";
import { GUARD_MODS, GUARD_PLUGIN_ID, guardCheck } from "@tavi/plugin-guard";
import {
  BUILTIN_CHANNELS,
  CHANNEL_HOST_PLUGIN_ID,
  BROWSER_ENGINE_PLUGIN_ID,
  PDF_ENGINE_PLUGIN_ID,
  VIDEO_ENGINE_PLUGIN_ID,
  DESKTOP_PLUGIN_ID,
} from "../features/plugins/catalog.js";
import { COLLECTORS_PLUGIN_ID } from "../features/collectors/host.js";
import { FLIGHTS_PLUGIN_ID } from "../features/flights/host.js";
import { SITE_SKILLS_PLUGIN_ID, addBuiltinSiteSkills } from "../features/browser/site-skills-host.js";
import { createJevProvider } from "@tavi/plugin-router";
import { dirname } from "node:path";
import { WEB_SEARCH_ENDPOINTS, createWebSearchAdapter } from "../features/search/web-search.js";
import { sweepVideoRetention } from "../features/video/retention.js";
import { createMemoryVectorBackfill, embeddingRefusal, memoryVectorsDoctor, workspacePrincipals } from "../features/memory/vectors.js";
import { memoryUnreachedNote } from "../features/memory/channel-cards.js";
import { freeBytesAt } from "../shared/disk.js";
import { DEFAULT_RETENTION_SWEEP_INTERVAL_MS, DEFAULT_TRANSPORT_RETENTION_DAYS } from "../features/maintenance/retention.js";
import { utilityTarget } from "../features/browser/models.js";
import { withoutLocalOrigin } from "../features/models/local-chats.js";
import { recordCancellation } from "../features/tasks/mutations.js";
import { writeGate } from "../shared/write-gate.js";
import { DUE_SWEEP_FALLBACK_MS, MEMORY_IDLE_TICK_MS, TASK_SUMMARY_FALLBACK_MS } from "./wakeups.js";
import { memoryReachOf } from "./chat-scope.js";
import type { ConversationsContext } from "./conversations.js";

/** How many private chats one retention sweep forgets at most; the next sweep takes the rest. */
const PRIVATE_CHATS_PER_SWEEP = 100;
/** How far back the start-up sweep looks for a worker whose result was never announced. */
const WORKER_RESULT_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How often `serve` deletes the chat grants past their end. */
const GRANT_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/** The ideas host: the daily run and `/ideas`; serve only. */
const BUILTIN_IDEAS_HOST_ID = "tavi.ideas";
/** The heartbeat host's plugin id: disabling it is the heartbeat's kill switch, and `/heartbeat` is its command. */
const BUILTIN_HEARTBEAT_HOST_ID = "tavi.heartbeat";

/** The built-in search activation and the built-in plugins the host composes. */
/** The built-in ideas' words in a language, for the owner outside this module (only it imports the plugin packages). */
export const builtinIdeaWords = ideaWordsIn;

export function composeBuiltinPlugins(composed: ConversationsContext) {
  const {
    hybridRef,
    siteSkills,
    access,
    admissions,
    browser,
    browserHandoffs,
    builtinSearchIds,
    builtinSearchRevisions,
    cancelOpenPurges,
    channelApprovals,
    channelPurging,
    channels,
    chatFolders,
    chatGrants,
    chatNotices,
    checkpointSaver,
    clock,
    duePlanner,
    embeddings,
    fetchInstances,
    fetchSettings,
    folderSpace,
    hasModelTransport,
    heartbeatFetchPage,
    heartbeatOptions,
    heartbeatProviderStates,
    heartbeatProviders,
    heartbeatReports,
    heartbeatSignals,
    heartbeatToolChoices,
    ideasCensusOf,
    ideasContinueChatOf,
    ideasHost,
    ideasProviders,
    ingress,
    isEmailConnection,
    keyAllowed,
    late,
    liveHub,
    liveModelReady,
    installBuiltinChannel,
    localInstances,
    logger,
    mcpHost,
    memory,
    memoryAutoApprove,
    memoryCards,
    memoryChannelCards,
    memoryCommandPlaces,
    memoryJobsSlot,
    memoryProviders,
    memorySettings,
    messaging,
    modelAccounting,
    modelAdapter,
    modelConnectionLocality,
    onboardingProviders,
    options,
    overrides,
    pendingAnnounces,
    persistencePort,
    providerRegistries,
    rememberOpenAccounts,
    reminderTargets,
    roomInvitations,
    routerProviders,
    routineDelivery,
    routines,
    routineEvaluation,
    routineRuns,
    routineWork,
    runEventBus,
    scheduleDependencies,
    scheduleWatchers,
    searchConfigurations,
    searchImplementationHash,
    secrets,
    startReminderTask,
    store,
    taintMode,
    taskRouting,
    tools,
    turnHooks,
    vectorWorkspaces,
    workflow,
  } = composed;
  /** The `tavi.providers` scope built-in search instances belong to, while it runs. */
  let builtinSearchScope: ResourceScope | undefined;
  /**
   * Binds each enabled built-in search provider with a key of its own that has
   * no instance for its current configuration yet: every one at start, and
   * after a `search` or `credentials` write only the ones added, enabled or
   * changed since — no restart. A provider
   * changed in place gets a new instance beside the old, whose calls `resolve`
   * already refuses as changed. `failed` decides what a provider that cannot
   * be bound does: stop the start, or be logged and left out.
   */
  const refreshBuiltinSearch = async (failed: (error: unknown, providerId: string) => void): Promise<void> => {
    const scope = builtinSearchScope;
    if (scope === undefined) return;
    const all = (await persistencePort.repositories.searchProviders.list()).providers;
    for (const workspace of options.workspaces) {
      const ids = builtinSearchIds.get(workspace.workspaceId) ?? new Map<string, string>();
      builtinSearchIds.set(workspace.workspaceId, ids);
      for (const config of all)
        if (config.enabled && (await keyAllowed(config, all))) {
          const revision = providerRevision({
            providerId: config.providerId,
            kind: config.kind,
            baseUrl: config.baseUrl,
            credentialRef: config.credentialRef,
            enabled: config.enabled,
          });
          const current = ids.get(config.providerId);
          if (current !== undefined && builtinSearchRevisions.get(current) === revision) {
            searchConfigurations.set(
              providerRegistries.search.bindings
                .resolve({ workspaceId: workspace.workspaceId, principalId: workspace.principalId }, current)
                .get(),
              config,
            );
            continue;
          }
          // The first instance keeps the id it always had; one made for a changed provider is told apart by its revision.
          const first = `builtin:search:${providerRevision(workspace.workspaceId)}:${config.providerId}`;
          const instanceId =
            !builtinSearchRevisions.has(first) || builtinSearchRevisions.get(first) === revision
              ? first
              : `${first}:${revision.slice(0, 16)}`;
          if (builtinSearchRevisions.get(instanceId) === revision) {
            searchConfigurations.set(
              providerRegistries.search.bindings
                .resolve({ workspaceId: workspace.workspaceId, principalId: workspace.principalId }, instanceId)
                .get(),
              config,
            );
            ids.set(config.providerId, instanceId);
            continue;
          }
          try {
            const endpoint = config.kind === "searxng" ? config.baseUrl : WEB_SEARCH_ENDPOINTS[config.kind];
            if (endpoint === undefined) throw new TaviError("NOT_CONFIGURED", "Search endpoint is missing");
            const instance = await providerRegistries.search.factories.create(`tavi.search.${config.kind}`, {
              instanceId,
              settings: config,
              credentials: config.credentialRef === undefined ? {} : { apiKey: config.credentialRef },
              readSecret: (reference) => secrets.getSecret(reference),
              owner: scope,
            });
            providerRegistries.search.bindings.register(
              {
                workspaceId: workspace.workspaceId,
                principalId: workspace.principalId,
                kind: "search",
                instanceId,
                accountId: config.credentialRef ?? config.providerId,
                endpoint,
                configRevision: revision,
                implementationHash: searchImplementationHash,
              },
              instance,
              scope,
            );
            searchConfigurations.set(instance.get(), config);
            builtinSearchRevisions.set(instanceId, revision);
            ids.set(config.providerId, instanceId);
          } catch (error) {
            failed(error, config.providerId);
          }
        }
    }
  };
  const activateBuiltinSearch = async (scope: ResourceScope) => {
    for (const kind of WEB_SEARCH_KINDS)
      providerRegistries.search.factories.register(
        `tavi.search.${kind}`,
        {
          settingsSchema: SearchProviderConfigSchema,
          create: ({ settings, credential }) =>
            createWebSearchAdapter(settings, {
              readSecret: () => credential("apiKey"),
              ...(overrides.searchFetch === undefined ? {} : { fetch: overrides.searchFetch }),
            }),
        },
        scope,
      );
    // The instances end with the scope: a start of their own begins from none.
    builtinSearchIds.clear();
    builtinSearchRevisions.clear();
    builtinSearchScope = scope;
    scope.defer(() => {
      if (builtinSearchScope === scope) builtinSearchScope = undefined;
    });
    // At start a provider that cannot be bound stops the owner, as it always did.
    await refreshBuiltinSearch((error) => {
      throw error;
    });
  };

  const builtinPlugins: readonly PluginDefinition[] = [
    {
      id: "tavi.providers",
      version: "0.0.0",
      requires: [PersistenceService],
      provides: [SearchFactoriesService, FetchFactoriesService, ModelFactoriesService],
      start: async ({ scope }) => {
        await activateBuiltinSearch(scope);
        late.builtinFetchScope = scope;
        scope.defer(() => {
          late.builtinFetchScope = undefined;
          fetchInstances.clear();
        });
        providerRegistries.fetch.factories.register(
          "tavi.fetch.http",
          {
            settingsSchema: fetchSettings,
            create: ({ settings }) =>
              createPublicFetchProvider({
                networkMode: settings.networkMode,
                allowedHosts: settings.allowedHosts,
                ...definedOnly({ maxBytes: settings.maxBytes, maxDecodedBytes: settings.maxDecodedBytes, timeoutMs: settings.timeoutMs }),
              }),
          },
          scope,
        );
        return {
          [SearchFactoriesService.id]: providerRegistries.search.factories,
          [FetchFactoriesService.id]: providerRegistries.fetch.factories,
          [ModelFactoriesService.id]: providerRegistries.model.factories,
        };
      },
    },
    // The Jev routing provider. The guard is host code and always composed;
    // this plugin only binds the provider it runs behind. Disabled, no provider
    // object exists and the guard's effective configuration turns routing off.
    {
      id: JEV_PROVIDER_ID,
      version: "0.0.0",
      provides: [],
      requires: [LoggerService],
      start: ({ scope }) => {
        const unbind = routerProviders.bind(
          JEV_PROVIDER_ID,
          createJevProvider({
            readSecret: (reference) => secrets.getSecret(reference),
            ...(overrides.routerFetch === undefined ? {} : { fetch: overrides.routerFetch }),
          }),
        );
        scope.defer(unbind);
        return {};
      },
    },
    // A retention sweep: a daily daemon accumulates
    // transport rows forever, and the path from there to "the disk is full and
    // the alert about it cannot be written" has no other gate on it.
    //
    // Opt-in, and only `serve` opts in: `tavi doctor` and `tavi prune` compose
    // this same runtime, and a read-only command must not delete rows as a side
    // effect of being run. It needs no model connection, so it sits outside the
    // `hasModelTransport` branch — a daemon without a model still accumulates
    // inbound messages.
    ...(options.retentionSweepEnabled === true
      ? ([
          {
            id: "tavi.retention",
            version: "0.0.0",
            provides: [],
            requires: [LoggerService, PersistenceService],
            start: ({ dependencies, scope }) => {
              const log = dependencies.get(LoggerService);
              // Browser sessions live in this process's memory, so any still
              // open in the history were left by the previous owner: closed
              // now. Only those opened before this
              // start, so a session a task opens meanwhile is never touched.
              const startedAt = clock.now();
              const closeLeftoverSessions = async (): Promise<void> => {
                const closed = await persistencePort.repositories.browserHistory.closeOpen({
                  openedBefore: startedAt,
                  closedAt: clock.now(),
                  reason: BROWSER_CLOSE_REASON_RESTART,
                });
                if (closed > 0) log.info("closed browser sessions left open by the previous owner", { closed });
              };
              let leftoversClosed = false;
              // Browser history is kept BROWSER_HISTORY_RETENTION_DAYS days
              // whatever `retentionSweepArtifacts` says: "kept 30 days" must not
              // mean forever on a deployment that never opted into the
              // artifact sweep.
              const sweepBrowserHistory = async (): Promise<void> => {
                if (!leftoversClosed) {
                  await closeLeftoverSessions();
                  leftoversClosed = true;
                }
                const olderThan = new Date(Date.parse(clock.now()) - BROWSER_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
                const swept = await persistencePort.repositories.browserHistory.sweep({ olderThan });
                if (swept.sessions + swept.thumbnails > 0) log.info("browser history retention sweep", { ...swept, olderThan });
              };
              // Memory retention:
              // unreviewed proposals expire, and lapsed ones are erased later.
              // `sweepExpired` is scoped to one principal, so it runs for each
              // workspace's operator and for every other person with personal
              // memory there — proposals are made in the name of whoever the
              // task ran for, including people who message the agent.
              // The records on unsettled card rows that no longer wait (decided, expired or gone), asked of
              // the port as the person each card was posted for; one the port cannot answer stays unsettled.
              const memoryPromptsToSettle = async (): Promise<readonly string[]> => {
                const rows = new Map<string, MemoryPromptRow>();
                for (const row of await persistencePort.repositories.transcripts.unsettledMemoryPrompts()) rows.set(row.recordId, row);
                const settle: string[] = [];
                for (const row of rows.values()) {
                  try {
                    const record = await memory.get({
                      actor: { principalId: row.principalId, workspaceId: row.workspaceId, caller: "retention", authority: "operator" },
                      recordId: row.recordId,
                    });
                    if (record.status !== "proposed") settle.push(row.recordId);
                  } catch (error) {
                    if (error instanceof TaviError && error.code === "NOT_FOUND") settle.push(row.recordId);
                    else log.warn("memory card row could not be checked", { recordId: row.recordId, error: String(error) });
                  }
                }
                return settle;
              };
              const sweepMemory = async (): Promise<void> => {
                for (const workspace of options.workspaces) {
                  const people = await memory.principals({
                    actor: {
                      principalId: workspace.principalId,
                      workspaceId: workspace.workspaceId,
                      caller: "retention",
                      authority: "operator",
                    },
                    // `approved` too: a preference or lesson past its own date is the sweep's to expire.
                    statuses: ["proposed", "approved", "rejected", "expired"],
                  });
                  const principals = [workspace.principalId, ...people.filter((principalId) => principalId !== workspace.principalId)];
                  for (const principalId of principals) {
                    // A proposal waits the workspace's `memory.limits.proposalDays`, read per sweep.
                    const proposalDays = (await memorySettings(workspace.workspaceId)).limits.proposalDays;
                    const swept = await memory.sweepExpired({
                      actor: { principalId, workspaceId: workspace.workspaceId, caller: "retention", authority: "operator" },
                      policy: { ...DEFAULT_MEMORY_RETENTION_DAYS, proposedOrRejected: proposalDays },
                    });
                    if (swept.length > 0) {
                      log.info("memory retention sweep", {
                        workspaceId: workspace.workspaceId,
                        expired: swept.filter((entry) => entry.outcome === "expired").length,
                        forgotten: swept.filter((entry) => entry.outcome === "forgotten").length,
                      });
                    }
                  }
                }
                // Memory cards' rows: settled when their record no longer waits, deleted a week after a card settled.
                const now = clock.now();
                // An override's records are not in Tavi's tables: the port says which ones no longer wait.
                const settle = overrides.memoryOverride === undefined ? undefined : await memoryPromptsToSettle();
                const cards = await persistencePort.repositories.transcripts.pruneMemoryPrompts({
                  now,
                  settledBefore: new Date(Date.parse(now) - MEMORY_PROMPT_KEEP_DAYS * 86_400_000).toISOString(),
                  ...(settle === undefined ? {} : { settle }),
                });
                if (cards.deleted > 0) log.info("memory card retention sweep", cards);
              };
              // A private chat's saved turns go 24 h after its last turn, by the chat-context forget path,
              // and with them the whole conversation: every checkpoint of its thread, not the newest few a
              // `forget` keeps to go on from, and the model requests kept for its turns (`forget` drops those).
              const sweepPrivateChats = async (): Promise<void> => {
                const now = clock.now();
                const idleBefore = new Date(Date.parse(now) - PRIVATE_CHAT_KEEP_MS).toISOString();
                let forgotten = 0;
                // One chat that cannot be forgotten is logged and passed over, so it does not hold back the rest.
                for (const taskId of await persistencePort.repositories.transcripts.privateChatsDue({
                  idleBefore,
                  limit: PRIVATE_CHATS_PER_SWEEP,
                })) {
                  try {
                    const { erased } = await forgetChatHistory(
                      {
                        repositories: persistencePort.repositories,
                        dropRetainedEvents: (taskId, before) => void runEventBus.dropRetained(taskId, before),
                        // Its fold archives go too, untagged older ones by what its summaries name.
                      },
                      taskId,
                      now,
                    );
                    // No turn of it is running (`privateChatsDue`), so nothing goes on from its checkpoints: all of them go.
                    const chat = await persistencePort.repositories.tasks.get(taskId);
                    if (chat !== undefined) await store.checkpoints.deleteThread(chat.threadId);
                    forgotten += erased.forgotten;
                  } catch (error) {
                    log.error("private chat could not be forgotten", { taskId, error });
                  }
                }
                if (forgotten > 0) log.info("private chat retention sweep", { forgotten });
              };
              const sweep = async (): Promise<void> => {
                try {
                  const cutoff = new Date(Date.parse(clock.now()) - DEFAULT_TRANSPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
                  const counts = await store.pruneTransport({ olderThan: cutoff, dryRun: false });
                  // Artifacts are opt-in per deployment (`retentionSweepArtifacts`),
                  // because an operator who has not thought about which artifacts
                  // matter should not have any deleted for them.
                  const artifacts =
                    options.retentionSweepArtifacts === true ? await store.pruneArtifacts({ olderThan: cutoff, dryRun: false }) : undefined;
                  const total = counts.inbox + counts.outbox + counts.mailbox + counts.waitIntents + (artifacts?.artifacts ?? 0);
                  if (total > 0) log.info("pruned finished transport rows", { ...counts, ...(artifacts ?? {}), olderThan: cutoff });
                } catch (error) {
                  // Never fatal: a failed prune must not take the daemon down, and
                  // the next one retries.
                  log.error("transport retention sweep failed", { error });
                }
                try {
                  await sweepBrowserHistory();
                } catch (error) {
                  // Never fatal, and apart from the others.
                  log.error("browser history retention sweep failed", { error });
                }
                // Videos taken from outside, past each workspace's `video.keepDays`,
                // whatever `retentionSweepArtifacts` says: "kept 30 days" must not mean forever.
                await sweepVideoRetention({
                  workspaceIds: access.workspaceIds(),
                  settingsOf: async (workspaceId) => (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings,
                  pruneVideo: (input) => store.pruneVideo(input),
                  now: () => clock.now(),
                  log,
                });
                try {
                  // Heartbeat history past its 30 days, every heartbeat's at once.
                  const olderThan = new Date(Date.parse(clock.now()) - HEARTBEAT_LIMITS.retentionDays * 24 * 60 * 60 * 1000).toISOString();
                  const swept = await persistencePort.repositories.heartbeats.sweep({ olderThan });
                  if (swept.ticks + swept.items + swept.signals + swept.tasks > 0)
                    log.info("heartbeat retention sweep", { ...swept, olderThan });
                } catch (error) {
                  // Never fatal, and apart from the others.
                  log.error("heartbeat retention sweep failed", { error });
                }
                try {
                  await sweepMemory();
                } catch (error) {
                  // Never fatal either, and apart from the transport prune: one
                  // failing must not stop the other.
                  log.error("memory retention sweep failed", { error });
                }
                try {
                  await sweepPrivateChats();
                } catch (error) {
                  // Never fatal, and apart from the others: the next sweep retries.
                  log.error("private chat retention sweep failed", { error });
                }
                try {
                  // Removed connections whose channel purges, once their 24 hours have passed.
                  await runDuePurges(channelPurging);
                } catch (error) {
                  log.error("channel purge sweep failed", { error });
                }
                try {
                  // Last, after the sweeps above freed what they free: the file's
                  // free pages go back to the operating system.
                  const reclaimed = await store.reclaimSpace();
                  if (reclaimed.action !== "none") log.info("reclaimed database space", reclaimed);
                } catch (error) {
                  // Never fatal: a busy file is reclaimed by the next sweep.
                  log.error("database space reclaim failed", { error });
                }
                try {
                  // Refresh the planner's statistics where the deletions moved them.
                  await store.optimize();
                } catch (error) {
                  log.error("database statistics refresh failed", { error });
                }
              };
              let pending: Promise<void> | undefined;
              const tick = (): void => {
                if (pending === undefined)
                  pending = sweep().finally(() => {
                    pending = undefined;
                  });
              };
              tick();
              const handle = setInterval(tick, options.retentionSweepIntervalMs ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS);
              const unref = (handle as { unref?: () => void }).unref;
              if (typeof unref === "function") unref.call(handle);
              scope.defer(async () => {
                clearInterval(handle);
                await pending;
              });
              return {};
            },
          },
        ] satisfies readonly PluginDefinition[])
      : []),
    {
      // A domain tool: `travel.flights_search` is composed with the owner's tools while this is enabled (`runtime/tools.ts`);
      // its entry here is what the host reports it as, running.
      id: FLIGHTS_PLUGIN_ID,
      version: "0.0.0",
      provides: [],
      requires: [],
      start: () => ({}),
    },
    // The engines: their tools are composed while each is enabled (`runtime/plugins.ts`, `runtime/tools.ts`); the
    // confinement ones are core, since every plugin runs under them. Entries here are what the host reports as running.
    ...[
      BROWSER_ENGINE_PLUGIN_ID,
      PDF_ENGINE_PLUGIN_ID,
      VIDEO_ENGINE_PLUGIN_ID,
      DESKTOP_PLUGIN_ID,
      "tavi.sandbox",
      "tavi.limits",
      "tavi.worker",
    ].map((id): PluginDefinition => ({ id, version: "0.0.0", provides: [], requires: [], start: () => ({}) })),
    {
      // The built-in site skills, in the registry the browser tools read while this runs.
      id: SITE_SKILLS_PLUGIN_ID,
      version: "0.0.0",
      provides: [],
      requires: [],
      start: ({ scope }) => {
        scope.defer(addBuiltinSiteSkills(siteSkills));
        return {};
      },
    },
    {
      // The daily brief's tools, composed with the owner's research tools while this is enabled (`runtime/research-tools.ts`).
      id: COLLECTORS_PLUGIN_ID,
      version: "0.0.0",
      provides: [],
      requires: [],
      start: () => ({}),
    },
    {
      // A first-party mod, off until enabled: its hook joins every turn while it runs, and leaves at once when it is
      // disabled, without a restart.
      id: GUARD_PLUGIN_ID,
      version: "0.0.0",
      provides: [],
      requires: [],
      start: ({ scope }) => {
        const withdraw = turnHooks.register(GUARD_PLUGIN_ID, GUARD_MODS.hooks, "tool.check", undefined, guardCheck);
        late.liveBuiltinWithdrawals.set(GUARD_PLUGIN_ID, withdraw);
        scope.defer(() => {
          late.liveBuiltinWithdrawals.delete(GUARD_PLUGIN_ID);
          withdraw();
        });
        return {};
      },
    },
    {
      id: "tavi.logger",
      version: "0.0.0",
      provides: [LoggerService],
      requires: [],
      start: () => ({ [LoggerService.id]: logger }),
    },
    {
      id: "tavi.persistence",
      version: "0.0.0",
      provides: [PersistenceService],
      requires: [LoggerService],
      start: ({ dependencies, scope }) => {
        const log = dependencies.get(LoggerService);
        scope.defer(async () => {
          // An announce scheduled after a worker's admission writes to the store,
          // and may resume or wake its parent: it finishes first.
          while (pendingAnnounces.size > 0) await Promise.allSettled([...pendingAnnounces]);
          // The shared browser is a child process that would keep an
          // in-process run alive after everything else closed; its history
          // writes go to the store, so it goes first — and before the live
          // hub, so a watcher still connected hears its sessions end.
          // MCP servers are child processes too: stopped before the store they record to closes.
          // Both stop even when work still running keeps the store below: a
          // retained database is the owner's to recover, a Chromium left
          // running is no one's (the live injection runs left one per owner).
          await mcpHost.shutdown().catch((error: unknown) => log.warn("mcp shutdown failed", { error: errorMessage(error) }));
          try {
            await browser.dispose?.();
          } catch (error) {
            log.warn("browser shutdown failed", { error: errorMessage(error) });
          }
          if (admissions.active() !== 0 || routineWork.active || routineRuns.active || routineEvaluation.active || routineDelivery.active)
            throw new Error("Invocations are still running; database and ownership retained");
          liveHub.close();
          log.info("closing sqlite store");
          await checkpointSaver.close();
          await store.close();
        });
        log.info("sqlite store opened", { databasePath: store.databasePath });
        return { [PersistenceService.id]: persistencePort };
      },
    },
    {
      id: "tavi.tools",
      version: "0.0.0",
      provides: [ToolRegistryService],
      requires: [LoggerService, PersistenceService],
      start: ({ dependencies }) => {
        dependencies.get(LoggerService).info("tool registry ready", { tools: tools.list().length });
        return { [ToolRegistryService.id]: tools };
      },
    },
    {
      id: "tavi.access",
      version: "0.0.0",
      provides: [AccessPolicyService],
      requires: [LoggerService],
      start: ({ dependencies }) => {
        dependencies.get(LoggerService).info("access policy loaded", {
          workspaces: options.workspaces.length,
        });
        return { [AccessPolicyService.id]: access };
      },
    },
    {
      id: "tavi.clock",
      version: "0.0.0",
      provides: [ClockService],
      requires: [],
      start: () => ({ [ClockService.id]: clock }),
    },
    {
      // The built-in memory provider: recall ranks with it and the idle
      // review and the epoch flush draft with it, through the host's registry. What every other provider falls back
      // to; disabled, recall is the host's own search and no proposal is drafted.
      id: BUILTIN_MEMORY_PROVIDER_ID,
      version: "0.0.0",
      provides: [MemoryProvidersService],
      requires: [],
      start: ({ scope }) => {
        scope.defer(
          memoryProviders.install(BUILTIN_MEMORY_PROVIDER_ID, {
            provider: createBuiltinMemoryProvider(),
            kind: "builtin",
            declaration: BUILTIN_MEMORY_DECLARATION,
          }),
        );
        return { [MemoryProvidersService.id]: memoryProviders };
      },
    },
    {
      // Seeds every configured workspace with the allow rules for the
      // reminder tools, the to-do tools, web_search and the two proposal tools
      // (memory.propose, skills.propose), once each: a rule the operator
      // revoked is never put back. Whether or not this runtime fires
      // reminders — the tools are offered either way. Owner-side only,
      // never from a page.
      id: "tavi.reminderrule",
      version: "0.0.0",
      provides: [],
      requires: [PersistenceService, LoggerService],
      start: async ({ dependencies }) => {
        const log = dependencies.get(LoggerService);
        for (const workspace of options.workspaces) {
          const now = clock.now();
          if (await persistencePort.repositories.toolPolicy.seedRule(seededReminderRule(workspace.workspaceId, now), now)) {
            log.info("seeded the reminder allow rule", { workspaceId: workspace.workspaceId });
          }
          if (await persistencePort.repositories.toolPolicy.seedRule(seededTodoRule(workspace.workspaceId, now), now)) {
            log.info("seeded the to-do allow rule", { workspaceId: workspace.workspaceId });
          }
          if (await persistencePort.repositories.toolPolicy.seedRule(seededWebSearchRule(workspace.workspaceId, now), now)) {
            log.info("seeded the web search allow rule", { workspaceId: workspace.workspaceId });
          }
          for (const rule of seededProposalRules(workspace.workspaceId, now)) {
            if (await persistencePort.repositories.toolPolicy.seedRule(rule, now)) {
              log.info("seeded a proposal allow rule", { workspaceId: workspace.workspaceId, ruleId: rule.ruleId });
            }
          }
        }
        return {};
      },
    },
    ...(options.reminderSweepEnabled === true && options.scheduleSweepEnabled !== false
      ? ([
          {
            // Fires reminders. Outside the
            // `hasModelTransport` branch: a text-only reminder makes no model
            // call, so an owner without a model connection still reminds, and
            // its buttons still work; only a reminder's task needs the workflow.
            id: "tavi.reminders",
            version: "0.0.0",
            provides: [],
            requires: [PersistenceService, LoggerService],
            start: ({ dependencies, scope }) => {
              const log = dependencies.get(LoggerService);
              const handle = startReminderScheduler({
                reminders: persistencePort.repositories.reminders,
                delivery: createReminderDelivery({
                  ...reminderTargets,
                  messaging,
                  isEmailConnection,
                  ...(workflow === undefined ? {} : { startTask: startReminderTask, modelReady: liveModelReady }),
                  postHome: (input) => chatNotices.postReminder(input),
                  postInChat: (input) => chatNotices.postReminderInChat(input),
                  now: () => clock.now(),
                  ownerAllowed: (workspaceId, principalId) => access.actsIn(workspaceId, principalId),
                  onDiagnostic: (message, fields) => log.warn(message, fields),
                  localeOf: workspaceLocaleOf(persistencePort.repositories.workspaceSettings),
                }),
                now: () => clock.now(),
                log: (event) => log[event.level](event.message, event.detail === undefined ? undefined : { detail: event.detail }),
                // The planner sweeps when a fire falls due; this timer is only the fallback.
                intervalMs: options.reminderSweepIntervalMs ?? DUE_SWEEP_FALLBACK_MS,
                ...(options.reminderSweepIntervalMs === undefined ? { every: duePlanner.every } : {}),
                onSwept: (result) => {
                  if (result.delivered.length > 0) log.info("reminder sweep delivered fires", { count: result.delivered.length });
                },
              });
              // Awaited on shutdown, so a delivery in flight records its outcome before the store closes.
              scope.defer(() => handle.stop());
              scope.defer(duePlanner.register("reminders", { sweep: handle.sweep }));
              return {};
            },
          },
        ] satisfies readonly PluginDefinition[])
      : []),
    ...(options.taskSummariesEnabled === true && hasModelTransport
      ? ([
          {
            // Generated task titles and summaries: its own loop, one call at a time, never on the
            // path that finishes a task. Calls go through the accounted model
            // port, so each is recorded against its task.
            id: "tavi.tasksummaries",
            version: "0.0.0",
            provides: [],
            requires: [PersistenceService, LoggerService],
            start: ({ dependencies, scope }) => {
              const log = dependencies.get(LoggerService);
              const handle = startTaskSummarizer({
                summaries: persistencePort.repositories.taskSummaries,
                settings: async (workspaceId) => (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings,
                models: modelAdapter,
                // The stored record first (it carries `localOnly`), then a connection from the startup configuration.
                locality: async (connectionId) => {
                  const stored = await persistencePort.repositories.modelConfig.getConnection(connectionId);
                  if (stored !== undefined) return connectionLocality(stored);
                  const configured = options.providers.find((provider) => provider.connectionId === connectionId);
                  return configured === undefined ? undefined : connectionLocality(configured);
                },
                // With no summary model of its own, the workspace's `fast` role writes it, as its explicit binding.
                fastTarget: async (workspaceId) =>
                  roleOrFast(await persistencePort.repositories.modelConfig.listRoleBindings(workspaceId), "fast"),
                now: () => clock.now(),
                newId: () => randomUUID(),
                log: (event) => log[event.level](event.message, event.detail === undefined ? undefined : { ...event.detail }),
                // Drained as each task ends (below); the timer picks up what that missed, such as a
                // summary deferred because no model could write it.
                intervalMs: options.taskSummaryIntervalMs ?? TASK_SUMMARY_FALLBACK_MS,
                ...(options.taskSummaryIntervalMs === undefined ? { every: duePlanner.every } : {}),
              });
              // Awaited on shutdown: the call in flight is aborted and its task stays queued.
              scope.defer(async () => {
                await handle.stop();
              });
              scope.defer(runEventBus.onCompleted(() => void handle.drain()));
              return {};
            },
          },
        ] satisfies readonly PluginDefinition[])
      : []),
    ...(hasModelTransport
      ? ([
          {
            id: "tavi.models",
            version: "0.0.0",
            provides: [ModelService],
            requires: [ClockService, LoggerService],
            start: ({ dependencies }: { dependencies: DependencyBag }) => {
              dependencies.get(LoggerService).info("model transport ready", {
                connections: options.providers.map((provider) => provider.connectionId),
              });
              return { [ModelService.id]: modelAdapter };
            },
          },
          {
            id: "tavi.workflow",
            version: "0.0.0",
            provides: [WorkflowService],
            requires: [ModelService, ToolRegistryService, LoggerService, PersistenceService],
            start: ({ dependencies }: { dependencies: DependencyBag }) => {
              dependencies.get(LoggerService).info("workflow graph compiled");
              return { [WorkflowService.id]: workflow };
            },
          },
          {
            // Periodically resumes any task suspended on `agents.wait` past
            // its deadline. Provides
            // no service of its own; it exists purely for the side effect,
            // stopped via `scope.defer` on shutdown like every other owned
            // resource. Safe under the single-data-directory-owner
            // invariant: only the process holding that lock ever reaches
            // here with a real `workflow`.
            id: "tavi.agentwaitscheduler",
            version: "0.0.0",
            provides: [],
            requires: [WorkflowService, PersistenceService, LoggerService],
            start: ({ dependencies, scope }) => {
              const log = dependencies.get(LoggerService);
              const handle: AgentWaitSchedulerHandle = startAgentWaitScheduler({
                // An expired question's message says so, and loses its buttons.
                onSettled: (waitId, outcome) => channelApprovals.onQuestionSettled({ waitId, outcome, via: "policy" }),
                waits: persistencePort.repositories.agentWaits,
                tasks: persistencePort.repositories.tasks,
                delegations: persistencePort.repositories.agentDelegations,
                // `workflow` is non-null in this branch: this plugin only
                // runs when `hasModelTransport` is true, the same condition
                // that makes `workflow` defined above.
                workflow: workflow as WorkflowPort,
                // The planner sweeps when a deadline falls due; this timer is only the fallback.
                intervalMs: options.agentWaitSweepIntervalMs ?? DUE_SWEEP_FALLBACK_MS,
                ...(options.agentWaitSweepIntervalMs === undefined ? { every: duePlanner.every } : {}),
                now: () => clock.now(),
                onError: (error) => log.error("agent wait sweep failed", { error }),
                onSwept: (result) => {
                  if (result.orphaned.length > 0) {
                    log.error("agent wait sweep found orphaned wait rows", { waitIds: result.orphaned });
                  }
                },
              });
              scope.defer(() => handle.stop());
              scope.defer(duePlanner.register("agentWaits", { sweep: handle.sweep }));
              // Workers that ended while no owner announced them — a restart
              // between an ending and its announce — report now, once.
              if (options.workerResultSweepEnabled === true && late.agentsService !== undefined) {
                const agents = late.agentsService;
                const since = new Date(Date.parse(clock.now()) - WORKER_RESULT_SWEEP_WINDOW_MS).toISOString();
                setImmediate(() => {
                  void agents
                    .announceUnreported({ since })
                    .then((announced) => {
                      if (announced > 0) log.info("announced workers' results a restart left unannounced", { announced, since });
                    })
                    .catch((error: unknown) => log.error("the unannounced worker results sweep failed", { error }));
                });
              }
              // `security.taint = off` is deprecated: said once at start.
              void (async () => {
                const off =
                  options.taintPolicy === "off"
                    ? ["*"]
                    : (
                        await Promise.all(
                          access.workspaceIds().map(async (workspaceId) => ((await taintMode(workspaceId)) === "off" ? [workspaceId] : [])),
                        )
                      ).flat();
                if (off.length > 0)
                  log.warn("security.taint is off: the gate's taint step neither asks nor records; off is deprecated", {
                    workspaces: off,
                    ...(options.taintPolicy === "off" ? { via: "serve --taint-policy" } : {}),
                  });
              })().catch((error: unknown) => log.error("the security.taint start check failed", { error }));
              // Chat grants past their end are deleted at start and hourly,
              // whether or not their chat is read again;
              // gate observations past their 30 days go with them.
              if (options.grantSweepEnabled === true) {
                let sweepingGrants = false;
                const sweepGrants = (): void => {
                  if (sweepingGrants) return;
                  sweepingGrants = true;
                  const grants = chatGrants
                    .sweepExpired()
                    .then((deleted) => {
                      if (deleted > 0) log.info("deleted chat grants past their end", { deleted });
                    })
                    .catch((error: unknown) => log.error("the chat grant expiry sweep failed", { error }));
                  const observations = persistencePort.repositories.toolPolicy
                    .deleteGateObservationsBefore(new Date(Date.parse(clock.now()) - GATE_OBSERVATION_RETENTION_MS).toISOString())
                    .then((deleted) => {
                      if (deleted > 0) log.info("deleted gate observations past their 30 days", { deleted });
                    })
                    .catch((error: unknown) => log.error("the gate observation retention sweep failed", { error }));
                  void Promise.all([grants, observations]).finally(() => {
                    sweepingGrants = false;
                  });
                };
                sweepGrants();
                const grantSweep = setInterval(sweepGrants, options.grantSweepIntervalMs ?? GRANT_SWEEP_INTERVAL_MS);
                grantSweep.unref();
                scope.defer(() => clearInterval(grantSweep));
              }
              // Handoffs end from the live view; those a restart orphaned are cancelled.
              if (browserHandoffs !== undefined) scope.defer(browserHandoffs.start());
              // Approval rounds announced to a chat expire the same way a wait
              // does: past the deadline, the round is decided as denied.
              // One sweep at a time: a sweep resumes each expired round's turn in
              // turn and can outlast the interval.
              let sweeping: Promise<void> | undefined;
              const sweepRounds = (): Promise<void> => {
                sweeping ??= channelApprovals
                  .sweepExpired()
                  .then(() => undefined)
                  .catch((error: unknown) => log.error("approval round expiry sweep failed", { error }))
                  .finally(() => {
                    sweeping = undefined;
                  });
                return sweeping;
              };
              // The planner sweeps when a round expires or a retry is owed; this timer is only the fallback.
              const roundEvery = options.agentWaitSweepIntervalMs === undefined ? duePlanner.every : repeatEvery;
              scope.defer(roundEvery(() => void sweepRounds(), options.agentWaitSweepIntervalMs ?? DUE_SWEEP_FALLBACK_MS));
              scope.defer(duePlanner.register("approvals", { sweep: sweepRounds }));
              return {};
            },
          },
          {
            // Fires operator-authored recurring schedules.
            // Inside the same `hasModelTransport` branch as the wait sweep,
            // because admitting a scheduled run needs the workflow; a
            // composition without a model connection has nothing to run.
            //
            // The scheduler answers a scheduled run's approval and
            // artifact-review suspensions by the schedule's own tool
            // allowlist, which is the whole reason a 07:00 run can
            // reach `messaging.send_to` with nobody present.
            id: "tavi.schedules",
            version: "0.0.0",
            provides: [],
            requires: [WorkflowService, PersistenceService, LoggerService],
            start: ({ dependencies, scope }) => {
              const log = dependencies.get(LoggerService);
              // See `TaviRuntimeOptions.scheduleSweepEnabled`: a composition
              // that exists to admit one operator-requested run must not also
              // start firing schedules on a timer.
              // Present in this branch for the same reason the wait sweep's
              // workflow is: this plugin only runs when `hasModelTransport` is.
              if (options.scheduleSweepEnabled === false || scheduleDependencies === undefined) return {};
              const handle: ScheduleSchedulerHandle = startScheduleScheduler({
                ...scheduleDependencies,
                // The planner sweeps when a fire falls due; this timer is only the fallback.
                intervalMs: options.scheduleSweepIntervalMs ?? DUE_SWEEP_FALLBACK_MS,
                ...(options.scheduleSweepIntervalMs === undefined ? { every: duePlanner.every } : {}),
                // Shutdown closes admission before it stops this plugin: a sweep
                // then leaves its remaining fires due instead of failing each.
                stopping: () => admissions.closed(),
                onSwept: (result) => {
                  const fired = result.fired.filter((entry) => entry.outcome.kind === "ran");
                  if (fired.length > 0) {
                    log.info("schedule sweep fired runs", { count: fired.length });
                  }
                },
              });
              // Awaited, so a fire mid-run reports before the store goes away
              // rather than being found orphaned at the next start.
              scope.defer(() => handle.stop());
              const inFlight = scheduleDependencies.inFlight;
              scope.defer(
                duePlanner.register("schedules", {
                  sweep: handle.sweep,
                  // A held run's end and a lapsed hold are noticed by the sweep, at the old timer's pace.
                  busy: () => (inFlight?.heldTasks().length ?? 0) > 0,
                }),
              );
              // File watchers react to their files only while the owner serves; stopped before the scheduler is.
              if (options.scheduleWatchersEnabled === true) {
                scope.defer(() => scheduleWatchers.stop());
                void scheduleWatchers.start().catch((error: unknown) => log.warn("schedule file watchers did not start", { error }));
              }
              return {};
            },
          },
        ] satisfies readonly PluginDefinition[])
      : []),
    {
      // The built-in onboarding flow. Any approved plugin with
      // `provides: ["onboarding"]` can replace it per install (`tavi onboard provider <id>`).
      id: BUILTIN_ONBOARDING_PROVIDER_ID,
      version: "0.0.0",
      provides: [],
      requires: [],
      start: ({ scope }) => {
        scope.defer(
          onboardingProviders.install(BUILTIN_ONBOARDING_PROVIDER_ID, { provider: createBuiltinOnboardingProvider(), kind: "builtin" }),
        );
        return {};
      },
    } satisfies PluginDefinition,
    {
      // The built-in ideas provider: catalogue templates the census can run.
      // Any approved plugin with `provides: ["ideas"]` can replace it per workspace (`tavi ideas provider <id>`).
      id: BUILTIN_IDEAS_PROVIDER_ID,
      version: "0.0.0",
      provides: [],
      requires: [],
      start: ({ scope }) => {
        scope.defer(
          ideasProviders.install(BUILTIN_IDEAS_PROVIDER_ID, {
            provider: createBuiltinIdeasProvider(),
            kind: "builtin",
            receives: ["memory", "tasks", "brief", "ledger"],
            // Two fast-model turns, one after the other: choosing the ideas that fit, then rewording them.
            maxRunSeconds: 60,
            usesTurns: true,
          }),
        );
        // A run under way is let finish before the owner stops, so it does not leave a `running` row behind.
        scope.defer(async () => await ideasHost.idle());
        return {};
      },
    } satisfies PluginDefinition,
    ...(options.ideasEnabled === true && options.scheduleSweepEnabled !== false
      ? [
          {
            // The ideas host: each workspace's run once a local day inside its hours, and `/ideas`.
            id: BUILTIN_IDEAS_HOST_ID,
            version: "0.0.0",
            provides: [],
            requires: [],
            start: ({ scope }) => {
              ideasHost.start();
              scope.defer(() => ideasHost.stop());
              // A reply of 1–3 to the weekly digest, on its channel: the idea it picks goes with the message.
              scope.defer(
                turnHooks.register(
                  BUILTIN_IDEAS_HOST_ID,
                  IDEAS_HOOKS,
                  "prompt.submit",
                  undefined,
                  ideasDigestReplyHook({
                    repositories: persistencePort.repositories,
                    principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
                    // A pick is offered only while what it uses is still here, as the tab offers it.
                    census: ideasCensusOf,
                    chatOf: async (taskId) => {
                      const conversation = await persistencePort.repositories.messagingConversations.getByTask(taskId);
                      return conversation === undefined
                        ? undefined
                        : { connectionId: conversation.connectionId, chatId: conversationOfKey(conversation.externalConversationId) };
                    },
                    now: () => new Date(clock.now()),
                    newId: () => clock.newId("feedback"),
                    log: (message, fields) => logger.warn(message, fields),
                  }),
                ),
              );
              scope.defer(
                turnHooks.registerCommand(
                  BUILTIN_IDEAS_HOST_ID,
                  IDEAS_COMMANDS,
                  "ideas",
                  ideasSlashCommand({
                    repositories: persistencePort.repositories,
                    principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
                    now: () => new Date(clock.now()),
                    census: ideasCensusOf,
                    providers: () => ideasProviderViews(ideasProviders.list()),
                    refresh: async (workspaceId) => await ideasHost.refresh(workspaceId),
                    nextRunAt: async (workspaceId) => await ideasHost.nextAt(workspaceId),
                    continueChat: ideasContinueChatOf,
                    ideaWords: ideaWordsIn,
                    placeOf: (envelope) => memoryCommandPlaces.get(envelope),
                  }),
                ),
              );
              return {};
            },
          } satisfies PluginDefinition,
        ]
      : []),
    ...(options.heartbeatEnabled === true && options.scheduleSweepEnabled !== false
      ? ([
          {
            // The heartbeat host: the sweep, the claim, the cheap
            // gates and the record. Non-core: disabling it is the heartbeat's global kill switch.
            id: BUILTIN_HEARTBEAT_HOST_ID,
            version: "0.0.0",
            provides: [],
            requires: [PersistenceService, LoggerService],
            start: ({ dependencies, scope }) => {
              const log = dependencies.get(LoggerService);
              const repositories = persistencePort.repositories;
              late.heartbeatHost = startHeartbeatHost({
                repository: repositories.heartbeats,
                providers: heartbeatProviders,
                providerStates: heartbeatProviderStates,
                // Mods' heartbeat.item and heartbeat.tick hooks.
                hooks: turnHooks,
                now: () => new Date(clock.now()),
                newId: (prefix) => clock.newId(prefix),
                sweepMs: overrides.heartbeatTiming?.sweepMs ?? 30_000,
                // The planner sweeps when a tick falls due; the host's own timer is only the fallback.
                sweepEveryMs: overrides.heartbeatTiming?.sweepMs ?? DUE_SWEEP_FALLBACK_MS,
                ...(overrides.heartbeatTiming?.sweepMs === undefined ? { every: duePlanner.every } : {}),
                ...(overrides.heartbeatTiming?.eventDebounceMs === undefined
                  ? {}
                  : { eventDebounceMs: overrides.heartbeatTiming.eventDebounceMs }),
                timezoneOf: async (workspaceId) =>
                  (await repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
                localeOf: workspaceLocaleOf(repositories.workspaceSettings),
                homeActivity: async (workspaceId, principalId) => {
                  const home = await repositories.tasks.homeOf(workspaceId, principalId);
                  if (home === undefined) return undefined;
                  const task = await repositories.tasks.get(home);
                  const { lastAt } = await repositories.transcripts.activity(home, { max: 1 });
                  return {
                    running: task?.status === "admitted" || task?.status === "running",
                    ...(lastAt === undefined ? {} : { lastUserEntryAt: lastAt }),
                  };
                },
                freeBytes: () => freeBytesAt(options.dataDirectory),
                modelAvailable: async (state) =>
                  state.config.model !== undefined ||
                  (await repositories.modelConfig.getRoleBinding(state.workspaceId, "fast")) !== undefined,
                signalSources: heartbeatSignals,
                // Paused memory gives a tick no memory block (invariant 13).
                // A tick on a remote model (its own, else the `fast` role's) reads nothing a local chat wrote.
                memoryContext: async (state, query) => {
                  if (!(await memorySettings(state.workspaceId)).enabled) return [];
                  const own = state.config.model ?? (await repositories.modelConfig.getRoleBinding(state.workspaceId, "fast"))?.target;
                  const local = own !== undefined && (await modelConnectionLocality(own.connectionId)) === "local";
                  return await heartbeatMemoryContext(local ? memory : withoutLocalOrigin(memory), state, query);
                },
                // What it tells goes to Home and the heartbeat's targets.
                delivery: createHeartbeatDelivery({
                  notices: chatNotices,
                  messaging,
                  connections: repositories.messagingConnections,
                  outbox: repositories.messagingOutbox,
                  log: (message, fields) => log.warn(message, fields),
                  localeOf: workspaceLocaleOf(repositories.workspaceSettings),
                }),
                // A provider's model turns need the workflow: an owner without a model connection has none to run.
                ...(workflow === undefined
                  ? {}
                  : {
                      runTurn: createHeartbeatTurnRunner({
                        workflow,
                        reports: heartbeatReports,
                        models: repositories.modelConfig,
                        ...(taskRouting.choose === undefined ? {} : { choose: taskRouting.choose.bind(taskRouting) }),
                        accounting: modelAccounting,
                        readOnlyTool: (toolId) => tools.get(toolId)?.effect === "read-only",
                        pluginTool: (toolId) => heartbeatToolChoices().some((choice) => choice.id === toolId),
                        cancel: async (taskId, reason) => {
                          await recordCancellation(store, { taskId, reason, operator: "heartbeat" }, () => clock.now());
                        },
                        now: () => clock.now(),
                      }),
                    }),
                log: (level, message, fields) => (level === "warn" ? log.warn(message, fields) : log.info(message, fields)),
              });
              scope.defer(() => {
                late.heartbeatHost?.stop();
                late.heartbeatHost = undefined;
              });
              scope.defer(duePlanner.register("heartbeats", { sweep: async () => await late.heartbeatHost?.sweepDue() }));
              const events = startHeartbeatEvents({
                wake: (workspaceId, principalId, event) => late.heartbeatHost?.wake(workspaceId, principalId, event),
                repositories,
                needs: async (workspaceId) => {
                  const { needs, truncated } = await listNeeds(repositories, { workspaceId, limit: 100 });
                  return { needs, truncated };
                },
                workspaces: () => options.workspaces.map((workspace) => workspace.workspaceId),
                principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
                onCompleted: (listener) => runEventBus.onCompleted(listener),
                now: () => new Date(clock.now()),
                ...(overrides.heartbeatTiming?.needPollMs === undefined
                  ? { writes: () => store.writeCount, every: duePlanner.every }
                  : { pollMs: overrides.heartbeatTiming.needPollMs }),
                log: (message, fields) => log.warn(message, fields),
              });
              late.heartbeatEvents = events;
              scope.defer(() => {
                events.stop();
                late.heartbeatEvents = undefined;
              });
              // `/heartbeat`: the first built-in command, on every front end and channel.
              scope.defer(
                turnHooks.registerCommand(
                  BUILTIN_HEARTBEAT_HOST_ID,
                  HEARTBEAT_COMMANDS,
                  "heartbeat",
                  heartbeatSlashCommand({
                    repositories,
                    principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
                    options: heartbeatOptions,
                    providers: () => heartbeatProviders.list(),
                    providerStates: heartbeatProviderStates,
                    toolChoices: heartbeatToolChoices,
                    sources: () =>
                      heartbeatSignals.list().map(({ id, kind, label }) => (label === undefined ? { id, kind } : { id, kind, label })),
                    host: () => late.heartbeatHost,
                    author: "command",
                    now: () => new Date(clock.now()),
                    onDiagnostic: (message, fields) => log.warn(message, fields),
                  }),
                ),
              );
              return {};
            },
          },
          {
            // The built-in heartbeat provider: one metered `fast` turn a tick.
            // Disabling it pauses every heartbeat that selected it until another is picked.
            id: BUILTIN_HEARTBEAT_PROVIDER_ID,
            version: "0.0.0",
            provides: [],
            requires: [],
            start: ({ scope }) => {
              scope.defer(
                heartbeatProviders.install(BUILTIN_HEARTBEAT_PROVIDER_ID, {
                  provider: createBuiltinHeartbeatProvider(),
                  kind: "builtin",
                  receives: ["instructions", "signals", "ledger", "memory"],
                  usesTurns: true,
                  maxTickSeconds: HEARTBEAT_LIMITS.builtinMaxTickSeconds,
                }),
              );
              return {};
            },
          },
          {
            // The built-in signal sources: needs, the agenda, failed schedules,
            // channels needing attention, held messages. Disabling it leaves only the instructions to look at.
            id: "tavi.heartbeatsignals",
            version: "0.0.0",
            provides: [],
            requires: [PersistenceService],
            start: ({ scope }) => {
              for (const source of builtinHeartbeatSources(persistencePort.repositories, {
                routineOwners: (scheduleIds) => routines.scheduleOwners(scheduleIds),
              }))
                scope.defer(heartbeatSignals.install(source.id, source, "builtin"));
              // Rooms waiting to be added or left: the operator's only.
              const rooms = roomInvitationsSource({
                invitations: roomInvitations,
                connections: persistencePort.repositories.messagingConnections,
                operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
              });
              scope.defer(heartbeatSignals.install(rooms.id, rooms, "builtin"));
              // Watched pages: the guarded public fetch, dialling only the hosts the heartbeat may read.
              const pages = watchedPagesSource({
                heartbeats: persistencePort.repositories.heartbeats,
                fetchPage: heartbeatFetchPage,
                log: (message, fields) => logger.info(message, fields),
              });
              scope.defer(heartbeatSignals.install(pages.id, pages, "builtin"));
              // Storage: chat folders near their budget and a disk below its floor, by size alone.
              const storage = storageSignalsSource({
                space: folderSpace,
                // A chat's managed folder is `<data-dir>/chats/<workspace>/<task-id>`: its parent lists them all.
                chatFolders: async (workspaceId) => await managedChatFolders(dirname(chatFolders.managedPath(workspaceId, "_"))),
                ownerOf: async (taskId) => (await persistencePort.repositories.tasks.get(taskId))?.principalId,
              });
              scope.defer(heartbeatSignals.install(storage.id, storage, "builtin"));
              return {};
            },
          },
        ] satisfies readonly PluginDefinition[])
      : []),
    ...(options.memoryHostEnabled === true
      ? ([
          {
            // The memory host: the chat commands `/remember`, `/forget`,
            // `/memory` and `/why`. Non-core: disabling it withdraws them; recall and proposals keep working.
            id: MEMORY_PLUGIN_ID,
            version: "0.0.0",
            provides: [],
            requires: [PersistenceService],
            start: ({ scope }) => {
              const repositories = persistencePort.repositories;
              const commands = memorySlashCommands({
                memory,
                repositories,
                operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
                placeOf: (envelope) => memoryCommandPlaces.get(envelope),
                reachOf: (taskId) => memoryReachOf(repositories, taskId),
                memorySettings,
                timezoneOf: async (workspaceId) =>
                  (await repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
                newId: (prefix) => clock.newId(prefix),
                now: () => new Date(clock.now()),
                // A receipt names the channels whose earlier card messages cannot be edited.
                channelNote: async (recordId, t) => memoryUnreachedNote((await memoryChannelCards.beforeForget(recordId)).unreached, t),
              });
              for (const [name, run] of Object.entries(commands))
                scope.defer(turnHooks.registerCommand(MEMORY_PLUGIN_ID, MEMORY_COMMANDS, name, run));
              // The review digest before proposals expire, on the host's one tick.
              const digest = createMemoryDigest({
                memory,
                repositories,
                workspaces: () =>
                  options.workspaces.map((workspace) => ({ workspaceId: workspace.workspaceId, principalId: workspace.principalId })),
                memorySettings,
                timezoneOf: async (workspaceId) =>
                  (await repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
                operatorTargets: reminderTargets.operatorTargets,
                deliver: (card) => memoryChannelCards.deliver(card),
                newId: (prefix) => clock.newId(prefix),
                now: overrides.memoryTiming?.now ?? (() => new Date(clock.now())),
                log: (message, fields) => logger.info(message, fields),
              });
              // The idle review: a quiet chat's new words read once, on the same tick.
              // A review's call in flight ends when the owner stops, rather than holding shutdown to its timeout.
              const stopping = new AbortController();
              const review = createMemoryIdleReview({
                models: modelAdapter,
                memory,
                repositories,
                workspaces: () => options.workspaces.map((workspace) => ({ workspaceId: workspace.workspaceId })),
                memorySettings,
                timezoneOf: async (workspaceId) =>
                  (await repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
                // The `extraction` role, else `fast`, else the chat's own model; never a remote one for a chat that used a
                // local connection (the rule the task summarizer applies too).
                targetOf: async (workspaceId, taskId) => {
                  const calls = (await modelAccounting.summaries(taskId)).filter((attempt) => attempt.purpose === "generation");
                  const latest = calls.at(-1);
                  const own = latest === undefined ? undefined : { connectionId: latest.connectionId, model: latest.model };
                  // `extraction`, else `fast`, as the flush falls back.
                  const bound = roleOrFast(await repositories.modelConfig.listRoleBindings(workspaceId), "extraction");
                  return await chooseRoleTarget({
                    own,
                    bound,
                    used: calls.map((attempt) => attempt.connectionId),
                    locality: modelConnectionLocality,
                  });
                },
                // The workspace's memory provider drafts: an external one only with `conversation` on, never for a
                // chat on a local connection (invariant 27), and told the titles of what `records` and
                // `includePersonal` let it receive (invariant 26).
                providerFor: (workspaceId, taskId) =>
                  chatCaptureProviderOf(memoryProviders, workspaceId, async () =>
                    hybridRef.current === undefined ? true : await hybridRef.current.chatIsLocal(workspaceId, taskId),
                  ),
                autoApprove: memoryAutoApprove,
                onReviewed: (taskId, seq, recordIds) => memoryCards.onReviewed(taskId, seq, recordIds),
                newId: (prefix) => clock.newId(prefix),
                now: overrides.memoryTiming?.now ?? (() => new Date(clock.now())),
                startedAt: (overrides.memoryTiming?.now ?? (() => new Date(clock.now())))(),
                signal: stopping.signal,
                log: (message, fields) => logger.info(message, fields),
              });
              // Hybrid recall's vectors: embedded on the same tick, 600 a minute at most.
              const vectors = createMemoryVectorBackfill({
                memory: repositories.memory,
                embeddings,
                workspaces: vectorWorkspaces,
                memorySettings,
                now: overrides.memoryTiming?.now ?? (() => new Date(clock.now())),
                signal: stopping.signal,
                log: (message, fields) => logger.info(message, fields),
              });
              // Weekly tidy-up suggestions, off by default: proposals only, on the same tick.
              const consolidation = createMemoryConsolidation({
                models: modelAdapter,
                memory,
                repositories,
                workspaces: () =>
                  options.workspaces.map((workspace) => ({ workspaceId: workspace.workspaceId, principalId: workspace.principalId })),
                peopleOf: (workspaceId) =>
                  workspacePrincipals(access.resolveWorkspace(workspaceId)?.principalId, access.peopleOf(workspaceId)),
                memorySettings,
                timezoneOf: async (workspaceId) =>
                  (await repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
                providers: memoryProviders,
                // The `extraction` role, else the workspace's utility model (no chat's words are read, so no chat's locality applies).
                targetOf: async (workspaceId) =>
                  await utilityTarget(repositories.modelConfig, workspaceId, {
                    connectionId: options.defaultConnectionId,
                    model: options.defaultModel,
                  }),
                isLocal: async (target) => (await modelConnectionLocality(target.connectionId)) === "local",
                newId: (prefix) => clock.newId(prefix),
                now: overrides.memoryTiming?.now ?? (() => new Date(clock.now())),
                signal: stopping.signal,
                log: (message, fields) => logger.info(message, fields),
              });
              const tick = startMemoryTick({
                ...(options.memoryTickEnabled === false ? {} : { everyMs: overrides.memoryTiming?.tickMs ?? 60_000 }),
                // Each job checks its own due time; with nothing written they are looked at every few minutes, not each minute.
                ...(overrides.memoryTiming?.tickMs === undefined
                  ? { gate: writeGate(() => store.writeCount, MEMORY_IDLE_TICK_MS), every: duePlanner.every }
                  : {}),
                jobs: [
                  () => digest.tick(),
                  () => review.tick(),
                  async () => {
                    await vectors.tick();
                  },
                  () => consolidation.tick(),
                ],
                log: (message, fields) => logger.warn(message, fields),
              });
              // The same jobs on an operator's demand, between ticks (`tavi memory reindex`, `review-now`, `consolidate-now`).
              scope.defer(
                memoryJobsSlot.set({
                  reindex: async (workspaceId) =>
                    await tick.exclusive(async () => {
                      const pass = await vectors.tick({ workspaceId });
                      const settings = await memorySettings(workspaceId);
                      const workspace = access.resolveWorkspace(workspaceId);
                      const counts = await memoryVectorsDoctor({
                        workspaceId,
                        principalId: workspace?.principalId,
                        principalIds: workspacePrincipals(workspace?.principalId, access.peopleOf(workspaceId)),
                        settings,
                        memory: repositories.memory,
                        embeddings,
                        now: new Date(clock.now()).toISOString(),
                      });
                      let blocked: string | undefined;
                      if (settings.retrieval === "hybrid") {
                        if (!settings.enabled) blocked = "memory is paused";
                        else if (counts.model === null)
                          blocked = "no embedding model is bound (tavi models set-role embedding --connection <id> --model <id>)";
                        else blocked = embeddingRefusal(settings, await embeddings.role(workspaceId));
                      }
                      return {
                        workspaceId,
                        retrieval: settings.retrieval,
                        model: counts.model,
                        embedded: pass.embedded,
                        failed: pass.failed,
                        limited: pass.limited,
                        ...(pass.retryInMs === undefined ? {} : { retryInMs: Math.round(pass.retryInMs) }),
                        backingOff: pass.backingOff,
                        ...(blocked === undefined ? {} : { blocked }),
                        indexed: counts.indexed,
                        missing: counts.missing,
                        failedTotal: counts.failed,
                      };
                    }),
                  reviewNow: async (workspaceId, taskId) =>
                    await tick.exclusive(async () => {
                      const settings = await memorySettings(workspaceId);
                      const chats = await review.reviewNow({ workspaceId, ...(taskId === undefined ? {} : { taskId }) });
                      return {
                        workspaceId,
                        capturing: settings.enabled && settings.capture === "suggest",
                        chats: chats.map((chat) => ({
                          ...chat,
                          filed: [...chat.filed],
                          ...(chat.reason === undefined ? {} : { reason: chat.reason.slice(0, 300) }),
                        })),
                      };
                    }),
                  consolidateNow: async (workspaceId, principalId) =>
                    await tick.exclusive(async () => {
                      const settings = await memorySettings(workspaceId);
                      const people = await consolidation.consolidateNow({
                        workspaceId,
                        ...(principalId === undefined ? {} : { principalId }),
                      });
                      return {
                        workspaceId,
                        consolidation: settings.consolidation,
                        enabled: settings.enabled,
                        people: (people ?? []).map((person) => ({
                          ...person,
                          filed: [...person.filed],
                          ...(person.reason === undefined ? {} : { reason: person.reason.slice(0, 300) }),
                        })),
                      };
                    }),
                }),
              );
              scope.defer(async () => {
                tick.stop();
                stopping.abort();
                await tick.running();
              });
              return {};
            },
          },
        ] satisfies readonly PluginDefinition[])
      : []),
    {
      // One local connection per workspace: the
      // channel of the owner's own front ends. Nothing to reach, so it opens
      // at once; closed on shutdown like any connection.
      id: "tavi.localmessaging",
      version: "0.0.0",
      provides: [],
      requires: [LoggerService],
      start: async ({ dependencies, scope }) => {
        const log = dependencies.get(LoggerService);
        for (const workspace of options.workspaces) {
          const connectionId = localConnectionId(workspace.workspaceId);
          scope.defer(() =>
            messaging
              .closeConnection(connectionId)
              .then(() => {
                localInstances.delete(connectionId);
              })
              .catch((error) => {
                log.error("failed to close messaging connection", { connectionId, error });
                throw error;
              }),
          );
          await messaging.openConnection({
            connection: {
              connectionId,
              providerId: LOCAL_PROVIDER_ID,
              accountIdentity: "local",
              workspaceId: workspace.workspaceId,
              configRevision: 1,
              enabled: true,
            },
            config: {},
          });
        }
        return {};
      },
    },
    // Each built-in channel is its own plugin: it installs its channel (descriptor, connector) as it starts and
    // withdraws it as it stops. Disabled, its channel is not installed, and a channel plugin may take its provider id.
    ...BUILTIN_CHANNELS.map(
      (channel): PluginDefinition => ({
        id: channel.pluginId,
        version: "0.0.0",
        provides: [builtinChannelService(channel.pluginId)],
        requires: [],
        start: ({ scope }) => {
          const withdraw = installBuiltinChannel(channel);
          scope.defer(withdraw);
          return { [builtinChannelService(channel.pluginId).id]: true };
        },
      }),
    ),
    {
      // Opens every messaging connection saved in Settings, of every installed channel, built-in or a plugin's, and
      // closes them on shutdown, independent of `hasModelTransport`: an operator can run a connector with no model
      // connection configured. A connection that cannot open is reported in Settings and the rest still open. Core:
      // there is no switch that stops every channel; each channel's plugin is disabled on its own.
      id: CHANNEL_HOST_PLUGIN_ID,
      version: "0.0.0",
      provides: [],
      requires: [LoggerService],
      // After the built-in channel plugins that run: their channels are installed before connections open.
      optional: BUILTIN_CHANNELS.map((channel) => builtinChannelService(channel.pluginId)),
      start: async ({ dependencies, scope }) => {
        const log = dependencies.get(LoggerService);
        // Deferred first, so a connection opened before a later one failed is still closed.
        scope.defer(() =>
          channels.close().catch((error) => {
            log.error("failed to close messaging connections", { error });
            throw error;
          }),
        );
        await channels.start();
        // What each purging channel's connection is, remembered while it runs: a removal made once it is closed still knows.
        await rememberOpenAccounts().catch((error: unknown) => log.warn("connections' accounts could not be remembered", { error }));
        await cancelOpenPurges(log);
        // Closed before the connections it feeds (deferred later, run first).
        scope.defer(() =>
          ingress.close().catch((error) => {
            log.error("failed to close the channel ingress", { error });
            throw error;
          }),
        );
        await ingress.ensure();
        return {};
      },
    },
  ];
  return { builtinPlugins, refreshBuiltinSearch };
}

/** What a built-in channel plugin provides: only that it ran, so the channel host starts after it (matched by id). */
function builtinChannelService(pluginId: string): ServiceToken<boolean> {
  return createServiceToken<boolean>(`${pluginId}.installed`);
}

export type BuiltinPluginsContext = ConversationsContext & ReturnType<typeof composeBuiltinPlugins>;
