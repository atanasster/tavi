import { useT } from "../../lib/i18n.js";
import { Failure, PageHead, Pending } from "../../ui/Parts.js";
import { LoadError } from "./FormParts.js";
import { SystemPromptEditor, useSystemPromptEditor } from "./SystemPromptEditor.js";
import { useWorkspace } from "../shell/Workspace.js";
import { DEFAULT_WORKSPACE_ID } from "@tavi/contracts";
import { workspaceWords } from "./common.js";

/**
 * Settings → System prompt.
 *
 * The editor's whole job is to make one thing legible: what an operator saves
 * here applies from each chat's next message, not to a turn already running, so
 * the activation copy says when it takes effect, and the shipped default is shown
 * as its own read-only view rather than as an editable placeholder.
 *
 * The draft, the saved baseline, the compare-and-set save and its outcomes are
 * `useSystemPromptEditor`'s (`SystemPromptEditor.tsx`, which says why the draft
 * and the saved state are kept apart), shared with the Command Center's Soul pane.
 *
 * A draft is not preserved across an in-app view switch: the shell mounts one
 * settings view at a time, so leaving the subview unmounts the editor. The
 * hook's browser-level guard covers a reload or a close, which is the loss this
 * editor can actually prevent from inside a page.
 */
export function SystemPromptSettings() {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const { client } = useWorkspace();
  const editor = useSystemPromptEditor(client, workspaceId);
  const { saved, draft, error, loading } = editor;

  const heading = (
    <PageHead
      className="settings-head"
      title={t("settings.systemPrompt.title")}
      description={t("settings.systemPrompt.description", { workspace: workspaceWords(workspaceId) })}
    />
  );

  if (error !== undefined && saved === undefined) {
    return (
      <section className="settings">
        {heading}
        <LoadError error={error} reload={editor.reload} />
      </section>
    );
  }
  if (saved === undefined || draft === undefined) {
    return (
      <section className="settings">
        {heading}
        <Pending label={t("settings.systemPrompt.loading")} className="notice" status />
      </section>
    );
  }

  return (
    <section className="settings">
      {heading}
      {/* An operator-asked reload adopts its answer, like the other explicit
          paths: otherwise a failed refresh leaves the form showing state the
          owner has moved past. */}
      {error === undefined ? null : <LoadError error={error} reload={editor.reloadSaved} />}
      {loading ? <p>{t("settings.systemPrompt.refreshing")}</p> : null}

      {saved.explicitAdapterShadowing ? <Failure>{t("settings.systemPrompt.shadowed")}</Failure> : null}

      <p>
        <strong>{saved.mode === "default" ? t("settings.systemPrompt.builtIn") : t("settings.systemPrompt.custom")}</strong>
        {" · "}
        {workspaceId === DEFAULT_WORKSPACE_ID
          ? t("settings.systemPrompt.applies", { revision: String(saved.revision) })
          : t("settings.systemPrompt.appliesIn", { revision: String(saved.revision), workspaceId })}
      </p>

      <SystemPromptEditor editor={editor} />

      <details className="settings-panel">
        <summary className="disclosure">{t("settings.systemPrompt.shipped", { version: saved.shipped.templateVersion })}</summary>
        {/* Rendered as text, never as markup: an operator's prompt is data. */}
        <pre role="region" aria-label={t("settings.systemPrompt.shippedLabel")}>
          {saved.shipped.text}
        </pre>
      </details>
      <details className="settings-panel">
        <summary className="disclosure">{t("settings.systemPrompt.added")}</summary>
        <p>{t("settings.systemPrompt.addedBody")}</p>
      </details>
    </section>
  );
}
