import { localDateTime, localeOf, type WorkspaceSettingsRepositoryPort } from "@tavi/contracts";
import { DEFAULT_LOCALE, type Locale } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { errorMessage } from "@tavi/contracts/util";

/**
 * The words a chat app is sent in: replies, cards, buttons and receipts speak
 * the workspace's language (`workspace.locale`), read where the message is
 * built. A workspace whose settings cannot be read is spoken to in English.
 */

/** A workspace's language, as a producer reads it. */
export type WorkspaceLocaleOf = (workspaceId: string) => Promise<Locale>;

/** `localeOf` of a workspace's stored settings. */
export function workspaceLocaleOf(settings: Pick<WorkspaceSettingsRepositoryPort, "get">): WorkspaceLocaleOf {
  return async (workspaceId) => localeOf((await settings.get(workspaceId)).settings);
}

/**
 * The `core` words for `workspaceId`'s language: English without a reader, or
 * when the settings cannot be read (`onError` is told why). Never throws.
 */
export async function channelWords(
  localeOfWorkspace: WorkspaceLocaleOf | undefined,
  workspaceId: string | undefined,
  onError?: (message: string, fields: Record<string, unknown>) => void,
): Promise<CoreT> {
  if (localeOfWorkspace === undefined || workspaceId === undefined) return coreEnglish;
  try {
    const locale = await localeOfWorkspace(workspaceId);
    return locale === DEFAULT_LOCALE ? coreEnglish : coreIn(locale);
  } catch (error) {
    onError?.("the workspace's language could not be read; a chat app is answered in English", { workspaceId, error: errorMessage(error) });
    return coreEnglish;
  }
}

const two = (value: number): string => String(value).padStart(2, "0");

/** The time of day `at` reads as in `zone`, 24-hour: "05:24". The same in every language. */
export function zonedClock(at: Date, zone: string): string {
  const parts = localDateTime(at, zone);
  return `${two(parts.hour)}:${two(parts.minute)}`;
}

/**
 * The day `at` falls on in `zone`, in `t`'s words: "Thu 15 Oct", "чт, 15 окт".
 * English is en-GB's own, as before ("Thu 17 Sept").
 */
export function zonedShortDay(at: Date, zone: string, t: CoreT = coreEnglish): string {
  if (t === coreEnglish)
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: zone }).format(at);
  const parts = localDateTime(at, zone);
  return t("date.shortDay", {
    weekdayShort: t(`date.weekdayShort.${parts.weekday}` as CoreKey),
    day: String(parts.day),
    monthShort: t(`date.monthShort.${parts.month}` as CoreKey),
    weekday: t(`date.weekday.${parts.weekday}` as CoreKey),
    month: t(`date.month.${parts.month}` as CoreKey),
  });
}
