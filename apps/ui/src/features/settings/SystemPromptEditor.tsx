import { useEffect, useRef, useState } from "react";

import type { SystemPromptAnswer } from "@tavi/contracts";

import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { SETTINGS_BOUNDS } from "./common.js";
import {
  systemPromptActions,
  systemPromptDirty,
  systemPromptProblem,
  systemPromptState,
  type SystemPromptMode,
  type SystemPromptState,
} from "./system-prompt-api.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { copyDraft } from "../../lib/clipboard.js";
import { useUnsavedGuard } from "../../hooks/page.js";
import { Failure, PageNote } from "../../ui/Parts.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Button } from "../../ui/Button.js";

/**
 * The workspace system prompt editor's state and its form, shared by Settings →
 * System prompt and the Command Center's Soul pane, so the two cannot differ in how a draft, a conflict or an unknown
 * outcome is handled.
 *
 * Two states are tracked separately and deliberately:
 *
 *  - `saved` — the workspace's persisted mode, text and revision, the thing a
 *    write compares against;
 *  - `draft` — what the operator is editing, seeded once and replaced only by an
 *    explicit Discard, Reload or a matched save acknowledgement. `useLoaded`
 *    re-reads on every reload, including after a failed write, so copying each
 *    answer into the draft would erase exactly the text an operator needs to keep
 *    when a save conflicts.
 *
 * Mode is tracked beside the text, never inferred from it: an override whose text
 * equals the shipped default displays identically to no override but is a
 * different state, and clearing it is still a write.
 *
 * `saved` is the **authoritative baseline** — the last loaded state, updated by a
 * matched save acknowledgement. Discard and both reload paths restore from it;
 * the raw `data` stream must never seed the draft directly, because a successful
 * save leaves it stale.
 */
export interface SystemPromptEditorState {
  /** The last load's failure, if any. */
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly saved: SystemPromptState | undefined;
  readonly draft: { readonly mode: SystemPromptMode; readonly text: string } | undefined;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly note: string | undefined;
  readonly conflict: string | undefined;
  readonly refusal: string | undefined;
  readonly unknownOutcome: string | undefined;
  /** Read again without replacing the draft (the first load's retry). */
  readonly reload: () => void;
  /** Read again and adopt the answer: Reload saved, and a Retry after a failed refresh. */
  readonly reloadSaved: () => void;
  readonly setText: (text: string) => void;
  /** Stage the shipped default: Save then clears the override. */
  readonly stageDefault: () => void;
  readonly stageCustom: () => void;
  readonly discard: () => void;
  readonly submit: () => Promise<void>;
  readonly copyDraft: () => void;
}

export function useSystemPromptEditor(
  client: SettingsClient,
  workspaceId: string,
  /** Told after a save or a reset the owner acknowledged, e.g. to refresh a preview. */
  onSaved?: () => void,
): SystemPromptEditorState {
  const load = () => systemPromptActions.load(client, workspaceId);
  const { data, error, loading, reload } = useLoaded<SystemPromptAnswer>(load);

  const [saved, setSaved] = useState<SystemPromptState | undefined>();
  const [draft, setDraft] = useState<{ readonly mode: SystemPromptMode; readonly text: string } | undefined>();
  const [adoptNextLoad, setAdoptNextLoad] = useState(false);
  /**
   * The answer object the draft was last taken from.
   *
   * Identity, not a boolean: `useLoaded` publishes a fresh object per read, so a
   * "reload was asked for" flag would be consumed by the *old* answer the moment
   * the flag flipped — adopting stale state and then ignoring the real reload.
   */
  const adopted = useRef<SystemPromptAnswer | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [conflict, setConflict] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<string | undefined>();
  const [unknownOutcome, setUnknownOutcome] = useState<string | undefined>();
  /** The workspace the mounted draft belongs to, so a prop change cannot carry it across. */
  const previousWorkspace = useRef(workspaceId);

  const adopt = (state: SystemPromptState): void => {
    setSaved(state);
    setDraft({ mode: state.mode, text: state.text });
    setConflict(undefined);
    setRefusal(undefined);
    setUnknownOutcome(undefined);
    // The note describes a transition; once the state it described is replaced,
    // keeping it would have the page contradict its own form.
    setNote(undefined);
  };

  useEffect(() => {
    // A changed `workspaceId` prop must not leave one workspace's text on screen
    // to be saved into another. The shell keys this view by workspace, so this is
    // a belt-and-braces guard rather than the only defense, and it makes
    // the guarantee independent of caller discipline.
    if (previousWorkspace.current === workspaceId) return;
    previousWorkspace.current = workspaceId;
    adopted.current = undefined;
    setSaved(undefined);
    setDraft(undefined);
    setConflict(undefined);
    setRefusal(undefined);
    setUnknownOutcome(undefined);
    setNote(undefined);
    setAdoptNextLoad(false);
    reload();
  }, [workspaceId, reload]);

  useEffect(() => {
    // Seeded on the first load, and afterwards only when something explicitly
    // asked for the saved state to replace the draft — and only for an answer
    // this component has not already taken. An answer for a different workspace
    // is never adopted, however it arrived.
    if (data === undefined || data.workspaceId !== workspaceId || adopted.current === data) return;
    if (saved === undefined || adoptNextLoad) {
      adopted.current = data;
      adopt(systemPromptState(data));
      setAdoptNextLoad(false);
    }
    // `adopt` is a fresh closure each render; the inputs that matter are these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, saved, adoptNextLoad, workspaceId]);

  const dirty = saved !== undefined && draft !== undefined && systemPromptDirty(saved, draft);

  useUnsavedGuard(dirty);

  const reloadSaved = (): void => {
    setAdoptNextLoad(true);
    reload();
  };

  const submit = async (): Promise<void> => {
    if (saved === undefined || draft === undefined) return;
    // A conflicted editor cannot save: `saved.revision` is deliberately not
    // advanced by a refusal, so a retry would resend the same stale revision.
    if (!dirty || systemPromptProblem(draft.mode, draft.text) !== undefined || saving || conflict !== undefined) return;
    setSaving(true);
    setNote(undefined);
    setConflict(undefined);
    setRefusal(undefined);
    setUnknownOutcome(undefined);
    const outcome =
      draft.mode === "custom"
        ? await systemPromptActions.save(client, workspaceId, draft.text, saved.revision)
        : await systemPromptActions.reset(client, workspaceId, saved.revision);
    setSaving(false);
    if (outcome.ok) {
      // The acknowledgement is the authoritative saved state, so the draft and
      // the baseline move together and the form is no longer dirty.
      adopt(systemPromptState(outcome.value));
      setNote(draft.mode === "custom" ? translateNow("settings.editor.saved") : translateNow("settings.editor.cleared"));
      onSaved?.();
      return;
    }
    if (outcome.code === "CONFLICT") {
      // Keep the draft: the operator's text is the thing worth preserving, and
      // the newer revision is offered rather than applied. No silent retry.
      setConflict(outcome.message);
      return;
    }
    if (outcome.code !== undefined && outcome.code !== "INTERNAL") {
      // A typed refusal is a definite answer from the owner: the write did not
      // happen, so the draft stays and the reason is shown as itself.
      setRefusal(outcome.message);
      return;
    }
    // No code at all (a timeout or a dropped connection), or an `INTERNAL` raised
    // after the write: the outcome is genuinely unknown, not a rollback.
    setUnknownOutcome(outcome.message);
  };

  return {
    error,
    loading,
    saved,
    draft,
    dirty,
    saving,
    note,
    conflict,
    refusal,
    unknownOutcome,
    reload,
    reloadSaved,
    setText: (text) => {
      setDraft({ mode: "custom", text });
      // The previous transition's note no longer describes what is on screen.
      setNote(undefined);
    },
    stageDefault: () => {
      if (saved === undefined) return;
      setDraft({ mode: "default", text: saved.shipped.text });
      setNote(undefined);
    },
    stageCustom: () => {
      if (saved === undefined) return;
      setDraft({ mode: "custom", text: saved.text });
      setNote(undefined);
    },
    discard: () => {
      if (saved !== undefined) adopt(saved);
    },
    submit,
    copyDraft: () => {
      if (draft === undefined) return;
      void copyDraft(draft.text).then(setNote);
    },
  };
}

/**
 * A compare-and-set refusal: the draft is kept, and the way forward is to
 * reload the saved text or copy the draft first. Shared by the system prompt
 * and the persona editors.
 */
const CONFLICT_KEYS: { readonly [What in "prompt" | "persona" | "instructions"]: UiKey } = {
  prompt: "settings.editor.conflict.prompt",
  persona: "settings.editor.conflict.persona",
  instructions: "settings.editor.conflict.instructions",
};

export function ConflictNotice({
  message,
  what,
  disabled,
  onReload,
  onCopy,
}: {
  readonly message: string;
  /** What the reload brings back. */
  readonly what: "prompt" | "persona" | "instructions";
  readonly disabled: boolean;
  readonly onReload: () => void;
  readonly onCopy: () => void;
}) {
  const t = useT();
  return (
    <Failure as="div">
      <p>
        {message} {t(CONFLICT_KEYS[what])}
      </p>
      <div className="actions">
        <Button disabled={disabled} onClick={onReload}>
          {t("settings.editor.reloadSaved")}
        </Button>
        <Button onClick={onCopy}>{t("settings.editor.copyDraft")}</Button>
      </div>
    </Failure>
  );
}

/**
 * The editor's form and its outcomes: the textarea, the character count, Save,
 * Discard, the staged default, and the conflict, refusal and unknown-outcome
 * notices. The caller renders the heading and the loading and error states.
 */
export function SystemPromptEditor({
  editor,
  id = "system-prompt",
  rows = 14,
  defaultLabel,
  className,
}: {
  readonly editor: SystemPromptEditorState;
  /** The prefix of the form's element ids, unique on the page. */
  readonly id?: string;
  readonly rows?: number;
  /** What the button staging the shipped default says. */
  readonly defaultLabel?: string;
  readonly className?: string;
}) {
  const t = useT();
  const { saved, draft, dirty, saving, conflict, refusal, unknownOutcome, note } = editor;
  if (saved === undefined || draft === undefined) return null;
  const restore = defaultLabel ?? t("settings.editor.restore");
  const problem = systemPromptProblem(draft.mode, draft.text);
  const canSave = dirty && problem === undefined && !saving && conflict === undefined;
  return (
    <div className={className}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void editor.submit();
        }}
      >
        <label htmlFor={`${id}-text`}>{t("settings.systemPrompt.title")}</label>
        <textarea
          id={`${id}-text`}
          className="prompt-text"
          aria-label={t("settings.systemPrompt.title")}
          aria-describedby={`${id}-count ${id}-problem`}
          rows={rows}
          // The bound is in string code units, matching the owner's schema and
          // the DOM's own `maxLength` accounting.
          maxLength={SETTINGS_BOUNDS.systemPrompt}
          readOnly={draft.mode === "default"}
          disabled={saving}
          value={draft.text}
          onChange={(event) => editor.setText(event.target.value)}
        />
        {/* Described by, not announced on every keystroke: a live region here
            would queue speech against the typing it is counting. */}
        <p id={`${id}-count`} className="editor-count">
          {t("settings.editor.count", { length: draft.text.length, max: SETTINGS_BOUNDS.systemPrompt })}
        </p>
        <Failure alert={false} id={`${id}-problem`}>
          {problem ?? ""}
        </Failure>

        <div className="actions">
          <Button variant="primary" type="submit" disabled={!canSave}>
            {/* Said only when it is the change: going back to the shipped prompt from a custom one. */}
            {saving
              ? t("ui.parts.saving")
              : draft.mode === "default" && dirty
                ? t("settings.editor.saveDefault")
                : t("settings.action.save")}
          </Button>
          {/* Offered for an edit only: with nothing changed there is nothing to discard. */}
          {dirty ? (
            <Button disabled={saving} onClick={editor.discard}>
              {t("settings.editor.discard")}
            </Button>
          ) : null}
          {draft.mode === "custom" ? (
            <Button disabled={saving} onClick={editor.stageDefault}>
              {restore}
            </Button>
          ) : (
            <Button disabled={saving} onClick={editor.stageCustom}>
              {t("settings.editor.writeCustom")}
            </Button>
          )}
        </div>
        {/* How going back works, where a saved custom prompt is there to go back from: not while a first one is being written. */}
        {saved.mode === "custom" ? <p>{t("settings.editor.restoreHint", { restore })}</p> : null}
      </form>

      {/* Boxed and held in view a moment, as every settings page's saved note is. */}
      <PageNote note={note} tone="note" />

      {conflict === undefined ? null : (
        <ConflictNotice message={conflict} what="prompt" disabled={saving} onReload={editor.reloadSaved} onCopy={editor.copyDraft} />
      )}

      {refusal === undefined ? null : (
        <Failure as="div">
          <p>
            {refusal} {t("settings.editor.refused")}
          </p>
        </Failure>
      )}

      {unknownOutcome === undefined ? null : (
        <Failure as="div">
          <p>
            {unknownOutcome} {t("settings.editor.unknown")}
          </p>
          <div className="actions">
            <Button disabled={saving} onClick={editor.reloadSaved}>
              {t("settings.editor.reloadSaved")}
            </Button>
          </div>
        </Failure>
      )}
    </div>
  );
}
