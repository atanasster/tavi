import { reminderIdOfTaskKey, type ReminderView } from "@tavi/contracts";
import { useState } from "react";

import { listSchedules } from "../center/schedules-api.js";
import { dayTime, todayIn } from "../../lib/time.js";
import { whenText } from "../center/reminder-model.js";
import { NewReminderForm } from "../center/Reminders.js";
import { getReminder, listReminders } from "../center/reminders-api.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { loadTaskRecord } from "../chat/tasks-api.js";
import { RepeatForms } from "../chat/RepeatThis.js";
import { CenterLink, CHAT_NOT_STARTED, NO_CHAT_SELECTED, Pending, StatusNote } from "../../ui/Parts.js";
import type { Session } from "../shell/shell.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { chatVersion } from "./load.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { ChatPanelItem } from "./ChatPanelItem.js";

/** What started the chat, when something other than a person did. */
type ChatOrigin =
  | { readonly kind: "schedule"; readonly scheduleId: string; readonly name: string | undefined; readonly routineId: string | undefined }
  | { readonly kind: "reminder"; readonly reminderId: string; readonly text: string };

/** The chat's place in the workspace's schedule: what started it, and the reminders asked for in it. */
export interface ChatSchedule {
  readonly origin: ChatOrigin | undefined;
  readonly reminders: readonly ReminderView[];
  readonly timezone: string | undefined;
}

type TaskRow = { readonly origin?: string; readonly originScheduleId?: string | null; readonly creationOperationKey?: string | null };

/**
 * The chat's schedule, from what the owner already lists: its task's record
 * (a schedule or a reminder's fire that started it — a fire's task is keyed by
 * its reminder) and the reminders the owner listed for it (`originTaskId`).
 */
export function chatScheduleOf(
  task: TaskRow | null | undefined,
  schedules: readonly { readonly scheduleId: string; readonly name: string; readonly routineId?: string | undefined }[],
  reminders: readonly ReminderView[],
  startedBy: { readonly reminderId: string; readonly text: string } | undefined,
): Omit<ChatSchedule, "timezone"> {
  const scheduleId = task?.originScheduleId ?? undefined;
  const schedule = schedules.find((item) => item.scheduleId === scheduleId);
  const origin: ChatOrigin | undefined =
    scheduleId !== undefined
      ? { kind: "schedule", scheduleId, name: schedule?.name, routineId: schedule?.routineId }
      : startedBy !== undefined
        ? { kind: "reminder", reminderId: startedBy.reminderId, text: startedBy.text }
        : undefined;
  // The owner already listed the chat's own — a delegated task's as its chat's.
  return { origin, reminders };
}

/** Every reminder asked for in the chat, as the owner filters them, page by page. */
async function chatReminders(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
): Promise<Outcome<{ readonly reminders: readonly ReminderView[]; readonly timezone: string }>> {
  const reminders: ReminderView[] = [];
  let cursor: string | undefined;
  let timezone = "UTC";
  // A chat holds a few reminders; the bound only keeps a runaway owner from looping.
  for (let page = 0; page < 10; page += 1) {
    const listed = await listReminders(client, workspaceId, ["active", "paused", "done"], { originTaskId: taskId, cursor });
    if (!listed.ok) return listed;
    reminders.push(...listed.value.reminders);
    timezone = listed.value.timezone;
    cursor = listed.value.nextCursor;
    if (cursor === undefined) break;
  }
  return { ok: true, value: { reminders, timezone } };
}

/** The chat's schedule; an owner without reminders (`reminders` false) is asked only about schedules. */
async function loadChatSchedule(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  reminders: boolean,
): Promise<Outcome<ChatSchedule>> {
  const task = await loadTaskRecord(client, taskId);
  if (!task.ok) return task;
  const row = task.value.task;
  const firedBy = reminders && row?.origin === "reminder" ? reminderIdOfTaskKey(row.creationOperationKey ?? null) : undefined;
  const [listed, fired, schedules] = await Promise.all([
    reminders ? chatReminders(client, workspaceId, taskId) : Promise.resolve(undefined),
    firedBy === undefined ? Promise.resolve(undefined) : getReminder(client, workspaceId, firedBy),
    row?.originScheduleId ? listSchedules(client, workspaceId) : Promise.resolve(undefined),
  ]);
  if (listed?.ok === false) return listed;
  const startedBy =
    firedBy === undefined
      ? undefined
      : { reminderId: firedBy, text: fired?.ok === true ? fired.value.reminder.text : "a reminder whose text could not be read" };
  const found = chatScheduleOf(row, schedules?.ok === true ? schedules.value.schedules : [], listed?.value.reminders ?? [], startedBy);
  return { ok: true, value: { ...found, timezone: listed?.value.timezone } };
}

/**
 * The chat panel's Schedule tab: what started the chat, if a schedule or a
 * reminder did, and the reminders asked for in it, each opening its page in
 * the Command Center, and *Repeat this…*: a new schedule (or, for research, a
 * routine) filled from the chat. Routines and schedules are not tied to a chat
 * and stay in the Center.
 */
export function Schedule({
  session,
  reminders,
  repeat = false,
  onOpenReminder,
  onOpenRoutine,
  onOpenSchedule,
  onCenter,
}: {
  readonly session: Session | undefined;
  /** Whether the owner offers reminders; without them only a schedule that started the chat is shown. */
  readonly reminders: boolean;
  /** Whether the owner offers schedules: the chat can be repeated as one. */
  readonly repeat?: boolean;
  readonly onOpenReminder: (reminderId: string) => void;
  readonly onOpenRoutine: (routineId: string) => void;
  /** A plain schedule's page in the Command Center; absent, its Schedule section stands in. */
  readonly onOpenSchedule?: ((scheduleId: string) => void) | undefined;
  /** The Command Center's Schedule; absent when the owner does not offer it. */
  readonly onCenter?: (() => void) | undefined;
}) {
  if (session === undefined) return <Empty>{NO_CHAT_SELECTED}</Empty>;
  return (
    <>
      {session.taskId === undefined ? (
        <Empty>{CHAT_NOT_STARTED}</Empty>
      ) : (
        <ChatScheduleView
          key={session.taskId}
          session={session}
          taskId={session.taskId}
          reminders={reminders}
          repeat={repeat}
          onOpenReminder={onOpenReminder}
          onOpenRoutine={onOpenRoutine}
          onOpenSchedule={onOpenSchedule}
          onCenter={onCenter}
        />
      )}
      <CenterLink what="Schedule" onCenter={onCenter} />
    </>
  );
}

function ChatScheduleView({
  session,
  taskId,
  reminders,
  repeat,
  onOpenReminder,
  onOpenRoutine,
  onOpenSchedule,
  onCenter,
}: {
  readonly session: Session;
  readonly taskId: string;
  readonly reminders: boolean;
  readonly repeat: boolean;
  readonly onOpenReminder: (reminderId: string) => void;
  readonly onOpenRoutine: (routineId: string) => void;
  readonly onOpenSchedule?: ((scheduleId: string) => void) | undefined;
  readonly onCenter?: (() => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const { data, error, reload } = useLoaded(() => loadChatSchedule(client, workspaceId, taskId, reminders), [chatVersion(session)]);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string>();
  const [repeating, setRepeating] = useState(false);
  const [repeated, setRepeated] = useState<string>();
  if (data === undefined) return <Pending error={error} />;
  const today = todayIn(data.timezone);
  const origin = data.origin;
  // A routine's schedule opens the routine's page; a plain one, its own page (or, without one, the Center's Schedule).
  const routineId = origin?.kind === "schedule" ? origin.routineId : undefined;
  const scheduleId = origin?.kind === "schedule" ? origin.scheduleId : undefined;
  const openSchedule =
    routineId !== undefined
      ? () => onOpenRoutine(routineId)
      : scheduleId !== undefined && onOpenSchedule !== undefined
        ? () => onOpenSchedule(scheduleId)
        : onCenter;
  return (
    <>
      {origin === undefined ? null : (
        <section aria-label="what started this chat">
          <h4>Started by</h4>
          {origin.kind === "schedule" ? (
            <p>
              {origin.routineId === undefined ? "The schedule" : "The routine"} <strong>{origin.name ?? origin.scheduleId}</strong>
              {openSchedule === undefined ? null : (
                <>
                  {" "}
                  <Button variant="ghost" size="sm" onClick={openSchedule}>
                    Open
                  </Button>
                </>
              )}
            </p>
          ) : (
            <p>
              The reminder{" "}
              <Button variant="ghost" size="sm" onClick={() => onOpenReminder(origin.reminderId)}>
                {origin.text}
              </Button>
            </p>
          )}
        </section>
      )}
      {!repeat ? null : (
        <section aria-label="repeat this chat">
          <h4>Repeat this chat</h4>
          <StatusNote note={repeated} className="chat-panel-note meta-sm" />
          <Button
            variant="ghost"
            size="sm"
            aria-haspopup="dialog"
            onClick={() => {
              setRepeated(undefined);
              setRepeating(true);
            }}
          >
            Repeat this…
          </Button>
          {repeating ? (
            <RepeatForms
              source={{ taskId, runs: session.runs }}
              onClose={() => setRepeating(false)}
              onDone={(note) => {
                setRepeating(false);
                setRepeated(note);
              }}
            />
          ) : null}
        </section>
      )}
      {!reminders ? null : (
        <section aria-label="reminders from this chat">
          <h4>Reminders from this chat</h4>
          {data.reminders.length === 0 ? (
            <Empty>None asked for here.</Empty>
          ) : (
            <ol className="chat-panel-timeline list-reset">
              {data.reminders.map((reminder) => (
                <li key={reminder.reminderId}>
                  <ChatPanelItem onOpen={() => onOpenReminder(reminder.reminderId)}>
                    <span className="chat-panel-item-title truncate">{reminder.text}</span>
                    <span className="chat-panel-item-detail meta-sm">
                      {whenText(reminder.when, data.timezone, today)} ·{" "}
                      {reminder.status === "active"
                        ? reminder.nextFireAt === null
                          ? "nothing due"
                          : `next ${dayTime(reminder.nextFireAt, data.timezone, today)}`
                        : reminder.status}
                    </span>
                  </ChatPanelItem>
                </li>
              ))}
            </ol>
          )}
          <StatusNote note={added} className="chat-panel-note meta-sm" />
          {adding ? (
            <NewReminderForm
              originTaskId={taskId}
              timeZone={data.timezone ?? "UTC"}
              today={today}
              onClose={() => setAdding(false)}
              onSaved={(_reminder, message) => {
                setAdding(false);
                setAdded(message);
                reload();
              }}
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdded(undefined);
                setAdding(true);
              }}
            >
              Remind me about this chat…
            </Button>
          )}
        </section>
      )}
    </>
  );
}
