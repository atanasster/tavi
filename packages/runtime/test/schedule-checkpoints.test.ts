import { expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/** A schedule that may ask needs an alert destination to ask in. */

const NOW = "2026-10-02T12:00:00.000Z";
const base = {
  workspaceId: "default",
  principalId: "operator",
  prompt: "Write the brief",
  spec: { at: "07:00", timezone: "UTC" },
  missedRunPolicy: "skip" as const,
  autoApproveTools: [],
  enabled: true,
  nextRunAt: NOW,
  now: NOW,
};
const alert = { connectionId: "telegram-main", destination: "123" };

it("keeps a schedule's choice to ask, only with an alert destination, and reads an older row as never asking", () => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  try {
    const schedules = store.asPort().repositories.schedules;
    expect(() => schedules.create({ ...base, scheduleId: "s-nowhere", name: "Nowhere", humanCheckpoints: "ask-with-default" })).toThrow(
      /alert destination to ask in/,
    );
    expect(schedules.get("s-nowhere")).toBeUndefined();

    expect(
      schedules.create({ ...base, scheduleId: "s-ask", name: "Ask", alert, humanCheckpoints: "ask-with-default" }).humanCheckpoints,
    ).toBe("ask-with-default");
    expect(schedules.create({ ...base, scheduleId: "s-quiet", name: "Quiet" }).humanCheckpoints).toBeUndefined();
    // Clearing the alert of a schedule that asks is refused, and changes nothing.
    expect(() => schedules.update({ scheduleId: "s-ask", alert: null, now: NOW })).toThrow(/alert destination to ask in/);
    expect(schedules.get("s-ask")?.alert).toEqual(alert);
    // Turning it off, then clearing the alert, is fine.
    expect(schedules.update({ scheduleId: "s-ask", humanCheckpoints: "off", now: NOW })).toBe(true);
    expect(schedules.get("s-ask")?.humanCheckpoints).toBeUndefined();
    expect(schedules.update({ scheduleId: "s-ask", alert: null, now: NOW })).toBe(true);
    // Turning it on without an alert is refused.
    expect(() => schedules.update({ scheduleId: "s-quiet", humanCheckpoints: "ask-with-default", now: NOW })).toThrow(
      /alert destination to ask in/,
    );
    // A hand-edited value is an unreadable row, never read as asking.
    store.handle.prepare("UPDATE tavi_schedules SET human_checkpoints = 'always' WHERE schedule_id = 's-quiet'").run();
    expect(() => schedules.get("s-quiet")).toThrow();
  } finally {
    store.close();
  }
});

it("keeps a schedule's delivery into Home, and clears it", () => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  try {
    const schedules = store.asPort().repositories.schedules;
    expect(schedules.create({ ...base, scheduleId: "s-home", name: "Home", deliverTo: "home" }).deliverTo).toBe("home");
    expect(schedules.create({ ...base, scheduleId: "s-none", name: "None" }).deliverTo).toBeUndefined();
    expect(schedules.update({ scheduleId: "s-none", deliverTo: "home", now: NOW })).toBe(true);
    expect(schedules.get("s-none")?.deliverTo).toBe("home");
    expect(schedules.update({ scheduleId: "s-home", deliverTo: null, now: NOW })).toBe(true);
    expect(schedules.get("s-home")?.deliverTo).toBeUndefined();
    expect(() => store.handle.prepare("UPDATE tavi_schedules SET deliver_to = 'telegram' WHERE schedule_id = 's-none'").run()).toThrow(
      /CHECK/,
    );
  } finally {
    store.close();
  }
});
