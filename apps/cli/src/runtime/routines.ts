import { RoutineTemplateRegistry } from "../features/routines/templates.js";
import {
  routinePluginReads,
  AsyncWork,
  RoutineControlService,
  RoutineEvaluationService,
  RoutineNewsService,
  RoutinePublicationService,
  RoutineDeliveryService,
} from "@tavi/runtime";
import {
  type RoutineScope,
  type RoutineSnapshot,
  TaviError,
  type RenderPort,
  DEFAULT_WORKSPACE_ID,
  parallelReadsOf,
} from "@tavi/contracts";
import { createOwnerRenderer } from "../features/browser/host.js";
import { rememberedWorkspaceZone } from "../features/memory/owner.js";
import { ANY_DESTINATION, destinationAllowed, parseDestinationEntry } from "../features/channels/destination.js";
import { registerRoutineTools } from "../features/routines/tools.js";
import { createRoutineNotices } from "../features/routines/notices.js";
import { executeRoutinePipeline } from "../features/routines/pipeline.js";
import { executeRoutineWorkflow, type RoutineFolderPinner } from "../features/routines/workflow.js";
import { externalConnectionsOf } from "./channel-destinations.js";
import type { TaviRuntime } from "./types.js";
import type { WorkflowContext } from "./workflow.js";

/** The routine pipeline, its delivery and publication, its bindings, and the routine tools. */
export function composeRoutines(composed: WorkflowContext) {
  const {
    access,
    askUserDelivery,
    channels,
    chatNotices,
    chatFolders,
    checkpointSaver,
    clock,
    destinationChannels,
    externalInstances,
    fetchGeneration,
    fixtureModel,
    hasModelTransport,
    injectionScan,
    late,
    liveBuiltinConnectionIds,
    liveModelTarget,
    logger,
    materializeArtifact,
    messaging,
    modelAdapter,
    options,
    overrides,
    ownerSession,
    ownershipSessionId,
    persistencePort,
    recordGateObservation,
    redactToolResults,
    resolveLiveDefault,
    resolveModelBinding,
    routineCheckpoints,
    routineDefaultModels,
    routineRuns,
    routines,
    routingConnections,
    scratchAtTurnEnd,
    secrets,
    store,
    taintMode,
    tools,
    turnFolder,
    turnHooks,
    workerPeople,
  } = composed;
  /**
   * The scheduler's dependencies, built once: the sweep fires on them, and so do
   * the owner's `schedules run` and the offline `tavi schedules run-now` — which
   * differ only in how they log and, for the owner, in answering on admission.
   * Absent without a workflow: there is nothing to run a fire with.
   */
  const routineWork = new AsyncWork();
  /**
   * A routine's pinned host folder: checked again at each fire as a
   * chat's primary is, and made the fire's task's primary before its first
   * turn. A retried fire whose task already works there is left as it is.
   */
  const routineFolders: RoutineFolderPinner = {
    check: (path) => chatFolders.checkPrimary(path),
    begin: async (scope, taskId, path) => {
      try {
        await chatFolders.begin(scope, taskId, path, { frontEnd: "local" });
      } catch (error) {
        if (TaviError.from(error).code !== "CONFLICT" || (await chatFolders.resolve(scope, taskId)).primary !== path) throw error;
      }
    },
  };
  const routineWorkflow: TaviRuntime["routineWorkflow"] = (run, fence, instructions, capture) =>
    routineWork.run(async () => {
      if (!hasModelTransport) throw new TaviError("UNAVAILABLE", "Routine model transport is unavailable");
      return executeRoutineWorkflow(
        {
          checkpointSaver,
          models: modelAdapter,
          tools,
          access,
          tasks: persistencePort.repositories.tasks,
          executions: persistencePort.repositories.executions,
          effects: persistencePort.repositories.effects,
          approvals: persistencePort.repositories.approvals,
          cancellations: persistencePort.repositories.cancellations,
          receipts: persistencePort.repositories.receipts,
          artifacts: persistencePort.repositories.artifacts,
          ownerSession,
          connectionId: options.defaultConnectionId,
          model: options.defaultModel,
          onDiagnostic: (message, fields) => logger.warn(message, fields),
          // Offered only to a routine with human checkpoints on.
          askUser: askUserDelivery,
          // A routine's turns get the plugins' hooks and the redaction setting, as owner turns do (invariant 16).
          redactToolResults,
          // `tools.parallelReads`, as owner turns.
          parallelReads: async (workspaceId) =>
            parallelReadsOf((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings),
          // `security.taint` and its observations, as owner turns.
          taintMode,
          injectionScan,
          recordGateObservation,
          turnHooks,
          // Each fire is a run of its own with its own folder, emptied of scratch when its turn ends.
          turnFolder,
          onTurnEnded: scratchAtTurnEnd,
        },
        routineRuns,
        run,
        fence,
        instructions,
        capture,
        undefined,
        routineCheckpoints,
        routineFolders,
      );
    });
  // To the routine's own delivery target, else (or when its channel refuses) into the person's Home.
  const routineNotices = createRoutineNotices({
    routines,
    messaging,
    postHome: (input) => chatNotices.postAlert(input),
    log: (message, fields) => logger.warn(message, fields),
  });
  late.routineNotices = routineNotices;
  const routineNews = new RoutineNewsService(routineRuns);
  const routinePublication = new RoutinePublicationService(routineRuns);
  const routineDelivery = new RoutineDeliveryService(routineRuns, {
    messaging,
    ready: async (job) => {
      const connection = externalConnectionsOf(channels).find((candidate) => candidate.connectionId === job.data.target.connectionId);
      if (connection?.credentialRef === undefined) return false;
      try {
        return (await secrets.getSecret(connection.credentialRef)) !== null;
      } catch {
        return false;
      }
    },
    onPaused: (run, targetId, cause) => routineNotices.deliveryPaused(run, targetId, cause),
  });
  const renderer = overrides.renderOverride ?? createOwnerRenderer();
  const routineRenderer: RenderPort = {
    capabilities: () => renderer.capabilities(),
    renderPdf: (input) => routineWork.run(() => renderer.renderPdf(input)),
  };
  late.routineDispatch = (run, fence) =>
    routineWork.run(() =>
      executeRoutinePipeline(
        {
          runs: routineRuns,
          news: routineNews,
          publication: routinePublication,
          delivery: routineDelivery,
          renderer: routineRenderer,
          workflow: routineWorkflow,
          stopping: () => routineWork.closed,
          materializeArtifact,
        },
        run,
        fence,
      ),
    );
  /** One configuration at a time, so an older one never lands after a newer one. */
  let routineConfiguration: Promise<void> = Promise.resolve();
  const configureRoutineBindings = (): Promise<void> => {
    // Ordering only: the previous configuration reported its own failure.
    const next = routineConfiguration.catch(() => undefined).then(configureRoutineBindingsNow);
    routineConfiguration = next;
    return next;
  };
  const configureRoutineBindingsNow = async () => {
    // The connections and default as configured now, not as the owner started.
    const builtinConnectionIds = await liveBuiltinConnectionIds();
    late.liveRoutineModels = {
      connectionIds: new Set(builtinConnectionIds),
      ...((target) => (target === undefined ? {} : { target }))(
        await resolveLiveDefault(options.workspaces[0]?.workspaceId ?? DEFAULT_WORKSPACE_ID),
      ),
    };
    // A binding names its caller, so each principal that owns routines — the workspace's, and each person allowed there — has its own.
    const modelBindings: Record<string, Record<string, Record<string, string>>> = {};
    const toolBindings: Record<string, Record<string, Record<string, string>>> = {};
    const people: Record<string, readonly string[]> = {};
    for (const workspace of options.workspaces) {
      people[workspace.workspaceId] = access.peopleOf(workspace.workspaceId);
      const workspaceModels: Record<string, Record<string, string>> = {};
      const workspaceTools: Record<string, Record<string, string>> = {};
      modelBindings[workspace.workspaceId] = workspaceModels;
      toolBindings[workspace.workspaceId] = workspaceTools;
      for (const principalId of new Set([workspace.principalId, ...access.peopleOf(workspace.workspaceId)])) {
        const routineContext = { workspaceId: workspace.workspaceId, principalId, runId: "routine-configuration", caller: "owner" };
        // An unavailable or ambiguous provider (several, none selected), or a model connection removed since the owner
        // started, leaves the routine binding unpinned; the call reports it when it is made.
        const unpinned = (error: unknown): undefined => {
          if (!["UNAVAILABLE", "NOT_CONFIGURED"].includes(TaviError.from(error).code)) throw error;
          return undefined;
        };
        const bindings: Record<string, string> = {};
        for (const connectionId of builtinConnectionIds) {
          const resolved = await resolveModelBinding({ connectionId, model: options.defaultModel }, routineContext).catch(unpinned);
          if (resolved !== undefined) bindings[connectionId] = resolved.bindingHash;
        }
        if (fixtureModel !== undefined && routingConnections.length === 0 && liveModelTarget === undefined) {
          const resolved = await resolveModelBinding(
            { connectionId: options.defaultConnectionId, model: options.defaultModel },
            routineContext,
          ).catch(unpinned);
          if (resolved !== undefined) bindings["*"] = resolved.bindingHash;
        }
        for (const id of externalInstances.ids("model", workspace.workspaceId))
          bindings[id] = externalInstances.resolveModel(id, routineContext).bindingHash;
        workspaceModels[principalId] = bindings;
        const search = await tools.get("web_search")?.resolveBinding?.({ query: "routine-binding" }, routineContext).catch(unpinned);
        const fetchBinding = await fetchGeneration(routineContext).catch(unpinned);
        workspaceTools[principalId] = {
          ...(search === undefined ? {} : { web_search: search.bindingHash }),
          ...(fetchBinding === undefined ? {} : { web_fetch: fetchBinding }),
        };
      }
    }
    await store.call("routine.configure", {
      modelBindings,
      toolBindings,
      people,
      ownerEpoch: ownershipSessionId,
      workspaces: options.workspaces,
      toolPermissions: Object.fromEntries(tools.list().map((tool) => [tool.id, tool.requiredPermissions])),
      // Plugin reads a routine may research with: read-only, sink search or none, as the plugin's manifest declares.
      pluginReads: routinePluginReads(tools),
      // Every allowlisted destination on any external connection, whatever its channel.
      // A routine names its destination exactly, so a `providerId:*` entry grants none.
      destinations: externalConnectionsOf(channels).flatMap((connection, _index, connections) =>
        (options.messagingAllowedDestinations ?? []).flatMap((entry) => {
          const connectionIds = connections.map((candidate) => candidate.connectionId);
          const parsed = parseDestinationEntry(entry);
          if (parsed?.chatId === ANY_DESTINATION) return [];
          let chatId: string | undefined = entry;
          if (parsed?.connectionId === connection.connectionId) chatId = parsed.chatId;
          // A target for every channel, in this one's form; none where it is no target.
          if (parsed?.connectionId === ANY_DESTINATION) chatId = destinationChannels.targetOf(connection.connectionId, parsed.chatId);
          if (chatId === undefined) return [];
          return destinationAllowed(
            connection.connectionId,
            chatId,
            options.messagingAllowedDestinations ?? [],
            connectionIds,
            destinationChannels,
          )
            ? [{ workspaceId: connection.workspaceId, connectionId: connection.connectionId, chatId }]
            : [];
        }),
      ),
      // The builtin connections configured now (never the unconfigured `default` placeholder), and the plugins' models.
      providerConnectionIds: [
        ...builtinConnectionIds,
        ...options.workspaces.flatMap((workspace) => externalInstances.ids("model", workspace.workspaceId)),
      ],
      modelOverride: overrides.modelOverride !== undefined,
      executionAvailable: true,
      ...(options.inMemory === true ? {} : { dataDirectory: options.dataDirectory }),
      ...((models) => (models === undefined ? {} : { defaultModels: models }))(routineDefaultModels()),
      allowedHosts: options.httpAllowedHosts ?? [],
      renderer: (overrides.renderOverride ?? createOwnerRenderer()).capabilities(),
    });
    // What the worker now holds: a change in Allowed people is measured against it.
    for (const [workspaceId, sent] of Object.entries(people)) workerPeople.set(workspaceId, [...sent].sort().join("\u0000"));
  };
  /**
   * Why a routine cannot be evaluated (or run) on this owner, in words its
   * owner can act on, or `true`. The tools checked are the ones the routine's
   * own research permissions name — an open-web routine uses `web_fetch`, an
   * allowlisted one `http.request` — and every missing piece is named, not just
   * the first. The model and search configuration is read as it is now
   * (`liveRoutineModels`, `web_search` registered on the first provider):
   * adding either takes effect without a restart.
   */
  const routineSetup = (scope: RoutineScope, snapshot: RoutineSnapshot): true | string => {
    const problems: string[] = [];
    if (!access.actsIn(scope.workspaceId, scope.principalId)) problems.push("The routine's owner is no longer allowed in this workspace.");
    const checkLiveModels = overrides.modelOverride === undefined || liveModelTarget !== undefined;
    if (
      !hasModelTransport ||
      (options.modelTargetUnconfigured === true &&
        checkLiveModels &&
        late.liveRoutineModels.target === undefined &&
        late.liveRoutineModels.connectionIds.size === 0 &&
        externalInstances.ids("model", scope.workspaceId).length === 0)
    ) {
      problems.push("No model is configured. Set a default model in Settings → Models.");
    } else if (checkLiveModels) {
      for (const [role, policy] of [
        ["research", snapshot.models.research],
        ["synthesis", snapshot.models.synthesis],
      ] as const) {
        const reachable = [policy.primary, ...policy.fallbacks].some(
          (target) =>
            late.liveRoutineModels.connectionIds.has(target.connectionId) || externalInstances.hasModel(target.connectionId, scope),
        );
        if (!reachable)
          problems.push(
            `The ${role} model (${policy.primary.connectionId}/${policy.primary.model}) is not available on this owner. Configure that connection in Settings → Models, or create the routine again to use the current default model.`,
          );
      }
    }
    for (const tool of snapshot.permissions.researchTools) {
      if (tools.get(tool) !== undefined) continue;
      problems.push(
        tool === "web_search"
          ? "No web search provider is configured. Add one in Settings → Web search."
          : `The ${tool} tool this routine researches with is not available. Restart \`tavi serve\`; if it persists, check the owner's tool configuration.`,
      );
    }
    return problems.length === 0 ? true : problems.join(" ");
  };
  const routineEvaluation = new RoutineEvaluationService(routines, {
    models: modelAdapter,
    ownerEpoch: ownershipSessionId,
    now: () => clock.now(),
    ready: routineSetup,
  });
  const wakeRoutines = (): void => {
    if (routineWork.closed) return;
    // Evaluations run beside runs, not ahead of them: a quality check can take
    // many minutes of model calls and must not delay a scheduled run. The
    // evaluator has its own work queue, stopped and awaited at shutdown.
    void routineEvaluation.drain().catch((error) => logger.warn("Routine evaluation requires attention", { error }));
    void routineWork
      .run(async () => {
        await routineRuns.drain();
        if (routineWork.closed) return;
        await routineDelivery.drain();
      })
      .catch((error) => logger.warn("Routine background work requires attention", { error }));
  };
  // Plugins' report templates, installed as each plugin starts; a create or update copies its own into the revision.
  const routineTemplates = new RoutineTemplateRegistry();
  const routineControl = new RoutineControlService({
    routines,
    runs: routineRuns,
    news: routineNews,
    delivery: routineDelivery,
    publication: routinePublication,
    defaultModels: routineDefaultModels,
    allowedHosts: options.httpAllowedHosts ?? [],
    wake: wakeRoutines,
    // The same capability the pipeline branches on, so the readiness view and a
    // real render agree about whether a PDF can be produced.
    renderer: () => (overrides.renderOverride ?? createOwnerRenderer()).capabilities(),
    // A routine's pinned folder is checked as a chat's primary is, when it is created.
    checkFolder: (path) => chatFolders.checkPrimary(path),
    templateOf: (id) => routineTemplates.get(id),
  });
  // The workspace's zone as the routines and schedules tools read it: one cache, refreshed once per step for both.
  const workspaceZone = rememberedWorkspaceZone(persistencePort.repositories.workspaceSettings);
  registerRoutineTools(tools, routineControl, {
    workspaceTimezone: workspaceZone.zoneOf,
    workspaceTimezoneSync: workspaceZone.known,
    refreshWorkspaceTimezone: workspaceZone.refresh,
  });
  return {
    configureRoutineBindings,
    routineControl,
    routineTemplates,
    routineDelivery,
    routineEvaluation,
    routineNews,
    routinePublication,
    routineWork,
    routineWorkflow,
    wakeRoutines,
    workspaceZone,
  };
}

export type RoutinesContext = WorkflowContext & ReturnType<typeof composeRoutines>;
