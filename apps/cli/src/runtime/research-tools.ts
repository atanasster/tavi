import { fileURLToPath } from "node:url";
import { SkillService, providerRevision } from "@tavi/runtime";
import { nowTimestamp } from "@tavi/contracts/util";
import { builtinImplementationHash } from "../features/models/provider-bindings.js";
import {
  type WebSearchProvider,
  TaviError,
  type SearchProviderConfig,
  refusedEarly,
  skillSuggestionsOn,
  videoToolsOn,
  englishOf,
  navPath,
} from "@tavi/contracts";
import { createOwnerRenderer } from "../features/browser/host.js";
import { registerAssistantTools } from "../features/tools/assistant.js";
import { registerMathTool } from "../features/tools/math.js";
import { registerSkillProposeTool } from "../features/skills/propose.js";
import { registerSkillTools } from "../features/skills/tools.js";
import {
  folderFileCheck,
  folderFileLabel,
  folderFileReader,
  folderFileTaint,
  folderSaver,
  fsRootResolver,
} from "../features/folders/fs-tools.js";
import { registerAuthoringTools } from "../features/plugins/authoring-tools.js";
import { COLLECTORS_PLUGIN_ID, registerOwnerCollectorTools } from "../features/collectors/host.js";
import { registerHttpTools } from "../features/http/tools.js";
import { WEB_SEARCH_ENDPOINTS, registerWebSearchTool, searchKeyProblem } from "../features/search/web-search.js";
import { withoutLocalChats } from "../features/models/local-chats.js";
import type { HostsContext } from "./hosts.js";

/** The authoring, assistant and HTTP tools, web search, the collectors and the report tools. */
export async function composeResearchTools(composed: HostsContext) {
  const {
    access,
    builtinPluginIds,
    disabledBuiltins,
    localChatModels,
    chatFolders,
    clock,
    currentCredentialRevision,
    externalInstances,
    fetchExecution,
    fsToolOptions,
    logger,
    materializeArtifact,
    options,
    overrides,
    persistencePort,
    providerLifetime,
    providerRegistries,
    sandbox,
    secrets,
    store,
    tools,
    videoOffered,
    webProviders,
  } = composed;
  // The plugin-authoring skill: its guide, and a check of a folder in the calling chat's folders.
  registerAuthoringTools(tools, {
    resolve: fsRootResolver(fsToolOptions),
    checkFile: folderFileCheck(fsToolOptions),
    validate: { builtins: builtinPluginIds, sandbox },
  });
  const readFolderFile = folderFileReader(fsToolOptions);
  const folderTaint = folderFileTaint(fsToolOptions);
  registerAssistantTools(tools, {
    // A picture in the chat's folders, as fs.read reads it and with the label it would give it.
    folderPicture: async (path, context, maxBytes) => {
      const file = readFolderFile(path, context, maxBytes);
      return {
        bytes: new Uint8Array(file.bytes),
        name: file.name,
        label: folderFileLabel(file, await folderTaint(file, context), context, nowTimestamp()),
      };
    },
    // A chat on a remote model finds no local chat's words.
    searchHistory: async ({ readerTaskId, ...input }) =>
      await withoutLocalChats(await store.searchTaskHistory(input), localChatModels, input.workspaceId, readerTaskId),
    artifacts: store,
    // An animated GIF goes to video.frames where it can read it; else it is seen as an image.
    videoFramesAvailable: async (workspaceId) =>
      videoOffered && videoToolsOn((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings),
  });
  // An approved skill's body, loaded when it applies: the context lists them by name.
  registerSkillTools(tools, {
    skills: persistencePort.repositories.skills,
    rollout: persistencePort.repositories.skillRollout,
    artifacts: store,
    warn: (message, fields) => logger.warn(message, fields),
  });
  // A procedure the agent carried out, offered as a skill: it always waits for the person's review.
  registerSkillProposeTool(tools, {
    service: new SkillService(persistencePort),
    skills: persistencePort.repositories.skills,
    tasks: persistencePort.repositories.tasks,
    now: nowTimestamp,
    suggestionsOff: async (workspaceId) =>
      !skillSuggestionsOn((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings),
  });
  // A calculator and date arithmetic: read-only, no sandbox, so it never asks.
  registerMathTool(tools);
  registerHttpTools(tools, {
    secretReader: secrets,
    allowedHosts: options.httpAllowedHosts ?? [],
    // `saveTo`: a new file of the calling chat's folder, held as `fs.write` holds one.
    saver: folderSaver(fsToolOptions),
    ...(options.httpAllowedRequestHeaders === undefined ? {} : { extraAllowedRequestHeaders: options.httpAllowedRequestHeaders }),
    ...(options.httpCredentialHosts === undefined ? {} : { credentialHosts: options.httpCredentialHosts }),
  });
  // Provider objects activate at startup; disable/remove is checked on each call.
  // A malformed stored row is reported once and excluded.
  const unreadableSearchProviders = (await persistencePort.repositories.searchProviders.list()).unreadable;
  for (const providerId of unreadableSearchProviders) {
    logger.warn("a configured search provider could not be read and is not used", { providerId });
  }
  // A provider whose key breaks the rule — stored before it, or whose
  // key a model connection or the launcher took since — is not asked: asking it
  // would send that key to its endpoint. Said once per composition, re-checked
  // on every call.
  const launcherBindings = [...Object.keys(options.credentials), ...Object.keys(options.httpCredentialHosts ?? {})];
  const warnedKeys = new Set<string>();
  const keyAllowed = async (provider: SearchProviderConfig, all: readonly SearchProviderConfig[]): Promise<boolean> => {
    if (provider.credentialRef === undefined) return true;
    const problem = searchKeyProblem(
      {
        connections: [...(await persistencePort.repositories.modelConfig.listConnections()), ...options.providers],
        launcherBindings,
        providers: all.filter((other) => other.providerId !== provider.providerId),
      },
      provider.kind,
      provider.credentialRef,
    );
    if (problem !== undefined && !warnedKeys.has(provider.providerId)) {
      warnedKeys.add(provider.providerId);
      logger.warn("a search provider's key is not its own; web_search does not ask it", { providerId: provider.providerId, problem });
    }
    return problem === undefined;
  };
  const searchImplementationHash = builtinImplementationHash(fileURLToPath(import.meta.url));
  const searchConfigurations = new WeakMap<WebSearchProvider, SearchProviderConfig>();
  const builtinSearchIds = new Map<string, Map<string, string>>();
  /** Each built-in search instance's provider revision, by instance id: one is made again only for a provider changed since. */
  const builtinSearchRevisions = new Map<string, string>();
  const searchExecution = { ...fetchExecution, implementationHash: searchImplementationHash };
  // Offered once an available provider exists: at start, and again after each
  // search or credentials write (`refreshProviders`), so the first
  // provider added to a running owner reaches the next turn with no restart.
  // Registered once; the providers are read again at every call.
  const registerSearch = async (): Promise<void> => {
    if (tools.get("web_search") !== undefined) return;
    await registerWebSearchTool(
      tools,
      async (context) => {
        providerLifetime.signal.throwIfAborted();
        const all = (await persistencePort.repositories.searchProviders.list()).providers;
        const eligible: WebSearchProvider[] = [];
        const workspace = context ?? options.workspaces[0];
        // The workspace's own providers are bound to its principal; a person allowed there is served by them too (see `resolve`).
        const owner = workspace === undefined ? undefined : access.resolveWorkspace(workspace.workspaceId)?.principalId;
        if (context !== undefined && !access.actsIn(context.workspaceId, context.principalId))
          throw new TaviError("NOT_AUTHORIZED", "Provider account belongs to another workspace or principal");
        if (workspace !== undefined && owner !== undefined)
          for (const provider of all)
            if (provider.enabled && (await keyAllowed(provider, all))) {
              const id = builtinSearchIds.get(workspace.workspaceId)?.get(provider.providerId);
              if (id !== undefined)
                eligible.push(
                  providerRegistries.search.bindings.resolve({ workspaceId: workspace.workspaceId, principalId: owner }, id).get(),
                );
            }
        if (context !== undefined)
          for (const id of externalInstances.ids("search", context.workspaceId))
            eligible.push(externalInstances.resolveSearch(id, context).get());
        else {
          // Registration checks availability; actual resolution always receives authenticated context.
          const workspace = options.workspaces.find((workspace) => externalInstances.ids("search", workspace.workspaceId).length > 0);
          if (workspace !== undefined)
            for (const id of externalInstances.ids("search", workspace.workspaceId))
              eligible.push(externalInstances.resolveSearch(id, { ...workspace, runId: "registration", caller: "owner" }).get());
        }
        return eligible;
      },
      {
        ...searchExecution,
        selection: (context) => webProviders.workspaces[context.workspaceId]?.search,
        // `web_fetch` is offered only with hosts to fetch (`--http-allow-host`): the description names it only then.
        fetchOffered: (options.httpAllowedHosts?.length ?? 0) > 0,
        resolve: async (provider, context) => {
          for (const id of externalInstances.ids("search", context.workspaceId)) {
            const resolved = externalInstances.resolveSearch(id, context);
            if (resolved.get() === provider) return { ...resolved, selectionId: id };
          }
          const all = (await persistencePort.repositories.searchProviders.list()).providers;
          const config = all.find((config) => config.providerId === provider.id && config.enabled);
          if (
            config === undefined ||
            searchConfigurations.get(provider) === undefined ||
            providerRevision(config) !== providerRevision(searchConfigurations.get(provider)) ||
            !(await keyAllowed(config, all))
          )
            throw new TaviError("NOT_AUTHORIZED", "Search provider was disabled or its credential binding changed");
          const endpoint = config.kind === "searxng" ? config.baseUrl : WEB_SEARCH_ENDPOINTS[config.kind];
          if (endpoint === undefined) throw refusedEarly("NOT_CONFIGURED", "Search endpoint is missing");
          const id = builtinSearchIds.get(context.workspaceId)?.get(config.providerId);
          if (id === undefined)
            throw new TaviError(
              "UNAVAILABLE",
              `Search provider is not active on this owner yet; save it again with \`tavi search enable\` or ${englishOf(navPath("nav.route.settings", "nav.settings.search"))}`,
            );
          // A workspace's search provider serves everyone who acts in it — its principal and each person allowed there —
          // as its built-in model and fetch do: resolved as the workspace's own instance, bound to the caller.
          const owner = access.resolveWorkspace(context.workspaceId)?.principalId;
          if (owner === undefined || !access.actsIn(context.workspaceId, context.principalId))
            throw new TaviError("NOT_AUTHORIZED", "Provider account belongs to another workspace or principal");
          const resolved = providerRegistries.search.bindings.resolve({ workspaceId: context.workspaceId, principalId: owner }, id);
          // The key is read per call, so the secret behind its reference is part of the binding.
          const credential = config.credentialRef === undefined ? undefined : await currentCredentialRevision(config.credentialRef);
          const binding = Object.freeze({
            ...resolved.binding,
            principalId: context.principalId,
            ...(credential === undefined ? {} : { configRevision: providerRevision({ config, credentialRevision: credential }) }),
          });
          return {
            ...resolved,
            binding,
            bindingHash: providerRevision(binding),
            signal: AbortSignal.any([resolved.signal, providerLifetime.signal]),
          };
        },
      },
    );
  };
  // The daily brief's tools (`tavi.collectors`), left out while it is disabled. The deterministic collectors:
  // fixed provider endpoints, `read-only` so an unattended run never raises an approval interrupt, and per-source
  // isolation so one dead credential costs a section, not the report. Then the brief's rendering step: the PDF
  // becomes an `approved` artifact, never a tool result — it is already past the 64 KiB gate the moment it exists.
  if (!disabledBuiltins.has(COLLECTORS_PLUGIN_ID))
    registerOwnerCollectorTools(
      tools,
      {
        dataDirectory: options.dataDirectory,
        secretReader: secrets,
        // The registry is the authority for which projects exist;
        // `<dataDir>/projects.json` is now only an import source.
        projects: persistencePort.repositories.projects,
      },
      {
        projects: persistencePort.repositories.projects,
        // Generated-report history.
        reports: persistencePort.repositories.reports,
        nowIso: () => clock.now(),
        dataDirectory: options.dataDirectory,
        secretReader: secrets,
        artifacts: persistencePort.repositories.artifacts,
        materializeArtifact,
        markFolderTainted: (context) => chatFolders.markTainted(context.workspaceId, context.runId, context.chatTaskId),
        renderer: overrides.renderOverride ?? createOwnerRenderer(),
        // The report handler degrades a failed history write instead of failing the
        // generation, so the cause only ever reaches the operator through the log.
        logWarning: (message, details) => logger.warn(message, details),
      },
    );
  return { builtinSearchIds, builtinSearchRevisions, keyAllowed, registerSearch, searchConfigurations, searchImplementationHash };
}

export type ResearchToolsContext = HostsContext & Awaited<ReturnType<typeof composeResearchTools>>;
