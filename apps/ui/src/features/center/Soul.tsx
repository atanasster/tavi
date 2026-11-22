import type { CenterSummaryAnswer } from "@tavi/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { AppLink } from "../shell/AppLink.js";
import { copyDraft } from "../../lib/clipboard.js";
import { Icon } from "../../ui/Icon.js";
import { formatCount } from "../../lib/format.js";
import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import { withParts } from "../../ui/with-parts.js";
import { useUnsavedGuard } from "../../hooks/page.js";
import { useOpenError } from "../../hooks/use-action.js";
import { SETTINGS_BOUNDS } from "../settings/common.js";
import { systemPromptLengthProblem } from "../settings/system-prompt-api.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { Failure, InlineConfirm, LoadError, Notice, PageHead, Pending, StatusNote } from "../../ui/Parts.js";
import { routinePath } from "../shell/route.js";
import { ConflictNotice, SystemPromptEditor, useSystemPromptEditor } from "../settings/SystemPromptEditor.js";
import { listAgents, loadPersona, loadPromptPreview, savePersona, type AgentSummary, type Persona } from "./memory-api.js";
import { MemoryPane } from "./Memory.js";
import { SkillsPane } from "./Skills.js";
import { useChatTitle } from "./ReminderRows.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { listEveryChatNote } from "../chat-panel/api.js";
import { recordTitle } from "./memory-model.js";
import { LayerRow } from "./LayerRow.js";
import { todayIn } from "../../lib/time.js";
import { Select } from "../../ui/Select.js";
import { Empty } from "../../ui/Empty.js";
import { TabList } from "../../ui/Tabs.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/**
 * The Soul pane: the layers a new task's
 * instructions are assembled from, as `system-prompt preview` lists them, and
 * an editor for the two an operator writes — the workspace prompt (the same
 * editor as Settings → System prompt) and an agent's persona — beside the
 * shipped default, read-only. Every save applies from the next message.
 */

type SoulTab = "prompt" | "persona" | "shipped";

/** The preview choice meaning no agent: what a plain task is sent. */
const NO_AGENT = "";

/** No agents listed yet: one list, so what depends on it does not see a new one each render. */
const NO_AGENTS: readonly AgentSummary[] = [];

/** A routine's page inside Schedule, as a link. */
function RoutineLink({
  routineId,
  name,
  onOpen,
}: {
  readonly routineId: string;
  readonly name: string;
  readonly onOpen: ((routineId: string) => void) | undefined;
}) {
  return (
    <AppLink href={routinePath(routineId)} onFollow={onOpen === undefined ? undefined : () => onOpen(routineId)}>
      {name}
    </AppLink>
  );
}

/** "Morning news and Evening digest": routines named in a sentence. */
function routineNames(pins: readonly { readonly name: string }[]): string {
  const names = pins.map((pin) => pin.name);
  return names.length <= 1
    ? (names[0] ?? "")
    : translateNow("center.soul.namesAnd", { names: names.slice(0, -1).join(", "), last: names.at(-1) ?? "" });
}

function SoulPane({
  agents,
  onOpenRoutine,
}: {
  readonly agents: readonly AgentSummary[];
  /** A routine's page, where a routine's pinned instructions are edited. */
  readonly onOpenRoutine?: ((routineId: string) => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [tab, setTab] = useState<SoulTab>("prompt");
  const [agentId, setAgentId] = useState<string | undefined>(agents[0]?.agentId);
  /** The agent the layers are previewed for: none, a plain task, until one is picked. */
  const [previewAgent, setPreviewAgent] = useState(NO_AGENT);
  const [previewKey, setPreviewKey] = useState(0);
  const refreshPreview = (): void => setPreviewKey((value) => value + 1);
  const editor = useSystemPromptEditor(client, workspaceId, refreshPreview);
  const persona = usePersonaEditor(client, workspaceId, agentId, refreshPreview, agents);
  const ids = useId();

  // The picked agent follows the list: the first one once agents load, another
  // when the picked one is gone. Set while rendering, so no render shows a gone agent.
  const firstAgent = agents[0]?.agentId;
  if (agentId !== firstAgent && !(agentId !== undefined && agents.some((agent) => agent.agentId === agentId))) setAgentId(firstAgent);
  // An agent previewed and then gone: back to a plain task.
  if (previewAgent !== NO_AGENT && !agents.some((agent) => agent.agentId === previewAgent)) setPreviewAgent(NO_AGENT);
  // No agents, no Persona tab to stand on.
  const tabs: readonly { readonly value: SoulTab; readonly label: string }[] = [
    { value: "prompt", label: t("center.soul.tabPrompt") },
    ...(agents.length > 0 ? [{ value: "persona" as const, label: t("center.soul.tabPersona") }] : []),
    { value: "shipped", label: t("center.soul.tabShipped") },
  ];
  const current = tabs.some((item) => item.value === tab) ? tab : "prompt";

  return (
    <section className="soul-pane card-flat" aria-labelledby="soul-title">
      <header className="soul-pane-head">
        <span className="soul-glyph" aria-hidden="true">
          <Icon name="sparkles" size="sm" />
        </span>
        <div>
          <h2 id="soul-title">{t("center.soul.title")}</h2>
          <p className="soul-pane-sub meta-sm">{t("center.soul.sub")}</p>
        </div>
      </header>

      {agents.length === 0 ? null : (
        <p className="soul-preview-for">
          <Field id={`${ids}-preview`} label={t("center.soul.layersFor")} inline>
            <Select value={previewAgent} onChange={(event) => setPreviewAgent(event.target.value)}>
              <option value={NO_AGENT}>{t("center.soul.noAgent")}</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.enabled ? agent.name : t("center.soul.agentDisabled", { name: agent.name })}
                </option>
              ))}
            </Select>
          </Field>
        </p>
      )}
      <PromptLayers agentId={previewAgent === NO_AGENT ? undefined : previewAgent} refresh={previewKey} />

      <div className="soul-editor">
        <TabList
          label={t("center.soul.editTabs")}
          className="soul-tabs tabs-underline"
          tabClassName="button-bare"
          items={tabs.map((item) => ({ value: item.value, content: item.label }))}
          current={current}
          onPick={setTab}
          tabId={(value) => `${ids}-tab-${value}`}
          panelId={`${ids}-panel`}
        />
        <div className="soul-panel" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${current}`}>
          <p className="soul-note meta-sm">{t("center.soul.applies")}</p>
          {current === "prompt" ? (
            editor.saved === undefined ? (
              <Pending error={editor.error} reload={editor.reload} label={t("center.soul.loadingPrompt")} className="notice" status />
            ) : (
              <>
                {editor.error === undefined ? null : <LoadError error={editor.error} reload={editor.reloadSaved} />}
                <p className="soul-status meta-sm">
                  {withParts(t("center.soul.status", { revision: String(editor.saved.revision) }), {
                    mode: <strong>{editor.saved.mode === "default" ? t("center.soul.statusDefault") : t("center.soul.tabPrompt")}</strong>,
                  })}
                </p>
                <SystemPromptEditor
                  editor={editor}
                  id="soul-prompt"
                  rows={12}
                  defaultLabel={t("center.soul.useDefault")}
                  className="soul-form"
                />
              </>
            )
          ) : current === "persona" ? (
            <PersonaEditor persona={persona} agents={agents} agentId={agentId} onPick={setAgentId} onOpenRoutine={onOpenRoutine} />
          ) : editor.saved === undefined ? (
            <Pending error={editor.error} reload={editor.reload} className="notice" status />
          ) : (
            <>
              <p className="soul-status meta-sm">
                {withParts(
                  t("center.soul.shippedStatus", {
                    count: editor.saved.shipped.text.length,
                    version: editor.saved.shipped.templateVersion,
                  }),
                  { figure: <span className="soul-figure">{formatCount(editor.saved.shipped.text.length)}</span> },
                )}
              </p>
              {/* Rendered as text, never as markup: a prompt is data. */}
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard */}
              <pre className="soul-shipped" role="region" aria-label={t("center.soul.shippedLabel")} tabIndex={0}>
                {editor.saved.shipped.text}
              </pre>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** The layer stack, read again whenever `refresh` or the picked agent moves. */
function PromptLayers({ agentId, refresh }: { readonly agentId: string | undefined; readonly refresh: number }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  // A failed read keeps the layers shown before beside its failure.
  const {
    data: preview,
    error,
    reload,
  } = useLoaded(() => loadPromptPreview(client, workspaceId, agentId), [JSON.stringify([workspaceId, agentId ?? null, refresh])]);
  if (preview === undefined) {
    return error === undefined ? (
      <Pending label={t("center.soul.loadingLayers")} className="notice soul-layers-status" status />
    ) : (
      <div className="soul-layers-status">
        <LoadError error={error} reload={reload} />
      </div>
    );
  }
  return (
    <>
      {error === undefined ? null : (
        <Failure alert={false} className="soul-layers-status">
          {error}
        </Failure>
      )}
      <ol className="soul-layers list-reset" aria-label={t("center.soul.layers")}>
        {preview.layers.map((layer, index) => (
          <LayerRow key={`${layer.kind}:${layer.source ?? ""}:${index}`} layer={layer} />
        ))}
      </ol>
    </>
  );
}

/** Why a persona draft cannot be saved, or `undefined` when it can. */
function personaProblem(text: string): string | undefined {
  if (text.trim().length === 0) return translateNow("center.soul.personaEmpty");
  return systemPromptLengthProblem(text);
}

/** The persona editor's state, held by the Soul pane so a tab switch keeps the draft. */
interface PersonaEditorState {
  readonly saved: Persona | undefined;
  readonly draft: string;
  readonly dirty: boolean;
  readonly loadError: string | undefined;
  readonly saving: boolean;
  readonly note: string | undefined;
  readonly conflict: string | undefined;
  readonly failure: string | undefined;
  readonly setDraft: (text: string) => void;
  readonly discard: () => void;
  readonly reloadSaved: () => void;
  readonly submit: () => Promise<void>;
  readonly copyDraft: () => void;
}

/**
 * An agent's persona: read whole with `agents show`, saved with `agents
 * update` asserting the `updatedAt` it was read at. A definition changed
 * meanwhile is a conflict with the same Reload saved / Copy draft as the
 * system prompt, and the draft is kept until one is chosen.
 */
function usePersonaEditor(
  client: SettingsClient,
  workspaceId: string,
  agentId: string | undefined,
  onSaved: () => void,
  agents: readonly AgentSummary[],
): PersonaEditorState {
  const [saved, setSaved] = useState<Persona>();
  const [draft, setDraftText] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string>();
  const [conflict, setConflict] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  /** The read whose answer counts; an older one's (another agent's) is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    if (agentId === undefined) return;
    const current = ++generation.current;
    // Another agent's notices describe a persona no longer shown.
    setSaved(undefined);
    setLoadError(undefined);
    setConflict(undefined);
    setFailure(undefined);
    setNote(undefined);
    void loadPersona(client, workspaceId, agentId).then((outcome) => {
      if (current !== generation.current) return;
      if (!outcome.ok) {
        setLoadError(outcome.message);
        return;
      }
      setSaved(outcome.value);
      setDraftText(outcome.value.systemPrompt);
    });
  }, [client, workspaceId, agentId, attempt]);

  const dirty = saved !== undefined && draft !== saved.systemPrompt;

  useUnsavedGuard(dirty);

  const submit = async (): Promise<void> => {
    if (saved === undefined || agentId === undefined || !dirty || personaProblem(draft) !== undefined || saving || conflict !== undefined)
      return;
    const current = generation.current;
    setSaving(true);
    setNote(undefined);
    setFailure(undefined);
    const outcome = await savePersona(client, workspaceId, agentId, draft, saved.updatedAt);
    setSaving(false);
    // Another agent was picked meanwhile: this answer describes a persona no longer shown.
    if (current !== generation.current) return;
    if (outcome.ok) {
      setSaved(outcome.value);
      setDraftText(outcome.value.systemPrompt);
      const pins = agents.find((agent) => agent.agentId === agentId)?.pinnedBy ?? [];
      setNote(
        pins.length === 0
          ? translateNow("center.soul.saved", { name: outcome.value.name })
          : translateNow("center.soul.savedPinned", { count: pins.length, name: outcome.value.name, routines: routineNames(pins) }),
      );
      onSaved();
      return;
    }
    if (outcome.code === "CONFLICT") setConflict(outcome.message);
    else if (outcome.code !== undefined && outcome.code !== "INTERNAL")
      setFailure(translateNow("center.soul.refused", { reason: outcome.message }));
    else setFailure(translateNow("center.soul.mayHaveApplied", { reason: outcome.message }));
  };

  return {
    saved,
    draft,
    dirty,
    loadError,
    saving,
    note,
    conflict,
    failure,
    setDraft: (text) => {
      setDraftText(text);
      setNote(undefined);
    },
    discard: () => {
      if (saved !== undefined) setDraftText(saved.systemPrompt);
    },
    reloadSaved: () => setAttempt((value) => value + 1),
    submit,
    copyDraft: () => {
      void copyDraft(draft).then(setNote);
    },
  };
}

/**
 * The Persona tab: the agent picker and the persona's form. Picking another
 * agent with unsaved changes asks first, in place: Discard, or Keep editing.
 */
function PersonaEditor({
  persona,
  agents,
  agentId,
  onPick,
  onOpenRoutine,
}: {
  readonly persona: PersonaEditorState;
  readonly agents: readonly AgentSummary[];
  readonly agentId: string | undefined;
  readonly onPick: (agentId: string) => void;
  readonly onOpenRoutine?: ((routineId: string) => void) | undefined;
}) {
  const t = useT();
  const { saved, draft, dirty, loadError, saving, note, conflict, failure } = persona;
  /** An agent picked while the draft was dirty, waiting for Discard or Keep editing. */
  const [pending, setPending] = useState<string>();
  const ids = useId();
  const problem = personaProblem(draft);
  const canSave = saved !== undefined && dirty && problem === undefined && !saving && conflict === undefined;
  const picked = agents.find((agent) => agent.agentId === agentId);
  const pendingName = agents.find((agent) => agent.agentId === pending)?.name ?? pending;

  return (
    <div className="soul-form">
      <Field id={`${ids}-agent`} label={t("center.soul.agent")}>
        <Select
          value={agentId ?? ""}
          disabled={saving || pending !== undefined}
          onChange={(event) => {
            if (dirty) setPending(event.target.value);
            else onPick(event.target.value);
          }}
        >
          {agents.map((agent) => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.enabled ? agent.name : t("center.soul.agentDisabled", { name: agent.name })}
            </option>
          ))}
        </Select>
      </Field>
      {pending === undefined ? null : (
        <InlineConfirm
          focusCancel
          label={t("center.soul.unsaved")}
          message={
            saved === undefined
              ? t("center.soul.unsavedThis", { other: pendingName ?? "" })
              : t("center.soul.unsavedNamed", { name: saved.name, other: pendingName ?? "" })
          }
          confirmLabel={t("center.soul.discard")}
          cancelLabel={t("center.soul.keepEditing")}
          onConfirm={() => {
            setPending(undefined);
            onPick(pending);
          }}
          onCancel={() => setPending(undefined)}
        />
      )}
      {picked !== undefined && !picked.enabled ? <Notice>{t("center.soul.agentOff")}</Notice> : null}
      {(picked?.pinnedBy ?? []).map((pin) => (
        <Notice key={pin.routineId} className="soul-pinned">
          {withParts(t("center.soul.pinned"), {
            routine: <RoutineLink routineId={pin.routineId} name={pin.name} onOpen={onOpenRoutine} />,
          })}
        </Notice>
      ))}
      {loadError !== undefined || saved === undefined ? (
        <Pending error={loadError} reload={persona.reloadSaved} label={t("center.soul.loadingPersona")} className="notice" status />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void persona.submit();
          }}
        >
          <label htmlFor={`${ids}-text`}>{t("center.soul.tabPersona")}</label>
          <textarea
            id={`${ids}-text`}
            aria-label={t("center.soul.personaOf", { name: saved.name })}
            aria-describedby={`${ids}-count ${ids}-problem`}
            rows={10}
            maxLength={SETTINGS_BOUNDS.systemPrompt}
            disabled={saving}
            value={draft}
            onChange={(event) => persona.setDraft(event.target.value)}
          />
          <p id={`${ids}-count`} className="editor-count">
            {t("center.soul.count", { count: draft.length, max: SETTINGS_BOUNDS.systemPrompt })}
          </p>
          <Failure alert={false} id={`${ids}-problem`}>
            {problem ?? ""}
          </Failure>
          <div className="actions">
            <Button variant="primary" type="submit" disabled={!canSave}>
              {saving ? t("ui.parts.saving") : t("center.soul.savePersona")}
            </Button>
            {dirty ? (
              <Button disabled={saving} onClick={persona.discard}>
                {t("center.soul.discardChanges")}
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <StatusNote note={note} className="" />
      {conflict === undefined ? null : (
        <ConflictNotice message={conflict} what="persona" disabled={saving} onReload={persona.reloadSaved} onCopy={persona.copyDraft} />
      )}
      {failure === undefined ? null : (
        <Failure as="div">
          <p>{failure}</p>
        </Failure>
      )}
    </div>
  );
}

/**
 * Soul & memory: the Soul pane and the
 * Memory pane side by side from 960 px, stacked below. The workspace's agents
 * are read once for both: the persona picker and Remember's scope picker.
 */
export function SoulAndMemory({
  summary,
  revision,
  focusProposals,
  onProposalsFocused,
  onOpenRoutine,
  onOpenChatNotes,
  onModels,
  skillsRevision,
}: {
  readonly summary: CenterSummaryAnswer | undefined;
  /** Settings → Models, which the memory settings link to for the capture model. */
  readonly onModels?: (() => void) | undefined;
  /** A chat's panel, on its notes; absent when the owner offers no chat notes, and the list is not shown. */
  readonly onOpenChatNotes?: ((taskId: string) => Promise<void>) | undefined;
  /** A routine's page, where a routine's pinned instructions are edited. */
  readonly onOpenRoutine?: ((routineId: string) => void) | undefined;
  /** Moves when the feed reports `memory`. */
  readonly revision: number;
  /** Moves when the feed reports `skill`; absent when the owner offers no `skills` command, and the panel is not shown. */
  readonly skillsRevision?: number | undefined;
  /** The rail's memory proposals were followed and the proposals heading has not taken focus yet. */
  readonly focusProposals: boolean;
  readonly onProposalsFocused: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  // The last agents read stay listed beside a failed reload.
  const listed = useLoaded(() => listAgents(client, workspaceId), [workspaceId]);
  const agents = listed.data?.agents ?? NO_AGENTS;
  const agentsError = listed.error;
  const timeZone = summary?.timezone;
  return (
    <section className="center-section soul" aria-labelledby="center-soul-title">
      <PageHead
        className="center-head"
        id="center-soul-title"
        title={translateCore("nav.center.identity")}
        description={t("center.soul.description")}
      />
      {agentsError === undefined ? null : (
        <LoadError error={t("center.soul.agentsFailed", { error: agentsError })} reload={listed.reload} />
      )}
      <div className="soul-split">
        <SoulPane agents={agents} onOpenRoutine={onOpenRoutine} />
        <MemoryPane
          agents={agents}
          people={summary?.people ?? {}}
          timeZone={timeZone}
          today={summary?.today ?? todayIn(timeZone)}
          revision={revision}
          proposalCount={summary?.counts.memoryProposals}
          focusProposals={focusProposals}
          onProposalsFocused={onProposalsFocused}
          onModels={onModels}
        />
      </div>
      {onOpenChatNotes === undefined ? null : <ChatNotesAcrossChats key={revision} onOpen={onOpenChatNotes} />}
      {skillsRevision === undefined ? null : <SkillsPane revision={skillsRevision} />}
    </section>
  );
}

/**
 * Every chat's notes in one list: notes the
 * reader keeps for one chat each, which the page that lists memory by scope
 * does not show. Each opens its chat's panel, where it is edited.
 */
function ChatNotesAcrossChats({ onOpen }: { readonly onOpen: (taskId: string) => Promise<void> }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => listEveryChatNote(client, workspaceId));
  const { openError: failure, open } = useOpenError();
  const notes = data?.records ?? [];
  return (
    <section className="soul-chat-notes" aria-labelledby="soul-chat-notes-title">
      <h2 id="soul-chat-notes-title">{t("center.soul.notesTitle")}</h2>
      <p className="settings-description">{t("center.soul.notesDescription")}</p>
      {data === undefined ? (
        <Pending error={error} />
      ) : notes.length === 0 ? (
        <Empty>{t("center.soul.notesEmpty")}</Empty>
      ) : (
        <ul className="soul-chat-notes-list list-reset">
          {notes.map((record) => {
            const taskId = record.target.slice("chat:".length);
            return (
              <li key={record.recordId}>
                <span className="soul-chat-note">
                  {recordTitle(record)}
                  {record.status === "proposed" ? <span className="muted">{t("center.soul.noteProposed")}</span> : null}
                </span>
                <Button variant="ghost" size="sm" onClick={() => open(t("center.soul.chat", { task: taskId }), () => onOpen(taskId))}>
                  <ChatName taskId={taskId} /> →
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {data?.more === true ? <Empty>{t("center.soul.notesMore")}</Empty> : null}
      <Failure message={failure} />
    </section>
  );
}

/** A chat's name, read once per page (`chatTitle`); the id until it answers. */
function ChatName({ taskId }: { readonly taskId: string }) {
  const { client } = useWorkspace();
  return <>{useChatTitle(client, taskId) ?? taskId}</>;
}
