import { TERMINAL_TASK_STATUSES } from "@tavi/agent-host/agent-communication";
import { builtinPluginsWithUi } from "../features/plugins/catalog.js";
import { snapshotDevPlugin } from "../features/plugins/dev.js";
import { builtCanvasDirectory } from "../canvas-directory.js";
import {
  MCP_ENABLED_SETTING,
  uniqueRules,
  mcpEnabledOf,
  homeChatOn,
  TaviError,
  maskPluginText,
  PLUGIN_STATUS_MAX_CHARS,
  isLocalConnectionId,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { PluginRegistry } from "@tavi/runtime";
import { join } from "node:path";
import { videoMcpExchange, videoMcpServers } from "../features/video/host.js";
import { APPS_SHARING_SETTING, parseSharing, sharingOf } from "../features/apps/sharing.js";
import { createLocalCredentialStore, serializeCredentialAction } from "../features/credentials/store.js";
import { createMcpHost } from "../features/mcp/host.js";
import { mcpSearchLines } from "../features/mcp/bridge.js";
import type { AccessContext } from "./access.js";
import { BROWSER_ENGINE_PLUGIN_ID } from "../features/plugins/catalog.js";

/** Days of site usage kept. */
const SITE_USAGE_KEEP_DAYS = 30;

/** The plugin registry, the MCP host, the dev plugins and the plugins resolved to load. */
export async function composePlugins(composed: AccessContext) {
  const {
    access,
    browserToolStage,
    clock,
    confinement,
    late,
    limits,
    logger,
    options,
    ownership,
    persistencePort,
    sandboxHost,
    sitePolicy,
    store,
    tools,
  } = composed;
  late.withdrawExternal = async () => undefined;
  // UI built-ins carry the hash of the files the canvas build ships.
  const builtinPluginInfos = builtinPluginsWithUi(builtCanvasDirectory());
  const pluginRegistry = new PluginRegistry({
    client: store,
    directory: join(options.dataDirectory, "plugins"),
    builtins: builtinPluginInfos,
    now: () => clock.now(),
    withdraw: (id, version) => late.withdrawExternal(id, version),
  });
  const disabledBuiltins = await pluginRegistry.disabledBuiltins();
  // The browser's tools, offered while `tavi.browser` is enabled: disabled, the agent has no browser from the next start.
  if (!disabledBuiltins.has(BROWSER_ENGINE_PLUGIN_ID)) tools.adopt(browserToolStage);
  // MCP servers: supervised out of process. What an earlier owner left running is reaped
  // first, and only by the owner (a foreground run must not kill a running owner's servers).
  // The household rule, for MCP servers and plugins alike: read at every offer, so a choice made on the page applies at once.
  const accountPersonal = async (pluginId: string, dataClass: "public" | "personal" | undefined): Promise<boolean> =>
    sharingOf(parseSharing(await store.getMeta(APPS_SHARING_SETTING)), pluginId, dataClass) === "personal";
  // The servers `analyzers.json` names as video analysers may read their exchange
  // directory, read now: a change takes effect at the next start, when every server starts afresh.
  const videoMcpAnalyzerServers = videoMcpServers(options.dataDirectory);
  const mcpHost = createMcpHost({
    analyzerExchange: (pluginId) => (videoMcpAnalyzerServers.has(pluginId) ? videoMcpExchange(options.dataDirectory, pluginId) : undefined),
    onSignedIn: async (pluginId) => {
      await late.connectWaitsRef.current
        ?.connected(pluginId)
        .catch((error: unknown) =>
          logger.warn("the tasks waiting for a server's sign-in could not go on", { pluginId, error: errorMessage(error) }),
        );
    },
    registry: pluginRegistry,
    mcp: store.asPort().repositories.mcp,
    dataDirectory: options.dataDirectory,
    resolveSecret: (reference) => late.secrets.getSecret(reference),
    now: () => clock.now(),
    confinement,
    sandboxHost,
    limits,
    log: (message, fields) => logger.info(message, fields),
    tools,
    workspaceSettings: async (workspaceId) => (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings,
    allWorkspaceSettings: async () =>
      (await persistencePort.repositories.workspaceSettings.list()).map(({ workspaceId, settings }) => ({ workspaceId, settings })),
    operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
    // OAuth grants in the credential store, one write at a time, as the channels' tokens are.
    grants: {
      read: (reference) => createLocalCredentialStore(options.dataDirectory).getSecret(reference),
      write: (reference, value) =>
        serializeCredentialAction(options.dataDirectory, () =>
          createLocalCredentialStore(options.dataDirectory).setSecret(reference, value),
        ),
      delete: (reference) =>
        serializeCredentialAction(options.dataDirectory, () => createLocalCredentialStore(options.dataDirectory).deleteSecret(reference)),
    },
    // The public address as the settings name it, read when a login starts; its listener opens once a public login waits.
    publicUrl: () => late.ingress.configuredPublicUrl(),
    awaitingPublic: () => late.ingress.ensure(),
    // A sign-in forgotten: the public listener closes if nothing else needs it.
    publicMayClose: () => late.ingress.ensure(),
    // The owner's kill switch, read whenever a server would start or register.
    enabled: async () => mcpEnabledOf(await store.getMeta(MCP_ENABLED_SETTING)),
    personal: accountPersonal,
    searchLine: mcpSearchLines(
      (key) => store.getMeta(key),
      (key, value) => store.setMeta(key, value, clock.now()),
    ).get,
    deleteSessionGrants: (toolIds) => persistencePort.repositories.toolPolicy.deleteSessionGrantsForTools(toolIds),
    // A call's image: an approved artifact of its task, labelled as the server's, which a model that reads
    // images is shown as `artifacts.view_image`'s are.
    storeImage: async ({ workspaceId, taskId, mediaType, data, label }) =>
      (
        await persistencePort.repositories.artifacts.putArtifact({
          workspaceId,
          ...(taskId === undefined ? {} : { runId: taskId }),
          contentType: mediaType,
          body: data,
          extension: mediaType.slice("image/".length).replace("jpeg", "jpg"),
          reviewState: "approved",
          untrusted: true,
          label,
        })
      ).artifactId,
    // A call held on its server's question is released when its task ends.
    taskOpen: async (taskId) => {
      const status = (await persistencePort.repositories.tasks.get(taskId))?.status;
      return status !== undefined && !TERMINAL_TASK_STATUSES.has(status);
    },
    // A call's progress: its server's line on the task's stream, after its last attempt.
    progress: ({ pluginId, taskId, line }) => {
      const attemptId = late.runEventBus.lastAttempt(taskId);
      if (attemptId === undefined) return;
      late.runEventBus.publish(taskId, {
        kind: "plugin.status",
        runId: taskId,
        attemptId,
        pluginId,
        ...(line === undefined ? {} : { line: maskPluginText(line, PLUGIN_STATUS_MAX_CHARS) }),
      });
    },
    rules: async () =>
      uniqueRules(
        (await Promise.all(options.workspaces.map((grant) => persistencePort.repositories.toolPolicy.listRules(grant.workspaceId)))).flat(),
      ),
    // Read when a notice is raised, after every server and channel is composed.
    delivery: {
      homeOf: async (workspaceId, principalId) => {
        if (!homeChatOn((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings)) return undefined;
        return await persistencePort.repositories.tasks.homeOf(workspaceId, principalId);
      },
      postNotice: (input) => persistencePort.repositories.transcripts.postNotice(input),
      targets: (workspaceId, principalId) => late.reminderTargets.operatorTargets(workspaceId, principalId),
      boundTo: async (connectionId, senderId) => await persistencePort.repositories.messagingIdentityBindings.get(connectionId, senderId),
      isLocalConnection: isLocalConnectionId,
      send: async ({ effectId, workspaceId, connectionId, chatId, text }) => {
        const destination = late.messaging.buildReplyDestination(connectionId, {
          externalConversationId: chatId,
          externalSenderId: chatId,
        });
        if (destination === undefined) return;
        await late.messaging.send({ effectId, connectionId, workspaceId, destination, parts: [{ content: text }] });
      },
    },
  });
  if (ownership !== undefined) await mcpHost.reap();
  late.liveBuiltinWithdrawals = new Map();
  // `verify` (doctor) checks each enabled plugin — approval, hash, settings — without importing it:
  // a diagnostic runs no third-party code, and still reports a plugin that would not load.
  const builtinPluginIds = new Set(builtinPluginInfos.map((plugin) => plugin.id));
  late.builtinPluginIds = builtinPluginIds;
  const devSnapshots = join(options.dataDirectory, "plugins", ".dev");
  const devPlugins =
    options.externalPlugins === "verify"
      ? []
      : (options.devPlugins ?? []).map((source) => ({
          source,
          load: snapshotDevPlugin(source, devSnapshots, builtinPluginIds, () => clock.now()),
        }));
  const devPluginIds = new Set(devPlugins.map((plugin) => plugin.load.record.pluginId));
  late.devPluginIds = devPluginIds;
  if (devPluginIds.size < devPlugins.length) throw new TaviError("INVALID_INPUT", "two --dev-plugin folders are the same plugin");
  const resolvedPlugins = [
    ...(await pluginRegistry.resolveEnabled()).filter((plugin) => !devPluginIds.has(plugin.ok ? plugin.record.pluginId : plugin.pluginId)),
    ...devPlugins.map((plugin) => plugin.load),
  ];
  late.resolvedPlugins = resolvedPlugins;
  // The site profiles' first read, for the assessments that cannot wait for one.
  await sitePolicy.refresh().catch((error: unknown) => logger.warn("the site profiles could not be read", { error: errorMessage(error) }));
  // A profile's day counts: the last month is kept.
  await persistencePort.repositories.siteUsage
    .prune(new Date(Date.parse(clock.now()) - SITE_USAGE_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10))
    .catch((error: unknown) => logger.warn("old site usage could not be pruned", { error: errorMessage(error) }));
  return {
    accountPersonal,
    builtinPluginIds,
    devPluginIds,
    devPlugins,
    devSnapshots,
    disabledBuiltins,
    mcpHost,
    pluginRegistry,
    resolvedPlugins,
  };
}

export type PluginsContext = AccessContext & Awaited<ReturnType<typeof composePlugins>>;
