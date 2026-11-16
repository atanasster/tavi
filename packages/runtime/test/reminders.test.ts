import { join } from "node:path";

import {
  REMINDER_MAX_ACTIVE_PER_WORKSPACE,
  TRUSTED_PUBLIC,
  UNTRUSTED_UNKNOWN_SOURCE,
  joinLabels,
  seededReminderRule,
  untrustedLabel,
  type CreateReminderInput,
  type ReminderWhen,
} from "@tavi/contracts";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../src/persistence/store.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** Reminders' store: idempotent creates, claims, the missed-fire rule, snooze and acknowledge. */

const NOW = "2026-10-01T12:00:00.000Z";
const at = (base: string, minutes: number) => new Date(Date.parse(base) + minutes * 60_000).toISOString();

function fixture(store = new SqliteStore({ databasePath: ":memory:", inMemory: true })) {
  const port = store.asPort().repositories;
  let serial = 0;
  const create = (when: ReminderWhen, overrides: Partial<CreateReminderInput> = {}) => {
    serial += 1;
    return port.reminders.create({
      reminderId: `rem-${serial}`,
      workspaceId: "default",
      principalId: "operator",
      text: `Reminder ${serial}`,
      when,
      timezone: "UTC",
      deliverTo: { kind: "app" },
      createdBy: "user",
      operationKey: `op-${serial}`,
      now: NOW,
      ...overrides,
    });
  };
  const claim = (now: string, limit = 50) => port.reminders.claimDue({ now, limit });
  const deliver = (reminderId: string, fireAt: string, now: string) =>
    port.reminders.recordOutcome({ reminderId, fireAt, outcome: "delivered-in-app", now });
  const fires = (reminderId: string) => port.reminders.fires({ workspaceId: "default", reminderId, limit: 200 });
  return { store, port, create, claim, deliver, fires };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  return undefined;
};

describe("creating reminders", () => {
  it("is idempotent on the operation key and returns an exact duplicate instead of a second reminder", () => {
    const { store, create } = fixture();
    try {
      const first = create({ kind: "once", at: "2026-10-02T09:00+02:00" }, { text: "Call the dentist", operationKey: "k1" });
      expect(first).toMatchObject({ created: true, skippedNotices: [] });
      expect(first.reminder).toMatchObject({
        status: "active",
        nextFireAt: "2026-10-02T07:00:00.000Z",
        lastFiredAt: null,
        when: { kind: "once", at: "2026-10-02T07:00:00.000Z" },
        deliverTo: { kind: "app" },
      });
      // A retried call with the same key, even with other content, is the first call.
      const retried = create({ kind: "once", at: "2026-10-03T09:00Z" }, { text: "Something else", operationKey: "k1" });
      expect(retried).toMatchObject({ created: false, reminder: { reminderId: first.reminder.reminderId } });
      expect(retried.duplicate).toBeUndefined();
      // Another key, the same person, text and first fire.
      const duplicate = create({ kind: "once", at: "2026-10-02T07:00:00Z" }, { text: "Call the dentist", operationKey: "k2" });
      expect(duplicate).toMatchObject({ created: false, duplicate: true, reminder: { reminderId: first.reminder.reminderId } });
      // Someone else's is theirs.
      expect(
        create({ kind: "once", at: "2026-10-02T07:00:00Z" }, { text: "Call the dentist", operationKey: "k2", principalId: "alice" })
          .created,
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reports notices already past, and refuses the past, too many times a day and the 101st active reminder", () => {
    const { store, create, port } = fixture();
    try {
      const event = create({ kind: "event", at: "2026-10-02T06:00:00Z", notify: ["-1d", "-1d@20:00", "-1h"] });
      expect(event.skippedNotices).toEqual(["-1d"]);
      expect(event.reminder.nextFireAt).toBe("2026-10-01T20:00:00.000Z");
      expect(refusal(() => create({ kind: "once", at: "2026-10-01T11:00:00Z" }))).toEqual({
        code: "INVALID_INPUT",
        message: "That time is in the past",
      });
      expect(refusal(() => create({ kind: "repeat", times: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] }))).toEqual({
        code: "INVALID_INPUT",
        message: "Reminders can repeat at most 6 times a day",
      });
      for (let index = 1; index < REMINDER_MAX_ACTIVE_PER_WORKSPACE; index += 1) create({ kind: "repeat", times: ["08:00"] });
      expect(refusal(() => create({ kind: "repeat", times: ["08:00"] }))?.message).toMatch(/at most 100 active reminders/);
      // Another workspace has its own allowance.
      expect(create({ kind: "repeat", times: ["08:00"] }, { workspaceId: "other" }).created).toBe(true);
      expect(port.reminders.list({ workspaceId: "default", statuses: ["active"], limit: 200 }).reminders).toHaveLength(
        REMINDER_MAX_ACTIVE_PER_WORKSPACE,
      );
    } finally {
      store.close();
    }
  });
});

describe("changing reminders", () => {
  it("updates under compare-and-set, reschedules, and pauses, resumes and cancels", () => {
    const { store, create, port } = fixture();
    try {
      const { reminder } = create({ kind: "repeat", times: ["21:00"] });
      const later = at(NOW, 1);
      const updated = port.reminders.update({
        reminderId: reminder.reminderId,
        expectedUpdatedAt: reminder.updatedAt,
        text: "Take your pills",
        when: { kind: "repeat", times: ["20:00", "08:00"] },
        now: later,
      });
      expect(updated).toMatchObject({
        text: "Take your pills",
        when: { times: ["08:00", "20:00"] },
        nextFireAt: "2026-10-01T20:00:00.000Z",
      });
      expect(
        refusal(() =>
          port.reminders.update({ reminderId: reminder.reminderId, expectedUpdatedAt: reminder.updatedAt, text: "stale", now: later }),
        )?.code,
      ).toBe("CONFLICT");

      const paused = port.reminders.transition({ reminderId: reminder.reminderId, action: "pause", now: later });
      expect(paused).toMatchObject({ status: "paused", nextFireAt: null });
      expect(port.reminders.claimDue({ now: at(NOW, 24 * 60), limit: 10 }).claimed).toEqual([]);
      // Resumed two days on: what fell due while paused is not sent.
      const resumed = port.reminders.transition({ reminderId: reminder.reminderId, action: "resume", now: "2026-10-03T09:00:00.000Z" });
      expect(resumed).toMatchObject({ status: "active", nextFireAt: "2026-10-03T20:00:00.000Z" });
      expect(port.reminders.claimDue({ now: "2026-10-03T09:00:30.000Z", limit: 10 })).toEqual({ claimed: [], missed: 0 });

      const cancelled = port.reminders.transition({
        reminderId: reminder.reminderId,
        action: "cancel",
        expectedUpdatedAt: resumed.updatedAt,
        now: "2026-10-03T09:01:00.000Z",
      });
      expect(cancelled).toMatchObject({ status: "cancelled", nextFireAt: null });
      expect(
        refusal(() => port.reminders.transition({ reminderId: reminder.reminderId, action: "pause", now: "2026-10-03T09:02:00.000Z" }))
          ?.code,
      ).toBe("CONFLICT");
      expect(
        refusal(() =>
          port.reminders.update({
            reminderId: reminder.reminderId,
            expectedUpdatedAt: cancelled.updatedAt,
            text: "x",
            now: "2026-10-03T09:02:00.000Z",
          }),
        )?.code,
      ).toBe("CONFLICT");
    } finally {
      store.close();
    }
  });

  it("lists newest first, by person and status, a page at a time", () => {
    const { store, create, port } = fixture();
    try {
      create({ kind: "repeat", times: ["08:00"] }, { now: "2026-10-01T10:00:00.000Z" });
      create({ kind: "repeat", times: ["08:00"] }, { principalId: "alice", now: "2026-10-01T11:00:00.000Z" });
      create({ kind: "repeat", times: ["08:00"] }, { now: NOW });
      const first = port.reminders.list({ workspaceId: "default", limit: 2 });
      expect(first.reminders.map((reminder) => reminder.reminderId)).toEqual(["rem-3", "rem-2"]);
      const second = port.reminders.list({ workspaceId: "default", limit: 2, cursor: first.nextCursor! });
      expect(second.reminders.map((reminder) => reminder.reminderId)).toEqual(["rem-1"]);
      expect(second.nextCursor).toBeUndefined();
      expect(
        port.reminders.list({ workspaceId: "default", principalId: "alice", limit: 10 }).reminders.map((reminder) => reminder.reminderId),
      ).toEqual(["rem-2"]);
      expect(port.reminders.list({ workspaceId: "default", statuses: ["cancelled"], limit: 10 }).reminders).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("claiming due fires", () => {
  it("claims each occurrence once, across two connections to one database, and finishes an event after its last notice", () => {
    const directory = directories.create("tavi-reminders-");
    const first = fixture(
      new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") }),
    );
    const second = fixture(
      new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") }),
    );
    try {
      const { reminder } = first.create({ kind: "event", at: "2026-10-01T14:00:00Z", notify: ["-1h", "-15m"] });
      const due = "2026-10-01T13:00:10.000Z";
      const claims = [first.claim(due), second.claim(due)];
      expect(claims.map((claim) => claim.claimed.length).sort()).toEqual([0, 1]);
      const claimed = claims.flatMap((claim) => claim.claimed);
      expect(claimed[0]).toMatchObject({
        late: false,
        fire: { fireAt: "2026-10-01T13:00:00.000Z", occurrence: "notice", noticeOffset: "-1h", outcome: "pending", firedAt: due },
      });
      expect(claimed[0]?.reminder).toMatchObject({ status: "active", nextFireAt: "2026-10-01T13:45:00.000Z" });
      expect(first.deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", due)).toBe(true);
      // A second outcome for the same fire is refused.
      expect(second.deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", due)).toBe(false);

      const last = second.claim("2026-10-01T13:45:05.000Z").claimed;
      expect(last).toHaveLength(1);
      expect(last[0]?.reminder).toMatchObject({ status: "done", nextFireAt: null });
      expect(first.claim("2026-10-01T13:50:00.000Z").claimed).toEqual([]);
      expect(first.port.reminders.get(reminder.reminderId)?.lastFiredAt).toBe(due);
    } finally {
      first.store.close();
      second.store.close();
    }
  });

  it("delivers a once reminder missed by less than six hours late, and records an older one as missed", () => {
    const { store, create, claim, fires, port } = fixture();
    try {
      const recent = create({ kind: "once", at: "2026-10-01T13:00:00Z" }).reminder;
      const old = create({ kind: "once", at: "2026-10-01T12:30:00Z" }).reminder;
      // The owner comes back at 18:45: 5h45 after the first, 6h15 after the second.
      const result = claim("2026-10-01T18:45:00.000Z");
      expect(result.missed).toBe(1);
      expect(result.claimed.map((entry) => [entry.reminder.reminderId, entry.late])).toEqual([[recent.reminderId, true]]);
      expect(result.claimed[0]?.fire.late).toBe(true);
      expect(fires(old.reminderId)).toEqual([expect.objectContaining({ outcome: "missed", firedAt: null, occurrence: "once" })]);
      expect(port.reminders.get(old.reminderId)).toMatchObject({ status: "done", nextFireAt: null, lastFiredAt: null });
      expect(port.reminders.get(recent.reminderId)).toMatchObject({ status: "done" });
    } finally {
      store.close();
    }
  });

  it("never sends a repeating reminder's backlog: the latest occurrence at most, late, and the rest missed", () => {
    const { store, create, claim, deliver, fires, port } = fixture();
    try {
      const { reminder } = create({ kind: "repeat", times: ["08:00", "20:00"] });
      // Down from 12:00 on the 1st to 09:00 on the 4th: six occurrences went by.
      const result = claim("2026-10-04T09:00:00.000Z");
      expect(result.claimed.map((entry) => [entry.fire.fireAt, entry.late])).toEqual([["2026-10-04T08:00:00.000Z", true]]);
      expect(result.missed).toBe(5);
      expect(fires(reminder.reminderId).map((fire) => fire.outcome)).toEqual(["pending", "missed", "missed", "missed", "missed", "missed"]);
      expect(port.reminders.get(reminder.reminderId)).toMatchObject({ status: "active", nextFireAt: "2026-10-04T20:00:00.000Z" });

      deliver(reminder.reminderId, "2026-10-04T08:00:00.000Z", "2026-10-04T09:00:01.000Z");
      // Down again past the grace of the latest: nothing is sent.
      const later = claim("2026-10-05T03:00:00.000Z");
      expect(later).toEqual({ claimed: [], missed: 1 });
    } finally {
      store.close();
    }
  });

  it("claims a delivery that never reported again once its lease runs out", () => {
    const { store, create, claim, deliver } = fixture();
    try {
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      expect(claim("2026-10-01T13:00:05.000Z").claimed).toHaveLength(1);
      expect(claim("2026-10-01T13:05:00.000Z").claimed).toEqual([]);
      const again = claim("2026-10-01T13:11:00.000Z").claimed;
      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({ late: true, fire: { fireAt: "2026-10-01T13:00:00.000Z", firedAt: "2026-10-01T13:11:00.000Z" } });
      expect(deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", "2026-10-01T13:11:01.000Z")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("snooze and acknowledge", () => {
  it("snoozes a delivered fire into a follow-up that fires again, and acknowledging clears it from unseen", () => {
    const { store, create, claim, deliver, port } = fixture();
    try {
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      claim("2026-10-01T13:00:05.000Z");
      deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", "2026-10-01T13:00:06.000Z");
      const unseen = () => port.reminders.fires({ workspaceId: "default", unseen: true, limit: 10 });
      expect(unseen()).toEqual([
        expect.objectContaining({
          reminderId: reminder.reminderId,
          fireAt: "2026-10-01T13:00:00.000Z",
          outcome: "delivered-in-app",
          text: "Reminder 1",
          principalId: "operator",
        }),
      ]);
      expect(port.reminders.get(reminder.reminderId)?.status).toBe("done");

      const snoozed = port.reminders.snooze({ reminderId: reminder.reminderId, minutes: 10, now: "2026-10-01T13:02:00.000Z" });
      expect(snoozed.snoozed).toMatchObject({
        outcome: "snoozed",
        snoozedUntil: "2026-10-01T13:12:00.000Z",
        acknowledgedAt: "2026-10-01T13:02:00.000Z",
      });
      expect(snoozed.followUp).toMatchObject({ fireAt: "2026-10-01T13:12:00.000Z", outcome: "pending", firedAt: null, occurrence: "once" });
      expect(snoozed.reminder).toMatchObject({ status: "active", nextFireAt: "2026-10-01T13:12:00.000Z" });
      expect(unseen()).toEqual([]);
      expect(
        refusal(() => port.reminders.snooze({ reminderId: reminder.reminderId, minutes: 10, now: "2026-10-01T13:03:00.000Z" }))?.code,
      ).toBe("NOT_FOUND");

      const back = claim("2026-10-01T13:12:10.000Z").claimed;
      expect(back).toHaveLength(1);
      expect(back[0]).toMatchObject({
        late: false,
        fire: { fireAt: "2026-10-01T13:12:00.000Z" },
        reminder: { status: "done", nextFireAt: null },
      });
      deliver(reminder.reminderId, "2026-10-01T13:12:00.000Z", "2026-10-01T13:12:11.000Z");
      expect(unseen()).toHaveLength(1);
      const acknowledged = port.reminders.acknowledge({
        reminderId: reminder.reminderId,
        fireAt: "2026-10-01T13:12:00.000Z",
        now: "2026-10-01T13:13:00.000Z",
      });
      expect(acknowledged).toMatchObject({ acknowledgedAt: "2026-10-01T13:13:00.000Z" });
      // Acknowledging again keeps the first time.
      expect(
        port.reminders.acknowledge({ reminderId: reminder.reminderId, fireAt: "2026-10-01T13:12:00.000Z", now: "2026-10-01T13:20:00.000Z" })
          .acknowledgedAt,
      ).toBe("2026-10-01T13:13:00.000Z");
      expect(unseen()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("records a snooze that came due while paused as missed on resume, and does not send it", () => {
    const { store, create, claim, deliver, port, fires } = fixture();
    try {
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      claim("2026-10-01T13:00:05.000Z");
      deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", "2026-10-01T13:00:06.000Z");
      port.reminders.snooze({ reminderId: reminder.reminderId, minutes: 60, now: "2026-10-01T13:01:00.000Z" });
      port.reminders.transition({ reminderId: reminder.reminderId, action: "pause", now: "2026-10-01T13:05:00.000Z" });
      const resumed = port.reminders.transition({ reminderId: reminder.reminderId, action: "resume", now: "2026-10-01T15:00:00.000Z" });
      expect(resumed).toMatchObject({ status: "done", nextFireAt: null });
      expect(claim("2026-10-01T15:00:05.000Z")).toEqual({ claimed: [], missed: 0 });
      expect(fires(reminder.reminderId).map((fire) => [fire.fireAt, fire.outcome])).toEqual([
        ["2026-10-01T14:01:00.000Z", "missed"],
        ["2026-10-01T13:00:00.000Z", "snoozed"],
      ]);
    } finally {
      store.close();
    }
  });

  it("drops a pending snooze when the reminder is cancelled", () => {
    const { store, create, claim, deliver, port, fires } = fixture();
    try {
      const { reminder } = create({ kind: "repeat", times: ["13:00"] });
      claim("2026-10-01T13:00:05.000Z");
      deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", "2026-10-01T13:00:06.000Z");
      port.reminders.snooze({ reminderId: reminder.reminderId, minutes: 60, now: "2026-10-01T13:01:00.000Z" });
      expect(port.reminders.get(reminder.reminderId)?.nextFireAt).toBe("2026-10-01T14:01:00.000Z");
      port.reminders.transition({ reminderId: reminder.reminderId, action: "cancel", now: "2026-10-01T13:02:00.000Z" });
      expect(fires(reminder.reminderId).map((fire) => fire.outcome)).toEqual(["snoozed"]);
      expect(claim("2026-10-01T14:01:05.000Z").claimed).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("the Command Center", () => {
  it("bumps the reminder counter for the workspace on writes to either table, and not for another workspace", () => {
    const { store, create, claim, deliver, port } = fixture();
    try {
      const changes = (cursor?: string) =>
        port.center.changes({ workspaceId: "default", principalId: "operator", ...(cursor === undefined ? {} : { cursor }) });
      const start = changes();
      create({ kind: "once", at: "2026-10-01T13:00:00Z" }, { workspaceId: "other" });
      expect(changes(start.cursor).changed).toEqual([]);
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      const created = changes(start.cursor);
      expect(created.changed).toEqual(["reminder"]);
      claim("2026-10-01T13:00:05.000Z");
      const claimed = changes(created.cursor);
      expect(claimed.changed).toEqual(["reminder"]);
      // A fire's own row moves the counter too.
      store.handle.prepare("UPDATE tavi_reminder_fires SET task_id = 'x' WHERE reminder_id = ?").run(reminder.reminderId);
      expect(changes(claimed.cursor).changed).toEqual(["reminder"]);
      deliver(reminder.reminderId, "2026-10-01T13:00:00.000Z", "2026-10-01T13:00:06.000Z");
    } finally {
      store.close();
    }
  });

  it("lists reminder fires on the agenda and in the summary, and counts active and unseen ones", () => {
    const { store, create, claim, deliver, port } = fixture();
    try {
      const pills = create({ kind: "repeat", times: ["21:00"] }, { text: "Take your pills" }).reminder;
      const dentist = create(
        { kind: "event", at: "2026-10-05T08:00:00Z", notify: ["-1d@20:00", "-1h"] },
        { text: "Dentist", timezone: "Europe/Berlin", principalId: "alice" },
      ).reminder;
      create({ kind: "once", at: "2026-10-01T12:30:00Z" }, { text: "Stretch" });
      const agenda = port.center.agenda({
        workspaceId: "default",
        now: NOW,
        from: NOW,
        until: "2026-10-06T00:00:00.000Z",
        limit: 50,
      }).items;
      expect(agenda.filter((item) => item.id === dentist.reminderId)).toEqual([
        {
          kind: "reminder",
          id: dentist.reminderId,
          title: "Dentist",
          at: "2026-10-04T18:00:00.000Z",
          cadence: { kind: "once" },
          reminder: { cadence: "event", eventAt: "2026-10-05T08:00:00.000Z", notice: "-1d@20:00" },
          enabled: true,
          principalId: "alice",
        },
        {
          kind: "reminder",
          id: dentist.reminderId,
          title: "Dentist",
          at: "2026-10-05T07:00:00.000Z",
          cadence: { kind: "once" },
          reminder: { cadence: "event", eventAt: "2026-10-05T08:00:00.000Z", notice: "-1h" },
          enabled: true,
          principalId: "alice",
        },
      ]);
      expect(agenda.filter((item) => item.id === pills.reminderId).map((item) => item.at)).toEqual(
        ["01", "02", "03", "04", "05"].map((day) => `2026-10-${day}T21:00:00.000Z`),
      );
      expect(agenda[0]).toMatchObject({ title: "Stretch", cadence: { kind: "once" }, at: "2026-10-01T12:30:00.000Z" });
      // A repeat time reads as a daily cadence at that time, with the reminder's own terms beside it.
      expect(agenda.find((item) => item.id === pills.reminderId)).toMatchObject({
        cadence: { kind: "daily", at: "21:00", timezone: "UTC" },
        reminder: { cadence: "repeat", times: ["21:00"] },
      });

      const summary = () => port.center.summary({ workspaceId: "default", principalId: "operator", timezone: "UTC", days: 1, now: NOW });
      expect(summary().next.map((item) => [item.kind, item.title])).toEqual([
        ["reminder", "Stretch"],
        ["reminder", "Take your pills"],
        ["reminder", "Take your pills"],
      ]);
      expect(summary().counts).toMatchObject({ reminders: 3, unseenReminders: 0 });

      claim("2026-10-01T12:30:05.000Z");
      deliver("rem-3", "2026-10-01T12:30:00.000Z", "2026-10-01T12:30:06.000Z");
      expect(
        port.center.summary({ workspaceId: "default", principalId: "operator", timezone: "UTC", days: 1, now: "2026-10-01T12:31:00.000Z" })
          .counts,
      ).toMatchObject({ reminders: 2, unseenReminders: 1 });
    } finally {
      store.close();
    }
  });

  it("lists a monthly or yearly reminder as a repeat on its day, never as a daily cadence", () => {
    const { store, create, port } = fixture();
    try {
      const rent = create({ kind: "repeat", times: ["09:00"], monthly: { dayOfMonth: 2 } }, { text: "Pay rent" }).reminder;
      const birthday = create({ kind: "repeat", times: ["08:00"], yearly: { month: 10, day: 3 } }, { text: "Birthday" }).reminder;
      const items = port.center.agenda({ workspaceId: "default", now: NOW, from: NOW, until: "2026-10-06T00:00:00.000Z", limit: 50 }).items;
      expect(items.filter((item) => item.id === rent.reminderId)).toEqual([
        expect.objectContaining({
          at: "2026-10-02T09:00:00.000Z",
          cadence: { kind: "repeat", at: "09:00", timezone: "UTC", monthly: { dayOfMonth: 2 } },
          reminder: { cadence: "repeat", times: ["09:00"], monthly: { dayOfMonth: 2 } },
        }),
      ]);
      expect(items.find((item) => item.id === birthday.reminderId)).toMatchObject({
        at: "2026-10-03T08:00:00.000Z",
        cadence: { kind: "repeat", at: "08:00", timezone: "UTC", yearly: { month: 10, day: 3 } },
        reminder: { cadence: "repeat", times: ["08:00"], yearly: { month: 10, day: 3 } },
      });
    } finally {
      store.close();
    }
  });

  it("lists an overdue fire as the occurrence that is overdue: its repeat time, or its event notice", () => {
    const { store, create, port } = fixture();
    try {
      create({ kind: "repeat", times: ["08:00", "12:30"] }, { text: "Water" });
      create({ kind: "event", at: "2026-10-01T13:30:00Z", notify: ["-1h"] }, { text: "Meeting" });
      // Nothing claimed them: the owner was stopped until 13:00.
      const later = "2026-10-01T13:00:00.000Z";
      const overdue = port.center
        .agenda({ workspaceId: "default", now: later, from: later, until: "2026-10-02T00:00:00.000Z", limit: 50 })
        .items.filter((item) => item.overdue === true);
      expect(overdue).toEqual([
        expect.objectContaining({
          title: "Water",
          at: "2026-10-01T12:30:00.000Z",
          cadence: { kind: "daily", at: "12:30", timezone: "UTC" },
        }),
        expect.objectContaining({
          title: "Meeting",
          at: "2026-10-01T12:30:00.000Z",
          reminder: { cadence: "event", eventAt: "2026-10-01T13:30:00.000Z", notice: "-1h" },
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("shows a far-off reminder in the summary beyond the agenda window", () => {
    const { store, create, port } = fixture();
    try {
      create({ kind: "once", at: "2027-03-01T09:00:00Z" }, { text: "Renew the passport" });
      const next = port.center.summary({ workspaceId: "default", principalId: "operator", timezone: "UTC", days: 1, now: NOW }).next;
      expect(next).toEqual([{ kind: "reminder", id: "rem-1", title: "Renew the passport", at: "2027-03-01T09:00:00.000Z" }]);
    } finally {
      store.close();
    }
  });
});

describe("delivery to a chat", () => {
  it("keeps a refused delivery pending until its retry time, opens the retry window once, and keeps the task and lateness", () => {
    const { store, create, claim, port, fires } = fixture();
    try {
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      const first = claim("2026-10-01T13:00:05.000Z").claimed[0];
      expect(first?.fire.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(
        port.reminders.recordOutcome({
          reminderId: reminder.reminderId,
          fireAt: "2026-10-01T13:00:00.000Z",
          outcome: "retry",
          retryAt: "2026-10-01T13:00:35.000Z",
          taskId: "task-1",
          now: "2026-10-01T13:00:05.000Z",
        }),
      ).toBe(true);
      expect(fires(reminder.reminderId)[0]).toMatchObject({
        outcome: "pending",
        attempts: 1,
        retryAt: "2026-10-01T13:00:35.000Z",
        retryUntil: "2026-10-01T13:15:05.000Z",
        taskId: "task-1",
      });
      // Not before its time, and not as a lapsed lease either.
      expect(claim("2026-10-01T13:00:30.000Z").claimed).toEqual([]);
      expect(claim("2026-10-01T13:12:00.000Z").claimed).toHaveLength(1);
      port.reminders.recordOutcome({
        reminderId: reminder.reminderId,
        fireAt: "2026-10-01T13:00:00.000Z",
        outcome: "retry",
        retryAt: "2026-10-01T13:15:05.000Z",
        now: "2026-10-01T13:12:00.000Z",
      });
      expect(fires(reminder.reminderId)[0]).toMatchObject({ attempts: 2, retryUntil: "2026-10-01T13:15:05.000Z", taskId: "task-1" });
      const last = claim("2026-10-01T13:15:05.000Z").claimed[0];
      // Twelve minutes after its time, but it was on time when first claimed.
      expect(last).toMatchObject({ late: false, fire: { taskId: "task-1", attempts: 2 } });
      expect(
        port.reminders.recordOutcome({
          reminderId: reminder.reminderId,
          fireAt: "2026-10-01T13:00:00.000Z",
          outcome: "delivered-in-app",
          now: "2026-10-01T13:15:06.000Z",
        }),
      ).toBe(true);
      expect(fires(reminder.reminderId)[0]).toMatchObject({ outcome: "delivered-in-app" });
      expect(fires(reminder.reminderId)[0]?.retryAt).toBeUndefined();
      expect(
        refusal(() =>
          port.reminders.recordOutcome({
            reminderId: reminder.reminderId,
            fireAt: "2026-10-01T13:00:00.000Z",
            outcome: "retry",
            now: "2026-10-01T13:15:06.000Z",
          }),
        )?.code,
      ).toBe("INVALID_INPUT");
    } finally {
      store.close();
    }
  });

  it("claims a retry due more than six hours after its fire time rather than recording it missed", () => {
    const { store, create, claim, port, fires } = fixture();
    try {
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      // The owner comes back 5 h 50 min late; the chat refuses the first send.
      const first = claim("2026-10-01T18:50:00.000Z").claimed[0];
      expect(first?.late).toBe(true);
      port.reminders.recordOutcome({
        reminderId: reminder.reminderId,
        fireAt: "2026-10-01T13:00:00.000Z",
        outcome: "retry",
        retryAt: "2026-10-01T19:05:00.000Z",
        now: "2026-10-01T18:50:00.000Z",
      });
      const again = claim("2026-10-01T19:05:00.000Z");
      expect(again.missed).toBe(0);
      expect(again.claimed).toEqual([
        expect.objectContaining({ late: true, fire: expect.objectContaining({ outcome: "pending", attempts: 1 }) }),
      ]);
      expect(fires(reminder.reminderId)[0]?.outcome).toBe("pending");
    } finally {
      store.close();
    }
  });

  it("finds a fire by the token its buttons carry", () => {
    const { store, create, claim, port } = fixture();
    try {
      const { reminder } = create({ kind: "once", at: "2026-10-01T13:00:00Z" });
      const token = claim("2026-10-01T13:00:05.000Z").claimed[0]?.fire.token ?? "";
      expect(port.reminders.fireByToken(token)).toMatchObject({
        reminder: { reminderId: reminder.reminderId },
        fire: { fireAt: "2026-10-01T13:00:00.000Z" },
      });
      expect(port.reminders.fireByToken("unknown-token")).toBeUndefined();
      expect(port.reminders.fireByToken("x")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("the seeded reminder rule", () => {
  it("is seeded once, and never again after the operator revokes it", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const policy = store.asPort().repositories.toolPolicy;
      expect(policy.seedRule(seededReminderRule("w1", NOW), NOW)).toBe(true);
      expect(policy.getRule("w1", "seeded-reminders")).toMatchObject({ toolPattern: "reminders.*", decision: "allow" });
      expect(policy.seedRule(seededReminderRule("w1", NOW), NOW)).toBe(false);
      expect(policy.deleteRule("w1", "seeded-reminders")).toBe(true);
      expect(policy.seedRule(seededReminderRule("w1", NOW), NOW)).toBe(false);
      expect(policy.getRule("w1", "seeded-reminders")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("a reminder's creation label", () => {
  const page = untrustedLabel("web", { principal: "host:shop.example", ref: { ref: "call-1", host: "shop.example", at: NOW } });

  it("stores an untrusted label, never a trusted one, and an update replaces it only when it names one", () => {
    const { store, create, port } = fixture();
    try {
      const tainted = create({ kind: "once", at: "2026-10-02T09:00Z" }, { prompt: "Check the sale", label: page });
      expect(tainted.reminder.label).toEqual(page);
      expect(port.reminders.get(tainted.reminder.reminderId)?.label).toEqual(page);
      const clean = create({ kind: "once", at: "2026-10-02T10:00Z" }, { label: TRUSTED_PUBLIC });
      expect(clean.reminder.label).toBeUndefined();
      // A change that names no label keeps it.
      const renamed = port.reminders.update({
        reminderId: tainted.reminder.reminderId,
        expectedUpdatedAt: tainted.reminder.updatedAt,
        text: "Sale ends",
        now: NOW,
      });
      expect(renamed.label).toEqual(page);
      // One that names a label stores it: joined by the caller, or trusted to clear it.
      const search = joinLabels(page, untrustedLabel("search", { ref: { ref: "call-2", at: NOW } }));
      const joined = port.reminders.update({
        reminderId: renamed.reminderId,
        expectedUpdatedAt: renamed.updatedAt,
        label: search,
        now: NOW,
      });
      expect(joined.label).toEqual(search);
      const cleared = port.reminders.update({
        reminderId: joined.reminderId,
        expectedUpdatedAt: joined.updatedAt,
        label: TRUSTED_PUBLIC,
        now: NOW,
      });
      expect(cleared.label).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("reads a stored label that no longer parses as untrusted from an unknown source (fail safe)", () => {
    const { store, create, port } = fixture();
    try {
      const made = create({ kind: "once", at: "2026-10-02T09:00Z" }, { label: page });
      store.handle
        .prepare("UPDATE tavi_reminders SET label_json = ? WHERE reminder_id = ?")
        .run('{"integrity":"maybe"}', made.reminder.reminderId);
      expect(port.reminders.get(made.reminder.reminderId)?.label).toEqual(UNTRUSTED_UNKNOWN_SOURCE);
    } finally {
      store.close();
    }
  });
});
