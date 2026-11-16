/** The chat panel's tabs, in the order they are shown. */
export const CHAT_PANEL_TABS = ["activity", "schedule", "memory", "instructions", "details"] as const;
export type ChatPanelTab = (typeof CHAT_PANEL_TABS)[number];

export const CHAT_PANEL_LABELS: Readonly<Record<ChatPanelTab, string>> = {
  activity: "Activity",
  schedule: "Schedule",
  memory: "Memory",
  instructions: "Instructions",
  details: "Details",
};

export function isChatPanelTab(value: unknown): value is ChatPanelTab {
  return typeof value === "string" && (CHAT_PANEL_TABS as readonly string[]).includes(value);
}

/**
 * A tab a UI plugin contributes (slot `chat.panel.tab`): `plugin:<plugin-id>/<contribution-id>`, shown after the
 * built-in five while the plugin is enabled and placed there.
 */
export type PluginPanelTab = `plugin:${string}`;
/** Any tab the panel can show: a built-in, or a contributed one. */
export type PanelTab = ChatPanelTab | PluginPanelTab;

const PLUGIN_TAB = /^plugin:[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\/[a-z][a-z0-9-]*$/;

export function isPluginPanelTab(value: unknown): value is PluginPanelTab {
  return typeof value === "string" && value.length <= 120 && PLUGIN_TAB.test(value);
}

export function isPanelTab(value: unknown): value is PanelTab {
  return isChatPanelTab(value) || isPluginPanelTab(value);
}

/** A contribution's tab, by its key (`<plugin-id>/<contribution-id>`). */
export function pluginPanelTab(key: string): PluginPanelTab {
  return `plugin:${key}`;
}
