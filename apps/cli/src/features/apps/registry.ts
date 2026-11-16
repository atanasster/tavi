import {
  APP_HEALTH,
  TaviError,
  type AppRepair,
  TaviErrorCodeSchema,
  type CatalogBadge,
  type ChannelsPayload,
  type CatalogEntry,
  type ChannelDescriptor,
  type MessagingSetup,
  type ConnectableApp,
  type McpPayload,
  type MessagingConnectionRecord,
  type PluginManifest,
  type PluginsPayload,
  type PluginView,
  type SiteProfile,
  type ToolRule,
  type WorkspaceSettings,
  type AppsCatalogAnswer,
} from "@tavi/contracts";

import { readPluginManifest, readPluginSiteProfiles } from "@tavi/runtime";

import { readPluginSiteNotes } from "../browser/site-notes.js";

import type { IpcAnswer } from "../../shared/ipc-decisions.js";
import type { McpReview, McpServerList, McpServerRow } from "../mcp/actions.js";
import type { AppsActivitySources } from "./activity.js";
import type { McpGrantFacts } from "./sources/mcp.js";
import type { RegistryEntry } from "../mcp/registry.js";
import { AVAILABLE_PRESETS, presetOf } from "../mcp/presets/index.js";
import { sharedProviderFacts, sharedProviderOf } from "../channels/oauth.js";
import { createLocalCredentialStore } from "../credentials/store.js";
import { channelGrantsOf } from "../channels/catalog.js";
import { channelPresentationOf } from "./builtin.js";
import { oauthClientCredentialRefs } from "./oauth-clients.js";
import { keptBy, type ProviderGrant } from "./shared-grants.js";
import { settableTargets } from "./permissions.js";
import {
  APPS_CALENDAR_SETTING,
  APPS_MAILBOX_SETTING,
  APPS_REFUSED_SETTING,
  APPS_SHARING_SETTING,
  APPS_SITES_SETTING,
  parseCalendar,
  parseMailbox,
  parseRefused,
  parseSharing,
  parseSites,
} from "./sharing.js";
import type { ChannelRunningStatus } from "./health.js";
import { channelApps } from "./sources/channel.js";
import { mcpApps } from "./sources/mcp.js";
import { pluginApps } from "./sources/plugin.js";

/**
 * What the `apps` command reads and calls. It holds nothing of its own: every source is read where it
 * lives, and every change goes through that source's own command, so its
 * refusals for a page apply unchanged.
 */
export interface AppsContext {
  readonly mcp: (payload: McpPayload) => Promise<IpcAnswer<unknown>>;
  readonly plugins: (payload: PluginsPayload) => Promise<IpcAnswer<unknown>>;
  readonly views: () => Promise<readonly PluginView[]>;
  readonly manifestOf: (pluginId: string, version: string) => PluginManifest | undefined;
  /** A version's site profiles, read from its snapshot; none when it ships none or no longer reads. */
  readonly sitesOf?: (pluginId: string, version: string) => readonly SiteProfile[];
  /** A version's site note ids, read from its snapshot: a note is switched by its own id where no profile shares it. */
  readonly siteNotesOf?: (pluginId: string, version: string) => readonly string[];
  readonly connections: (workspaceId: string) => Promise<readonly MessagingConnectionRecord[]>;
  readonly descriptorOf: (providerId: string) => ChannelDescriptor | undefined;
  readonly descriptors: () => readonly ChannelDescriptor[];
  /** A running connection's state and named repair, from the owner's messaging service. */
  readonly channelStatus?: (connectionId: string) => ChannelRunningStatus | undefined;
  /** A running connection's setup notes, from its last probe. */
  readonly channelSetup?: (connectionId: string) => MessagingSetup | undefined;
  readonly rules: {
    readonly inForce: (workspaceId: string) => Promise<readonly ToolRule[]>;
    readonly put: (rule: ToolRule) => Promise<unknown>;
    readonly remove: (workspaceId: string, ruleId: string) => Promise<boolean>;
  };
  readonly getMeta: (key: string) => Promise<string | undefined>;
  readonly setMeta: (key: string, value: string) => Promise<void>;
  readonly workspaceSettings: (workspaceId: string) => Promise<WorkspaceSettings>;
  /** Every workspace the owner grants: an owner-wide page rule is decided against each one's rules. */
  readonly workspaceIds: () => readonly string[];
  /** Credential references the store holds (names only). */
  readonly credentialRefs: () => Promise<ReadonlySet<string>>;
  /** What a page may know of an MCP server's sign-in: the account, when, and what consent left out; never a token. */
  readonly mcpGrant?: (pluginId: string) => Promise<McpGrantFacts | undefined>;
  /** After a mailbox is turned on: marks its connection as needing a new sign-in when its grant lacks mail access. */
  readonly checkMailConsent?: (connectionId: string) => Promise<void>;
  readonly dataDirectory: string;
  readonly now: () => string;
  /** Who acts: `operator:ui` from a page, `operator:cli` otherwise. */
  readonly actor: string;
  /** The effect ledger and approval history an app's Recent activity reads. */
  readonly activity?: AppsActivitySources;
  /** *Not now* for one task's connect need, from an owner that runs tasks. */
  readonly declineConnect?: (waitId: string, workspaceId: string) => Promise<void>;
  /** The channels command: a shared client changes through it, so a channel's sign-ins made with another are signed out. */
  readonly channels?: (payload: ChannelsPayload) => Promise<IpcAnswer<unknown>>;
}

/** A result the source's command answered, or its refusal thrown with the same code. */
export function resultOf<T>(answer: IpcAnswer<unknown>): T {
  if (!answer.ok) {
    const code = TaviErrorCodeSchema.safeParse(answer.error.code);
    throw new TaviError(
      code.success ? code.data : "INTERNAL",
      answer.error.message,
      answer.error.details === undefined ? undefined : { details: answer.error.details },
    );
  }
  return answer.result as T;
}

/** The repairs that wait on the person: a paused or off app was turned off on purpose, and asks nothing. */
const WAITING_REPAIR_KINDS: ReadonlySet<AppRepair["kind"]> = new Set([
  "sign-in",
  "grant-access",
  "review-tools",
  "retry",
  "finish-setup",
  "sharing",
]);

/** Every app's repairs that wait on the person, as one list in the apps' order (worst first), each naming its app (the Center rail). */
export function appRepairList(apps: readonly ConnectableApp[]): (AppRepair & { readonly appId: string; readonly appName: string })[] {
  return apps
    .filter((app) => app.health !== "paused" && app.health !== "off")
    .flatMap((app) =>
      app.repairs
        .filter((repair) => WAITING_REPAIR_KINDS.has(repair.kind))
        .map((repair) => ({ ...repair, appId: app.appId, appName: app.name })),
    );
}

/** `sitesOf` for an apps context: a version's site profiles from its snapshot, none when it no longer reads. */
export function snapshotSites(
  snapshotDirectory: (pluginId: string, version: string) => string,
): (pluginId: string, version: string) => readonly SiteProfile[] {
  return (pluginId, version) => {
    try {
      return readPluginSiteProfiles(snapshotDirectory(pluginId, version));
    } catch {
      return [];
    }
  };
}

/** `siteNotesOf` for an apps context: the ids of a version's site notes from its snapshot, none when it no longer reads. */
export function snapshotSiteNotes(
  snapshotDirectory: (pluginId: string, version: string) => string,
): (pluginId: string, version: string) => readonly string[] {
  return (pluginId, version) => {
    try {
      const directory = snapshotDirectory(pluginId, version);
      return readPluginSiteNotes(directory, readPluginManifest(directory)).map((note) => note.id);
    } catch {
      return [];
    }
  };
}

/** Every app the workspace holds, worst health first, then by name. */
export async function projectApps(context: AppsContext, workspaceId: string): Promise<ConnectableApp[]> {
  const views = await context.views();
  const listed = await context.mcp({ action: "list", workspaceId });
  const rows = new Map<string, McpServerRow>(
    (listed.ok ? (listed.result as { readonly servers: McpServerList }).servers.servers : []).map((row) => [row.pluginId, row]),
  );
  const reviews = new Map<string, McpReview>();
  for (const view of views) {
    if (view.kind !== "mcp" || view.versions.length === 0) continue;
    const shown = await context.mcp({ action: "show", pluginId: view.id });
    if (shown.ok) reviews.set(view.id, (shown.result as { readonly review: McpReview }).review);
  }
  const [rules, settings, refs, connections] = await Promise.all([
    context.rules.inForce(workspaceId),
    context.workspaceSettings(workspaceId),
    context.credentialRefs(),
    context.connections(workspaceId),
  ]);
  const sharing = parseSharing(await context.getMeta(APPS_SHARING_SETTING));
  const grants = new Map<string, McpGrantFacts>();
  for (const view of views) {
    if (view.kind !== "mcp" || context.mcpGrant === undefined) continue;
    const grant = await context.mcpGrant(view.id);
    if (grant !== undefined) grants.set(view.id, grant);
  }
  const apps = [
    ...mcpApps({
      views,
      rows,
      reviews,
      manifestOf: context.manifestOf,
      rules,
      settings,
      workspaceId,
      sharing,
      credentialRefs: refs,
      grants,
      now: context.now(),
      refused: parseRefused(await context.getMeta(APPS_REFUSED_SETTING)),
    }),
    ...channelApps({
      connections,
      descriptorOf: context.descriptorOf,
      sharing,
      credentialRefs: refs,
      mailbox: parseMailbox(await context.getMeta(APPS_MAILBOX_SETTING)),
      calendar: parseCalendar(await context.getMeta(APPS_CALENDAR_SETTING)),
      rules,
      ...(context.channelStatus === undefined ? {} : { statusOf: context.channelStatus }),
      ...(context.channelSetup === undefined ? {} : { setupOf: context.channelSetup }),
    }),
    ...pluginApps({
      views,
      manifestOf: context.manifestOf,
      rules,
      sharing,
      workspaceId,
      sitesOn: parseSites(await context.getMeta(APPS_SITES_SETTING)),
      ...(context.sitesOf === undefined ? {} : { sitesOf: context.sitesOf }),
    }),
  ];
  // A page's rule is owner-wide, so what it may pick holds against every workspace's rules, as the change is decided.
  const others = context.workspaceIds().filter((other) => other !== workspaceId);
  const ruleSets = [rules, ...(await Promise.all(others.map((other) => context.rules.inForce(other))))];
  const settable = (app: ConnectableApp): ConnectableApp => ({
    ...app,
    tools: app.tools.map((tool) =>
      tool.canSetHere.length === 0
        ? tool
        : {
            ...tool,
            canSetHere: settableTargets(ruleSets, {
              toolId: tool.toolId,
              effect: tool.effect,
              floor: tool.floor,
              mcp: app.source.kind === "mcp",
            }),
          },
    ),
  });
  // One id, one app: a second source using an id already taken is shown under its own plugin's id (or provider's).
  const seen = new Set<string>();
  const unique = (others.length === 0 ? apps : apps.map(settable)).map((app) => {
    const fallback = app.source.pluginIds[0] ?? `${app.appId}.${app.source.kind}`;
    const appId = seen.has(app.appId) ? fallback : app.appId;
    seen.add(appId);
    return appId === app.appId ? app : { ...app, appId };
  });
  const kept = await withKeptBy(context, unique);
  return kept.sort((a, b) => APP_HEALTH.indexOf(a.health) - APP_HEALTH.indexOf(b.health) || a.name.localeCompare(b.name));
}

/**
 * Each signed-in account of a provider's apps, with the other apps a revoke
 * of it would end too: every workspace's channel connections count,
 * as the provider's grant is the person's, not a workspace's.
 */
async function withKeptBy(context: AppsContext, apps: readonly ConnectableApp[]): Promise<ConnectableApp[]> {
  const store = createLocalCredentialStore(context.dataDirectory);
  // A client id that cannot be read is unknown, which revocation takes as the same project as any other: the safe side.
  const read = async (reference: string): Promise<string | undefined> => (await store.getSecret(reference).catch(() => null)) ?? undefined;
  const shared = new Map<string, string | undefined>();
  const sharedId = async (provider: string): Promise<string | undefined> => {
    if (!shared.has(provider)) shared.set(provider, await read(oauthClientCredentialRefs(provider).id));
    return shared.get(provider);
  };
  const grants = new Map<string, ProviderGrant[]>();
  const add = (provider: string, grant: ProviderGrant): void => void grants.set(provider, [...(grants.get(provider) ?? []), grant]);
  for (const workspaceId of context.workspaceIds()) {
    for (const record of await context.connections(workspaceId)) {
      const provider = sharedProviderOf(record.providerId);
      if (provider === undefined || record.deletedAt !== undefined || record.credentialRefs["oauth"] === undefined) continue;
      // A channel of a provider whose apps share a client signs in with that client only.
      const clientId = await sharedId(provider);
      // Named by its connection, as two of the same app (another workspace's Gmail) would read alike by app.
      const app = context.descriptorOf(record.providerId)?.app?.name ?? record.providerId;
      const where = workspaceId === "default" ? "" : ` in ${workspaceId}`;
      add(provider, {
        appName: `${app} (${record.label ?? record.connectionId}${where})`,
        accountId: record.connectionId,
        ...(record.accountIdentity === "" ? {} : { identity: record.accountIdentity }),
        ...(clientId === undefined ? {} : { clientId }),
      });
    }
  }
  return apps.map((app) => {
    const provider = app.auth.kind === "oauth" ? app.auth.provider : undefined;
    const others = provider === undefined ? undefined : grants.get(provider);
    if (provider === undefined || others === undefined) return app;
    const pattern = sharedProviderFacts(provider).clientProjectPattern;
    return {
      ...app,
      accounts: app.accounts.map((account) => {
        const mine = others.find((grant) => grant.accountId === account.accountId);
        const keeps = mine === undefined ? [] : keptBy(mine, others, pattern);
        return keeps.length === 0 ? account : { ...account, keptBy: [...keeps].slice(0, 16) };
      }),
    };
  });
}

const matches = (query: string, ...texts: readonly (string | undefined)[]): boolean => {
  const words = query.trim().toLowerCase();
  return words === "" || texts.some((text) => text?.toLowerCase().includes(words) === true);
};

/** The catalog: Tavi presets, installed apps not yet set up, the channels, then the MCP Registry for a search. */
export async function appsCatalog(
  context: AppsContext,
  input: { readonly query: string; readonly cursor?: string | undefined; readonly workspaceId: string },
): Promise<AppsCatalogAnswer> {
  const apps = await projectApps(context, input.workspaceId);
  const presetEntries: CatalogEntry[] = [];
  for (const id of AVAILABLE_PRESETS) {
    const preset = presetOf(id);
    if (preset === undefined || !matches(input.query, preset.name, preset.description)) continue;
    const installed = apps.find((app) => app.source.preset === id);
    const badges: CatalogBadge[] = ["tavi-preset"];
    if (preset.app?.auth?.kind === "oauth" && preset.app.auth.provider !== undefined) badges.push("own-client");
    if (preset.block.network?.lan === true) badges.push("lan");
    else if (preset.block.transport === "http") badges.push("remote");
    presetEntries.push({
      ref: { kind: "preset", id },
      name: preset.name,
      summary: (preset.app?.summary ?? preset.description).slice(0, 500),
      category: preset.app?.category ?? "other",
      auth: preset.block.auth === "oauth" ? "oauth" : preset.block.auth === "headers" ? "api-key" : "none",
      badges,
      installed: installed !== undefined,
      ...(installed === undefined ? {} : { appId: installed.appId }),
      options: [],
    });
  }
  const installedEntries: CatalogEntry[] = apps
    .filter((app) => app.health === "not-set-up" && app.source.pluginIds.length > 0 && matches(input.query, app.name, app.summary))
    .map((app) => ({
      ref: { kind: "installed", pluginId: app.source.pluginIds[0] as string },
      name: app.name,
      summary: app.summary.slice(0, 500),
      category: app.category,
      auth: app.auth.kind,
      badges:
        app.source.kind === "mcp" && app.source.isolation === "remote"
          ? ["remote"]
          : app.source.isolation === "sandboxed"
            ? ["runs-here"]
            : [],
      installed: true,
      appId: app.appId,
      options: [],
    }));
  const connected = new Set(apps.filter((app) => app.source.kind === "channel").map((app) => app.appId));
  const channelEntries: CatalogEntry[] = context
    .descriptors()
    .filter((descriptor) => matches(input.query, descriptor.label, descriptor.description, descriptor.app?.name))
    .map((descriptor) => {
      const presentation = channelPresentationOf(descriptor);
      const appId = presentation?.id ?? descriptor.providerId;
      const badges: CatalogBadge[] = channelGrantsOf(descriptor.providerId)?.verified === "built-in" ? ["built-in"] : [];
      // The operator brings the OAuth client a channel connects through.
      if (descriptor.auth.kind === "oauth2" && descriptor.auth.oauth.client.source === "operator") badges.push("own-client");
      return {
        ref: { kind: "channel", providerId: descriptor.providerId },
        name: presentation?.name ?? descriptor.label,
        summary: (presentation?.summary ?? descriptor.description).slice(0, 500),
        category: presentation?.category ?? (descriptor.kind === "email" ? "email" : "chat"),
        auth: descriptor.auth.kind === "oauth2" ? "oauth" : descriptor.auth.kind === "secrets" ? "api-key" : "none",
        badges,
        installed: connected.has(appId),
        ...(connected.has(appId) ? { appId } : {}),
        options: [],
      };
    });
  const sections: AppsCatalogAnswer["sections"][number][] = [
    { section: "presets", entries: presetEntries },
    { section: "installed", entries: installedEntries },
    { section: "channels", entries: channelEntries },
  ];
  // The registry is searched for words or a next page only: a plain visit sends no request out.
  if (input.query.trim() === "" && input.cursor === undefined) return { sections };
  const searched = await context.mcp({
    action: "search",
    query: input.query,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  if (!searched.ok)
    return { sections: [...sections, { section: "registry", entries: [] }], registryNote: searched.error.message.slice(0, 300) };
  const discover = (searched.result as { readonly discover: { readonly entries: readonly RegistryEntry[]; readonly next?: string } })
    .discover;
  const registryEntries: CatalogEntry[] = discover.entries
    .filter((entry) => entry.options.length > 0)
    .slice(0, 100)
    .map((entry) => {
      const badges: CatalogBadge[] = ["unreviewed-listing"];
      if (entry.labels.includes("remote")) badges.push("remote");
      if (entry.labels.includes("installable")) badges.push("runs-here");
      const first = entry.options[0] as RegistryEntry["options"][number];
      return {
        ref: { kind: "registry", name: entry.name, version: entry.version, option: first.key },
        name: (entry.title ?? entry.name).slice(0, 256),
        summary: entry.description.slice(0, 500),
        category: "other",
        auth: entry.options.some((option) => option.credentials.length > 0) ? "api-key" : "none",
        badges,
        installed: false,
        options: entry.options.map((option) => option.key).slice(0, 16),
      };
    });
  return {
    sections: [...sections, { section: "registry", entries: registryEntries }],
    ...(discover.next === undefined ? {} : { cursor: discover.next }),
  };
}
