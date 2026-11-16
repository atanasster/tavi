import {
  MCP_PLUGIN_PREFIX,
  TaviError,
  type PluginAppIconsEntry,
  type PluginUiAnswer,
  type PluginUiEntry,
  type PluginsPayload,
  type PluginView,
  type WorkspaceSettingsRepositoryPort,
  workerRefusal,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import type { PluginLiveStatus, PluginRegistry } from "@tavi/runtime";
import { inProcessAudit, type PluginAuditEntry } from "./audit.js";
import { BUILTIN_CHANNELS } from "./catalog.js";

/**
 * One `plugins` action, shared by the owner's IPC handler and the
 * offline CLI so the two front ends answer alike. Plugins compose when an
 * owner starts, so anything that changes what runs says `restartRequired` —
 * except a plugin that runs no owner code: a UI-only plugin's change the
 * canvas picks up at once, and an MCP server runs out of process.
 */
interface PluginWriteResult {
  readonly result: unknown;
  readonly restartRequired: boolean;
  /** A running owner stopped this plugin's routing already; only unloading its code waits for the restart. */
  readonly routingStopped?: boolean;
  /** The change committed, but cleanup of the loaded plugin failed. */
  readonly cleanupWarning?: string;
  /** A removed channel plugin's connections whose data is erased after the grace. */
  readonly purgesScheduled?: readonly string[];
}

export interface PluginActionContext {
  /** Where an enabled MCP server joins its workspace's `mcp.servers`. */
  readonly workspaceSettings?: WorkspaceSettingsRepositoryPort | undefined;
  /** An MCP server's removal with its remove hook. */
  readonly mcpRemove?:
    | ((
        pluginId: string,
        version: string | undefined,
      ) => Promise<{ readonly removed: readonly string[]; readonly cleanupWarning?: string; readonly cleaned?: unknown }>)
    | undefined;
  /**
   * A channel plugin's last version removed: the purge each connection of its channels that purge on
   * removal (`providerIds`, as its review disclosed) is owed, scheduled after
   * the same grace. Answers the connections scheduled.
   */
  readonly channelPluginRemove?: ((pluginId: string, providerIds: readonly string[]) => Promise<readonly string[]>) | undefined;
  /** What those purges would erase, asked before a removal not yet confirmed: the connections, and what they brought in. */
  readonly channelPluginPreview?:
    | ((
        providerIds: readonly string[],
      ) => Promise<{ readonly connections: number; readonly conversations: number; readonly messages: number; readonly files: number }>)
    | undefined;
  /** The owner's tool-budget check before an MCP server is enabled; offline, the next start checks. */
  readonly mcpBudget?: ((pluginId: string, version: string | undefined, workspaceId: string) => Promise<void>) | undefined;
}

/** The workspace an enable that names none acts in: the owner's own. */
const OWNER_WORKSPACE_ID = "default";

/** Adds an MCP server to a workspace's `mcp.servers`, keeping the rest. */
async function allowMcpServer(
  settings: WorkspaceSettingsRepositoryPort,
  workspaceId: string,
  pluginId: string,
  actor: string,
): Promise<void> {
  const current = await settings.get(workspaceId);
  const servers = current.settings.mcpServers ?? [];
  if (servers.includes(pluginId)) return;
  await settings.set({
    workspaceId,
    settings: { ...current.settings, mcpServers: [...servers, pluginId] },
    expectedRevision: current.revision,
    actor,
    now: nowTimestamp(),
  });
}

export type PluginAnswer =
  | { readonly plugins: readonly PluginView[] }
  | { readonly plugin: PluginView }
  | PluginWriteResult
  | PluginUiAnswer
  | { readonly audit: readonly PluginAuditEntry[] };

export async function runPluginAction(
  registry: PluginRegistry,
  input: PluginsPayload,
  actor: string,
  live?: PluginLiveStatus,
  context?: PluginActionContext,
): Promise<PluginAnswer> {
  switch (input.action) {
    case "list":
      return { plugins: await registry.list(live) };
    case "audit": {
      // Every enabled plugin whose code runs in the owner's process, read from its approved files.
      const entries: PluginAuditEntry[] = [];
      for (const view of await registry.list(live)) {
        const entry = inProcessAudit(registry, view);
        if (entry !== undefined) entries.push(entry);
      }
      return { audit: entries };
    }
    case "show":
      return { plugin: await registry.show(input.pluginId, live) };
    case "install": {
      const { record, created } = await registry.install(input.path, actor);
      const { manifest } = record;
      // As approval decides it: code that cannot be a worker, or whose manifest asks not to be, is approved `--in-process`.
      const inProcessOnly =
        manifest.mcp === undefined &&
        manifest.entry !== undefined &&
        (workerRefusal(manifest) !== undefined || manifest.isolation === "in-process");
      return {
        result: {
          pluginId: record.pluginId,
          version: record.version,
          reviewState: record.reviewState,
          contentHash: record.contentHash,
          created,
          ...(inProcessOnly ? { inProcessOnly: true } : {}),
        },
        restartRequired: false,
      };
    }
    case "approve":
    case "reject": {
      // An MCP server's approval decides each of its tools, which the generic review cannot show.
      if (input.pluginId.startsWith(MCP_PLUGIN_PREFIX)) {
        throw new TaviError(
          "CONFLICT",
          `${input.pluginId} is an MCP server: review its tools with \`tavi mcp show ${input.pluginId}\`, then \`tavi mcp ${input.action} ${input.pluginId} ${input.version}\``,
        );
      }
      const before = await registry.show(input.pluginId);
      const { cleanupWarning, ...record } = await registry.decide(
        input.pluginId,
        input.version,
        input.action === "approve" ? "approved" : "rejected",
        actor,
        ...(input.action === "approve" ? [{ inProcess: input.inProcess === true }] : []),
      );
      // Loaded external contributions withdraw immediately; restart reconciles composition.
      const running = before.enabled && before.activeVersion === input.version;
      const prior = before.versions.find((candidate) => candidate.version === input.version);
      const codeRuns = prior?.runsOwnerCode !== false;
      // Approved again to run elsewhere: the running version moves at the next start.
      const moved = input.action === "approve" && prior?.reviewState === "approved" && prior.isolation !== record.isolation;
      return {
        result: {
          pluginId: record.pluginId,
          version: record.version,
          reviewState: record.reviewState,
          ...(record.isolation === undefined ? {} : { isolation: record.isolation }),
        },
        restartRequired: (input.action === "reject" || moved) && running && codeRuns,
        ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
      };
    }
    case "enable": {
      const mcp = input.pluginId.startsWith(MCP_PLUGIN_PREFIX);
      const workspaceId = input.workspaceId ?? OWNER_WORKSPACE_ID;
      if (mcp) await context?.mcpBudget?.(input.pluginId, input.version, workspaceId);
      // A version that was running code stays loaded until a restart, whatever replaces it.
      const before = await registry.show(input.pluginId);
      const wasRunning = before.enabled && (await runsOwnerCode(registry, input.pluginId, before.activeVersion));
      const result = await registry.enable(input.pluginId, actor, input.version);
      if (mcp && context?.workspaceSettings !== undefined)
        await allowMcpServer(context.workspaceSettings, workspaceId, input.pluginId, actor);
      return {
        result,
        restartRequired: wasRunning || (await runsOwnerCode(registry, input.pluginId, result.activeVersion)),
      };
    }
    case "disable": {
      const runs = await runsOwnerCode(registry, input.pluginId, (await registry.show(input.pluginId)).activeVersion);
      const { cleanupWarning, ...result } = await registry.disable(input.pluginId, actor);
      // A built-in channel's saved connections stay, and its provider id is free: what takes it is handed them.
      const channel = BUILTIN_CHANNELS.find((candidate) => candidate.pluginId === input.pluginId);
      const handover =
        channel === undefined
          ? undefined
          : `${channel.descriptor.label}'s saved connections stay, with their credentials and paired people: a channel plugin approved for provider ${channel.descriptor.providerId} now opens them. Remove them in Settings → Channels (\`tavi channels remove\`) first if no other plugin should.`;
      const warning = [cleanupWarning, handover].filter((line): line is string => line !== undefined).join(" ");
      return { result, restartRequired: runs, ...(warning === "" ? {} : { cleanupWarning: warning }) };
    }
    case "config": {
      if (Object.keys(input.set).length === 0 && input.unset.length === 0 && input.instances === undefined) {
        throw new TaviError("INVALID_INPUT", "plugins config needs --set key=value, --unset key or --instances json");
      }
      const setting = await registry.configure(input.pluginId, input.set, input.unset, actor, input.version, input.instances);
      return {
        result: setting,
        restartRequired: setting.enabled && (await runsOwnerCode(registry, input.pluginId, setting.activeVersion)),
      };
    }
    case "remove": {
      if (input.pluginId.startsWith(MCP_PLUGIN_PREFIX) && context?.mcpRemove !== undefined) {
        const { cleanupWarning, ...result } = await context.mcpRemove(input.pluginId, input.version);
        return { result, restartRequired: false, ...(cleanupWarning === undefined ? {} : { cleanupWarning }) };
      }
      // Its channels, when this removes its last version: their connections are owed a purge.
      const before = (await registry.list()).find((plugin) => plugin.id === input.pluginId);
      const last =
        before !== undefined && (input.version === undefined || before.versions.every((version) => version.version === input.version));
      const providerIds = last
        ? [
            ...new Set(
              before.versions.flatMap((version) =>
                (version.channels ?? []).filter((channel) => channel.retention === "purge-on-remove").map((channel) => channel.providerId),
              ),
            ),
          ]
        : [];
      // Asked first: what goes is shown, and nothing is removed until the removal is confirmed.
      const preview = providerIds.length === 0 || input.yes === true ? undefined : await context?.channelPluginPreview?.(providerIds);
      if (preview !== undefined && preview.connections > 0) {
        throw new TaviError(
          "CONFLICT",
          `Removing ${input.pluginId} erases what its ${String(preview.connections)} connection(s) brought in, 24 hours from now: ${String(preview.conversations)} conversation(s), ${String(preview.messages)} message(s), ${String(preview.files)} file(s), and the chat notes they taught. Its channel's terms require it; installing it again before then cancels it. Disable it instead to keep everything, or confirm with \`tavi plugins remove ${input.pluginId} --yes\`.`,
          { details: { purge: preview } },
        );
      }
      const { cleanupWarning, ...result } = await registry.remove(input.pluginId, input.version);
      const purgesScheduled = providerIds.length === 0 ? [] : ((await context?.channelPluginRemove?.(input.pluginId, providerIds)) ?? []);
      return {
        result,
        restartRequired: false,
        ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
        ...(purgesScheduled.length === 0 ? {} : { purgesScheduled }),
      };
    }
    case "ui": {
      const plugins = await registry.list();
      const asked = (entry: { readonly pluginId: string; readonly contentHash: string }) =>
        (input.pluginId === undefined || entry.pluginId === input.pluginId) &&
        (input.contentHash === undefined || entry.contentHash === input.contentHash);
      const entries = pluginUiEntries(plugins).filter(asked);
      const icons = pluginAppIconEntries(plugins).filter(asked);
      return { entries, ...(icons.length === 0 ? {} : { icons }) };
    }
  }
}

/**
 * The UI contributions the canvas may load:
 * enabled built-ins that ship UI, and enabled external plugins' active,
 * approved version — never a proposed, rejected or disabled one.
 */
export function pluginUiEntries(plugins: readonly PluginView[]): PluginUiEntry[] {
  const entries: PluginUiEntry[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    if (plugin.kind === "builtin") {
      if (plugin.ui !== undefined && plugin.uiContentHash !== undefined) {
        entries.push({ pluginId: plugin.id, kind: "builtin", contentHash: plugin.uiContentHash, ui: plugin.ui });
      }
      continue;
    }
    const version = plugin.versions.find((candidate) => candidate.version === plugin.activeVersion);
    if (version === undefined || version.reviewState !== "approved" || version.ui === undefined) continue;
    entries.push({ pluginId: plugin.id, kind: "external", version: version.version, contentHash: version.contentHash, ui: version.ui });
  }
  return entries;
}

/**
 * The app icons the canvas may load: those an enabled installed plugin's (an MCP server's too) active,
 * approved version names in its `apps` block.
 */
export function pluginAppIconEntries(plugins: readonly PluginView[]): PluginAppIconsEntry[] {
  const entries: PluginAppIconsEntry[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.kind === "builtin") continue;
    const version = plugin.versions.find((candidate) => candidate.version === plugin.activeVersion);
    if (version === undefined || version.reviewState !== "approved") continue;
    const paths = [...new Set((version.apps?.apps ?? []).flatMap((app) => (app.icon === undefined ? [] : [app.icon])))];
    if (paths.length > 0) entries.push({ pluginId: plugin.id, version: version.version, contentHash: version.contentHash, paths });
  }
  return entries;
}

/**
 * Whether `pluginId` (at `version`, for an installed one) imports code into
 * the owner: a UI-only plugin's and an MCP server's do not, so switching them
 * needs no restart. Read from the listing's own `runsOwnerCode`, never
 * inferred from a missing `entry`.
 */
async function runsOwnerCode(registry: PluginRegistry, pluginId: string, version: string | undefined): Promise<boolean> {
  const view = await registry.show(pluginId);
  if (view.kind === "builtin") return view.runsOwnerCode;
  return view.versions.find((candidate) => candidate.version === version)?.runsOwnerCode ?? true;
}
