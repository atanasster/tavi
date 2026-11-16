import { join } from "node:path";
import Database from "better-sqlite3";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";

/** To-dos in the reminders store: a row with no fire time, kept apart from reminders, paged oldest first. */

const directories = temporaryDirectories({ prefix: "tavi-todos-" });
afterEach(() => directories.cleanup());

const NOW = "2026-10-01T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const reminders = store.asPort().repositories.reminders;
  let serial = 0;
  const add = (text: string, extra: { list?: string; due?: string; now?: string } = {}) => {
    serial += 1;
    return reminders.createTodo({
      todoId: `todo-${serial}`,
      workspaceId: "default",
      principalId: "operator",
      text,
      timezone: "UTC",
      deliverTo: { kind: "app" },
      createdBy: "user",
      operationKey: `op-${serial}`,
      now: extra.now ?? later(serial),
      ...(extra.list === undefined ? {} : { list: extra.list }),
      ...(extra.due === undefined ? {} : { due: extra.due }),
    });
  };
  return { store, reminders, add };
}

describe("to-dos in the reminders store", () => {
  it("pages oldest first, by list and status, and never lists a to-do among reminders", async () => {
    const { store, reminders, add } = fixture();
    try {
      await add("One", { list: " Work " });
      await add("Two");
      await add("Three", { list: "work" });
      const first = await reminders.listTodos({ workspaceId: "default", limit: 2 });
      expect(first.todos.map((todo) => todo.text)).toEqual(["One", "Two"]);
      const rest = await reminders.listTodos({
        workspaceId: "default",
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      });
      expect(rest.todos.map((todo) => todo.text)).toEqual(["Three"]);
      expect((await reminders.listTodos({ workspaceId: "default", list: "WORK", limit: 10 })).todos.map((todo) => todo.text)).toEqual([
        "One",
        "Three",
      ]);
      expect((await reminders.list({ workspaceId: "default", limit: 10 })).reminders).toEqual([]);
      await reminders.updateTodo({ todoId: "todo-2", status: "done", now: later(10) });
      expect((await reminders.listTodos({ workspaceId: "default", limit: 10 })).todos.map((todo) => todo.text)).toEqual(["One", "Three"]);
      expect(await reminders.getTodo("todo-2")).toMatchObject({ status: "done", completedAt: later(10) });
    } finally {
      store.close();
    }
  });

  it("a due time fires once as a reminder; a due date and a past time do not; a stale change is a conflict", async () => {
    const { store, reminders, add } = fixture();
    try {
      const timed = await add("Call", { due: "2026-10-01T15:00:00+02:00" });
      expect(timed.todo).toMatchObject({ due: "2026-10-01T13:00:00.000Z", remindAt: "2026-10-01T13:00:00.000Z" });
      expect((await add("Rent", { due: "2026-10-05" })).todo.remindAt).toBeNull();
      expect((await add("Late", { due: "2026-09-30T09:00:00Z" })).todo.remindAt).toBeNull();
      const claimed = await reminders.claimDue({ now: "2026-10-01T13:00:10.000Z", limit: 10 });
      expect(claimed.claimed.map((fire) => fire.reminder.reminderId)).toEqual(["todo-1"]);
      expect(() =>
        reminders.updateTodo({ todoId: "todo-1", expectedUpdatedAt: "2020-01-01T00:00:00.000Z", text: "x", now: later(20) }),
      ).toThrow(/changed since it was read/);
      const stored = await reminders.getTodo("todo-1");
      expect(() =>
        reminders.update({ reminderId: "todo-1", expectedUpdatedAt: stored?.updatedAt ?? "", text: "x", now: later(20) }),
      ).toThrow(/That is a to-do/);
      expect(await reminders.removeTodo({ todoId: "todo-1" })).toBe(true);
      expect(await reminders.removeTodo({ todoId: "todo-1" })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("is never cancelled, paused or resumed as a reminder", async () => {
    const { store, reminders, add } = fixture();
    try {
      const { todo } = await add("Call", { due: "2026-10-01T15:00:00Z" });
      for (const action of ["cancel", "pause", "resume"] as const)
        expect(() => reminders.transition({ reminderId: todo.todoId, action, now: later(30) })).toThrow(/That is a to-do/);
      expect(await reminders.getTodo(todo.todoId)).toMatchObject({ status: "open", remindAt: "2026-10-01T15:00:00.000Z" });
    } finally {
      store.close();
    }
  });

  it("ticked off with a delivery waiting to be retried, it does not remind", async () => {
    const { store, reminders, add } = fixture();
    try {
      const { todo } = await add("Call", { due: "2026-10-01T13:00:00Z" });
      expect((await reminders.claimDue({ now: "2026-10-01T13:00:05.000Z", limit: 10 })).claimed).toHaveLength(1);
      reminders.recordOutcome({
        reminderId: todo.todoId,
        fireAt: "2026-10-01T13:00:00.000Z",
        outcome: "retry",
        retryAt: "2026-10-01T13:00:35.000Z",
        now: "2026-10-01T13:00:05.000Z",
      });
      await reminders.updateTodo({ todoId: todo.todoId, status: "done", now: "2026-10-01T13:00:10.000Z" });
      expect((await reminders.claimDue({ now: "2026-10-01T13:01:00.000Z", limit: 10 })).claimed).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("a reminder made before 0011 stays a reminder: listed, and still fired", async () => {
    const dir = directories.create();
    const databasePath = join(dir, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0011_todos"),
        ),
      );
      pre
        .prepare(
          `INSERT INTO tavi_reminders (reminder_id, workspace_id, principal_id, text, prompt, when_json, timezone, deliver_to_json,
             status, next_fire_at, schedule_cursor_at, created_by, operation_key, created_at, updated_at)
           VALUES ('rem-old', 'default', 'operator', 'Stretch', NULL, ?, 'UTC', ?, 'active', ?, ?, 'user', 'op-old', ?, ?)`,
        )
        .run(
          JSON.stringify({ kind: "once", at: "2026-10-01T13:00:00.000Z" }),
          JSON.stringify({ kind: "app" }),
          "2026-10-01T13:00:00.000Z",
          NOW,
          NOW,
          NOW,
        );
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath, artifactsDirectory: join(dir, "artifacts") });
    try {
      const reminders = store.asPort().repositories.reminders;
      const old = await reminders.get("rem-old");
      expect(old).toMatchObject({ reminderId: "rem-old", text: "Stretch", status: "active" });
      expect(old?.kind).toBeUndefined();
      expect(await reminders.getTodo("rem-old")).toBeUndefined();
      expect((await reminders.list({ workspaceId: "default", limit: 10 })).reminders.map((reminder) => reminder.reminderId)).toEqual([
        "rem-old",
      ]);
      expect((await reminders.listTodos({ workspaceId: "default", limit: 10 })).todos).toEqual([]);
      const claimed = await reminders.claimDue({ now: "2026-10-01T13:00:05.000Z", limit: 10 });
      expect(claimed.claimed.map((fire) => fire.reminder.reminderId)).toEqual(["rem-old"]);
    } finally {
      store.close();
    }
  });
});
