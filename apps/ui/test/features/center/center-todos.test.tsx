// @vitest-environment jsdom
import type { Todo } from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { dueText, Todos, todosByList } from "../../../src/features/center/Todos.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { InWorkspace } from "../../support/workspace.js";
import { clickSettled as click, mountSettled as mount, settle, unmountAll } from "../../support/dom.js";

/** The Command Center's to-do list: open to-dos by list, ticked off with their box, and an add line. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => unmountAll());

const stamp = "2026-10-01T10:00:00.000Z";
function todo(overrides: Partial<Todo> & Pick<Todo, "todoId" | "text">): Todo {
  return {
    workspaceId: "default",
    principalId: "operator",
    list: "inbox",
    status: "open",
    remindAt: null,
    timezone: "Europe/Berlin",
    deliverTo: { kind: "app" },
    createdBy: "agent",
    operationKey: `k-${overrides.todoId}`,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

const milk = todo({ todoId: "todo-1", text: "Buy milk", list: "groceries" });
const plumber = todo({ todoId: "todo-2", text: "Call the plumber", due: "2026-10-02T15:00:00.000Z", remindAt: "2026-10-02T15:00:00.000Z" });
const rent = todo({ todoId: "todo-3", text: "Pay rent", due: "2026-10-05" });

function owner(todos: readonly Todo[]) {
  const asked: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      asked.push(payload);
      if (command !== "reminders") return { ok: false, error: { code: "NOT_FOUND", message: "no" } } as never;
      if (payload["action"] === "todos") return { ok: true, result: { timezone: "Europe/Berlin", todos } } as never;
      return { ok: true, result: { todo: { ...milk, status: "done" } } } as never;
    },
  };
  return { client, asked };
}

describe("the to-do list", () => {
  it("groups open to-dos by list and says each due", () => {
    expect(todosByList([milk, plumber, rent]).map((group) => [group.list, group.todos.map((item) => item.text)])).toEqual([
      ["groceries", ["Buy milk"]],
      ["inbox", ["Call the plumber", "Pay rent"]],
    ]);
    expect(dueText(rent, "Europe/Berlin")).toBe("due Mon 5 Oct");
    expect(dueText(plumber, "Europe/Berlin")).toBe("due Fri 2 Oct 17:00");
    expect(dueText(milk, "Europe/Berlin")).toBeUndefined();
  });

  it("names the default list in the page's language, and a list the person named as they wrote it", async () => {
    await setLocale("bg");
    try {
      const { client } = owner([milk, rent]);
      const page = await mount(
        <InWorkspace client={client} workspaceId="default">
          <Todos revision={0} />
        </InWorkspace>,
      );
      expect([...page.querySelectorAll(".center-todo-list h3")].map((heading) => heading.textContent)).toEqual(["groceries", "Входящи"]);
    } finally {
      await setLocale("en");
    }
  });

  it("ticks a to-do off, and adds one", async () => {
    const { client, asked } = owner([milk, rent]);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Todos revision={0} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Buy milk");
    expect(page.textContent).toContain("groceries");
    // The section is named by its heading alone; the hint sits beside it.
    const heading = page.querySelector(`#${page.querySelector("section")?.getAttribute("aria-labelledby")}`);
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toBe("To-dos");
    expect(page.querySelector(".center-subhead")?.textContent).toContain("ask in any chat");
    const box = page.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await click(box);
    expect(asked).toContainEqual({ action: "todo-update", workspaceId: "default", todoId: "todo-1", status: "done" });
    const input = page.querySelector<HTMLInputElement>('input[aria-label="New to-do"]');
    if (input === null) throw new Error("no add line");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Water plants");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form?.requestSubmit();
    });
    await settle();
    expect(asked.find((payload) => payload["action"] === "todo-add")).toMatchObject({ text: "Water plants", workspaceId: "default" });
  });
});
