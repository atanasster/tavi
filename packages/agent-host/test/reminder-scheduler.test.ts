import type {
  ClaimDueRemindersInput,
  ClaimDueRemindersResult,
  RecordReminderOutcomeInput,
  Reminder,
  ReminderDeliveryPort,
  ReminderFire,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";
import { sleep } from "@tavi/node-kit";

import {
  inAppReminderDelivery,
  startReminderScheduler,
  sweepReminders,
  type ReminderSchedulerDependencies,
} from "../src/schedulers/reminder-scheduler.js";

/**
 * The reminder scheduler, against a fake
 * clock, a fake store that claims each fire once, and a fake delivery port.
 * The claim rules themselves (missed fires, exactly-once) are the store's and
 * are tested in the runtime.
 */

const reminder = (reminderId: string): Reminder => ({
  reminderId,
  workspaceId: "default",
  principalId: "operator",
  text: `Reminder ${reminderId}`,
  when: { kind: "once", at: "2026-10-01T13:00:00.000Z" },
  timezone: "UTC",
  deliverTo: { kind: "app" },
  status: "active",
  nextFireAt: "2026-10-01T13:00:00.000Z",
  lastFiredAt: null,
  createdBy: "user",
  operationKey: `op-${reminderId}`,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
});

function fakeStore(fires: readonly { reminderId: string; fireAt: string }[]) {
  const claimed = new Set<string>();
  const outcomes: RecordReminderOutcomeInput[] = [];
  const claims: ClaimDueRemindersInput[] = [];
  const reminders: ReminderSchedulerDependencies["reminders"] = {
    claimDue: (input) => {
      claims.push(input);
      const due = fires
        .filter((fire) => fire.fireAt <= input.now && !claimed.has(`${fire.reminderId}@${fire.fireAt}`))
        .slice(0, input.limit);
      for (const fire of due) claimed.add(`${fire.reminderId}@${fire.fireAt}`);
      const result: ClaimDueRemindersResult = {
        claimed: due.map((fire) => {
          const record: ReminderFire = {
            reminderId: fire.reminderId,
            fireAt: fire.fireAt,
            firedAt: input.now,
            outcome: "pending",
            occurrence: "once",
          };
          return { reminder: reminder(fire.reminderId), fire: record, late: false };
        }),
        missed: 0,
      };
      return Promise.resolve(result);
    },
    recordOutcome: (input) => {
      outcomes.push(input);
      return Promise.resolve(true);
    },
  };
  return { reminders, outcomes, claims };
}

function clock(start: string) {
  let now = Date.parse(start);
  return {
    now: () => new Date(now).toISOString(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const quiet: ReminderSchedulerDependencies["log"] = () => {};

describe("sweepReminders", () => {
  it("delivers each due fire once, as the clock reaches it, and records the port's outcome", async () => {
    const time = clock("2026-10-01T12:59:00.000Z");
    const store = fakeStore([
      { reminderId: "a", fireAt: "2026-10-01T13:00:00.000Z" },
      { reminderId: "b", fireAt: "2026-10-01T13:30:00.000Z" },
    ]);
    const asked: string[] = [];
    const delivery: ReminderDeliveryPort = {
      deliver: ({ reminder: target, late }) => {
        asked.push(`${target.reminderId}${late ? " late" : ""}`);
        return Promise.resolve(
          target.reminderId === "a" ? { outcome: "delivered-in-app" as const } : { outcome: "delivered" as const, taskId: "task-b" },
        );
      },
    };
    const deps = { reminders: store.reminders, delivery, now: time.now, log: quiet };

    expect(await sweepReminders(deps)).toEqual({ delivered: [], missed: 0 });
    time.advance(90_000);
    expect((await sweepReminders(deps)).delivered).toEqual([
      { reminderId: "a", fireAt: "2026-10-01T13:00:00.000Z", outcome: "delivered-in-app", late: false },
    ]);
    expect((await sweepReminders(deps)).delivered).toEqual([]);
    time.advance(30 * 60_000);
    await sweepReminders(deps);
    expect(asked).toEqual(["a", "b"]);
    expect(store.outcomes.map((outcome) => [outcome.reminderId, outcome.outcome, outcome.taskId])).toEqual([
      ["a", "delivered-in-app", undefined],
      ["b", "delivered", "task-b"],
    ]);
  });

  it("retries a delivery that throws, with backoff, and goes on with the others", async () => {
    const store = fakeStore([
      { reminderId: "broken", fireAt: "2026-10-01T13:00:00.000Z" },
      { reminderId: "fine", fireAt: "2026-10-01T13:00:00.000Z" },
    ]);
    const logged: string[] = [];
    const delivery: ReminderDeliveryPort = {
      deliver: ({ reminder: target }) =>
        target.reminderId === "broken"
          ? Promise.reject(new Error("connector down"))
          : inAppReminderDelivery.deliver({ reminder: target, fire: {} as ReminderFire, late: false }),
    };
    const result = await sweepReminders({
      reminders: store.reminders,
      delivery,
      now: () => "2026-10-01T13:00:10.000Z",
      log: (event) => logged.push(event.message),
    });
    expect(result.delivered.map((entry) => [entry.reminderId, entry.outcome])).toEqual([
      ["broken", "retry"],
      ["fine", "delivered-in-app"],
    ]);
    expect(store.outcomes.map((outcome) => [outcome.outcome, outcome.retryAt])).toEqual([
      ["retry", "2026-10-01T13:00:40.000Z"],
      ["delivered-in-app", undefined],
    ]);
    expect(logged).toContain("reminder delivery threw");
  });

  it("backs off from the attempts so far, and shows the reminder in the app once the retry window has passed", async () => {
    const outcomes: RecordReminderOutcomeInput[] = [];
    const claimedWith = (fire: Partial<ReminderFire>): ReminderSchedulerDependencies["reminders"] => ({
      claimDue: (input) =>
        Promise.resolve({
          claimed: [
            {
              reminder: reminder("broken"),
              fire: {
                reminderId: "broken",
                fireAt: "2026-10-01T13:00:00.000Z",
                firedAt: input.now,
                outcome: "pending",
                occurrence: "once",
                ...fire,
              },
              late: false,
            },
          ],
          missed: 0,
        }),
      recordOutcome: (input) => {
        outcomes.push(input);
        return Promise.resolve(true);
      },
    });
    const delivery: ReminderDeliveryPort = { deliver: () => Promise.reject(new Error("connector down")) };
    await sweepReminders({
      reminders: claimedWith({ attempts: 2, retryUntil: "2026-10-01T13:15:10.000Z" }),
      delivery,
      now: () => "2026-10-01T13:02:00.000Z",
      log: quiet,
    });
    await sweepReminders({
      reminders: claimedWith({ attempts: 2, retryUntil: "2026-10-01T13:02:30.000Z" }),
      delivery,
      now: () => "2026-10-01T13:02:00.000Z",
      log: quiet,
    });
    await sweepReminders({
      reminders: claimedWith({ attempts: 6, retryUntil: "2026-10-01T13:15:10.000Z" }),
      delivery,
      now: () => "2026-10-01T13:15:10.000Z",
      log: quiet,
    });
    expect(outcomes.map((outcome) => [outcome.outcome, outcome.retryAt])).toEqual([
      ["retry", "2026-10-01T13:04:00.000Z"],
      ["retry", "2026-10-01T13:02:30.000Z"],
      ["delivered-in-app", undefined],
    ]);
  });
});

describe("a delivery the channel refused", () => {
  it("records the retry and its time, so the store claims the fire again then", async () => {
    const store = fakeStore([{ reminderId: "chat", fireAt: "2026-10-01T13:00:00.000Z" }]);
    const delivery: ReminderDeliveryPort = {
      deliver: () => Promise.resolve({ outcome: "retry", retryAt: "2026-10-01T13:00:40.000Z", taskId: "task-1" }),
    };
    const result = await sweepReminders({ reminders: store.reminders, delivery, now: () => "2026-10-01T13:00:10.000Z", log: quiet });
    expect(result.delivered.map((entry) => entry.outcome)).toEqual(["retry"]);
    expect(store.outcomes).toEqual([
      {
        reminderId: "chat",
        fireAt: "2026-10-01T13:00:00.000Z",
        outcome: "retry",
        retryAt: "2026-10-01T13:00:40.000Z",
        taskId: "task-1",
        now: "2026-10-01T13:00:10.000Z",
      },
    ]);
  });
});

describe("a delivery that never answers", () => {
  it("is retried after the delivery timeout, and the next sweep still claims what came due", async () => {
    const time = clock("2026-10-01T13:00:10.000Z");
    const store = fakeStore([
      { reminderId: "stuck", fireAt: "2026-10-01T13:00:00.000Z" },
      { reminderId: "later", fireAt: "2026-10-01T13:05:00.000Z" },
    ]);
    const delivery: ReminderDeliveryPort = {
      deliver: ({ reminder: target }) =>
        target.reminderId === "stuck"
          ? new Promise(() => {})
          : inAppReminderDelivery.deliver({ reminder: target, fire: {} as ReminderFire, late: false }),
    };
    const deps = { reminders: store.reminders, delivery, now: time.now, log: quiet, deliveryTimeoutMs: 20 };
    expect((await sweepReminders(deps)).delivered.map((entry) => [entry.reminderId, entry.outcome])).toEqual([["stuck", "retry"]]);
    time.advance(5 * 60_000);
    expect((await sweepReminders(deps)).delivered.map((entry) => [entry.reminderId, entry.outcome])).toEqual([
      ["later", "delivered-in-app"],
    ]);
    expect(store.outcomes.map((outcome) => [outcome.reminderId, outcome.outcome])).toEqual([
      ["stuck", "retry"],
      ["later", "delivered-in-app"],
    ]);
  });

  it("does not hold stop up past the delivery in progress", async () => {
    const store = fakeStore([
      { reminderId: "a", fireAt: "2026-10-01T13:00:00.000Z" },
      { reminderId: "b", fireAt: "2026-10-01T13:00:00.000Z" },
    ]);
    const delivery: ReminderDeliveryPort = { deliver: () => new Promise(() => {}) };
    const handle = startReminderScheduler({
      reminders: store.reminders,
      delivery,
      now: () => "2026-10-01T13:00:10.000Z",
      log: quiet,
      intervalMs: 5,
      deliveryTimeoutMs: 30,
    });
    await sleep(5);
    await handle.stop();
    // The delivery in flight timed out and was recorded; the other stays claimed for its lease.
    expect(store.outcomes.map((outcome) => [outcome.reminderId, outcome.outcome])).toEqual([["a", "retry"]]);
  });
});

describe("startReminderScheduler", () => {
  it("sweeps at once on start, never overlaps, and stop waits for the sweep in flight", async () => {
    const store = fakeStore([{ reminderId: "a", fireAt: "2026-10-01T13:00:00.000Z" }]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deliveries = 0;
    const delivery: ReminderDeliveryPort = {
      deliver: async () => {
        deliveries += 1;
        await gate;
        return { outcome: "delivered-in-app" };
      },
    };
    const handle = startReminderScheduler({
      reminders: store.reminders,
      delivery,
      now: () => "2026-10-01T13:00:10.000Z",
      log: quiet,
      intervalMs: 5,
    });
    // The start sweep is still delivering: a tick or a manual sweep joins it rather than starting another.
    const joined = handle.sweep();
    await sleep(30);
    expect(store.claims).toHaveLength(1);
    expect(deliveries).toBe(1);

    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await sleep(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await joined)?.delivered).toHaveLength(1);
    expect(store.outcomes).toHaveLength(1);
    // Stopped: no more sweeps.
    const claims = store.claims.length;
    await sleep(20);
    expect(store.claims).toHaveLength(claims);
    expect(await handle.sweep()).toBeUndefined();
  });
});
