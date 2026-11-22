import { useEffect, useId, useRef, useState } from "react";

import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, SUPPORTED_LOCALES, type Locale } from "@tavi/contracts/i18n";
import { WorkspaceSettingsAnswerSchema, type WorkspaceSettingsAnswer } from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { setLocale, useT } from "../../lib/i18n.js";
import { read, type SettingsClient } from "../../lib/ipc.js";
import { StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { workspaceSettingsActions } from "./workspace-api.js";

/** The language a browser asks for, when it is one Tavi speaks: `bg-BG` → `bg`. */
export function browserLocale(languages: readonly string[]): Locale | undefined {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return undefined;
}

/**
 * The language picker: every language pack, each named in its own language,
 * saved to the workspace (`workspace.locale`) the moment one is picked, and
 * the page switched to it at once. Settings → General shows it with its
 * heading and hint, on the settings it has read (`settings`); Welcome shows
 * it in its rail on a read of its own, where `suggest` first sets a workspace
 * with no language yet to the browser's: the first of its languages Tavi
 * speaks, when that is not English. An owner from before languages, which
 * names none in effect, gets no picker.
 */
export function LanguageChoice({
  client,
  workspaceId,
  settings,
  compact = false,
  suggest = false,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  /** The workspace settings the page has already read, and how it reads them again; absent, the picker reads its own. */
  readonly settings?: { readonly answer: WorkspaceSettingsAnswer; readonly reload: () => void } | undefined;
  readonly compact?: boolean;
  readonly suggest?: boolean;
}) {
  const t = useT();
  const hintId = useId();
  // Read against the schema: an answer without the workspace's settings shows no picker rather than a guess.
  const load = () => read(client, "workspace-settings", { action: "get", workspaceId }, WorkspaceSettingsAnswerSchema);
  const own = useLoaded<WorkspaceSettingsAnswer>(load, [client, workspaceId], { enabled: settings === undefined });
  const data = settings?.answer ?? own.data;
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string>();
  const suggested = useRef(false);
  const choose = async (next: Locale, answer: WorkspaceSettingsAnswer): Promise<void> => {
    setSaving(true);
    setNote(undefined);
    // On its own read, the revision is read again first: another step on the page (Welcome's Tasks) may have saved since.
    const latest = settings === undefined ? await load() : undefined;
    const revision = latest?.ok === true ? latest.value.revision : answer.revision;
    const saved = await workspaceSettingsActions.setLanguage(client, workspaceId, next, revision);
    setSaving(false);
    // Read again either way: a refusal for a revision another save moved on is not the last word on the next pick.
    if (settings !== undefined) settings.reload();
    else if (saved.ok) own.replace(saved.value);
    else own.reload();
    if (!saved.ok) return setNote(saved.message);
    await setLocale(saved.value.effective.locale ?? next);
  };
  useEffect(() => {
    if (!suggest || suggested.current || data?.effective.locale === undefined || data.settings.locale !== undefined) return;
    suggested.current = true;
    const wanted = browserLocale(typeof navigator === "undefined" ? [] : navigator.languages);
    if (wanted !== undefined && wanted !== DEFAULT_LOCALE) void choose(wanted, data);
  });
  if (data?.effective.locale === undefined) return null;
  const current = data.effective.locale;
  const picker = (
    <Select
      aria-label={t("settings.language.label")}
      {...(compact ? {} : { "aria-describedby": hintId })}
      value={current}
      disabled={saving}
      onChange={(event) => {
        if (isLocale(event.target.value) && event.target.value !== current) void choose(event.target.value, data);
      }}
    >
      {SUPPORTED_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {LOCALE_NAMES[locale]}
        </option>
      ))}
    </Select>
  );
  if (compact) {
    return (
      <div className="language-choice">
        {picker}
        <StatusNote note={note} />
      </div>
    );
  }
  return (
    <>
      <h2>{t("settings.language.label")}</h2>
      <p className="muted" id={hintId}>
        {t("settings.language.hint")}
      </p>
      <div className="actions">{picker}</div>
      <StatusNote note={note} />
    </>
  );
}
