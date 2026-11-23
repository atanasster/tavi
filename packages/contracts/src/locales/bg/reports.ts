import type { CatalogFor } from "../../i18n.js";

import type { reports as en } from "../en/reports.js";

/** The `core` words for summaries, idea rewording and routine reports, in Bulgarian. */
export const reports = {
  "reports.language.en": "английски",
  "reports.language.bg": "български",
  "reports.news.preview": "Пробно пускане",
  "reports.news.revision": "Версия {revision}",
  "reports.news.quiet": "В този период не се потвърди нито една новина, която да отговаря на условията.",
  "reports.news.coverage": "Обхват: от {from} до {to}.",
  "reports.news.fetched": { one: "{count} изтеглена страница.", other: "{count} изтеглени страници." },
  "reports.news.fetchedAs": "{count} {word}.",
  "reports.news.widened": "Периодът е разширен в рамките на зададения лимит.",
} as const satisfies CatalogFor<typeof en>;
