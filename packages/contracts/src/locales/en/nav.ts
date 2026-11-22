/**
 * The `core` words for the canvas's places, in English: its routes, Settings' views and the Command Center's
 * sections, as its navigation labels them, and a menu path through them ("Settings → Models"). The canvas's nav
 * reads these keys, and every message that names a place builds its path from them (`navPath`, `navPathIn`), so a
 * path in a message always says what the nav says.
 */
export const nav = {
  /** A menu path, each place as its nav labels it. */
  "nav.path.two": "{first} → {second}",
  "nav.path.three": "{first} → {second} → {third}",
  // The routes.
  "nav.route.chat": "Chat",
  "nav.route.ideas": "Ideas",
  "nav.route.center": "Center",
  "nav.route.settings": "Settings",
  /** The Center's full name, as its sidebar's heading says it. */
  "nav.route.commandCenter": "Command Center",
  // Settings' views.
  "nav.settings.general": "General",
  "nav.settings.apps": "Connected apps",
  "nav.settings.models": "Models",
  "nav.settings.search": "Web search",
  "nav.settings.systemPrompt": "System prompt",
  "nav.settings.credentials": "Credentials",
  "nav.settings.channels": "Channels",
  "nav.settings.people": "Allowed people",
  "nav.settings.plugins": "Plugins",
  "nav.settings.permissions": "Permissions",
  "nav.settings.ideas": "Ideas",
  // The Command Center's sections, and the rail's.
  "nav.center.activity": "Activity",
  "nav.center.approvals": "Approvals",
  "nav.center.schedule": "Schedule",
  "nav.center.heartbeat": "Heartbeat",
  "nav.center.identity": "Soul & memory",
  "nav.center.browser": "Browser",
  "nav.center.waitingOnYou": "Waiting on you",
  "nav.center.servers": "Servers",
} as const;
