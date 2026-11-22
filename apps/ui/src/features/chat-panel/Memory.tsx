import type { MemoryItem } from "@tavi/contracts";
import { memoryPendingProvidersNote } from "@tavi/contracts";
import { useId, useState } from "react";

import { decideMemory, forgetMemory, listMemory } from "../center/memory-api.js";
import { translateNow, useT } from "../../lib/i18n.js";
import { dayMonth, localDate, localTime } from "../../lib/time.js";
import { listed } from "../../lib/format.js";
import { KIND_LABELS, recordTitle, scopeLabel } from "../center/memory-model.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { useFreshContext } from "../chat/Notices.js";
import { CenterLink, Failure, InlineConfirm, Pending, StatusNote } from "../../ui/Parts.js";
import type { Session } from "../shell/shell.js";
import {
  addChatNote,
  forgetChatHistory,
  listChatNotes,
  listLearnedHere,
  listUsedHere,
  loadChatContext,
  moveMemory,
  requestFreshContext,
} from "./api.js";
import { Empty } from "../../ui/Empty.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";

/** The records a chat inherits: the first page of the workspace's approved memory. */
interface Inherited {
  readonly records: readonly MemoryItem[];
  readonly more: boolean;
}

async function loadInherited(client: SettingsClient, workspaceId: string): Promise<Outcome<Inherited>> {
  const approved = await listMemory(client, workspaceId, { status: "approved" });
  if (!approved.ok) return approved;
  return { ok: true, value: { records: approved.value.records, more: approved.value.nextCursor !== undefined } };
}

/**
 * When a record was last given to the chat's turns, short and in the
 * workspace's `timeZone`: the date, or the time today.
 */
export function usedWhen(usedAt: string | undefined, timeZone: string | undefined, now: Date = new Date()): string | undefined {
  if (usedAt === undefined || Number.isNaN(Date.parse(usedAt))) return undefined;
  const date = localDate(usedAt, timeZone);
  return date === localDate(now.toISOString(), timeZone)
    ? translateNow("chatPanel.memory.today", { time: localTime(usedAt, timeZone) })
    : dayMonth(date);
}

/**
 * The chat panel's Memory tab: the chat's notes
 * (recalled only in it), what it taught every chat, and the
 * workspace's memory it inherits, folded away. A note can be made memory for
 * every chat and a lesson kept to this chat; a proposal is decided here.
 * On an owner without `chat-context` only the inherited memory is shown.
 */
export function Memory({
  session,
  editable,
  proposals,
  onCenter,
  onChanged,
  version = "",
}: {
  readonly session?: Session | undefined;
  /** Whether the owner offers `chat-context`, and with it a chat's notes. */
  readonly editable?: boolean | undefined;
  /** Proposals waiting for review, as the Command Center's live summary counts them; absent without one. */
  readonly proposals?: number | undefined;
  readonly onCenter?: (() => void) | undefined;
  /** Told after each change to the chat's memory, so what shows it elsewhere reads it again. */
  readonly onChanged?: (() => void) | undefined;
  /** What changes when the chat's or the workspace's memory may have: both are read again then. */
  readonly version?: string | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data, error, reload } = useLoaded(() => loadInherited(client, workspaceId), [version]);
  const taskId = session?.taskId;
  const waiting = proposals !== undefined && proposals > 0;
  return (
    <>
      {editable !== true || taskId === undefined ? null : (
        <ChatMemory
          key={taskId}
          version={version}
          taskId={taskId}
          onChanged={() => {
            reload();
            onChanged?.();
          }}
        />
      )}
      {data === undefined ? (
        <Pending error={error} />
      ) : (
        <details className="chat-panel-inherited">
          <summary className="disclosure">
            {t(data.more ? "chatPanel.memory.globalMore" : "chatPanel.memory.global", { count: data.records.length })}
          </summary>
          {data.records.length === 0 ? (
            <Empty>{t("chatPanel.memory.nothingRemembered")}</Empty>
          ) : (
            <ul className="chat-panel-records">
              {data.records.map((record) => (
                <li key={record.recordId}>
                  <span className="chat-panel-item-title truncate">{recordTitle(record)}</span>
                  <span className="chat-panel-item-detail meta-sm">
                    {KIND_LABELS[record.kind]} · {scopeLabel(record.target, {})}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {/* Waiting proposals make the way to the Command Center say what waits there. */}
      {waiting && onCenter === undefined ? (
        <p className="chat-panel-note meta-sm">{t("chatPanel.memory.proposalsWait", { count: proposals })}</p>
      ) : (
        <CenterLink
          what={waiting ? t("chatPanel.memory.reviewProposals", { count: proposals }) : t("chatPanel.memory.soul")}
          onCenter={onCenter}
        />
      )}
    </>
  );
}

/** The chat's own memory: resolved to the chat a delegated task belongs to, whose notes it reads. */
function ChatMemory({ version, taskId, onChanged }: { readonly version: string; readonly taskId: string; readonly onChanged: () => void }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => loadChatContext(client, workspaceId, taskId));
  if (data === undefined) return <Pending error={error} />;
  const chatTaskId = data.delegatedFrom ?? taskId;
  return (
    <>
      {data.delegatedFrom === undefined ? null : <p className="chat-panel-note meta-sm">{t("chatPanel.memory.agentNotes")}</p>}
      <ChatNotes version={version} chatTaskId={chatTaskId} readOnly={data.delegatedFrom !== undefined} onChanged={onChanged} />
      {data.delegatedFrom === undefined ? (
        <section aria-label={t("chatPanel.memory.historyLabel")}>
          <h4>{t("chatPanel.memory.history")}</h4>
          <p className="chat-panel-note meta-sm">{t("chatPanel.memory.historyNote")}</p>
          <FreshContext taskId={taskId} version={version} />
          <ForgetHistory version={version} taskId={taskId} onChanged={onChanged} />
        </section>
      ) : null}
    </>
  );
}

/** The approved memories a chat taught (its notes included), as the forget offers them: one page, and whether there are more. */
async function loadTaught(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
): Promise<Outcome<{ readonly count: number; readonly more: boolean }>> {
  const taught = await listLearnedHere(client, workspaceId, taskId);
  if (!taught.ok) return taught;
  return {
    ok: true,
    value: {
      count: taught.value.records.filter((record) => record.status === "approved").length,
      more: taught.value.nextCursor !== undefined,
    },
  };
}

/**
 * Forget the chat's history: its saved turns, the archives of
 * its earlier turns and the memory proposals it made that still wait. The
 * memories it taught stay unless the box is ticked. Its folder is never
 * touched, and the answer says what went.
 */
function ForgetHistory({
  version,
  taskId,
  onChanged,
}: {
  readonly version: string;
  readonly taskId: string;
  readonly onChanged: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { data } = useLoaded(() => loadTaught(client, workspaceId, taskId), [version]);
  const [asking, setAsking] = useState(false);
  const [withMemory, setWithMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean }>();
  const id = useId();
  const taught = data === undefined || data.count === 0 ? undefined : `${data.count}${data.more ? "+" : ""}`;
  const forget = async (): Promise<void> => {
    setBusy(true);
    const answer = await forgetChatHistory(client, workspaceId, taskId, withMemory && taught !== undefined);
    setBusy(false);
    setAsking(false);
    if (!answer.ok) {
      setSaid({ text: answer.message, failed: true });
      return;
    }
    const { forgotten, archives = 0, proposals = 0, memories = 0, memoryNotYours, memoryWaitsFor } = answer.value;
    const went = [
      t("chatPanel.memory.went.turns", { count: forgotten }),
      ...(archives === 0 ? [] : [t("chatPanel.memory.went.archives", { count: archives })]),
      ...(proposals === 0 ? [] : [t("chatPanel.memory.went.proposals", { count: proposals })]),
      ...(memories === 0 ? [] : [t("chatPanel.memory.went.memories", { count: memories })]),
    ];
    // A bound person's chat keeps their memory (invariant 21), even with the box ticked.
    const kept = memoryNotYours === true ? ` ${t("chatPanel.memory.notYours")}` : "";
    // A provider that could not take a removal now is named.
    const waiting = memoryPendingProvidersNote(memoryWaitsFor)?.replace(/^It will/, " What it taught will") ?? "";
    setSaid({
      text: `${t("chatPanel.memory.forgotten", { list: listed(went) })}${kept}${waiting} ${t("chatPanel.memory.reopen")}`,
      failed: false,
    });
    setWithMemory(false);
    onChanged();
  };
  return (
    <>
      {asking ? (
        <InlineConfirm
          focusCancel
          busy={busy}
          label={t("chatPanel.memory.forgetLabel")}
          message={
            <>
              {t("chatPanel.memory.forgetConfirm")}
              {taught === undefined ? null : (
                <>
                  <br />
                  <label htmlFor={id}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={withMemory}
                      disabled={busy}
                      onChange={(event) => setWithMemory(event.target.checked)}
                    />{" "}
                    {t(data?.count === 1 && data.more !== true ? "chatPanel.memory.alsoForgetOne" : "chatPanel.memory.alsoForget", {
                      taught,
                    })}
                  </label>
                </>
              )}
            </>
          }
          confirmLabel={busy ? t("chatPanel.memory.forgetting") : t("chatPanel.memory.forgetHistory")}
          cancelLabel={t("chatPanel.memory.keepIt")}
          onConfirm={() => void forget()}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSaid(undefined);
            setAsking(true);
          }}
        >
          {t("chatPanel.memory.forgetMore")}
        </Button>
      )}
      <StatusNote note={said?.text} className={said?.failed === true ? "failure" : "chat-panel-note meta-sm"} />
    </>
  );
}

/**
 * Fresh context: the chat's next message starts a new epoch — its
 * earlier turns summarized for the model and archived — whatever its length.
 * What proposals that summary's flush makes wait in the Command Center.
 */
function FreshContext({ taskId, version }: { readonly taskId: string; readonly version: string }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  // "Your next message starts a new epoch" holds until that message: the chat's next run (its newest, by id) clears it;
  // earlier runs loaded into view do not.
  const state = useFreshContext(async () => {
    const answer = await requestFreshContext(client, workspaceId, taskId);
    return answer.ok ? undefined : answer.message;
  }, version.split("|").at(-1)?.split(":")[0] ?? "");
  return (
    <>
      <Button variant="ghost" size="sm" disabled={state.busy} onClick={state.ask}>
        {t("chatPanel.memory.fresh")}
      </Button>
      <StatusNote note={state.said} className={state.failed === true ? "failure" : "chat-panel-note meta-sm"} />
    </>
  );
}

/** The chat's notes and what it taught, read together and read again after each change. */
async function loadChatMemory(
  client: SettingsClient,
  workspaceId: string,
  chatTaskId: string,
): Promise<
  Outcome<{ readonly notes: readonly MemoryItem[]; readonly learned: readonly MemoryItem[]; readonly used: readonly MemoryItem[] }>
> {
  const [notes, learned, used] = await Promise.all([
    listChatNotes(client, workspaceId, chatTaskId),
    listLearnedHere(client, workspaceId, chatTaskId),
    listUsedHere(client, workspaceId, chatTaskId),
  ]);
  if (!notes.ok) return notes;
  if (!learned.ok) return learned;
  // A chat's notes also name it as their origin: what it taught every chat is the rest.
  // "Used here" is a convenience: an owner that cannot answer it leaves it empty.
  return {
    ok: true,
    value: {
      notes: notes.value.records,
      learned: learned.value.records.filter((record) => record.target !== `chat:${chatTaskId}`),
      used: used.ok ? used.value.records : [],
    },
  };
}

function ChatNotes({
  version,
  chatTaskId,
  readOnly,
  onChanged,
}: {
  readonly version: string;
  readonly chatTaskId: string;
  readonly readOnly: boolean /** Told after each change, which may move a record into or out of the workspace's memory. */;
  readonly onChanged: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  /** The workspace's zone, the one when a record was used is said in. */
  const timeZone = useTimeZone();
  const { data, error, reload } = useLoaded(() => loadChatMemory(client, workspaceId, chatTaskId), [version]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [note, setNote] = useState("");
  const id = useId();
  /** One change at a time; the lists are read again after it, whatever it answered. */
  const act = async (change: () => Promise<Outcome<unknown>>): Promise<boolean> => {
    setBusy(true);
    setFailure(undefined);
    const outcome = await change();
    setBusy(false);
    if (!outcome.ok) setFailure(outcome.message);
    reload();
    onChanged();
    return outcome.ok;
  };
  if (data === undefined) return <Pending error={error} />;
  const row = (record: MemoryItem, actions: readonly { readonly label: string; readonly run: () => Promise<Outcome<unknown>> }[]) => (
    <li key={record.recordId}>
      <span className="chat-panel-item-title truncate">{recordTitle(record)}</span>
      <span className="chat-panel-item-detail meta-sm">
        {KIND_LABELS[record.kind]}
        {record.status === "proposed" ? ` · ${t("chatPanel.memory.proposed")}` : ""}
        {readOnly
          ? null
          : actions.map((action) => (
              <Button variant="ghost" size="sm" key={action.label} disabled={busy} onClick={() => void act(action.run)}>
                {action.label}
              </Button>
            ))}
      </span>
    </li>
  );
  const decide = (record: MemoryItem) =>
    record.status === "proposed"
      ? [
          { label: t("chatPanel.memory.keep"), run: () => decideMemory(client, workspaceId, record.recordId, true) },
          { label: t("chatPanel.memory.discard"), run: () => decideMemory(client, workspaceId, record.recordId, false) },
        ]
      : [];
  return (
    <>
      <section aria-label={t("chatPanel.memory.notesLabel")}>
        <h4>{t("chatPanel.memory.notes")}</h4>
        <p className="chat-panel-note meta-sm">{t("chatPanel.memory.notesNote")}</p>
        {data.notes.length === 0 ? (
          <Empty>{t("chatPanel.memory.noNotes")}</Empty>
        ) : (
          <ul className="chat-panel-records">
            {data.notes.map((record) =>
              row(record, [
                ...decide(record),
                ...(record.status === "approved"
                  ? [{ label: t("chatPanel.memory.everywhere"), run: () => moveMemory(client, workspaceId, record, "personal") }]
                  : []),
                { label: t("chatPanel.memory.forget"), run: () => forgetMemory(client, workspaceId, record.recordId) },
              ]),
            )}
          </ul>
        )}
        {readOnly ? null : (
          <form
            className="chat-panel-add"
            onSubmit={(event) => {
              event.preventDefault();
              const body = note.trim();
              if (body === "") return;
              void act(() => addChatNote(client, workspaceId, chatTaskId, body)).then((ok) => {
                if (ok) setNote("");
              });
            }}
          >
            <Field id={id} label={t("chatPanel.memory.noteField")} labelClassName="visually-hidden">
              <input
                className="field-sm"
                value={note}
                placeholder={t("chatPanel.memory.notePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            <Button variant="ghost" size="sm" type="submit" disabled={busy || note.trim() === ""}>
              {t("chatPanel.memory.add")}
            </Button>
          </form>
        )}
      </section>
      <section aria-label={t("chatPanel.memory.learnedLabel")}>
        <h4>{t("chatPanel.memory.learned")}</h4>
        <p className="chat-panel-note meta-sm">{t("chatPanel.memory.learnedNote")}</p>
        {data.learned.length === 0 ? (
          <Empty>{t("chatPanel.memory.nothingYet")}</Empty>
        ) : (
          <ul className="chat-panel-records">
            {data.learned.map((record) =>
              row(record, [
                ...decide(record),
                ...(record.status === "approved" && record.target !== "shared"
                  ? [{ label: t("chatPanel.memory.keepHere"), run: () => moveMemory(client, workspaceId, record, `chat:${chatTaskId}`) }]
                  : []),
                ...(record.target === "shared"
                  ? []
                  : [{ label: t("chatPanel.memory.forget"), run: () => forgetMemory(client, workspaceId, record.recordId) }]),
              ]),
            )}
          </ul>
        )}
      </section>
      <section aria-label={t("chatPanel.memory.usedLabel")}>
        <h4>{t("chatPanel.memory.used")}</h4>
        <p className="chat-panel-note meta-sm">{t("chatPanel.memory.usedNote")}</p>
        {data.used.length === 0 ? (
          <Empty>{t("chatPanel.memory.nothingRecalled")}</Empty>
        ) : (
          <ul className="chat-panel-records">
            {data.used.map((record) => {
              const when = usedWhen(record.usedAt, timeZone);
              return (
                <li key={record.recordId} data-record-id={record.recordId}>
                  <span className="chat-panel-item-title truncate" title={record.recordId}>
                    {recordTitle(record)}
                  </span>
                  <span className="chat-panel-item-detail meta-sm">
                    {KIND_LABELS[record.kind]} ·{" "}
                    {record.target.startsWith("chat:") ? t("chatPanel.thisChat") : scopeLabel(record.target, {})}
                    {when === undefined ? "" : ` · ${t("chatPanel.memory.usedWhen", { when })}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <Failure message={failure} />
    </>
  );
}
