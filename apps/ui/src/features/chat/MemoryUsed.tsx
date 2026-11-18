import {
  memoryCardItemName,
  memoryCardTitleOf,
  memoryListedHeading,
  memorySeenCount,
  memoryUsedCount,
  memoryUsedLabel,
  type MemoryItem,
  type MemoryListAnswer,
  type TranscriptMemoryUsed,
} from "@tavi/contracts";
import { useCallback, useId, useState } from "react";

import { localDayWithYear } from "../../lib/time.js";
import { forgetUsedMemory, keepEditedMemory, listUsedInTurn, loadMemoryBody } from "../chat-panel/api.js";
import { ANNOUNCER_ID } from "../shell/a11y.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";
import { Icon } from "../../ui/Icon.js";

/** Where a record applies, in a few words. */
function scopeWords(target: string): string {
  if (target.startsWith("chat:")) return "this chat's notes";
  if (target.startsWith("agent:")) return `agent ${target.slice("agent:".length)}`;
  switch (target) {
    case "personal":
      return "everywhere";
    case "workspace":
      return "this workspace";
    case "shared":
      return "shared";
    default:
      return target;
  }
}

/** Whether a memory's body only repeats its title ("Lives in Lisbon." under "Lives in Lisbon"): then it is not said twice. */
function sameWords(title: string, body: string): boolean {
  const words = (text: string) =>
    text
      .replace(/[\s.!?…]+$/u, "")
      .trim()
      .toLowerCase();
  return words(title) === words(body);
}

/**
 * What an answer used: a quiet chip on the answer's footer — a memory icon
 * and the count, named "Used 3 memories" — a disclosure button with
 * `aria-expanded` — that opens to each record's title (and what it says, when that is more), kind, scope, date and
 * source chat, with *Forget* and *Correct*; "Looked through 6 memories" when the model only listed what is kept,
 * and both when it did both. The saved turn holds ids only, so
 * the list is read from the owner when opened (`memory list { usedInTurn }`):
 * a record forgotten since is not shown, only counted.
 */
export function MemoryUsed({
  taskId,
  seq,
  used,
  connected = true,
}: {
  readonly taskId: string;
  /** The answer's saved turn. */
  readonly seq: number;
  readonly used: TranscriptMemoryUsed;
  readonly connected?: boolean;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const [open, setOpen] = useState(false);
  const [listed, setListed] = useState<MemoryListAnswer | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ readonly recordId: string; readonly text: string } | undefined>();
  const id = useId();
  const count = memoryUsedCount(used);
  const looked = memoryUsedCount(used.listed);

  const reload = useCallback(async (): Promise<void> => {
    const outcome = await listUsedInTurn(client, workspaceId, taskId, seq);
    if (outcome.ok) {
      setListed(outcome.value);
      setFailure(undefined);
    } else setFailure(outcome.message);
  }, [client, workspaceId, taskId, seq]);

  if (memorySeenCount(used) === 0) return null;

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) void reload();
  };
  const announce = (text: string): void => {
    const region = document.getElementById(ANNOUNCER_ID);
    if (region) region.textContent = text;
  };
  /** Run one action, then read the list again: whatever changed elsewhere shows too. */
  const act = (run: () => Promise<{ readonly ok: boolean; readonly message?: string }>, done: string): void => {
    setBusy(true);
    void run().then(async (outcome) => {
      if (outcome.ok) announce(done);
      await reload();
      if (!outcome.ok) setFailure(outcome.message);
      setBusy(false);
    });
  };
  const startCorrect = (record: MemoryItem): void => {
    setBusy(true);
    void loadMemoryBody(client, workspaceId, record.recordId).then((body) => {
      if (body.ok) setEditing({ recordId: record.recordId, text: body.value });
      else setFailure(body.message);
      setBusy(false);
    });
  };
  const disabled = busy || !connected;
  const summary = listed?.used;
  const gone = summary === undefined ? 0 : summary.forgotten;
  const hidden = summary?.hidden ?? 0;
  const unnamed = summary === undefined ? 0 : Math.max(0, summary.used - (listed?.records.length ?? 0) - gone - hidden);
  const lookedThrough = summary?.listed;
  const lookedGone = lookedThrough?.forgotten ?? 0;
  const lookedHidden = lookedThrough?.hidden ?? 0;
  const lookedUnnamed =
    lookedThrough === undefined ? 0 : Math.max(0, lookedThrough.count - (listed?.listed?.length ?? 0) - lookedGone - lookedHidden);
  /** One record of the list: what it says, with *Forget* and *Correct*. */
  const recordItem = (record: MemoryItem) => {
    const name = memoryCardItemName({
      state: "saved",
      sensitive: record.redacted,
      title: memoryCardTitleOf({
        ...(record.title === null ? {} : { title: record.title }),
        ...(record.body === null ? {} : { body: record.body }),
      }),
    });
    const editingThis = editing?.recordId === record.recordId;
    return (
      <li key={record.recordId} className="memory-used-item">
        <p className="memory-used-title">{name}</p>
        {record.redacted || record.title === null || record.body === null || sameWords(record.title, record.body) ? null : (
          <p className="memory-used-body">{record.body}</p>
        )}
        <p className="meta-sm">
          {record.kind} · {scopeWords(record.target)} · {localDayWithYear(record.recordedAt, timeZone)}
          {record.originTaskId === undefined ? "" : ` · from chat ${record.originTaskId}`}
        </p>
        {editingThis ? (
          <form
            className="memory-card-edit"
            onSubmit={(event) => {
              event.preventDefault();
              const text = editing.text.trim();
              if (text === "") return;
              act(async () => {
                const outcome = await keepEditedMemory(
                  client,
                  workspaceId,
                  {
                    recordId: record.recordId,
                    ...(record.currentRevisionId === undefined ? {} : { currentRevisionId: record.currentRevisionId }),
                    state: "saved",
                  },
                  text,
                );
                if (outcome.ok) setEditing(undefined);
                return outcome;
              }, `Corrected: ${name}`);
            }}
          >
            <Field id={`${id}-${record.recordId}`} label={<>Correct: {name}</>}>
              <textarea
                value={editing.text}
                rows={3}
                onChange={(event) => setEditing({ recordId: record.recordId, text: event.target.value })}
              />
            </Field>
            <div className="memory-card-actions">
              <Button size="sm" type="submit" disabled={disabled || editing.text.trim() === ""}>
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="memory-card-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`Forget: ${name}`}
              onClick={() => act(() => forgetUsedMemory(client, workspaceId, record.recordId), `Forgotten: ${name}`)}
            >
              Forget
            </Button>
            {record.redacted ? null : (
              <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Correct: ${name}`} onClick={() => startCorrect(record)}>
                Correct
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="memory-used" data-memory-used={seq}>
      {/* An icon and the count on the reply's footer; the words are its name and its tooltip. */}
      <Button
        variant="ghost"
        size="sm"
        className="memory-used-chip"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={memoryUsedLabel(count, looked)}
        title={memoryUsedLabel(count, looked)}
        onClick={toggle}
      >
        <Icon name="memory" size="sm" />
        <span aria-hidden="true">{count > 0 ? count : looked}</span>
      </Button>
      {open ? (
        <div id={`${id}-list`} className="memory-used-list">
          {listed === undefined ? (
            failure === undefined ? (
              <p className="meta-sm">Reading…</p>
            ) : null
          ) : (
            <>
              {listed.records.length === 0 ? null : <ul className="memory-used-items">{listed.records.map(recordItem)}</ul>}
              {gone > 0 ? (
                <p className="meta-sm">{gone === 1 ? "1 forgotten since, or not yours" : `${gone} forgotten since, or not yours`}</p>
              ) : null}
              {hidden > 0 ? <p className="meta-sm">{hidden === 1 ? "1 no longer current" : `${hidden} no longer current`}</p> : null}
              {unnamed > 0 ? <p className="meta-sm">{unnamed === 1 ? "and 1 more not listed" : `and ${unnamed} more not listed`}</p> : null}
              {lookedThrough === undefined ? null : (
                <>
                  {/* The chip already says it when there is nothing else here. */}
                  {count === 0 ? null : <p className="memory-used-title">{memoryListedHeading(lookedThrough.count, count)}</p>}
                  {listed.listed === undefined || listed.listed.length === 0 ? null : (
                    <ul className="memory-used-items">{listed.listed.map(recordItem)}</ul>
                  )}
                  {lookedGone > 0 ? (
                    <p className="meta-sm">
                      {lookedGone === 1 ? "1 forgotten since, or not yours" : `${lookedGone} forgotten since, or not yours`}
                    </p>
                  ) : null}
                  {lookedHidden > 0 ? (
                    <p className="meta-sm">{lookedHidden === 1 ? "1 no longer current" : `${lookedHidden} no longer current`}</p>
                  ) : null}
                  {lookedUnnamed > 0 ? (
                    <p className="meta-sm">{lookedUnnamed === 1 ? "and 1 more not listed" : `and ${lookedUnnamed} more not listed`}</p>
                  ) : null}
                </>
              )}
              {summary !== undefined && summary.preferences > 0 ? (
                <p className="meta-sm">
                  {summary.preferences === 1 ? "1 preference applied" : `${summary.preferences} preferences applied`}
                </p>
              ) : null}
            </>
          )}
          <Failure message={failure} alert={false} />
        </div>
      ) : null}
    </div>
  );
}
