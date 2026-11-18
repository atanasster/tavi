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
  const { workspaceId } = useWorkspace();
  const { client } = useWorkspace();
  const editor = useSystemPromptEditor(client, workspaceId);
  const { saved, draft, error, loading } = editor;

  const heading = (
    <PageHead
      className="settings-head"
      title="System prompt"
      description={
        <>
          The base instructions for chats in {workspaceWords(workspaceId)}. A new chat, and each existing chat's next message, run under it.
          A persona is appended after this text, and a routine's own pinned instructions always win.
        </>
      }
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
        <Pending label="Loading system prompt…" className="notice" status />
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
      {loading ? <p>Refreshing…</p> : null}

      {saved.explicitAdapterShadowing ? (
        <Failure>
          This owner runs a prompt configured outside the workspace settings, which outranks this one: messages run under it, not what you
          save here. This is unusual — no ordinary workspace task selects a prompt this way today — and a save here still changes what a
          task without such a prompt would use.
        </Failure>
      ) : null}

      <p>
        <strong>{saved.mode === "default" ? "Built-in default" : "Custom"}</strong> · revision {saved.revision} · applies from the next
        message{workspaceId === DEFAULT_WORKSPACE_ID ? "" : ` in ${workspaceId}`}
      </p>

      <SystemPromptEditor editor={editor} />

      <details className="settings-panel">
        <summary className="disclosure">The shipped default ({saved.shipped.templateVersion})</summary>
        {/* Rendered as text, never as markup: an operator's prompt is data. */}
        <pre role="region" aria-label="Shipped default system prompt">
          {saved.shipped.text}
        </pre>
      </details>
      <details className="settings-panel">
        <summary className="disclosure">What gets added to this text</summary>
        <p>
          A named agent's persona is appended after this text, and resolved memory, approved skills and retrieved context are added
          separately on every model call. The compaction summary call uses its own dedicated prompt and is unaffected. Personas are looked
          up live, so this release does not snapshot them.
        </p>
      </details>
    </section>
  );
}
