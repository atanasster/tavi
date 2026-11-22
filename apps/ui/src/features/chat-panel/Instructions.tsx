import { CHAT_INSTRUCTIONS_MAX, type ChatContextAnswer, type ChatInstructionsRevision } from "@tavi/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { loadPromptPreview } from "../center/memory-api.js";
import { instantLabel, todayIn } from "../../lib/time.js";
import { LayerRow } from "../center/LayerRow.js";
import { copyDraft } from "../../lib/clipboard.js";
import { formatCount } from "../../lib/format.js";
import { useT } from "../../lib/i18n.js";
import { ConflictNotice } from "../settings/SystemPromptEditor.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Failure, Pending, StatusNote } from "../../ui/Parts.js";
import type { Session } from "../shell/shell.js";
import { loadChatContext, loadChatHistory, loadChatPreview, saveChatInstructions } from "./api.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Button } from "../../ui/Button.js";

/**
 * The chat panel's Instructions tab: the chat's own
 * instructions, the top layer of its prompt, edited here; the layers it
 * inherits, edited where they live. On an owner without `chat-context` the
 * tab is the read-only view of the inherited layers.
 *
 * Before the chat's first message the instructions are a draft the page
 * holds and sends with that message; after, each save is a revision
 * under a compare-and-set that applies from the chat's next turn.
 */
export function Instructions({
  session,
  editable,
  draft,
  onDraft,
  onSettings,
  onSoul,
  onOpenTask,
  onSaved,
  version = "",
}: {
  readonly session?: Session | undefined;
  /** Whether the owner offers `chat-context`. */
  readonly editable: boolean;
  /** A new chat's instructions, held by the page until its first message carries them. */
  readonly draft?: string | undefined;
  readonly onDraft?: ((text: string) => void) | undefined;
  readonly onSettings: () => void;
  readonly onSoul?: (() => void) | undefined;
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
  /** Told after a save the owner acknowledged, so what shows the chat's instructions elsewhere reads them again. */
  readonly onSaved?: (() => void) | undefined;
  /** What changes when the chat's instructions may have changed elsewhere: they are read again then. */
  readonly version?: string | undefined;
}) {
  const t = useT();
  const taskId = session?.taskId;
  /** Moves on each save, so the preview below is read again with the new instructions. */
  const [saved, setSaved] = useState(0);
  return (
    <>
      {!editable ? null : taskId === undefined ? (
        onDraft === undefined ? null : (
          <DraftInstructions draft={draft ?? ""} onDraft={onDraft} />
        )
      ) : (
        <ChatInstructions
          key={taskId}
          version={version}
          taskId={taskId}
          onOpenTask={onOpenTask}
          onSaved={() => {
            setSaved((value) => value + 1);
            onSaved?.();
          }}
        />
      )}
      <Inherited version={`${version}|${saved}`} taskId={editable ? taskId : undefined} />
      <p className="chat-panel-links">
        <Button variant="ghost" size="sm" onClick={onSettings}>
          {t("chatPanel.instructions.settingsLink")}
        </Button>
        {onSoul === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={onSoul}>
            {t("chatPanel.instructions.soulLink")}
          </Button>
        )}
      </p>
    </>
  );
}

/** What the character count says, and whether the text is over the bound. */
function Count({ text }: { readonly text: string }) {
  const over = text.length > CHAT_INSTRUCTIONS_MAX;
  return (
    <span className={over ? "chat-panel-count-text over" : "chat-panel-count-text"}>
      {formatCount(text.length)} / {formatCount(CHAT_INSTRUCTIONS_MAX)}
    </span>
  );
}

function DraftInstructions({ draft, onDraft }: { readonly draft: string; readonly onDraft: (text: string) => void }) {
  const t = useT();
  const id = useId();
  return (
    <section className="chat-panel-editor" aria-label={t("chatPanel.instructions.label")}>
      <h4>
        <label htmlFor={id}>{t("chatPanel.instructions.heading")}</label>
      </h4>
      <textarea
        id={id}
        rows={6}
        value={draft}
        aria-invalid={draft.length > CHAT_INSTRUCTIONS_MAX}
        placeholder={t("chatPanel.instructions.placeholder")}
        onChange={(event) => onDraft(event.target.value)}
      />
      <p className="chat-panel-note meta-sm">
        {t("chatPanel.instructions.draftNote")} <Count text={draft} />
      </p>
    </section>
  );
}

function ChatInstructions({
  version,
  taskId,
  onOpenTask,
  onSaved,
}: {
  readonly version: string;
  readonly taskId: string;
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
  readonly onSaved?: (() => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data: loaded, error, reload } = useLoaded(() => loadChatContext(client, workspaceId, taskId), [version]);
  /** A save's acknowledgement: the saved state until a read at least as new arrives. */
  const [acknowledged, setAcknowledged] = useState<ChatContextAnswer>();
  const data = acknowledged !== undefined && (loaded === undefined || acknowledged.revision > loaded.revision) ? acknowledged : loaded;
  const [draft, setDraft] = useState<string>();
  /**
   * When to seed the draft from a load: `null` the first load; an answer, the
   * next load that is not it (a Reload saved: the answer held when it was
   * asked is stale); `undefined` never — a refresh must not erase what the
   * reader is writing.
   */
  const [adoptAfter, setAdoptAfter] = useState<object | null | undefined>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  const [savedNote, setSavedNote] = useState(false);
  /** What a Copy draft said: the draft is on the clipboard, or how to copy it by hand. */
  const [copied, setCopied] = useState<string>();
  const [history, setHistory] = useState(0);
  const id = useId();
  const saved = data?.current?.text ?? "";
  /** The saved text the editor last showed, so a change made elsewhere reaches an editor the reader has not touched. */
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (data === undefined) return;
    const now = data.current?.text ?? "";
    if (adoptAfter !== undefined && data !== adoptAfter) {
      setDraft(now);
      setAdoptAfter(undefined);
    } else if (shown.current !== undefined && shown.current !== now && draft === shown.current) {
      setDraft(now);
    }
    shown.current = now;
  }, [data, adoptAfter, draft]);

  if (data === undefined) return <Pending error={error} />;
  if (data.delegatedFrom !== undefined) {
    return (
      <section className="chat-panel-editor" aria-label={t("chatPanel.instructions.label")}>
        <h4>{t("chatPanel.instructions.heading")}</h4>
        <p className="chat-panel-note meta-sm">{t("chatPanel.instructions.agentTask")}</p>
        {onOpenTask === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={() => onOpenTask(data.delegatedFrom as string)}>
            {t("chatPanel.instructions.openParent")}
          </Button>
        )}
      </section>
    );
  }
  const text = draft ?? saved;
  const dirty = text !== saved;
  const over = text.length > CHAT_INSTRUCTIONS_MAX;
  const save = async (next: string): Promise<void> => {
    setSaving(true);
    setConflict(undefined);
    setRefusal(undefined);
    setCopied(undefined);
    const outcome = await saveChatInstructions(client, workspaceId, taskId, next.trim() === "" ? "" : next, data.revision);
    setSaving(false);
    if (outcome.ok) {
      // The acknowledgement is the saved state: the draft becomes it now, and
      // the read that follows only confirms it.
      setAcknowledged(outcome.value);
      setDraft(outcome.value.current?.text ?? "");
      setSavedNote(true);
      setHistory((value) => value + 1);
      reload();
      onSaved?.();
    } else if (outcome.code === "CONFLICT") setConflict(t("chatPanel.instructions.conflict"));
    else setRefusal(outcome.message);
  };
  return (
    <section className="chat-panel-editor" aria-label={t("chatPanel.instructions.label")}>
      <h4>
        <label htmlFor={id}>{t("chatPanel.instructions.heading")}</label>{" "}
        {data.revision === 0 ? null : <span className="muted">{t("chatPanel.instructions.revision", { revision: data.revision })}</span>}
      </h4>
      <textarea
        id={id}
        rows={8}
        value={text}
        placeholder={t("chatPanel.instructions.placeholder")}
        onChange={(event) => {
          setDraft(event.target.value);
          setSavedNote(false);
        }}
        aria-invalid={over}
      />
      <p className="chat-panel-note meta-sm">
        {dirty || savedNote ? <span className="chat-panel-pill">{t("chatPanel.instructions.appliesNext")}</span> : null}{" "}
        <Count text={text} />
      </p>
      <StatusNote note={copied} className="" />
      {conflict === undefined ? null : (
        <ConflictNotice
          message={conflict}
          what="instructions"
          disabled={saving}
          onReload={() => {
            setConflict(undefined);
            setCopied(undefined);
            setAdoptAfter(data);
            reload();
          }}
          onCopy={() => void copyDraft(text).then(setCopied)}
        />
      )}
      <Failure message={refusal} />
      <div className="actions">
        <Button variant="primary" size="sm" disabled={!dirty || saving || over} onClick={() => void save(text)}>
          {saving ? t("ui.parts.saving") : t("chatPanel.instructions.save")}
        </Button>
        {/* Discard is offered for an edit, Clear for saved instructions: each only when it would do something. */}
        {dirty ? (
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(saved)}>
            {t("chatPanel.instructions.discard")}
          </Button>
        ) : null}
        {saved === "" ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              setDraft("");
              void save("");
            }}
          >
            {t("chatPanel.instructions.clear")}
          </Button>
        )}
      </div>
      {data.revision === 0 ? null : (
        <History
          key={history}
          taskId={taskId}
          onUse={(revision) => {
            setDraft(revision.text);
            setSavedNote(false);
          }}
        />
      )}
    </section>
  );
}

/** Earlier revisions, read when opened; any can be taken back into the draft (undo). */
function History({ taskId, onUse }: { readonly taskId: string; readonly onUse: (revision: ChatInstructionsRevision) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details className="chat-panel-inherited" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="disclosure">{t("chatPanel.instructions.history")}</summary>
      {open ? <HistoryList taskId={taskId} onUse={onUse} /> : null}
    </details>
  );
}

function HistoryList({ taskId, onUse }: { readonly taskId: string; readonly onUse: (revision: ChatInstructionsRevision) => void }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => loadChatHistory(client, workspaceId, taskId));
  const timeZone = useTimeZone();
  if (data === undefined) return <Pending error={error} />;
  const today = todayIn(timeZone);
  return (
    <ol className="chat-panel-records">
      {data.revisions.map((revision) => (
        <li key={revision.revision}>
          <span className="chat-panel-item-title truncate">
            {revision.text === "" ? t("chatPanel.instructions.cleared") : revision.text}
          </span>
          <span className="chat-panel-item-detail meta-sm">
            {t("chatPanel.instructions.revisionLine", {
              revision: revision.revision,
              author: revision.author,
              when: instantLabel(revision.recordedAt, timeZone, today),
            })}{" "}
            <Button variant="ghost" size="sm" onClick={() => onUse(revision)}>
              {t("chatPanel.instructions.useThis")}
            </Button>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The layers the chat inherits, folded away: with a chat, the layers its next
 * turn would be given (its own base, then its instructions); without one, what
 * a new chat is given now.
 */
function Inherited({
  version,
  taskId,
}: {
  /** Read again when it changes: after each save. */ readonly version: string;
  readonly taskId: string | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data, error } = useLoaded(
    () => (taskId === undefined ? loadPromptPreview(client, workspaceId) : loadChatPreview(client, workspaceId, taskId)),
    [version],
  );
  return (
    <details className="chat-panel-inherited" open={taskId === undefined}>
      <summary className="disclosure">
        {t(taskId === undefined ? "chatPanel.instructions.newChatLayers" : "chatPanel.instructions.nextTurnPrompt")}
      </summary>
      <p className="chat-panel-note meta-sm">
        {t(taskId === undefined ? "chatPanel.instructions.newChatNote" : "chatPanel.instructions.nextTurnNote")}
      </p>
      {data === undefined ? (
        <Pending error={error} />
      ) : (
        <>
          <ol className="soul-layers list-reset" aria-label={t("chatPanel.instructions.layers")}>
            {data.layers.map((layer, index) => (
              <LayerRow key={`${layer.kind}:${layer.source ?? ""}:${index}`} layer={layer} />
            ))}
          </ol>
          {data.budget === undefined ? null : <Budget fixed={data.budget.fixedTokens} max={data.budget.maxTokens} />}
        </>
      )}
    </details>
  );
}

/** Past this share of the budget, the fixed prompt leaves little room for memory, skills and the runtime facts. */
const BUDGET_WARN_SHARE = 0.6;

/**
 * The fixed prompt's size against the context budget each call is checked
 * against: past it a call is refused, and near it memory and skills are
 * squeezed out first.
 */
function Budget({ fixed, max }: { readonly fixed: number; readonly max: number }) {
  const t = useT();
  const over = fixed > max;
  const near = !over && fixed > max * BUDGET_WARN_SHARE;
  return (
    <p className={over || near ? "chat-panel-budget meta-sm warn" : "chat-panel-budget meta-sm"} role={over || near ? "alert" : undefined}>
      {t("chatPanel.instructions.budget", { fixed, max })}
      {over ? ` ${t("chatPanel.instructions.overBudget")}` : near ? ` ${t("chatPanel.instructions.nearBudget")}` : null}
    </p>
  );
}
