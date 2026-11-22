import type { CatalogFor } from "@tavi/contracts/i18n";

import { app } from "./bg/app.js";
import { common } from "./bg/common.js";
import { ui } from "./bg/ui.js";
import { shell } from "./bg/shell.js";
import { welcome } from "./bg/welcome.js";
import { chat } from "./bg/chat.js";
import { chatPanel } from "./bg/chat-panel.js";
import { needs } from "./bg/needs.js";
import { transcript } from "./bg/transcript.js";
import { sessions } from "./bg/sessions.js";
import { center } from "./bg/center.js";
import { settings } from "./bg/settings.js";
import { routines } from "./bg/routines.js";
import { apps } from "./bg/apps.js";
import { ideas } from "./bg/ideas.js";
import { takeover } from "./bg/takeover.js";
import { workers } from "./bg/workers.js";
import { pluginHost } from "./bg/plugin-host.js";
import type { en } from "./en.js";

/** The canvas's words in Bulgarian, loaded in its own chunk only when the workspace speaks it. */
export const bg = {
  ...app,
  ...common,
  ...ui,
  ...shell,
  ...welcome,
  ...chat,
  ...chatPanel,
  ...needs,
  ...transcript,
  ...sessions,
  ...center,
  ...settings,
  ...routines,
  ...apps,
  ...ideas,
  ...takeover,
  ...workers,
  ...pluginHost,
} as const satisfies CatalogFor<typeof en>;
