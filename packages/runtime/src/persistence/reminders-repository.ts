import { createHash } from "node:crypto";

import type { ReminderRepositoryPort } from "./internal-contracts.js";
import { z } from "zod";
import {
  AcknowledgeReminderFireInputSchema,
  ContentLabelSchema,
  UNTRUSTED_UNKNOWN_SOURCE,
  isTrustedPublic,
  normalizeLabel,
  type ContentLabel,
  ClaimDueRemindersInputSchema,
  CreateReminderInputSchema,
  ListReminderFiresInputSchema,
  ListRemindersInputSchema,
  REMINDER_CLAIM_LEASE_MS,
  REMINDER_MAX_ACTIVE_PER_WORKSPACE,
  REMINDER_MAX_MISSED_RECORDED,
  REMINDER_RETRY_WINDOW_MS,
  RecordReminderOutcomeInputSchema,
  ReminderSchema,
  CreateTodoInputSchema,
  DEFAULT_TODO_LIST,
  ListTodosInputSchema,
  REMINDER_MAX_AHEAD_DAYS,
  RemoveTodoInputSchema,
  TODO_MAX_OPEN_PER_WORKSPACE,
  TodoSchema,
  UpdateTodoInputSchema,
  todoDueIsTime,
  type CreateTodoResult,
  type ListTodosResult,
  type ReminderWhen,
  type Todo,
  type TodoStatus,
  SnoozeReminderInputSchema,
  TaviError,
  TransitionReminderInputSchema,
  UpdateReminderInputSchema,
  checkReminderSchedule,
  nextReminderFire,
  normalizeReminderWhen,
  reminderFireDisposition,
  reminderOccurrenceSeries,
  type AcknowledgeReminderFireInput,
  type ClaimDueRemindersInput,
  type ClaimDueRemindersResult,
  type ClaimedReminderFire,
  type CreateReminderInput,
  type CreateReminderResult,
  type CreateTodoInput,
  type ListTodosInput,
  type RemoveTodoInput,
  type UpdateTodoInput,
  type ListReminderFiresInput,
  type ListRemindersInput,
  type ListRemindersResult,
  type RecordReminderOutcomeInput,
  type Reminder,
  type ReminderFire,
  type ReminderFireView,
  type ReminderOccurrence,
  type ReminderStatus,
  type SnoozeReminderInput,
  type SnoozeReminderResult,
  type TransitionReminderInput,
  type UpdateReminderInput,
  parseOrThrow,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";

interface ReminderRow {
  readonly reminder_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly text: string;
  readonly prompt: string | null;
  readonly when_json: string;
  readonly timezone: string;
  readonly deliver_to_json: string;
  readonly status: string;
  readonly next_fire_at: string | null;
  readonly last_fired_at: string | null;
  readonly schedule_cursor_at: string;
  readonly created_by: string;
  readonly origin_task_id: string | null;
  readonly operation_key: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly label_json: string | null;
  readonly kind: string;
  readonly todo_status: string | null;
  readonly list: string | null;
  readonly notes: string | null;
  readonly due: string | null;
  readonly completed_at: string | null;
}

interface FireRow {
  readonly reminder_id: string;
  readonly fire_at: string;
  readonly occurrence: string;
  readonly notice_offset: string | null;
  readonly fired_at: string | null;
  readonly outcome: string;
  readonly late: number;
  readonly task_id: string | null;
  readonly acknowledged_at: string | null;
  readonly snoozed_until: string | null;
  readonly attempts: number;
  readonly retry_at: string | null;
  readonly retry_until: string | null;
  readonly token: string | null;
}

/** The token a fire's buttons carry: short, unguessable without the ids, and the same for the same fire. */
function fireToken(reminderId: string, fireAt: string): string {
  return createHash("sha256").update(`${reminderId}\u0000${fireAt}`).digest("base64url").slice(0, 16);
}

/** What the repository needs of the store: its handle, and a write-locked transaction for every read-compare-write. */
export interface ReminderStore {
  readonly handle: Database;
  transactionImmediate<T>(fn: () => T): T;
}

const iso = (value: string | Date): string => new Date(value).toISOString();

function parsed<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  // The first issue's own message: the schemas word theirs for a person
  // ("Reminders can repeat at most 6 times a day").
  return parseOrThrow(schema, input, (_, error) => error.issues[0]?.message ?? `The ${what} request is not valid`);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A stored label: one that no longer parses reads as untrusted `unknown-source` (fail safe). */
function storedLabel(text: string): ContentLabel {
  const result = ContentLabelSchema.safeParse(json(text));
  return result.success ? result.data : UNTRUSTED_UNKNOWN_SOURCE;
}

/** What `label_json` stores: the canonical label when untrusted or private, else nothing — absent is the one encoding of trusted and public. */
function labelColumn(label: ContentLabel | undefined): string | null {
  return label === undefined || isTrustedPublic(label) ? null : JSON.stringify(normalizeLabel(label));
}

/** A stored row as the contract's record, or undefined when it cannot be read. */
function tryReminder(row: ReminderRow): Reminder | undefined {
  const result = ReminderSchema.safeParse({
    reminderId: row.reminder_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    text: row.text,
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    when: json(row.when_json),
    timezone: row.timezone,
    deliverTo: json(row.deliver_to_json),
    status: row.status,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    createdBy: row.created_by,
    ...(row.origin_task_id === null ? {} : { originTaskId: row.origin_task_id }),
    operationKey: row.operation_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.kind === "todo" ? { kind: "todo" } : {}),
    ...(row.label_json === null ? {} : { label: storedLabel(row.label_json) }),
  });
  return result.success ? result.data : undefined;
}

/** A stored to-do row as the contract's record, or undefined when it is not one or cannot be read. */
function tryTodo(row: ReminderRow): Todo | undefined {
  if (row.kind !== "todo") return undefined;
  const result = TodoSchema.safeParse({
    todoId: row.reminder_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    text: row.text,
    list: row.list ?? DEFAULT_TODO_LIST,
    ...(row.notes === null ? {} : { notes: row.notes }),
    ...(row.due === null ? {} : { due: row.due }),
    status: row.todo_status ?? "open",
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    remindAt: row.status === "active" ? row.next_fire_at : null,
    timezone: row.timezone,
    deliverTo: json(row.deliver_to_json),
    createdBy: row.created_by,
    ...(row.origin_task_id === null ? {} : { originTaskId: row.origin_task_id }),
    operationKey: row.operation_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.label_json === null ? {} : { label: storedLabel(row.label_json) }),
  });
  return result.success ? result.data : undefined;
}

/**
 * What a to-do's reminder part is, as of `now`: a due time still to come
 * fires once then (and must be at most two years ahead); anything else — no
 * due, a due date, a time already past, a done to-do — has nothing to fire.
 */
function todoSchedule(
  due: string | undefined,
  status: TodoStatus,
  now: string,
  createdAt: string,
): { readonly when: ReminderWhen; readonly status: ReminderStatus; readonly nextFireAt: string | null } {
  if (due !== undefined && todoDueIsTime(due) && status === "open" && Date.parse(due) > Date.parse(now)) {
    const when: ReminderWhen = { kind: "once", at: iso(due) };
    if (Date.parse(due) > Date.parse(now) + REMINDER_MAX_AHEAD_DAYS * 86_400_000)
      throw new TaviError("INVALID_INPUT", "A to-do's due time can be at most 2 years ahead");
    return { when, status: "active", nextFireAt: iso(due) };
  }
  return { when: { kind: "once", at: iso(createdAt) }, status: "done", nextFireAt: null };
}

/** A due as stored: a date as written, a time in UTC. */
const storedDue = (due: string): string => (todoDueIsTime(due) ? iso(due) : due);

function readReminder(row: ReminderRow): Reminder {
  const reminder = tryReminder(row);
  if (reminder === undefined) {
    throw new TaviError("INTERNAL", `Reminder ${row.reminder_id} has an unreadable record; cancel it or restore a backup`, {
      details: { reminderId: row.reminder_id },
    });
  }
  return reminder;
}

function toFire(row: FireRow): ReminderFire {
  return {
    reminderId: row.reminder_id,
    fireAt: row.fire_at,
    firedAt: row.fired_at,
    outcome: row.outcome as ReminderFire["outcome"],
    occurrence: row.occurrence as ReminderFire["occurrence"],
    ...(row.notice_offset === null ? {} : { noticeOffset: row.notice_offset }),
    ...(row.late === 1 ? { late: true } : {}),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
    ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
    ...(row.attempts > 0 ? { attempts: row.attempts } : {}),
    ...(row.retry_at === null ? {} : { retryAt: row.retry_at }),
    ...(row.retry_until === null ? {} : { retryUntil: row.retry_until }),
    ...(row.token === null ? {} : { token: row.token }),
  };
}

const CursorSchema = z.strictObject({ c: z.string().max(64), i: z.string().max(128) });

function encodeCursor(createdAt: string, reminderId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: reminderId })).toString("base64url");
}

function decodeCursor(cursor: string): { readonly c: string; readonly i: string } {
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new TaviError("INVALID_INPUT", "Invalid reminders cursor; list again from the start");
  }
}

/** A write's new `updatedAt`: never equal to the one it replaces, so a compare-and-set can always tell them apart. */
function nextStamp(now: string, previous: string): string {
  return Date.parse(now) > Date.parse(previous) ? now : new Date(Date.parse(previous) + 1).toISOString();
}

/**
 * Reminders and their fires.
 *
 * Every write is one `transactionImmediate`, for the reason
 * `SqliteWorkspaceSettingsRepository` gives: a read-compare-write inside a
 * deferred transaction is not atomic against another writer under WAL. That
 * is also what makes `claimDue` exactly-once: two claims serialize, and the
 * second finds the schedule cursor already moved and the fire rows present.
 */
export class SqliteReminderRepository implements ReminderRepositoryPort {
  readonly #store: ReminderStore;

  constructor(store: ReminderStore) {
    this.#store = store;
  }

  get #db(): Database {
    return this.#store.handle;
  }

  create(input: CreateReminderInput): CreateReminderResult {
    const request = parsed(CreateReminderInputSchema, input, "reminder");
    const now = iso(request.now);
    return this.#store.transactionImmediate(() => {
      const retried = this.#db
        .prepare("SELECT * FROM tavi_reminders WHERE workspace_id = ? AND principal_id = ? AND operation_key = ?")
        .get(request.workspaceId, request.principalId, request.operationKey) as ReminderRow | undefined;
      if (retried?.kind === "todo") throw new TaviError("CONFLICT", "That operation key already made a to-do, not a reminder");
      if (retried !== undefined) return { reminder: readReminder(retried), created: false, skippedNotices: [] };

      const when = normalizeReminderWhen(request.when);
      const check = checkReminderSchedule({ when, timezone: request.timezone }, new Date(now));
      const first = check.first.at.toISOString();

      // An exact duplicate — the same person, text and first fire — is the
      // reminder already made, typically a model asking twice in other words.
      const candidates = this.#db
        .prepare(
          "SELECT * FROM tavi_reminders WHERE workspace_id = ? AND principal_id = ? AND text = ? AND status IN ('active', 'paused') AND kind = 'reminder'",
        )
        .all(request.workspaceId, request.principalId, request.text) as ReminderRow[];
      for (const row of candidates) {
        const existing = tryReminder(row);
        if (existing !== undefined && nextReminderFire(existing, new Date(now))?.at.toISOString() === first) {
          return { reminder: existing, created: false, duplicate: true, skippedNotices: [] };
        }
      }
      this.#assertRoomFor(request.workspaceId);
      this.#db
        .prepare(
          `INSERT INTO tavi_reminders (reminder_id, workspace_id, principal_id, text, prompt, when_json, timezone, deliver_to_json,
             status, next_fire_at, last_fired_at, schedule_cursor_at, created_by, origin_task_id, operation_key, created_at, updated_at, label_json)
           VALUES (@reminderId, @workspaceId, @principalId, @text, @prompt, @when, @timezone, @deliverTo,
             'active', @first, NULL, @now, @createdBy, @originTaskId, @operationKey, @now, @now, @label)`,
        )
        .run({
          reminderId: request.reminderId,
          workspaceId: request.workspaceId,
          principalId: request.principalId,
          text: request.text,
          prompt: request.prompt ?? null,
          when: JSON.stringify(when),
          timezone: request.timezone,
          deliverTo: JSON.stringify(request.deliverTo),
          first,
          createdBy: request.createdBy,
          originTaskId: request.originTaskId ?? null,
          operationKey: request.operationKey,
          now,
          label: labelColumn(request.label),
        });
      return { reminder: this.#require(request.reminderId), created: true, skippedNotices: [...check.skippedNotices] };
    });
  }

  get(reminderId: string): Reminder | undefined {
    const row = this.#db.prepare("SELECT * FROM tavi_reminders WHERE reminder_id = ?").get(reminderId) as ReminderRow | undefined;
    return row === undefined ? undefined : readReminder(row);
  }

  list(input: ListRemindersInput): ListRemindersResult {
    const request = parsed(ListRemindersInputSchema, input, "reminders list");
    // A to-do is listed by `listTodos`, never among reminders.
    const filters = ["workspace_id = ?", "kind = 'reminder'"];
    const params: (string | number)[] = [request.workspaceId];
    if (request.principalId !== undefined) {
      filters.push("principal_id = ?");
      params.push(request.principalId);
    }
    if (request.originTaskId !== undefined) {
      filters.push("origin_task_id = ?");
      params.push(request.originTaskId);
    }
    if (request.statuses !== undefined) {
      filters.push(`status IN (${request.statuses.map(() => "?").join(", ")})`);
      params.push(...request.statuses);
    }
    if (request.cursor !== undefined) {
      const cursor = decodeCursor(request.cursor);
      filters.push("(created_at < ? OR (created_at = ? AND reminder_id < ?))");
      params.push(cursor.c, cursor.c, cursor.i);
    }
    const rows = this.#db
      .prepare(`SELECT * FROM tavi_reminders WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, reminder_id DESC LIMIT ?`)
      .all(...params, request.limit + 1) as ReminderRow[];
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);
    return {
      // A row that cannot be read is left out of a list rather than failing it;
      // `get` names it.
      reminders: page.map(tryReminder).filter((reminder): reminder is Reminder => reminder !== undefined),
      ...(rows.length > request.limit && last !== undefined ? { nextCursor: encodeCursor(last.created_at, last.reminder_id) } : {}),
    };
  }

  update(input: UpdateReminderInput): Reminder {
    const request = parsed(UpdateReminderInputSchema, input, "reminder update");
    const now = iso(request.now);
    return this.#store.transactionImmediate(() => {
      const current = this.#current(request.reminderId, request.expectedUpdatedAt);
      if (current.kind === "todo") throw new TaviError("CONFLICT", "That is a to-do; change it as a to-do");
      if (current.status === "cancelled") throw new TaviError("CONFLICT", "A cancelled reminder cannot be changed; make a new one");
      const rescheduled = request.when !== undefined || request.timezone !== undefined;
      const when = request.when === undefined ? current.when : normalizeReminderWhen(request.when);
      const timezone = request.timezone ?? current.timezone;
      let status: ReminderStatus = current.status;
      let nextFireAt = current.nextFireAt;
      let cursor: string | undefined;
      if (rescheduled) {
        const check = checkReminderSchedule({ when, timezone }, new Date(now));
        // The old schedule's snoozed fires belong to times that no longer apply.
        this.#db
          .prepare("DELETE FROM tavi_reminder_fires WHERE reminder_id = ? AND outcome = 'pending' AND fired_at IS NULL")
          .run(current.reminderId);
        cursor = now;
        if (status === "done") {
          this.#assertRoomFor(current.workspaceId);
          status = "active";
        }
        nextFireAt = status === "active" ? check.first.at.toISOString() : null;
      }
      const prompt = request.prompt === undefined ? (current.prompt ?? null) : request.prompt;
      this.#db
        .prepare(
          `UPDATE tavi_reminders SET text = @text, prompt = @prompt, when_json = @when, timezone = @timezone, deliver_to_json = @deliverTo,
             status = @status, next_fire_at = @nextFireAt, schedule_cursor_at = COALESCE(@cursor, schedule_cursor_at), updated_at = @updatedAt,
             label_json = CASE WHEN @relabel = 1 THEN @label ELSE label_json END
           WHERE reminder_id = @reminderId`,
        )
        .run({
          reminderId: current.reminderId,
          text: request.text ?? current.text,
          prompt,
          when: JSON.stringify(when),
          timezone,
          deliverTo: JSON.stringify(request.deliverTo ?? current.deliverTo),
          status,
          nextFireAt,
          cursor: cursor ?? null,
          updatedAt: nextStamp(now, current.updatedAt),
          relabel: request.label === undefined ? 0 : 1,
          label: labelColumn(request.label),
        });
      return this.#require(current.reminderId);
    });
  }

  transition(input: TransitionReminderInput): Reminder {
    const request = parsed(TransitionReminderInputSchema, input, "reminder change");
    const now = iso(request.now);
    return this.#store.transactionImmediate(() => {
      const current = this.#current(request.reminderId, request.expectedUpdatedAt);
      if (current.kind === "todo") throw new TaviError("CONFLICT", "That is a to-do; change it as a to-do");
      const set = (status: ReminderStatus, nextFireAt: string | null, cursor?: string): Reminder => {
        this.#db
          .prepare(
            `UPDATE tavi_reminders SET status = ?, next_fire_at = ?, schedule_cursor_at = COALESCE(?, schedule_cursor_at), updated_at = ?
             WHERE reminder_id = ?`,
          )
          .run(status, nextFireAt, cursor ?? null, nextStamp(now, current.updatedAt), current.reminderId);
        return this.#require(current.reminderId);
      };
      switch (request.action) {
        case "cancel":
          if (current.status === "cancelled") return current;
          this.#db
            .prepare("DELETE FROM tavi_reminder_fires WHERE reminder_id = ? AND outcome = 'pending' AND fired_at IS NULL")
            .run(current.reminderId);
          return set("cancelled", null);
        case "pause":
          if (current.status === "paused") return current;
          if (current.status !== "active")
            throw new TaviError("CONFLICT", `Only an active reminder can be paused; this one is ${current.status}`);
          return set("paused", null);
        case "resume": {
          if (current.status === "active") return current;
          if (current.status !== "paused")
            throw new TaviError("CONFLICT", `Only a paused reminder can be resumed; this one is ${current.status}`);
          this.#assertRoomFor(current.workspaceId);
          // What fell due while it was paused is not sent: the schedule resumes
          // from now, and a snoozed fire that came due meanwhile is missed.
          this.#db
            .prepare(
              "UPDATE tavi_reminder_fires SET outcome = 'missed' WHERE reminder_id = ? AND outcome = 'pending' AND fired_at IS NULL AND fire_at <= ?",
            )
            .run(current.reminderId, now);
          const next = this.#nextFireAt(current, new Date(now));
          return next === null ? set("done", null, now) : set("active", next, now);
        }
      }
    });
  }

  snooze(input: SnoozeReminderInput): SnoozeReminderResult {
    const request = parsed(SnoozeReminderInputSchema, input, "reminder snooze");
    const now = iso(request.now);
    return this.#store.transactionImmediate(() => {
      const current = this.#current(request.reminderId);
      if (current.status === "cancelled" || current.status === "paused") {
        throw new TaviError("CONFLICT", `That reminder is ${current.status}; resume it before snoozing`);
      }
      const row = (
        request.fireAt === undefined
          ? this.#db
              .prepare(`SELECT * FROM tavi_reminder_fires WHERE reminder_id = ? AND outcome IN ('delivered', 'delivered-in-app')
                AND acknowledged_at IS NULL ORDER BY fire_at DESC LIMIT 1`)
              .get(current.reminderId)
          : this.#db
              .prepare("SELECT * FROM tavi_reminder_fires WHERE reminder_id = ? AND fire_at = ?")
              .get(current.reminderId, iso(request.fireAt))
      ) as FireRow | undefined;
      if (row === undefined) throw new TaviError("NOT_FOUND", "That reminder has not fired, so there is nothing to snooze");
      if (row.outcome !== "delivered" && row.outcome !== "delivered-in-app") {
        throw new TaviError("CONFLICT", `Only a delivered reminder can be snoozed; that one is ${row.outcome}`);
      }
      const until = new Date(Date.parse(now) + request.minutes * 60_000).toISOString();
      this.#db
        .prepare(`UPDATE tavi_reminder_fires SET outcome = 'snoozed', snoozed_until = ?, acknowledged_at = COALESCE(acknowledged_at, ?)
          WHERE reminder_id = ? AND fire_at = ?`)
        .run(until, now, row.reminder_id, row.fire_at);
      this.#db
        .prepare(`INSERT INTO tavi_reminder_fires (reminder_id, fire_at, occurrence, notice_offset, fired_at, outcome, token)
          VALUES (?, ?, ?, ?, NULL, 'pending', ?) ON CONFLICT (reminder_id, fire_at) DO NOTHING`)
        .run(row.reminder_id, until, row.occurrence, row.notice_offset, fireToken(row.reminder_id, until));
      // A snooze brings a finished reminder back until its follow-up fires.
      const next = this.#nextFireAt(
        { ...current, status: "active" },
        new Date(current.status === "done" ? now : this.#cursorOf(current.reminderId)),
      );
      this.#db
        .prepare("UPDATE tavi_reminders SET status = 'active', next_fire_at = ?, updated_at = ? WHERE reminder_id = ?")
        .run(next, nextStamp(now, current.updatedAt), current.reminderId);
      return {
        reminder: this.#require(current.reminderId),
        snoozed: this.#fire(row.reminder_id, row.fire_at),
        followUp: this.#fire(row.reminder_id, until),
      };
    });
  }

  acknowledge(input: AcknowledgeReminderFireInput): ReminderFire {
    const request = parsed(AcknowledgeReminderFireInputSchema, input, "reminder acknowledgement");
    const fireAt = iso(request.fireAt);
    return this.#store.transactionImmediate(() => {
      const row = this.#db
        .prepare("SELECT * FROM tavi_reminder_fires WHERE reminder_id = ? AND fire_at = ?")
        .get(request.reminderId, fireAt) as FireRow | undefined;
      if (row === undefined) throw new TaviError("NOT_FOUND", `Reminder ${request.reminderId} has no fire at ${fireAt}`);
      if (row.acknowledged_at === null) {
        this.#db
          .prepare("UPDATE tavi_reminder_fires SET acknowledged_at = ? WHERE reminder_id = ? AND fire_at = ?")
          .run(iso(request.now), request.reminderId, fireAt);
      }
      return this.#fire(request.reminderId, fireAt);
    });
  }

  fires(input: ListReminderFiresInput): readonly ReminderFireView[] {
    const request = parsed(ListReminderFiresInputSchema, input, "reminder fires");
    const filters = ["r.workspace_id = ?"];
    const params: (string | number)[] = [request.workspaceId];
    if (request.reminderId !== undefined) {
      filters.push("f.reminder_id = ?");
      params.push(request.reminderId);
    }
    if (request.unseen === true) filters.push("f.outcome = 'delivered-in-app' AND f.acknowledged_at IS NULL");
    const rows = this.#db
      .prepare(`SELECT f.*, r.workspace_id, r.principal_id, r.text FROM tavi_reminder_fires f
        JOIN tavi_reminders r ON r.reminder_id = f.reminder_id
        WHERE ${filters.join(" AND ")} ORDER BY f.fire_at DESC, f.reminder_id LIMIT ?`)
      .all(...params, request.limit) as (FireRow & { workspace_id: string; principal_id: string; text: string })[];
    return rows.map((row) => ({ ...toFire(row), workspaceId: row.workspace_id, principalId: row.principal_id, text: row.text }));
  }

  claimDue(input: ClaimDueRemindersInput): ClaimDueRemindersResult {
    const request = parsed(ClaimDueRemindersInputSchema, input, "reminder claim");
    const now = iso(request.now);
    const nowMs = Date.parse(now);
    return this.#store.transactionImmediate(() => {
      const claimed: ClaimedReminderFire[] = [];
      let missed = 0;
      const readable = new Map<string, Reminder>();
      const reminderOf = (reminderId: string): Reminder | undefined => {
        if (!readable.has(reminderId)) {
          const row = this.#db.prepare("SELECT * FROM tavi_reminders WHERE reminder_id = ?").get(reminderId) as ReminderRow | undefined;
          const reminder = row === undefined ? undefined : tryReminder(row);
          if (reminder !== undefined) readable.set(reminderId, reminder);
        }
        return readable.get(reminderId);
      };
      /**
       * Claim an existing row for delivery, or record it missed: by how late it
       * is now. A retried delivery was already due to be said, so it is never
       * missed (its retry window ends in the app), and it keeps the lateness it
       * was first claimed with.
       */
      const claimRow = (row: FireRow): void => {
        const reminder = reminderOf(row.reminder_id);
        if (reminder === undefined) return;
        const disposition = row.retry_at !== null ? "late" : reminderFireDisposition(nowMs - Date.parse(row.fire_at));
        if (disposition === "missed") {
          this.#db
            .prepare("UPDATE tavi_reminder_fires SET outcome = 'missed' WHERE reminder_id = ? AND fire_at = ?")
            .run(row.reminder_id, row.fire_at);
          missed += 1;
          return;
        }
        const late = row.retry_at !== null ? row.late : disposition === "late" ? 1 : 0;
        this.#db
          .prepare("UPDATE tavi_reminder_fires SET fired_at = ?, late = ?, retry_at = NULL WHERE reminder_id = ? AND fire_at = ?")
          .run(now, late, row.reminder_id, row.fire_at);
        claimed.push({ reminder, fire: this.#fire(row.reminder_id, row.fire_at), late: late === 1 });
      };

      // A claim whose outcome never arrived: the owner stopped mid-delivery.
      const lease = new Date(nowMs - REMINDER_CLAIM_LEASE_MS).toISOString();
      const stale = this.#db
        .prepare(`SELECT f.* FROM tavi_reminder_fires f JOIN tavi_reminders r ON r.reminder_id = f.reminder_id
          WHERE f.outcome = 'pending' AND f.fired_at IS NOT NULL AND f.fired_at <= ? AND f.retry_at IS NULL AND r.status IN ('active', 'done')
          AND NOT (r.kind = 'todo' AND r.todo_status = 'done')
          ORDER BY f.fire_at, f.reminder_id LIMIT ?`)
        .all(lease, request.limit) as FireRow[];
      for (const row of stale) claimRow(row);

      // Deliveries a chat refused, due to be tried again.
      const retries = this.#db
        .prepare(`SELECT f.* FROM tavi_reminder_fires f JOIN tavi_reminders r ON r.reminder_id = f.reminder_id
          WHERE f.outcome = 'pending' AND f.retry_at IS NOT NULL AND f.retry_at <= ? AND r.status IN ('active', 'done')
          AND NOT (r.kind = 'todo' AND r.todo_status = 'done')
          ORDER BY f.retry_at, f.reminder_id LIMIT ?`)
        .all(now, request.limit) as FireRow[];
      for (const row of retries) claimRow(row);

      const due = this.#db
        .prepare(
          "SELECT * FROM tavi_reminders WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at, reminder_id",
        )
        .all(now) as ReminderRow[];
      for (const row of due) {
        if (claimed.length >= request.limit) break;
        // An unreadable row is left for `get` to name; it must not stop the others.
        const reminder = tryReminder(row);
        if (reminder === undefined) continue;
        readable.set(reminder.reminderId, reminder);

        // The schedule's occurrences since the last claim, sorted into those to
        // deliver (on time or late) and those too late to send.
        const deliver: { occurrence: ReminderOccurrence; late: boolean }[] = [];
        const lost: ReminderOccurrence[] = [];
        for (const occurrence of reminderOccurrenceSeries(reminder, new Date(row.schedule_cursor_at), new Date(nowMs + 1))) {
          const disposition = reminderFireDisposition(nowMs - occurrence.at.getTime());
          if (disposition === "missed") lost.push(occurrence);
          else deliver.push({ occurrence, late: disposition === "late" });
        }
        // A repeating reminder never sends a backlog: the latest occurrence at most.
        if (reminder.when.kind === "repeat" && deliver.length > 1)
          lost.push(...deliver.splice(0, deliver.length - 1).map((entry) => entry.occurrence));
        lost.sort((a, b) => a.at.getTime() - b.at.getTime());
        const insert = this.#db.prepare(
          `INSERT INTO tavi_reminder_fires (reminder_id, fire_at, occurrence, notice_offset, fired_at, outcome, late, token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reminder_id, fire_at) DO NOTHING`,
        );
        for (const occurrence of lost.slice(-REMINDER_MAX_MISSED_RECORDED)) {
          const fireAt = occurrence.at.toISOString();
          if (
            insert.run(
              reminder.reminderId,
              fireAt,
              occurrence.occurrence,
              occurrence.noticeOffset ?? null,
              null,
              "missed",
              0,
              fireToken(reminder.reminderId, fireAt),
            ).changes > 0
          )
            missed += 1;
        }
        for (const { occurrence, late } of deliver) {
          const fireAt = occurrence.at.toISOString();
          if (
            insert.run(
              reminder.reminderId,
              fireAt,
              occurrence.occurrence,
              occurrence.noticeOffset ?? null,
              now,
              "pending",
              late ? 1 : 0,
              fireToken(reminder.reminderId, fireAt),
            ).changes === 0
          )
            continue;
          claimed.push({ reminder, fire: this.#fire(reminder.reminderId, fireAt), late });
        }
        // Snoozed fires coming back.
        const followUps = this.#db
          .prepare(
            "SELECT * FROM tavi_reminder_fires WHERE reminder_id = ? AND outcome = 'pending' AND fired_at IS NULL AND fire_at <= ? ORDER BY fire_at",
          )
          .all(reminder.reminderId, now) as FireRow[];
        for (const followUp of followUps) claimRow(followUp);

        const next = this.#nextFireAt(reminder, new Date(now));
        const status: ReminderStatus = next === null ? "done" : "active";
        this.#db
          .prepare(`UPDATE tavi_reminders SET schedule_cursor_at = ?, next_fire_at = ?, status = ?,
              updated_at = CASE WHEN status = ? THEN updated_at ELSE ? END WHERE reminder_id = ?`)
          .run(now, next, status, status, nextStamp(now, row.updated_at), reminder.reminderId);
        // The claimed fires carry the reminder as it now stands (`done`, next fire).
        const updated = this.#require(reminder.reminderId);
        readable.set(reminder.reminderId, updated);
        for (let index = 0; index < claimed.length; index += 1) {
          const entry = claimed[index];
          if (entry !== undefined && entry.reminder.reminderId === updated.reminderId) claimed[index] = { ...entry, reminder: updated };
        }
      }
      return { claimed, missed };
    });
  }

  recordOutcome(input: RecordReminderOutcomeInput): boolean {
    const request = parsed(RecordReminderOutcomeInputSchema, input, "reminder outcome");
    const fireAt = iso(request.fireAt);
    const now = iso(request.now);
    return this.#store.transactionImmediate(() => {
      if (request.outcome === "retry") {
        if (request.retryAt === undefined) throw new TaviError("INVALID_INPUT", "A retried reminder delivery needs the time to try again");
        // The window opens with the first refusal and does not move after it.
        return (
          this.#db
            .prepare(`UPDATE tavi_reminder_fires SET attempts = attempts + 1, retry_at = ?, retry_until = COALESCE(retry_until, ?), task_id = COALESCE(?, task_id)
            WHERE reminder_id = ? AND fire_at = ? AND outcome = 'pending' AND fired_at IS NOT NULL AND retry_at IS NULL`)
            .run(
              iso(request.retryAt),
              new Date(Date.parse(now) + REMINDER_RETRY_WINDOW_MS).toISOString(),
              request.taskId ?? null,
              request.reminderId,
              fireAt,
            ).changes > 0
        );
      }
      const changed =
        this.#db
          .prepare(`UPDATE tavi_reminder_fires SET outcome = ?, task_id = COALESCE(?, task_id), retry_at = NULL
          WHERE reminder_id = ? AND fire_at = ? AND outcome = 'pending' AND fired_at IS NOT NULL AND retry_at IS NULL`)
          .run(request.outcome, request.taskId ?? null, request.reminderId, fireAt).changes > 0;
      if (changed && request.outcome !== "failed") {
        this.#db
          .prepare("UPDATE tavi_reminders SET last_fired_at = ? WHERE reminder_id = ? AND (last_fired_at IS NULL OR last_fired_at < ?)")
          .run(now, request.reminderId, now);
      }
      return changed;
    });
  }

  fireByToken(token: string): { readonly reminder: Reminder; readonly fire: ReminderFire } | undefined {
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(token)) return undefined;
    const row = this.#db.prepare("SELECT * FROM tavi_reminder_fires WHERE token = ?").get(token) as FireRow | undefined;
    const reminder = row === undefined ? undefined : this.get(row.reminder_id);
    return row === undefined || reminder === undefined ? undefined : { reminder, fire: toFire(row) };
  }

  /** The reminder, checked against the `updatedAt` the caller read when one is given. */
  createTodo(input: CreateTodoInput): CreateTodoResult {
    const request = parsed(CreateTodoInputSchema, input, "to-do");
    const now = iso(request.now);
    const list = request.list ?? DEFAULT_TODO_LIST;
    return this.#store.transactionImmediate(() => {
      const retried = this.#db
        .prepare("SELECT * FROM tavi_reminders WHERE workspace_id = ? AND principal_id = ? AND operation_key = ?")
        .get(request.workspaceId, request.principalId, request.operationKey) as ReminderRow | undefined;
      if (retried !== undefined) {
        const todo = tryTodo(retried);
        if (todo === undefined) throw new TaviError("CONFLICT", "That operation key already made a reminder, not a to-do");
        return { todo, created: false };
      }
      // An open to-do with the same text on the same list is the one already
      // made: a model asking twice, or "add milk" said again.
      const same = this.#db
        .prepare(
          "SELECT * FROM tavi_reminders WHERE workspace_id = ? AND principal_id = ? AND kind = 'todo' AND todo_status = 'open' AND list = ? AND lower(text) = lower(?) LIMIT 1",
        )
        .get(request.workspaceId, request.principalId, list, request.text) as ReminderRow | undefined;
      const existing = same === undefined ? undefined : tryTodo(same);
      if (existing !== undefined) return { todo: existing, created: false, duplicate: true };
      const { n } = this.#db
        .prepare("SELECT count(*) AS n FROM tavi_reminders WHERE workspace_id = ? AND kind = 'todo' AND todo_status = 'open'")
        .get(request.workspaceId) as { n: number };
      if (n >= TODO_MAX_OPEN_PER_WORKSPACE) {
        throw new TaviError(
          "INVALID_INPUT",
          `A workspace can have at most ${TODO_MAX_OPEN_PER_WORKSPACE} open to-dos; tick off or remove some first`,
          { details: { open: n } },
        );
      }
      const schedule = todoSchedule(request.due, "open", now, now);
      this.#db
        .prepare(
          `INSERT INTO tavi_reminders (reminder_id, workspace_id, principal_id, text, prompt, when_json, timezone, deliver_to_json,
             status, next_fire_at, last_fired_at, schedule_cursor_at, created_by, origin_task_id, operation_key, created_at, updated_at, label_json,
             kind, todo_status, list, notes, due, completed_at)
           VALUES (@todoId, @workspaceId, @principalId, @text, NULL, @when, @timezone, @deliverTo,
             @status, @nextFireAt, NULL, @now, @createdBy, @originTaskId, @operationKey, @now, @now, @label,
             'todo', 'open', @list, @notes, @due, NULL)`,
        )
        .run({
          todoId: request.todoId,
          workspaceId: request.workspaceId,
          principalId: request.principalId,
          text: request.text,
          when: JSON.stringify(schedule.when),
          timezone: request.timezone,
          deliverTo: JSON.stringify(request.deliverTo),
          status: schedule.status,
          nextFireAt: schedule.nextFireAt,
          createdBy: request.createdBy,
          originTaskId: request.originTaskId ?? null,
          operationKey: request.operationKey,
          now,
          label: labelColumn(request.label),
          list,
          notes: request.notes ?? null,
          due: request.due === undefined ? null : storedDue(request.due),
        });
      return { todo: this.#requireTodo(request.todoId), created: true };
    });
  }

  getTodo(todoId: string): Todo | undefined {
    const row = this.#db.prepare("SELECT * FROM tavi_reminders WHERE reminder_id = ? AND kind = 'todo'").get(todoId) as
      | ReminderRow
      | undefined;
    if (row === undefined) return undefined;
    const todo = tryTodo(row);
    if (todo === undefined) throw new TaviError("INTERNAL", `To-do ${todoId} has an unreadable record; remove it or restore a backup`);
    return todo;
  }

  listTodos(input: ListTodosInput): ListTodosResult {
    const request = parsed(ListTodosInputSchema, input, "to-do list");
    const filters = ["workspace_id = ?", "kind = 'todo'"];
    const params: (string | number)[] = [request.workspaceId];
    if (request.principalId !== undefined) {
      filters.push("principal_id = ?");
      params.push(request.principalId);
    }
    const statuses = request.statuses ?? ["open"];
    filters.push(`todo_status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    if (request.list !== undefined) {
      filters.push("list = ?");
      params.push(request.list);
    }
    if (request.cursor !== undefined) {
      const cursor = decodeCursor(request.cursor);
      filters.push("(created_at > ? OR (created_at = ? AND reminder_id > ?))");
      params.push(cursor.c, cursor.c, cursor.i);
    }
    const rows = this.#db
      .prepare(`SELECT * FROM tavi_reminders WHERE ${filters.join(" AND ")} ORDER BY created_at ASC, reminder_id ASC LIMIT ?`)
      .all(...params, request.limit + 1) as ReminderRow[];
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);
    return {
      todos: page.map(tryTodo).filter((todo): todo is Todo => todo !== undefined),
      ...(rows.length > request.limit && last !== undefined ? { nextCursor: encodeCursor(last.created_at, last.reminder_id) } : {}),
    };
  }

  updateTodo(input: UpdateTodoInput): Todo {
    const request = parsed(UpdateTodoInputSchema, input, "to-do change");
    const now = iso(request.now);
    return this.#store.transactionImmediate(() => {
      const current = this.getTodo(request.todoId);
      if (current === undefined) throw new TaviError("NOT_FOUND", `To-do ${request.todoId} does not exist`);
      if (request.expectedUpdatedAt !== undefined && Date.parse(request.expectedUpdatedAt) !== Date.parse(current.updatedAt)) {
        throw new TaviError("CONFLICT", "That to-do changed since it was read; reload it and try again", {
          details: { expectedUpdatedAt: request.expectedUpdatedAt, updatedAt: current.updatedAt },
        });
      }
      const status = request.status ?? current.status;
      const due = request.due === undefined ? current.due : (request.due ?? undefined);
      const retimed = request.due !== undefined || status !== current.status;
      const schedule = retimed ? todoSchedule(due, status, now, current.createdAt) : undefined;
      // A due time that changed, or a to-do ticked off or reopened: the old time's snoozed fires, and a delivery
      // waiting to be retried, no longer apply.
      if (retimed)
        this.#db
          .prepare(
            "DELETE FROM tavi_reminder_fires WHERE reminder_id = ? AND outcome = 'pending' AND (fired_at IS NULL OR retry_at IS NOT NULL)",
          )
          .run(current.todoId);
      this.#db
        .prepare(
          `UPDATE tavi_reminders SET text = @text, list = @list, notes = @notes, due = @due, todo_status = @todoStatus,
             completed_at = @completedAt, updated_at = @updatedAt,
             when_json = COALESCE(@when, when_json), status = COALESCE(@status, status),
             next_fire_at = CASE WHEN @retimed = 1 THEN @nextFireAt ELSE next_fire_at END,
             schedule_cursor_at = CASE WHEN @retimed = 1 THEN @now ELSE schedule_cursor_at END,
             label_json = CASE WHEN @relabel = 1 THEN @label ELSE label_json END
           WHERE reminder_id = @todoId`,
        )
        .run({
          todoId: current.todoId,
          text: request.text ?? current.text,
          list: request.list ?? current.list,
          notes: request.notes === undefined ? (current.notes ?? null) : request.notes,
          due: due === undefined ? null : storedDue(due),
          todoStatus: status,
          completedAt: status === "done" ? (current.status === "done" ? (current.completedAt ?? now) : now) : null,
          updatedAt: nextStamp(now, current.updatedAt),
          when: schedule === undefined ? null : JSON.stringify(schedule.when),
          status: schedule?.status ?? null,
          retimed: retimed ? 1 : 0,
          nextFireAt: schedule?.nextFireAt ?? null,
          now,
          relabel: request.label === undefined ? 0 : 1,
          label: labelColumn(request.label),
        });
      return this.#requireTodo(current.todoId);
    });
  }

  removeTodo(input: RemoveTodoInput): boolean {
    const request = parsed(RemoveTodoInputSchema, input, "to-do removal");
    return this.#store.transactionImmediate(() => {
      const current = this.getTodo(request.todoId);
      if (current === undefined) return false;
      if (request.expectedUpdatedAt !== undefined && Date.parse(request.expectedUpdatedAt) !== Date.parse(current.updatedAt))
        throw new TaviError("CONFLICT", "That to-do changed since it was read; reload it and try again");
      this.#db.prepare("DELETE FROM tavi_reminder_fires WHERE reminder_id = ?").run(current.todoId);
      return this.#db.prepare("DELETE FROM tavi_reminders WHERE reminder_id = ? AND kind = 'todo'").run(current.todoId).changes > 0;
    });
  }

  #requireTodo(todoId: string): Todo {
    const todo = this.getTodo(todoId);
    if (todo === undefined) throw new TaviError("INTERNAL", `To-do ${todoId} vanished inside its own write`);
    return todo;
  }

  #current(reminderId: string, expectedUpdatedAt?: string): Reminder {
    const current = this.get(reminderId);
    if (current === undefined) throw new TaviError("NOT_FOUND", `Reminder ${reminderId} does not exist`);
    if (expectedUpdatedAt !== undefined && Date.parse(expectedUpdatedAt) !== Date.parse(current.updatedAt)) {
      throw new TaviError("CONFLICT", "That reminder changed since it was read; reload it and try again", {
        details: { expectedUpdatedAt, updatedAt: current.updatedAt },
      });
    }
    return current;
  }

  #require(reminderId: string): Reminder {
    const reminder = this.get(reminderId);
    if (reminder === undefined) throw new TaviError("INTERNAL", `Reminder ${reminderId} vanished inside its own write`);
    return reminder;
  }

  #fire(reminderId: string, fireAt: string): ReminderFire {
    const row = this.#db.prepare("SELECT * FROM tavi_reminder_fires WHERE reminder_id = ? AND fire_at = ?").get(reminderId, fireAt) as
      | FireRow
      | undefined;
    if (row === undefined) throw new TaviError("INTERNAL", `Reminder ${reminderId}'s fire at ${fireAt} vanished inside its own write`);
    return toFire(row);
  }

  #cursorOf(reminderId: string): string {
    return (
      this.#db.prepare("SELECT schedule_cursor_at FROM tavi_reminders WHERE reminder_id = ?").get(reminderId) as {
        schedule_cursor_at: string;
      }
    ).schedule_cursor_at;
  }

  /** The next fire of any kind: the schedule's next after `after`, or a snoozed fire waiting to come back, whichever is first. */
  #nextFireAt(reminder: Reminder, after: Date): string | null {
    const scheduled = nextReminderFire(reminder, after)?.at.toISOString();
    const followUp =
      (
        this.#db
          .prepare("SELECT min(fire_at) AS at FROM tavi_reminder_fires WHERE reminder_id = ? AND outcome = 'pending' AND fired_at IS NULL")
          .get(reminder.reminderId) as { at: string | null }
      ).at ?? undefined;
    if (scheduled === undefined) return followUp ?? null;
    if (followUp === undefined) return scheduled;
    // biome-ignore lint/complexity/useMathMinMax: ISO timestamps, compared as strings; Math.min would make them NaN.
    return followUp < scheduled ? followUp : scheduled;
  }

  #assertRoomFor(workspaceId: string): void {
    const { n } = this.#db
      .prepare("SELECT count(*) AS n FROM tavi_reminders WHERE workspace_id = ? AND status = 'active' AND kind = 'reminder'")
      .get(workspaceId) as { n: number };
    if (n >= REMINDER_MAX_ACTIVE_PER_WORKSPACE) {
      throw new TaviError(
        "INVALID_INPUT",
        `A workspace can have at most ${REMINDER_MAX_ACTIVE_PER_WORKSPACE} active reminders; cancel some first`,
        { details: { active: n } },
      );
    }
  }
}
