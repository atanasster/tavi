import { app } from "./en/app.js";
import { common } from "./en/common.js";
import { ui } from "./en/ui.js";
import { shell } from "./en/shell.js";
import { welcome } from "./en/welcome.js";
import { chat } from "./en/chat.js";
import { chatPanel } from "./en/chat-panel.js";
import { needs } from "./en/needs.js";
import { transcript } from "./en/transcript.js";
import { sessions } from "./en/sessions.js";
import { center } from "./en/center.js";
import { settings } from "./en/settings.js";
import { routines } from "./en/routines.js";
import { apps } from "./en/apps.js";
import { ideas } from "./en/ideas.js";
import { takeover } from "./en/takeover.js";
import { workers } from "./en/workers.js";
import { pluginHost } from "./en/plugin-host.js";

/**
 * The canvas's words in English: the source every other language's catalogue
 * matches key for key (`locales/bg.ts` is typed against it). Each part of the
 * canvas keeps its words in its own module under `en/`, and keys read
 * `feature.place.purpose`.
 */
export const en = {
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
} as const;

export type UiKey = keyof typeof en;
