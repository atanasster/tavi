// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Schedule } from "../../../src/features/center/Schedule.js";
import { MINUTE_TICK_MS } from "../../../src/hooks/use-poll.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mountSettled, rerender, settle } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * Schedule stays current on an idle page: an open schedule or reminder page is
 * read again as the feed moves, "in 10 min" moves each minute, the Recurring
 * count waits for every list, and a blocked routine's switch says it is blocked.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.useRealTimers());

/** An owner recording each `command action` asked; `answer` gives a result, or a promise of one, per request. */
function owner(answer: (command: string, action: string) => unknown) {
  const asked: string[] = [];
  const client: SettingsClient = {
    request: async (command, raw) => {
      const action = String((raw as Record<string, unknown>)["action"]);
      asked.push(`${command} ${action}`);
      const result = await answer(command, action);
      return result === undefined
        ? ({ ok: false, error: { code: "NOT_FOUND", message: "not found" } } as never)
        : ({ ok: true, result } as never);
    },
  };
  return { client, count: (what: string) => asked.filter((item) => item === what).length };
}

const empty = (command: string, action: string): unknown =>
  command === "schedules" && action === "agenda"
    ? { timezone: "UTC", items: [], truncated: false, skipped: [] }
    : command === "schedules" && action === "list"
      ? { schedules: [], truncated: false }
      : command === "routines" && action === "list"
        ? { routines: [] }
        : command === "reminders" && (action === "list" || action === "fires")
          ? { timezone: "UTC", reminders: [], fires: [] }
          : command === "todos"
            ? { todos: [] }
            : undefined;

const view = (client: SettingsClient, props: Partial<Parameters<typeof Schedule>[0]> = {}) => (
  <InWorkspace client={client} workspaceId="default">
    <Schedule summary={undefined} revision={0} onOpenRoutine={() => undefined} onFollow={async () => {}} {...props} />
  </InWorkspace>
);

const plain = (nextRunAt: string) => ({
  scheduleId: "s1",
  workspaceId: "default",
  principalId: "operator",
  name: "Morning brief",
  prompt: "Summarise",
  spec: { at: "07:00", timezone: "UTC" },
  enabled: true,
  nextRunAt,
  lastRunAt: null,
  lastRunTaskId: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  createdAt: "x",
  updatedAt: "x",
});

describe("an open page under Schedule", () => {
  it("reads a schedule's page again when the feed moves", async () => {
    const fake = owner(empty);
    await mountSettled(view(fake.client, { scheduleId: "s1" }));
    expect([fake.count("schedules show"), fake.count("schedules history")]).toEqual([1, 1]);
    await rerender(view(fake.client, { scheduleId: "s1", revision: 1 }));
    await settle();
    expect([fake.count("schedules show"), fake.count("schedules history")]).toEqual([2, 2]);
  });

  it("reads a reminder's page again when the feed moves", async () => {
    const fake = owner(empty);
    await mountSettled(view(fake.client, { reminderId: "rem-1", reminders: true }));
    expect(fake.count("reminders get")).toBe(1);
    await rerender(view(fake.client, { reminderId: "rem-1", reminders: true, revision: 1 }));
    await settle();
    expect(fake.count("reminders get")).toBe(2);
  });
});

describe("the lists", () => {
  it("moves a relative time each minute with no feed event", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-28T06:00:00.000Z"));
    const fake = owner((command, action) =>
      command === "schedules" && action === "list"
        ? { schedules: [plain("2026-10-28T06:10:00.000Z")], truncated: false }
        : empty(command, action),
    );
    const page = await mountSettled(view(fake.client));
    const row = () => page.querySelector(".schedule-recurring-list")?.textContent ?? "";
    expect(row()).toContain("in 10 min");
    await act(async () => vi.advanceTimersByTime(MINUTE_TICK_MS));
    expect(row()).toContain("in 9 min");
    expect(fake.count("schedules list")).toBe(1);
  });

  it("shows the Recurring count only once every list is read", async () => {
    let routinesAnswer: (value: unknown) => void = () => {};
    const routines = new Promise((resolve) => (routinesAnswer = resolve));
    let remindersAnswer: (value: unknown) => void = () => {};
    const reminders = new Promise((resolve) => (remindersAnswer = resolve));
    const fake = owner((command, action) =>
      command === "routines" && action === "list"
        ? routines
        : command === "reminders" && action === "list"
          ? reminders
          : command === "schedules" && action === "list"
            ? { schedules: [plain("2026-10-28T06:10:00.000Z")], truncated: false }
            : empty(command, action),
    );
    const page = await mountSettled(view(fake.client, { reminders: true }));
    const count = () => page.querySelector(".schedule-recurring-head > span")?.textContent;
    expect(count()).toBe("");
    routinesAnswer({
      routines: [
        {
          routineId: "r1",
          workspaceId: "default",
          principalId: "operator",
          name: "LLM news",
          status: "active",
          version: 1,
          activeRevision: 1,
          latestRevision: 1,
          lastRun: null,
        },
      ],
    });
    await settle();
    expect(count()).toBe("");
    remindersAnswer({ timezone: "UTC", reminders: [] });
    await settle();
    expect(count()).toBe("2");
  });

  it("marks a credential-blocked routine's switch as a warning, and says why", async () => {
    const fake = owner((command, action) =>
      command === "routines" && action === "list"
        ? {
            routines: [
              {
                routineId: "r1",
                workspaceId: "default",
                principalId: "operator",
                name: "LLM news",
                status: "credential-blocked",
                version: 1,
                activeRevision: 1,
                latestRevision: 1,
                lastRun: null,
              },
              {
                routineId: "r2",
                workspaceId: "default",
                principalId: "operator",
                name: "Weekly digest",
                status: "active",
                version: 1,
                activeRevision: 1,
                latestRevision: 1,
                lastRun: null,
              },
            ],
          }
        : empty(command, action),
    );
    const page = await mountSettled(view(fake.client));
    const blocked = page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Pause LLM news"]');
    expect(blocked?.classList.contains("switch-warning")).toBe(true);
    const described = document.getElementById(blocked?.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toContain("Research is blocked");
    const fine = page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Pause Weekly digest"]');
    expect(fine?.classList.contains("switch-warning")).toBe(false);
    expect(fine?.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("a due to-do in Coming up", () => {
  it("is said as a to-do and opens the to-do list, not a reminder page", async () => {
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const fake = owner((command, action) =>
      command === "schedules" && action === "agenda"
        ? {
            timezone: "UTC",
            items: [
              { kind: "reminder", id: "todo-1", title: "Call the plumber", at, cadence: { kind: "once" }, enabled: true },
              { kind: "reminder", id: "rem-1", title: "Stretch", at, cadence: { kind: "once" }, enabled: true },
            ],
            truncated: false,
            skipped: [],
          }
        : command === "reminders" && action === "todos"
          ? {
              timezone: "UTC",
              todos: [
                {
                  todoId: "todo-1",
                  workspaceId: "default",
                  principalId: "operator",
                  text: "Call the plumber",
                  list: "inbox",
                  status: "open",
                  due: at,
                  remindAt: at,
                  timezone: "UTC",
                  deliverTo: { kind: "app" },
                  createdBy: "agent",
                  operationKey: "k-1",
                  createdAt: "2026-10-01T00:00:00.000Z",
                  updatedAt: "2026-10-01T00:00:00.000Z",
                },
              ],
            }
          : empty(command, action),
    );
    const page = await mountSettled(view(fake.client, { reminders: true }));
    const rows = [...page.querySelectorAll(".schedule-timeline .schedule-item")];
    const row = (title: string) => rows.find((item) => item.querySelector(".schedule-title")?.textContent === title);
    expect(row("Call the plumber")?.querySelector(".schedule-kind")?.textContent).toBe("To-do");
    expect(row("Call the plumber")?.querySelector("a")?.getAttribute("href")).toBe("/center/schedule");
    expect(row("Stretch")?.querySelector(".schedule-kind")?.textContent).toBe("Reminder");
  });
});
