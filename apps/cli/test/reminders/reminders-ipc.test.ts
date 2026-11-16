import type {
  AgendaAnswer,
  CenterSummaryAnswer,
  CenterWatchAnswer,
  ReminderAcknowledgeAnswer,
  ReminderCreateAnswer,
  ReminderFiresAnswer,
  ReminderGetAnswer,
  ReminderSnoozeAnswer,
  ReminderWriteAnswer,
  RemindersListAnswer,
} from "@tavi/contracts";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, until } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** `reminders` on a live owner: create, the agenda and summary, a fire delivered in the app, acknowledge. */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(): Promise<IpcClient> {
  const directory = directories.create("tavi-reminders-");
  const handle = await serve(
    fixtureRuntimeOptions(directory, { reminderSweepEnabled: true, reminderSweepIntervalMs: 50 }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return client;
}

async function ok<T>(client: IpcClient, payload: Record<string, unknown>, command = "reminders"): Promise<T> {
  const answer = await client.request(command, payload, `${command}-${String(payload["action"])}`);
  if (!answer.ok)
    throw new Error(`${command} ${String(payload["action"])} refused: ${answer.error?.code ?? ""} ${answer.error?.message ?? ""}`);
  return answer.result as T;
}

describe("reminders on a live owner", () => {
  it("creates a reminder that shows on the agenda and in the summary, fires in the app, and is acknowledged", async () => {
    const client = await owner();
    await ok(client, { action: "set", key: "timezone", value: "Europe/Berlin" }, "workspace-settings");
    const watched = await ok<CenterWatchAnswer>(client, { action: "watch" }, "center");

    const pills = await ok<ReminderCreateAnswer>(client, {
      action: "create",
      text: "Take your pills",
      when: { kind: "repeat", times: ["21:00"] },
      operationKey: "pills",
    });
    expect(pills).toMatchObject({
      created: true,
      skippedNotices: [],
      reminder: { timezone: "Europe/Berlin", createdBy: "user", principalId: "operator", deliverTo: { kind: "app" }, status: "active" },
    });
    expect(pills.reminder.upcoming).toHaveLength(5);
    // A retried create answers the first one.
    const retried = await ok<ReminderCreateAnswer>(client, {
      action: "create",
      text: "Take your pills",
      when: { kind: "repeat", times: ["21:00"] },
      operationKey: "pills",
    });
    expect(retried).toMatchObject({ created: false, reminder: { reminderId: pills.reminder.reminderId } });

    const soon = new Date(Date.now() + 1_500).toISOString();
    const stretch = await ok<ReminderCreateAnswer>(client, { action: "create", text: "Stretch", when: { kind: "once", at: soon } });

    const changed = await ok<CenterWatchAnswer>(client, { action: "watch", cursor: watched.cursor, timeoutMs: 1_000 }, "center");
    expect(changed.changed).toContain("reminder");

    const agenda = await ok<AgendaAnswer>(client, { action: "agenda" }, "schedules");
    expect(agenda.items[0]).toMatchObject({
      kind: "reminder",
      id: stretch.reminder.reminderId,
      title: "Stretch",
      cadence: { kind: "once" },
      principalId: "operator",
    });
    expect(agenda.items.filter((item) => item.id === pills.reminder.reminderId).length).toBeGreaterThanOrEqual(6);
    const summary = await ok<CenterSummaryAnswer>(client, { action: "summary" }, "center");
    expect(summary.next[0]).toMatchObject({ kind: "reminder", title: "Stretch" });
    expect(summary.counts).toMatchObject({ reminders: 2, unseenReminders: 0 });

    const list = await ok<RemindersListAnswer>(client, { action: "list" });
    expect(list.timezone).toBe("Europe/Berlin");
    expect(list.reminders.map((reminder) => reminder.text).sort()).toEqual(["Stretch", "Take your pills"]);

    // The scheduler fires it, and the step-11 delivery records it in the app.
    const unseen = await until(
      () => ok<ReminderFiresAnswer>(client, { action: "fires", status: "unseen" }),
      (answer) => answer.fires.length > 0,
    );
    expect(unseen.fires).toEqual([
      expect.objectContaining({
        reminderId: stretch.reminder.reminderId,
        fireAt: soon,
        outcome: "delivered-in-app",
        text: "Stretch",
        occurrence: "once",
      }),
    ]);
    const fired = await ok<CenterSummaryAnswer>(client, { action: "summary" }, "center");
    expect(fired.counts).toMatchObject({ reminders: 1, unseenReminders: 1 });
    const got = await ok<ReminderGetAnswer>(client, { action: "get", reminderId: stretch.reminder.reminderId });
    expect(got.reminder).toMatchObject({ status: "done", nextFireAt: null, upcoming: [] });
    expect(got.fires).toHaveLength(1);

    const acknowledged = await ok<ReminderAcknowledgeAnswer>(client, {
      action: "acknowledge",
      reminderId: stretch.reminder.reminderId,
      fireAt: soon,
    });
    expect(acknowledged.fire.acknowledgedAt).toBeDefined();
    expect((await ok<ReminderFiresAnswer>(client, { action: "fires", status: "unseen" })).fires).toEqual([]);
    expect((await ok<CenterSummaryAnswer>(client, { action: "summary" }, "center")).counts).toMatchObject({ unseenReminders: 0 });

    // Snoozing brings it back ten minutes on.
    const snoozed = await ok<ReminderSnoozeAnswer>(client, {
      action: "snooze",
      reminderId: stretch.reminder.reminderId,
      fireAt: soon,
      minutes: 10,
    });
    expect(snoozed.reminder).toMatchObject({ status: "active", nextFireAt: snoozed.followUp.fireAt });

    // Pause, resume and cancel, under compare-and-set.
    const paused = await ok<ReminderWriteAnswer>(client, {
      action: "pause",
      reminderId: pills.reminder.reminderId,
      expectedUpdatedAt: pills.reminder.updatedAt,
    });
    expect(paused.reminder).toMatchObject({ status: "paused", nextFireAt: null, upcoming: [] });
    const stale = await client.request(
      "reminders",
      { action: "update", reminderId: pills.reminder.reminderId, expectedUpdatedAt: pills.reminder.updatedAt, text: "x" },
      "stale",
    );
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const resumed = await ok<ReminderWriteAnswer>(client, { action: "resume", reminderId: pills.reminder.reminderId });
    expect(resumed.reminder.status).toBe("active");
    const cancelled = await ok<ReminderWriteAnswer>(client, { action: "cancel", reminderId: pills.reminder.reminderId });
    expect(cancelled.reminder.status).toBe("cancelled");
  });

  it("refuses the past, too many times a day and a workspace it does not serve, in words a person reads", async () => {
    const client = await owner();
    const past = await client.request(
      "reminders",
      { action: "create", text: "Too late", when: { kind: "once", at: "2020-01-01T09:00:00Z" } },
      "past",
    );
    expect(past).toEqual({ ok: false, error: { code: "INVALID_INPUT", message: "That time is in the past" } });
    const many = await client.request(
      "reminders",
      { action: "create", text: "Water", when: { kind: "repeat", times: ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00"] } },
      "many",
    );
    expect(many).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(many.error?.message).toMatch(/Reminders can repeat at most 6 times a day/);
    // A chat that is not one of the person's conversations nor a target added for them.
    const foreign = await client.request(
      "reminders",
      {
        action: "create",
        text: "Hi",
        when: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
        deliverTo: { kind: "conversation", connectionId: "telegram-main", conversationId: "someone-else" },
      },
      "foreign",
    );
    expect(foreign).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("only to a conversation of the person it is for") },
    });
    const elsewhere = await client.request("reminders", { action: "list", workspaceId: "nowhere" }, "elsewhere");
    expect(elsewhere).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const missing = await client.request("reminders", { action: "get", reminderId: "rem-missing" }, "missing");
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
