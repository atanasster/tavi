import type { AdmissionOutcome, AdmissionRecord, ClientEvent } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  automaticDecision,
  followWorkers,
  nextSettledOutcome,
  waitsOnWorkers,
  type RoundDecision,
} from "../../src/features/run/workers.js";
import { delay } from "@tavi/test-support";

/** A bus whose tasks' events are published by the test, delivered to whoever subscribed (and replayed to a late one). */
function bus() {
  const events = new Map<string, ClientEvent[]>();
  const listeners = new Map<string, ((event: ClientEvent) => void)[]>();
  return {
    publish(taskId: string, event: Record<string, unknown>) {
      const sent = event as unknown as ClientEvent;
      events.set(taskId, [...(events.get(taskId) ?? []), sent]);
      for (const deliver of listeners.get(taskId) ?? []) deliver(sent);
    },
    subscribe(taskId: string, deliver: (event: ClientEvent) => void) {
      for (const event of events.get(taskId) ?? []) deliver(event);
      listeners.set(taskId, [...(listeners.get(taskId) ?? []), deliver]);
      return () =>
        listeners.set(
          taskId,
          (listeners.get(taskId) ?? []).filter((listener) => listener !== deliver),
        );
    },
  };
}

const round = (admissionId: string, steps: number, callIds: readonly string[]): AdmissionRecord =>
  ({
    admissionId,
    state: "committed",
    result: {
      status: "waiting",
      interrupt: { requests: callIds.map((callId) => ({ callId, toolName: "browser.navigate", summary: "open", input: {}, steps })) },
    },
  }) as unknown as AdmissionRecord;

const settle = () => delay(0);

describe("a one-shot run's workers", () => {
  it("decides the rounds of the workers the task spawns, and theirs, once each, never the task's own", async () => {
    const events = bus();
    const admissions = new Map<string, AdmissionRecord>([
      ["root", round("r1", 1, ["own"])],
      ["w1", round("a1", 2, ["c1", "c2"])],
      ["w2", round("a2", 3, ["c3"])],
    ]);
    const resumed: { taskId: string; steps: number; decisions: readonly RoundDecision[] }[] = [];
    const follower = followWorkers("root", {
      subscribe: (taskId, deliver) => events.subscribe(taskId, deliver),
      latestSettledAdmission: async (taskId) => admissions.get(taskId),
      decide: async (_taskId, requests) => requests.map((request) => ({ callId: request.callId, approved: true, decidedBy: "auto" })),
      resume: async (taskId, steps, decisions) => void resumed.push({ taskId, steps, decisions }),
      report: () => undefined,
      sleep: async () => undefined,
    });
    // A worker spawned before the follow began is found in what the bus retained.
    events.publish("root", { kind: "approval.required", steps: 1 });
    events.publish("root", { kind: "task.spawned", childRunId: "w1" });
    events.publish("w1", { kind: "approval.required", steps: 2, callId: "c1" });
    events.publish("w1", { kind: "approval.required", steps: 2, callId: "c2" });
    // A worker's own worker is followed too.
    events.publish("w1", { kind: "task.spawned", childRunId: "w2" });
    events.publish("w2", { kind: "approval.required", steps: 3, callId: "c3" });
    await settle();
    await settle();
    expect(resumed).toEqual([
      {
        taskId: "w1",
        steps: 2,
        decisions: [
          { callId: "c1", approved: true, decidedBy: "auto" },
          { callId: "c2", approved: true, decidedBy: "auto" },
        ],
      },
      { taskId: "w2", steps: 3, decisions: [{ callId: "c3", approved: true, decidedBy: "auto" }] },
    ]);
    expect([follower.follows("w1"), follower.follows("w2"), follower.follows("root"), follower.follows("elsewhere")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    follower.stop();
    events.publish("w1", { kind: "approval.required", steps: 4 });
    await settle();
    expect(resumed).toHaveLength(2);
  });

  it("decides a second worker's round while the first worker's resumed turn still runs", async () => {
    const events = bus();
    const resumed: string[] = [];
    let finishFirst: () => void = () => undefined;
    followWorkers("root", {
      subscribe: (taskId, deliver) => events.subscribe(taskId, deliver),
      latestSettledAdmission: async (taskId) => round(`a-${taskId}`, 1, [`c-${taskId}`]),
      decide: async (_taskId, requests) => requests.map((request) => ({ callId: request.callId, approved: true })),
      // The first worker's turn runs on until the test ends it: a resume is its whole turn.
      resume: (taskId) => (
        resumed.push(taskId), taskId === "w1" ? new Promise<void>((resolve) => (finishFirst = resolve)) : Promise.resolve()
      ),
      report: () => undefined,
      sleep: async () => undefined,
    });
    events.publish("root", { kind: "task.spawned", childRunId: "w1" });
    events.publish("root", { kind: "task.spawned", childRunId: "w2" });
    events.publish("w1", { kind: "approval.required", steps: 1 });
    events.publish("w2", { kind: "approval.required", steps: 1 });
    for (let tick = 0; tick < 5; tick += 1) await settle();
    expect(resumed).toEqual(["w1", "w2"]);
    finishFirst();
  });

  it("leaves a round for a person when the run has no policy and no terminal, saying how to decide it", async () => {
    const events = bus();
    const reported: string[] = [];
    followWorkers("root", {
      subscribe: (taskId, deliver) => events.subscribe(taskId, deliver),
      latestSettledAdmission: async () => round("a1", 2, ["c1"]),
      decide: async () => undefined,
      resume: async () => {
        throw new Error("must not resume");
      },
      report: (message) => void reported.push(message),
      sleep: async () => undefined,
    });
    events.publish("root", { kind: "task.spawned", childRunId: "w1" });
    events.publish("w1", { kind: "approval.required", steps: 2 });
    await settle();
    await settle();
    expect(reported).toEqual(["Worker w1 is waiting on an approval: decide it with `tavi approvals approve w1` (or reject)."]);
  });

  it("sits out only a wait on a worker, and answers the task's next outcome or nothing past the deadline", async () => {
    const onWorker = {
      status: "waiting",
      waitInterrupt: { wait: { waitId: "w", waitingOnWorkerTaskId: "w1", deadlineAt: "2026-10-08T12:00:00.000Z" } },
    } as unknown as AdmissionOutcome;
    const onQuestion = {
      status: "waiting",
      waitInterrupt: { wait: { waitId: "q", deadlineAt: "2026-10-08T12:00:00.000Z" } },
    } as unknown as AdmissionOutcome;
    expect(waitsOnWorkers(onWorker)).toBe(true);
    expect(waitsOnWorkers(onQuestion)).toBe(false);
    expect(waitsOnWorkers({ status: "completed", finalText: "x" } as AdmissionOutcome)).toBe(false);

    let polls = 0;
    const done = { status: "completed", finalText: "answered" } as unknown as AdmissionOutcome;
    const latest = async () =>
      ({ admissionId: polls >= 2 ? "next" : "first", result: polls >= 2 ? done : onWorker }) as unknown as AdmissionRecord;
    const clock = Date.parse("2026-10-08T11:00:00.000Z");
    expect(
      await nextSettledOutcome(
        "root",
        "2026-10-08T12:00:00.000Z",
        { latestSettledAdmission: latest, now: () => clock, sleep: async () => void (polls += 1) },
        new AbortController().signal,
      ),
    ).toBe(done);

    let time = clock;
    const stuck = async () => ({ admissionId: "first", result: onWorker }) as unknown as AdmissionRecord;
    expect(
      await nextSettledOutcome(
        "root",
        "2026-10-08T11:00:01.000Z",
        { latestSettledAdmission: stuck, now: () => time, sleep: async () => void (time += 60_000), graceMs: 0 },
        new AbortController().signal,
      ),
    ).toBeUndefined();
    // Past the deadline, a turn still running (the one the deadline started) is waited for.
    let turns = 0;
    const late = async () =>
      ({ admissionId: turns >= 3 ? "late" : "first", result: turns >= 3 ? done : onWorker }) as unknown as AdmissionRecord;
    time = Date.parse("2026-10-08T13:00:00.000Z");
    expect(
      await nextSettledOutcome(
        "root",
        "2026-10-08T11:00:01.000Z",
        { latestSettledAdmission: late, running: async () => turns < 3, now: () => time, sleep: async () => void (turns += 1), graceMs: 0 },
        new AbortController().signal,
      ),
    ).toBe(done);
  });
});

describe("automaticDecision — `--approval approve|deny` in a run nobody attends", () => {
  const risk = (level: "medium" | "critical", tainted: boolean) => ({ level, reasons: [], tainted });

  it("refuses a taint-step ask, a tainted askWhenTainted call and a critical call under approve, with the reason", () => {
    expect(
      automaticDecision({ callId: "a", tainted: true, gateReason: "novel-url", risk: risk("medium", true) }, true, "auto:op"),
    ).toMatchObject({ callId: "a", approved: false, decidedBy: "auto:op", note: expect.stringContaining("(novel-url)") });
    expect(
      automaticDecision({ callId: "b", tainted: true, askWhenTainted: true, risk: risk("medium", true) }, true, "auto:op"),
    ).toMatchObject({ approved: false, note: expect.stringContaining("asks a person") });
    expect(automaticDecision({ callId: "c", risk: risk("critical", false) }, true, "auto:op")).toMatchObject({
      approved: false,
      note: expect.stringContaining("critical"),
    });
  });

  it("under security.taint = observe, approves a tainted call whose only reason is an observed one, and still refuses a tainted askWhenTainted call and a critical one", () => {
    // Observe puts no gateReason on the entry: the taint step's would-be ask is only recorded.
    expect(automaticDecision({ callId: "g", tainted: true, risk: risk("medium", true) }, true, "auto:op")).toEqual({
      callId: "g",
      approved: true,
      decidedBy: "auto:op",
    });
    expect(
      automaticDecision({ callId: "h", tainted: true, askWhenTainted: true, risk: risk("medium", true) }, true, "auto:op"),
    ).toMatchObject({ approved: false, note: expect.stringContaining("asks a person") });
    expect(automaticDecision({ callId: "i", tainted: true, risk: risk("critical", true) }, true, "auto:op")).toMatchObject({
      approved: false,
      note: expect.stringContaining("critical"),
    });
  });

  it("refuses a call only a person decides under approve, clean or not", () => {
    expect(
      automaticDecision({ callId: "p", tainted: false, attendedOnly: true, risk: risk("medium", false) }, true, "auto:op"),
    ).toMatchObject({ approved: false, note: expect.stringContaining("a person reviews") });
  });

  it("approves the rest under approve, a round from before the fields included, and refuses everything under deny", () => {
    expect(automaticDecision({ callId: "d", tainted: false, askWhenTainted: true, risk: risk("medium", false) }, true, "auto:op")).toEqual({
      callId: "d",
      approved: true,
      decidedBy: "auto:op",
    });
    expect(automaticDecision({ callId: "e" }, true, "auto:op")).toEqual({ callId: "e", approved: true, decidedBy: "auto:op" });
    expect(automaticDecision({ callId: "f", gateReason: "novel-url" }, false, "auto:op")).toEqual({
      callId: "f",
      approved: false,
      decidedBy: "auto:op",
    });
  });
});
