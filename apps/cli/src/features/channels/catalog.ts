import { TaviError, type ChannelCalendarKit, type ChannelDescriptor, type ChannelMailboxKit, type PersistencePort } from "@tavi/contracts";

import { BUILTIN_CHANNELS } from "../plugins/catalog.js";

/**
 * The channels this owner knows: every registered
 * descriptor by provider id. Core names, classes and validates a channel only
 * through here, never by a provider's name or a connection id's prefix.
 * Each channel's plugin registers it when it starts, a built-in channel's
 * (`tavi.telegram`, …) as a plugin's, and takes it out when it stops; nothing
 * is registered while its plugin is disabled.
 */
const descriptors = new Map<string, ChannelDescriptor>();

/** The plugin that registered each plugin channel, by provider id: its Connected apps source. */
const registeringPlugins = new Map<string, string>();

/**
 * The built-in channels registered, by provider id, with how many registrations hold each: one process may compose
 * more than one owner (the tests do), and each registers the channels its own plugins install.
 */
const builtinHolds = new Map<string, number>();

/** The approved version of the plugin that registered each plugin channel, by provider id. */
const registeringVersions = new Map<string, string>();

/** The mailbox a plugin's channel ships, by provider id: kept only for one whose reviewed descriptor declares `app.mailbox`. */
const pluginMailboxes = new Map<string, ChannelMailboxKit<typeof globalThis.fetch>>();

/**
 * Registers a plugin's channel, with the mailbox it ships; refused while another, a built-in or a plugin, holds
 * its provider id.
 */
export function registerChannelDescriptor(
  descriptor: ChannelDescriptor,
  pluginId?: string,
  mailbox?: ChannelMailboxKit<typeof globalThis.fetch>,
  version?: string,
): void {
  if (descriptors.has(descriptor.providerId))
    throw new TaviError("DUPLICATE", `A channel for provider ${descriptor.providerId} is already registered`);
  descriptors.set(descriptor.providerId, descriptor);
  if (pluginId !== undefined) registeringPlugins.set(descriptor.providerId, pluginId);
  if (pluginId !== undefined && version !== undefined) registeringVersions.set(descriptor.providerId, version);
  if (mailbox !== undefined && descriptor.app?.mailbox === true) pluginMailboxes.set(descriptor.providerId, mailbox);
}

/** Withdraws a channel a plugin registered (it stopped). A built-in channel leaves only through its own withdrawal. */
export function unregisterChannelDescriptor(providerId: string): void {
  if (isBuiltinChannel(providerId)) return;
  descriptors.delete(providerId);
  registeringPlugins.delete(providerId);
  registeringVersions.delete(providerId);
  pluginMailboxes.delete(providerId);
}

/**
 * Registers a channel this build ships, as its built-in plugin starts; the function returned withdraws this
 * registration, and the channel leaves once none holds it. Refused while a plugin's channel holds the provider id.
 */
export function registerBuiltinChannelDescriptor(descriptor: ChannelDescriptor): () => void {
  const held = builtinHolds.get(descriptor.providerId) ?? 0;
  if (held === 0) {
    if (descriptors.has(descriptor.providerId))
      throw new TaviError("DUPLICATE", `A channel for provider ${descriptor.providerId} is already registered`);
    descriptors.set(descriptor.providerId, descriptor);
  }
  builtinHolds.set(descriptor.providerId, held + 1);
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    const left = (builtinHolds.get(descriptor.providerId) ?? 1) - 1;
    if (left > 0) {
      builtinHolds.set(descriptor.providerId, left);
      return;
    }
    builtinHolds.delete(descriptor.providerId);
    descriptors.delete(descriptor.providerId);
  };
}

/** The built-in channels whose plugins this data directory has enabled (every one, until one is disabled), registered. */
export async function registerBuiltinChannelsOf(repositories: Pick<PersistencePort["repositories"], "plugins">): Promise<() => void> {
  const settings = new Map((await repositories.plugins.listSettings()).settings.map((setting) => [setting.pluginId, setting.enabled]));
  return registerEnabledBuiltinChannels((pluginId) => settings.get(pluginId) !== false);
}

/**
 * For a reader without the owner (`tavi channels`, bindings, an offline context): the built-in channels whose
 * plugins are enabled, registered as an owner's start would, before any plugin's channel is.
 */
export function registerEnabledBuiltinChannels(enabled: (pluginId: string) => boolean): () => void {
  const releases: (() => void)[] = [];
  for (const channel of BUILTIN_CHANNELS)
    if (enabled(channel.pluginId) && !builtinHolds.has(channel.descriptor.providerId) && !descriptors.has(channel.descriptor.providerId))
      releases.push(registerBuiltinChannelDescriptor(channel.descriptor));
  return () => {
    for (const release of releases) release();
  };
}

/** The plugin a channel came from; `undefined` for a builtin one. */
export function channelPluginOf(providerId: string): string | undefined {
  return registeringPlugins.get(providerId);
}

/** The approved version of the plugin a channel came from, when it registered with one. */
export function channelPluginVersionOf(providerId: string): string | undefined {
  return registeringVersions.get(providerId);
}

/**
 * Whether the channel registered for a provider id is one this build ships, registered by its built-in plugin: a
 * plugin that took the id while that built-in is disabled is not.
 */
export function isBuiltinChannel(providerId: string): boolean {
  return builtinHolds.has(providerId);
}

/** The owner setting naming, per shared provider, the channel plugin the operator lets use its OAuth client. */
export const CHANNELS_SHARED_CLIENTS_SETTING = "channels.sharedClients";

/** A shared provider's client bound to one approved version of a channel plugin: another version, or another plugin under its id, is not. */
export interface SharedClientBinding {
  readonly pluginId: string;
  readonly version: string;
}

/** The operator's bindings of a shared provider's client to a channel plugin, as last read or saved. */
let sharedClientBindings: ReadonlyMap<string, SharedClientBinding> = new Map();

/** Each provider's binding, read from the setting's JSON; anything else in it is ignored. */
export function parseSharedClients(raw: string | undefined): ReadonlyMap<string, SharedClientBinding> {
  try {
    const value: unknown = raw === undefined ? {} : JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
    return new Map(
      Object.entries(value).flatMap(([provider, binding]: [string, unknown]) => {
        if (typeof binding !== "object" || binding === null) return [];
        const { pluginId, version } = binding as Record<string, unknown>;
        return typeof pluginId === "string" && typeof version === "string" ? [[provider, { pluginId, version }] as const] : [];
      }),
    );
  } catch {
    return new Map();
  }
}

/**
 * The owner setting listing the reverse proxies, besides one on this machine, whose `X-Forwarded-For` the webhook
 * ingress believes (`tavi channels ingress --trusted-proxies`): a JSON array of addresses and CIDR ranges.
 */
export const CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING = "channels.ingressTrustedProxies";

/** The trusted proxies, read from the setting's JSON; anything but a list of strings reads as none. */
export function parseTrustedProxies(raw: string | undefined): readonly string[] {
  try {
    const value: unknown = raw === undefined ? [] : JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Takes the bindings this owner (or an offline reader) honours from now on. */
export function setSharedClientBindings(bindings: ReadonlyMap<string, SharedClientBinding>): void {
  sharedClientBindings = new Map(bindings);
}

/** The hosts a URL is on, or none for one that does not parse. */
const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Whether a plugin channel's OAuth endpoints are its shared provider's own: the hosts this build's channels of that
 * provider sign in at (Gmail's, for Google). The shared client's secret goes to a channel's token address, so a
 * channel at any other host is never handed it, bound or not.
 */
export function signsInAtProvider(descriptor: ChannelDescriptor, provider: string): boolean {
  const spec = descriptor.auth.kind === "oauth2" ? descriptor.auth.oauth : undefined;
  if (spec === undefined) return false;
  const own = new Set(
    BUILTIN_CHANNELS.flatMap((channel) => {
      const shipped = channel.descriptor.auth.kind === "oauth2" ? channel.descriptor.auth.oauth : undefined;
      if (channel.descriptor.app?.provider !== provider || shipped === undefined) return [];
      return [shipped.authorizeUrl, shipped.tokenUrl, shipped.revokeUrl, shipped.deviceAuthorizationUrl].flatMap(
        (url) => hostOf(url) ?? [],
      );
    }),
  );
  const asked = [spec.authorizeUrl, spec.tokenUrl, spec.revokeUrl, spec.deviceAuthorizationUrl].filter((url) => url !== undefined);
  return own.size > 0 && asked.every((url) => own.has(hostOf(url) ?? ""));
}

/** What a registered channel may do beyond carrying messages, by who shipped it and what the operator granted. */
export interface ChannelGrants {
  /** The shared provider whose OAuth client it connects with. */
  readonly provider?: string;
  /** Its accounts are mailboxes the agent's tools may use (each still by its own opt-in). */
  readonly mailbox: boolean;
  /** Its accounts have calendars the agent's tools may use (each still by its own opt-in): only a built-in's. */
  readonly calendar: boolean;
  /** The class its accounts start in: a plugin's is never below `personal`. */
  readonly dataClass?: "public" | "personal";
  /** How Connected apps badges it: one this build ships, or a reviewed plugin's. */
  readonly verified: "built-in" | "reviewed";
}

/**
 * The privileges a registered channel holds. A built-in channel's descriptor is trusted as shipped. A plugin's
 * descriptor was reviewed with its version, and that review is the grant: its `app.mailbox` holds when it registered a
 * mailbox to go with it, and its `app.provider` only once the operator bound that provider's client to this version
 * of the plugin (`tavi channels share-client`), and only while it signs in at that provider's own hosts. Its accounts never start `public`: that label would lower what egress guards.
 */
export function channelGrantsOf(providerId: string | undefined): ChannelGrants | undefined {
  const descriptor = channelDescriptorOf(providerId);
  if (providerId === undefined || descriptor === undefined) return undefined;
  const app = descriptor.app;
  if (isBuiltinChannel(providerId))
    return {
      ...(app?.provider === undefined ? {} : { provider: app.provider }),
      mailbox: app?.mailbox === true && mailboxKitOf(providerId) !== undefined,
      calendar: app?.calendar === true && calendarKitOf(providerId) !== undefined,
      ...(app?.dataClass === undefined ? {} : { dataClass: app.dataClass }),
      verified: "built-in",
    };
  const binding = app?.provider === undefined ? undefined : sharedClientBindings.get(app.provider);
  const bound =
    app?.provider !== undefined &&
    binding !== undefined &&
    binding.pluginId === registeringPlugins.get(providerId) &&
    binding.version === registeringVersions.get(providerId) &&
    signsInAtProvider(descriptor, app.provider);
  return {
    ...(bound && app?.provider !== undefined ? { provider: app.provider } : {}),
    mailbox: app?.mailbox === true && pluginMailboxes.has(providerId),
    calendar: false,
    ...(app?.dataClass === "personal" ? { dataClass: "personal" as const } : {}),
    verified: "reviewed",
  };
}

/** The mailbox a registered channel ships: a built-in's from this build, a plugin's as it registered it. */
export function mailboxKitOf(providerId: string): ChannelMailboxKit<typeof globalThis.fetch> | undefined {
  if (isBuiltinChannel(providerId)) return BUILTIN_CHANNELS.find((channel) => channel.descriptor.providerId === providerId)?.mailbox;
  return channelDescriptorOf(providerId)?.app?.mailbox === true ? pluginMailboxes.get(providerId) : undefined;
}

/** The calendar a built-in channel ships for its accounts: a plugin's channel ships none. */
export function calendarKitOf(providerId: string): ChannelCalendarKit<typeof globalThis.fetch> | undefined {
  return isBuiltinChannel(providerId)
    ? BUILTIN_CHANNELS.find((channel) => channel.descriptor.providerId === providerId)?.calendar
    : undefined;
}

/** Every channel this owner can configure, in the order registered. */
export function channelDescriptors(): readonly ChannelDescriptor[] {
  return [...descriptors.values()];
}

export function channelDescriptorOf(providerId: string | undefined): ChannelDescriptor | undefined {
  return providerId === undefined ? undefined : descriptors.get(providerId);
}

/** What a person calls the channel a provider is; `undefined` for one no descriptor names. */
export function channelLabelOf(providerId: string | undefined): string | undefined {
  return channelDescriptorOf(providerId)?.label;
}

/**
 * Every connection's provider this data directory has recorded: its saved
 * connections, and the connections its conversations were held on — how a
 * reader without the owner names a connection's channel.
 */
export async function recordedConnectionProviders(
  repositories: Pick<PersistencePort["repositories"], "messagingConnections" | "messagingConversations">,
): Promise<ReadonlyMap<string, string>> {
  const providers = new Map<string, string>();
  for (const { connectionId, providerId } of await repositories.messagingConversations.connectionProviders())
    providers.set(connectionId, providerId);
  for (const connection of await repositories.messagingConnections.list(undefined, { includeDeleted: true }))
    providers.set(connection.connectionId, connection.providerId);
  return providers;
}
