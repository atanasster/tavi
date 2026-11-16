import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/** `schedules agenda`: every occurrence in a window, merged and sorted. */

const NOW = "2026-10-22T12:00:00.000Z"; // a Thursday, three days before Europe/Berlin leaves summer time
const WEEK = "2026-10-29T12:00:00.000Z";

type Spec = import("@tavi/contracts").ScheduleSpec;

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const port = store.asPort().repositories;
  const schedule = (scheduleId: string, spec: Spec, enabled = true, workspaceId = "default") =>
    port.schedules.create({
      scheduleId,
      workspaceId,
      principalId: "operator",
      name: `Schedule ${scheduleId}`,
      prompt: "fixture",
      spec,
      missedRunPolicy: "skip",
      autoApproveTools: [],
      enabled,
      nextRunAt: enabled ? NOW : null,
      now: NOW,
    });
  const routine = (routineId: string, status = "active", workspaceId = "default") =>
    store.handle
      .prepare(
        "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES(?,?,'operator',?,1,1,1,?,NULL,?,?)",
      )
      .run(routineId, workspaceId, `Routine ${routineId}`, status, NOW, NOW);
  /** A routine trigger with its own schedule row, as `syncSchedules` writes it. */
  const trigger = (
    routineId: string,
    trigger: Record<string, unknown> & { id: string },
    options: { enabled?: boolean; consumed?: boolean; workspaceId?: string } = {},
  ) => {
    const scheduleId = `${routineId}-${trigger.id}`;
    schedule(scheduleId, { at: "00:00", timezone: "UTC" }, options.enabled ?? true, options.workspaceId ?? "default");
    store.handle
      .prepare("INSERT INTO tavi_routine_triggers(routine_id,trigger_id,schedule_id,spec_json,consumed) VALUES(?,?,?,?,?)")
      .run(routineId, trigger.id, scheduleId, JSON.stringify(trigger), options.consumed === true ? 1 : 0);
  };
  const answer = (input: { from?: string; until?: string; limit?: number; workspaceId?: string } = {}) =>
    port.center.agenda({
      workspaceId: input.workspaceId ?? "default",
      now: NOW,
      from: input.from ?? NOW,
      until: input.until ?? WEEK,
      limit: input.limit ?? 200,
    });
  const agenda = (input: Parameters<typeof answer>[0] = {}) => answer(input).items;
  const summary = () =>
    port.center.summary({ workspaceId: "default", principalId: "operator", timezone: "Europe/Berlin", days: 1, now: NOW });
  return { store, port, schedule, routine, trigger, answer, agenda, summary };
}

const berlinClock = (at: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));

describe("schedules agenda", () => {
  it("expands a daily schedule to one 21:00 local occurrence per day across the DST change", () => {
    const { store, schedule, agenda } = fixture();
    try {
      schedule("pills", { at: "21:00", timezone: "Europe/Berlin" });
      const items = agenda();
      expect(items.map((item) => item.at)).toEqual([
        "2026-10-22T19:00:00.000Z",
        "2026-10-23T19:00:00.000Z",
        "2026-10-24T19:00:00.000Z",
        // 2026-10-25: Berlin is on UTC+1 from 03:00 local.
        "2026-10-25T20:00:00.000Z",
        "2026-10-26T20:00:00.000Z",
        "2026-10-27T20:00:00.000Z",
        "2026-10-28T20:00:00.000Z",
      ]);
      expect(items.map((item) => berlinClock(item.at))).toEqual(
        ["22", "23", "24", "25", "26", "27", "28"].map((day) => `${day}/10/2026, 21:00`),
      );
      expect(items[0]).toEqual({
        kind: "schedule",
        id: "pills",
        title: "Schedule pills",
        at: "2026-10-22T19:00:00.000Z",
        cadence: { kind: "daily", at: "21:00", timezone: "Europe/Berlin" },
        enabled: true,
      });
    } finally {
      store.close();
    }
  });

  it("expands every stored cadence shape, each occurrence at its own time, and ends a series that ends", () => {
    const { store, schedule, trigger, routine, agenda } = fixture();
    try {
      schedule("twice", { times: ["08:00", "20:00"], timezone: "Europe/Berlin", until: "2026-10-23" });
      schedule("hourly", { everyHours: 4, between: { from: "09:00", to: "17:00" }, timezone: "UTC", once: "2026-10-26" });
      schedule("monthly", { at: "09:00", timezone: "Europe/Berlin", monthly: { nth: -1, weekday: 2 } });
      routine("r1");
      trigger("r1", { id: "weekdays", kind: "daily", times: ["07:00", "12:00"], timezone: "UTC", daysOfWeek: [6], until: "2026-10-24" });
      const items = agenda();
      const of = (id: string) => items.filter((item) => item.id === id);
      expect(of("twice").map((item) => [item.at, item.cadence])).toEqual([
        ["2026-10-22T18:00:00.000Z", { kind: "daily", at: "20:00", timezone: "Europe/Berlin" }],
        ["2026-10-23T06:00:00.000Z", { kind: "daily", at: "08:00", timezone: "Europe/Berlin" }],
        ["2026-10-23T18:00:00.000Z", { kind: "daily", at: "20:00", timezone: "Europe/Berlin" }],
      ]);
      expect(of("hourly").map((item) => [item.at, item.cadence.kind])).toEqual([
        ["2026-10-26T09:00:00.000Z", "once"],
        ["2026-10-26T13:00:00.000Z", "once"],
        ["2026-10-26T17:00:00.000Z", "once"],
      ]);
      // The last Tuesday of October, 09:00 in Berlin after the clocks went back.
      expect(of("monthly").map((item) => [item.at, item.cadence])).toEqual([
        ["2026-10-27T08:00:00.000Z", { kind: "repeat", at: "09:00", timezone: "Europe/Berlin", monthly: { nth: -1, weekday: 2 } }],
      ]);
      expect(of("r1").map((item) => item.at)).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-24T12:00:00.000Z"]);
    } finally {
      store.close();
    }
  });

  it("honours a weekday mask", () => {
    const { store, schedule, agenda } = fixture();
    try {
      // Monday and Wednesday only.
      schedule("gym", { at: "07:30", timezone: "Europe/Berlin", daysOfWeek: [1, 3] });
      const items = agenda();
      expect(items.map((item) => item.at)).toEqual(["2026-10-26T06:30:00.000Z", "2026-10-28T06:30:00.000Z"]);
      expect(items[0]?.cadence).toEqual({ kind: "daily", at: "07:30", timezone: "Europe/Berlin", daysOfWeek: [1, 3] });
    } finally {
      store.close();
    }
  });

  it("lists a once trigger inside the window and leaves out one outside it or consumed", () => {
    const { store, routine, trigger, agenda } = fixture();
    try {
      routine("trip");
      trigger("trip", { id: "inside", kind: "once", runAt: "2026-10-24T08:00:00.000Z" });
      trigger("trip", { id: "outside", kind: "once", runAt: "2026-11-05T08:00:00.000Z" });
      trigger("trip", { id: "past", kind: "once", runAt: "2026-10-21T08:00:00.000Z" });
      trigger("trip", { id: "fired", kind: "once", runAt: "2026-10-23T08:00:00.000Z" }, { consumed: true });
      expect(agenda()).toEqual([
        {
          kind: "routine",
          id: "trip",
          triggerId: "inside",
          title: "Routine trip",
          at: "2026-10-24T08:00:00.000Z",
          cadence: { kind: "once" },
          enabled: true,
          status: "active",
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("leaves out paused routines, dormant ones, disabled schedules and other workspaces", () => {
    const { store, schedule, routine, trigger, agenda } = fixture();
    try {
      routine("paused", "paused");
      trigger("paused", { id: "daily", kind: "daily", at: "09:00", timezone: "UTC" }, { enabled: false });
      // A draft's row is never armed; even one left enabled does not fire.
      routine("draft", "draft");
      trigger("draft", { id: "daily", kind: "daily", at: "09:00", timezone: "UTC" });
      schedule("off", { at: "09:00", timezone: "UTC" }, false);
      schedule("elsewhere", { at: "09:00", timezone: "UTC" }, true, "other");
      routine("live");
      trigger("live", { id: "daily", kind: "daily", at: "09:00", timezone: "UTC", daysOfWeek: [5] });
      expect(agenda().map((item) => [item.kind, item.id, item.at])).toEqual([["routine", "live", "2026-10-23T09:00:00.000Z"]]);
      expect(agenda({ workspaceId: "other" }).map((item) => item.id)).toEqual(Array(7).fill("elsewhere"));
    } finally {
      store.close();
    }
  });

  it("merges the sources in time order and stops at the limit", () => {
    const { store, schedule, routine, trigger, agenda } = fixture();
    try {
      schedule("evening", { at: "21:00", timezone: "Europe/Berlin" });
      schedule("morning", { at: "08:00", timezone: "Europe/Berlin" });
      routine("news");
      trigger("news", { id: "noon", kind: "daily", at: "12:00", timezone: "UTC" });
      const all = agenda();
      expect(all).toHaveLength(21);
      expect([...all].sort((a, b) => a.at.localeCompare(b.at))).toEqual(all);
      const first = agenda({ limit: 4 });
      expect(first.map((item) => [item.id, item.at])).toEqual([
        // Exactly now: the window's start is inclusive.
        ["news", "2026-10-22T12:00:00.000Z"],
        ["evening", "2026-10-22T19:00:00.000Z"],
        ["morning", "2026-10-23T06:00:00.000Z"],
        ["news", "2026-10-23T12:00:00.000Z"],
      ]);
      expect(first).toEqual(all.slice(0, 4));
      // The window's end is exclusive.
      expect(agenda({ from: "2026-10-23T06:00:00.000Z", until: "2026-10-23T12:00:00.000Z" }).map((item) => item.id)).toEqual(["morning"]);
    } finally {
      store.close();
    }
  });

  it("gives the center summary's next as the agenda's head", () => {
    const { store, schedule, routine, trigger, agenda, summary } = fixture();
    try {
      schedule("evening", { at: "21:00", timezone: "Europe/Berlin" });
      routine("trip");
      trigger("trip", { id: "inside", kind: "once", runAt: "2026-10-22T15:00:00.000Z" });
      const head = agenda()
        .slice(0, 3)
        .map(({ kind, id, title, at }) => ({ kind, id, title, at }));
      expect(head.map((item) => item.id)).toEqual(["trip", "evening", "evening"]);
      expect(summary().next).toEqual(head);
    } finally {
      store.close();
    }
  });

  it("lists an overdue fire the scheduler still owes first, and none it would skip", () => {
    const { store, port, routine, trigger, answer, agenda } = fixture();
    const overdueSchedule = (scheduleId: string, at: string, nextRunAt: string, missedRunPolicy: "skip" | "run-once-if-missed-within-6h") =>
      port.schedules.create({
        scheduleId,
        workspaceId: "default",
        principalId: "operator",
        name: `Schedule ${scheduleId}`,
        prompt: "fixture",
        spec: { at, timezone: "UTC" },
        missedRunPolicy,
        autoApproveTools: [],
        enabled: true,
        nextRunAt,
        now: NOW,
      });
    try {
      // The host slept through 11:00; the scheduler catches it up on its next tick.
      overdueSchedule("slept", "11:00", "2026-10-22T11:00:00.000Z", "run-once-if-missed-within-6h");
      // The same miss under `skip`, and one beyond the 6 h catch-up: both are advanced, never run.
      overdueSchedule("skipped", "11:30", "2026-10-22T11:30:00.000Z", "skip");
      overdueSchedule("stale", "04:00", "2026-10-22T04:00:00.000Z", "run-once-if-missed-within-6h");
      routine("trip");
      trigger("trip", { id: "late", kind: "once", runAt: "2026-10-22T10:00:00.000Z" });
      store.handle
        .prepare(
          "UPDATE tavi_schedules SET next_run_at = ?, missed_run_policy = 'run-once-if-missed-within-6h' WHERE schedule_id = 'trip-late'",
        )
        .run("2026-10-22T10:00:00.000Z");

      const head = agenda({ limit: 3 });
      expect(head).toEqual([
        {
          kind: "routine",
          id: "trip",
          triggerId: "late",
          title: "Routine trip",
          at: "2026-10-22T10:00:00.000Z",
          cadence: { kind: "once" },
          enabled: true,
          status: "active",
          overdue: true,
        },
        {
          kind: "schedule",
          id: "slept",
          title: "Schedule slept",
          at: "2026-10-22T11:00:00.000Z",
          cadence: { kind: "daily", at: "11:00", timezone: "UTC" },
          enabled: true,
          overdue: true,
        },
        {
          kind: "schedule",
          id: "stale",
          title: "Schedule stale",
          at: "2026-10-23T04:00:00.000Z",
          cadence: { kind: "daily", at: "04:00", timezone: "UTC" },
          enabled: true,
        },
      ]);
      expect(
        agenda()
          .filter((item) => item.overdue === true)
          .map((item) => item.id),
      ).toEqual(["trip", "slept"]);
      // A window that starts later owes nothing.
      expect(answer({ from: "2026-10-23T00:00:00.000Z" }).items.some((item) => item.overdue === true)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("leaves out a row whose stored zone is unknown, naming it, and still answers the summary", () => {
    const { store, schedule, answer, summary } = fixture();
    try {
      schedule("broken", { at: "09:00", timezone: "Europe/Berlin" });
      store.handle
        .prepare("UPDATE tavi_schedules SET spec_json = ? WHERE schedule_id = 'broken'")
        .run(JSON.stringify({ at: "09:00", timezone: "Mars/Base" }));
      schedule("fine", { at: "09:00", timezone: "UTC" });
      const result = answer();
      expect(result.skipped).toEqual(["broken"]);
      expect(result.items.map((item) => item.id)).toEqual(Array(7).fill("fine"));
      expect(summary().next.map((item) => item.id)).toEqual(["fine", "fine", "fine"]);
    } finally {
      store.close();
    }
  });

  it("says when the limit cut the window short", () => {
    const { store, schedule, answer } = fixture();
    try {
      schedule("daily", { at: "09:00", timezone: "UTC" });
      expect(answer({ limit: 7 })).toMatchObject({ truncated: false, skipped: [] });
      expect(answer({ limit: 6 })).toMatchObject({ truncated: true });
      expect(answer({ limit: 6 }).items).toHaveLength(6);
    } finally {
      store.close();
    }
  });

  it("fills the summary's next with a stored fire beyond the agenda's 31 days", () => {
    const { store, routine, trigger, agenda, summary } = fixture();
    try {
      routine("far");
      trigger("far", { id: "trip", kind: "once", runAt: "2026-12-05T08:00:00.000Z" });
      store.handle.prepare("UPDATE tavi_schedules SET next_run_at = ? WHERE schedule_id = 'far-trip'").run("2026-12-05T08:00:00.000Z");
      routine("paused", "paused");
      trigger("paused", { id: "later", kind: "once", runAt: "2026-12-06T08:00:00.000Z" });
      store.handle.prepare("UPDATE tavi_schedules SET next_run_at = ? WHERE schedule_id = 'paused-later'").run("2026-12-06T08:00:00.000Z");
      expect(agenda()).toEqual([]);
      expect(summary().next).toEqual([{ kind: "routine", id: "far", title: "Routine far", at: "2026-12-05T08:00:00.000Z" }]);
    } finally {
      store.close();
    }
  });

  it("marks a due to-do's reminder as a to-do, and a plain reminder not", async () => {
    const { store, port, agenda } = fixture();
    try {
      await port.reminders.createTodo({
        todoId: "todo-plumber",
        workspaceId: "default",
        principalId: "operator",
        text: "Call the plumber",
        due: "2026-10-24T17:00:00.000Z",
        timezone: "Europe/Berlin",
        deliverTo: { kind: "app" },
        createdBy: "user",
        operationKey: "op-plumber",
        now: NOW,
      });
      const items = agenda();
      expect(items).toEqual([
        expect.objectContaining({ kind: "reminder", id: "todo-plumber", todo: true, at: "2026-10-24T17:00:00.000Z" }),
      ]);
    } finally {
      store.close();
    }
  });

  it("refuses a malformed window", () => {
    const { store, agenda } = fixture();
    try {
      expect(() => agenda({ limit: 0 })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    } finally {
      store.close();
    }
  });
});
