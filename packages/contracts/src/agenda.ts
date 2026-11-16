import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import { SCHEDULE_TIME_PATTERN } from "./schedules.js";
import { ROUTINE_STATUSES } from "./routines.js";
import { ReminderMonthlySchema, ReminderYearlySchema } from "./reminders.js";

/**
 * `schedules agenda`: every occurrence of the
 * workspace's scheduled work in a window, merged and sorted — routine
 * triggers, plain schedules and reminders.
 *
 * Recurring cadences are expanded to each occurrence in the window, not just
 * the next one; a `once` trigger contributes its single time while unconsumed.
 * A reminder contributes each fire: its `once` time, an event's notices, or
 * each `repeat` time. Only enabled items (active reminders) are listed.
 *
 * Each occurrence reads in one cadence vocabulary: a one-off (a `once`
 * trigger or date, a reminder's `once` time or event notice) is `once`; a
 * time on chosen weekdays or every day (several times a day, or every few
 * hours, each at its own time) is `daily` at that time; one on a monthly or
 * yearly day is `repeat`. A reminder also carries its own terms in `reminder`.
 */

export const AGENDA_DEFAULT_DAYS = 7;
export const AGENDA_MAX_DAYS = 31;
export const AGENDA_DEFAULT_LIMIT = 100;
export const AGENDA_MAX_LIMIT = 200;
/** At most this many unreadable rows are named in one answer. */
export const AGENDA_MAX_SKIPPED = 50;

/** An instant as a caller may write it: UTC or with an offset. */
const AgendaInstantSchema = z.iso.datetime({ offset: true });

/** The IPC payload fields `schedules agenda` reads (`SchedulesPayloadSchema`). */
export const AgendaWindowFieldsSchema = z.object({
  /** Absent: now. A `from` in the past is read as now: the agenda lists what is still to come. */
  from: AgendaInstantSchema.optional(),
  /** Absent: `from` plus `AGENDA_DEFAULT_DAYS`. At most `AGENDA_MAX_DAYS` after `from`. */
  until: AgendaInstantSchema.optional(),
  /** Absent: `AGENDA_DEFAULT_LIMIT`. */
  limit: z.number().int().min(1).max(AGENDA_MAX_LIMIT).optional(),
});

export const AgendaCadenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("daily"),
    at: z.string().regex(SCHEDULE_TIME_PATTERN),
    timezone: z.string().min(1).max(64),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  }),
  z.strictObject({ kind: z.literal("once") }),
  /** A monthly or yearly repeat (a schedule's, a trigger's or a reminder's), at one of its times. */
  z.strictObject({
    kind: z.literal("repeat"),
    at: z.string().regex(SCHEDULE_TIME_PATTERN),
    timezone: z.string().min(1).max(64),
    monthly: ReminderMonthlySchema.optional(),
    yearly: ReminderYearlySchema.optional(),
  }),
]);
export type AgendaCadence = z.infer<typeof AgendaCadenceSchema>;

export const AgendaItemSchema = z.strictObject({
  kind: z.enum(["routine", "schedule", "reminder"]),
  /** The routine's id for `routine`, the schedule's for `schedule`, the reminder's for `reminder`. */
  id: IdSchema,
  /** The routine trigger this occurrence comes from. */
  triggerId: IdSchema.optional(),
  title: z.string().min(1).max(256),
  /** The occurrence, ISO-8601 UTC. */
  at: TimestampSchema,
  cadence: AgendaCadenceSchema,
  enabled: z.boolean(),
  /** The routine's status, for `routine` items. */
  status: z.enum(ROUTINE_STATUSES).optional(),
  /** The person a `reminder` is for. */
  principalId: IdSchema.optional(),
  /** A `reminder` that is a to-do's due time (its `id` the to-do's): it opens the to-do list, not a reminder page. */
  todo: z.literal(true).optional(),
  /** How a `reminder` fires: its own cadence, and for an event the notice this occurrence is. */
  reminder: z
    .strictObject({
      cadence: z.enum(["once", "event", "repeat"]),
      /** The event's time, for an `event`. */
      eventAt: TimestampSchema.optional(),
      /** The notice this occurrence is (`-1d@20:00`), for an `event`. */
      notice: z.string().min(1).max(16).optional(),
      /** Every time of day, for a `repeat`. */
      times: z.array(z.string().regex(SCHEDULE_TIME_PATTERN)).min(1).max(6).optional(),
      /** The day each month, for a `repeat` that is monthly. */
      monthly: ReminderMonthlySchema.optional(),
      /** The day each year, for a `repeat` that is yearly. */
      yearly: ReminderYearlySchema.optional(),
      /** The last local date, for a `repeat` that ends. */
      until: z.iso.date().optional(),
    })
    .optional(),
  /**
   * A stored fire whose time already passed and that the scheduler still owes
   * (on time, or within a `run-once-if-missed-within-6h` catch-up): `at` is
   * that past time, and it sorts first. Only a window that starts now has one.
   */
  overdue: z.literal(true).optional(),
});
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const AgendaAnswerSchema = z.strictObject({
  /** The workspace's effective zone (the owner host's while none is set). */
  timezone: z.string().min(1).max(64),
  /** Sorted by `at`. */
  items: z.array(AgendaItemSchema).max(AGENDA_MAX_LIMIT),
  /** More occurrences fall in the window than `limit` let through. */
  truncated: z.boolean(),
  /** Rows left out because their stored spec or zone could not be read: a schedule id, or `routineId/triggerId`. */
  skipped: z.array(z.string().min(1).max(300)).max(AGENDA_MAX_SKIPPED),
});
export type AgendaAnswer = z.infer<typeof AgendaAnswerSchema>;
/** What the repository answers: the answer without the zone, which the caller resolves. */
export type AgendaResult = Omit<AgendaAnswer, "timezone">;

/** The repository's input: a resolved window. `from` is already at least `now`. */
export const AgendaInputSchema = z.strictObject({
  workspaceId: IdSchema,
  /** The caller's clock: what counts as overdue. */
  now: TimestampSchema,
  from: TimestampSchema,
  until: TimestampSchema,
  limit: z.number().int().min(1).max(AGENDA_MAX_LIMIT),
});
export type AgendaInput = z.infer<typeof AgendaInputSchema>;

/**
 * The window a payload asks for, resolved against `now`: `from` defaults to
 * now and is never earlier than it; `until` defaults to `from` plus
 * `AGENDA_DEFAULT_DAYS`, must be after `from` and at most `AGENDA_MAX_DAYS`
 * after it. Returns an error message for a window that breaks those rules.
 */
export function resolveAgendaWindow(
  fields: { readonly from?: string | undefined; readonly until?: string | undefined; readonly limit?: number | undefined },
  now: Date,
): { readonly from: string; readonly until: string; readonly limit: number } | { readonly error: string } {
  const requested = fields.from === undefined ? now.getTime() : Date.parse(fields.from);
  const until = fields.until === undefined ? requested + AGENDA_DEFAULT_DAYS * 86_400_000 : Date.parse(fields.until);
  if (Number.isNaN(requested) || Number.isNaN(until)) return { error: "agenda from/until must be ISO-8601 instants" };
  if (until <= requested) return { error: "agenda until must be after from" };
  if (until - requested > AGENDA_MAX_DAYS * 86_400_000) return { error: `an agenda window is at most ${AGENDA_MAX_DAYS} days` };
  const from = Math.max(requested, now.getTime());
  return {
    from: new Date(from).toISOString(),
    until: new Date(Math.max(until, from)).toISOString(),
    limit: fields.limit ?? AGENDA_DEFAULT_LIMIT,
  };
}
