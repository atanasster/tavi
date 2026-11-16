import { providerCredentialRevision } from "../features/models/credential-revision.js";
import { z } from "zod";
import { ownerRequestSigner } from "../features/browser/host.js";
import {
  type ProviderInstance,
  type ProviderExecutionOptions,
  ProviderBindings,
  scopedProvider,
  providerRevision,
  ModelAccounting,
  accountedModelPort,
  RouterRepository,
  RouterProviderSlot,
  createRouterGuard,
  ProviderFactoryRegistry,
  createChainedSecretStore,
  createEncryptedFileSecretStore,
  createSecretReader,
  describeSecretStore,
  registerFetchTool,
} from "@tavi/runtime";
import { externalProviderInstances } from "../features/plugins/provider-instances.js";
import {
  type RoutineSnapshot,
  type WebFetchProvider,
  keptModelRequests,
  RoutineNetworkModeSchema,
  type WebSearchProvider,
  TaviError,
  type InvocationContext,
  type ModelPort,
  PDF_LIMITS,
  isModelVisibleArtifact,
  type ModelTarget,
  ProviderFailureLog,
} from "@tavi/contracts";
import { fileURLToPath } from "node:url";
import { builtinImplementationHash, builtinModelResolver, liveProviderConnection } from "../features/models/provider-bindings.js";
import { onboardingTurnRecorder } from "../features/onboard/verification.js";
import { definedOnly } from "@tavi/contracts/util";
import { connectionLocality } from "@tavi/agent-host/task-summarizer";
import { createEmbeddingRole } from "../features/memory/embedding-role.js";
import { createAiSdkModelAdapter, type ProviderConnection } from "@tavi/agent-host/models";
import { join } from "node:path";
import { MAX_VIEW_IMAGE_BYTES, VIEWABLE_IMAGE_TYPES } from "../features/tools/assistant.js";
import { attendedVideoResolver } from "../features/video/tools.js";
import { createLocalCredentialStore, serializeCredentialAction } from "../features/credentials/store.js";
import { chatGptAwareResolver, revisionValue } from "../features/onboard/chatgpt.js";
import { createTaskRouting } from "../features/router/task-routing.js";
import { resolveLiveTarget } from "../features/models/target.js";
import { localChatRouter } from "../features/models/local-chats.js";
import { localityWrite, SettledMemo } from "../features/models/locality-memo.js";
import { ArtifactBodyCache, artifactBodyWrite } from "../features/models/artifact-body-cache.js";
import type { PluginsContext } from "./plugins.js";

/** Secrets and credentials, model accounting, the router and task routing, the model transport, fetch and embeddings. */
export async function composeModels(composed: PluginsContext) {
  const {
    access,
    clock,
    fetchSelection,
    hybridRef,
    late,
    logger,
    options,
    overrides,
    ownerSession,
    ownership,
    persistencePort,
    resolvedPlugins,
    store,
    tools,
    readMemos,
  } = composed;
  const configuredExternalModels =
    options.externalPlugins === "verify"
      ? []
      : resolvedPlugins.flatMap((plugin) =>
          plugin.ok
            ? plugin.instances
                .filter((instance) =>
                  plugin.record.manifest.capabilities.some(
                    (capability) => capability.id === instance.factory && capability.kind === "model",
                  ),
                )
                .map((instance) => ({ id: `${plugin.record.pluginId}.${instance.id}`, workspaceId: instance.workspaceId }))
            : [],
        );
  // A live target (`serve`'s) composes the model transport even with no
  // provider at startup — an owner started on an empty store — so the first
  // connection added over IPC is served from the next turn with no restart.
  // The calls themselves read
  // each connection as configured then (`liveProviderConnection`).
  const liveModelTarget = options.liveModelTarget;
  const hasModelTransport =
    options.providers.length > 0 ||
    overrides.modelOverride !== undefined ||
    configuredExternalModels.length > 0 ||
    liveModelTarget !== undefined;
  /**
   * What routines read of the live model configuration: the default
   * target as it resolves now, and the builtin connections configured now.
   * Read again by `configureRoutineBindingsNow` — at start, and after each
   * `models`, `credentials` or `search` write (`refreshProviders`) — so the
   * synchronous readers below (`routineDefaultModels`, `routineSetup`) never
   * read the startup configuration a write has since replaced.
   */
  late.liveRoutineModels = {
    connectionIds: new Set(
      options.providers
        .filter((provider) => options.modelTargetUnconfigured !== true || provider.connectionId !== options.defaultConnectionId)
        .map((provider) => provider.connectionId),
    ),
  };
  // What a routine may pin as its default research and synthesis model: the
  // live default target, else the owner's resolved target — unless that is
  // only the unconfigured placeholder (a test's fixture may stand behind it,
  // unless the target is live: then only a default configured since is pinned).
  const routineDefaultModels = (): RoutineSnapshot["models"] | undefined => {
    const startupTarget =
      options.modelTargetUnconfigured !== true || (overrides.modelOverride !== undefined && liveModelTarget === undefined);
    const target =
      late.liveRoutineModels.target ??
      (startupTarget ? { connectionId: options.defaultConnectionId, model: options.defaultModel } : undefined);
    return hasModelTransport && target !== undefined
      ? { research: { primary: { ...target }, fallbacks: [] }, synthesis: { primary: { ...target }, fallbacks: [] } }
      : undefined;
  };
  if (overrides.inspectCheckpoints === true && hasModelTransport)
    throw new TaviError("INVALID_INPUT", "Checkpoint inspection cannot run model workflows");
  const requireModelTransport = overrides.requireModelTransport ?? true;

  // `serve` composes with `requireModelTransport: false` (`serve.ts`), which
  // lets a caller pass `providers: []` and still start — an embedder, or a
  // future `--no-model` mode. `tavi serve` started with no model passes none
  // too, but always with a live target, so `hasModelTransport` is true
  // on every CLI path and this branch guards the embedding case. When it fires,
  // a messaging connector would silently record every inbound message
  // (`messagingInbox`) but never admit a turn — `messagingAdmitImpl` (below)
  // stays permanently `undefined` for this runtime's whole lifetime, and
  // nothing else in this file would otherwise signal that to an operator.

  // Credential resolution is a chain of explicitly configured sources, in
  // priority order: the service-manager credential directory injected for this
  // service identity, then the per-reference bindings the launcher declared.
  // A source that fails loudly stops the chain, so a misconfigured
  // binding never silently becomes a different credential.
  const secrets = createChainedSecretStore([
    // Absence of the injected directory is normal for a foreground CLI that
    // declares its binding explicitly, so it falls through; an unsafe directory
    // would still stop the chain. Encrypted at rest once `credentials.key`
    // exists; plain files stay readable.
    createEncryptedFileSecretStore({
      directory: join(options.dataDirectory, "credentials"),
      keyFile: join(options.dataDirectory, "credentials.key"),
      missingDirectory: "absent",
    }),
    createSecretReader({ bindings: options.credentials }),
  ]);
  late.secrets = secrets;
  const secretSource = describeSecretStore(secrets, "chain");
  // What a model call sends: a ChatGPT sign-in's stored token record answers its access token, renewed near
  // expiry and the rotated record stored first; any other credential is itself. Revisions read the record, not this.
  const localCredentials = createLocalCredentialStore(options.dataDirectory);
  const modelSecret = chatGptAwareResolver(
    (reference) => secrets.getSecret(reference),
    async (reference, value) => await localCredentials.setSecret(reference, value),
    // The whole renewal in the credential store's queue, as every write is.
    { serialize: async (work) => await serializeCredentialAction(options.dataDirectory, work) },
  );
  const credentialRevision = providerCredentialRevision(options.dataDirectory);
  // An unreadable secret is reported by the adapter that reads it; its binding revision is the absent one.
  // A ChatGPT sign-in's revision is its client and account, not its hourly tokens.
  const currentCredentialRevision = async (reference: string) =>
    credentialRevision(reference, revisionValue(await secrets.getSecret(reference).catch(() => null)));
  const modelAccounting = new ModelAccounting(store.asPort());
  if (ownership !== undefined) await modelAccounting.recoverPreviousOwner(ownerSession, clock.now());
  const routerRepository = new RouterRepository(store, (scope) => access.actsIn(scope.workspaceId, scope.principalId));
  if (ownership !== undefined) await routerRepository.recoverPreviousOwner(ownerSession, clock.now());
  // What a chat's locality is judged by, remembered between reads: a turn and each memory read it makes
  // ask it again. Each memo is dropped when a write that could change it settles on this store (a model
  // configuration write, a saved route, a run's recorded attempt), and by `forgetLocality` after a
  // `models`, `credentials` or `search` write (`refreshProviders`).
  const localityMemo = new SettledMemo<string, "local" | "remote" | undefined>();
  const defaultLocalMemo = new SettledMemo<string, boolean>();
  const routeMemo = new SettledMemo<string, { readonly principalId: string; readonly target: ModelTarget | undefined } | undefined>();
  const usedMemo = new SettledMemo<string, readonly string[]>();
  const forgetLocality = () => {
    localityMemo.clear();
    defaultLocalMemo.clear();
    routeMemo.clear();
    usedMemo.clear();
  };
  store.onSettled((operation, input) => {
    const write = localityWrite(operation, input);
    if (write === undefined) return;
    if (write.kind === "config") {
      localityMemo.clear();
      defaultLocalMemo.clear();
    } else if (write.kind === "routes") routeMemo.clear();
    else if (write.runId === undefined) usedMemo.clear();
    else usedMemo.delete(write.runId);
  });
  // The bodies of the images, documents and videos a model is sent, kept between steps (a run re-sends
  // each every step). The record is read again on every step — revoked, rejected, erased or hidden, it is
  // not sent — and an erasure, prune or review drops what was kept of the artifacts it touched.
  const artifactBodies = new ArtifactBodyCache();
  store.onSettled((operation, input) => {
    const write = artifactBodyWrite(operation, input);
    if (write === undefined) return;
    if (write.kind === "all") artifactBodies.clear();
    else artifactBodies.delete(write.artifactIds);
  });
  const artifactBody = async (artifact: { readonly artifactId: string; readonly sha256: string }) =>
    await artifactBodies.read(artifact, async () => await store.readArtifactBody(artifact.artifactId));
  // A connection's locality: the stored record first (it carries `localOnly`), then the startup configuration.
  const modelConnectionLocality = async (connectionId: string): Promise<"local" | "remote" | undefined> =>
    await localityMemo.read(connectionId, async () => {
      const stored = await persistencePort.repositories.modelConfig.getConnection(connectionId);
      if (stored !== undefined) return connectionLocality(stored);
      const configured = options.providers.find((provider) => provider.connectionId === connectionId);
      return configured === undefined ? undefined : connectionLocality(configured);
    });
  /** The model a chat keeps between turns (chosen, or saved by the router), when it has one. */
  const savedTarget = async (workspaceId: string, taskId: string): Promise<ModelTarget | undefined> => {
    const saved = await routeMemo.read(
      `${workspaceId}\u0000${taskId}`,
      async () => {
        const task = await persistencePort.repositories.tasks.get(taskId);
        if (task === undefined) return undefined;
        // A route that cannot be read is not guessed at: the failure reaches the callers, which treat unknown as local.
        const route = await routerRepository.route({ workspaceId, principalId: task.principalId }, taskId);
        return { principalId: task.principalId, target: route?.target };
      },
      // A chat not created yet is asked again: its route comes with it.
      (read) => read !== undefined,
    );
    if (saved === undefined) return undefined;
    // A remembered route is read under the access the router reads it under now.
    if (!access.actsIn(workspaceId, saved.principalId)) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return saved.target;
  };
  /** Whether an error resolving a workspace's `main` says only that it is not configured: an answer that may be remembered. */
  const unconfigured = (error: unknown) =>
    error instanceof TaviError && ["NOT_CONFIGURED", "CAPABILITY_MISSING", "NOT_FOUND"].includes(error.code);
  /**
   * The default chain a chat with no model of its own runs, resolved as the turn resolves it (`liveBaseline`),
   * and whether that chain is the configured one rather than a fallback taken because a read failed.
   */
  const readDefaultChain = async (workspaceId: string): Promise<{ readonly chain: readonly ModelTarget[]; readonly settled: boolean }> => {
    let settled = true;
    if (liveModelTarget !== undefined) {
      // A live target that no longer resolves is not used: the configured chain is.
      const resolved = await resolveLiveTarget(store.services.modelConfig, {
        workspaceId,
        connectionId: liveModelTarget.connectionId,
        model: liveModelTarget.model,
      }).catch(() => {
        settled = false;
        return undefined;
      });
      if (resolved !== undefined) return { chain: [resolved.target, ...resolved.fallback.map((entry) => entry.target)], settled };
    } else {
      // An owner with no live target: the workspace's `main` as configured, which a one-shot run is started on.
      const main = await store.services.modelConfig.resolveRole({ workspaceId, role: "main" }).catch((error: unknown) => {
        if (!unconfigured(error)) settled = false;
        return undefined;
      });
      if (main !== undefined)
        return {
          chain: [
            main.target,
            ...((await persistencePort.repositories.modelConfig.listRoleBindings(workspaceId)).find((binding) => binding.role === "main")
              ?.fallback ?? []),
          ],
          settled,
        };
    }
    return {
      chain: [{ connectionId: options.defaultConnectionId, model: options.defaultModel }, ...(options.modelFallback ?? [])],
      settled,
    };
  };
  const defaultChain = async (workspaceId: string): Promise<readonly ModelTarget[]> => (await readDefaultChain(workspaceId)).chain;
  const isLocalTarget = async (target: ModelTarget | undefined): Promise<boolean> =>
    target !== undefined && (await modelConnectionLocality(target.connectionId)) === "local";
  /** Whether a chat with no model of its own starts on a local connection. */
  const defaultIsLocal = async (workspaceId: string): Promise<boolean> => {
    let settled = true;
    return await defaultLocalMemo.read(
      workspaceId,
      async () => {
        const read = await readDefaultChain(workspaceId);
        settled = read.settled;
        return await isLocalTarget(read.chain[0]);
      },
      // The answer of a chain read past a failure is not remembered: the next read asks again.
      () => settled,
    );
  };
  /**
   * Whether a chat's model is a local one now: its own when it has one, else
   * the default it starts on. Only such a chat recalls what local chats wrote.
   */
  const chatRunsLocal = async (workspaceId: string, taskId: string): Promise<boolean> => {
    const saved = taskId === "" ? undefined : await savedTarget(workspaceId, taskId);
    return saved === undefined ? await defaultIsLocal(workspaceId) : await isLocalTarget(saved);
  };
  /** Chats found local: once local, a chat stays local. */
  const localChats = new Set<string>();
  /**
   * Whether a chat used a local connection, or runs on one: its words, and
   * what it produced, stay off remote models (invariant 14, and the router, the
   * browser's model roles and memory's provenance). One never called on any
   * is judged by the model it starts on.
   */
  const chatIsLocal = async (workspaceId: string, taskId: string): Promise<boolean> => {
    if (localChats.has(taskId)) return true;
    return await judgeChat(workspaceId, taskId, await usedMemo.read(taskId, async () => await modelAccounting.usedConnections(taskId)));
  };
  /** `chatIsLocal` past its remembered answer, given the connections the chat's calls went to. */
  const judgeChat = async (workspaceId: string, taskId: string, used: readonly string[]): Promise<boolean> => {
    const local = await (async () => {
      if ((await Promise.all(used.map(modelConnectionLocality))).some((locality) => locality === "local")) return true;
      const saved = await savedTarget(workspaceId, taskId);
      if (saved !== undefined) return await isLocalTarget(saved);
      return used.length > 0 ? false : await defaultIsLocal(workspaceId);
    })();
    // Only what a chat did is remembered: a chat judged by the default it would start on may yet start elsewhere.
    if (local && used.length > 0) localChats.add(taskId);
    return local;
  };
  /**
   * Which of `taskIds` are local chats (`chatIsLocal`), asked together; one that cannot be judged is local.
   * The connections of the chats not remembered are read in one worker request, not one per chat; when
   * that read fails, none of them is remembered and each answers local.
   */
  const chatsAreLocal = async (workspaceId: string, taskIds: readonly string[]): Promise<ReadonlyMap<string, boolean>> => {
    const asked = [...new Set(taskIds)];
    const used = await usedMemo
      .readMany(
        asked.filter((taskId) => !localChats.has(taskId)),
        async (missing) => new Map((await modelAccounting.usedConnectionsOf(missing)).map((entry) => [entry.runId, entry.connections])),
      )
      .catch(() => undefined);
    return new Map(
      await Promise.all(
        asked.map(async (taskId) => {
          if (localChats.has(taskId)) return [taskId, true] as const;
          const connections = used?.get(taskId);
          const local = connections === undefined ? true : await judgeChat(workspaceId, taskId, connections).catch(() => true);
          return [taskId, local] as const;
        }),
      ),
    );
  };
  /**
   * The local model a local chat goes on with: its own when that is local,
   * else the first local one of the default chain; undefined when there is none.
   */
  const localTargetOf = async (workspaceId: string, taskId: string): Promise<ModelTarget | undefined> => {
    const saved = await savedTarget(workspaceId, taskId);
    if (await isLocalTarget(saved)) return saved;
    for (const target of await defaultChain(workspaceId)) if (await isLocalTarget(target)) return target;
    return undefined;
  };
  /** The workspace's `fast` model when it is a local one. */
  const localFast = async (workspaceId: string): Promise<ModelTarget | undefined> => {
    const fast = (await persistencePort.repositories.modelConfig.listRoleBindings(workspaceId)).find(
      (binding) => binding.role === "fast",
    )?.target;
    return (await isLocalTarget(fast)) ? fast : undefined;
  };
  /**
   * The model an idea's work starts on when Ideas read local chats and records
   * (their `fast` model is local): the default when it is local, else that
   * `fast` model. Undefined when Ideas run on a remote model, reading neither.
   */
  const ideaModel = async (workspaceId: string): Promise<ModelTarget | undefined> => {
    const fast = await localFast(workspaceId);
    if (fast === undefined) return undefined;
    const first = (await defaultChain(workspaceId))[0];
    return first !== undefined && (await isLocalTarget(first)) ? first : fast;
  };
  const localChatModels = {
    isLocal: chatIsLocal,
    areLocal: chatsAreLocal,
    runsLocal: chatRunsLocal,
    locality: modelConnectionLocality,
    localTargetOf,
    localFast,
    defaultIsLocal,
    ideaModel,
  };
  // Routing providers run behind the host guard, which owns consent, budgets and receipts.
  // A local chat's decisions never reach a provider: they answer "egress" at once.
  const routerProviders = new RouterProviderSlot();
  const router = localChatRouter(
    createRouterGuard({ repository: routerRepository, accounting: modelAccounting, slot: routerProviders }),
    async (scope, taskId) => await chatIsLocal(scope.workspaceId, taskId),
  );
  const removeManagedConnection = async (connectionId: string) => {
    const repository = persistencePort.repositories.modelConfig;
    if ((await repository.getConnection(connectionId))?.providerBinding === undefined) return;
    await repository.replaceCatalog(connectionId, []);
    await repository.deleteConnection(connectionId);
  };
  // A provider-managed connection lives only as long as its configured instance.
  if (ownership !== undefined && options.externalPlugins !== "verify") {
    for (const stale of await persistencePort.repositories.modelConfig.listConnections()) {
      if (stale.providerBinding !== undefined && !configuredExternalModels.some((instance) => instance.id === stale.connectionId))
        await removeManagedConnection(stale.connectionId);
    }
  }
  const storedModelConnections = await persistencePort.repositories.modelConfig.listConnections();
  if (
    options.providers.some((provider) =>
      storedModelConnections.some((stored) => stored.connectionId === provider.connectionId && stored.providerBinding !== undefined),
    )
  )
    throw new TaviError("CONFLICT", "A provider-managed connection cannot be configured as a builtin transport");
  const routingConnections = [
    ...options.providers,
    ...storedModelConnections
      .filter(
        (entry) =>
          entry.providerBinding === undefined && !options.providers.some((provider) => provider.connectionId === entry.connectionId),
      )
      .map(({ headers, ...connection }) => ({ ...connection, ...(headers === undefined ? {} : { headers }) })),
  ];
  const liveConnection = liveProviderConnection({
    launched: options.providers,
    storedAtStartup: new Set(storedModelConnections.map((connection) => connection.connectionId)),
    stored: async (connectionId) => await persistencePort.repositories.modelConfig.getConnection(connectionId),
  });
  const taskRouting = await createTaskRouting({
    router,
    repository: routerRepository,
    models: persistencePort.repositories.modelConfig,
    connection: liveConnection,
    baseline: { connectionId: options.defaultConnectionId, model: options.defaultModel },
    fallback: options.modelFallback ?? [],
    ...(liveModelTarget === undefined
      ? {}
      : {
          liveBaseline: async (scope) => {
            const resolved = await resolveLiveTarget(store.services.modelConfig, {
              workspaceId: scope.workspaceId,
              connectionId: liveModelTarget.connectionId,
              model: liveModelTarget.model,
            });
            return resolved === undefined ? undefined : [resolved.target, ...resolved.fallback.map((entry) => entry.target)];
          },
        }),
    providerTarget: async (target, scope) => {
      if (
        !configuredExternalModels.some((instance) => instance.id === target.connectionId) &&
        !storedModelConnections.some(
          (connection) => connection.connectionId === target.connectionId && connection.providerBinding !== undefined,
        )
      )
        return undefined;
      if (!externalInstances.hasModel(target.connectionId, scope)) return false;
      const entry = (await persistencePort.repositories.modelConfig.listCatalog(target.connectionId)).find(
        (model) => model.modelId === target.model,
      );
      return entry !== undefined && entry.state !== "unavailable";
    },
    readSecret: (reference) => secrets.getSecret(reference),
    price: (target, at) => modelAccounting.price(target.connectionId, target.model, at),
    now: () => clock.now(),
    // A chain that starts on a local connection keeps only its local fallbacks, and never asks the router;
    // a chat that ran locally never moves onto a remote default.
    locality: modelConnectionLocality,
    chatIsLocal: async (scope, taskId) => await chatIsLocal(scope.workspaceId, taskId),
  });
  /**
   * The default target as configured now in `workspaceId`, or
   * `undefined` when there is no live target or nothing usable resolves.
   */
  const resolveLiveDefault = async (workspaceId: string): Promise<ModelTarget | undefined> => {
    if (liveModelTarget === undefined) return undefined;
    // A live target that no longer resolves is not used: the configured chain is.
    const resolved = await resolveLiveTarget(store.services.modelConfig, {
      workspaceId,
      connectionId: liveModelTarget.connectionId,
      model: liveModelTarget.model,
    }).catch(() => undefined);
    return resolved?.target;
  };
  /**
   * Whether a turn in `workspaceId` has a model to run on now: always
   * on an owner that started with one; on one started with none, once a
   * default resolves from what was configured since. Reminders' tasks and
   * channel admissions read it before admitting, so neither starts a turn
   * against the unconfigured placeholder.
   */
  const liveModelReady = async (workspaceId: string): Promise<boolean> => {
    if (!hasModelTransport) return false;
    if (options.modelTargetUnconfigured !== true) return true;
    if (liveModelTarget === undefined) return overrides.modelOverride !== undefined;
    return (await resolveLiveDefault(workspaceId)) !== undefined;
  };
  /**
   * The builtin connections configured now: the ones launched (never the
   * unconfigured placeholder) and every stored one that is not
   * provider-managed — what `routingConnections` was at startup, read again
   * so a connection added since gets routine bindings.
   */
  const liveBuiltinConnectionIds = async (): Promise<readonly string[]> => {
    const launched = options.providers
      .filter((provider) => options.modelTargetUnconfigured !== true || provider.connectionId !== options.defaultConnectionId)
      .map((provider) => provider.connectionId);
    const stored = (await persistencePort.repositories.modelConfig.listConnections())
      .filter((entry) => entry.providerBinding === undefined)
      .map((entry) => entry.connectionId);
    return [...new Set([...launched, ...stored])];
  };
  const providerLifetime = new AbortController();
  const fetchExecution: ProviderExecutionOptions = {
    ownerSession,
    ledger: modelAccounting,
    signal: providerLifetime.signal,
    implementationHash: builtinImplementationHash(fileURLToPath(import.meta.resolve("@tavi/runtime"))),
    actsIn: (workspaceId, principalId) => access.actsIn(workspaceId, principalId),
  };
  late.fetchExecution = fetchExecution;
  // The AI SDK adapter, unless a fixture stands in for it: only it can send on one pinned connection.
  const modelTransport =
    overrides.modelOverride !== undefined
      ? { fixture: overrides.modelOverride }
      : {
          adapter: createAiSdkModelAdapter({
            connections: routingConnections,
            connection: liveConnection,
            readSecret: modelSecret,
            // The workflow's clock, which keeps the `Retry-After` waits.
            now: () => Date.parse(clock.now()),
            // `artifacts.view_image`'s reference, resolved for the model that reads
            // it: an approved image, never more than the tool itself allows.
            resolveMedia: async (artifactId) => {
              const artifact = await store.getArtifact(artifactId);
              if (
                artifact === undefined ||
                !isModelVisibleArtifact(artifact) ||
                artifact.reviewState !== "approved" ||
                !VIEWABLE_IMAGE_TYPES.test(artifact.contentType) ||
                artifact.byteSize > MAX_VIEW_IMAGE_BYTES
              )
                return undefined;
              const data = await artifactBody(artifact);
              return data === undefined ? undefined : { mediaType: artifact.contentType, data };
            },
            // `pdf.view`'s document, for a connection that takes PDFs: an approved,
            // model-visible PDF within `pdf.view`'s cap (under the provider's request size), its record read again here on every step.
            resolveDocument: async (artifactId) => {
              const artifact = await store.getArtifact(artifactId);
              if (
                artifact === undefined ||
                !isModelVisibleArtifact(artifact) ||
                artifact.reviewState !== "approved" ||
                artifact.contentType !== "application/pdf" ||
                artifact.byteSize > PDF_LIMITS.viewMaxBytes
              )
                return undefined;
              const data = await artifactBody(artifact);
              return data === undefined ? undefined : { mediaType: "application/pdf", data };
            },
            // A whole video, only for a run a person attends: a task this store
            // knows, started at a terminal, in the canvas or in a chat on a channel. Anything else — a heartbeat, a schedule,
            // a reminder, an agent, an id that is no task — gets the frames: no per-run cost cap guards a clip.
            resolveVideo: attendedVideoResolver({
              task: async (runId) => persistencePort.repositories.tasks.get(runId),
              artifact: async (artifactId) => store.getArtifact(artifactId),
              body: async (_artifactId, artifact) => await artifactBody(artifact),
            }),
          }),
        };
  const aiSdkAdapter = "adapter" in modelTransport ? modelTransport.adapter : undefined;
  const rawModelAdapter: ModelPort = "adapter" in modelTransport ? modelTransport.adapter : modelTransport.fixture;
  const resolveConfiguredModel = builtinModelResolver({
    models: rawModelAdapter,
    ...(aiSdkAdapter === undefined ? {} : { pin: (connection: ProviderConnection) => aiSdkAdapter.pinned(connection) }),
    implementationHash: builtinImplementationHash(fileURLToPath(import.meta.resolve("@tavi/agent-host/models"))),
    signal: providerLifetime.signal,
    actsIn: (workspaceId, principalId) => access.actsIn(workspaceId, principalId),
    current: liveConnection,
    credentialRevision: currentCredentialRevision,
  });
  const providerRegistries = {
    search: { factories: new ProviderFactoryRegistry<WebSearchProvider>(), bindings: new ProviderBindings<WebSearchProvider>() },
    fetch: { factories: new ProviderFactoryRegistry<WebFetchProvider>(), bindings: new ProviderBindings<WebFetchProvider>() },
    model: {
      factories: new ProviderFactoryRegistry<import("@tavi/contracts").LanguageModelProvider>(),
      bindings: new ProviderBindings<ModelPort>(),
    },
  };
  const fetchInstances = new Map<string, Promise<ProviderInstance<WebFetchProvider>>>();
  const fetchSettings = z.object({
    networkMode: RoutineNetworkModeSchema,
    allowedHosts: z.array(z.string()),
    maxBytes: z.number().optional(),
    maxDecodedBytes: z.number().optional(),
    timeoutMs: z.number().optional(),
  });
  late.builtinFetchResolver = async (policy, context) => {
    if (late.builtinFetchScope === undefined) throw new TaviError("UNAVAILABLE", "Fetch factory is not ready");
    const settings = {
      networkMode: policy.networkMode,
      allowedHosts: policy.allowedHosts ?? [],
      ...definedOnly({ maxBytes: policy.maxBytes, maxDecodedBytes: policy.maxDecodedBytes, timeoutMs: policy.timeoutMs }),
    };
    const instanceId = `builtin:fetch:${providerRevision({ workspaceId: context.workspaceId, settings })}`;
    let instance = fetchInstances.get(instanceId);
    if (instance === undefined) {
      if (fetchInstances.size >= 128)
        throw new TaviError("UNAVAILABLE", "Fetch policy instance limit reached; restart to release inactive policies");
      instance = providerRegistries.fetch.factories.create("tavi.fetch.http", {
        instanceId,
        settings,
        credentials: {},
        readSecret: async () => null,
        owner: late.builtinFetchScope,
      });
      fetchInstances.set(instanceId, instance);
      void instance.catch(() => {
        if (fetchInstances.get(instanceId) === instance) fetchInstances.delete(instanceId);
      });
    }
    const owned = await instance;
    const resolved = scopedProvider(
      fetchExecution,
      context,
      { kind: "fetch", instanceId, accountId: "anonymous", endpoint: "in-process", configRevision: providerRevision(settings) },
      owned.get(),
    );
    return [
      {
        id: "builtin:public-fetch",
        resolved: { ...resolved, signal: AbortSignal.any([resolved.signal, owned.signal]), get: () => owned.get() },
      },
      ...externalInstances.ids("fetch", context.workspaceId).map((id) => ({ id, resolved: externalInstances.resolveFetch(id, context) })),
    ];
  };
  // Opt-in signed agent identity (RFC 9421, `TAVI_AGENT_SIGNATURE_*`): the same key the browser's documents carry.
  const signRequest = ownerRequestSigner();
  registerFetchTool(tools, {
    ...(signRequest === undefined ? {} : { signRequest }),
    execution: fetchExecution,
    provider: late.builtinFetchResolver,
    selection: fetchSelection,
    enabled: true,
    networkMode: "custom_hosts",
    allowedHosts: options.httpAllowedHosts ?? [],
  });
  const externalInstances = externalProviderInstances(providerRegistries, {
    principalFor: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
    actsIn: (workspaceId, principalId) => access.actsIn(workspaceId, principalId),
    readSecret: (reference) => secrets.getSecret(reference),
    credentialRevision,
    publishModel: async (connection, catalog) => {
      const repository = persistencePort.repositories.modelConfig;
      const previous = await repository.getConnection(connection.connectionId);
      if (previous !== undefined && previous.providerBinding === undefined)
        throw new TaviError("CONFLICT", "Provider instance collides with a model connection");
      await repository.upsertConnection({ ...connection, createdAt: previous?.createdAt ?? connection.createdAt });
      await repository.replaceCatalog(connection.connectionId, catalog);
    },
    unpublishModel: removeManagedConnection,
  });
  if (configuredExternalModels.some((instance) => routingConnections.some((connection) => connection.connectionId === instance.id))) {
    throw new TaviError("CONFLICT", "External model instance ID collides with a builtin connection");
  }
  const fixtureModel = overrides.modelOverride;
  const resolveBuiltinModel =
    fixtureModel === undefined || routingConnections.length > 0 || liveModelTarget !== undefined
      ? resolveConfiguredModel
      : async (_request: { connectionId: string; model: string }, context: InvocationContext) =>
          scopedProvider(
            { ...fetchExecution, implementationHash: providerRevision({ fixture: fixtureModel.stream.toString() }) },
            context,
            {
              kind: "model",
              instanceId: "in-process-fixture",
              accountId: "fixture",
              endpoint: "in-process",
              configRevision: providerRevision({ kind: "in-process-fixture" }),
            },
            fixtureModel,
          );
  const resolveModelBinding = async (request: { connectionId: string; model: string }, context: InvocationContext) =>
    configuredExternalModels.some((instance) => instance.id === request.connectionId)
      ? externalInstances.resolveModel(request.connectionId, context)
      : resolveBuiltinModel(request, context);
  // A real turn on a default target verifies or fails the model for onboarding, after the call and never in its way.
  const onboardingTurns = onboardingTurnRecorder({
    repositories: persistencePort.repositories,
    modelConfig: store.services.modelConfig,
    credentialRevision: currentCredentialRevision,
    now: () => new Date(clock.now()),
    warn: (message, fields) => logger.warn(message, fields),
  });
  // What each task's generation calls came to, so a scheduled run that failed on provider weather is tried again.
  const providerFailures = new ProviderFailureLog();
  const modelAdapter = accountedModelPort(rawModelAdapter, modelAccounting, {
    ownerSession,
    now: () => clock.now(),
    resolve: resolveModelBinding,
    onSettled: (settled) => {
      onboardingTurns.record(settled);
      if (settled.context !== undefined && settled.purpose === "generation")
        providerFailures.note(settled.context.runId, "model", settled.status === "completed" ? "ok" : settled.failure);
      // A scheduled run's tokens count on its budget, so one past its schedule's ceiling is stopped.
      if (settled.context !== undefined && settled.usage !== undefined)
        late.scheduleDependencies?.inFlight?.chargeTokens(
          settled.context.runId,
          settled.usage.totalTokens ?? (settled.usage.inputTokens ?? 0) + (settled.usage.outputTokens ?? 0),
        );
    },
    authorize: async (context) => {
      const refusal = access.authorize(context, ["models.invoke"]);
      if (refusal !== undefined) throw refusal;
    },
    // A task keeps the whole request of only its newest calls: the workspace's `models.keptRequests`.
    keptRequests: async (context) =>
      keptModelRequests(context === undefined ? {} : (await readMemos.workspaceSettings.get(context.workspaceId)).settings),
  });
  // The `embedding` role, looked up with its locality and called through the accounted port.
  const embeddings = createEmbeddingRole({
    modelConfig: store.services.modelConfig,
    models: modelAdapter,
    newId: () => clock.newId("attempt"),
  });
  hybridRef.current = {
    embeddings,
    chatIsLocal,
    chatRunsLocal: async (actor) => await chatRunsLocal(actor.workspaceId, actor.chatTaskId ?? actor.runId ?? ""),
  };
  return {
    currentCredentialRevision,
    embeddings,
    externalInstances,
    fetchExecution,
    fetchInstances,
    fetchSettings,
    fixtureModel,
    hasModelTransport,
    liveBuiltinConnectionIds,
    liveModelReady,
    liveModelTarget,
    modelAccounting,
    modelAdapter,
    providerFailures,
    modelConnectionLocality,
    chatIsLocal,
    chatsAreLocal,
    chatRunsLocal,
    forgetLocality,
    localChatModels,
    modelSecret,
    onboardingTurns,
    providerLifetime,
    providerRegistries,
    requireModelTransport,
    resolveLiveDefault,
    resolveModelBinding,
    router,
    routerProviders,
    routerRepository,
    routineDefaultModels,
    routingConnections,
    secretSource,
    secrets,
    taskRouting,
  };
}

export type ModelsContext = PluginsContext & Awaited<ReturnType<typeof composeModels>>;
