import { join } from "node:path";

import {
  localeOf,
  PluginUiMessagesSchema,
  PluginUiSchema,
  type ChannelDescriptor,
  type PluginManifest,
  type PluginUi,
  type PluginUiEntry,
  type PluginView,
  type WorkspaceSettingsRepositoryPort,
} from "@tavi/contracts";
import type { Catalog, Locale } from "@tavi/contracts/i18n";
import { localizedPluginManifest, readBuiltinUiPacks, readPluginManifest, readPluginUiMessages } from "@tavi/runtime";

import { channelPluginOf, channelPluginVersionOf } from "../channels/catalog.js";
import type { ExternalPluginLanguage } from "./external.js";

/**
 * A plugin's words in the workspace's language, for a person's screens: the
 * owner lays each installed version's language pack over its English manifest
 * before the canvas sees it (Connected apps, channel setup, plugin detail), so
 * the canvas never holds both languages. What runs, and what the model reads,
 * stay the English the version was reviewed with.
 */

/**
 * The language a canvas request's plugin words are served in: the workspace's,
 * when it is not English; `undefined` (the English as installed) otherwise, and
 * for the terminal, whose plugin listings stay English (scripts read them).
 */
export async function canvasPluginLocale(
  settings: Pick<WorkspaceSettingsRepositoryPort, "get">,
  workspaceId: string,
  fromCanvas: boolean,
): Promise<Locale | undefined> {
  if (!fromCanvas) return undefined;
  const locale = localeOf((await settings.get(workspaceId)).settings);
  return locale === "en" ? undefined : locale;
}

/** Where an installed version's snapshot is, and the hash it was approved with: its packs are read only from a snapshot that still has it. */
export type PluginSnapshotOf = (
  pluginId: string,
  version: string,
) => { readonly directory: string; readonly contentHash: string } | undefined;

/** Each installed version's snapshot and approved hash, from the registry's listing. */
export async function pluginSnapshots(registry: {
  readonly list: () => Promise<readonly PluginView[]>;
  readonly snapshotDirectory: (pluginId: string, version: string) => string;
}): Promise<PluginSnapshotOf> {
  const hashes = new Map<string, string>();
  for (const view of await registry.list())
    for (const version of view.versions) hashes.set(`${view.id}\u0000${version.version}`, version.contentHash);
  return (pluginId, version) => {
    const contentHash = hashes.get(`${pluginId}\u0000${version}`);
    return contentHash === undefined ? undefined : { directory: registry.snapshotDirectory(pluginId, version), contentHash };
  };
}

/**
 * A version's manifest read from its snapshot, in `locale` when given and its
 * approved `contentHash` is known (English otherwise); `undefined` when it no longer reads.
 */
export function localizedSnapshotManifest(
  directory: string,
  locale: Locale | undefined,
  contentHash: string | undefined,
): PluginManifest | undefined {
  let manifest: PluginManifest;
  try {
    manifest = readPluginManifest(directory);
  } catch {
    return undefined;
  }
  return contentHash === undefined ? manifest : localizedPluginManifest(directory, manifest, locale, contentHash);
}

/**
 * Channel descriptors as channel setup shows them in `locale`: a plugin's
 * channel with its version's pack laid over it; a built-in's, or one whose
 * pack does not reach it, as registered.
 */
export function localizedChannelDescriptors(
  descriptors: readonly ChannelDescriptor[],
  locale: Locale | undefined,
  snapshotOf: PluginSnapshotOf,
): readonly ChannelDescriptor[] {
  if (locale === undefined || locale === "en") return descriptors;
  const manifests = new Map<string, PluginManifest | undefined>();
  return descriptors.map((descriptor) => {
    const pluginId = channelPluginOf(descriptor.providerId);
    const version = channelPluginVersionOf(descriptor.providerId);
    const snapshot = pluginId === undefined || version === undefined ? undefined : snapshotOf(pluginId, version);
    if (snapshot === undefined) return descriptor;
    if (!manifests.has(snapshot.directory))
      manifests.set(snapshot.directory, localizedSnapshotManifest(snapshot.directory, locale, snapshot.contentHash));
    return manifests.get(snapshot.directory)?.channels.find((candidate) => candidate.providerId === descriptor.providerId) ?? descriptor;
  });
}

/**
 * The workspace's language as plugins read it (`ctx.locale`): read once, then
 * again after each write to workspace settings (`onWrite`, the store's write
 * signal), so a language changed in Settings reaches a running plugin without a
 * restart. Listeners hear each change.
 */
export async function pluginLanguage(
  settings: Pick<WorkspaceSettingsRepositoryPort, "get">,
  workspaceId: string,
  onWrite: (listener: (operation: string) => void) => () => void,
): Promise<ExternalPluginLanguage & { readonly close: () => void }> {
  let current = localeOf((await settings.get(workspaceId)).settings);
  const listeners = new Set<(locale: Locale) => void>();
  let reading = Promise.resolve();
  const reread = async (): Promise<void> => {
    let next: Locale;
    try {
      next = localeOf((await settings.get(workspaceId)).settings);
    } catch {
      return;
    }
    if (next === current) return;
    current = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // A listener's throw is its own.
      }
    }
  };
  const close = onWrite((operation) => {
    if (!operation.startsWith("repository.workspaceSettings.") || /\.(get|list)$/.test(operation)) return;
    reading = reading.then(reread);
  });
  return {
    current: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}

/** Where `localizedUiEntries` reads a plugin's packs: an installed version's snapshot, a built-in's files in the canvas build. */
export interface UiPackSources {
  readonly snapshotDirectory: (pluginId: string, version: string) => string;
  /** The canvas build the owner hashed its UI built-ins from (`builtCanvasDirectory`); absent: no built-in is translated. */
  readonly canvasDirectory: string | undefined;
}

/**
 * The canvas's UI entries in `locale`: each with the language and its
 * plugin's own words (`messages`) for its frames' `init` (`tavi.ui/1`), read
 * only from files whose hash is the one the entry is served under. An
 * installed version's `ui` titles were overlaid by the listing already; a
 * built-in's are laid over here from its own pack (`ui.contributions.<id>.title`
 * and `.disclosure`), kept English when the result would not be a valid `ui`
 * block. English, or no language, answers `entries` as they are.
 */
export function localizedUiEntries(entries: readonly PluginUiEntry[], locale: Locale | undefined, sources: UiPackSources): PluginUiEntry[] {
  if (locale === undefined || locale === "en") return [...entries];
  return entries.map((entry) => {
    let messages: Catalog | undefined;
    let ui: PluginUi = entry.ui;
    if (entry.kind === "external") {
      if (entry.version === undefined) return { ...entry, locale };
      const directory = sources.snapshotDirectory(entry.pluginId, entry.version);
      let manifest: PluginManifest;
      try {
        manifest = readPluginManifest(directory);
      } catch {
        return { ...entry, locale };
      }
      messages = readPluginUiMessages(directory, manifest, entry.contentHash, locale);
    } else {
      if (sources.canvasDirectory === undefined) return { ...entry, locale };
      const read = readBuiltinUiPacks(join(sources.canvasDirectory, "plugins", entry.pluginId), entry.contentHash, locale);
      messages = read.messages;
      ui = overlaidUi(entry.ui, read.pack?.manifest ?? {});
    }
    // Words the canvas would refuse are left out, never sent: one plugin's must not spoil the whole answer.
    const fit = messages === undefined ? undefined : PluginUiMessagesSchema.safeParse(messages);
    return { ...entry, ui, locale, ...(fit?.success === true ? { messages: fit.data } : {}) };
  });
}

/** `ui` with a built-in pack's contribution titles and disclosures in place of its English; English when that would not parse. */
function overlaidUi(ui: PluginUi, overlay: Readonly<Record<string, string>>): PluginUi {
  if (Object.keys(overlay).length === 0) return ui;
  const words = (id: string, field: "title" | "disclosure"): string | undefined =>
    Object.hasOwn(overlay, `ui.contributions.${id}.${field}`) ? overlay[`ui.contributions.${id}.${field}`] : undefined;
  const contributions = ui.contributions.map((contribution) => {
    const title = words(contribution.id, "title");
    const disclosure = contribution.disclosure === undefined ? undefined : words(contribution.id, "disclosure");
    return { ...contribution, ...(title === undefined ? {} : { title }), ...(disclosure === undefined ? {} : { disclosure }) };
  });
  const parsed = PluginUiSchema.safeParse({ ...ui, contributions });
  return parsed.success ? parsed.data : ui;
}
