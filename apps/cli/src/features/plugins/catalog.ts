import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  modHookViewsOf,
  type BuiltinPluginInfo,
  type BuiltinRouterProvider,
  type ChannelDescriptor,
  type ChannelHostServices,
  type ChannelCalendarKit,
  type ChannelMailboxKit,
  type MessagingConnectorDefinition,
  type ModsDeclaration,
  type PluginView,
} from "@tavi/contracts";
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";
import { CORE_EN } from "@tavi/contracts/locales/core-en";
import { BROWSER_VIEW_MANIFEST } from "@tavi/plugin-browser-view/manifest";
import { gmailChannel } from "@tavi/plugin-gmail/channel";
import { mailgunChannel } from "@tavi/plugin-mailgun/channel";
import { JEV_ROUTER } from "@tavi/plugin-router";
import { telegramChannel } from "@tavi/plugin-telegram/channel";
import { hashPluginDirectory } from "@tavi/runtime";

import { GUARD_MODS, GUARD_PLUGIN_ID, guardMods } from "@tavi/plugin-guard/manifest";

import { COLLECTORS_PLUGIN_ID } from "../collectors/host.js";
import { SITE_SKILLS_PLUGIN_ID } from "../browser/site-skills-host.js";
import { FLIGHTS_PLUGIN_ID } from "../flights/host.js";

/** The plugin that opens every installed channel's saved connections: core, since every channel plugin needs it. */
export const CHANNEL_HOST_PLUGIN_ID = "tavi.channelhost";

/** The engines a person may turn off: each one's tools are offered while it is enabled. */
export const BROWSER_ENGINE_PLUGIN_ID = "tavi.browser";
/** Desktop control: experimental, macOS only, off until enabled. */
export const DESKTOP_PLUGIN_ID = "tavi.desktop";
export const PDF_ENGINE_PLUGIN_ID = "tavi.pdf";
export const VIDEO_ENGINE_PLUGIN_ID = "tavi.video";

/** A built-in's description, as the catalogue says it in English (`plugins.catalog.<id>`). */
function said(pluginId: string): string {
  return coreEnglish(`plugins.catalog.${pluginId}` as CoreKey);
}

/**
 * The plugins this build composes, as `tavi plugins list` and the
 * Plugins settings page present them. `core` cannot be disabled: it provides a
 * service another plugin depends on, or it is the confinement every plugin runs
 * under (`tavi.sandbox`, `tavi.limits`, `tavi.worker`). The others can be
 * switched off; composition leaves a disabled one out.
 * `test/plugins.test.ts` pins this list against what composition composes.
 */
export const BUILTIN_PLUGINS: readonly BuiltinPluginInfo[] = [
  // Composed beside the external plugins (`runtime/external-plugins.ts`), since it waits on what they provide.
  { id: "tavi.providerreadiness", description: said("tavi.providerreadiness"), core: true },
  { id: "tavi.providers", description: said("tavi.providers"), core: true },
  { id: "tavi.logger", description: said("tavi.logger"), core: true },
  { id: "tavi.persistence", description: said("tavi.persistence"), core: true },
  { id: "tavi.tools", description: said("tavi.tools"), core: true },
  { id: "tavi.access", description: said("tavi.access"), core: true },
  { id: "tavi.clock", description: said("tavi.clock"), core: true },
  { id: "tavi.router", description: said("tavi.router"), core: false },
  { id: "tavi.models", description: said("tavi.models"), core: true },
  { id: "tavi.workflow", description: said("tavi.workflow"), core: true },
  { id: "tavi.retention", description: said("tavi.retention"), core: false },
  { id: "tavi.agentwaitscheduler", description: said("tavi.agentwaitscheduler"), core: false },
  { id: "tavi.schedules", description: said("tavi.schedules"), core: false },
  { id: "tavi.ideas", description: said("tavi.ideas"), core: false },
  { id: "tavi.heartbeat", description: said("tavi.heartbeat"), core: false },
  { id: "tavi.heartbeatagent", description: said("tavi.heartbeatagent"), core: false },
  { id: "tavi.ideasagent", description: said("tavi.ideasagent"), core: false },
  { id: "tavi.onboarding", description: said("tavi.onboarding"), core: false },
  { id: "tavi.heartbeatsignals", description: said("tavi.heartbeatsignals"), core: false },
  { id: "tavi.memoryprovider", description: said("tavi.memoryprovider"), core: false },
  { id: "tavi.memory", description: said("tavi.memory"), core: false },
  { id: "tavi.reminderrule", description: said("tavi.reminderrule"), core: false },
  { id: "tavi.reminders", description: said("tavi.reminders"), core: false },
  { id: "tavi.tasksummaries", description: said("tavi.tasksummaries"), core: false },
  { id: "tavi.localmessaging", description: said("tavi.localmessaging"), core: true },
  { id: CHANNEL_HOST_PLUGIN_ID, description: said("tavi.channelhost"), core: true },
  // The built-in channels, each its own plugin: disabled, its channel is not installed, and a plugin may take its place.
  { id: "tavi.telegram", description: said("tavi.telegram"), core: false },
  { id: "tavi.mailgun", description: said("tavi.mailgun"), core: false },
  { id: "tavi.gmail", description: said("tavi.gmail"), core: false },
  // Domain tools: composed with the owner's tools, left out while disabled.
  { id: FLIGHTS_PLUGIN_ID, description: said("tavi.flights"), core: false },
  { id: BROWSER_ENGINE_PLUGIN_ID, description: said("tavi.browser"), core: false },
  { id: PDF_ENGINE_PLUGIN_ID, description: said("tavi.pdf"), core: false },
  { id: VIDEO_ENGINE_PLUGIN_ID, description: said("tavi.video"), core: false },
  { id: "tavi.sandbox", description: said("tavi.sandbox"), core: true },
  { id: "tavi.limits", description: said("tavi.limits"), core: true },
  { id: "tavi.worker", description: said("tavi.worker"), core: true },
  { id: SITE_SKILLS_PLUGIN_ID, description: said("tavi.siteskills"), core: false },
  { id: COLLECTORS_PLUGIN_ID, description: said("tavi.collectors"), core: false },
  // Experimental: off until enabled, macOS only.
  {
    id: DESKTOP_PLUGIN_ID,
    description: said("tavi.desktop"),
    core: false,
    enabledByDefault: false,
  },
  // A first-party mod: off until enabled; its hooks join the turn while it is on.
  {
    id: GUARD_PLUGIN_ID,
    description: said("tavi.guard"),
    core: false,
    enabledByDefault: false,
    mods: GUARD_MODS,
  },
  // UI only: nothing composes it; the canvas frames it.
  { id: BROWSER_VIEW_MANIFEST.id, description: BROWSER_VIEW_MANIFEST.description, core: false, uiOnly: true, ui: BROWSER_VIEW_MANIFEST.ui },
];

/** The built-ins whose hooks a person reads a disclosure of, by the language it is read in. */
const BUILTIN_MODS_IN: Readonly<Record<string, (t: CoreT) => ModsDeclaration>> = { [GUARD_PLUGIN_ID]: guardMods };

/**
 * A built-in's listing in `t`'s words: its description and its hooks'
 * disclosures, for the canvas's plugin list and detail. Any other view, or a
 * built-in the catalogue has no words for (one whose UI is its own manifest's),
 * is as listed.
 */
export function builtinViewIn(view: PluginView, t: CoreT): PluginView {
  if (view.kind !== "builtin") return view;
  const key = `plugins.catalog.${view.id}`;
  const mods = BUILTIN_MODS_IN[view.id];
  return {
    ...view,
    ...(Object.hasOwn(CORE_EN, key) ? { description: t(key as CoreKey) } : {}),
    ...(mods === undefined || view.mods === undefined ? {} : { mods: modHookViewsOf(mods(t), t) }),
  };
}

/**
 * A built-in channel's descriptor in `t`'s words; `undefined` for a provider
 * id no built-in channel of this build has.
 */
export function builtinChannelDescriptorIn(providerId: string, t: CoreT): ChannelDescriptor | undefined {
  const channel = BUILTIN_CHANNELS.find((candidate) => candidate.descriptor.providerId === providerId);
  return channel?.descriptorIn?.(t);
}

/** A channel this build ships: its descriptor, its connector made for an owner, and the mailbox its accounts' tools use, if its app is one. */
export interface BuiltinChannel {
  /** The built-in plugin that installs it: disabled, the channel is not installed and its provider id is free. */
  readonly pluginId: string;
  readonly descriptor: ChannelDescriptor;
  /** Its descriptor in a language's words, for a person's screens (channel setup, Connected apps). */
  readonly descriptorIn?: (t: CoreT) => ChannelDescriptor;
  /** Its connector, made with the services every channel gets, builtin or a plugin's (`ChannelHostServices`). */
  readonly connector: (host: ChannelHostServices<typeof globalThis.fetch>) => MessagingConnectorDefinition;
  readonly mailbox?: ChannelMailboxKit<typeof globalThis.fetch>;
  readonly calendar?: ChannelCalendarKit<typeof globalThis.fetch>;
}

/**
 * The messaging channels this build ships, each its own built-in plugin,
 * loaded through the same registration a channel plugin's go through, with
 * builtin trust. `features/channels/catalog.ts` is how the rest of the owner
 * reads the ones installed.
 */
export const BUILTIN_CHANNELS: readonly BuiltinChannel[] = [
  { pluginId: "tavi.telegram", ...telegramChannel },
  { pluginId: "tavi.mailgun", ...mailgunChannel },
  { pluginId: "tavi.gmail", ...gmailChannel },
];

export const BUILTIN_CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = BUILTIN_CHANNELS.map((channel) => channel.descriptor);

/**
 * The routing providers this build ships, as the owner knows them without
 * running them: their settings' schema, price sheet and readiness. The router's
 * commands and `doctor` read them here and name no provider of their own.
 */
export const BUILTIN_ROUTER_PROVIDERS: readonly BuiltinRouterProvider[] = [JEV_ROUTER];

/** A built-in routing provider by plugin id; undefined for any other. */
export function builtinRouterProvider(providerId: string): BuiltinRouterProvider | undefined {
  return BUILTIN_ROUTER_PROVIDERS.find((provider) => provider.id === providerId);
}

/** The built-in onboarding flow's provider (`tavi.onboarding`), for `tavi onboard` offline, as the owner's composition installs it. */
export { createBuiltinOnboardingProvider } from "@tavi/plugin-defaults/onboarding";

/**
 * The catalog with each UI built-in's content hash, read from the canvas
 * build that ships it (`<canvas>/plugins/<id>/`): what its `/plugin-ui/`
 * address names, and what the bridge checks its files against. A built-in
 * whose files are not there — no canvas built — gets no hash, so the canvas
 * is never offered it.
 */
export function builtinPluginsWithUi(
  canvasDirectory: string | undefined,
  plugins: readonly BuiltinPluginInfo[] = BUILTIN_PLUGINS,
): readonly BuiltinPluginInfo[] {
  return plugins.map((plugin) => {
    if (plugin.ui === undefined || canvasDirectory === undefined) return plugin;
    const directory = join(canvasDirectory, "plugins", plugin.id);
    // Not built: never offered. Files that are there but cannot be hashed are a broken install, and said so.
    if (!existsSync(directory)) return plugin;
    return { ...plugin, uiContentHash: hashPluginDirectory(directory).hash };
  });
}
