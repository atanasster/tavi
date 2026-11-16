import { hostTimeZone, type ReminderFire, type ReminderView, type RoutineDetail, type SchedulesListResult } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useState } from "react";

import { useAction } from "../../hooks/use-action.js";
import { MINUTE_TICK_MS, useNow } from "../../hooks/use-poll.js";
import { localDate, localTime, relativeTime, shortDay, todayIn } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { Confirm } from "../../ui/Confirm.js";
import { Empty } from "../../ui/Empty.js";
import { ActionNote, FilterChip, InlineConfirm, LoadError, LoadState, SearchField } from "../../ui/Parts.js";
import { ROUTINES_LIMIT, routineRequest, routineStep, type ListedRoutine } from "../routines/api.js";
import { CreateRoutine, EditRoutine, type RoutineDraft } from "../routines/RoutineForms.js";
import { useWorkspace } from "../shell/Workspace.js";
import { useSharedHeartbeat } from "./heartbeat-source.js";
import { useScheduleActions } from "./PlainSchedules.js";
import { focusRowMenu } from "./RecurringRow.js";
import { NewReminderForm } from "./Reminders.js";
import { scheduledWorkLine } from "./schedule-model.js";
import { UNDO_DELETE_RETURN_ID, type UndoDelete } from "./UndoDelete.js";
import { byNextRun, FILTERS, matches, type Entry, type Filter, type Loaded } from "./recurring-model.js";
import { heartbeatEntry, reminderEntry, routineEntry, scheduleEntry, type EntryContext } from "./RecurringEntries.js";

/**
 * Recurring: every repeating reminder, routine and plain schedule, and the
 * heartbeat, as one kind of row (`RecurringRow`) sorted by next run, with
 * filter chips, a text filter and Pause all for what is shown. Deleting a
 * schedule or a reminder waits behind its Undo (`undoDelete`); archiving a
 * routine, which keeps its history, asks first. Duplicate opens the filled
 * form. The count shows once every list is read, and "in 14 h" moves each minute.
 */
export function Recurring({
  quiet,
  routines,
  schedules,
  reminders,
  remindersOffered,
  lastFires,
  remindersLoaded,
  people,
  showPerson,
  timeZone,
  changed,
  undoDelete,
  heartbeat: heartbeatOffered,
  onOpenHeartbeat,
  onOpenRoutine,
  onOpenReminder,
  onOpenSchedule,
  onFollow,
}: {
  /** The section already says nothing is scheduled: no empty line of its own. */
  readonly quiet: boolean;
  readonly routines: Loaded<{ readonly routines: readonly ListedRoutine[] }>;
  readonly schedules: Loaded<SchedulesListResult>;
  /** Repeating reminders, active and paused. */
  readonly reminders: readonly ReminderView[];
  /** Whether the owner offers reminders: the Reminders chip shows only then. */
  readonly remindersOffered: boolean;
  /** Each reminder's latest fire among the recent ones: its row says how it went. */
  readonly lastFires: ReadonlyMap<string, ReminderFire>;
  readonly remindersLoaded: boolean;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly showPerson: boolean;
  readonly timeZone: string | undefined;
  readonly changed: () => void;
  /** Deletes waiting for their Undo: their rows are hidden. */
  readonly undoDelete: UndoDelete;
  /** Whether the owner offers the heartbeat: its row shows then. */
  readonly heartbeat: boolean;
  readonly onOpenHeartbeat: () => void;
  readonly onOpenRoutine: (routineId: string, runId?: string) => void;
  readonly onOpenReminder: (reminderId: string) => void;
  readonly onOpenSchedule: (scheduleId: string) => void;
  readonly onFollow: (taskId: string) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  const actions = useAction(changed);
  const scheduleActions = useScheduleActions(client, workspaceId, changed, onFollow, timeZone);
  const busy = actions.busy ?? scheduleActions.busy;
  const now = useNow(MINUTE_TICK_MS);
  const heartbeat = useSharedHeartbeat({ enabled: heartbeatOffered });
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [askingPauseAll, setAskingPauseAll] = useState(false);
  // What Pause all paused, so one press resumes exactly those.
  const [resumable, setResumable] = useState<readonly string[]>([]);
  const [editingRoutine, setEditingRoutine] = useState<RoutineDetail>();
  const [copyingRoutine, setCopyingRoutine] = useState<RoutineDraft>();
  const [archiving, setArchiving] = useState<ListedRoutine>();
  const [copyingReminder, setCopyingReminder] = useState<ReminderView>();
  const [editingReminder, setEditingReminder] = useState<ReminderView>();

  const listed = routines.data?.routines ?? [];
  const plain = schedules.data?.schedules.filter((row) => row.routineId === undefined) ?? [];
  const at = (iso: string): string => `${shortDay(localDate(iso, timeZone))} ${localTime(iso, timeZone)}`;
  const nextText = (next: string | null | undefined): string =>
    next === null || next === undefined ? "Not armed" : `Next ${at(next)}, ${relativeTime(next, now, timeZone)}`;
  const zone = timeZone ?? hostTimeZone();

  /** A routine's `get`, then `then` with it: Edit and Duplicate start from the routine as it is now. */
  const withRoutine = (routine: ListedRoutine, key: string, then: (detail: RoutineDetail) => void): void =>
    void actions.run(
      `${key}:${routine.routineId}`,
      async () => {
        const detail = await routineRequest<RoutineDetail>(client, workspaceId, { action: "get", routineId: routine.routineId });
        if (!detail.ok) return detail;
        then(detail.value);
        return { ok: true, value: undefined };
      },
      { reload: false },
    );

  const context: EntryContext = {
    client,
    workspaceId,
    actions,
    scheduleActions,
    heartbeat,
    busy,
    now,
    at,
    nextText,
    timeZone,
    people,
    showPerson,
    lastFires,
    undoDelete,
    onOpenHeartbeat,
    onOpenRoutine,
    onOpenReminder,
    onOpenSchedule,
    onFollow,
    withRoutine,
    setEditingRoutine,
    setCopyingRoutine,
    setArchiving,
    setEditingReminder,
    setCopyingReminder,
  };
  // One set of rows, the heartbeat's among them: the heading counts it and the filter's "N of M shown" says the same M.
  const entries = [
    ...reminders.map((reminder) => reminderEntry(context, reminder)),
    ...listed.map((routine) => routineEntry(context, routine)),
    ...plain.map((row) => scheduleEntry(context, row)),
    ...(heartbeat.data === undefined ? [] : [heartbeatEntry(context, heartbeat.data)]),
  ]
    .filter((entry) => !undoDelete.hidden.has(entry.key))
    .sort(byNextRun);
  const needle = text.trim().toLowerCase();
  const shown = entries.filter((entry) => matches(entry, filter, needle));
  const filtering = filter !== "all" || needle !== "";
  const pausable = shown.filter((entry) => entry.pause !== undefined);
  const loaded =
    routines.data !== undefined &&
    schedules.data !== undefined &&
    remindersLoaded &&
    (!heartbeatOffered || heartbeat.data !== undefined || heartbeat.error !== undefined);

  const pauseAll = (): void =>
    void actions.run("pause-all", async () => {
      const paused: Entry[] = [];
      const refused: string[] = [];
      for (const entry of pausable) {
        const done = (await entry.pause?.()) ?? { ok: false as const, message: "it cannot be paused" };
        if (done.ok) paused.push(entry);
        else refused.push(`${entry.name} (${done.message})`);
      }
      setAskingPauseAll(false);
      setResumable(paused.map((entry) => entry.key));
      const said = `Paused ${paused.length} of ${pausable.length}${paused.length === 0 ? "" : `: ${paused.map((entry) => entry.name).join(", ")}`}.${
        refused.length === 0 ? "" : ` Not paused: ${refused.join("; ")}.`
      }`;
      return refused.length === 0 ? { ok: true, value: said } : { ok: false, message: said };
    });
  const resumeThose = (): void =>
    void actions.run("resume-all", async () => {
      const resumed: string[] = [];
      const refused: string[] = [];
      for (const key of resumable) {
        const entry = entries.find((each) => each.key === key);
        if (entry?.resume === undefined) continue;
        const done = await entry.resume();
        if (done.ok) resumed.push(entry.name);
        else refused.push(`${entry.name} (${done.message})`);
      }
      setResumable([]);
      const said = `Resumed ${resumed.length}${resumed.length === 0 ? "" : `: ${resumed.join(", ")}`}.${
        refused.length === 0 ? "" : ` Not resumed: ${refused.join("; ")}.`
      }`;
      return refused.length === 0 ? { ok: true, value: said } : { ok: false, message: said };
    });

  return (
    <>
      <h2 className="center-subhead schedule-recurring-head" id={UNDO_DELETE_RETURN_ID} tabIndex={-1}>
        Recurring <span>{loaded ? `${entries.length}` : ""}</span>
        <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={scheduleActions.create}>
          New schedule
        </Button>
      </h2>
      {schedules.data?.scheduledWork === undefined ? null : <ScheduledWork usage={schedules.data.scheduledWork} />}
      {routines.error ? <LoadError error={routines.error} reload={routines.reload} /> : null}
      <LoadState
        error={schedules.error || undefined}
        reload={schedules.reload}
        loading={(routines.loading && routines.data === undefined) || (schedules.loading && schedules.data === undefined)}
        label="Loading routines and schedules…"
        status
      />
      <ActionNote note={actions.note || undefined} tone={actions.tone} />
      <ActionNote note={scheduleActions.note || undefined} tone={scheduleActions.tone} />
      <ActionNote note={undoDelete.note} tone={undoDelete.tone} />
      {resumable.length === 0 ? null : (
        <p className="notice cluster">
          <Button size="sm" disabled={busy !== undefined} onClick={resumeThose}>
            Resume the {plural(resumable.length, "paused item")}
          </Button>
        </p>
      )}
      {listed.length === ROUTINES_LIMIT ? <p className="muted">Showing the first {ROUTINES_LIMIT} routines.</p> : null}
      {schedules.data?.truncated ? <p className="muted">Showing the first {schedules.data.schedules.length} schedules.</p> : null}
      {copyingReminder === undefined ? null : (
        <NewReminderForm
          timeZone={zone}
          today={todayIn(zone)}
          draft={copyingReminder}
          onClose={() => {
            setCopyingReminder(undefined);
            focusRowMenu(`reminder:${copyingReminder.reminderId}`);
          }}
          onSaved={(_reminder, note) => {
            setCopyingReminder(undefined);
            actions.say(note);
            changed();
          }}
        />
      )}
      {editingReminder === undefined ? null : (
        <NewReminderForm
          key={editingReminder.reminderId}
          timeZone={zone}
          today={todayIn(zone)}
          editing={editingReminder}
          onClose={() => {
            setEditingReminder(undefined);
            focusRowMenu(`reminder:${editingReminder.reminderId}`);
          }}
          onSaved={(_reminder, note) => {
            setEditingReminder(undefined);
            actions.say(note);
            changed();
            focusRowMenu(`reminder:${editingReminder.reminderId}`);
          }}
        />
      )}
      {!quiet && loaded && entries.length === 0 ? <Empty className="center-empty">No routines or schedules yet.</Empty> : null}
      {entries.length > 0 ? (
        <>
          <div className="schedule-recurring-tools">
            <div className="center-chips" role="group" aria-label="Show">
              {FILTERS.filter((each) => each.value !== "reminder" || remindersOffered).map((each) => (
                <FilterChip key={each.value} pressed={filter === each.value} onPick={() => setFilter(each.value)}>
                  {each.label}
                </FilterChip>
              ))}
            </div>
            <SearchField value={text} placeholder="Filter by name" label="Filter recurring by name" onChange={setText} />
            <Button
              size="sm"
              disabled={busy !== undefined || pausable.length === 0 || askingPauseAll}
              onClick={() => setAskingPauseAll(true)}
            >
              Pause all
            </Button>
          </div>
          {askingPauseAll ? (
            <InlineConfirm
              label="Pause all"
              message={
                <>
                  Pause {plural(pausable.length, filtering ? "item shown" : "item")}: {pausable.map((entry) => entry.name).join(", ")}? Each
                  can be resumed.
                </>
              }
              confirmLabel="Pause them"
              cancelLabel="Keep running"
              focusCancel
              busy={busy !== undefined}
              onConfirm={pauseAll}
              onCancel={() => setAskingPauseAll(false)}
            />
          ) : null}
          {/* Mounted while nothing is filtered, so the first filter's count is announced. */}
          <p className={filtering ? "meta-sm muted" : "visually-hidden"} role="status">
            {filtering ? `${shown.length} of ${entries.length} shown` : ""}
          </p>
          {shown.length === 0 ? (
            <Empty className="center-empty">Nothing here matches.</Empty>
          ) : (
            <ul className="schedule-recurring-list card-flat list-reset">{shown.map((entry) => entry.row)}</ul>
          )}
        </>
      ) : null}
      {scheduleActions.form}
      {editingRoutine === undefined ? null : (
        <EditRoutine
          value={editingRoutine}
          timeZone={timeZone}
          onClose={() => setEditingRoutine(undefined)}
          saved={() => {
            setEditingRoutine(undefined);
            actions.say(`${editingRoutine.routine.name} saved.`);
            changed();
          }}
        />
      )}
      {copyingRoutine === undefined ? null : (
        <CreateRoutine
          timeZone={timeZone}
          draft={copyingRoutine}
          onClose={() => setCopyingRoutine(undefined)}
          saved={(created) => {
            setCopyingRoutine(undefined);
            changed();
            onOpenRoutine(created);
          }}
        />
      )}
      {archiving === undefined ? null : (
        <Confirm
          title="Archive routine"
          message={`Archive ${archiving.name} and stop its future triggers? Its runs and reports are kept.`}
          action="Archive"
          onConfirm={() =>
            actions.run(`archive:${archiving.routineId}`, () =>
              routineStep(
                client,
                workspaceId,
                { action: "archive", routineId: archiving.routineId, expectedVersion: archiving.version },
                () => `${archiving.name} archived.`,
              ),
            )
          }
          onClose={() => setArchiving(undefined)}
        />
      )}
    </>
  );
}

/** What the workspace's schedules and routines spent this month, and its share of the monthly budget when one is set. */
function ScheduledWork({ usage }: { readonly usage: NonNullable<SchedulesListResult["scheduledWork"]> }) {
  const line = scheduledWorkLine(usage);
  return (
    <p className="meta-sm muted schedule-month">
      {line.over ? (
        <>
          <span className="badge badge-warning">Near budget</span>{" "}
        </>
      ) : null}
      {line.text}
    </p>
  );
}
