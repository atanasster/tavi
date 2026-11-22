import {
  ReminderAcknowledgeAnswerSchema,
  ReminderCreateAnswerSchema,
  ReminderFiresAnswerSchema,
  ReminderGetAnswerSchema,
  ReminderSnoozeAnswerSchema,
  ReminderWriteAnswerSchema,
  RemindersListAnswerSchema,
  TodoWriteAnswerSchema,
  TodosListAnswerSchema,
  type TodoStatus,
  type TodoWriteAnswer,
  type TodosListAnswer,
  type ReminderAcknowledgeAnswer,
  type ReminderDeliverTo,
  type ReminderCreateAnswer,
  type ReminderFiresAnswer,
  type ReminderGetAnswer,
  type ReminderSnoozeAnswer,
  type ReminderStatus,
  type ReminderWhen,
  type ReminderWriteAnswer,
  type RemindersListAnswer,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { z } from "zod";

import { listDeliveryTargets } from "../routines/api.js";
import { firstLine } from "../../lib/format.js";
import { translateNow } from "../../lib/i18n.js";
import { read, type Outcome, type Readable, type SettingsClient } from "../../lib/ipc.js";
import { admissionPrompt, loadTaskRecord } from "../chat/tasks-api.js";

/**
 * The canvas's side of the owner's `reminders` command. An answer the page cannot read is a failed outcome, never a value a
 * view trips over; a refusal keeps the owner's words ("That time is in the
 * past"), which the form shows as they are.
 */

function remind<T>(client: SettingsClient, payload: Record<string, unknown>, schema: Readable<T>): Promise<Outcome<T>> {
  return read(client, "reminders", payload, schema);
}

/** Reminders in `statuses` (the owner's default: active and paused), newest first. */
export function listReminders(
  client: SettingsClient,
  workspaceId: string,
  statuses?: readonly ReminderStatus[],
  options: { readonly originTaskId?: string | undefined; readonly cursor?: string | undefined } = {},
): Promise<Outcome<RemindersListAnswer>> {
  return remind(
    client,
    {
      action: "list",
      workspaceId,
      ...(statuses === undefined ? {} : { statuses: [...statuses] }),
      ...(options.originTaskId === undefined ? {} : { originTaskId: options.originTaskId }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      limit: 200,
    },
    RemindersListAnswerSchema,
  );
}

/** One reminder, with its 20 most recent fires. */
export function getReminder(client: SettingsClient, workspaceId: string, reminderId: string): Promise<Outcome<ReminderGetAnswer>> {
  return remind(client, { action: "get", workspaceId, reminderId }, ReminderGetAnswerSchema);
}

export interface NewReminder {
  readonly text: string;
  readonly when: ReminderWhen;
  readonly timezone?: string | undefined;
  readonly prompt?: string | undefined;
  /** Where it is said; absent, the app. */
  readonly deliverTo?: ReminderDeliverTo | undefined;
  /** One per form: a retried save returns the first one's reminder. */
  readonly operationKey: string;
  /** The chat it is asked from, which lists it. */
  readonly originTaskId?: string | undefined;
  /** Whom it is for; absent, the operator. */
  readonly principalId?: string | undefined;
  /** The reminder it copies (Duplicate): the owner keeps that one's label on it. */
  readonly copyOf?: string | undefined;
}

/** A reminder the operator adds from the page: delivered in the app, or to a chat the operator added as a delivery target. */
export function createReminder(client: SettingsClient, workspaceId: string, reminder: NewReminder): Promise<Outcome<ReminderCreateAnswer>> {
  return remind(
    client,
    {
      action: "create",
      workspaceId,
      text: reminder.text,
      when: reminder.when,
      ...definedOnly({
        timezone: reminder.timezone,
        prompt: reminder.prompt,
        deliverTo: reminder.deliverTo,
        originTaskId: reminder.originTaskId,
        principalId: reminder.principalId,
        copyOf: reminder.copyOf,
      }),
      operationKey: reminder.operationKey,
    },
    ReminderCreateAnswerSchema,
  );
}

/** What an edit changes: only what is named is sent; a `prompt` of `null` clears it. */
export interface ReminderEdit {
  readonly text?: string;
  readonly when?: ReminderWhen;
  readonly timezone?: string;
  readonly prompt?: string | null;
  readonly deliverTo?: ReminderDeliverTo;
}

/** Change a reminder in place, based on the `updatedAt` read: a change made meanwhile is the owner's `CONFLICT`. */
export function updateReminder(
  client: SettingsClient,
  workspaceId: string,
  reminderId: string,
  expectedUpdatedAt: string,
  edit: ReminderEdit,
): Promise<Outcome<ReminderWriteAnswer>> {
  return remind(client, { action: "update", workspaceId, reminderId, expectedUpdatedAt, ...edit }, ReminderWriteAnswerSchema);
}

/** Pause, resume or cancel. */
export function transitionReminder(
  client: SettingsClient,
  workspaceId: string,
  reminderId: string,
  action: "pause" | "resume" | "cancel",
): Promise<Outcome<ReminderWriteAnswer>> {
  return remind(client, { action, workspaceId, reminderId }, ReminderWriteAnswerSchema);
}

/** Bring a delivered fire (by default the latest one not yet done) back in 10 or 60 minutes. */
export function snoozeReminder(
  client: SettingsClient,
  workspaceId: string,
  reminderId: string,
  minutes: 10 | 60,
  fireAt?: string,
): Promise<Outcome<ReminderSnoozeAnswer>> {
  return remind(
    client,
    { action: "snooze", workspaceId, reminderId, minutes, ...(fireAt === undefined ? {} : { fireAt }) },
    ReminderSnoozeAnswerSchema,
  );
}

/** Mark a fire seen: Done. */
export function acknowledgeReminder(
  client: SettingsClient,
  workspaceId: string,
  reminderId: string,
  fireAt: string,
): Promise<Outcome<ReminderAcknowledgeAnswer>> {
  return remind(client, { action: "acknowledge", workspaceId, reminderId, fireAt }, ReminderAcknowledgeAnswerSchema);
}

/** The workspace's to-dos in `statuses` (the owner's default: open), oldest first. */
export function listTodos(
  client: SettingsClient,
  workspaceId: string,
  statuses?: readonly TodoStatus[],
): Promise<Outcome<TodosListAnswer>> {
  return remind(
    client,
    { action: "todos", workspaceId, ...(statuses === undefined ? {} : { statuses: [...statuses] }), limit: 200 },
    TodosListAnswerSchema,
  );
}

/** A to-do the operator adds from the page; one operation key per add, so a retried save is the same to-do. */
export function addTodo(
  client: SettingsClient,
  workspaceId: string,
  todo: { readonly text: string; readonly list?: string | undefined; readonly operationKey: string },
): Promise<Outcome<TodoWriteAnswer>> {
  return remind(
    client,
    { action: "todo-add", workspaceId, text: todo.text, ...definedOnly({ list: todo.list }), operationKey: todo.operationKey },
    TodoWriteAnswerSchema,
  );
}

/** Tick a to-do off, or put it back on its list. */
export function setTodoStatus(
  client: SettingsClient,
  workspaceId: string,
  todoId: string,
  status: TodoStatus,
): Promise<Outcome<TodoWriteAnswer>> {
  return remind(client, { action: "todo-update", workspaceId, todoId, status }, TodoWriteAnswerSchema);
}

/** Recent fires across reminders, newest first; `unseen`: delivered in the app and not yet done (the rail). */
export function listReminderFires(client: SettingsClient, workspaceId: string, unseen: boolean): Promise<Outcome<ReminderFiresAnswer>> {
  return remind(client, { action: "fires", workspaceId, ...(unseen ? { status: "unseen" } : {}), limit: 200 }, ReminderFiresAnswerSchema);
}

/** A chat a reminder can be said in: one of the operator's routine delivery targets. */
export interface ReminderChatTarget {
  readonly targetId: string;
  readonly label: string;
  readonly connectionId: string;
  readonly chatId: string;
}

/** What a reminder needs of a delivery target: the routine form reads less of one. */
const ChatTargetsSchema = z.array(
  z.object({
    targetId: z.string().min(1),
    label: z.string().min(1),
    connectionId: z.string().min(1),
    chatId: z.string().min(1),
    enabled: z.boolean(),
    authorized: z.boolean(),
  }),
);

/**
 * The chats the operator added as routine delivery targets (`routines
 * targets`, read as the routine form reads them), enabled and still
 * authorized: the ones the owner accepts as a reminder's `deliverTo`. An owner
 * without routines has none.
 */
export async function listReminderTargets(client: SettingsClient, workspaceId: string): Promise<Outcome<readonly ReminderChatTarget[]>> {
  const outcome = await listDeliveryTargets(client, workspaceId);
  if (!outcome.ok) return outcome;
  const parsed = ChatTargetsSchema.safeParse(outcome.value.targets);
  if (!parsed.success) return { ok: false, message: translateNow("center.remindersApi.targetsUnreadable") };
  return {
    ok: true,
    value: parsed.data
      .filter((target) => target.enabled && target.authorized)
      .map(({ targetId, label, connectionId, chatId }) => ({ targetId, label, connectionId, chatId })),
  };
}

const titles = new Map<string, Promise<string | undefined>>();

/**
 * What the chat a reminder was asked in is called: its title, else the first
 * line of its first prompt. Read once per task for the page's life; a chat
 * that cannot be read is undefined, and the page says "a chat".
 */
export function chatTitle(client: SettingsClient, taskId: string): Promise<string | undefined> {
  const known = titles.get(taskId);
  if (known !== undefined) return known;
  const reading = loadTaskRecord(client, taskId).then((outcome) => {
    if (!outcome.ok) {
      titles.delete(taskId);
      return undefined;
    }
    const title = outcome.value.task?.title;
    if (typeof title === "string" && title.trim() !== "") return title.trim();
    for (const admission of outcome.value.admissions ?? []) {
      const prompt = admissionPrompt(admission)?.trim();
      if (prompt) return firstLine(prompt, 60);
    }
    return undefined;
  });
  titles.set(taskId, reading);
  return reading;
}

/** Forget the chat titles read so far (tests). */
export function forgetChatTitles(): void {
  titles.clear();
}
