import type { MemoryItem } from "@tavi/contracts";
import { memoryPendingProvidersNote } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useId, useState } from "react";

import { decideMemory, forgetMemory, listMemory } from "../center/memory-api.js";
import { dayMonth, localDate, localTime } from "../../lib/time.js";
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
  return date === localDate(now.toISOString(), timeZone) ? `today ${localTime(usedAt, timeZone)}` : dayMonth(date);
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
            Global memory ({data.records.length}
            {data.more ? "+" : ""})
          </summary>
          {data.records.length === 0 ? (
            <Empty>Nothing remembered yet.</Empty>
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
        <p className="chat-panel-note meta-sm">{plural(proposals, "proposal waits", "proposals wait")} for review in the Command Center.</p>
      ) : (
        <CenterLink what={waiting ? `Review ${plural(proposals, "proposal")}` : "Soul & memory"} onCenter={onCenter} />
      )}
    </>
  );
}

/** The chat's own memory: resolved to the chat a delegated task belongs to, whose notes it reads. */
function ChatMemory({ version, taskId, onChanged }: { readonly version: string; readonly taskId: string; readonly onChanged: () => void }) {
  const { client, workspaceId } = useWorkspace();
  const { data, error } = useLoaded(() => loadChatContext(client, workspaceId, taskId));
  if (data === undefined) return <Pending error={error} />;
  const chatTaskId = data.delegatedFrom ?? taskId;
  return (
    <>
      {data.delegatedFrom === undefined ? null : (
        <p className="chat-panel-note meta-sm">This agent's task reads the notes of the chat it works for, shown here.</p>
      )}
      <ChatNotes version={version} chatTaskId={chatTaskId} readOnly={data.delegatedFrom !== undefined} onChanged={onChanged} />
      {data.delegatedFrom === undefined ? (
        <section aria-label="this chat's history">
          <h4>History</h4>
          <p className="chat-panel-note meta-sm">
            A long chat summarizes its earlier turns by itself. Fresh context does it at your next message.
          </p>
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
      plural(forgotten, "saved turn"),
      ...(archives === 0 ? [] : [plural(archives, "archive")]),
      ...(proposals === 0 ? [] : [plural(proposals, "waiting proposal")]),
      ...(memories === 0 ? [] : [plural(memories, "memory", "memories")]),
    ];
    // A bound person's chat keeps their memory (invariant 21), even with the box ticked.
    const kept = memoryNotYours === true ? " Its memory belongs to the person the chat is with and was not touched." : "";
    // A provider that could not take a removal now is named.
    const waiting = memoryPendingProvidersNote(memoryWaitsFor)?.replace(/^It will/, " What it taught will") ?? "";
    setSaid({ text: `Forgotten: ${went.join(", ")}.${kept}${waiting} Reopen the chat to see what is left.`, failed: false });
    setWithMemory(false);
    onChanged();
  };
  return (
    <>
      {asking ? (
        <InlineConfirm
          focusCancel
          busy={busy}
          label="Forget this chat's history"
          message={
            <>
              Forget this chat's history? Its saved turns, the archives of its earlier turns and the memory it proposed that still waits are
              erased for good. Its folder is not touched.
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
                    Also forget the {taught} {data?.count === 1 && data.more !== true ? "memory" : "memories"} this chat taught
                  </label>
                </>
              )}
            </>
          }
          confirmLabel={busy ? "Forgetting…" : "Forget history"}
          cancelLabel="Keep it"
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
          Forget history…
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
        Fresh context
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
        {record.status === "proposed" ? " · proposed" : ""}
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
          { label: "Keep", run: () => decideMemory(client, workspaceId, record.recordId, true) },
          { label: "Discard", run: () => decideMemory(client, workspaceId, record.recordId, false) },
        ]
      : [];
  return (
    <>
      <section aria-label="this chat's notes">
        <h4>Chat notes</h4>
        <p className="chat-panel-note meta-sm">Recalled in this chat only, for as long as it lasts.</p>
        {data.notes.length === 0 ? (
          <Empty>No notes yet.</Empty>
        ) : (
          <ul className="chat-panel-records">
            {data.notes.map((record) =>
              row(record, [
                ...decide(record),
                ...(record.status === "approved"
                  ? [{ label: "Remember everywhere", run: () => moveMemory(client, workspaceId, record, "personal") }]
                  : []),
                { label: "Forget", run: () => forgetMemory(client, workspaceId, record.recordId) },
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
            <Field id={id} label="A note for this chat" labelClassName="visually-hidden">
              <input
                className="field-sm"
                value={note}
                placeholder="Add a note for this chat"
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            <Button variant="ghost" size="sm" type="submit" disabled={busy || note.trim() === ""}>
              Add
            </Button>
          </form>
        )}
      </section>
      <section aria-label="learned in this chat">
        <h4>Learned here</h4>
        <p className="chat-panel-note meta-sm">Memory this chat added for every chat.</p>
        {data.learned.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ul className="chat-panel-records">
            {data.learned.map((record) =>
              row(record, [
                ...decide(record),
                ...(record.status === "approved" && record.target !== "shared"
                  ? [{ label: "Keep to this chat", run: () => moveMemory(client, workspaceId, record, `chat:${chatTaskId}`) }]
                  : []),
                ...(record.target === "shared" ? [] : [{ label: "Forget", run: () => forgetMemory(client, workspaceId, record.recordId) }]),
              ]),
            )}
          </ul>
        )}
      </section>
      <section aria-label="used in this chat">
        <h4>Used here</h4>
        <p className="chat-panel-note meta-sm">Memory used in this chat: what its answers were given, most recent first.</p>
        {data.used.length === 0 ? (
          <Empty>Nothing recalled yet.</Empty>
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
                    {KIND_LABELS[record.kind]} · {record.target.startsWith("chat:") ? "This chat" : scopeLabel(record.target, {})}
                    {when === undefined ? "" : ` · used ${when}`}
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
