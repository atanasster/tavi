/** The `core` words for summaries, idea rewording and routine reports, in English. */
export const reports = {
  /** A language's name, as a model is told which language to write in (read in English: the model's instructions are English). */
  "reports.language.en": "English",
  "reports.language.bg": "Bulgarian",
  /** A routine report's PDF: the run that made it. */
  "reports.news.preview": "Preview",
  "reports.news.revision": "Revision {revision}",
  /** A report with no story to tell. */
  "reports.news.quiet": "No qualifying stories were verified in this coverage window.",
  /** The footer: the window the report covers. */
  "reports.news.coverage": "Coverage: {from} to {to}.",
  /** How many pages the run read (English has always said "pages", whatever the count). */
  "reports.news.fetched": { other: "{count} pages fetched." },
  /** The same, in a plugin template's own word for its sources. */
  "reports.news.fetchedAs": "{count} {word}.",
  "reports.news.widened": "Window widened within the saved limit.",
} as const;
