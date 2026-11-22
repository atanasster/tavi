import { PluginRegistry, createEncryptedFileSecretStore, readPluginManifest, type DatabaseClient } from "@tavi/runtime";
import { channelDescriptorOf, channelDescriptors, registerBuiltinChannelsOf } from "../channels/catalog.js";
import { BUILTIN_PLUGINS } from "../plugins/catalog.js";
import { mcpAccountPersonal } from "../apps/sharing.js";
import { projectApps, snapshotSiteNotes, snapshotSites, type AppsContext } from "../apps/registry.js";
import { keptByAccount } from "../apps/shared-grants.js";
import { McpOAuthTokens } from "./oauth-provider.js";
import { guardedFetch } from "./fetch.js";
import { runMcpAction, type McpActionContext } from "./actions.js";
import { MCP_REGISTRY_SETTING } from "./registry.js";
import { mcpSearchLines } from "./bridge.js";
import { refusalFrom } from "../../shared/ipc-decisions.js";
import { TaviError, MCP_ENABLED_SETTING, mcpEnabledOf, DEFAULT_WORKSPACE_ID } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { join } from "node:path";
import { createLocalCredentialStore, listCredentialRefs } from "../credentials/store.js";

/** Who else keeps an account's grant, in any workspace, weighed from the data directory as the owner would. */
export async function offlineKeptBy(store: DatabaseClient, dataDirectory: string, accountId: string): Promise<readonly string[]> {
  const workspaceIds = [
    ...new Set([DEFAULT_WORKSPACE_ID, ...(await store.asPort().repositories.workspaceSettings.list()).map((record) => record.workspaceId)]),
  ];
  for (const workspaceId of workspaceIds) {
    const kept = (await offlineSharedGrants(store, dataDirectory, workspaceId)).get(accountId);
    if (kept !== undefined) return kept;
  }
  return [];
}

/**
 * The workspace's accounts another app shares a provider grant with,
 * projected from the data directory as the owner's Connected apps would, so a
 * Gmail disconnect with no owner still leaves Calendar's sign-in alone.
 */
export async function offlineSharedGrants(
  store: DatabaseClient,
  dataDirectory: string,
  workspaceId: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const mcp = offlineMcpContext(store, dataDirectory);
  const repositories = store.asPort().repositories;
  // The channels an owner would install: the built-in ones whose plugins are enabled, for this weighing only.
  const release = await registerBuiltinChannelsOf(repositories);
  try {
    return await weighSharedGrants(store, dataDirectory, workspaceId, mcp);
  } finally {
    release();
  }
}

async function weighSharedGrants(
  store: DatabaseClient,
  dataDirectory: string,
  workspaceId: string,
  mcp: McpActionContext,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const repositories = store.asPort().repositories;
  const credentials = createLocalCredentialStore(dataDirectory);
  const workspaceIds = [...new Set((await repositories.messagingConnections.list()).map((record) => record.workspaceId))];
  const readOnly = async (): Promise<never> => {
    throw new TaviError("UNAVAILABLE", "weighing a disconnect changes nothing");
  };
  // Read only: a grant's facts are on disk, and nothing here is written or fetched.
  const tokens = new McpOAuthTokens({
    store: { read: (reference) => credentials.getSecret(reference), write: readOnly, delete: readOnly },
    fetchFor: () => readOnly,
  });
  const context: AppsContext = {
    mcp: async (payload) => {
      try {
        return { ok: true, result: await runMcpAction(mcp, payload, "operator:cli") };
      } catch (error) {
        return refusalFrom(error);
      }
    },
    plugins: readOnly,
    views: () => mcp.registry.list(),
    manifestOf: (pluginId, version) => {
      try {
        return readPluginManifest(mcp.registry.snapshotDirectory(pluginId, version));
      } catch {
        return undefined;
      }
    },
    sitesOf: snapshotSites((pluginId, version) => mcp.registry.snapshotDirectory(pluginId, version)),
    siteNotesOf: snapshotSiteNotes((pluginId, version) => mcp.registry.snapshotDirectory(pluginId, version)),
    connections: (id) => repositories.messagingConnections.list(id),
    descriptorOf: channelDescriptorOf,
    descriptors: channelDescriptors,
    // Only the sign-ins are weighed: no rule decides who keeps a grant.
    rules: { inForce: async () => [], put: readOnly, remove: readOnly },
    getMeta: (key) => store.getMeta(key),
    setMeta: readOnly,
    workspaceSettings: async (id) => (await repositories.workspaceSettings.get(id)).settings,
    workspaceIds: () => workspaceIds,
    credentialRefs: async () => new Set((await listCredentialRefs(dataDirectory)).valid),
    mcpGrant: (pluginId) => tokens.grant(pluginId),
    dataDirectory,
    now: nowTimestamp,
    actor: "operator:cli",
  };
  return keptByAccount(await projectApps(context, workspaceId));
}

/** The `mcp` actions' context on the data directory, with no owner: credentials from the encrypted store. */
export function offlineMcpContext(store: DatabaseClient, dataDirectory: string): McpActionContext {
  const secrets = createEncryptedFileSecretStore({
    directory: join(dataDirectory, "credentials"),
    keyFile: join(dataDirectory, "credentials.key"),
    missingDirectory: "absent",
  });
  const registry = new PluginRegistry({ client: store, directory: join(dataDirectory, "plugins"), builtins: BUILTIN_PLUGINS });
  return {
    registry,
    mcp: store.asPort().repositories.mcp,
    dataDirectory,
    // The household rule offline too: a Personal account is lent to no one.
    personal: async (pluginId) => await mcpAccountPersonal(registry, (key) => store.getMeta(key), pluginId),
    resolveSecret: (reference) => secrets.getSecret(reference),
    now: nowTimestamp,
    workspaceSettings: store.asPort().repositories.workspaceSettings,
    deleteSessionGrants: (toolIds) => store.asPort().repositories.toolPolicy.deleteSessionGrantsForTools(toolIds),
    // A logout needs no owner: the grant is revoked where the server allows (its lan read from the active version's), and forgotten.
    logout: async (pluginId, logoutOptions) => {
      const credentials = createLocalCredentialStore(dataDirectory);
      const view = await registry.show(pluginId);
      const version = view.activeVersion ?? view.versions.at(-1)?.version;
      const lan = version !== undefined && readPluginManifest(registry.snapshotDirectory(pluginId, version)).mcp?.network?.lan === true;
      const tokens = new McpOAuthTokens({
        store: {
          read: (reference) => credentials.getSecret(reference),
          write: (reference, value) => credentials.setSecret(reference, value),
          delete: (reference) => credentials.deleteSecret(reference),
        },
        fetchFor: () => guardedFetch({ lan }),
      });
      // Revoked at the provider only when no other app keeps its grant, weighed from the data directory.
      const kept = logoutOptions?.upstream === false ? [] : await offlineKeptBy(store, dataDirectory, pluginId);
      return await tokens.revoke(pluginId, kept.length > 0 ? { upstream: false } : (logoutOptions ?? {}));
    },
    // Offline too: the next start reads it.
    enabled: async () => mcpEnabledOf(await store.getMeta(MCP_ENABLED_SETTING)),
    setEnabled: async (on) => await store.setMeta(MCP_ENABLED_SETTING, String(on), nowTimestamp()),
    searchLines: mcpSearchLines(
      (key) => store.getMeta(key),
      (key, value) => store.setMeta(key, value, nowTimestamp()),
    ),
    registryUrl: {
      get: async () => await store.getMeta(MCP_REGISTRY_SETTING),
      set: async (url) => await store.setMeta(MCP_REGISTRY_SETTING, url ?? "", nowTimestamp()),
    },
  };
}
