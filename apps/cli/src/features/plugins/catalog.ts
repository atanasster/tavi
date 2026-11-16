import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  BuiltinPluginInfo,
  BuiltinRouterProvider,
  ChannelDescriptor,
  ChannelHostServices,
  ChannelCalendarKit,
  ChannelMailboxKit,
  MessagingConnectorDefinition,
} from "@tavi/contracts";
import { BROWSER_VIEW_MANIFEST } from "@tavi/plugin-browser-view/manifest";
import { gmailChannel } from "@tavi/plugin-gmail/channel";
import { mailgunChannel } from "@tavi/plugin-mailgun/channel";
import { JEV_ROUTER } from "@tavi/plugin-router";
import { telegramChannel } from "@tavi/plugin-telegram/channel";
import { hashPluginDirectory } from "@tavi/runtime";

import { GUARD_MODS, GUARD_PLUGIN_ID } from "@tavi/plugin-guard/manifest";

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
  { id: "tavi.providerreadiness", description: "Activates reviewed provider instances before admissions open.", core: true },
  { id: "tavi.providers", description: "Account-scoped search, fetch and model provider factories.", core: true },
  { id: "tavi.logger", description: "Structured logging for every other plugin.", core: true },
  { id: "tavi.persistence", description: "The SQLite store and data-directory ownership.", core: true },
  { id: "tavi.tools", description: "The tool registry the workflow offers to models.", core: true },
  { id: "tavi.access", description: "Workspace access policy and permission checks.", core: true },
  { id: "tavi.clock", description: "The shared clock.", core: true },
  {
    id: "tavi.router",
    description: "Jev (TypeSafe) routing provider. Routing stays off until configured with `tavi router`.",
    core: false,
  },
  { id: "tavi.models", description: "Model connections (composed when a model connection is configured).", core: true },
  { id: "tavi.workflow", description: "The task workflow engine (composed when a model connection is configured).", core: true },
  { id: "tavi.retention", description: "Six-hourly retention sweep of finished transport rows (serve only).", core: false },
  { id: "tavi.agentwaitscheduler", description: "Wakes tasks waiting on agent replies.", core: false },
  { id: "tavi.schedules", description: "Fires recurring unattended schedules.", core: false },
  {
    id: "tavi.ideas",
    description:
      "The ideas host: looks for new ideas once a day inside each workspace's hours, and answers /ideas (serve only). Disabling it stops the daily run; a refresh still works.",
    core: false,
  },
  {
    id: "tavi.heartbeat",
    description:
      "The heartbeat host: wakes each heartbeat inside its active hours, runs its cheap checks before any model call, and keeps its log (serve only). Disabling it stops every heartbeat.",
    core: false,
  },
  {
    id: "tavi.heartbeatagent",
    description:
      "The built-in heartbeat provider: one short, metered, read-only model turn on the fast model each check, telling you only what it reports (serve only). Disabling it pauses heartbeats that use it.",
    core: false,
  },
  {
    id: "tavi.ideasagent",
    description:
      'The built-in ideas provider: ranks the use-case catalogue by what Tavi can do here and what you mentioned, and has your fast model reword the ones that fit you, within the day\'s ideas budget. A plugin with provides: ["ideas"] can replace it per workspace; disabling it skips the runs of workspaces that use it.',
    core: false,
  },
  {
    id: "tavi.onboarding",
    description:
      'The built-in onboarding flow: the steps tavi onboard, tavi setup and the canvas\'s Welcome walk — a model first, then you, apps, channels, search, keeping Tavi running and a first idea. A plugin with provides: ["onboarding"] can replace it; disabling it leaves the setup checklist with the command for each open step.',
    core: false,
  },
  {
    id: "tavi.heartbeatsignals",
    description:
      "The heartbeat's built-in signal sources: what waits on you, what is coming up, failed schedules and routine runs, channels needing attention, held messages, messages left unanswered, sends that failed, watched pages, and chat folders or the disk filling up (serve only).",
    core: false,
  },
  {
    id: "tavi.memoryprovider",
    description:
      "The built-in memory provider: ranks what memory recalls for turns, the memory.search tool and heartbeat checks with Tavi's own index, drafts the idle review's and the epoch flush's proposals, and drafts weekly tidy-up suggestions when a workspace turns them on. It is what any other provider falls back to; disabled, with no other chosen, recall is the host's own search and nothing drafts proposals.",
    core: false,
  },
  {
    id: "tavi.memory",
    description:
      "The memory host: the chat commands /remember, /forget, /memory and /why, in the app, the terminal and direct chats, and the weekly review digest (serve only). Disabling it withdraws them and stops the digest, the idle review, weekly tidy-ups and the vector backfill; recall, proposals and provider removals keep working.",
    core: false,
  },
  {
    id: "tavi.reminderrule",
    description: "Seeds each workspace once with the allow rule for the reminder tools; a revoked rule is not put back.",
    core: false,
  },
  {
    id: "tavi.reminders",
    description: "Fires reminders when they are due, with their buttons; a text-only reminder needs no model connection.",
    core: false,
  },
  {
    id: "tavi.tasksummaries",
    description: "Writes each task's title and summary in its own loop, one call at a time, never on the path that finishes a task.",
    core: false,
  },
  {
    id: "tavi.localmessaging",
    description:
      "The local connection each workspace's terminal and canvas chats go through: core, since without it no message typed there reaches a task.",
    core: true,
  },
  {
    id: CHANNEL_HOST_PLUGIN_ID,
    description:
      "Opens the saved connections of every installed channel, built-in or a plugin's, and applies Settings changes live; each channel is its own plugin.",
    core: true,
  },
  // The built-in channels, each its own plugin: disabled, its channel is not installed, and a plugin may take its place.
  { id: "tavi.telegram", description: "The Telegram channel: a bot you message, paired to you.", core: false },
  { id: "tavi.mailgun", description: "The email channel over Mailgun: inbound routes and outbound sending.", core: false },
  { id: "tavi.gmail", description: "The Gmail channel: your mailbox, read and drafted with your approval.", core: false },
  // Domain tools: composed with the owner's tools, left out while disabled.
  {
    id: FLIGHTS_PLUGIN_ID,
    description:
      "travel.flights_search: flight search over Kiwi.com's public MCP server, before browsing, with Google Flights and Kayak links.",
    core: false,
  },
  {
    id: BROWSER_ENGINE_PLUGIN_ID,
    description:
      "The agent's browser engine and its browser.* tools. Disabled, the agent has no browser from the next start; a replacement engine is an embedder's composition option, never a plugin.",
    core: false,
  },
  {
    id: PDF_ENGINE_PLUGIN_ID,
    description:
      "Reading and filling PDFs (pdf.* tools), each document parsed in a confined, single-use process. Disabled, the pdf tools are not offered from the next start.",
    core: false,
  },
  {
    id: VIDEO_ENGINE_PLUGIN_ID,
    description:
      "Understanding videos with the person's own FFmpeg (video.* tools), each read in a confined, capped run. Disabled, the video tools are not offered from the next start.",
    core: false,
  },
  {
    id: "tavi.sandbox",
    description:
      "The confinement every plugin worker, sandbox.run, the PDF parser and video reads run under. Core: it cannot be disabled, nor replaced by a plugin, since it confines every plugin.",
    core: true,
  },
  {
    id: "tavi.limits",
    description: "The CPU, memory and time limits confined runs get. Core: it cannot be disabled, nor replaced by a plugin.",
    core: true,
  },
  {
    id: "tavi.worker",
    description:
      "The worker processes approved plugins run in, through the confinement. Core: it cannot be disabled, nor replaced by a plugin.",
    core: true,
  },
  {
    id: SITE_SKILLS_PLUGIN_ID,
    description:
      "What is known of sites an agent often browses (Google Flights, Kayak, Skyscanner, Booking.com, Google Maps), carried on a first observation.",
    core: false,
  },
  {
    id: COLLECTORS_PLUGIN_ID,
    description:
      "The daily brief's collectors (projects, GA4, Search Console, GCP billing, Stripe, news) and its report tools (reports.generate, reports.history).",
    core: false,
  },
  // Experimental: off until enabled, macOS only.
  {
    id: DESKTOP_PLUGIN_ID,
    description:
      "Experimental, macOS only: desktop.* tools that see and act in the apps a workspace grants (desktop.grantedApps), every action asked about in an attended run. Off until enabled; its helper is built once on the Mac it runs on.",
    core: false,
    enabledByDefault: false,
  },
  // A first-party mod: off until enabled; its hooks join the turn while it is on.
  {
    id: GUARD_PLUGIN_ID,
    description:
      "Asks before shell commands that delete or overwrite files, and says what they would touch; refuses them where nobody can approve. Off until enabled.",
    core: false,
    enabledByDefault: false,
    mods: GUARD_MODS,
  },
  // UI only: nothing composes it; the canvas frames it.
  { id: BROWSER_VIEW_MANIFEST.id, description: BROWSER_VIEW_MANIFEST.description, core: false, uiOnly: true, ui: BROWSER_VIEW_MANIFEST.ui },
];

/** A channel this build ships: its descriptor, its connector made for an owner, and the mailbox its accounts' tools use, if its app is one. */
export interface BuiltinChannel {
  /** The built-in plugin that installs it: disabled, the channel is not installed and its provider id is free. */
  readonly pluginId: string;
  readonly descriptor: ChannelDescriptor;
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
