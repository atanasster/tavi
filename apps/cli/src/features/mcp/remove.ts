import { rmSync } from "node:fs";
import { join } from "node:path";

import { TaviError, toolPatternMatches, uniqueRules, type ToolRule, type WorkspaceSettingsRepositoryPort } from "@tavi/contracts";
import { readPluginManifest, type PluginRegistry } from "@tavi/runtime";

import { createLocalCredentialStore } from "../credentials/store.js";
import type { McpActionContext } from "./actions.js";
import { mcpSearchLines } from "./bridge.js";
import { guardedFetch } from "./fetch.js";
import { McpOAuthTokens, mcpOAuthRef, type McpRevocation } from "./oauth-provider.js";

/**
 * The MCP remove hook: removing a
 * server's last version stops it, deletes its home (`<data>/mcp/<id>/`), its
 * credentials, its OAuth sign-in (revoked where the server offers it), its notices, its `tools.search` line and every session grant of its tools, drops it
 * from every workspace's `mcp.servers` and `mcp.people`, and lists the allow
 * rules that still name its tools (an operator's rules are theirs to delete).
 * Its version and tool rows go with the plugin's by foreign-key cascade.
 * Removing one of several versions removes only that version.
 */

type AsyncMcpRepository = McpActionContext["mcp"];

export interface McpRemovalDeps {
  readonly registry: PluginRegistry;
  readonly mcp: AsyncMcpRepository;
  readonly dataDirectory: string;
  readonly deleteSecret: (reference: string) => Promise<void>;
  readonly deleteSessionGrants: (toolIds: readonly string[]) => Promise<number>;
  readonly rules: () => Promise<readonly ToolRule[]>;
  readonly workspaceSettings: WorkspaceSettingsRepositoryPort;
  readonly now: () => string;
  /** Forgets the operator's `tools.search` line for the server. */
  readonly clearSearchLine: (pluginId: string) => Promise<void>;
  /**
   * Revokes the server's OAuth grant where it offers revocation (best effort), and deletes it; whether there was one.
   * `upstream: false`: deleted here only, another app keeping the provider's grant.
   */
  readonly revokeGrant: (pluginId: string, lan: boolean, options?: { readonly upstream?: boolean }) => Promise<McpRevocation>;
  /** The other apps that keep its grant at the provider, asked before it is removed (it is not projected after). */
  readonly keptBy?: (pluginId: string) => Promise<readonly string[]>;
}

export interface McpRemoval {
  readonly removed: readonly string[];
  /** The server is gone (its last version): what went with it. */
  readonly cleaned?: {
    readonly credentials: readonly string[];
    readonly grantsDeleted: number;
    readonly noticesDeleted: number;
    readonly workspaces: readonly string[];
    /** Allow rules that still name its tools, as `<workspace>:<ruleId>`. */
    readonly rules: readonly string[];
  };
  readonly cleanupWarning?: string;
}

/** The hook's dependencies from a store's repositories, owner or offline: the credential store is the data directory's. */
export function mcpRemovalDeps(
  registry: PluginRegistry,
  repositories: {
    readonly mcp: AsyncMcpRepository;
    readonly toolPolicy: {
      deleteSessionGrantsForTools(toolIds: readonly string[]): Promise<number>;
      listRules(workspaceId: string): Promise<readonly ToolRule[]>;
    };
    readonly workspaceSettings: WorkspaceSettingsRepositoryPort;
  },
  dataDirectory: string,
  workspaceIds: readonly string[],
  now: () => string,
  setMeta: (key: string, value: string) => Promise<void> | void,
  /** The owner's own tokens' revoke, so a refresh it has in flight never writes the grant back; the data directory's otherwise. */
  revokeGrant?: (pluginId: string, lan: boolean, options?: { readonly upstream?: boolean }) => Promise<McpRevocation>,
  /** Who else keeps its grant at the provider: its revocation upstream waits for the last one. */
  keptBy?: (pluginId: string) => Promise<readonly string[]>,
): McpRemovalDeps {
  const credentials = createLocalCredentialStore(dataDirectory);
  return {
    registry,
    mcp: repositories.mcp,
    dataDirectory,
    deleteSecret: (reference) => credentials.deleteSecret(reference),
    deleteSessionGrants: (toolIds) => repositories.toolPolicy.deleteSessionGrantsForTools(toolIds),
    rules: async () =>
      uniqueRules((await Promise.all(workspaceIds.map((workspaceId) => repositories.toolPolicy.listRules(workspaceId)))).flat()),
    workspaceSettings: repositories.workspaceSettings,
    now,
    clearSearchLine: (pluginId) => mcpSearchLines(() => undefined, setMeta).set(pluginId, undefined),
    revokeGrant:
      revokeGrant === undefined
        ? async (pluginId, lan, options) =>
            await new McpOAuthTokens({
              store: {
                read: (reference) => credentials.getSecret(reference),
                write: (reference, value) => credentials.setSecret(reference, value),
                delete: (reference) => credentials.deleteSecret(reference),
              },
              fetchFor: () => guardedFetch({ lan }),
            }).revoke(pluginId, options)
        : async (pluginId, lan, options) => await revokeGrant(pluginId, lan, options),
    ...(keptBy === undefined ? {} : { keptBy }),
  };
}

export async function removeMcpServer(
  deps: McpRemovalDeps,
  pluginId: string,
  version: string | undefined,
  actor: string,
): Promise<McpRemoval> {
  const view = await deps.registry.show(pluginId);
  if (view.kind !== "mcp") throw new TaviError("INVALID_INPUT", `${pluginId} is not an MCP server`);
  const last = version === undefined || view.versions.every((candidate) => candidate.version === version);
  // Read before the rows and snapshots go: the tools' ids, and which settings hold credentials.
  const toolIds = [...new Set((await deps.mcp.listTools(pluginId)).map((tool) => tool.toolId))];
  const credentialSettings = new Set<string>();
  // Its revocation goes where its server's own network allows: a LAN server's sign-in is on the LAN.
  let lan = false;
  for (const candidate of view.versions) {
    try {
      const manifest = readPluginManifest(deps.registry.snapshotDirectory(pluginId, candidate.version));
      for (const [name, field] of Object.entries(manifest.config)) if (field.type === "credential") credentialSettings.add(name);
      if (manifest.mcp?.network?.lan === true) lan = true;
    } catch {
      // A snapshot that no longer reads names no credential.
    }
  }
  // Every credential setting's reference, and any setting naming one under the server's own prefix (a version whose
  // snapshot no longer reads still had its credentials set there).
  const references = [
    ...new Set(
      [
        ...[...credentialSettings].map((name) => view.config[name]),
        ...Object.values(view.config).filter((value) => typeof value === "string" && value.startsWith(`plugins.${pluginId}.`)),
      ].filter((reference): reference is string => typeof reference === "string" && reference !== ""),
    ),
  ];
  // Who else keeps its grant, weighed while it is still an app: unknown is kept, so a failed check never revokes another's.
  const shared =
    last && deps.keptBy !== undefined
      ? await deps.keptBy(pluginId).then(
          (kept) => kept.length > 0,
          () => true,
        )
      : false;
  const { cleanupWarning, ...result } = await deps.registry.remove(pluginId, version);
  if (!last) return { ...result, ...(cleanupWarning === undefined ? {} : { cleanupWarning }) };

  rmSync(join(deps.dataDirectory, "mcp", pluginId), { recursive: true, force: true });
  const kept: string[] = [];
  for (const reference of references) {
    try {
      await deps.deleteSecret(reference);
    } catch {
      kept.push(reference);
    }
  }
  // Its OAuth grant is a credential no setting names: revoked where the server offers it, and deleted.
  const revocation = await deps.revokeGrant(pluginId, lan, shared ? { upstream: false } : {}).catch((): McpRevocation => {
    kept.push(mcpOAuthRef(pluginId));
    return { hadGrant: false, confirmed: false };
  });
  const deleted = [...references.filter((reference) => !kept.includes(reference)), ...(revocation.hadGrant ? [mcpOAuthRef(pluginId)] : [])];
  const unconfirmed =
    revocation.hadGrant && !revocation.confirmed ? "its sign-in was forgotten, but the server did not confirm revoking it" : undefined;
  const noticesDeleted = await deps.mcp.deleteNotices(pluginId);
  await deps.clearSearchLine(pluginId);
  const grantsDeleted = toolIds.length === 0 ? 0 : await deps.deleteSessionGrants(toolIds);
  const workspaces: string[] = [];
  for (const record of await deps.workspaceSettings.list()) {
    const { mcpServers, mcpPeople } = record.settings;
    if (mcpServers?.includes(pluginId) !== true && mcpPeople?.includes(pluginId) !== true) continue;
    await deps.workspaceSettings.set({
      workspaceId: record.workspaceId,
      settings: {
        ...record.settings,
        mcpServers: (mcpServers ?? []).filter((id) => id !== pluginId),
        mcpPeople: (mcpPeople ?? []).filter((id) => id !== pluginId),
      },
      expectedRevision: record.revision,
      actor,
      now: deps.now(),
    });
    workspaces.push(record.workspaceId);
  }
  const rules = (await deps.rules())
    .filter((rule) => rule.decision === "allow" && toolIds.some((toolId) => toolPatternMatches(rule.toolPattern, toolId)))
    .map((rule) => `${rule.workspaceId}:${rule.ruleId}`);
  return {
    ...result,
    cleaned: { credentials: deleted, grantsDeleted, noticesDeleted, workspaces, rules },
    ...(cleanupWarning === undefined && kept.length === 0 && unconfirmed === undefined
      ? {}
      : {
          cleanupWarning: [
            cleanupWarning,
            kept.length === 0 ? undefined : `credentials not deleted: ${kept.join(", ")} (tavi credentials delete)`,
            unconfirmed,
          ]
            .filter((part): part is string => part !== undefined)
            .join("; "),
        }),
  };
}
