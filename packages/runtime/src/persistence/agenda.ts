import {
  AGENDA_MAX_SKIPPED,
  ReminderWhenSchema,
  RoutineTriggerSchema,
  ScheduleSpecSchema,
  fireDisposition,
  isValidTimeZone,
  reminderOccurrenceSeries,
  reminderOccurrences,
  routineTriggerSpec,
  scheduleOccurrences,
  type AgendaInput,
  type AgendaItem,
  type AgendaResult,
  type ReminderWhen,
  type RoutineStatus,
  type ScheduleSpec,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";

/**
 * The agenda's sources: each turns one kind of scheduled work into series of
 * occurrences, and `agendaItems` merges them. Reminders are the third entry in
 * `AGENDA_SOURCES`.
 *
 * A series is lazy and sorted by time, and the merge takes only `limit`
 * items, so a workspace with many daily schedules expands no more
 * occurrences than the answer holds (plus one look-ahead per series).
 */
type AgendaSeries = Iterator<AgendaItem, undefined>;
interface AgendaWindow {
  readonly workspaceId: string;
  readonly now: Date;
  readonly from: Date;
  readonly until: Date;
}
/** A source's series, and the ids of the rows it could not read (left out rather than failing the agenda). */
interface AgendaSourceResult {
  readonly series: readonly AgendaSeries[];
  readonly skipped: readonly string[];
}
export type AgendaSource = (db: Database, window: AgendaWindow) => AgendaSourceResult;

/** More than a 31-day window of hourly occurrences: a bound, not a limit anything reaches. */
const MAX_SERIES_OCCURRENCES = 800;

const title = (text: string): string => text.slice(0, 256);

/**
 * Every occurrence of `spec` in `[from, until)`, each with its cadence, DST-safe
 * through the engine the scheduler claims by. A spec that ends stops its own
 * series there, and one that cannot be read ends its series, not the agenda.
 */
function* specOccurrences(spec: ScheduleSpec, window: AgendaWindow, item: Omit<AgendaItem, "at" | "cadence">): AgendaSeries {
  let count = 0;
  try {
    for (const fire of scheduleOccurrences(spec, new Date(window.from.getTime() - 1), window.until)) {
      if (count >= MAX_SERIES_OCCURRENCES) return undefined;
      count += 1;
      yield { ...item, at: fire.at.toISOString(), cadence: specCadence(spec, fire.time) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function* single(item: AgendaItem): AgendaSeries {
  yield item;
  return undefined;
}

/**
 * The stored fire the scheduler still owes: `next_run_at` already passed, and
 * the scheduler would run it rather than skip it — on time, or within the
 * catch-up window of a `run-once-if-missed-within-6h` row. Only a window that
 * starts now lists it.
 */
function overdue(nextRunAt: string | null, policy: string, window: AgendaWindow, item: Omit<AgendaItem, "at">): AgendaSeries | undefined {
  if (nextRunAt === null || window.from.getTime() > window.now.getTime()) return undefined;
  const at = Date.parse(nextRunAt);
  const late = window.now.getTime() - at;
  if (Number.isNaN(at) || late <= 0) return undefined;
  const disposition = fireDisposition(late);
  if (disposition === "missed" || (disposition === "late" && policy === "skip")) return undefined;
  return single({ ...item, at: new Date(at).toISOString(), overdue: true });
}

/**
 * How one occurrence of `spec` at `time` reads on the agenda: a one-off date is
 * `once`, a monthly or yearly day is `repeat`, and every other spec (weekdays,
 * several times a day, every few hours) is `daily` at that time.
 */
function specCadence(spec: ScheduleSpec, time: string): AgendaItem["cadence"] {
  if (spec.once !== undefined) return { kind: "once" };
  if (spec.monthly !== undefined || spec.yearly !== undefined) {
    return {
      kind: "repeat",
      at: time,
      timezone: spec.timezone,
      ...(spec.monthly === undefined ? {} : { monthly: spec.monthly }),
      ...(spec.yearly === undefined ? {} : { yearly: spec.yearly }),
    };
  }
  return {
    kind: "daily",
    at: time,
    timezone: spec.timezone,
    ...(spec.daysOfWeek === undefined ? {} : { daysOfWeek: [...spec.daysOfWeek] }),
  };
}

/** The cadence a stored fire still owed reads as: its spec's at the wall time the fire is for. */
function dueCadence(spec: ScheduleSpec, at: string): AgendaItem["cadence"] {
  const first = spec.at ?? spec.times?.[0] ?? spec.between?.from ?? "00:00";
  try {
    const fire = scheduleOccurrences(spec, new Date(Date.parse(at) - 1), new Date(Date.parse(at) + 1)).next();
    return specCadence(spec, fire.done === true ? first : fire.value.time);
  } catch {
    return specCadence(spec, first);
  }
}

/** Statuses whose armed triggers still fire; the others never reach a fire even with an enabled row. */
const DORMANT_ROUTINE_STATUSES: readonly RoutineStatus[] = ["draft", "paused", "paused-failures", "completed", "archived"];
const DORMANT_SQL = `r.status NOT IN (${DORMANT_ROUTINE_STATUSES.map(() => "?").join(", ")})`;

/**
 * Routine triggers: the synced trigger (`tavi_routine_triggers.spec_json`),
 * while its schedule row is enabled and it is unconsumed. A `once` trigger's
 * own `runAt` is the time, to the second its schedule row's minute leaves out.
 */
const routineTriggers: AgendaSource = (db, window) => {
  const rows = db
    .prepare(`SELECT r.routine_id, r.name, r.status, t.trigger_id, t.spec_json, s.next_run_at, s.missed_run_policy
      FROM tavi_routine_triggers t
      JOIN tavi_routines r ON r.routine_id = t.routine_id
      JOIN tavi_schedules s ON s.schedule_id = t.schedule_id
      WHERE r.workspace_id = ? AND s.enabled = 1 AND t.consumed = 0 AND ${DORMANT_SQL}
      ORDER BY r.routine_id, t.trigger_id`)
    .all(window.workspaceId, ...DORMANT_ROUTINE_STATUSES) as {
    routine_id: string;
    name: string;
    status: RoutineStatus;
    trigger_id: string;
    spec_json: string;
    next_run_at: string | null;
    missed_run_policy: string;
  }[];
  const series: AgendaSeries[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const parsed = RoutineTriggerSchema.safeParse(safeJson(row.spec_json));
    if (!parsed.success) {
      skipped.push(`${row.routine_id}/${row.trigger_id}`);
      continue;
    }
    const trigger = parsed.data;
    const base = {
      kind: "routine",
      id: row.routine_id,
      triggerId: row.trigger_id,
      title: title(row.name),
      enabled: true,
      status: row.status,
    } as const;
    const spec = routineTriggerSpec(trigger);
    const dueAt = row.next_run_at;
    const late =
      dueAt === null
        ? undefined
        : overdue(dueAt, row.missed_run_policy, window, {
            ...base,
            cadence: spec === undefined ? { kind: "once" } : dueCadence(spec, dueAt),
          });
    if (late !== undefined) series.push(late);
    if (spec === undefined) {
      if (trigger.kind !== "once") continue;
      const at = Date.parse(trigger.runAt);
      if (at >= window.from.getTime() && at < window.until.getTime()) {
        series.push(single({ ...base, at: new Date(at).toISOString(), cadence: { kind: "once" } }));
      }
      continue;
    }
    if (!isValidTimeZone(spec.timezone)) {
      skipped.push(`${row.routine_id}/${row.trigger_id}`);
      continue;
    }
    series.push(specOccurrences(spec, window, base));
  }
  return { series, skipped };
};

/** Plain schedules: enabled `tavi_schedules` rows no routine trigger owns. */
const plainSchedules: AgendaSource = (db, window) => {
  const rows = db
    .prepare(`SELECT s.schedule_id, s.name, s.spec_json, s.next_run_at, s.missed_run_policy FROM tavi_schedules s
      WHERE s.workspace_id = ? AND s.enabled = 1
        AND NOT EXISTS (SELECT 1 FROM tavi_routine_triggers rt WHERE rt.schedule_id = s.schedule_id)
      ORDER BY s.schedule_id`)
    .all(window.workspaceId) as {
    schedule_id: string;
    name: string;
    spec_json: string;
    next_run_at: string | null;
    missed_run_policy: string;
  }[];
  const series: AgendaSeries[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const parsed = ScheduleSpecSchema.safeParse(safeJson(row.spec_json));
    if (!parsed.success || !isValidTimeZone(parsed.data.timezone)) {
      skipped.push(row.schedule_id);
      continue;
    }
    const spec = parsed.data;
    const item = { kind: "schedule", id: row.schedule_id, title: title(row.name), enabled: true } as const;
    const dueAt = row.next_run_at;
    const late = dueAt === null ? undefined : overdue(dueAt, row.missed_run_policy, window, { ...item, cadence: dueCadence(spec, dueAt) });
    if (late !== undefined) series.push(late);
    series.push(specOccurrences(spec, window, item));
  }
  return { series, skipped };
};

/**
 * How one reminder occurrence reads on the agenda: in the cadence routines and
 * schedules use (a `once` time or an event notice is `once`; a `repeat` time
 * on chosen weekdays is `daily` at that time, a monthly or yearly one is
 * `repeat`), and in the reminder's own terms.
 */
function reminderCadence(
  when: ReminderWhen,
  timezone: string,
  occurrence: { readonly notice?: string | undefined; readonly time?: string | undefined },
): Pick<AgendaItem, "cadence" | "reminder"> {
  switch (when.kind) {
    case "once":
      return { cadence: { kind: "once" }, reminder: { cadence: "once" } };
    case "event":
      return {
        cadence: { kind: "once" },
        reminder: {
          cadence: "event",
          eventAt: new Date(when.at).toISOString(),
          ...(occurrence.notice === undefined ? {} : { notice: occurrence.notice }),
        },
      };
    case "repeat": {
      const at = occurrence.time ?? when.times[0] ?? "00:00";
      const pattern = {
        ...(when.monthly === undefined ? {} : { monthly: when.monthly }),
        ...(when.yearly === undefined ? {} : { yearly: when.yearly }),
      };
      const days = when.daysOfWeek === undefined ? {} : { daysOfWeek: [...when.daysOfWeek] };
      return {
        cadence:
          when.monthly !== undefined || when.yearly !== undefined
            ? { kind: "repeat", at, timezone, ...pattern }
            : { kind: "daily", at, timezone, ...days },
        reminder: {
          cadence: "repeat",
          times: [...when.times],
          ...pattern,
          ...(when.until === undefined ? {} : { until: when.until }),
        },
      };
    }
  }
}

/** Map a lazy series, keeping it lazy. */
function* mapSeries<T>(source: Iterable<T>, map: (value: T) => AgendaItem): AgendaSeries {
  for (const value of source) yield map(value);
  return undefined;
}

/**
 * Reminders: each active reminder's fires — its `once` time, an event's
 * notices, each `repeat` time — through the same occurrence math the scheduler
 * claims by, from where its last claim left off; a snoozed fire coming back;
 * and, in a window that starts now, a fire already due that the scheduler has
 * not claimed yet but still will (less than six hours late).
 */
const reminders: AgendaSource = (db, window) => {
  const rows = db
    .prepare(`SELECT reminder_id, principal_id, kind, text, when_json, timezone, next_fire_at, schedule_cursor_at FROM tavi_reminders
      WHERE workspace_id = ? AND status = 'active' ORDER BY reminder_id`)
    .all(window.workspaceId) as {
    reminder_id: string;
    principal_id: string;
    kind: string | null;
    text: string;
    when_json: string;
    timezone: string;
    next_fire_at: string | null;
    schedule_cursor_at: string;
  }[];
  const followUpAt = db.prepare("SELECT notice_offset FROM tavi_reminder_fires WHERE reminder_id = ? AND fire_at = ?");
  const followUps = db.prepare(`SELECT fire_at, notice_offset FROM tavi_reminder_fires
    WHERE reminder_id = ? AND outcome = 'pending' AND fired_at IS NULL AND fire_at >= ? AND fire_at < ? ORDER BY fire_at`);
  const series: AgendaSeries[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const parsed = ReminderWhenSchema.safeParse(safeJson(row.when_json));
    if (!parsed.success || !isValidTimeZone(row.timezone)) {
      skipped.push(row.reminder_id);
      continue;
    }
    const when = parsed.data;
    const base = {
      kind: "reminder",
      id: row.reminder_id,
      title: title(row.text),
      enabled: true,
      principalId: row.principal_id,
      // A to-do's due time: said as a to-do, not a reminder.
      ...(row.kind === "todo" ? { todo: true as const } : {}),
    } as const;
    const item = (at: Date, occurrence: { readonly notice?: string | undefined; readonly time?: string | undefined }): AgendaItem => ({
      ...base,
      at: at.toISOString(),
      ...reminderCadence(when, row.timezone, occurrence),
    });
    if (row.next_fire_at !== null && window.from.getTime() <= window.now.getTime()) {
      const at = Date.parse(row.next_fire_at);
      const late = window.now.getTime() - at;
      if (!Number.isNaN(at) && late > 0 && fireDisposition(late, { missedAtGrace: true }) !== "missed") {
        // The occurrence that is overdue: a scheduled one, else a snoozed fire coming back.
        const due = reminderOccurrences({ when, timezone: row.timezone }, new Date(at), new Date(at + 1))[0];
        const snoozed =
          due === undefined
            ? (followUpAt.get(row.reminder_id, row.next_fire_at) as { notice_offset: string | null } | undefined)
            : undefined;
        const occurrence =
          due === undefined ? { notice: snoozed?.notice_offset ?? undefined } : { notice: due.noticeOffset, time: due.time };
        series.push(single({ ...item(new Date(at), occurrence), overdue: true }));
      }
    }
    for (const followUp of followUps.all(row.reminder_id, window.from.toISOString(), window.until.toISOString()) as {
      fire_at: string;
      notice_offset: string | null;
    }[]) {
      series.push(single(item(new Date(followUp.fire_at), { notice: followUp.notice_offset ?? undefined })));
    }
    const after = Math.max(window.from.getTime() - 1, Date.parse(row.schedule_cursor_at));
    series.push(
      mapSeries(reminderOccurrenceSeries({ when, timezone: row.timezone }, new Date(after), window.until), (fire) =>
        item(fire.at, { notice: fire.noticeOffset, time: fire.time }),
      ),
    );
  }
  return { series, skipped };
};

const AGENDA_SOURCES: readonly AgendaSource[] = [routineTriggers, plainSchedules, reminders];

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Ties at the same instant sort by kind, id and trigger, so the order is stable. */
function before(a: AgendaItem, b: AgendaItem): boolean {
  if (a.at !== b.at) return a.at < b.at;
  if (a.kind !== b.kind) return a.kind < b.kind;
  if (a.id !== b.id) return a.id < b.id;
  return (a.triggerId ?? "") < (b.triggerId ?? "");
}

/**
 * The first `limit` occurrences from every source, sorted by time: overdue
 * fires the scheduler still owes, then `[from, until)`. `truncated` says more
 * occurrences exist in the window; `skipped` names rows that could not be read.
 */
export function agendaItems(db: Database, input: AgendaInput, sources: readonly AgendaSource[] = AGENDA_SOURCES): AgendaResult {
  const window: AgendaWindow = {
    workspaceId: input.workspaceId,
    now: new Date(input.now),
    from: new Date(input.from),
    until: new Date(input.until),
  };
  const heads: { item: AgendaItem; series: AgendaSeries }[] = [];
  const skipped: string[] = [];
  for (const source of sources) {
    const result = source(db, window);
    skipped.push(...result.skipped);
    for (const series of result.series) {
      const first = series.next();
      if (!first.done) heads.push({ item: first.value, series });
    }
  }
  const items: AgendaItem[] = [];
  while (items.length < input.limit && heads.length > 0) {
    let best = 0;
    for (let index = 1; index < heads.length; index += 1) {
      const candidate = heads[index];
      const current = heads[best];
      if (candidate !== undefined && current !== undefined && before(candidate.item, current.item)) best = index;
    }
    const head = heads[best];
    if (head === undefined) break;
    items.push(head.item);
    const next = head.series.next();
    if (next.done) heads.splice(best, 1);
    else head.item = next.value;
  }
  return { items, truncated: heads.length > 0, skipped: skipped.slice(0, AGENDA_MAX_SKIPPED) };
}

/**
 * The earliest stored fires at or after `after`, for a "Coming up" list the
 * agenda's window did not fill: a far-off `once` trigger or reminder still
 * shows. Reads `next_run_at` and a reminder's `next_fire_at` only, so it is
 * two indexed queries and expands nothing.
 */
export function laterFires(
  db: Database,
  workspaceId: string,
  after: string,
  limit: number,
): Pick<AgendaItem, "kind" | "id" | "title" | "at">[] {
  const reminderRows = db
    .prepare(`SELECT reminder_id, text, next_fire_at FROM tavi_reminders
      WHERE workspace_id = ? AND status = 'active' AND next_fire_at >= ? ORDER BY next_fire_at, reminder_id LIMIT ?`)
    .all(workspaceId, after, limit) as { reminder_id: string; text: string; next_fire_at: string }[];
  const later = reminderRows.map((row) => ({
    kind: "reminder" as const,
    id: row.reminder_id,
    title: title(row.text),
    at: new Date(row.next_fire_at).toISOString(),
  }));
  return [...scheduledLaterFires(db, workspaceId, after, limit), ...later]
    .sort((a, b) => (a.at === b.at ? (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1) : a.at < b.at ? -1 : 1))
    .slice(0, limit);
}

function scheduledLaterFires(
  db: Database,
  workspaceId: string,
  after: string,
  limit: number,
): Pick<AgendaItem, "kind" | "id" | "title" | "at">[] {
  const rows = db
    .prepare(`SELECT s.schedule_id, s.name, s.next_run_at, t.routine_id, r.name AS routine_name
      FROM tavi_schedules s
      LEFT JOIN tavi_routine_triggers t ON t.schedule_id = s.schedule_id
      LEFT JOIN tavi_routines r ON r.routine_id = t.routine_id
      WHERE s.workspace_id = ? AND s.enabled = 1 AND s.next_run_at >= ?
        AND (t.routine_id IS NULL OR (t.consumed = 0 AND r.routine_id IS NOT NULL AND ${DORMANT_SQL}))
      ORDER BY s.next_run_at, s.schedule_id LIMIT ?`)
    .all(workspaceId, after, ...DORMANT_ROUTINE_STATUSES, limit) as {
    schedule_id: string;
    name: string;
    next_run_at: string;
    routine_id: string | null;
    routine_name: string | null;
  }[];
  return rows.map((row) =>
    row.routine_id === null
      ? { kind: "schedule", id: row.schedule_id, title: title(row.name), at: new Date(row.next_run_at).toISOString() }
      : {
          kind: "routine",
          id: row.routine_id,
          title: title(row.routine_name ?? row.routine_id),
          at: new Date(row.next_run_at).toISOString(),
        },
  );
}
