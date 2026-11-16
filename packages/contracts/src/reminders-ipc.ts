import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import {
  REMINDER_FIRES_MAX_LIMIT,
  REMINDER_LIST_MAX_LIMIT,
  REMINDER_OCCURRENCES,
  REMINDER_SNOOZE_MAX_MINUTES,
  ReminderCursorSchema,
  ReminderDeliverToSchema,
  ReminderFireSchema,
  ReminderFireViewSchema,
  ReminderOffsetSchema,
  ReminderOperationKeySchema,
  ReminderPromptSchema,
  ReminderSchema,
  ReminderStatusSchema,
  ReminderTextSchema,
  ReminderWhenSchema,
  REMINDER_STATUSES,
  TODO_STATUSES,
  TodoDueSchema,
  TodoListNameSchema,
  TodoNotesSchema,
  TodoSchema,
  TodoStatusSchema,
} from "./reminders.js";
import { TimeZoneSchema } from "./workspace-settings.js";

/**
 * `reminders`: the operator's view of every
 * person's reminders, and the operator's edits. The agent's own tools
 * (`reminders.*`) see only the asking person's.
 */

/** Upcoming fires listed with each reminder. */
export const REMINDERS_IPC_UPCOMING = 5;
/** Recent fires `get` returns. */
export const REMINDERS_IPC_RECENT_FIRES = 20;
export const REMINDERS_IPC_LIST_DEFAULT = 50;
export const REMINDERS_IPC_FIRES_DEFAULT = 50;

const target = { workspaceId: IdSchema.optional(), reminderId: IdSchema } as const;

export const RemindersPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("list"),
    workspaceId: IdSchema.optional(),
    /** Absent: active and paused. */
    statuses: z.array(ReminderStatusSchema).min(1).max(REMINDER_STATUSES.length).optional(),
    /** One person's reminders; absent, everyone's. */
    principalId: IdSchema.optional(),
    /** Only the reminders asked for in this chat. */
    originTaskId: IdSchema.optional(),
    cursor: ReminderCursorSchema.optional(),
    limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT).optional(),
  }),
  z.strictObject({ action: z.literal("get"), ...target }),
  z.strictObject({
    action: z.literal("create"),
    workspaceId: IdSchema.optional(),
    text: ReminderTextSchema,
    prompt: ReminderPromptSchema.optional(),
    when: ReminderWhenSchema,
    /** Absent: the workspace's zone (the owner host's while none is set). */
    timezone: TimeZoneSchema.optional(),
    /** Absent: the app. */
    deliverTo: ReminderDeliverToSchema.optional(),
    /** Whom it is for. Absent: the operator. */
    principalId: IdSchema.optional(),
    /** A retried create with the same key returns the first one's reminder. Absent: a fresh key. */
    operationKey: ReminderOperationKeySchema.optional(),
    /** The chat it is asked from, which lists it (the chat panel's "Remind me about this chat…"). */
    originTaskId: IdSchema.optional(),
    /** The reminder this one copies (Duplicate), of this workspace and the same person: the copy keeps its `label`. */
    copyOf: IdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    ...target,
    /** The `updatedAt` the edit was based on; a later change makes this a `CONFLICT`. */
    expectedUpdatedAt: TimestampSchema,
    text: ReminderTextSchema.optional(),
    prompt: ReminderPromptSchema.nullable().optional(),
    when: ReminderWhenSchema.optional(),
    timezone: TimeZoneSchema.optional(),
    deliverTo: ReminderDeliverToSchema.optional(),
  }),
  z.strictObject({ action: z.literal("cancel"), ...target, expectedUpdatedAt: TimestampSchema.optional() }),
  z.strictObject({ action: z.literal("pause"), ...target, expectedUpdatedAt: TimestampSchema.optional() }),
  z.strictObject({ action: z.literal("resume"), ...target, expectedUpdatedAt: TimestampSchema.optional() }),
  z.strictObject({
    action: z.literal("snooze"),
    ...target,
    /** Any span from a minute up to a week (`tavi reminders snooze --minutes`); a delivery's buttons offer 10 or 60. */
    minutes: z
      .number()
      .int()
      .min(1, "Snooze for at least a minute")
      .max(REMINDER_SNOOZE_MAX_MINUTES, `Snooze for at most ${REMINDER_SNOOZE_MAX_MINUTES} minutes (a week)`),
    /** The fire to snooze. Absent: the latest delivered one not yet acknowledged. */
    fireAt: TimestampSchema.optional(),
  }),
  z.strictObject({ action: z.literal("acknowledge"), ...target, fireAt: TimestampSchema }),
  z.strictObject({
    action: z.literal("fires"),
    workspaceId: IdSchema.optional(),
    /** `unseen`: delivered in the app and not yet acknowledged (the rail). Absent: every recent fire. */
    status: z.literal("unseen").optional(),
    reminderId: IdSchema.optional(),
    limit: z.number().int().min(1).max(REMINDER_FIRES_MAX_LIMIT).optional(),
  }),
  // To-dos (`TodoSchema`): the Center's list, `tavi todos`, and the operator's own adds and ticks.
  z.strictObject({
    action: z.literal("todos"),
    workspaceId: IdSchema.optional(),
    /** Absent: open ones. */
    statuses: z.array(TodoStatusSchema).min(1).max(TODO_STATUSES.length).optional(),
    list: TodoListNameSchema.optional(),
    principalId: IdSchema.optional(),
    cursor: ReminderCursorSchema.optional(),
    limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT).optional(),
  }),
  z.strictObject({
    action: z.literal("todo-add"),
    workspaceId: IdSchema.optional(),
    text: ReminderTextSchema,
    list: TodoListNameSchema.optional(),
    notes: TodoNotesSchema.optional(),
    due: TodoDueSchema.optional(),
    timezone: TimeZoneSchema.optional(),
    principalId: IdSchema.optional(),
    operationKey: ReminderOperationKeySchema.optional(),
  }),
  z.strictObject({
    action: z.literal("todo-update"),
    workspaceId: IdSchema.optional(),
    todoId: IdSchema,
    expectedUpdatedAt: TimestampSchema.optional(),
    text: ReminderTextSchema.optional(),
    list: TodoListNameSchema.optional(),
    notes: TodoNotesSchema.nullable().optional(),
    due: TodoDueSchema.nullable().optional(),
    status: TodoStatusSchema.optional(),
  }),
  z.strictObject({ action: z.literal("todo-remove"), workspaceId: IdSchema.optional(), todoId: IdSchema }),
]);
export type RemindersPayload = z.infer<typeof RemindersPayloadSchema>;

export const ReminderUpcomingSchema = z.strictObject({
  at: TimestampSchema,
  occurrence: z.enum(REMINDER_OCCURRENCES),
  noticeOffset: ReminderOffsetSchema.optional(),
});
export type ReminderUpcoming = z.infer<typeof ReminderUpcomingSchema>;

/** A reminder as the page shows it: the record, and its next fires. */
export const ReminderViewSchema = ReminderSchema.extend({
  upcoming: z.array(ReminderUpcomingSchema).max(REMINDERS_IPC_UPCOMING),
});
export type ReminderView = z.infer<typeof ReminderViewSchema>;

export const RemindersListAnswerSchema = z.strictObject({
  timezone: TimeZoneSchema,
  reminders: z.array(ReminderViewSchema),
  nextCursor: ReminderCursorSchema.optional(),
});
export type RemindersListAnswer = z.infer<typeof RemindersListAnswerSchema>;

export const ReminderGetAnswerSchema = z.strictObject({
  reminder: ReminderViewSchema,
  /** Newest first. */
  fires: z.array(ReminderFireSchema).max(REMINDERS_IPC_RECENT_FIRES),
});
export type ReminderGetAnswer = z.infer<typeof ReminderGetAnswerSchema>;

export const ReminderCreateAnswerSchema = z.strictObject({
  reminder: ReminderViewSchema,
  created: z.boolean(),
  duplicate: z.literal(true).optional(),
  skippedNotices: z.array(ReminderOffsetSchema),
});
export type ReminderCreateAnswer = z.infer<typeof ReminderCreateAnswerSchema>;

export const ReminderWriteAnswerSchema = z.strictObject({ reminder: ReminderViewSchema });
export type ReminderWriteAnswer = z.infer<typeof ReminderWriteAnswerSchema>;

export const ReminderSnoozeAnswerSchema = z.strictObject({
  reminder: ReminderViewSchema,
  snoozed: ReminderFireSchema,
  followUp: ReminderFireSchema,
});
export type ReminderSnoozeAnswer = z.infer<typeof ReminderSnoozeAnswerSchema>;

export const ReminderAcknowledgeAnswerSchema = z.strictObject({ fire: ReminderFireSchema });
export type ReminderAcknowledgeAnswer = z.infer<typeof ReminderAcknowledgeAnswerSchema>;

export const ReminderFiresAnswerSchema = z.strictObject({ fires: z.array(ReminderFireViewSchema) });
export type ReminderFiresAnswer = z.infer<typeof ReminderFiresAnswerSchema>;

export const TodosListAnswerSchema = z.strictObject({
  timezone: TimeZoneSchema,
  todos: z.array(TodoSchema),
  nextCursor: ReminderCursorSchema.optional(),
});
export type TodosListAnswer = z.infer<typeof TodosListAnswerSchema>;

export const TodoWriteAnswerSchema = z.strictObject({
  todo: TodoSchema,
  /** Only on `todo-add`. */
  created: z.boolean().optional(),
  duplicate: z.literal(true).optional(),
});
export type TodoWriteAnswer = z.infer<typeof TodoWriteAnswerSchema>;

export const TodoRemoveAnswerSchema = z.strictObject({ todoId: IdSchema, removed: z.boolean() });
export type TodoRemoveAnswer = z.infer<typeof TodoRemoveAnswerSchema>;
