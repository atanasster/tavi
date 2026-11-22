import type { HeartbeatGetAnswer, ReminderFire, ReminderView, RoutineDetail } from "@tavi/contracts";

import type { useAction } from "../../hooks/use-action.js";
import { translateNow as t } from "../../lib/i18n.js";
import { dayTime, relativeTime, when } from "../../lib/time.js";
import { StatusBadge } from "../../ui/Parts.js";
import { operationKey, routineRequest, routineStep, type ListedRoutine } from "../routines/api.js";
import { routineDraft, type RoutineDraft } from "../routines/RoutineForms.js";
import { routineToggle } from "../routines/status.js";
import { centerPath, reminderPath, routinePath, schedulePath } from "../shell/route.js";
import type { useWorkspace } from "../shell/Workspace.js";
import { changeHeartbeat, checkHeartbeatNow } from "./heartbeat-api.js";
import type { useSharedHeartbeat } from "./heartbeat-source.js";
import type { ScheduleActions } from "./PlainSchedules.js";
import { removeSchedule, switchSchedule, type ListedSchedule } from "./schedules-api.js";
import { RecurringRow, type RowMenuItem } from "./RecurringRow.js";
import { lastFireText, repeatText, transitionSaid, whenText } from "./reminder-model.js";
import { AddedFrom, ReminderPerson } from "./ReminderRows.js";
import { transitionReminder } from "./reminders-api.js";
import { finishedHint, outcomeSentence, pausedText, routineCadence, scheduleState, specText, watchText } from "./schedule-model.js";
import type { UndoDelete } from "./UndoDelete.js";
import { heartbeatCadence, notRun, ROUTINE_TROUBLE, type Entry } from "./recurring-model.js";

/** What the rows' builders read from Recurring: its owner, actions, clock, people and the forms its menus open. */
export interface EntryContext {
  readonly client: ReturnType<typeof useWorkspace>["client"];
  readonly workspaceId: string;
  readonly actions: ReturnType<typeof useAction>;
  readonly scheduleActions: ScheduleActions;
  readonly heartbeat: ReturnType<typeof useSharedHeartbeat>;
  /** The action in flight, Recurring's or a schedule's. */
  readonly busy: string | undefined;
  readonly now: number;
  /** A time as a row says it: "Tue 08:00". */
  readonly at: (iso: string) => string;
  readonly nextText: (next: string | null | undefined) => string;
  readonly timeZone: string | undefined;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly showPerson: boolean;
  readonly lastFires: ReadonlyMap<string, ReminderFire>;
  readonly undoDelete: UndoDelete;
  readonly onOpenHeartbeat: () => void;
  readonly onOpenRoutine: (routineId: string, runId?: string) => void;
  readonly onOpenReminder: (reminderId: string) => void;
  readonly onOpenSchedule: (scheduleId: string) => void;
  readonly onFollow: (taskId: string) => Promise<void>;
  /** A routine's `get`, then `then` with it. */
  readonly withRoutine: (routine: ListedRoutine, key: string, then: (detail: RoutineDetail) => void) => void;
  readonly setEditingRoutine: (routine: RoutineDetail) => void;
  readonly setCopyingRoutine: (draft: RoutineDraft) => void;
  readonly setArchiving: (routine: ListedRoutine) => void;
  readonly setEditingReminder: (reminder: ReminderView) => void;
  readonly setCopyingReminder: (reminder: ReminderView) => void;
}

/** A routine as a row: Run now opens the run it started; Edit and Duplicate read the routine first; Archive asks. */
export function routineEntry(context: EntryContext, routine: ListedRoutine): Entry {
  const {
    client,
    workspaceId,
    actions,
    busy,
    nextText,
    timeZone,
    people,
    showPerson,
    onOpenRoutine,
    withRoutine,
    setEditingRoutine,
    setCopyingRoutine,
    setArchiving,
  } = context;
  // A revoked person's routine no longer runs: it is shown so it can be opened and archived.
  const revoked = routine.ownerRevoked === true;
  const can = revoked ? { pause: false, resume: false } : routineToggle(routine);
  const on = routine.status === "active" || routine.status === "credential-blocked";
  const last = routine.lastRun;
  const key = `routine:${routine.routineId}`;
  const step = (action: "pause" | "resume") => () =>
    routineRequest(client, workspaceId, { action, routineId: routine.routineId, expectedVersion: routine.version });
  const toggle = (pause: boolean): void =>
    void actions.run(`${pause ? "pause" : "resume"}:${routine.routineId}`, () =>
      routineStep(
        client,
        workspaceId,
        { action: pause ? "pause" : "resume", routineId: routine.routineId, expectedVersion: routine.version },
        () => t(pause ? "center.recurringEntries.paused" : "center.recurringEntries.resumed", { name: routine.name }),
      ),
    );
  const runNow = (): void => {
    let started: string | undefined;
    void actions
      .run(`run:${routine.routineId}`, () =>
        routineStep<{ readonly runId?: unknown } | null>(
          client,
          workspaceId,
          { action: "run", routineId: routine.routineId, operationKey: operationKey() },
          (value) => {
            started = typeof value?.runId === "string" ? value.runId : undefined;
            return t("center.recurringEntries.started", { name: routine.name });
          },
        ),
      )
      .then(() => {
        if (started !== undefined) onOpenRoutine(routine.routineId, started);
      });
  };
  const menu: RowMenuItem[] = [
    ...(routine.status === "archived" || revoked
      ? []
      : [{ label: t("center.recurringEntries.edit"), onSelect: () => withRoutine(routine, "edit", setEditingRoutine) }]),
    {
      label: t("center.recurringEntries.duplicate"),
      onSelect: () => withRoutine(routine, "duplicate", (detail) => setCopyingRoutine(routineDraft(detail))),
    },
    ...(routine.status === "archived"
      ? []
      : [{ label: t("center.recurringEntries.archive"), danger: true, onSelect: () => setArchiving(routine) }]),
  ];
  return {
    key,
    kind: "routine",
    name: routine.name,
    next: on ? routine.nextRunAt : undefined,
    failing: ROUTINE_TROUBLE.has(routine.status) || last?.status === "failed",
    paused: routine.status === "paused" || routine.status === "paused-failures",
    pause: can.pause ? step("pause") : undefined,
    resume: can.resume ? step("resume") : undefined,
    row: (
      <RecurringRow
        key={key}
        kind="routine"
        rowKey={key}
        name={routine.name}
        href={routinePath(routine.routineId)}
        onOpen={() => onOpenRoutine(routine.routineId)}
        badge={<StatusBadge status={routine.status} />}
        titleExtra={
          <>
            <ReminderPerson principalId={routine.principalId} people={people} show={showPerson || revoked} lead=" · " />
            {revoked ? <span className="meta"> · {t("center.recurringEntries.noLongerAllowed")}</span> : null}
          </>
        }
        when={
          <>
            {routine.triggers === undefined ? null : (
              <>
                <span className="schedule-cadence">{routineCadence(routine.triggers)}</span> ·{" "}
              </>
            )}
            {routine.nextRunAt === undefined ? null : nextText(routine.nextRunAt)}
          </>
        }
        last={
          last ? (
            <>
              {t("center.recurringEntries.lastRun", { when: when(last.startedAt ?? last.claimedAt, timeZone) })} ·{" "}
              <StatusBadge status={last.status} />
            </>
          ) : (
            notRun()
          )
        }
        runNow={{
          onRun: runNow,
          disabled: revoked || routine.activeRevision === null || !on,
          title: on ? undefined : t("center.recurringEntries.resumeToRun"),
        }}
        toggle={{
          on,
          label: t(on ? "center.recurringEntries.pauseNamed" : "center.recurringEntries.resumeNamed", { name: routine.name }),
          warning: routine.status === "credential-blocked" ? t("center.recurringEntries.credentialBlocked") : undefined,
          disabled: !(on ? can.pause : can.resume),
          onToggle: () => toggle(on),
        }}
        menu={menu}
        busy={busy !== undefined}
      />
    ),
  };
}

/** A repeating reminder as a row, with how its latest fire went; Delete waits behind its Undo. */
export function reminderEntry(context: EntryContext, reminder: ReminderView): Entry {
  const {
    client,
    workspaceId,
    actions,
    busy,
    now,
    timeZone,
    people,
    showPerson,
    lastFires,
    undoDelete,
    onOpenReminder,
    onFollow,
    setEditingReminder,
    setCopyingReminder,
  } = context;
  const on = reminder.status === "active";
  const lastFire = lastFires.get(reminder.reminderId);
  const key = `reminder:${reminder.reminderId}`;
  const transition = (action: "pause" | "resume" | "cancel") => () => transitionReminder(client, workspaceId, reminder.reminderId, action);
  const act = (action: "pause" | "resume"): void =>
    void actions.run(`${action}:${reminder.reminderId}`, async () => {
      const answer = await transitionReminder(client, workspaceId, reminder.reminderId, action);
      if (!answer.ok) return answer;
      return { ok: true, value: transitionSaid(action, reminder.text) };
    });
  const reminderWhen = reminder.when;
  return {
    key,
    kind: "reminder",
    name: reminder.text,
    next: reminder.nextFireAt,
    failing: lastFire?.outcome === "failed",
    paused: reminder.status === "paused",
    pause: on ? transition("pause") : undefined,
    resume: reminder.status === "paused" ? transition("resume") : undefined,
    row: (
      <RecurringRow
        key={key}
        kind="reminder"
        rowKey={key}
        name={reminder.text}
        href={reminderPath(reminder.reminderId)}
        onOpen={() => onOpenReminder(reminder.reminderId)}
        linkClassName="reminder-title"
        badge={reminder.status === "active" ? null : <StatusBadge status={reminder.status} />}
        when={
          <>
            <span className="schedule-cadence">
              {reminderWhen.kind === "repeat" ? repeatText(reminderWhen) : whenText(reminderWhen, timeZone)} · {reminder.timezone}
            </span>
            {" · "}
            {reminder.nextFireAt === null
              ? on
                ? t("center.recurringEntries.nothingLeft")
                : t("center.recurringEntries.pausedState")
              : t("center.recurringEntries.next", {
                  at: dayTime(reminder.nextFireAt, timeZone),
                  relative: relativeTime(reminder.nextFireAt, now, timeZone),
                })}
          </>
        }
        lastClassName="reminder-meta"
        last={
          <>
            {lastFire !== undefined
              ? t("center.recurringEntries.lastFire", { fire: lastFireText(lastFire, timeZone) })
              : reminder.lastFiredAt === null
                ? notRun()
                : t("center.recurringEntries.lastFired", { at: dayTime(reminder.lastFiredAt, timeZone) })}
            <ReminderPerson principalId={reminder.principalId} people={people} show={showPerson} />
            <AddedFrom reminder={reminder} onFollow={onFollow} />
          </>
        }
        toggle={{
          on,
          label: t(on ? "center.recurringEntries.pauseNamed" : "center.recurringEntries.resumeNamed", { name: reminder.text }),
          disabled: reminder.status !== "active" && reminder.status !== "paused",
          onToggle: () => act(on ? "pause" : "resume"),
        }}
        menu={[
          ...(reminder.status === "active" || reminder.status === "paused"
            ? [{ label: t("center.recurringEntries.edit"), onSelect: () => setEditingReminder(reminder) }]
            : []),
          { label: t("center.recurringEntries.duplicate"), onSelect: () => setCopyingReminder(reminder) },
          {
            label: t("center.recurringEntries.delete"),
            danger: true,
            onSelect: () => undoDelete.hold(key, reminder.text, transition("cancel")),
          },
        ]}
        busy={busy !== undefined}
      />
    ),
  };
}

/** A plain schedule as a row, through the schedules' own actions; Delete waits behind its Undo. */
export function scheduleEntry(context: EntryContext, row: ListedSchedule): Entry {
  const { client, workspaceId, scheduleActions, busy, at, nextText, timeZone, undoDelete, onOpenSchedule } = context;
  const key = `schedule:${row.scheduleId}`;
  const state = scheduleState(row);
  const taskId = row.lastRunTaskId;
  const request = (action: "enable" | "disable") => () => switchSchedule(client, workspaceId, row.scheduleId, action);
  const menu: RowMenuItem[] = [
    { label: t("center.recurringEntries.edit"), onSelect: () => scheduleActions.edit(row.scheduleId) },
    { label: t("center.recurringEntries.duplicate"), onSelect: () => scheduleActions.duplicate(row.scheduleId) },
    ...(taskId ? [{ label: t("center.recurringEntries.openLastTask"), onSelect: () => scheduleActions.openLast(taskId) }] : []),
    {
      label: t("center.recurringEntries.delete"),
      danger: true,
      onSelect: () => undoDelete.hold(key, row.name, () => removeSchedule(client, workspaceId, row.scheduleId)),
    },
  ];
  const watching = watchText(row);
  // A finished schedule has nothing left to run: it is neither failing nor paused, and cannot be resumed as it is.
  const finished = state === "finished";
  return {
    key,
    kind: "schedule",
    name: row.name,
    next: row.enabled ? row.nextRunAt : undefined,
    failing: !finished && (row.consecutiveFailures > 0 || state === "failed" || state === "paused-failures"),
    paused: !row.enabled && !finished,
    watcher: watching !== undefined,
    pause: row.enabled ? request("disable") : undefined,
    resume: row.enabled || finished ? undefined : request("enable"),
    row: (
      <RecurringRow
        key={key}
        kind="schedule"
        rowKey={key}
        name={row.name}
        href={schedulePath(row.scheduleId)}
        onOpen={() => onOpenSchedule(row.scheduleId)}
        badge={
          <>
            {watching === undefined ? null : (
              <span className="badge" title={watching}>
                {t("center.recurringEntries.watcher")}
              </span>
            )}
            {state === undefined ? null : <StatusBadge status={state} />}
          </>
        }
        when={
          <>
            <span className="schedule-cadence">{watching ?? specText(row.spec)}</span> ·{" "}
            {row.enabled ? nextText(row.nextRunAt) : pausedText(row)}
          </>
        }
        last={
          <>
            {row.lastRunAt === null ? null : `${t("center.recurringEntries.lastRun", { when: at(row.lastRunAt) })} · `}
            {outcomeSentence(row.lastOutcome, timeZone)}
            {row.consecutiveFailures > 0 ? ` ${t("center.recurringEntries.failuresInARow", { count: row.consecutiveFailures })}` : ""}
          </>
        }
        runNow={{ onRun: () => void scheduleActions.act({ action: "run", scheduleId: row.scheduleId }, row.name) }}
        toggle={{
          on: row.enabled,
          label: t(row.enabled ? "center.recurringEntries.pauseNamed" : "center.recurringEntries.resumeNamed", { name: row.name }),
          disabled: finished,
          hint: finished ? finishedHint() : undefined,
          onToggle: () => void scheduleActions.act({ action: row.enabled ? "disable" : "enable", scheduleId: row.scheduleId }, row.name),
        }}
        menu={menu}
        busy={busy !== undefined}
      />
    ),
  };
}

/** The heartbeat as a row: on and off, Check now, and Edit on its own page. */
export function heartbeatEntry(context: EntryContext, answer: HeartbeatGetAnswer): Entry {
  const { client, workspaceId, actions, heartbeat, busy, now, at, onOpenHeartbeat } = context;
  const { config } = answer;
  const paused = config.paused;
  const next = config.enabled && paused === undefined ? answer.state?.nextTickAt : undefined;
  const lastTick = answer.state?.lastTickAt;
  const toggle = (): void =>
    void actions.run("heartbeat", async () => {
      const done = await changeHeartbeat(client, workspaceId, answer.revision, { enabled: !config.enabled });
      if (!done.ok) {
        heartbeat.reload();
        return done;
      }
      heartbeat.replace(done.value);
      return {
        ok: true,
        value: t(done.value.config.enabled ? "center.recurringEntries.heartbeatOn" : "center.recurringEntries.heartbeatOff"),
      };
    });
  const check = (): void =>
    void actions.run("heartbeat-check", async () => {
      const done = await checkHeartbeatNow(client, workspaceId);
      if (!done.ok) return done;
      return {
        ok: true,
        value: t(done.value.status === "started" ? "center.recurringEntries.checking" : "center.recurringEntries.checkQueued"),
      };
    });
  return {
    key: "heartbeat",
    kind: "heartbeat",
    name: t("center.recurringEntries.heartbeat"),
    next,
    failing: paused?.reason === "failures" || paused?.reason === "provider",
    paused: !config.enabled || paused !== undefined,
    row: (
      <RecurringRow
        key="heartbeat"
        kind="heartbeat"
        rowKey="heartbeat"
        name={t("center.recurringEntries.heartbeat")}
        href={centerPath("heartbeat")}
        onOpen={onOpenHeartbeat}
        badge={!config.enabled ? <StatusBadge status="off" /> : paused === undefined ? null : <StatusBadge status="paused" />}
        when={
          <>
            <span className="schedule-cadence">{heartbeatCadence(answer)}</span> ·{" "}
            {!config.enabled
              ? t("center.recurringEntries.off")
              : paused !== undefined
                ? paused.until === undefined
                  ? t("center.recurringEntries.pausedState")
                  : t("center.recurringEntries.pausedUntil", { until: dayTime(paused.until, answer.timezone) })
                : next === undefined
                  ? t("center.recurringEntries.noCheckDue")
                  : t("center.recurringEntries.nextCheck", { at: at(next), relative: relativeTime(next, now, answer.timezone) })}
          </>
        }
        last={lastTick === undefined ? notRun() : t("center.recurringEntries.lastCheck", { at: at(lastTick) })}
        runNow={{
          onRun: check,
          disabled: !config.enabled || paused !== undefined || !answer.hostRunning,
          title: answer.hostRunning ? undefined : t("center.recurringEntries.runsInServe"),
        }}
        toggle={{
          on: config.enabled,
          label: t(config.enabled ? "center.recurringEntries.turnOffHeartbeat" : "center.recurringEntries.turnOnHeartbeat"),
          disabled: false,
          onToggle: toggle,
        }}
        menu={[{ label: t("center.recurringEntries.edit"), onSelect: onOpenHeartbeat }]}
        busy={busy !== undefined}
      />
    ),
  };
}
