import { DEFAULT_WORKSPACE_ID, localeOf, WorkspaceSettingsSchema } from "@tavi/contracts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";

/**
 * The terminal's language: the workspace's `workspace.locale`, as the owner
 * holds it — or, with no owner, as the data directory stores it — and English
 * whenever it cannot be read. `--help`, usage errors and `--format json` stay
 * English whatever it is (decision 6); everything else a person reads at the
 * terminal is said in it.
 */

/** The language a `workspace-settings get` answer names: its effective one, else the stored setting, else English. */
export function localeOfSettingsAnswer(result: unknown): Locale {
  const answer = result as { readonly effective?: { readonly locale?: unknown }; readonly settings?: unknown } | undefined;
  const effective = answer?.effective?.locale;
  if (isLocale(effective)) return effective;
  const settings = WorkspaceSettingsSchema.safeParse(answer?.settings);
  return settings.success ? localeOf(settings.data) : DEFAULT_LOCALE;
}

/** The terminal's words for a `workspace-settings get` answer (English for a refused or unreadable one). */
export const wordsOfSettingsAnswer = (result: unknown): CoreT => wordsIn(localeOfSettingsAnswer(result));

/** The words of `locale`: English is the shared default translator, so an English terminal says exactly what it always has. */
export const wordsIn = (locale: Locale): CoreT => (locale === DEFAULT_LOCALE ? coreEnglish : coreIn(locale));

/** A client of the owner, as far as reading its settings goes. */
interface SettingsReader {
  request(
    command: "workspace-settings",
    payload: unknown,
    id: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<{ readonly ok: boolean; readonly result?: unknown }>;
}

/** The words of the workspace a live owner serves; English when it does not answer. */
export async function ownerWords(client: SettingsReader, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<CoreT> {
  try {
    const answer = await client.request("workspace-settings", { action: "get", workspaceId }, `cli-words-${process.pid}`, {
      timeoutMs: 5_000,
    });
    return answer.ok ? wordsOfSettingsAnswer(answer.result) : coreEnglish;
  } catch {
    return coreEnglish;
  }
}

/** A store's workspace settings, as far as reading the language goes. */
interface SettingsStore {
  asPort(): {
    readonly repositories: { readonly workspaceSettings: { get(workspaceId: string): Promise<{ readonly settings: unknown }> } };
  };
}

/** The words of a workspace as the data directory stores it (no owner running); English when it cannot be read. */
export async function storeWords(store: SettingsStore, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<CoreT> {
  try {
    const settings = WorkspaceSettingsSchema.safeParse((await store.asPort().repositories.workspaceSettings.get(workspaceId)).settings);
    return settings.success ? wordsIn(localeOf(settings.data)) : coreEnglish;
  } catch {
    return coreEnglish;
  }
}

/**
 * A typed yes or no, in either language the terminal speaks: `y`, `yes`, `д`, `да` say yes; `n`, `no`, `н`, `не`
 * say no; anything else is no answer. Both are always read, whatever the workspace's language, so a hand used to
 * one never answers wrongly in the other — and no Bulgarian word approves more than its English one does.
 */
export function yesNoOf(typed: string): boolean | undefined {
  const word = typed.trim().toLowerCase();
  if (["y", "yes", "д", "да"].includes(word)) return true;
  if (["n", "no", "н", "не"].includes(word)) return false;
  return undefined;
}

/** The hint after a yes-or-no question: `[Y/n]` when Enter says yes, `[y/N]` when it says no (`[Д/н]`, `[д/Н]` in Bulgarian). */
export const yesNoHint = (fallback: boolean, t: CoreT = coreEnglish): string =>
  t(fallback ? "prompt.confirm.hintYes" : "prompt.confirm.hintNo");
