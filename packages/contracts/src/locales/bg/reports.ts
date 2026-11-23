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
  "reports.news.gap.uncovered": "По-ранен период без покритие е извън запазения прозорец за наваксване",
  "reports.news.gap.noClusteringRelease":
    "Групирането на почти еднакви новини не е налично, затова повторенията са отсети само по изданието",
  "reports.news.gap.noClusteringStory": "Групирането на почти еднакви новини не е налично, затова повторенията са отсети само по новината",
  "reports.news.gap.failures": { one: "{n} обръщение към източник не успя", other: "{n} обръщения към източници не успяха" },
  "reports.news.gap.undated": "Някои прочетени страници нямат дата на публикуване, която да се провери",
  "reports.news.gap.unsupported": {
    one: "{n} предложена новина нямаше подходящ прочетен източник",
    other: "{n} предложени новини нямаха подходящ прочетен източник",
  },
} as const satisfies CatalogFor<typeof en>;
