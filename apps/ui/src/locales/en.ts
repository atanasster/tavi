/**
 * The canvas's words in English: the source every other language's catalogue
 * matches key for key (`locales/bg.ts` is typed against it). Keys read
 * `feature.place.purpose`.
 */
export const en = {
  "settings.language.label": "Language",
  "settings.language.hint": "Tavi speaks to you in this language in the canvas, in chats and on your channels.",
} as const;

export type UiKey = keyof typeof en;
