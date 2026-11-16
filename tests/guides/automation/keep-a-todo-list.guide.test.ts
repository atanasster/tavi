import { expect } from "vitest";

import { inDays, SEED_ZONE, spanning } from "../support/automation.js";
import { dismissChecklist, homeId, lastAnswer, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Todo {
  readonly todoId: string;
  readonly text: string;
  readonly list: string;
  readonly status: string;
  readonly remindAt?: string | null;
}
interface Todos {
  readonly todos: readonly Todo[];
}

type Walk = { taviJson<T>(...args: string[]): T };
const todos = (walk: Walk): readonly Todo[] => walk.taviJson<Todos>("todos", "list", "--all").todos;
const groceries = (walk: Walk): readonly Todo[] => todos(walk).filter((todo) => todo.list === "groceries");

walkGuide("automation/keep-a-todo-list", {
  configured: true,
  model: true,
  seed: [[...SEED_ZONE]],
  steps: {
    "ask-tavi-to-add-to-your-list": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(page, "Add milk and eggs to my groceries list.");
      // Two to-dos on the list named, added without an approval card.
      expect(groceries(walk).map((todo) => todo.text.toLowerCase())).toEqual(
        expect.arrayContaining([expect.stringMatching(/milk/), expect.stringMatching(/eggs/)]),
      );
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("todos.add");
      await expect(page.getByText("Needs your approval").count()).resolves.toBe(0);
      const answer = await lastAnswer(page);
      await walk.shot(answer, { mask: [answer.locator(".text")] });
    },
    "add-one-with-a-due-time": async (walk) => {
      const due = `${inDays(3)}T17:00+00:00`;
      const screen = await walk.terminal({
        title: "tavi todos add",
        args: ["todos", "add", "Call the plumber", "--due", due, "--notes", "the leak under the sink"],
        // The line ends with the to-do's id: wide enough not to break it.
        cols: 144,
      });
      expect(screen.join("\n")).toContain("I'll remind you then");
      const plumber = todos(walk).find((todo) => todo.text === "Call the plumber");
      expect(plumber?.list).toBe("inbox");
      expect(plumber?.remindAt).toBe(new Date(due).toISOString());
    },
    "tick-one-off-in-the-command-center": async (walk) => {
      const page = await walk.open("/center/schedule");
      const region = page.getByRole("region", { name: /^To-dos/ });
      await region.getByRole("checkbox", { name: "Call the plumber" }).waitFor();
      await region.scrollIntoViewIfNeeded();
      await walk.shot(region);
      const milk = groceries(walk).find((todo) => /milk/i.test(todo.text));
      await region.getByRole("checkbox", { name: milk?.text ?? "" }).click();
      await expect.poll(() => todos(walk).find((todo) => todo.todoId === milk?.todoId)?.status, { timeout: 15_000 }).toBe("done");
    },
    "choose-where-your-to-dos-live": async (walk) => {
      const page = await walk.open("/settings/general");
      const heading = page.getByRole("heading", { name: "Your to-do list" });
      const choice = page.getByRole("combobox", { name: "to-do list" });
      await heading.scrollIntoViewIfNeeded();
      await expect(choice.textContent()).resolves.toContain("Tavi");
      expect(walk.tavi("config", "get", "tasks.home")).toMatch(/tasks\.home = tavi/);
      const span = await spanning(page, heading, choice);
      await walk.shot(span.box);
      await span.remove();
    },
    "take-your-list-with-you": async (walk) => {
      const screen = await walk.terminal({ title: "tavi todos export", args: ["todos", "export"] });
      const text = screen.join("\n");
      expect(text).toContain("## groceries");
      expect(text).toMatch(/- \[x\] .*milk/i);
      expect(text).toContain("- [ ] Call the plumber");
    },
  },
});
