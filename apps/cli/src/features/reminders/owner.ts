import { randomUUID } from "node:crypto";

import {
  DEFAULT_WORKSPACE_ID,
  REMINDERS_IPC_FIRES_DEFAULT,
  REMINDERS_IPC_LIST_DEFAULT,
  REMINDERS_IPC_RECENT_FIRES,
  REMINDERS_IPC_UPCOMING,
  hostTimeZone,
  upcomingReminderFires,
  type PersistencePort,
  type Reminder,
  type ReminderAcknowledgeAnswer,
  type ReminderDeliverTo,
  type ReminderCreateAnswer,
  type ReminderFire,
  type ReminderFireView,
  type ReminderFiresAnswer,
  type ReminderGetAnswer,
  type ReminderSnoozeAnswer,
  type ReminderView,
  type ReminderWriteAnswer,
  type RemindersListAnswer,
  type RemindersPayload,
  type Todo,
  type TodoRemoveAnswer,
  type TodoWriteAnswer,
  type TodosListAnswer,
  keyedError,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { refusalFrom, type IpcAnswer } from "../../shared/ipc-decisions.js";

/**
 * `reminders`: the operator's view of every
 * person's reminders in a workspace, and the operator's edits, snoozes and
 * acknowledgements. Whatever the operator creates is `createdBy: "user"` and,
 * unless it names a conversation, delivered in the app.
 *
 * The schedule rules (the past, two years ahead, six times a day, 100 active)
 * are the store's, and its refusals are worded for a person, so they are
 * passed on as they are.
 */
export interface RemindersCommandDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "reminders" | "workspaceSettings" | "tasks" | "agentDelegations">;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly now: () => Date;
  /** Whether a person's reminder may be said in a conversation; absent, only the app is accepted. */
  readonly conversationAllowed?: (
    owner: { readonly workspaceId: string; readonly principalId: string; readonly originTaskId?: string | undefined },
    connectionId: string,
    conversationId: string,
  ) => Promise<boolean>;
  /** A fresh id; a test pins it. */
  readonly newId?: () => string;
}

export type RemindersAnswer = IpcAnswer<
  | RemindersListAnswer
  | ReminderGetAnswer
  | ReminderCreateAnswer
  | ReminderWriteAnswer
  | ReminderSnoozeAnswer
  | ReminderAcknowledgeAnswer
  | ReminderFiresAnswer
  | TodosListAnswer
  | TodoWriteAnswer
  | TodoRemoveAnswer
>;

/**
 * A reminder with its next fires. Only an active reminder has any; a snoozed
 * fire coming back shows in `nextFireAt`, which is always the earliest.
 */
function reminderView(reminder: Reminder, now: Date): ReminderView {
  const upcoming =
    reminder.status === "active"
      ? upcomingReminderFires(reminder, now, REMINDERS_IPC_UPCOMING).map((fire) => ({
          at: fire.at.toISOString(),
          occurrence: fire.occurrence,
          ...(fire.noticeOffset === undefined ? {} : { noticeOffset: fire.noticeOffset }),
        }))
      : [];
  return { ...reminder, upcoming };
}

/** A fire without the reminder fields a cross-reminder list adds. */
function fireOf(view: ReminderFireView): ReminderFire {
  const { workspaceId: _workspace, principalId: _principal, text: _text, ...fire } = view;
  return fire;
}

export async function remindersCommand(deps: RemindersCommandDependencies, payload: RemindersPayload): Promise<RemindersAnswer> {
  try {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    // As `center`: a workspace this owner does not serve would otherwise
    // answer an empty, plausible-looking list.
    const operator = deps.principalOf(workspaceId);
    if (operator === undefined) {
      throw keyedError("NOT_FOUND", "error.workspace.notConfigured", { workspaceId }, { details: { workspaceId } });
    }
    const reminders = deps.repositories.reminders;
    const now = deps.now();
    const stamp = now.toISOString();
    const newId = deps.newId ?? (() => randomUUID());
    /** A reminder of this workspace, or `NOT_FOUND` — another workspace's is not said to exist. */
    const inWorkspace = async (reminderId: string): Promise<Reminder> => {
      const reminder = await reminders.get(reminderId);
      if (reminder === undefined || reminder.workspaceId !== workspaceId)
        throw keyedError("NOT_FOUND", "error.reminder.notFound", { reminderId });
      return reminder;
    };
    /**
     * As `inWorkspace`, but a to-do is refused: it is read and changed as a
     * to-do. Snooze, acknowledge and fires still take one, since a to-do's
     * delivered fire is snoozed and acknowledged from the rail.
     */
    const reminderOnly = async (reminderId: string): Promise<Reminder> => {
      const reminder = await inWorkspace(reminderId);
      if (reminder.kind === "todo") throw keyedError("CONFLICT", "error.reminder.isTodo");
      return reminder;
    };
    const written = (reminder: Reminder): RemindersAnswer => ({ ok: true, result: { reminder: reminderView(reminder, now) } });
    /** A to-do of this workspace, or `NOT_FOUND`. */
    const todoInWorkspace = async (todoId: string): Promise<Todo> => {
      const todo = await reminders.getTodo(todoId);
      if (todo === undefined || todo.workspaceId !== workspaceId) throw keyedError("NOT_FOUND", "error.todo.notFound", { todoId });
      return todo;
    };
    /** A conversation is refused unless it is one this person's reminders may go to. */
    const checkDeliverTo = async (
      deliverTo: ReminderDeliverTo | undefined,
      owner: { readonly principalId: string; readonly originTaskId?: string | undefined },
    ): Promise<void> => {
      if (deliverTo?.kind !== "conversation") return;
      const allowed =
        (await deps.conversationAllowed?.({ workspaceId, ...owner }, deliverTo.connectionId, deliverTo.conversationId)) === true;
      if (!allowed) {
        throw keyedError("INVALID_INPUT", "error.reminder.deliveryNotAllowed");
      }
    };

    /**
     * The chat a task belongs to: a delegated task's reminders are its
     * chat's, as the agent's own reminder tool files them.
     */
    const chatOf = async (taskId: string): Promise<string> => {
      const delegation = await deps.repositories.agentDelegations.getByWorkerTaskId(taskId);
      return delegation?.rootTaskId ?? delegation?.parentTaskId ?? taskId;
    };

    switch (payload.action) {
      case "list": {
        const listed = await reminders.list({
          workspaceId,
          statuses: payload.statuses ?? ["active", "paused"],
          limit: payload.limit ?? REMINDERS_IPC_LIST_DEFAULT,
          ...(payload.principalId === undefined ? {} : { principalId: payload.principalId }),
          ...(payload.originTaskId === undefined ? {} : { originTaskId: await chatOf(payload.originTaskId) }),
          ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
        });
        return {
          ok: true,
          result: {
            timezone: await workspaceZone(deps, workspaceId),
            reminders: listed.reminders.map((reminder) => reminderView(reminder, now)),
            ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
          },
        };
      }
      case "get": {
        const reminder = await reminderOnly(payload.reminderId);
        const fires = await reminders.fires({ workspaceId, reminderId: reminder.reminderId, limit: REMINDERS_IPC_RECENT_FIRES });
        return { ok: true, result: { reminder: reminderView(reminder, now), fires: fires.map(fireOf) } };
      }
      case "create": {
        if (payload.originTaskId !== undefined) {
          const task = await deps.repositories.tasks.get(payload.originTaskId);
          if (task === undefined || task.workspaceId !== workspaceId)
            throw keyedError("NOT_FOUND", "error.task.notFound", { taskId: payload.originTaskId });
        }
        const originTaskId = payload.originTaskId === undefined ? undefined : await chatOf(payload.originTaskId);
        const principalId = payload.principalId ?? operator;
        // A copy is made under the label its source was made under: the operator cannot clear a reminder's taint by duplicating it.
        const source = payload.copyOf === undefined ? undefined : await reminderOnly(payload.copyOf);
        if (source !== undefined && source.principalId !== principalId) throw keyedError("INVALID_INPUT", "error.reminder.copySamePerson");
        await checkDeliverTo(payload.deliverTo, {
          principalId,
          ...(originTaskId === undefined ? {} : { originTaskId }),
        });
        const created = await reminders.create({
          reminderId: `rem-${newId()}`,
          workspaceId,
          principalId,
          text: payload.text,
          ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
          when: payload.when,
          timezone: payload.timezone ?? (await workspaceZone(deps, workspaceId)),
          deliverTo: payload.deliverTo ?? { kind: "app" },
          createdBy: "user",
          ...(originTaskId === undefined ? {} : { originTaskId }),
          operationKey: payload.operationKey ?? `operator:${newId()}`,
          ...(source?.label === undefined ? {} : { label: source.label }),
          now: stamp,
        });
        return {
          ok: true,
          result: {
            reminder: reminderView(created.reminder, now),
            created: created.created,
            ...(created.duplicate === true ? { duplicate: true as const } : {}),
            skippedNotices: [...created.skippedNotices],
          },
        };
      }
      case "update": {
        const reminder = await reminderOnly(payload.reminderId);
        await checkDeliverTo(payload.deliverTo, reminder);
        return written(
          await reminders.update({
            reminderId: reminder.reminderId,
            expectedUpdatedAt: payload.expectedUpdatedAt,
            ...definedOnly({
              text: payload.text,
              prompt: payload.prompt,
              when: payload.when,
              timezone: payload.timezone,
              deliverTo: payload.deliverTo,
            }),
            now: stamp,
          }),
        );
      }
      case "cancel":
      case "pause":
      case "resume": {
        const reminder = await reminderOnly(payload.reminderId);
        return written(
          await reminders.transition({
            reminderId: reminder.reminderId,
            action: payload.action,
            ...(payload.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: payload.expectedUpdatedAt }),
            now: stamp,
          }),
        );
      }
      case "snooze": {
        const reminder = await inWorkspace(payload.reminderId);
        const snoozed = await reminders.snooze({
          reminderId: reminder.reminderId,
          minutes: payload.minutes,
          ...(payload.fireAt === undefined ? {} : { fireAt: payload.fireAt }),
          now: stamp,
        });
        return {
          ok: true,
          result: { reminder: reminderView(snoozed.reminder, now), snoozed: snoozed.snoozed, followUp: snoozed.followUp },
        };
      }
      case "acknowledge": {
        const reminder = await inWorkspace(payload.reminderId);
        return {
          ok: true,
          result: { fire: await reminders.acknowledge({ reminderId: reminder.reminderId, fireAt: payload.fireAt, now: stamp }) },
        };
      }
      case "fires": {
        if (payload.reminderId !== undefined) await inWorkspace(payload.reminderId);
        const fires = await reminders.fires({
          workspaceId,
          limit: payload.limit ?? REMINDERS_IPC_FIRES_DEFAULT,
          ...(payload.status === "unseen" ? { unseen: true } : {}),
          ...(payload.reminderId === undefined ? {} : { reminderId: payload.reminderId }),
        });
        return { ok: true, result: { fires: [...fires] } };
      }
      case "todos": {
        const listed = await reminders.listTodos({
          workspaceId,
          limit: payload.limit ?? REMINDERS_IPC_LIST_DEFAULT,
          ...definedOnly({ statuses: payload.statuses, list: payload.list, principalId: payload.principalId, cursor: payload.cursor }),
        });
        return {
          ok: true,
          result: {
            timezone: await workspaceZone(deps, workspaceId),
            todos: [...listed.todos],
            ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
          },
        };
      }
      case "todo-add": {
        // The operator's own to-do: a due time is said in the app.
        const added = await reminders.createTodo({
          todoId: `todo-${newId()}`,
          workspaceId,
          principalId: payload.principalId ?? operator,
          text: payload.text,
          ...definedOnly({ list: payload.list, notes: payload.notes, due: payload.due }),
          timezone: payload.timezone ?? (await workspaceZone(deps, workspaceId)),
          deliverTo: { kind: "app" },
          createdBy: "user",
          operationKey: payload.operationKey ?? `operator:${newId()}`,
          now: stamp,
        });
        return {
          ok: true,
          result: { todo: added.todo, created: added.created, ...(added.duplicate === true ? { duplicate: true as const } : {}) },
        };
      }
      case "todo-update": {
        const todo = await todoInWorkspace(payload.todoId);
        const updated = await reminders.updateTodo({
          todoId: todo.todoId,
          ...definedOnly({
            expectedUpdatedAt: payload.expectedUpdatedAt,
            text: payload.text,
            list: payload.list,
            notes: payload.notes,
            due: payload.due,
            status: payload.status,
          }),
          now: stamp,
        });
        return { ok: true, result: { todo: updated } };
      }
      case "todo-remove": {
        const todo = await todoInWorkspace(payload.todoId);
        return { ok: true, result: { todoId: todo.todoId, removed: await reminders.removeTodo({ todoId: todo.todoId }) } };
      }
    }
  } catch (error) {
    return refusalFrom(error);
  }
}

/** The workspace's effective zone, resolved per call like the runtime facts: the owner host's while none is set. */
export async function workspaceZone(
  deps: { readonly repositories: Pick<PersistencePort["repositories"], "workspaceSettings"> },
  workspaceId: string,
): Promise<string> {
  return (await deps.repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone();
}
