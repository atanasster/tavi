import { ChannelProviderIdSchema } from "./channels.js";
import { z } from "zod";
import { IdSchema, TimestampSchema } from "./ids.js";
import { TASK_NEEDS } from "./need-kinds.js";
import { CONVERSATION_HOME_KINDS } from "./messaging.js";
import { CHAT_KINDS, CHAT_MEMORY_MODES, TASK_ORIGINS } from "./ports/tasks.js";
import { TASK_SUMMARY_STATES, TASK_SUMMARY_TEXT_MAX } from "./task-summaries.js";

/** Session list bounds also keep worst-case escaped Unicode within one IPC frame. */
export const TASK_LIST_LIMIT = 100;
export const TASK_NEEDS_LIMIT = 128;
export const TASK_LIST_DEFAULT_LIMIT = 50;
/** The chat kinds a list may be narrowed to: the recorded kinds, and `chat` for a task with none. */
export const TASK_LIST_CHAT_KINDS = ["home", "side", "worker", "run", "chat"] as const;
/**
 * A listed task's status. `idle` is a Home's between turns: a chat that
 * never ends is never `completed`, nor `failed` because
 * one turn failed — its latest turn is working, needs the reader, or is done.
 */
export const TASK_SESSION_STATUSES = [
  "submitted",
  "working",
  "input-required",
  "idle",
  "completed",
  "stopped",
  "canceled",
  "failed",
  "unknown",
] as const;
/** `updated`: last touched first (the session sidebar). `created`: the day the prompt was asked. */
export const TASK_LIST_ORDERS = ["updated", "created"] as const;
export type TaskListOrder = (typeof TASK_LIST_ORDERS)[number];
export const TaskNeedSchema = z.enum(TASK_NEEDS);
const needs = z
  .array(TaskNeedSchema)
  .max(TASK_NEEDS.length)
  .refine((items) => new Set(items).size === items.length, "needs must be a set");
/**
 * Where a task came from, as a reader names it:
 * the routine whose run it is, the reminder or schedule that started it, a
 * delegation (`agent`), or the front end — `web` for the canvas, `terminal`
 * for `tavi run`/`tavi chat` (`cli`, `ipc`). A messaging task's kind is its
 * channel's provider id (`telegram`, `mailgun`, any plugin's), or `messaging`
 * when its provider was never recorded, so this list is
 * not closed: `TaskChannelKindSchema` accepts any provider id.
 */
export const TASK_CHANNEL_KINDS = ["messaging", "routine", "reminder", "schedule", "agent", "web", "terminal"] as const;
export const TaskChannelKindSchema = ChannelProviderIdSchema;
export type TaskChannelKind = string;
/** Opaque keyset cursor. Only the owner interprets its contents. */
export const TaskListCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
export const TaskListFiltersSchema = z
  .object({
    workspaceId: IdSchema.optional(),
    status: z.array(z.enum(TASK_SESSION_STATUSES)).max(TASK_SESSION_STATUSES.length).optional(),
    /** `ipc` also matches `web`: a canvas run was recorded as `ipc` before `web` existed. */
    origin: z.array(z.enum(TASK_ORIGINS)).max(TASK_ORIGINS.length).optional(),
    /** Tasks this person started only. */
    principalId: IdSchema.optional(),
    /** Tasks whose `channel` is one of these kinds; a task with no channel matches none. */
    channelKinds: z.array(TaskChannelKindSchema).min(1).max(32).optional(),
    /** Only these kinds of chat; `chat` is a task recorded with no kind. */
    chatKinds: z.array(z.enum(TASK_LIST_CHAT_KINDS)).min(1).max(TASK_LIST_CHAT_KINDS.length).optional(),
    /** Only the side chats opened from this chat. */
    parentChatId: IdSchema.optional(),
    // SQLite stores UTC milliseconds; normalize accepted ISO precision to match.
    since: TimestampSchema.transform((value) => new Date(value).toISOString()).optional(),
    until: TimestampSchema.transform((value) => new Date(value).toISOString()).optional(),
    query: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(TASK_LIST_LIMIT).optional(),
    cursor: TaskListCursorSchema.optional(),
    /** Absent: `updated`. The order also decides the column `since`/`until` bound; a cursor is valid only in its own order. */
    order: z.enum(TASK_LIST_ORDERS).optional(),
    /** Delegation workers are nested under their root (`delegated`) unless this is true. An inbox (`needs`) always includes them. */
    includeDelegated: z.boolean().optional(),
    /** Nonempty needs selects the complete matching inbox, ignoring limit/cursor, up to TASK_NEEDS_LIMIT. */
    needs: needs.optional(),
  })
  .strict()
  .refine((value) => value.since === undefined || value.until === undefined || value.since <= value.until, "since must not follow until");
export type TaskListFilters = z.infer<typeof TaskListFiltersSchema>;

/** A channel label's bound: a reminder's text is clipped to it. */
export const TASK_CHANNEL_LABEL_MAX = 60;
export const TaskChannelSchema = z
  .object({
    kind: TaskChannelKindSchema,
    /** The connection's id, the routine's or schedule's name, or the reminder's text; absent for the front ends and delegation. */
    label: z.string().min(1).max(256).optional(),
  })
  .strict();
export type TaskChannel = z.infer<typeof TaskChannelSchema>;

/** Projected durable session facts; never full prompts, tool payloads or credentials. */
export const TaskListRowSchema = z
  .object({
    taskId: IdSchema,
    workspaceId: IdSchema,
    /**
     * A status this build does not know (a newer owner's) reads as `unknown`, so a
     * list never fails on one row's status.
     */
    status: z.enum(TASK_SESSION_STATUSES).catch("unknown"),
    origin: z.enum(TASK_ORIGINS).nullable(),
    /** The reader's rename, else the generated title when the task has one, else the first line of its prompt (`titleSource`). */
    title: z.string().max(120).optional(),
    /** Optional so an older owner's rows still parse; this owner sends it with every title. */
    titleSource: z.enum(["generated", "prompt", "reader", "home"]).optional(),
    /** The generated one-line summary of what the task did, or null before one exists. */
    summary: z.string().max(TASK_SUMMARY_TEXT_MAX).nullable().optional(),
    /** Where the summary stands: null for a Home, or before the task's first admission. */
    summaryState: z.enum(TASK_SUMMARY_STATES).nullable().optional(),
    promptPreview: z.string().max(256).optional(),
    lastText: z.string().max(256).optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    /** Every need of the task and of its delegation workers (`descendantNeeds`), merged. */
    needs,
    /**
     * The task's own needs, without its workers': what an inbox shows on this
     * row, since a worker's own row carries its need. Optional so an older
     * owner's rows still parse; this owner always sends it.
     */
    ownNeeds: needs.optional(),
    /** The subset hoisted from descendants; live parent events must not clear it. */
    descendantNeeds: needs.optional(),
    // Historical calls may predate a durable counter; unknown must never mean zero.
    counts: z.object({ admissions: z.number().int().nonnegative(), tools: z.number().int().nonnegative().nullable() }).strict(),
    // Optional so an older owner's rows still parse; this owner always sends the first two.
    principalId: IdSchema.optional(),
    /** Delegation workers whose root (their parent, for a row without one) is this task. */
    delegated: z.number().int().nonnegative().optional(),
    /** Set on a delegation worker's own row, listed only under `includeDelegated`. */
    rootTaskId: IdSchema.optional(),
    /** Where the task came from; absent for a task whose start no longer says (an older owner's rows too). */
    channel: TaskChannelSchema.optional(),
    /** Follow-up prompts: replies with text, not system wakes (`tasks prompts` lists them). Optional so an older owner's rows still parse. */
    followUps: z.number().int().nonnegative().optional(),
    /** The chat has instructions of its own in force. Absent: none, or an older owner. */
    chatInstructions: z.literal(true).optional(),
    /** How many notes the chat keeps, in force or proposed. Absent: none, or an older owner. */
    chatNotes: z.number().int().positive().optional(),
    /** What chat the task is; absent for an ordinary chat recorded before kinds. */
    chatKind: z.enum(CHAT_KINDS).optional(),
    parentChatId: IdSchema.optional(),
    /** The chat's own memory mode: absent while memory is on, or from an older owner. */
    memoryMode: z.enum(CHAT_MEMORY_MODES).optional(),
    /**
     * Set when the task is a messaging conversation's Home: the current
     * epoch's task of a DM or group on a channel (never the owner's local
     * connection, never a forum topic's side chat). `kind` is read from the
     * conversation's ids, `epoch` counts its `/new`s. Absent: not one,
     * an ended epoch, or an older owner.
     */
    conversationHome: z
      .object({ kind: z.enum(CONVERSATION_HOME_KINDS), epoch: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export type TaskListRow = z.infer<typeof TaskListRowSchema>;
/** `tasks list`'s answer; `action` names which `tasks` answer it is. */
export const TaskListResultSchema = z
  .object({
    action: z.literal("list"),
    rows: z.array(TaskListRowSchema).max(TASK_NEEDS_LIMIT),
    nextCursor: TaskListCursorSchema.optional(),
    truncated: z.boolean(),
  })
  .strict();
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

/** `tasks prompts`: at most this many follow-ups, oldest first. */
export const TASK_PROMPTS_LIMIT = 50;
/** Each follow-up's text is clipped to this many characters. */
export const TASK_PROMPT_TEXT_MAX = 500;
export const TaskPromptsFiltersSchema = z
  .object({
    taskId: IdSchema,
    /** When set, a task in another workspace is not found. */
    workspaceId: IdSchema.optional(),
  })
  .strict();
export type TaskPromptsFilters = z.infer<typeof TaskPromptsFiltersSchema>;
/**
 * A task's follow-up prompts: its `reply`
 * admissions that carry text, oldest first. The start prompt is the row's own,
 * a system wake has no text, and a refused reply never ran — none is listed.
 */
export const TaskPromptsResultSchema = z
  .object({
    action: z.literal("prompts"),
    items: z.array(z.object({ at: TimestampSchema, text: z.string().max(TASK_PROMPT_TEXT_MAX) }).strict()).max(TASK_PROMPTS_LIMIT),
    /** More follow-ups exist than `items` holds; the newest are left out. */
    truncated: z.boolean(),
  })
  .strict();
export type TaskPromptsResult = z.infer<typeof TaskPromptsResultSchema>;
