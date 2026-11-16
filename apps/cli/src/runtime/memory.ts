import { isPlumbingOrigin, TaviError, type MemoryActor, type MemoryServicePort, isLocalConnectionId } from "@tavi/contracts";
import { withLocalChatMemory } from "../features/models/local-chats.js";
import { openMemoryOverride, openMemoryService, memorySettingsReader } from "../server/workspace-settings-commands.js";
import { MemoryProviderRegistry, approvedMemoryDeclaration, withProviderRecall } from "../features/memory/providers.js";
import { createMemoryProviderSync, type MemoryProviderSync } from "../features/memory/provider-sync.js";
import type { EmbeddingRoleService } from "../features/memory/embedding-role.js";
import { createChatNotices, EARLIER_CHAT_KINDS } from "../features/tasks/notices.js";
import { createMemoryReads } from "../features/memory/reads.js";
import { registerMemoryTools } from "../features/memory/tools.js";
import { createMemoryAutoApprove } from "../features/memory/auto-approve.js";
import { hybridDraftVector, MemoryRecallTimes, workspacePrincipals } from "../features/memory/vectors.js";
import { createMemoryJobsSlot } from "../features/memory/jobs-now.js";
import { workspaceZoneOf } from "../features/memory/owner.js";
import { createMemoryCards } from "../features/memory/cards.js";
import type { MemoryChannelCards } from "../features/memory/channel-cards.js";
import type { CoreContext } from "./core.js";
import { MEMORY_IDLE_TICK_MS } from "./wakeups.js";
import { writeGate } from "../shared/write-gate.js";
import { createOwnerReadMemos } from "./read-memo.js";

/** The persistence port, memory and its providers, and the chat notices, memory cards and memory tools. */
export function composeMemory(composed: CoreContext) {
  const { clock, duePlanner, late, logger, options, overrides, store, tools } = composed;
  // The guarded public-retrieval path. Registered on the
  // generic surface against the operator's own allowlist; a routine narrows or
  // widens it per revision through `routineResearchTools`.
  // `enabled` is stated rather than defaulted: this path is always registered,
  // and there is no deployment-level kill switch that removes it. Its boundaries
  // are per revision — the egress mode and host allowlist the operator sets on a
  // routine, which `routineResearchTools` intersects with `httpAllowedHosts` —
  // not a build-time choice made here.

  // Every `Sqlite*Repository` returned here is a stateless wrapper over the
  // shared store, so one binding reused below is equivalent to calling
  // `asPort()` again at each use site — just without the repeated
  // allocation of a fresh repository-object set per call.
  const persistencePort = store.asPort();
  late.persistencePort = persistencePort;
  // The settings, delegation rows and task origins a turn reads many times, each dropped by the write that changes it.
  const readMemos = createOwnerReadMemos(store, persistencePort.repositories);
  // The workspace's `memory` section, read per call: a change applies from the next model call.
  const memorySettings = memorySettingsReader(readMemos.workspaceSettings, { contextTokens: options.maxContextTokens });
  /** Memory cards on channels, built once messaging is: a forget edits the messages a card was sent as. */
  const memoryChannelCardsRef: { current?: MemoryChannelCards } = {};
  // Hybrid recall: the embedding role and a chat's locality are built further down
  // (they need the accounted model port), so recall reads them through this ref; until then, words only.
  const hybridRef: {
    current?: {
      readonly embeddings: EmbeddingRoleService;
      readonly chatIsLocal: (workspaceId: string, taskId: string) => Promise<boolean>;
      readonly chatRunsLocal: (actor: MemoryActor) => Promise<boolean>;
    };
  } = {};
  const hybridEmbeddings = (): EmbeddingRoleService => {
    if (hybridRef.current === undefined) throw new TaviError("UNAVAILABLE", "The embedding role is not ready yet");
    return hybridRef.current.embeddings;
  };
  const memoryRecallTimes = new MemoryRecallTimes();
  // Set by the `tavi.memory` host when it starts (below): its jobs, run now by an operator.
  const memoryJobsSlot = createMemoryJobsSlot();
  const aroundMemoryForget = async (recordId: string) => (await memoryChannelCardsRef.current?.beforeForget(recordId))?.after;
  // The memory providers: the host's registry, not `tavi.memory`'s, so disabling that plugin
  // never stops recall. `tavi.memoryprovider` installs the built-in below; recall goes through it.
  // A workspace selects its provider: one not running falls back to the built-in, said once to the operator.
  const memoryProviders = new MemoryProviderRegistry({
    settingsOf: memorySettings,
    onFallback: (workspaceId, notice) => logger.warn("memory provider unavailable; the built-in serves", { workspaceId, notice }),
  });
  /** The served workspaces and their people, read when a provider is synced (`access` is built further down). */
  const memorySyncRef: { current?: MemoryProviderSync } = {};
  // A heartbeat check's own memory.search is the heartbeat's: its words are signals, other people's (invariants 14 and 26).
  // An idea's prepared step is plumbing too, held to the same: it is never the person's own recall.
  const heartbeatTask = async (taskId: string): Promise<boolean> => isPlumbingOrigin(await readMemos.taskOrigin(taskId));
  const hybridRecall = {
    embeddings: {
      role: (workspaceId: string) => hybridEmbeddings().role(workspaceId),
      embed: (call: Parameters<EmbeddingRoleService["embed"]>[0]) => hybridEmbeddings().embed(call),
    },
    // Unknown is local: a query is never sent where it might not be allowed to go.
    chatIsLocal: async (workspaceId: string, taskId: string) =>
      hybridRef.current === undefined ? true : await hybridRef.current.chatIsLocal(workspaceId, taskId),
    // A heartbeat check's own memory.search stays lexical (invariant 14).
    heartbeatTask,
    // The operator whose own personal memory a remote embedding connection may embed, once accepted.
    workspacePrincipal: (workspaceId: string) => options.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.principalId,
    times: memoryRecallTimes,
  };
  const memoryPort = withProviderRecall(
    overrides.memoryOverride !== undefined
      ? openMemoryOverride(
          overrides.memoryOverride,
          {
            now: () => clock.now(),
            onChange: async (scope) => {
              await persistencePort.repositories.center
                .memoryChanged({ scope })
                .catch((error: unknown) => logger.warn("memory onChange failed", { error: String(error) }));
            },
          },
          aroundMemoryForget,
        )
      : withLocalChatMemory(openMemoryService(persistencePort, memorySettings, aroundMemoryForget, hybridRecall), {
          // A local chat's notes are stamped as such, and a chat on a remote model never recalls them. Before the
          // models are composed nothing is known: a write is stamped local, a read is a remote reader's.
          chatIsLocal: async (workspaceId, taskId) =>
            hybridRef.current === undefined ? true : await hybridRef.current.chatIsLocal(workspaceId, taskId),
          chatRunsLocal: async (actor) => (hybridRef.current === undefined ? false : await hybridRef.current.chatRunsLocal(actor)),
        }),
    memoryProviders,
    {
      log: (message, fields) => logger.warn(message, fields),
      // An `index: "host"` provider's candidates, only with `records` egress.
      snapshots: async (actor, snapshotOptions) =>
        memorySyncRef.current === undefined ? [] : await memorySyncRef.current.snapshotsFor(actor, snapshotOptions),
      // A heartbeat check's own memory.search never reaches an external provider (invariant 26).
      heartbeatTask,
      // Nor does a local chat's recall (invariant 27): unknown is local.
      localChat: async (actor) => {
        const taskId = actor.chatTaskId ?? actor.runId;
        if (taskId === undefined) return false;
        return hybridRef.current === undefined ? true : await hybridRef.current.chatIsLocal(actor.workspaceId, taskId);
      },
    },
  );
  // External providers' own indexes follow every committed change, before the call returns (invariant 9).
  const memoryProviderSync = createMemoryProviderSync({
    memory: memoryPort,
    providers: memoryProviders,
    declarationOf: (providerId) => approvedMemoryDeclaration(persistencePort.repositories.plugins, providerId),
    workspaces: () => options.workspaces.map((workspace) => ({ workspaceId: workspace.workspaceId, principalId: workspace.principalId })),
    peopleOf: (workspaceId) =>
      workspacePrincipals(late.access.resolveWorkspace(workspaceId)?.principalId, late.access.peopleOf(workspaceId)),
    settingsOf: memorySettings,
    journal: persistencePort.repositories.memory,
    now: () => clock.now(),
    log: (message, fields) => logger.warn(message, fields),
    ...(overrides.memoryTiming?.syncMs === undefined ? {} : { syncDeadlineMs: overrides.memoryTiming.syncMs }),
  });
  memorySyncRef.current = memoryProviderSync;
  const memory: MemoryServicePort = memoryProviderSync.wrap(memoryPort);
  // Pending removals and stale indexes are resent on the owner's own timer, not `tavi.memory`'s tick:
  // disabling that plugin never stops a removal. Stopped, and its pass awaited, on close.
  // An idle owner with no provider running skips the pass without a database call until something is written,
  // and the pass's timer is the due-work planner's, shared with the owner's other periodic work.
  const memoryProviderUpkeep =
    overrides.memoryTiming?.tickMs === undefined
      ? memoryProviderSync.startUpkeep(
          60_000,
          writeGate(() => store.writeCount, MEMORY_IDLE_TICK_MS),
          duePlanner.every,
        )
      : memoryProviderSync.startUpkeep(overrides.memoryTiming.tickMs);
  // Notices posted into chats.
  const chatNotices = createChatNotices({
    repositories: persistencePort.repositories,
    homeOf: async (workspaceId, principalId) => await persistencePort.repositories.tasks.homeOf(workspaceId, principalId),
    recentChats: async (workspaceId, principalId, limit) =>
      (await store.listTaskSessions({ workspaceId, principalId, chatKinds: [...EARLIER_CHAT_KINDS], limit })).rows,
    isLocalConnection: isLocalConnectionId,
    newId: () => clock.newId("notice"),
    now: () => clock.now(),
    log: (message, fields) => logger.warn(message, fields),
  });
  // Auto-approve: the operator's *Keep without asking*, applied after a turn and a review, only where its conditions hold.
  const memoryAutoApprove = createMemoryAutoApprove({
    memory,
    repositories: persistencePort.repositories,
    operatorOf: (workspaceId) => late.access.resolveWorkspace(workspaceId)?.principalId,
    // Kin by meaning under hybrid recall, the draft embedded under recall's own rules; an override's store has no vectors.
    ...(overrides.memoryOverride !== undefined ? {} : { draftVector: hybridDraftVector({ ...hybridRecall, memorySettings }) }),
    log: (message, fields) => logger.info(message, fields),
  });
  // Memory cards: each turn's proposals, and each flush's, shown in the chat for the person to decide.
  const memoryCards = createMemoryCards({
    autoApprove: memoryAutoApprove,
    repositories: persistencePort.repositories,
    newId: () => clock.newId("notice"),
    now: () => clock.now(),
    log: (message, fields) => logger.warn(message, fields),
    // And on the chat's channel, where it is a direct one.
    deliver: async (card) => await memoryChannelCardsRef.current?.deliver(card),
  });
  // What a turn's memory tools returned, for its saved turn's `memoryUsed`.
  const memoryReads = createMemoryReads();
  registerMemoryTools(tools, memory, {
    onProposed: (context, record) => memoryCards.noteProposed(context, record),
    onRead: (context, read, kind) => memoryReads.note(context, read, kind),
    // A date-only `validUntil` holds through that day in the workspace's zone.
    timeZoneOf: workspaceZoneOf(readMemos.workspaceSettings),
    now: () => clock.now(),
    // `memory.forget` forgets only on the operator's own approval, and says which channel messages still show it.
    operatorOf: (workspaceId) => late.access.resolveWorkspace(workspaceId)?.principalId,
    beforeForget: async (recordId) => await memoryChannelCardsRef.current?.beforeForget(recordId),
  });
  // Typed by its port, which a declaration can name: the service's own interface is not exported.
  const ports: { readonly memory: MemoryServicePort } = { memory };
  return {
    chatNotices,
    hybridRef,
    ...ports,
    memoryAutoApprove,
    memoryCards,
    memoryChannelCardsRef,
    memoryJobsSlot,
    memoryProviderSync,
    memoryProviderUpkeep,
    memoryProviders,
    memoryReads,
    memoryRecallTimes,
    memorySettings,
    persistencePort,
    readMemos,
  };
}

export type MemoryContext = CoreContext & ReturnType<typeof composeMemory>;
