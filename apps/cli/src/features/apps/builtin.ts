import { pluginUiUrl, type AppPresentation, type ChannelDescriptor, type PluginView } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { channelGrantsOf } from "../channels/catalog.js";
import { AVAILABLE_PRESETS, presetOf } from "../mcp/presets/index.js";
import { BUILTIN_CHANNEL_DESCRIPTORS } from "../plugins/catalog.js";

/**
 * How a channel presents in Connected apps: its descriptor's own `app`, in its channel's words — core names no
 * channel. Its id is its provider id. A channel without
 * one presents from its label and description.
 */
export function channelPresentationOf(
  descriptor: ChannelDescriptor | undefined,
): (AppPresentation & { readonly provider?: string; readonly mailbox?: true; readonly calendar?: true }) | undefined {
  const app = descriptor?.app;
  if (descriptor === undefined || app === undefined) return undefined;
  const providerId = descriptor.providerId;
  // A plugin's channel presents in its words, with only the shared client and mailbox it was granted.
  const grants = channelGrantsOf(providerId);
  const provider = grants?.provider;
  const dataClass = grants?.dataClass;
  return {
    id: providerId,
    name: app.name,
    summary: app.summary === "" ? descriptor.description.slice(0, 200) : app.summary,
    category: app.category,
    ...definedOnly({
      publisher: app.publisher,
      provider,
      dataClass,
    }),
    accountScope: "owner",
    scopes: [...app.scopes],
    tools: {},
    binds: { channel: providerId },
    ...(grants?.mailbox === true ? { mailbox: true as const } : {}),
    ...(grants?.calendar === true ? { calendar: true as const } : {}),
  };
}

/**
 * The ids Tavi's own presentations use: a plugin's `apps` block may not
 * claim one, or its app would be grouped into (and removed with) Tavi's.
 */
const TAVI_APP_IDS: ReadonlySet<string> = new Set([
  ...AVAILABLE_PRESETS.map((id) => presetOf(id)?.app?.id).filter((id): id is string => id !== undefined),
  ...BUILTIN_CHANNEL_DESCRIPTORS.map((descriptor) => descriptor.providerId),
]);

/** A manifest's own presentation, with an id it may not claim replaced by its plugin's. */
export function authorPresentation<T extends AppPresentation>(declared: T, pluginId: string): T {
  return TAVI_APP_IDS.has(declared.id) ? { ...declared, id: pluginId } : declared;
}

/**
 * The bridge path of the icon the author's `apps` block names, only
 * while the bridge would serve it: an enabled plugin's active, approved
 * version. Otherwise the canvas draws a monogram.
 */
export function servedIconOf(view: PluginView, icon: string | undefined): string | undefined {
  if (icon === undefined || !view.enabled || view.kind === "builtin") return undefined;
  const version = view.versions.find((candidate) => candidate.version === view.activeVersion);
  return version?.reviewState === "approved" ? pluginUiUrl({ pluginId: view.id, contentHash: version.contentHash }, icon) : undefined;
}

/** The version a plugin runs, or the approved one it would run once turned on (enabling picks the latest approved). */
export function approvedVersionOf(view: PluginView): string | undefined {
  return view.activeVersion ?? view.versions.findLast((candidate) => candidate.reviewState === "approved")?.version;
}
