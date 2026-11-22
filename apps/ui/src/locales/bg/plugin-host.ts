import type { CatalogFor } from "@tavi/contracts/i18n";

import type { pluginHost as en } from "../en/plugin-host.js";

/** The words of features/plugin-host, in Bulgarian. */
export const pluginHost = {
  "pluginHost.top.show": "Покажи „{title}“",
  "pluginHost.top.hide": "Скрий „{title}“",
  "pluginHost.top.resize": "Промени височината на „{title}“",
  "pluginHost.tab.shrink": "Смали изгледа на браузъра",
  "pluginHost.tab.expand": "Уголеми изгледа на браузъра",
  "pluginHost.tab.shrinkTip": "Смали (Esc)",
  "pluginHost.tab.expandTip": "Уголеми",
  "pluginHost.takeOver": "Поеми браузъра",
} as const satisfies CatalogFor<typeof en>;
