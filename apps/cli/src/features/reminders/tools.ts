import { z } from "zod";

import {
  REMINDER_DEFAULT_NOTIFY,
  REMINDER_MAX_ACTIVE_PER_WORKSPACE,
  REMINDER_MAX_AHEAD_DAYS,
  REMINDER_MAX_NOTICES,
  REMINDER_MAX_TIMES_PER_DAY,
  REMINDER_SNOOZE_MAX_MINUTES,
  TOOL_LABEL_KEY,
  TaviError,
  hostTimeZone,
  instantForLocalTime,
  isTrustedPublic,
  isUntrusted,
  joinLabels,
  normalizeReminderWhen,
  reminderReadBack,
  type CallAssessment,
  type ContentLabel,
  type InvocationContext,
  type PersistencePort,
  type Reminder,
  type ReminderDeliverTo,
  type ReminderWhen,
  type ToolSink,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { definedOnly } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";

import { cardWords } from "../approvals/card-words.js";

/**
 * The agent's reminder tools:
 * `reminders.create`, `.list`, `.update`, `.cancel` and `.snooze`.
 *
 * - Where a reminder is said is never the model's to choose: it is the
 *   conversation the task came from, else the app.
 * - Each person sees and changes only their own reminders.
 * - `create` takes an operation key, so a retried call is the same call, and
 *   answers an exact duplicate with the reminder already made; an `update`
 *   repeated with the same values changes nothing.
 * - Every answer carries `readBack`, the resolved local time in words, which
 *   the model repeats so a wrong reading of "next Monday" is caught at once.
 * - A seeded allow rule lets these run without a round; one that starts a
 *   task, or changes or cancels a reminder, still asks when the conversation
 *   holds untrusted content (`askWhenTainted`).
 * - One made or changed under taint keeps that call's context label: the
 *   task its `prompt` starts begins with it, its words are disarmed when
 *   said on a channel, and every answer that shows it is labelled from it. A change under taint joins its
 *   label; a clean change keeps what it held.
 */

export interface ReminderToolDependencies {
  readonly repositories: Pick<
    PersistencePort["repositories"],
    "reminders" | "workspaceSettings" | "messagingConversations" | "agentDelegations"
  > & { readonly tasks?: Pick<PersistencePort["repositories"]["tasks"], "get"> };
  /** The owner's own front ends' connections: a reminder asked there is delivered in the app. */
  readonly isLocalConnection: (connectionId: string) => boolean;
  readonly now: () => Date;
  readonly newId: () => string;
}

const id = z.string().min(1).max(128);
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("24-hour local time, HH:MM");
/** A date and time, local (read in the reminder's zone) or with its UTC offset. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;
const instant = z
  .string()
  .regex(DATE_TIME)
  .describe(
    "Local date and time, e.g. 2026-10-05T10:00, read in the reminder's zone on that date (daylight saving included); a time with a UTC offset is taken as given",
  );
const notice = z
  .string()
  .regex(/^-[1-9]\d{0,4}[mhd](@([01]\d|2[0-3]):[0-5]\d)?$/)
  .describe('A notice before the event: "-15m", "-2h", "-1d" (same time the day before) or "-1d@20:00" (20:00 the day before)');
const when = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once").describe("Remind once, at `at`"), at: instant }),
  z.strictObject({
    kind: z.literal("event").describe("An appointment at `at`: remind with each notice before it (not at the event itself)"),
    at: instant,
    notify: z
      .array(notice)
      .min(1)
      .max(REMINDER_MAX_NOTICES)
      .optional()
      .describe(`Default ${JSON.stringify(REMINDER_DEFAULT_NOTIFY)}: the evening before at 20:00 and one hour before`),
  }),
  z.strictObject({
    kind: z.literal("repeat").describe("Remind at each time on each chosen day"),
    times: z.array(time).min(1).max(REMINDER_MAX_TIMES_PER_DAY),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe("0 = Sunday … 6 = Saturday; omit for every day"),
    monthly: z
      .union([
        z.strictObject({ dayOfMonth: z.number().int().min(1).max(31).describe("31 is each month's last day when shorter") }),
        z.strictObject({
          nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1)]).describe("-1: the last"),
          weekday: z.number().int().min(0).max(6),
        }),
      ])
      .optional()
      .describe("Once a month (rent on the 1st, the last Friday): in place of daysOfWeek"),
    yearly: z
      .strictObject({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })
      .optional()
      .describe("Once a year (a birthday, a renewal): in place of daysOfWeek"),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The last date it fires, YYYY-MM-DD"),
  }),
]);
const operationKey = z.string().min(1).max(160).describe("A key you choose for this request; repeat it when retrying the same request");
const zone = z.string().min(1).max(64).describe("IANA time zone; omit for the workspace's");

/**
 * Each operation's sink: a reminder that fires later outlives the chat;
 * listing reads, and a snooze only re-times an existing one.
 */
const SINKS = { create: "persist", list: "none", update: "persist", cancel: "persist", snooze: "none" } as const satisfies Record<
  keyof typeof operations,
  ToolSink
>;

const operations = {
  create: z.strictObject({
    text: z.string().min(1).max(500).describe('What to say when it fires, addressed to the person ("Take your pills")'),
    when,
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('Also start a task with this instruction when it fires ("check the Frankfurt connection")'),
    timezone: zone.optional(),
    operationKey,
  }),
  list: z.strictObject({
    includeFinished: z.boolean().optional().describe("Also list done and cancelled reminders"),
    cursor: z.string().min(1).max(512).optional().describe("A previous answer's nextCursor: the next page"),
  }),
  update: z.strictObject({
    reminderId: id,
    text: z.string().min(1).max(500).optional(),
    when: when.optional(),
    prompt: z.string().min(1).max(4000).nullable().optional().describe("null removes the task it starts"),
    timezone: zone.optional(),
  }),
  cancel: z.strictObject({ reminderId: id }),
  snooze: z.strictObject({
    reminderId: id,
    minutes: z.number().int().min(1).max(REMINDER_SNOOZE_MAX_MINUTES).describe("How long, in minutes: up to a week (10,080)"),
  }),
} as const;

const LIMITS = `Times must be in the future and at most ${Math.round(REMINDER_MAX_AHEAD_DAYS / 365)} years ahead; a repeat fires at most ${REMINDER_MAX_TIMES_PER_DAY} times a day; a workspace holds at most ${REMINDER_MAX_ACTIVE_PER_WORKSPACE} active reminders.`;
const DESCRIPTIONS: Readonly<Record<keyof typeof operations, string>> = {
  create:
    'Create a reminder that tells this person something at a time. Not for a prompt run at set times (schedules.create), research that publishes a report (routines.create) or something to do with no time (todos.add): "remind me to check the train" is a reminder with a `prompt`. ' +
    "Kinds: `once` at a time; `event` for an appointment, which fires its notices before it — by default the evening before at 20:00 and one hour before (say so); `repeat` at up to six times a day on chosen weekdays, monthly (a day of the month, or the nth weekday) or yearly (a birthday, a renewal). " +
    "The only repeats are days of the week, monthly and yearly. Asked for any other interval (every two weeks, every three months), say plainly that a reminder can't repeat that, and offer the nearest one that can, or a single reminder; a one-off never reschedules itself, so never say it will, and a `prompt` is no way round this. " +
    `Resolve "next Monday" and "9 PM" against the current local time in the runtime facts; write \`at\` as a local time. ${LIMITS} ` +
    "It is delivered to this conversation (or in the app); you cannot choose another destination. Repeat the answer's `readBack` to the person word for word, and mention any `skippedNotices`. " +
    "For: remind me, reminder, alarm, at a time, tomorrow, tonight, every day or evening, an appointment, don't let me forget. " +
    'Example: {"text":"Pay the rent","when":{"kind":"repeat","times":["09:00"],"monthly":{"dayOfMonth":1}},"operationKey":"rent"}.',
  list: "List this person's reminders, with each one's readBack.",
  update: "Change one of this person's reminders: its text, its time, or the task it starts. Repeat the answer's `readBack` to the person.",
  cancel: "Cancel one of this person's reminders.",
  snooze: "Snooze the latest delivered fire of one of this person's reminders, by any span up to a week.",
};

/**
 * The task a reminder is asked in: a delegated worker's delegation root, the
 * task the person talks to, so delivery checks and "Added from" name it.
 */
export async function originTaskOf(deps: ReminderToolDependencies, context: InvocationContext): Promise<string> {
  const delegation = await deps.repositories.agentDelegations.getByWorkerTaskId(context.runId);
  return delegation?.rootTaskId ?? delegation?.parentTaskId ?? context.runId;
}

/**
 * Where a reminder asked in this task is said: its conversation (or its
 * delegation root's); else, asked in the person's Home, Home itself, as a
 * notice; else the app.
 */
export async function deliverToOf(
  deps: ReminderToolDependencies,
  context: InvocationContext,
  originTaskId: string,
): Promise<ReminderDeliverTo> {
  let replyTo: { readonly connectionId: string; readonly externalConversationId: string } | undefined = context.messagingReplyTo;
  replyTo ??= (await deps.repositories.messagingConversations.getByTask(context.runId))?.replyTo;
  if (replyTo === undefined && originTaskId !== context.runId)
    replyTo = (await deps.repositories.messagingConversations.getByTask(originTaskId))?.replyTo;
  if (replyTo !== undefined && !deps.isLocalConnection(replyTo.connectionId))
    return { kind: "conversation", connectionId: replyTo.connectionId, conversationId: replyTo.externalConversationId };
  const origin = await deps.repositories.tasks?.get(originTaskId);
  return origin?.chatKind === "home" && origin.principalId === context.principalId ? { kind: "home" } : { kind: "app" };
}

/** The person's own reminder, or `NOT_FOUND` — whether someone else's exists is not said. */
async function ownReminder(deps: ReminderToolDependencies, context: InvocationContext, reminderId: string): Promise<Reminder> {
  const reminder = await deps.repositories.reminders.get(reminderId);
  // A to-do's row is changed with `todos.*`, never as a reminder.
  if (
    reminder === undefined ||
    reminder.kind === "todo" ||
    reminder.workspaceId !== context.workspaceId ||
    reminder.principalId !== context.principalId
  ) {
    throw new TaviError("NOT_FOUND", `You have no reminder ${reminderId}`);
  }
  return reminder;
}

/**
 * `at` as an instant: as written when it carries an offset, else the wall time
 * it names in `timezone` on that date — so a date past a daylight-saving
 * change is not read with today's offset.
 */
export function instantOf(at: string, timezone: string): string {
  const match = DATE_TIME.exec(at);
  if (match === null || match[7] !== undefined) return at;
  const part = (index: number): number => Number(match[index] ?? 0);
  const local = { year: part(1), month: part(2), day: part(3), hour: part(4), minute: part(5) };
  const second = part(6);
  const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (
    calendar.getUTCMonth() !== local.month - 1 ||
    calendar.getUTCDate() !== local.day ||
    local.hour > 23 ||
    local.minute > 59 ||
    second > 59
  ) {
    throw new TaviError("INVALID_INPUT", `${at} is not a date and time`);
  }
  return new Date(instantForLocalTime(local, timezone).getTime() + second * 1000).toISOString();
}

/** A schedule as the model wrote it, with local times read in `timezone` and an event's default notices filled in. */
function whenOf(input: z.infer<typeof when>, timezone: string): ReminderWhen {
  if (input.kind === "repeat") return input;
  const at = instantOf(input.at, timezone);
  return input.kind === "event" ? { ...input, at, notify: input.notify ?? [...REMINDER_DEFAULT_NOTIFY] } : { ...input, at };
}

function view(reminder: Reminder, now: Date) {
  return {
    reminderId: reminder.reminderId,
    text: reminder.text,
    status: reminder.status,
    nextFireAt: reminder.nextFireAt,
    ...(reminder.prompt === undefined ? {} : { startsTask: true }),
    readBack: reminderReadBack(reminder, now),
  };
}

/**
 * An answer showing reminders, labelled from what they hold:
 * their stored labels joined in (`TOOL_LABEL_KEY` `stored`), so one made from
 * private data makes the answer private; when one was made or changed under
 * taint, its words may be a page's, so the answer is untrusted too.
 */
function labelledByReminders<T extends object>(answer: T, reminders: readonly Reminder[]): T {
  return labelledByStored(answer, reminders);
}

/** `labelledByReminders` for any stored records with a label: a reminder's, a to-do's. */
export function labelledByStored<T extends object>(answer: T, records: readonly { readonly label?: ContentLabel | undefined }[]): T {
  const labels = records.flatMap((record) => (record.label !== undefined && !isTrustedPublic(record.label) ? [record.label] : []));
  const stored = labels.reduce<ContentLabel | undefined>(
    (joined, label) => (joined === undefined ? label : joinLabels(joined, label)),
    undefined,
  );
  if (stored === undefined) return answer;
  return {
    ...answer,
    [TOOL_LABEL_KEY]: isUntrusted(stored) ? { untrusted: true, source: stored.sources[0] ?? "unknown-source", stored } : { stored },
  };
}

function assessment(title: string, askWhenTainted: boolean, reasons: readonly string[], detail?: string): CallAssessment {
  return {
    subjects: [],
    risk: "low",
    reasons,
    ...(askWhenTainted ? { askWhenTainted: true } : {}),
    display: { title: title.slice(0, 300), ...(detail === undefined ? {} : { detail: detail.slice(0, 2_000) }) },
  };
}

type Assessor = (input: unknown, context: InvocationContext | undefined) => CallAssessment;

const ASSESSORS: Readonly<Partial<Record<keyof typeof operations, Assessor>>> = {
  create: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.create.safeParse(input);
    if (!parsed.success) return assessment(t("approval.card.reminder.createAny"), true, []);
    const prompt = parsed.data.prompt;
    return assessment(
      t("approval.card.reminder.create", { text: parsed.data.text }),
      prompt !== undefined,
      prompt === undefined ? [] : [t("approval.reason.reminder.startsTask")],
      prompt === undefined ? undefined : t("approval.card.reminder.alsoTask", { prompt }),
    );
  },
  update: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.update.safeParse(input);
    return assessment(
      parsed.success ? t("approval.card.reminder.change", { id: parsed.data.reminderId }) : t("approval.card.reminder.changeAny"),
      true,
      [t("approval.reason.reminder.changes")],
    );
  },
  cancel: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.cancel.safeParse(input);
    return assessment(
      parsed.success ? t("approval.card.reminder.cancel", { id: parsed.data.reminderId }) : t("approval.card.reminder.cancelAny"),
      true,
      [t("approval.reason.reminder.cancels")],
    );
  },
  snooze: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.snooze.safeParse(input);
    return assessment(
      parsed.success
        ? t("approval.card.reminder.snooze", { id: parsed.data.reminderId, count: parsed.data.minutes, n: String(parsed.data.minutes) })
        : t("approval.card.reminder.snoozeAny"),
      false,
      [],
    );
  },
};

export function registerReminderTools(registry: ToolRegistry, deps: ReminderToolDependencies): void {
  const reminders = deps.repositories.reminders;
  const handlers: {
    readonly [K in keyof typeof operations]: (
      input: z.infer<(typeof operations)[K]>,
      context: InvocationContext,
      contextLabel: ContentLabel | undefined,
    ) => Promise<unknown>;
  } = {
    create: async (input, context, contextLabel) => {
      const now = deps.now();
      const timezone =
        input.timezone ?? (await deps.repositories.workspaceSettings.get(context.workspaceId)).settings.timezone ?? hostTimeZone();
      const originTaskId = await originTaskOf(deps, context);
      const created = await reminders.create({
        reminderId: `rem-${deps.newId()}`,
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        text: input.text,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        when: whenOf(input.when, timezone),
        timezone,
        deliverTo: await deliverToOf(deps, context, originTaskId),
        createdBy: "agent",
        originTaskId,
        // Scoped to the task, so two tasks choosing the same key make two reminders.
        operationKey: `agent:${context.runId}:${input.operationKey}`,
        // Made under taint, or from private data: stored, so its task starts with it and, when untrusted, its words are disarmed when said.
        ...(contextLabel === undefined || isTrustedPublic(contextLabel) ? {} : { label: contextLabel }),
        now: now.toISOString(),
      });
      return labelledByReminders(
        {
          ...view(created.reminder, now),
          created: created.created,
          ...(created.duplicate === true ? { duplicate: true, note: "An identical reminder already existed; it is the one returned" } : {}),
          skippedNotices: created.skippedNotices,
          deliveredTo:
            created.reminder.deliverTo.kind === "app"
              ? "the app"
              : created.reminder.deliverTo.kind === "home"
                ? "Home"
                : "this conversation",
        },
        [created.reminder],
      );
    },
    list: async (input, context) => {
      const now = deps.now();
      const listed = await reminders.list({
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        statuses: input.includeFinished === true ? ["active", "paused", "done", "cancelled"] : ["active", "paused"],
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: 50,
      });
      return labelledByReminders(
        {
          reminders: listed.reminders.map((reminder) => view(reminder, now)),
          ...(listed.nextCursor === undefined ? {} : { more: true, nextCursor: listed.nextCursor }),
        },
        listed.reminders,
      );
    },
    update: async (input, context, contextLabel) => {
      const now = deps.now();
      const current = await ownReminder(deps, context, input.reminderId);
      const next = input.when === undefined ? undefined : whenOf(input.when, input.timezone ?? current.timezone);
      // The same change again (a retried call) changes nothing.
      const unchanged =
        (input.text === undefined || input.text === current.text) &&
        (input.prompt === undefined || (input.prompt ?? undefined) === current.prompt) &&
        (input.timezone === undefined || input.timezone === current.timezone) &&
        (next === undefined || JSON.stringify(normalizeReminderWhen(next)) === JSON.stringify(current.when));
      if (unchanged) return labelledByReminders({ ...view(current, now), changed: false }, [current]);
      // Changed under taint or from private data: its label joins what it already held; a clean change keeps that.
      const relabel =
        contextLabel === undefined || isTrustedPublic(contextLabel)
          ? undefined
          : current.label === undefined
            ? contextLabel
            : joinLabels(current.label, contextLabel);
      const updated = await reminders.update({
        reminderId: current.reminderId,
        expectedUpdatedAt: current.updatedAt,
        ...definedOnly({
          label: relabel,
          text: input.text,
          prompt: input.prompt,
          when: next,
          timezone: input.timezone,
        }),
        now: now.toISOString(),
      });
      return labelledByReminders({ ...view(updated, now), changed: true }, [updated]);
    },
    cancel: async (input, context) => {
      const current = await ownReminder(deps, context, input.reminderId);
      const cancelled = await reminders.transition({ reminderId: current.reminderId, action: "cancel", now: deps.now().toISOString() });
      return labelledByReminders(view(cancelled, deps.now()), [cancelled]);
    },
    snooze: async (input, context) => {
      const current = await ownReminder(deps, context, input.reminderId);
      const snoozed = await reminders.snooze({ reminderId: current.reminderId, minutes: input.minutes, now: deps.now().toISOString() });
      return labelledByReminders({ ...view(snoozed.reminder, deps.now()), snoozedUntil: snoozed.followUp.fireAt }, [snoozed.reminder]);
    },
  };
  for (const name of Object.keys(operations) as (keyof typeof operations)[]) {
    const schema = operations[name];
    const assess = ASSESSORS[name];
    registry.register({
      id: `reminders.${name}`,
      sink: SINKS[name],
      version: "1.0.0",
      description: DESCRIPTIONS[name],
      effect: name === "list" ? "read-only" : "mutating",
      // Cancelling ends a reminder for good; a second cancel changes nothing more.
      ...(name === "cancel" ? { annotations: { destructive: true, idempotent: true } } : {}),
      requiredPermissions: ["tools.invoke"],
      inputSchema: schema,
      ...(assess === undefined ? {} : { assess }),
      handler: async ({ input, context, signal, contextLabel }) => {
        if (signal.aborted) throw new TaviError("CANCELLED", `reminders.${name} was cancelled`);
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          throw new TaviError("INVALID_INPUT", `reminders.${name}: ${zodIssues(parsed.error, "input").join("; ")}`);
        }
        return runHandler(handlers, name, parsed.data, context, contextLabel);
      },
    });
  }
}

/** Calls the handler for `name` with its own input type, which a loop over the names cannot state. */
function runHandler<K extends keyof typeof operations>(
  handlers: {
    readonly [N in keyof typeof operations]: (
      input: z.infer<(typeof operations)[N]>,
      context: InvocationContext,
      contextLabel: ContentLabel | undefined,
    ) => Promise<unknown>;
  },
  name: K,
  input: z.infer<(typeof operations)[K]>,
  context: InvocationContext,
  contextLabel: ContentLabel | undefined,
): Promise<unknown> {
  const handler: (
    input: z.infer<(typeof operations)[K]>,
    context: InvocationContext,
    contextLabel: ContentLabel | undefined,
  ) => Promise<unknown> = handlers[name];
  return handler(input, context, contextLabel);
}
