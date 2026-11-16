// @vitest-environment jsdom
import { initialRunState } from "@tavi/client/browser";
import type { ReminderView } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { Schedule, chatScheduleOf } from "../../../src/features/chat-panel/Schedule.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { Session } from "../../../src/features/shell/shell.js";
import { InWorkspace } from "../../support/workspace.js";
import { mountSettled as mount } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-10-01T10:00:00.000Z";
const reminder = (
  reminderId: string,
  text: string,
  originTaskId: string | undefined,
  status: ReminderView["status"] = "active",
): ReminderView => ({
  reminderId,
  workspaceId: "default",
  principalId: "operator",
  text,
  when: { kind: "once", at: "2026-10-03T09:00:00.000Z" },
  timezone: "UTC",
  deliverTo: { kind: "app" },
  status,
  nextFireAt: status === "active" ? "2026-10-03T09:00:00.000Z" : null,
  lastFiredAt: null,
  createdBy: "agent",
  ...(originTaskId === undefined ? {} : { originTaskId }),
  operationKey: reminderId,
  createdAt: at,
  updatedAt: at,
  upcoming: [],
});
const session: Session = {
  key: "task-1",
  taskId: "task-1",
  title: "t",
  status: "completed",
  runs: [
    { id: "ui-1", prompt: "p", run: { ...initialRunState(), taskId: "task-1" }, roundCalls: {}, deciding: undefined, aborting: false },
  ],
};

describe("the chat panel's Schedule tab", () => {
  it("keeps the reminders the owner listed for the chat — a delegated task's carry its chat's id — and names a schedule that started it", () => {
    const found = chatScheduleOf(
      { origin: "schedule", originScheduleId: "s1" },
      [{ scheduleId: "s1", name: "Morning digest", routineId: "routine-1" }],
      [reminder("r1", "Call the bank", "task-1"), reminder("r2", "Asked in its chat", "chat-root")],
      { reminderId: "r2", text: "ignored: a schedule started it" },
    );
    expect(found.origin).toEqual({ kind: "schedule", scheduleId: "s1", name: "Morning digest", routineId: "routine-1" });
    expect(found.reminders.map((item) => item.text)).toEqual(["Call the bank", "Asked in its chat"]);
  });

  it("names the reminder whose fire started the chat, read by the reminder its task is keyed by", async () => {
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        const input = payload as Record<string, unknown>;
        sent.push([command, input["action"], input["reminderId"] ?? input["originTaskId"]]);
        if (command === "tasks")
          return {
            ok: true,
            result: {
              task: { origin: "reminder", originScheduleId: null, creationOperationKey: `reminder:rem-7:${"2026-10-01T09:00:00.000Z"}` },
              admissions: [],
            },
          };
        if (command === "reminders" && input["action"] === "get")
          return { ok: true, result: { reminder: reminder("rem-7", "Water the plants", undefined, "cancelled"), fires: [] } };
        if (command === "reminders") return { ok: true, result: { timezone: "UTC", reminders: [] } };
        return { ok: false, error: { code: "UNAVAILABLE", message: "no" } };
      },
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule session={session} reminders onOpenReminder={() => undefined} onOpenRoutine={() => undefined} />
      </InWorkspace>,
    );
    expect(page.querySelector('[aria-label="what started this chat"]')?.textContent).toContain("Water the plants");
    expect(sent).toContainEqual(["reminders", "get", "rem-7"]);
  });

  it("asks an owner without reminders only about the schedule that started the chat, and opens a routine's page", async () => {
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (command) => {
        sent.push(command);
        if (command === "tasks") return { ok: true, result: { task: { origin: "schedule", originScheduleId: "s1" }, admissions: [] } };
        if (command === "schedules")
          return {
            ok: true,
            result: { schedules: [{ scheduleId: "s1", name: "Morning digest", routineId: "routine-1" }], truncated: false },
          };
        return { ok: false, error: { code: "UNAVAILABLE", message: `${command} is unavailable` } };
      },
    };
    const onOpenRoutine = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule session={session} reminders={false} onOpenReminder={() => undefined} onOpenRoutine={onOpenRoutine} />
      </InWorkspace>,
    );
    expect(sent).toEqual(["tasks", "schedules"]);
    const started = page.querySelector('[aria-label="what started this chat"]');
    expect(started?.textContent).toContain("The routine Morning digest");
    expect(page.querySelector('[aria-label="reminders from this chat"]')).toBeNull();
    await act(async () => (started?.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenRoutine).toHaveBeenCalledWith("routine-1");
  });

  it("lists the chat's reminders, each opening its page", async () => {
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        sent.push([command, (payload as { action?: string }).action]);
        if (command === "reminders") expect((payload as { originTaskId?: string }).originTaskId).toBe("task-1");
        if (command === "tasks") return { ok: true, result: { task: { origin: "ipc", originScheduleId: null }, admissions: [] } };
        if (command === "reminders")
          return (payload as { action: string }).action === "list"
            ? {
                ok: true,
                result: {
                  timezone: "UTC",
                  reminders: [reminder("r1", "Call the bank", "task-1"), reminder("r3", "Done one", "task-1", "done")],
                },
              }
            : { ok: true, result: { fires: [] } };
        return { ok: false, error: { code: "UNAVAILABLE", message: "no" } };
      },
    };
    const onOpenReminder = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule session={session} reminders onOpenReminder={onOpenReminder} onOpenRoutine={() => undefined} />
      </InWorkspace>,
    );
    // No schedule or reminder started it: neither is read, and the owner filters the chat's reminders.
    expect(sent).toEqual([
      ["tasks", undefined],
      ["reminders", "list"],
    ]);
    const rows = [...page.querySelectorAll('[aria-label="reminders from this chat"] button.chat-panel-item')];
    expect(rows.map((row) => row.textContent)).toEqual(["Call the bankOnce · next Sat 3 Oct 09:00", "Done oneOnce · done"]);
    await act(async () => (rows[0] as HTMLButtonElement).click());
    expect(onOpenReminder).toHaveBeenCalledWith("r1");
    expect(page.querySelector('[aria-label="what started this chat"]')).toBeNull();
  });

  it("asks for a reminder about the chat from the tab, and lists it", async () => {
    const created: Record<string, unknown>[] = [];
    let listed: ReminderView[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        const input = payload as Record<string, unknown>;
        if (command === "tasks") return { ok: true, result: { task: { origin: "ipc", originScheduleId: null }, admissions: [] } };
        if (command === "reminders" && input["action"] === "create") {
          created.push(input);
          const made = reminder("r-new", String(input["text"]), "task-1");
          listed = [made];
          return { ok: true, result: { reminder: made, created: true, skippedNotices: [] } };
        }
        if (command === "reminders") return { ok: true, result: { timezone: "UTC", reminders: listed } };
        if (command === "routines") return { ok: true, result: { targets: [] } };
        return { ok: false, error: { code: "UNAVAILABLE", message: "no" } };
      },
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule session={session} reminders onOpenReminder={() => undefined} onOpenRoutine={() => undefined} />
      </InWorkspace>,
    );
    await act(async () =>
      ([...page.querySelectorAll("button")].find((node) => node.textContent === "Remind me about this chat…") as HTMLButtonElement).click(),
    );
    const form = page.querySelector('form[aria-label="New reminder"]') as HTMLFormElement;
    const text = form.querySelector('input[type="text"], textarea, input:not([type])') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(text), "value")?.set;
    await act(async () => {
      setter?.call(text, "Check the audit");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => form.requestSubmit());
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(created[0]).toMatchObject({ text: "Check the audit", originTaskId: "task-1" });
    expect(page.querySelector('form[aria-label="New reminder"]')).toBeNull();
    expect(page.querySelector('[aria-label="reminders from this chat"]')?.textContent).toContain("Check the audit");
  });

  it("says when the owner could not answer", async () => {
    const page = await mount(
      <InWorkspace
        client={{ request: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "tasks is unavailable" } }) }}
        workspaceId="default"
      >
        <Schedule session={session} reminders onOpenReminder={() => undefined} onOpenRoutine={() => undefined} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("tasks is unavailable");
  });
});
