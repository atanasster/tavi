import type { CatalogFor } from "@tavi/contracts/i18n";

import type { app as en } from "../en/app.js";

/** The words of App.tsx, main.tsx and features/startup, in Bulgarian. */
export const app = {
  "app.shell.openChatToDownload": "Отвори чата, в който е попълнен формулярът, за да го изтеглиш.",
  "app.tab.setup": "Първи стъпки",
  "app.skip.content": "Към съдържанието",
  "app.skip.notification": "Към известието",
  "app.session.notAnswering": "tavi ui не отговаря. Още ли работи?",
  "app.session.linkExpired": "Този линк вече е използван или е изтекъл. За нова натисни Enter там, където работи `tavi ui`.",
  "app.session.linkRefused": "tavi ui отказа линка ({status}).",
  "app.session.unreadable": "tavi ui отговори във вид, който тази страница не може да прочете. Отвори я отново от нов линк.",
  "app.start.noLink": "Отвори тази страница от линка, който ти дава `tavi ui`. За нова натисни Enter там, където работи.",
  "app.start.connecting": "Свързвам се със сървъра на Tavi…",
  "app.start.signInEnded": "Сесията в този раздел изтече. За нов линк натисни Enter там, където работи `tavi ui`.",
  "app.start.unreachable": "Не успях да се свържа със сървъра на Tavi: {error}",
} as const satisfies CatalogFor<typeof en>;
