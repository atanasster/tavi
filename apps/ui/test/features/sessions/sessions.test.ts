import { describe, expect, it } from "vitest";
import {
  directoryGroup,
  directoryLayout,
  fetchSessionPreferences,
  loadSessionPreferences,
  saveSessionPreferences,
  sessionFilters,
  storeSessionPreferences,
} from "../../../src/features/sessions/sessions.js";
import type { TaskListRow } from "@tavi/contracts";

describe("session search and tab preferences", () => {
  it("parses prefixes and keeps ordinary keywords", () => {
    expect(sessionFilters("origin:schedule broken report status:failed")).toEqual({
      origin: ["schedule"],
      status: ["failed"],
      query: "broken report",
    });
    expect(() => sessionFilters("status:bogus")).toThrow(/Unknown status/);
  });
  it("survives a reload in one storage instance without sharing another", () => {
    const tab = new Map<string, string>();
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => void tab.set(key, value) };
    const preferences = { pins: ["a"], archived: ["b"], seen: { a: "now" } };
    saveSessionPreferences(preferences, storage);
    expect(loadSessionPreferences(storage)).toEqual(preferences);
    expect(loadSessionPreferences()).toEqual({ pins: [], archived: [], seen: {} });
    expect(loadSessionPreferences({ getItem: () => "broken" }).pins).toEqual([]);
  });
  it("asks the owner for the panel's preferences and treats a refusal as absence", async () => {
    const asked: unknown[] = [];
    const preferences = { pins: ["a"], archived: ["b"], seen: { a: "now" } };
    const client = {
      request: async (command: string, payload: unknown) => {
        asked.push([command, payload]);
        return { ok: true, result: { preferences } } as never;
      },
    };
    expect(await fetchSessionPreferences(client, "default")).toEqual(preferences);
    expect(await storeSessionPreferences(client, "default", preferences)).toBe(true);
    expect(asked).toEqual([
      ["ui-preferences", { action: "get", workspaceId: "default" }],
      ["ui-preferences", { action: "set", workspaceId: "default", preferences }],
    ]);
    expect(await fetchSessionPreferences({ request: async () => ({ ok: false }) as never }, "default")).toBeUndefined();
    expect(
      await fetchSessionPreferences({ request: async () => ({ ok: true, result: { preferences: { pins: [1] } } }) as never }, "default"),
    ).toBeUndefined();
    expect(
      await storeSessionPreferences(
        {
          request: async () => {
            throw new Error("gone");
          },
        },
        "default",
        preferences,
      ),
    ).toBe(false);
  });
  it("prioritizes needs even on a finished task, then groups completion dates", () => {
    expect(directoryGroup({ status: "completed", needs: ["review"] } as TaskListRow, "UTC")).toBe("Needs you");
    expect(directoryGroup({ status: "completed", needs: [], updatedAt: "2026-09-20T00:00:00Z" } as unknown as TaskListRow, "UTC")).toBe(
      "Completed · 2026-09-20",
    );
  });
  it("groups a completed session by its day in the workspace zone, not UTC's", () => {
    const late = { status: "completed", needs: [], updatedAt: "2026-09-19T23:30:00Z" } as unknown as TaskListRow;
    // 23:30 UTC is 01:30 the next day in Berlin, and 19:30 the same day in New York.
    expect(directoryGroup(late, "Europe/Berlin")).toBe("Completed · 2026-09-20");
    expect(directoryGroup(late, "America/New_York")).toBe("Completed · 2026-09-19");
  });
  it("gives a stopped chat a heading of its own: a stop is not a completion", () => {
    const stopped = { status: "stopped", needs: [], updatedAt: "2026-09-20T10:00:00Z" } as unknown as TaskListRow;
    expect(directoryGroup(stopped, "UTC")).toBe("Stopped · 2026-09-20");
    expect(directoryGroup({ ...stopped, needs: ["approval"] }, "UTC")).toBe("Needs you");
  });
  const row = (taskId: string, extra: Partial<TaskListRow> = {}): TaskListRow =>
    ({ taskId, status: "completed", needs: [], updatedAt: "2026-09-20T10:00:00Z", title: taskId, ...extra }) as unknown as TaskListRow;
  it("orders stopped chats among the days, newest first, stopped before completed on one day", () => {
    const layout = directoryLayout(
      [
        row("old-stop", { status: "stopped", updatedAt: "2026-09-18T10:00:00Z" }),
        row("done", { updatedAt: "2026-09-20T10:00:00Z" }),
        row("stop", { status: "stopped", updatedAt: "2026-09-20T09:00:00Z" }),
        row("older-done", { updatedAt: "2026-09-19T10:00:00Z" }),
        row("going", { status: "working" }),
        row("asks", { needs: ["question"] }),
      ],
      false,
      "UTC",
    );
    expect(layout.sections.map((section) => section.label)).toEqual([
      "Needs you",
      "Working",
      "Stopped · 2026-09-20",
      "Completed · 2026-09-20",
      "Completed · 2026-09-19",
      "Stopped · 2026-09-18",
    ]);
  });
  it("lists a run that needs the reader under Needs you, not Activity", () => {
    const layout = directoryLayout(
      [
        row("home", { chatKind: "home", principalId: "alice" }),
        row("fire", { chatKind: "run", needs: ["approval"] }),
        row("done-run", { chatKind: "run" }),
      ],
      true,
      "UTC",
      "alice",
    );
    expect(layout.sections.map((section) => [section.label, section.rows.map((item) => item.taskId)])).toEqual([
      ["Home", ["home"]],
      ["Needs you", ["fire"]],
      ["Activity", ["done-run"]],
    ]);
  });
  it("pins the reader's Home on top as an ordinary chat, under no Home heading, with chat.home off", () => {
    const rows = [
      row("chat-a", { updatedAt: "2026-09-21T10:00:00Z" }),
      row("home", { chatKind: "home", principalId: "alice", title: "Home" }),
      row("bob-home", { chatKind: "home", principalId: "bob" }),
    ];
    const layout = directoryLayout(rows, false, "UTC", "alice");
    expect(layout.sections.map((section) => [section.kind, section.rows.map((item) => item.taskId)])).toEqual([
      ["pinned", ["home"]],
      ["status", ["chat-a"]],
      ["status", ["bob-home"]],
    ]);
    expect(layout.sections.some((section) => section.label === "Home")).toBe(false);
    // Without knowing whose it is, no Home is pinned.
    expect(directoryLayout(rows, false, "UTC").sections.every((section) => section.kind === "status")).toBe(true);
  });
});
