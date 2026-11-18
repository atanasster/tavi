import {
  hostTimeZone,
  type CenterSummaryAnswer,
  type RemindersListAnswer,
  type ReminderFiresAnswer,
  type TodosListAnswer,
} from "@tavi/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../ui/Icon.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { listRoutines } from "../routines/api.js";
import { BackLink, LoadError, Notice, PageHead, StatusNote } from "../../ui/Parts.js";
import { CreateRoutine, type RoutineStart } from "../routines/RoutineForms.js";
import { RoutineOverview } from "../routines/RoutineOverview.js";
import { loadAgenda } from "./api.js";
import { DAY_MS, todayIn } from "../../lib/time.js";
import type { ScheduleDraft } from "./PlainSchedules.js";
import { ScheduleForm } from "./ScheduleForm.js";
import { listSchedules, removeSchedule } from "./schedules-api.js";
import { latestFires } from "./reminder-model.js";
import { listReminderFires, listReminders, listTodos, transitionReminder } from "./reminders-api.js";
import { NewReminderForm, type ReminderStart } from "./Reminders.js";
import { ScheduleTemplates, templateScheduleDraft, type ScheduleTemplate } from "./ScheduleTemplates.js";
import { NotificationToggle } from "./ReminderNotifications.js";
import { ReminderPage } from "./ReminderPage.js";
import { SchedulePage } from "./SchedulePage.js";
import { AddedFrom, DoneReminders, doneEntries, LaterReminderRow, ReminderPerson } from "./ReminderRows.js";
import { EmptyState } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { ComingUp } from "./ScheduleLists.js";
import { Recurring } from "./Recurring.js";
import { UndoToast, useUndoDelete, type UndoDelete } from "./UndoDelete.js";
import { Todos } from "./Todos.js";
import { Command } from "../../ui/Command.js";

/** Reminders in the order they run: a paused one, with no next run, comes last. */
const byNextFire = (a: { readonly nextFireAt: string | null }, b: { readonly nextFireAt: string | null }): number =>
  (a.nextFireAt ?? "\uffff").localeCompare(b.nextFireAt ?? "\uffff");

/**
 * Schedule: what runs next, then what
 * repeats. *Coming up* is `schedules agenda` — the next seven days, under the
 * workspace zone's days. *Recurring* is every routine and plain schedule (and
 * the heartbeat, when the owner offers it), one row each with its cadence, its
 * last outcome, Run now, a pause switch and More. A schedule or reminder
 * deleted here or from its page waits behind an Undo for a few seconds before
 * the owner is asked, so Undo keeps it whole. The Routines
 * tab and Settings → Schedules folded in here: a routine opens as its own
 * page inside the section (`/center/schedule/routines/<id>`), a run beneath it.
 *
 * Reminders (when the owner offers `reminders`) join each list: their
 * occurrences in Coming up, repeating ones in Recurring, one-off ones beyond
 * the week under Later, and Done / missed collapsed at the end. The header
 * adds New reminder and the browser-notification opt-in, and a reminder opens
 * as its own page (`/center/schedule/reminders/<id>`), as a plain schedule
 * does (`/center/schedule/schedules/<id>`). The to-do list
 * (`Todos`) closes the section; a to-do's due time in Coming up opens that
 * list, not a reminder page, since a to-do is not changed as a reminder.
 * With nothing scheduled, a few templates each open the schedule, routine or
 * reminder form filled in.
 */
export function Schedule({
  summary,
  revision,
  routineId,
  runId,
  reminderId,
  scheduleId,
  reminders: offersReminders = false,
  heartbeat = false,
  onOpenRoutine,
  onOpenReminder,
  onOpenSchedule,
  onOpenHeartbeat,
  onFollow,
}: {
  /** The feed's summary: the zone and today, until the agenda names its own. */
  readonly summary: CenterSummaryAnswer | undefined;
  /** Moves when the feed reports `routine`, `schedule` or `reminder`: every list, and the page open, is read again. */
  readonly revision: number;
  /** The routine the address names, if any: its page instead of the lists. */
  readonly routineId?: string | undefined;
  /** The run of it the address names. */
  readonly runId?: string | undefined;
  /** The reminder the address names: its page instead of the lists. */
  readonly reminderId?: string | undefined;
  /** The plain schedule the address names: its page instead of the lists. */
  readonly scheduleId?: string | undefined;
  /** Whether the owner offers `reminders`; without it the section is routines and schedules alone. */
  readonly reminders?: boolean | undefined;
  /** Whether the owner offers the heartbeat: Recurring then has its row. */
  readonly heartbeat?: boolean | undefined;
  /** Go to Center → Heartbeat, from its row. */
  readonly onOpenHeartbeat?: (() => void) | undefined;
  /** Go to the lists (no routine), a routine, or one of its runs: a new address each. */
  readonly onOpenRoutine: (routineId: string | undefined, runId?: string) => void;
  /** Go to a reminder's page. Absent: Schedule's lists stand in for it. */
  readonly onOpenReminder?: ((reminderId: string) => void) | undefined;
  /** Go to a plain schedule's page. Absent: Schedule's lists stand in for it. */
  readonly onOpenSchedule?: ((scheduleId: string) => void) | undefined;
  readonly onFollow: (taskId: string) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  const { heard, reloaded } = useHeardRevision(revision);
  // The lists are read only while they are shown: a page of its own reads what it shows, and the lists are read again on return.
  const lists = { enabled: routineId === undefined && scheduleId === undefined && reminderId === undefined };
  // A live change re-reads the lists; the first render already read them.
  const agenda = useLoaded(() => loadAgenda(client, workspaceId), [heard], lists);
  const routines = useLoaded(() => listRoutines(client, workspaceId), [heard], lists);
  const schedules = useLoaded(() => listSchedules(client, workspaceId, true), [heard], lists);
  const noReminders = async (): Promise<{ readonly ok: true; readonly value: undefined }> => ({ ok: true, value: undefined });
  const reminders = useLoaded<RemindersListAnswer | undefined>(
    () => (offersReminders ? listReminders(client, workspaceId) : noReminders()),
    [heard],
    lists,
  );
  const finished = useLoaded<RemindersListAnswer | undefined>(
    () => (offersReminders ? listReminders(client, workspaceId, ["done", "cancelled"]) : noReminders()),
    [heard],
    lists,
  );
  const fires = useLoaded<ReminderFiresAnswer | undefined>(
    () => (offersReminders ? listReminderFires(client, workspaceId, false) : noReminders()),
    [heard],
    lists,
  );
  const openTodos = useLoaded<TodosListAnswer | undefined>(
    () => (offersReminders ? listTodos(client, workspaceId) : noReminders()),
    [heard],
    lists,
  );
  const reloadAll = (): void => {
    reloaded();
    agenda.reload();
    routines.reload();
    schedules.reload();
    reminders.reload();
    finished.reload();
    fires.reload();
    openTodos.reload();
  };
  const [create, setCreate] = useState(false);
  const [newReminder, setNewReminder] = useState(false);
  const [note, setNote] = useState<string>();
  // What a template filled in: the form it opened starts from it.
  const [routineStart, setRoutineStart] = useState<RoutineStart>();
  const [reminderStart, setReminderStart] = useState<ReminderStart>();
  const [scheduleStart, setScheduleStart] = useState<ScheduleDraft>();
  const undoDelete = useUndoDelete(reloadAll, workspaceId);
  const newReminderButton = useRef<HTMLButtonElement>(null);
  // Back to the button that opened the form, once it is enabled again.
  const refocusNewReminder = (): void => void requestAnimationFrame(() => newReminderButton.current?.focus());
  const openReminder = onOpenReminder ?? (() => onOpenRoutine(undefined));
  const openSchedule = onOpenSchedule ?? (() => onOpenRoutine(undefined));
  const byId = useMemo(
    () => new Map((reminders.data?.reminders ?? []).map((reminder) => [reminder.reminderId, reminder])),
    [reminders.data],
  );
  const todoIds = useMemo(() => new Set((openTodos.data?.todos ?? []).map((todo) => todo.todoId)), [openTodos.data]);
  const openComingUp = (id: string): void => {
    if (todoIds.has(id)) document.getElementById("center-todos-title")?.scrollIntoView({ block: "start" });
    else openReminder(id);
  };
  const people = summary?.people;
  // A person is named once more than one has reminders or routines (a person from Allowed people owns theirs).
  const showPerson =
    new Set([
      ...(reminders.data?.reminders ?? []).map((reminder) => reminder.principalId),
      ...(routines.data?.routines ?? []).map((routine) => routine.principalId),
    ]).size > 1;

  // A new routine, schedule or reminder starts in the workspace zone, not this browser's.
  const timeZone = agenda.data?.timezone ?? reminders.data?.timezone ?? summary?.timezone;
  const creating = create ? (
    <CreateRoutine
      timeZone={timeZone}
      start={routineStart}
      onClose={() => {
        setCreate(false);
        setRoutineStart(undefined);
      }}
      saved={(created) => {
        setCreate(false);
        setRoutineStart(undefined);
        reloadAll();
        onOpenRoutine(created);
      }}
    />
  ) : null;

  if (routineId !== undefined) {
    return (
      <section className="center-section routines" aria-label="Schedule">
        <RoutineOverview
          key={routineId}
          routineId={routineId}
          revision={heard}
          runId={runId}
          onOpenRun={(next) => onOpenRoutine(routineId, next)}
          onClose={() => onOpenRoutine(undefined)}
          onFollow={onFollow}
          changed={reloadAll}
          timeZone={timeZone}
        />
      </section>
    );
  }

  if (scheduleId !== undefined) {
    if (undoDelete.hidden.has(`schedule:${scheduleId}`))
      return <Deleting undoDelete={undoDelete} rowKey={`schedule:${scheduleId}`} what="schedule" onBack={() => onOpenRoutine(undefined)} />;
    return (
      <SchedulePage
        key={scheduleId}
        scheduleId={scheduleId}
        revision={heard}
        timeZone={timeZone}
        onBack={() => onOpenRoutine(undefined)}
        onDelete={(schedule) => {
          undoDelete.hold(`schedule:${schedule.scheduleId}`, schedule.name, () => removeSchedule(client, workspaceId, schedule.scheduleId));
          onOpenRoutine(undefined);
        }}
        onFollow={onFollow}
        onOpenRoutine={(routine) => onOpenRoutine(routine)}
        changed={reloadAll}
      />
    );
  }

  if (reminderId !== undefined) {
    if (!offersReminders) {
      return (
        <section className="center-section" aria-label="Schedule">
          <BackLink label="Schedule" onBack={() => onOpenRoutine(undefined)} />
          <Notice role="status">This reminder was not found.</Notice>
        </section>
      );
    }
    if (undoDelete.hidden.has(`reminder:${reminderId}`))
      return <Deleting undoDelete={undoDelete} rowKey={`reminder:${reminderId}`} what="reminder" onBack={() => onOpenRoutine(undefined)} />;
    return (
      <ReminderPage
        key={reminderId}
        reminderId={reminderId}
        revision={heard}
        people={people}
        onBack={() => onOpenRoutine(undefined)}
        onDelete={(reminder) => {
          undoDelete.hold(`reminder:${reminder.reminderId}`, reminder.text, () =>
            transitionReminder(client, workspaceId, reminder.reminderId, "cancel"),
          );
          onOpenRoutine(undefined);
        }}
        onFollow={onFollow}
        changed={reloadAll}
      />
    );
  }

  const listed = routines.data?.routines;
  const plain = schedules.data?.schedules.filter((row) => row.routineId === undefined);
  const active = reminders.data?.reminders;
  const empty =
    agenda.data?.items.length === 0 && listed?.length === 0 && plain?.length === 0 && (!offersReminders || active?.length === 0);
  const zone = timeZone ?? hostTimeZone();
  const today = summary?.today ?? todayIn(zone);
  const weekEnd = Date.now() + 7 * DAY_MS;
  const later = (active ?? []).filter(
    (reminder) =>
      reminder.when.kind !== "repeat" &&
      !undoDelete.hidden.has(`reminder:${reminder.reminderId}`) &&
      (reminder.status === "paused" || (reminder.nextFireAt !== null && Date.parse(reminder.nextFireAt) >= weekEnd)),
  );
  const done = doneEntries(finished.data?.reminders ?? [], fires.data?.fires ?? [], Date.now());
  const startFrom = (template: ScheduleTemplate): void => {
    setNote(undefined);
    if (template.kind === "routine") {
      setRoutineStart(template.routine);
      setCreate(true);
    } else if (template.kind === "reminder") {
      setReminderStart(template.reminder);
      setNewReminder(true);
    } else setScheduleStart(templateScheduleDraft(template.schedule, zone));
  };

  return (
    <section className="center-section schedule" aria-labelledby="center-schedule-title">
      <PageHead
        className="center-head"
        id="center-schedule-title"
        title="Schedule"
        description={
          <>
            {offersReminders
              ? "Reminders, routines and schedules, in the order they run. Ask in any chat: “remind me…” or “every weekday at 7…”."
              : "Routines and schedules, in the order they run."}{" "}
            Tavi has to be running (<Command>tavi serve</Command>) when they are due.
          </>
        }
      >
        <div className="center-head-actions">
          {offersReminders ? <NotificationToggle /> : null}
          {offersReminders ? (
            <Button ref={newReminderButton} onClick={() => setNewReminder(true)} disabled={newReminder}>
              <Icon name="bell" size="sm" />
              New reminder
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => setCreate(true)}>
            <Icon name="plus" size="sm" />
            New routine
          </Button>
        </div>
      </PageHead>

      {newReminder ? (
        <NewReminderForm
          key={reminderStart?.text ?? "blank"}
          timeZone={zone}
          today={today}
          start={reminderStart}
          onClose={() => {
            setNewReminder(false);
            setReminderStart(undefined);
            refocusNewReminder();
          }}
          onSaved={(_reminder, said) => {
            setNewReminder(false);
            setReminderStart(undefined);
            setNote(said);
            reloadAll();
            refocusNewReminder();
          }}
        />
      ) : null}
      <StatusNote note={note} />

      {empty ? (
        <EmptyState title="Nothing scheduled yet">
          {offersReminders ? <p>Try asking: “remind me to stretch every day at 15:00”.</p> : null}
          <p>
            A routine researches on a schedule, writes a report and can deliver it. Create one here, or ask in chat: “Find the latest LLM
            model news every morning at 9am.”
          </p>
          <p>Or start from a template, and change anything before you save it:</p>
          <ScheduleTemplates reminders={offersReminders} onPick={startFrom} />
        </EmptyState>
      ) : null}

      <ComingUp
        agenda={agenda}
        hidden={undoDelete.hidden}
        timeZone={timeZone}
        today={summary?.today}
        quiet={empty}
        onOpenRoutine={onOpenRoutine}
        reminderRow={(item) => {
          const reminder = byId.get(item.id);
          return (
            <>
              {reminder === undefined ? null : (
                <ReminderPerson principalId={reminder.principalId} people={people} show={showPerson} lead=" · " />
              )}
              {reminder === undefined ? null : <AddedFrom reminder={reminder} onFollow={onFollow} lead=" · " />}
            </>
          );
        }}
        onOpenReminder={openComingUp}
        onOpenSchedule={openSchedule}
        todoIds={todoIds}
      />

      {reminders.error ? <LoadError error={reminders.error} reload={reminders.reload} /> : null}
      <Recurring
        quiet={empty}
        routines={routines}
        schedules={schedules}
        reminders={(active ?? []).filter((reminder) => reminder.when.kind === "repeat")}
        remindersOffered={offersReminders}
        lastFires={latestFires(fires.data?.fires ?? [])}
        remindersLoaded={!offersReminders || reminders.data !== undefined}
        people={people}
        showPerson={showPerson}
        timeZone={timeZone}
        changed={reloadAll}
        undoDelete={undoDelete}
        heartbeat={heartbeat && onOpenHeartbeat !== undefined}
        onOpenHeartbeat={() => onOpenHeartbeat?.()}
        onOpenRoutine={onOpenRoutine}
        onOpenReminder={openReminder}
        onOpenSchedule={openSchedule}
        onFollow={onFollow}
      />
      {later.length > 0 ? (
        <>
          <h2 className="center-subhead">
            Later <span>one-off reminders after this week</span>
          </h2>
          <ul className="schedule-recurring-list card-flat list-reset">
            {[...later].sort(byNextFire).map((reminder) => (
              <LaterReminderRow
                key={reminder.reminderId}
                reminder={reminder}
                timeZone={timeZone}
                people={people}
                showPerson={showPerson}
                onOpen={openReminder}
                onFollow={onFollow}
              />
            ))}
          </ul>
        </>
      ) : null}
      <DoneReminders entries={done} timeZone={timeZone} onOpen={openReminder} />
      {offersReminders ? <Todos revision={heard} /> : null}
      {creating}
      {scheduleStart === undefined ? null : (
        <ScheduleForm
          client={client}
          workspaceId={workspaceId}
          initial={undefined}
          draft={scheduleStart}
          timeZone={zone}
          onClose={() => setScheduleStart(undefined)}
          onSaved={(name) => {
            setScheduleStart(undefined);
            setNote(`${name} created.`);
            reloadAll();
          }}
        />
      )}
      <UndoToast undo={undoDelete} />
    </section>
  );
}

/** How soon after a reload of its own the feed's word of that same change is taken as said: nothing is read twice for it. */
const ECHO_MS = 2_000;

/**
 * The feed's `revision` as Schedule reads by it: the first move after a
 * reload of its own (`reloaded`, called as a write's answer is read again)
 * within `ECHO_MS` is that write's own echo, and is not read again.
 */
function useHeardRevision(revision: number): { readonly heard: number; readonly reloaded: () => void } {
  const [heard, setHeard] = useState(revision);
  const seen = useRef(revision);
  const lastOwn = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    if (Date.now() - lastOwn.current < ECHO_MS) {
      lastOwn.current = Number.NEGATIVE_INFINITY;
      return;
    }
    setHeard(revision);
  }, [revision]);
  return {
    heard,
    reloaded: () => {
      lastOwn.current = Date.now();
    },
  };
}

/**
 * A schedule's or reminder's page while its delete waits for its Undo (or was
 * just made): it says so, with Undo while it can still be undone, rather than
 * showing what is about to go as if nothing happened.
 */
function Deleting({
  undoDelete,
  rowKey,
  what,
  onBack,
}: {
  readonly undoDelete: UndoDelete;
  readonly rowKey: string;
  readonly what: "schedule" | "reminder";
  readonly onBack: () => void;
}) {
  const held = undoDelete.held?.key === rowKey ? undoDelete.held : undefined;
  return (
    <section className="center-section" aria-label="Schedule">
      <BackLink label="Schedule" onBack={onBack} />
      <Notice role="status" className="cluster">
        {held === undefined ? (
          `This ${what} was deleted.`
        ) : (
          <>
            <span>{held.name} is being deleted.</span>
            <Button size="sm" aria-label={`Undo deleting ${held.name}`} onClick={undoDelete.undo}>
              Undo
            </Button>
          </>
        )}
      </Notice>
    </section>
  );
}
