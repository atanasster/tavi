import { randomUUID } from "node:crypto";

import {
  REMINDER_LIST_MAX_LIMIT,
  TaviError,
  TodosListAnswerSchema,
  formatReminderTime,
  todoDueIsTime,
  type RemindersPayload,
  type Todo,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";

import { emit } from "../../cli/output.js";
import { EXIT, configRefusalExit, reportCommandFailure } from "../../cli/exit.js";
import type { CliIo } from "../../cli/io.js";
import { runFamily } from "../../cli/owner.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";
import { alignedColumns, terminalText } from "../../shared/terminal-text.js";
import { remindersCommand } from "../reminders/owner.js";
import { todoReadBack } from "./tools.js";
import type { TodosCommandOptions } from "./parse.js";

/**
 * `tavi todos <action>`: the `reminders` command's to-do actions on a live
 * owner, acting as the workspace's operator; with none, the same actions on
 * the directory itself. Every action is a plain store write, so all of them
 * work offline (a due time reminds once the owner runs). `list` and `export`
 * read page after page until the last, so neither stops at one page's limit.
 */
export async function todosCliCommand(options: ResolvedDataDirectory<TodosCommandOptions>, io: CliIo): Promise<number> {
  const payload = todosPayload(options, `cli:${randomUUID()}`);
  const print = (result: unknown): number => {
    emit(io, options.format, result, () => todosResultText(options, result));
    return EXIT.ok;
  };
  /** The next page's payload: the same read from `cursor`. */
  const nextPage = (cursor: string): RemindersPayload => ({ ...payload, cursor }) as RemindersPayload;
  const codes = { NOT_FOUND: EXIT.usage };
  return runFamily(options.dataDirectory, "reminders", io, {
    label: `tavi todos ${options.action}`,
    mutates: options.action !== "list" && options.action !== "export",
    codes,
    build: async () => payload,
    render: async (result, client) => {
      if (payload.action !== "todos") return print(result);
      let page = TodosListAnswerSchema.parse(result);
      const todos = [...page.todos];
      while (page.nextCursor !== undefined) {
        const next = await client.request("reminders", nextPage(page.nextCursor), prefixedId("reminders"));
        if (!next.ok) throw new TaviError("UNAVAILABLE", terminalText(next.error?.message ?? "The owner refused the next page"));
        page = TodosListAnswerSchema.parse(next.result);
        todos.push(...page.todos);
      }
      return print({ ...page, todos });
    },
    offline: async (store) => {
      const deps = {
        repositories: store.asPort().repositories,
        principalOf: () => options.principalId ?? "operator",
        now: () => new Date(),
      };
      const refused = (error: { readonly code: string; readonly message: string }): number => {
        io.stderr(`${terminalText(error.message)}\n`);
        return error.code === "NOT_FOUND" ? codes.NOT_FOUND : configRefusalExit(error.code);
      };
      const answer = await remindersCommand(deps, payload);
      if (!answer.ok) return refused(answer.error);
      if (payload.action !== "todos") return print(answer.result);
      let page = TodosListAnswerSchema.parse(answer.result);
      const todos = [...page.todos];
      while (page.nextCursor !== undefined) {
        const next = await remindersCommand(deps, nextPage(page.nextCursor));
        if (!next.ok) return refused(next.error);
        page = TodosListAnswerSchema.parse(next.result);
        todos.push(...page.todos);
      }
      return print({ ...page, todos });
    },
    failed: (error) => reportCommandFailure(error, io, "todos command failed"),
  });
}

/** The `reminders` payload an action sends. */
export function todosPayload(options: TodosCommandOptions, operationKey: string): RemindersPayload {
  const workspaceId = options.workspaceId;
  switch (options.action) {
    case "list":
    case "export":
      return {
        action: "todos",
        workspaceId,
        statuses: options.action === "export" || options.all === true ? ["open", "done"] : ["open"],
        ...(options.list === undefined ? {} : { list: options.list }),
        ...(options.principalId === undefined ? {} : { principalId: options.principalId }),
        limit: REMINDER_LIST_MAX_LIMIT,
      };
    case "add":
      return {
        action: "todo-add",
        workspaceId,
        text: options.text ?? "",
        ...definedOnly({ list: options.list, notes: options.notes, due: options.due, principalId: options.principalId }),
        operationKey,
      };
    case "done":
    case "reopen":
      return { action: "todo-update", workspaceId, todoId: options.todoId ?? "", status: options.action === "done" ? "done" : "open" };
    case "remove":
      return { action: "todo-remove", workspaceId, todoId: options.todoId ?? "" };
  }
}

/**
 * One to-do as a Markdown checklist line: `- [ ] Buy milk (groceries, due 2026-10-30)`, a due
 * time as `list` says it, in the to-do's zone (`due Fri 6 Nov 17:00 Europe/London`).
 * A chat may have written its words from a page, so they reach the terminal without control characters.
 */
export function todoChecklistLine(todo: Todo): string {
  const due =
    todo.due === undefined
      ? ""
      : `, due ${todoDueIsTime(todo.due) ? `${formatReminderTime(new Date(todo.due), todo.timezone)} ${todo.timezone}` : todo.due}`;
  const notes = todo.notes === undefined ? "" : ` — ${terminalText(todo.notes.replace(/\s+/g, " "))}`;
  return `- [${todo.status === "done" ? "x" : " "}] ${terminalText(todo.text)}${notes} (${terminalText(todo.list)}${due})`;
}

function todosResultText(options: TodosCommandOptions, result: unknown): string {
  const answer = result as {
    readonly todos?: readonly Todo[];
    readonly todo?: Todo;
    readonly removed?: boolean;
    readonly duplicate?: true;
  };
  if (answer.todos !== undefined) {
    if (options.action === "export") {
      // Grouped by list, each a checklist: what a task app's import, or a person, reads.
      const lists = [...new Set(answer.todos.map((todo) => todo.list))];
      return `${lists
        .map(
          (list) =>
            `## ${terminalText(list)}\n\n${(answer.todos ?? [])
              .filter((todo) => todo.list === list)
              .map(todoChecklistLine)
              .join("\n")}`,
        )
        .join("\n\n")}\n`;
    }
    if (answer.todos.length === 0) return "No to-dos.\n";
    // The text first, its id last (what `done` and `remove` take), the ids lined up under each other.
    const rows = answer.todos.map((todo) => [
      `${terminalText(todo.text)}  (${terminalText(todoReadBack(todo))})`,
      terminalText(todo.todoId),
    ]);
    return `${alignedColumns(rows).join("\n")}\n`;
  }
  if (answer.removed !== undefined) return answer.removed ? "Removed.\n" : "There was no such to-do.\n";
  if (answer.todo !== undefined)
    return `${answer.duplicate === true ? "Already on the list: " : ""}${terminalText(answer.todo.text)}  (${terminalText(todoReadBack(answer.todo))})  ${terminalText(answer.todo.todoId)}\n`;
  return "\n";
}
