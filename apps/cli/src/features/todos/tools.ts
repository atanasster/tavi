import { z } from "zod";

import {
  DEFAULT_TODO_LIST,
  TODO_MAX_OPEN_PER_WORKSPACE,
  TaviError,
  formatReminderTime,
  hostTimeZone,
  isTrustedPublic,
  joinLabels,
  todoDueIsTime,
  type CallAssessment,
  type ContentLabel,
  type InvocationContext,
  type Todo,
  type ToolSink,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { definedOnly } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";

import { cardWords } from "../approvals/card-words.js";
import { deliverToOf, instantOf, labelledByStored, originTaskOf, type ReminderToolDependencies } from "../reminders/tools.js";

/**
 * The agent's to-do tools: `todos.add`, `.list`, `.complete`, `.update` and
 * `.remove`, over the reminders store (a to-do is a reminder row with no fire
 * time of its own; see `TodoSchema`).
 *
 * - Each person sees and changes only their own to-dos.
 * - `add` takes an operation key, so a retried call is the same call, and
 *   answers an open to-do with the same text on the same list as the one
 *   already made; a `complete` or `update` repeated with the same values
 *   changes nothing.
 * - A due *time* also reminds, said where a reminder asked here would be;
 *   every answer carries `readBack`, the due in words, which the model
 *   repeats so a wrong reading of "Friday" is caught at once.
 * - A seeded allow rule (`seeded-todos`) lets these run without a round: the
 *   person's own list never asks. A change or removal still asks when the
 *   conversation holds untrusted content (`askWhenTainted`).
 * - One made or changed under taint keeps that call's context label, and
 *   every answer that shows it is labelled from it, as a reminder's is.
 * - Where the person keeps tasks in an app of their own (`tasks.home`), the
 *   system prompt sends their to-dos there; these keep Tavi's own follow-ups.
 */

export type TodoToolDependencies = ReminderToolDependencies;

const id = z.string().min(1).max(128);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const due = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/,
    "expected YYYY-MM-DD or a local date and time",
  )
  .describe(
    "A due date (2026-10-30: shown, no reminder) or a due time (2026-10-30T17:00, local in the workspace's zone: also reminds then). Omit for none",
  );
const list = z
  .string()
  .min(1)
  .max(60)
  .describe(`The list's name ("groceries", "work"); omit for "${DEFAULT_TODO_LIST}". Names are not case-sensitive`);
const operationKey = z.string().min(1).max(160).describe("A key you choose for this request; repeat it when retrying the same request");

/** Each operation's sink: a to-do outlives the chat; listing reads. */
const SINKS = { add: "persist", list: "none", complete: "persist", update: "persist", remove: "persist" } as const satisfies Record<
  keyof typeof operations,
  ToolSink
>;

const operations = {
  add: z.strictObject({
    text: z.string().min(1).max(500).describe('The to-do, as the person would write it ("Buy milk")'),
    list: list.optional(),
    notes: z.string().min(1).max(2000).optional().describe("Detail worth keeping with it"),
    due: due.optional(),
    operationKey,
  }),
  list: z.strictObject({
    list: list.optional().describe("Only this list; omit for every list"),
    includeDone: z.boolean().optional().describe("Also list done to-dos"),
    cursor: z.string().min(1).max(512).optional().describe("A previous answer's nextCursor: the next page"),
  }),
  complete: z.strictObject({
    todoId: id,
    reopen: z.boolean().optional().describe("true puts a done to-do back on the list"),
  }),
  update: z.strictObject({
    todoId: id,
    text: z.string().min(1).max(500).optional(),
    list: list.optional().describe("Move it to this list"),
    notes: z.string().min(1).max(2000).nullable().optional().describe("null removes the notes"),
    due: due.nullable().optional().describe("A new due date or time; null removes it, and any reminder it set"),
  }),
  remove: z.strictObject({ todoId: id }),
} as const;

const DESCRIPTIONS: Readonly<Record<keyof typeof operations, string>> = {
  add:
    'Add a to-do to this person\'s list in Tavi: "add milk to my list", "I need to renew my passport", "put \'call the plumber\' on my work list". ' +
    "A to-do is something to do, kept until it is ticked off; a reminder (`reminders.create`) says something at a time. " +
    "A due time also reminds at that time, said in this conversation; a due date is only shown. " +
    `Resolve "Friday" against the current local time in the runtime facts. Repeat the answer's \`readBack\`. A workspace holds at most ${TODO_MAX_OPEN_PER_WORKSPACE} open to-dos. ` +
    "When the system prompt says the person keeps their tasks in an app of their own, add their to-dos there instead and use this only for your own follow-ups. " +
    "For: to-do, todo, task list, my list, shopping list, add to my list, I need to.",
  list: "List this person's open to-dos in Tavi (every list, or one), oldest first, each with its readBack.",
  complete: "Tick off one of this person's to-dos (it stops reminding), or with reopen put a done one back on its list.",
  update: "Change one of this person's to-dos: its text, list, notes or due. Repeat the answer's `readBack`.",
  remove:
    "Remove one of this person's to-dos for good. Ticking it off (`todos.complete`) keeps it as done; remove only when asked to delete it.",
};

/** The person's own to-do, or `NOT_FOUND` — whether someone else's exists is not said. */
async function ownTodo(deps: TodoToolDependencies, context: InvocationContext, todoId: string): Promise<Todo> {
  const todo = await deps.repositories.reminders.getTodo(todoId);
  if (todo === undefined || todo.workspaceId !== context.workspaceId || todo.principalId !== context.principalId) {
    throw new TaviError("NOT_FOUND", `You have no to-do ${todoId}`);
  }
  return todo;
}

/** A due as the model wrote it: a date as it is, a local time read in `timezone`. */
const dueOf = (value: string, timezone: string): string => (DATE.test(value) ? value : instantOf(value, timezone));

/** The due in words: "due Fri 30 Oct 17:00 Europe/Berlin; I'll remind you then", "due 2026-10-30", or "no due date". */
export function todoReadBack(todo: Todo): string {
  const status = todo.status === "done" ? "done" : "open";
  if (todo.due === undefined) return `${status}, on ${todo.list}, no due date`;
  if (!todoDueIsTime(todo.due)) return `${status}, on ${todo.list}, due ${todo.due}`;
  const when = `${formatReminderTime(new Date(todo.due), todo.timezone)} ${todo.timezone}`;
  return `${status}, on ${todo.list}, due ${when}; ${todo.remindAt === null ? "no reminder is still to come" : "I'll remind you then"}`;
}

function view(todo: Todo) {
  return {
    todoId: todo.todoId,
    text: todo.text,
    list: todo.list,
    status: todo.status,
    ...(todo.notes === undefined ? {} : { notes: todo.notes }),
    ...(todo.due === undefined ? {} : { due: todo.due }),
    readBack: todoReadBack(todo),
  };
}

function assessment(title: string, askWhenTainted: boolean, reasons: readonly string[]): CallAssessment {
  return {
    subjects: [],
    risk: "low",
    reasons,
    ...(askWhenTainted ? { askWhenTainted: true } : {}),
    display: { title: title.slice(0, 300) },
  };
}

type Assessor = (input: unknown, context: InvocationContext | undefined) => CallAssessment;

const ASSESSORS: Readonly<Partial<Record<keyof typeof operations, Assessor>>> = {
  add: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.add.safeParse(input);
    return assessment(parsed.success ? t("approval.card.todo.add", { text: parsed.data.text }) : t("approval.card.todo.addAny"), false, []);
  },
  complete: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.complete.safeParse(input);
    const reopen = parsed.success && parsed.data.reopen === true;
    return assessment(
      parsed.success
        ? t(reopen ? "approval.card.todo.reopen" : "approval.card.todo.complete", { id: parsed.data.todoId })
        : t("approval.card.todo.completeAny"),
      true,
      [t("approval.reason.todo.changes")],
    );
  },
  update: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.update.safeParse(input);
    return assessment(
      parsed.success ? t("approval.card.todo.change", { id: parsed.data.todoId }) : t("approval.card.todo.changeAny"),
      true,
      [t("approval.reason.todo.changes")],
    );
  },
  remove: (input, context) => {
    const t = cardWords(context);
    const parsed = operations.remove.safeParse(input);
    return assessment(
      parsed.success ? t("approval.card.todo.remove", { id: parsed.data.todoId }) : t("approval.card.todo.removeAny"),
      true,
      [t("approval.reason.todo.removes")],
    );
  },
};

/** The label a change holds from now on: under taint or from private data it joins what the to-do held; a clean change keeps that. */
function relabelOf(current: Todo, contextLabel: ContentLabel | undefined): ContentLabel | undefined {
  if (contextLabel === undefined || isTrustedPublic(contextLabel)) return undefined;
  return current.label === undefined ? contextLabel : joinLabels(current.label, contextLabel);
}

export function registerTodoTools(registry: ToolRegistry, deps: TodoToolDependencies): void {
  const store = deps.repositories.reminders;
  const handlers: {
    readonly [K in keyof typeof operations]: (
      input: z.infer<(typeof operations)[K]>,
      context: InvocationContext,
      contextLabel: ContentLabel | undefined,
    ) => Promise<unknown>;
  } = {
    add: async (input, context, contextLabel) => {
      const timezone = (await deps.repositories.workspaceSettings.get(context.workspaceId)).settings.timezone ?? hostTimeZone();
      const originTaskId = await originTaskOf(deps, context);
      const added = await store.createTodo({
        todoId: `todo-${deps.newId()}`,
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        text: input.text,
        ...definedOnly({ list: input.list, notes: input.notes }),
        ...(input.due === undefined ? {} : { due: dueOf(input.due, timezone) }),
        timezone,
        deliverTo: await deliverToOf(deps, context, originTaskId),
        createdBy: "agent",
        originTaskId,
        // Scoped to the task, so two tasks choosing the same key make two to-dos.
        operationKey: `agent:${context.runId}:todo:${input.operationKey}`,
        ...(contextLabel === undefined || isTrustedPublic(contextLabel) ? {} : { label: contextLabel }),
        now: deps.now().toISOString(),
      });
      return labelledByStored(
        {
          ...view(added.todo),
          created: added.created,
          ...(added.duplicate === true ? { duplicate: true, note: "That to-do was already on the list; it is the one returned" } : {}),
        },
        [added.todo],
      );
    },
    list: async (input, context) => {
      const listed = await store.listTodos({
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        statuses: input.includeDone === true ? ["open", "done"] : ["open"],
        ...definedOnly({ list: input.list, cursor: input.cursor }),
        limit: 100,
      });
      return labelledByStored(
        {
          todos: listed.todos.map(view),
          ...(listed.nextCursor === undefined ? {} : { more: true, nextCursor: listed.nextCursor }),
        },
        listed.todos,
      );
    },
    complete: async (input, context, contextLabel) => {
      const current = await ownTodo(deps, context, input.todoId);
      const status = input.reopen === true ? "open" : "done";
      if (current.status === status) return labelledByStored({ ...view(current), changed: false }, [current]);
      const relabel = relabelOf(current, contextLabel);
      const changed = await store.updateTodo({
        todoId: current.todoId,
        expectedUpdatedAt: current.updatedAt,
        status,
        ...(relabel === undefined ? {} : { label: relabel }),
        now: deps.now().toISOString(),
      });
      return labelledByStored({ ...view(changed), changed: true }, [changed]);
    },
    update: async (input, context, contextLabel) => {
      const current = await ownTodo(deps, context, input.todoId);
      const nextDue = input.due === undefined ? undefined : input.due === null ? null : dueOf(input.due, current.timezone);
      // The same change again (a retried call) changes nothing.
      const unchanged =
        (input.text === undefined || input.text === current.text) &&
        (input.list === undefined || input.list.trim().toLowerCase() === current.list) &&
        (input.notes === undefined || (input.notes ?? undefined) === current.notes) &&
        (nextDue === undefined ||
          (nextDue ?? undefined) === current.due ||
          (nextDue !== null && current.due !== undefined && Date.parse(nextDue) === Date.parse(current.due)));
      if (unchanged) return labelledByStored({ ...view(current), changed: false }, [current]);
      const relabel = relabelOf(current, contextLabel);
      const changed = await store.updateTodo({
        todoId: current.todoId,
        expectedUpdatedAt: current.updatedAt,
        ...definedOnly({ text: input.text, list: input.list, notes: input.notes, due: nextDue, label: relabel }),
        now: deps.now().toISOString(),
      });
      return labelledByStored({ ...view(changed), changed: true }, [changed]);
    },
    remove: async (input, context) => {
      const current = await ownTodo(deps, context, input.todoId);
      const removed = await store.removeTodo({ todoId: current.todoId });
      return labelledByStored({ todoId: current.todoId, text: current.text, removed }, [current]);
    },
  };
  for (const name of Object.keys(operations) as (keyof typeof operations)[]) {
    const schema = operations[name];
    const assess = ASSESSORS[name];
    registry.register({
      id: `todos.${name}`,
      sink: SINKS[name],
      version: "1.0.0",
      description: DESCRIPTIONS[name],
      effect: name === "list" ? "read-only" : "mutating",
      // Removing ends a to-do for good; a second removal changes nothing more.
      ...(name === "remove" ? { annotations: { destructive: true, idempotent: true } } : {}),
      requiredPermissions: ["tools.invoke"],
      inputSchema: schema,
      ...(assess === undefined ? {} : { assess }),
      handler: async ({ input, context, signal, contextLabel }) => {
        if (signal.aborted) throw new TaviError("CANCELLED", `todos.${name} was cancelled`);
        const parsed = schema.safeParse(input);
        if (!parsed.success) throw new TaviError("INVALID_INPUT", `todos.${name}: ${zodIssues(parsed.error, "input").join("; ")}`);
        const handler = handlers[name] as (
          input: unknown,
          context: InvocationContext,
          contextLabel: ContentLabel | undefined,
        ) => Promise<unknown>;
        return handler(parsed.data, context, contextLabel);
      },
    });
  }
}
