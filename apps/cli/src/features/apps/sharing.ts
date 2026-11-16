import { APP_SHARING, type AppMailboxAccess, type AppSharing } from "@tavi/contracts";
import { readPluginManifest, type PluginRegistry } from "@tavi/runtime";

import { mcpDataClassOf } from "../mcp/bridge.js";

/**
 * The household rule: every account is
 * Personal or Shared. A Personal one is offered only in the operator's own
 * one-to-one chats. The choice is owner-wide, as apps are, kept in
 * the store's meta table as the person made it; with none, an account is
 * Personal when its app's data is personal, Shared otherwise.
 */
export const APPS_SHARING_SETTING = "apps.sharing";

/** Each mailbox account's opt-in: read and draft, or send too; absent is off. */
export const APPS_MAILBOX_SETTING = "apps.mailbox";

export function parseMailbox(stored: string | undefined): Readonly<Record<string, Exclude<AppMailboxAccess, "off">>> {
  if (stored === undefined || stored === "") return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, Exclude<AppMailboxAccess, "off">] => entry[1] === "read" || entry[1] === "send",
      ),
    );
  } catch {
    return {};
  }
}

/** The accounts whose calendar the agent may use, by connection id: owner-wide, as apps are; absent is off. */
export const APPS_CALENDAR_SETTING = "apps.calendar";

export function parseCalendar(stored: string | undefined): ReadonlySet<string> {
  if (stored === undefined || stored === "") return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Set();
    return new Set(Object.entries(parsed).flatMap(([accountId, on]) => (on === true ? [accountId] : [])));
  } catch {
    return new Set();
  }
}

/** The site profiles the operator turned on, by plugin: owner-wide, as apps are; absent is off. */
export const APPS_SITES_SETTING = "apps.sites";

export type SitesOn = Readonly<Record<string, readonly string[]>>;

export function parseSites(stored: string | undefined): SitesOn {
  if (stored === undefined || stored === "") return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
        .map(([pluginId, ids]) => [pluginId, ids.filter((id) => typeof id === "string")]),
    );
  } catch {
    return {};
  }
}

export type SharingOverrides = Readonly<Record<string, AppSharing>>;

/** The stored overrides; anything unreadable is no override, so the default applies. */
export function parseSharing(stored: string | undefined): SharingOverrides {
  if (stored === undefined || stored === "") return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const overrides: Record<string, AppSharing> = {};
    for (const [accountId, value] of Object.entries(parsed))
      if ((APP_SHARING as readonly unknown[]).includes(value)) overrides[accountId] = value as AppSharing;
    return overrides;
  } catch {
    return {};
  }
}

export function sharingOf(overrides: SharingOverrides, accountId: string, dataClass: "public" | "personal" | undefined): AppSharing {
  return overrides[accountId] ?? (dataClass === "personal" ? "personal" : "shared");
}

/** The overrides with one account's choice set as the person made it. */
export function withSharing(overrides: SharingOverrides, accountId: string, sharing: AppSharing): SharingOverrides {
  return { ...overrides, [accountId]: sharing };
}

/** Whether an MCP server's account is Personal: its override, else its active (or newest) version's data class. */
export async function mcpAccountPersonal(
  registry: Pick<PluginRegistry, "show" | "snapshotDirectory">,
  getMeta: (key: string) => Promise<string | undefined>,
  pluginId: string,
): Promise<boolean> {
  const view = await registry.show(pluginId);
  const version = view.activeVersion ?? view.versions.at(-1)?.version;
  const dataClass = version === undefined ? undefined : mcpDataClassOf(readPluginManifest(registry.snapshotDirectory(pluginId, version)));
  return sharingOf(parseSharing(await getMeta(APPS_SHARING_SETTING)), pluginId, dataClass) === "personal";
}

/**
 * Keys a server refused at their test, by plugin: when, and the settings it held then. Owner-wide, as apps are. A
 * refusal stands until a test passes, its key is given again, its settings change, or it is probed since.
 */
export const APPS_REFUSED_SETTING = "apps.refused";

export interface RefusedKey {
  readonly at: string;
  /** The settings the server held when its key was refused (`configPrint`): a change since is a new key to try. */
  readonly config: string;
}

export type RefusedKeys = Readonly<Record<string, RefusedKey>>;

/** A server's settings as one comparable string: values are references, never secrets. */
export function configPrint(config: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}

export function parseRefused(stored: string | undefined): RefusedKeys {
  if (stored === undefined || stored === "") return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([pluginId, value]) => {
        const entry = value as Partial<RefusedKey> | null;
        return typeof entry?.at === "string" && typeof entry.config === "string"
          ? [[pluginId, { at: entry.at, config: entry.config }] as const]
          : [];
      }),
    );
  } catch {
    return {};
  }
}
