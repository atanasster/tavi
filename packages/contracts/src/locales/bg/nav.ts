import type { CatalogFor } from "../../i18n.js";

import type { nav as en } from "../en/nav.js";

/** The `core` words for the canvas's places, in Bulgarian: each label capitalised as on screen, a path unquoted ("Настройки → Модели"). */
export const nav = {
  "nav.path.two": "{first} → {second}",
  "nav.path.three": "{first} → {second} → {third}",
  "nav.route.chat": "Чат",
  "nav.route.ideas": "Идеи",
  "nav.route.center": "Център",
  "nav.route.settings": "Настройки",
  "nav.route.commandCenter": "Команден център",
  "nav.settings.general": "Общи",
  "nav.settings.apps": "Свързани приложения",
  "nav.settings.models": "Модели",
  "nav.settings.search": "Търсене в мрежата",
  "nav.settings.systemPrompt": "Системни инструкции",
  "nav.settings.credentials": "Данни за достъп",
  "nav.settings.channels": "Канали",
  "nav.settings.people": "Разрешени хора",
  "nav.settings.plugins": "Плъгини",
  "nav.settings.permissions": "Разрешения",
  "nav.settings.ideas": "Идеи",
  "nav.center.activity": "Дейност",
  "nav.center.approvals": "Одобрения",
  "nav.center.schedule": "График",
  "nav.center.heartbeat": "Пулс",
  "nav.center.identity": "Душа и памет",
  "nav.center.browser": "Браузър",
  "nav.center.waitingOnYou": "Чака теб",
  "nav.center.servers": "Сървъри",
} as const satisfies CatalogFor<typeof en>;
