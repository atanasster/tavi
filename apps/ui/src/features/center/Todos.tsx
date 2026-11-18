import type { Todo, TodosListAnswer } from "@tavi/contracts";
import { useState, type FormEvent } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import type { Outcome } from "../../lib/ipc.js";
import { Button } from "../../ui/Button.js";
import { Icon } from "../../ui/Icon.js";
import { Failure, LoadError } from "../../ui/Parts.js";
import { useWorkspace } from "../shell/Workspace.js";
import { addTodo, listTodos, setTodoStatus } from "./reminders-api.js";
import { shortDay } from "../../lib/time.js";

/**
 * To-dos in Schedule: the workspace's open to-dos (the same list a chat adds
 * to with `todos.add`), grouped by list, each ticked off with its box, and an
 * add line at the foot. A to-do's due time also reminds, so it shows in Coming
 * up as well. Done ones leave the list; `tavi todos export` writes them all.
 */

/** Open to-dos by list, the lists in the order their first to-do was written. */
export function todosByList(todos: readonly Todo[]): readonly { readonly list: string; readonly todos: readonly Todo[] }[] {
  const lists = new Map<string, Todo[]>();
  for (const todo of todos) lists.set(todo.list, [...(lists.get(todo.list) ?? []), todo]);
  return [...lists].map(([list, items]) => ({ list, todos: items }));
}

/** A to-do's due as the row says it: a date as a short day ("Mon 5 Oct"), a time in the workspace's zone. */
export function dueText(todo: Todo, timeZone: string): string | undefined {
  if (todo.due === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(todo.due)) return `due ${shortDay(todo.due)}`;
  const at = new Date(todo.due).toLocaleString("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `due ${at}`;
}

export function Todos({ revision }: { readonly revision: number }) {
  const { client, workspaceId } = useWorkspace();
  const todos = useLoaded<TodosListAnswer>(() => listTodos(client, workspaceId), [revision]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  const run = async (write: () => Promise<Outcome<unknown>>): Promise<boolean> => {
    setBusy(true);
    setFailed(undefined);
    const outcome = await write();
    setBusy(false);
    if (!outcome.ok) {
      setFailed(outcome.message);
      return false;
    }
    todos.reload();
    return true;
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const words = text.trim();
    if (words === "") return;
    const operationKey = `canvas:${crypto.randomUUID()}`;
    if (await run(() => addTodo(client, workspaceId, { text: words, operationKey }))) setText("");
  };

  const zone = todos.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const groups = todosByList(todos.data?.todos ?? []);
  return (
    <section className="center-todos" aria-labelledby="center-todos-title">
      {/* The hint sits beside the heading, not in it: the heading's name is "To-dos". */}
      <div className="center-subhead">
        <h2 id="center-todos-title">To-dos</h2> <span>ask in any chat: “add milk to my list”</span>
      </div>
      {todos.error ? <LoadError error={todos.error} reload={todos.reload} /> : null}
      {todos.data !== undefined && groups.length === 0 ? <p className="meta-sm">Nothing on your list.</p> : null}
      {groups.map((group) => (
        <div key={group.list} className="center-todo-list">
          <h3 className="meta-sm">{group.list}</h3>
          <ul className="schedule-recurring-list card-flat list-reset">
            {group.todos.map((todo) => {
              const due = dueText(todo, zone);
              return (
                <li key={todo.todoId} className="center-todo">
                  <label>
                    <input
                      type="checkbox"
                      checked={todo.status === "done"}
                      disabled={busy}
                      onChange={() =>
                        void run(() => setTodoStatus(client, workspaceId, todo.todoId, todo.status === "done" ? "open" : "done"))
                      }
                    />{" "}
                    <span>{todo.text}</span>
                  </label>
                  {due === undefined ? null : <span className="meta-sm"> · {due}</span>}
                  {todo.notes === undefined ? null : <p className="meta-sm">{todo.notes}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <form className="center-todo-add" onSubmit={(event) => void submit(event)}>
        <input
          type="text"
          aria-label="New to-do"
          placeholder="Add a to-do"
          maxLength={500}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={busy || text.trim() === ""}>
          <Icon name="plus" size="sm" />
          Add
        </Button>
      </form>
      {failed === undefined ? null : <Failure message={failed} />}
    </section>
  );
}
