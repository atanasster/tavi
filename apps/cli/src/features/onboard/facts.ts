import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  memoryScopeKey,
  MCP_PLUGIN_PREFIX,
  TasksHomeSchema,
  WEB_SEARCH_CAPABILITIES,
  type AsyncPersistenceRepositories,
  type ConnectableApp,
  type ModelConfigPort,
  type ModelConnection,
} from "@tavi/contracts";
import type { OnboardingLiveFacts, OnboardingModelTarget } from "@tavi/agent-host/onboarding-host";

import { resolveLiveTarget } from "../models/target.js";
import { DEFAULT_SERVICE_LABEL } from "../service/unit.js";

/**
 * Live facts for onboarding's status:
 * read from the services each family already has — models, credentials,
 * search, channels, apps, memory, workspace settings and ideas — never from a
 * remembered wizard step. Every read that fails leaves its step open
 * rather than failing the status.
 */

export interface OnboardingFactSources {
  readonly repositories: Pick<
    AsyncPersistenceRepositories,
    "workspaceSettings" | "memory" | "searchProviders" | "messagingConnections" | "messagingIdentityBindings" | "ideas"
  >;
  readonly modelConfig: ModelConfigPort;
  /** `providerCredentialRevision` of a reference's current secret. */
  readonly credentialRevision: (reference: string) => Promise<string>;
  /** Whether a credential reference resolves to a stored secret. */
  readonly credentialStored: (reference: string) => Promise<boolean>;
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** The connectable apps and their accounts (the `apps list` answer); absent where no owner can list them. */
  readonly apps?: (workspaceId: string) => Promise<readonly ConnectableApp[]>;
  /** The owner was launched with a model provider of its own (`--config` providers), which no stored connection lists. */
  readonly launchedWithModel?: boolean;
  /** The ids of the workspace's active external search instances (an enabled search plugin's); absent offline. */
  readonly externalSearch?: (workspaceId: string) => readonly string[];
  /** The channel kinds an enabled channel plugin registers. */
  readonly channelKinds: () => readonly string[];
  /** Whether the operator has started a chat turn of their own in the workspace. */
  readonly startedTurn: (workspaceId: string) => Promise<boolean>;
  /** The service state: see `serviceState`. */
  readonly service: () => Promise<OnboardingLiveFacts["service"]>;
  /** Voice messages' transcription, from the running owner's voice setup; absent offline, where the step says so. */
  readonly voice?: () => Promise<NonNullable<OnboardingLiveFacts["voice"]>>;
  readonly now: () => Date;
}

const settle = async <T>(read: () => Promise<T>, otherwise: T): Promise<T> => {
  try {
    return await read();
  } catch {
    return otherwise;
  }
};

/** A connection's name as a person reads it. */
const labelOf = (connection: ModelConnection | undefined, connectionId: string): string => connection?.label ?? connectionId;

/** A connection and model as a verify checks them: its endpoint and its key's revision now; undefined when no such connection exists. */
export async function onboardingModelTarget(
  sources: Pick<OnboardingFactSources, "modelConfig" | "credentialRevision">,
  connectionId: string,
  model: string,
): Promise<OnboardingModelTarget | undefined> {
  const connection = (await settle(async () => await sources.modelConfig.listConnections(), [] as readonly ModelConnection[])).find(
    (candidate) => candidate.connectionId === connectionId,
  );
  return connection === undefined ? undefined : await modelTarget(sources, connection, connectionId, model);
}

async function modelTarget(
  sources: Pick<OnboardingFactSources, "credentialRevision">,
  connection: ModelConnection | undefined,
  connectionId: string,
  model: string,
): Promise<OnboardingModelTarget> {
  const base = { connectionId, model, baseUrl: connection?.baseUrl ?? "", label: labelOf(connection, connectionId) };
  if (connection?.providerBinding !== undefined) return { ...base, providedBy: connection.providerBinding.instanceId };
  if (connection === undefined) return base;
  const revision = await settle(async () => await sources.credentialRevision(connection.credentialRef), undefined);
  return revision === undefined ? base : { ...base, credentialRevision: revision };
}

async function modelFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts["model"]> {
  const connections = await settle(async () => await sources.modelConfig.listConnections(), [] as readonly ModelConnection[]);
  // A provider the owner was launched with is a model connection too: such an install is never a first run.
  const hasConnection = connections.length > 0 || sources.launchedWithModel === true;
  const byId = new Map(connections.map((connection) => [connection.connectionId, connection]));
  const resolved = await settle(async () => (await resolveLiveTarget(sources.modelConfig, { workspaceId }))?.target, undefined);
  // A default a failed test marked unavailable no longer resolves, but it is still the one configured: its advice shows.
  const configured =
    resolved ??
    (await settle(
      async () =>
        ((await sources.modelConfig.getWorkspaceDefault(workspaceId)) ?? (await sources.modelConfig.getWorkspaceDefault("default")))
          ?.target,
      undefined,
    ));
  const main = configured?.model === undefined ? undefined : { connectionId: configured.connectionId, model: configured.model };
  if (main === undefined) return { hasConnection };
  const mainTarget = await modelTarget(sources, byId.get(main.connectionId), main.connectionId, main.model);
  const fast = await settle(async () => (await sources.modelConfig.resolveRole({ workspaceId, role: "fast" })).target, undefined);
  const distinct = fast !== undefined && (fast.connectionId !== main.connectionId || fast.model !== main.model);
  return {
    hasConnection,
    main: mainTarget,
    ...(distinct ? { fast: await modelTarget(sources, byId.get(fast.connectionId), fast.connectionId, fast.model) } : {}),
  };
}

async function aboutFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts["about"]> {
  const settings = await settle(async () => (await sources.repositories.workspaceSettings.get(workspaceId)).settings, {});
  const principalId = sources.principalOf(workspaceId);
  const namePreference =
    principalId === undefined
      ? false
      : await settle(async () => {
          const holders = await sources.repositories.memory.keyHolders({
            scopeKey: memoryScopeKey({ kind: "personal", principalId }),
            kind: "preference",
            key: "user.name",
            now: sources.now().toISOString(),
          });
          return holders.some((record) => record.status === "approved");
        }, false);
  return { ...(settings.operatorName === undefined ? {} : { operatorName: settings.operatorName }), namePreference };
}

async function searchFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts["search"]> {
  const { providers } = await settle(async () => await sources.repositories.searchProviders.list(), { providers: [], unreadable: [] });
  const ready = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    // Keyless: Tavily without a key, or a self-hosted instance (SearXNG), which takes only its address.
    const capabilities = WEB_SEARCH_CAPABILITIES[provider.kind];
    const keyless = provider.credentialRef === undefined && (capabilities.supportsKeyless || capabilities.selfHosted);
    const reference = provider.credentialRef;
    if (keyless || (reference !== undefined && (await settle(async () => await sources.credentialStored(reference), false))))
      ready.push({ id: provider.providerId, label: provider.providerId });
  }
  // An enabled search plugin's instance answers once active: its key, if any, is the plugin's to check.
  for (const id of await settle(async () => sources.externalSearch?.(workspaceId) ?? [], [] as readonly string[]))
    ready.push({ id, label: id });
  // The built-in kinds are always installed.
  return { installed: true, ready };
}

async function appFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts["apps"]> {
  if (sources.apps === undefined) return { available: [], connected: [] };
  // A channel is the channels step's; an app here is one the agent reads and acts in.
  const apps = (await settle(async () => (await sources.apps?.(workspaceId)) ?? [], [] as readonly ConnectableApp[])).filter(
    (app) => app.source.kind !== "channel",
  );
  return {
    available: apps.map((app) => ({ id: app.appId, label: app.name })),
    connected: apps
      .filter((app) => app.accounts.some((account) => account.health === "ready" && account.workspaces.includes(workspaceId)))
      .map((app) => ({ id: app.appId, label: app.name })),
  };
}

async function channelFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts["channels"]> {
  const [connections, bindings] = await Promise.all([
    settle(async () => (await sources.repositories.messagingConnections.list(workspaceId)).filter((connection) => connection.enabled), []),
    settle(async () => await sources.repositories.messagingIdentityBindings.list(workspaceId), []),
  ]);
  const bound = new Set(bindings.map((binding) => binding.connectionId));
  return {
    available: sources.channelKinds().length > 0,
    // Named as the person knows it: its label, else the account it speaks as (a bot's name), never its internal id when either is set.
    connections: connections.map((connection) => ({
      id: connection.connectionId,
      label: connection.label ?? (connection.accountIdentity.trim() === "" ? connection.connectionId : connection.accountIdentity),
      paired: bound.has(connection.connectionId),
    })),
  };
}

async function ideaFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts["ideas"]> {
  const [tried, startedTurn] = await Promise.all([
    settle(
      async () =>
        (await sources.repositories.ideas.list({ workspaceId, now: sources.now().toISOString(), includeInactive: true })).some(
          (idea) => idea.status === "tried" || idea.status === "done",
        ),
      false,
    ),
    settle(async () => await sources.startedTurn(workspaceId), false),
  ]);
  return { tried, startedTurn };
}

/**
 * The tasks step's facts: the `tasks.home` saved (none while the default
 * stands) and the task apps added as MCP servers, each by the home it would
 * be (`mcp:<server>`), connected when an account of it is ready here.
 */
async function taskFacts(sources: OnboardingFactSources, workspaceId: string): Promise<NonNullable<OnboardingLiveFacts["tasks"]>> {
  const [settings, listed] = await Promise.all([
    settle(async () => (await sources.repositories.workspaceSettings.get(workspaceId)).settings, {} as { readonly tasksHome?: string }),
    settle(async () => (await sources.apps?.(workspaceId)) ?? [], [] as readonly ConnectableApp[]),
  ]);
  const apps = listed
    .filter((app) => app.category === "tasks" && app.source.kind === "mcp")
    .flatMap((app) =>
      app.accounts
        .filter((account) => account.accountId.startsWith(MCP_PLUGIN_PREFIX))
        .map((account) => ({
          id: `mcp:${account.accountId.slice(MCP_PLUGIN_PREFIX.length)}`,
          label: app.accounts.length > 1 ? `${app.name} (${account.identity ?? account.label})` : app.name,
          connected: account.health === "ready" && account.workspaces.includes(workspaceId),
        })),
    )
    .filter((app) => TasksHomeSchema.safeParse(app.id).success);
  return { ...(settings.tasksHome === undefined ? {} : { home: settings.tasksHome }), apps };
}

/** Every family's live facts for one workspace. */
export async function liveOnboardingFacts(sources: OnboardingFactSources, workspaceId: string): Promise<OnboardingLiveFacts> {
  const voiceSource = sources.voice;
  const [model, about, search, apps, channels, service, ideas, tasks, voice] = await Promise.all([
    modelFacts(sources, workspaceId),
    aboutFacts(sources, workspaceId),
    searchFacts(sources, workspaceId),
    appFacts(sources, workspaceId),
    channelFacts(sources, workspaceId),
    settle(sources.service, { supported: false, running: false, installed: false }),
    ideaFacts(sources, workspaceId),
    taskFacts(sources, workspaceId),
    voiceSource === undefined ? undefined : settle(voiceSource, undefined),
  ]);
  return { model, about, search, apps, channels, service, ideas, tasks, ...(voice === undefined ? {} : { voice }) };
}

/** Where a unit for `label` lives, user scope first: read, never spawned for. */
export function serviceUnitPaths(platform: NodeJS.Platform, label: string, home: string = homedir()): readonly string[] {
  if (platform === "darwin")
    return [join(home, "Library", "LaunchAgents", `${label}.plist`), join("/Library", "LaunchDaemons", `${label}.plist`)];
  if (platform === "linux")
    return [join(home, ".config", "systemd", "user", `${label}.service`), join("/etc", "systemd", "system", `${label}.service`)];
  return [];
}

/** Whether a rendered unit starts `serve` on `dataDirectory`: `--data-dir` and the directory, as `renderServiceUnit` writes them. */
export function unitNamesDataDirectory(text: string, dataDirectory: string): boolean {
  if (!text.includes("--data-dir")) return false;
  const escaped = dataDirectory.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return (
    text.includes(`<string>${escaped}</string>`) ||
    new RegExp(`--data-dir[= ]"?${dataDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"?(\\s|$)`, "mu").test(text)
  );
}

/**
 * The service step's facts: `running` only from the owner's own
 * environment (an offline CLI cannot know), `installed` when a unit with the
 * label this flow wrote — else the default — names this data directory.
 */
export async function serviceState(input: {
  readonly platform: NodeJS.Platform;
  readonly dataDirectory: string;
  /** The owner's own `process.env.TAVI_SERVICE === "1"`; false for an offline CLI. */
  readonly ownerIsService: boolean;
  /** The label the service step recorded as created, if any. */
  readonly label?: string;
  readonly home?: string;
}): Promise<OnboardingLiveFacts["service"]> {
  const supported = input.platform === "darwin" || input.platform === "linux";
  if (!supported) return { supported, running: false, installed: false };
  let installed = false;
  for (const path of serviceUnitPaths(input.platform, input.label ?? DEFAULT_SERVICE_LABEL, input.home)) {
    // A unit file that cannot be read is not taken as this data directory's.
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined && unitNamesDataDirectory(text, input.dataDirectory)) {
      installed = true;
      break;
    }
  }
  return { supported, running: input.ownerIsService, installed };
}
