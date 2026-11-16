import { describe, expect, it, vi } from "vitest";

import { CLIENT_PROTOCOL_VERSION, type ClientEvent, type UnsequencedClientEvent } from "@tavi/contracts";

import { createRunEventBus, encodedEventBytes } from "../src/ipc/bus.js";

/**
 * `RunEventBus`.
 *
 * The properties under test are the ones a client's correctness rests on:
 * sequencing per task across admissions, an epoch that invalidates cursors
 * honestly, bytes-bounded retention, and an eviction order that finishes with
 * completed transcripts before it touches a live one.
 */

const diag = () => vi.fn();

const bus = (overrides: Partial<Parameters<typeof createRunEventBus>[0]> = {}) =>
  createRunEventBus({ epoch: "session-1", onDiagnostic: diag(), ...overrides });

/** A delta whose encoded size is predictable, for the byte-bound tests. */
const delta = (taskId: string, text: string): UnsequencedClientEvent => ({
  kind: "text.delta",
  runId: taskId,
  attemptId: "attempt-1",
  blockId: "block-1",
  text,
});

describe("sequencing", () => {
  it("numbers one task's events continuously across three admissions", () => {
    const events = bus();
    // A task spans start, approval and reply: three admissions, one stream.
    events.publish("task-1", { ...delta("task-1", "a"), kind: "run.started", threadId: "t", workspaceId: "w" } as never);
    events.publish("task-1", delta("task-1", "b"));
    events.publish("task-1", { ...delta("task-1", ""), kind: "task.completed", finalText: "done" } as never);

    const { replayed } = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(replayed.map((event) => event.sequence)).toEqual([0, 1, 2]);
    // Not "one sequence per admission": a subscriber sees one ordered stream.
    expect(new Set(replayed.map((event) => event.epoch))).toEqual(new Set(["session-1"]));
  });

  it("numbers each task independently", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "a"));
    events.publish("task-2", delta("task-2", "b"));
    events.publish("task-1", delta("task-1", "c"));

    const one = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    const two = events.subscribe({ taskId: "task-2", from: "beginning", deliver: () => {} });
    expect(one.replayed.map((event) => event.sequence)).toEqual([0, 1]);
    expect(two.replayed.map((event) => event.sequence)).toEqual([0]);
  });

  it("stamps the protocol version and an `at` the producer did not supply", () => {
    const events = bus({ now: () => "2026-01-01T00:00:00.000Z" });
    const published = events.publish("task-1", delta("task-1", "a"));
    expect(published.protocolVersion).toBe(CLIENT_PROTOCOL_VERSION);
    expect(published.at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("says whether it holds anything for a task: nothing it never saw, or forgot", () => {
    // What a producer re-reporting a recorded outcome asks: only an empty stream
    // needs it, since one that holds events carries its own end.
    const events = bus();
    expect(events.retains("task-1")).toBe(false);
    // Subscribing creates no event.
    events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(events.retains("task-1")).toBe(false);
    events.publish("task-1", delta("task-1", "a"));
    expect(events.retains("task-1")).toBe(true);
    events.forget("task-1");
    expect(events.retains("task-1")).toBe(false);
  });

  it("refuses to publish an event that violates the contract", () => {
    const events = bus();
    expect(() => events.publish("task-1", { kind: "text.delta", runId: "task-1" } as never)).toThrow();
  });
});

describe("subscriptions and cursors", () => {
  it("answers a task's head, from which a subscription yields exactly what follows", () => {
    const events = bus();
    // Nothing published, or a ring gone: no cursor to answer from.
    expect(events.head("task-1")).toBeUndefined();
    events.publish("task-1", delta("task-1", "a"));
    events.publish("task-1", delta("task-1", "b"));
    const head = events.head("task-1");
    expect(head).toEqual({ epoch: "session-1", sequence: 1 });

    events.publish("task-1", delta("task-1", "c"));
    const { replayed } = events.subscribe({ taskId: "task-1", from: head ?? "beginning", deliver: () => {} });
    expect(replayed.map((event) => (event as Extract<ClientEvent, { kind: "text.delta" }>).text)).toEqual(["c"]);

    events.forget("task-1");
    expect(events.head("task-1")).toBeUndefined();
  });

  it("replays from the requested sequence, exclusive", () => {
    const events = bus();
    for (let index = 0; index < 5; index += 1) events.publish("task-1", delta("task-1", `${index}`));

    const { replayed } = events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: 1 }, deliver: () => {} });
    expect(replayed.map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it("delivers live events after replay, and stops after unsubscribe", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "before"));
    const seen: number[] = [];
    const { subscription } = events.subscribe({
      taskId: "task-1",
      from: "beginning",
      deliver: (event) => seen.push(event.sequence),
    });
    events.publish("task-1", delta("task-1", "live"));
    expect(seen).toContain(1);

    subscription.unsubscribe();
    events.publish("task-1", delta("task-1", "after"));
    expect(seen).not.toContain(2);
    expect(events.stats().subscriptions).toBe(0);
  });

  it("reports the last delivered sequence, so a reconnect has a cursor", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "a"));
    const { subscription } = events.subscribe({ taskId: "task-1", deliver: () => {} });
    events.publish("task-1", delta("task-1", "b"));
    expect(subscription.delivered()).toBe(1);
  });

  it("reports no cursor for a subscriber that has seen nothing, rather than 0", () => {
    // A cursor at 0 means "sequence 0 was seen": reconnecting from it would skip
    // the stream's first event, typically `run.started`.
    const events = bus();
    const { subscription } = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(subscription.delivered()).toBeUndefined();
    events.publish("task-1", delta("task-1", "first"));
    expect(subscription.delivered()).toBe(0);
  });

  it("streams from now when no cursor is given, replaying nothing", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "already"));
    const { replayed, resync } = events.subscribe({ taskId: "task-1", deliver: () => {} });
    expect(replayed).toEqual([]);
    expect(resync).toBeNull();
  });

  it("resyncs when the cursor names another epoch", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "a"));
    const { resync } = events.subscribe({
      taskId: "task-1",
      from: { epoch: "session-0", sequence: 0 },
      deliver: () => {},
    });
    expect(resync?.kind).toBe("resync.required");
    // The reason distinguishes "the owner restarted" from "the ring moved on".
    expect(resync?.kind === "resync.required" && resync.reason).toMatch(/restarted/);
  });

  it("resyncs when the cursor's sequence has been evicted", () => {
    // A ring small enough to retain only the last event or two.
    const events = bus({ ringBytes: 400 });
    for (let index = 0; index < 40; index += 1) events.publish("task-1", delta("task-1", "x".repeat(50)));

    const { resync } = events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: 0 }, deliver: () => {} });
    expect(resync?.kind).toBe("resync.required");
    expect(resync?.kind === "resync.required" && resync.reason).toMatch(/no longer retained/);
  });

  it("gives every stale subscriber of a silent task one shared marker, so each is followed directly by the first event", () => {
    // After a restart every attached front end resubscribes with its old
    // epoch's cursor, and a task suspended on a decision publishes nothing
    // until it is decided.
    const events = bus({ epoch: "session-2" });
    const streams: ClientEvent[][] = [[], [], []];
    for (const stream of streams) {
      const { resync } = events.subscribe({
        taskId: "task-1",
        from: { epoch: "session-1", sequence: 4 },
        deliver: (event) => stream.push(event),
      });
      if (resync !== null) stream.push(resync);
    }
    events.publish("task-1", delta("task-1", "decided"));
    for (const stream of streams) {
      expect(stream.map((event) => [event.kind, event.sequence])).toEqual([
        ["resync.required", 0],
        ["text.delta", 1],
      ]);
    }
  });

  it("numbers the first live event after a resync above the marker", () => {
    const events = bus({ ringBytes: 300 });
    for (let index = 0; index < 30; index += 1) events.publish("task-1", delta("task-1", "x".repeat(50)));
    const seen: ClientEvent[] = [];
    const { resync } = events.subscribe({
      taskId: "task-1",
      from: { epoch: "session-1", sequence: 0 },
      deliver: (event) => seen.push(event),
    });
    expect(resync).not.toBeNull();
    // Live delivery continues after the resync marker.
    events.publish("task-1", delta("task-1", "after"));
    expect(seen.at(-1)?.sequence).toBe((resync?.sequence ?? 0) + 1);
  });
});

describe("byte-bounded retention", () => {
  it("bounds a 10 000-event run at the true per-event bound, and joins at every thousandth sequence", () => {
    // The true bound for one `text.delta`: 64 Ki characters that each JSON-escape
    // to six bytes — ~384 KiB encoded, three times what a schema-length budget
    // would assume. Every event of the run is at that bound, so the ring's 2 MiB
    // holds a handful and trimming runs on almost every publish.
    const worst = String.fromCharCode(1).repeat(64 * 1024);
    const events = bus();
    const first = events.publish("task-1", delta("task-1", worst));
    expect(encodedEventBytes(first)).toBeGreaterThan(6 * 64 * 1024);

    /** Per subscriber: the sequences it was delivered, and where it started. */
    const joined: { readonly from: number; readonly seen: number[] }[] = [];
    for (let sequence = 1; sequence < 10_000; sequence += 1) {
      events.publish("task-1", delta("task-1", worst));
      expect(events.stats().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      if (sequence % 1_000 !== 0) continue;

      // A cursor one behind the head is still retained: it replays exactly the
      // event it missed, and nothing else.
      const fresh: number[] = [];
      const answered = events.subscribe({
        taskId: "task-1",
        from: { epoch: "session-1", sequence: sequence - 1 },
        deliver: (event) => fresh.push(event.sequence),
      });
      expect(answered.resync).toBeNull();
      expect(answered.replayed.map((event) => event.sequence)).toEqual([sequence]);
      joined.push({ from: sequence + 1, seen: fresh });

      // A cursor a thousand behind has been trimmed: one resync for this joiner,
      // numbered at the head, and the stream is marked truncated.
      const stale: number[] = [];
      const resynced = events.subscribe({
        taskId: "task-1",
        from: { epoch: "session-1", sequence: sequence - 1_000 },
        deliver: (event) => stale.push(event.sequence),
      });
      expect(resynced.replayed).toEqual([]);
      expect(resynced.resync?.sequence).toBe(sequence);
      expect(resynced.truncated).toBe(true);
      joined.push({ from: sequence + 1, seen: stale });
    }

    // Every joiner then saw a contiguous run to the end: no gap, no repeat.
    for (const { from, seen } of joined) {
      expect(seen).toEqual(Array.from({ length: 10_000 - from }, (_, index) => from + index));
    }
    // And a late "beginning" replay is the tail, flagged as truncated.
    const late = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(late.truncated).toBe(true);
    expect(late.replayed.at(-1)?.sequence).toBe(9_999);
    expect(late.replayed.length).toBeLessThan(10);
  }, 120_000);

  it("reports a whole transcript as not truncated", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "a"));
    events.publish("task-1", delta("task-1", "b"));
    const { replayed, truncated } = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(replayed.map((event) => event.sequence)).toEqual([0, 1]);
    expect(truncated).toBe(false);
  });
});

describe("the resync marker", () => {
  it("goes to the joining subscriber only, and never into a later replay", () => {
    const events = bus({ ringBytes: 300 });
    const sibling: string[] = [];
    events.subscribe({ taskId: "task-1", deliver: (event) => sibling.push(event.kind) });
    for (let index = 0; index < 30; index += 1) events.publish("task-1", delta("task-1", "x".repeat(50)));

    // One client reconnects with a stale cursor…
    const { resync } = events.subscribe({ taskId: "task-1", from: { epoch: "session-0", sequence: 3 }, deliver: () => {} });
    expect(resync?.kind).toBe("resync.required");
    // …and the healthy sibling is not told to throw its state away.
    expect(sibling).not.toContain("resync.required");
    const replay = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(replay.replayed.map((event) => event.kind)).not.toContain("resync.required");
  });

  it("is numbered at the head, so re-subscribing from it is caught up and misses nothing", () => {
    const events = bus({ ringBytes: 300 });
    for (let index = 0; index < 30; index += 1) events.publish("task-1", delta("task-1", "x".repeat(50)));
    const { resync } = events.subscribe({ taskId: "task-1", from: { epoch: "session-0", sequence: 0 }, deliver: () => {} });
    expect(resync?.sequence).toBe(29);

    // The client stores the marker as its cursor and reconnects before the next
    // event: no second resync, and the next event is not skipped.
    const again = events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: 29 }, deliver: () => {} });
    expect(again.resync).toBeNull();
    const seen: number[] = [];
    events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: 29 }, deliver: (event) => seen.push(event.sequence) });
    events.publish("task-1", delta("task-1", "next"));
    expect(seen).toEqual([30]);
  });

  it("reserves a sequence for a stream that has published nothing, so its first event is numbered above it", () => {
    const events = bus();
    const seen: number[] = [];
    const early: number[] = [];
    // A "beginning" subscriber that joined before anything happened.
    events.subscribe({ taskId: "task-1", from: "beginning", deliver: (event) => early.push(event.sequence) });
    const { resync } = events.subscribe({
      taskId: "task-1",
      from: { epoch: "session-0", sequence: 12 },
      deliver: (event) => seen.push(event.sequence),
    });
    expect(resync?.sequence).toBe(0);
    events.publish("task-1", delta("task-1", "first"));
    expect(seen).toEqual([1]);
    expect(early).toEqual([1]);
    // The reserved sequence is not a lost event: a later "beginning" replay starts
    // at the stream's first real event and is whole.
    const late = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(late.replayed.map((event) => event.sequence)).toEqual([1]);
    expect(late.truncated).toBe(false);
  });

  it("answers a caught-up cursor on an evicted ring instead of resyncing it", () => {
    const events = bus({ ringBytes: 400, totalBytes: 500 });
    events.publish("task-1", delta("task-1", "a"));
    events.markCompleted("task-1");
    for (let index = 0; index < 40; index += 1) events.publish("other", delta("other", "z".repeat(200)));

    // The client saw sequence 0 — everything the task published — and its ring
    // has since been evicted. It is caught up; there is nothing to resync.
    const { resync, replayed } = events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: 0 }, deliver: () => {} });
    expect(resync).toBeNull();
    expect(replayed).toEqual([]);
  });
});

describe("the global cap and eviction order", () => {
  const sized = (totalBytes: number) => bus({ ringBytes: 4_000, totalBytes });

  it("evicts a completed task's ring before a live one", () => {
    const events = sized(4_000);
    events.publish("done-task", delta("done-task", "x".repeat(500)));
    events.markCompleted("done-task");
    events.publish("live-task", delta("live-task", "y".repeat(500)));

    // Push past the cap; the completed ring goes first, whatever its age.
    for (let index = 0; index < 12; index += 1) events.publish("live-task", delta("live-task", "z".repeat(500)));

    const live = events.subscribe({
      taskId: "live-task",
      from: "beginning",
      deliver: () => {},
    });
    expect(live.replayed.length).toBeGreaterThan(0);
    expect(live.replayed.at(-1)?.sequence).toBe(12);
  });

  it("names a task's last attempt, and keeps a finished task finished for a note about its browser", () => {
    const events = sized(4_000);
    expect(events.lastAttempt("done-task")).toBeUndefined();
    events.publish("done-task", delta("done-task", "x".repeat(500)));
    const attemptId = events.lastAttempt("done-task");
    expect(attemptId).toBeTypeOf("string");
    events.markCompleted("done-task");
    events.publish("done-task", {
      kind: "browser.controlled",
      runId: "done-task",
      attemptId: attemptId as string,
      sessionId: "6f1d2c3b-0000-4000-8000-000000000001",
      outcome: "done",
      controlledMs: 1_000,
    });
    events.publish("live-task", delta("live-task", "y".repeat(500)));
    // Still first to go: the note did not make it live again.
    for (let index = 0; index < 12; index += 1) events.publish("live-task", delta("live-task", "z".repeat(500)));
    expect(events.retains("done-task")).toBe(false);
    expect(events.retains("live-task")).toBe(true);
  });

  it("trims the oldest live ring's head only when nothing is completed", () => {
    const events = sized(4_000);
    for (let index = 0; index < 20; index += 1) events.publish("task-1", delta("task-1", "x".repeat(500)));

    const { replayed } = events.subscribe({
      taskId: "task-1",
      from: "beginning",
      deliver: () => {},
    });
    // The head is gone and the tail is kept: still contiguous, still ending at
    // the newest event, with the numbering unchanged.
    expect(replayed.at(-1)?.sequence).toBe(19);
    expect(replayed[0]?.sequence).toBeGreaterThan(0);
    for (const [index, event] of replayed.entries()) {
      expect(event.sequence).toBe((replayed[0]?.sequence ?? 0) + index);
    }
  });

  it("stays under the cap while events keep arriving", () => {
    const events = sized(8_000);
    for (let index = 0; index < 100; index += 1) {
      events.publish("task-1", delta("task-1", "x".repeat(1_000)));
      expect(events.stats().bytes).toBeLessThanOrEqual(8_000 + 2_000);
    }
  });

  it("keeps enforcing the cap after a ring is emptied, never stalling", () => {
    // A ring trimmed to zero events keeps the lowest sequence; without filtering
    // empty rings out of the selection, eviction re-selects it forever and the
    // cap silently stops being enforced.
    const events = bus({ ringBytes: 10_000_000, totalBytes: 3_000 });
    events.publish("a", delta("a", "x".repeat(200)));
    for (let index = 0; index < 20; index += 1) events.publish("b", delta("b", "y".repeat(200)));

    // Under the cap (plus at most one event's overshoot), not 2.4x over it.
    expect(events.stats().bytes).toBeLessThanOrEqual(3_000 + 400);
  });

  it("never delivers a decreasing sequence when an evicted task publishes again", () => {
    const events = bus({ ringBytes: 400 });
    const seen: number[] = [];
    events.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event.sequence) });
    events.publish("task-1", delta("task-1", "a"));
    events.markCompleted("task-1");

    // Cap pressure evicts the completed ring.
    for (let index = 0; index < 40; index += 1) events.publish("other", delta("other", "z".repeat(200)));

    // The task produces another event (a task spans several admissions). It must
    // not restart at 0 under a subscriber that is still attached.
    events.publish("task-1", delta("task-1", "b"));

    const taskOne = seen.filter((_sequence, index) => index < seen.length);
    expect(taskOne.length).toBeGreaterThan(0);
    for (let index = 1; index < seen.length; index += 1) {
      // Sequences are non-decreasing across the whole stream; a resync marker
      // carries the current sequence rather than resetting it.
      expect(seen[index]!).toBeGreaterThanOrEqual(seen[index - 1]!);
    }
  });

  it("measures a payload once, so a producer's later mutation cannot corrupt the accounting", () => {
    const events = bus();
    const output: { blob: string } = { blob: "x".repeat(100) };
    events.publish("task-1", {
      kind: "tool.completed",
      runId: "task-1",
      attemptId: "attempt-1",
      callId: "call-1",
      toolName: "fixture.write",
      output,
      durationMs: 1,
    });
    const before = events.stats().bytes;

    // A producer reusing the object for a larger value: the retained copy was
    // measured when it was accepted, so the counters do not drift.
    output.blob = "x".repeat(5_000);
    expect(events.stats().bytes).toBe(before);
  });

  it("bounds a free-form payload the way the CLI sink does", () => {
    const events = bus();
    const published = events.publish("task-1", {
      kind: "tool.completed",
      runId: "task-1",
      attemptId: "attempt-1",
      callId: "call-1",
      toolName: "fixture.write",
      output: "x".repeat(20_000),
      durationMs: 1,
    });
    expect(published.kind).toBe("tool.completed");
    const output = published.kind === "tool.completed" ? published.output : undefined;
    expect(output).toMatchObject({ truncated: true });
  });

  it("does not let one throwing subscriber starve the others", () => {
    const events = bus();
    const seen: number[] = [];
    events.subscribe({
      taskId: "task-1",
      deliver: () => {
        throw new Error("this client is broken");
      },
    });
    events.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event.sequence) });

    // The publish itself must not throw, and the healthy subscriber still gets it.
    expect(() => events.publish("task-1", delta("task-1", "a"))).not.toThrow();
    expect(seen).toEqual([0]);
    // The broken one was dropped rather than retried forever.
    expect(events.stats().subscriptions).toBe(1);
  });

  it("does not hand the in-flight event to a subscriber that joins during delivery", () => {
    const events = bus();
    const late: number[] = [];
    events.subscribe({
      taskId: "task-1",
      deliver: () => {
        if (late.length === 0) {
          // Re-entrant subscribe, the case a snapshot guards against.
          events.subscribe({ taskId: "task-1", deliver: (event) => late.push(event.sequence) });
        }
      },
    });

    events.publish("task-1", delta("task-1", "a"));
    // The late subscriber joined *during* delivery of sequence 0 and must not
    // receive it (it would see the same event twice on the next publish).
    expect(late).toEqual([]);
    events.publish("task-1", delta("task-1", "b"));
    expect(late).toEqual([1]);
  });

  it("refuses an invalid cursor rather than answering it wrongly", () => {
    const events = bus();
    expect(() => events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: -1 }, deliver: () => {} })).toThrow(
      /non-negative integer/,
    );
  });

  it("keeps an evicted task's subscribers attached, with contiguous numbering and no marker", () => {
    // Both bounds small: the ring must trim *and* the global cap must evict, or
    // the eviction path under test never runs. An attached subscriber already
    // has everything the evicted ring held, so eviction costs it nothing: it is
    // not told to resync (the old marker also reused the next event's sequence),
    // and the task's next event continues its numbering.
    const events = bus({ ringBytes: 400, totalBytes: 500 });
    const seen: ClientEvent[] = [];
    events.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event) });
    events.publish("task-1", delta("task-1", "a"));
    events.markCompleted("task-1");
    for (let index = 0; index < 40; index += 1) events.publish("other", delta("other", "z".repeat(200)));

    events.publish("task-1", delta("task-1", "b"));
    expect(seen.map((event) => [event.kind, event.sequence])).toEqual([
      ["text.delta", 0],
      ["text.delta", 1],
    ]);
    expect(events.stats().subscriptions).toBe(1);
  });

  it("bounds how many rings it keeps, evicting idle ones and keeping their numbering", () => {
    const events = bus({ maxRings: 8 });
    events.publish("kept", delta("kept", "a"));
    // Subscribers that come and go on many tasks: every one used to leave an
    // empty ring behind for the life of the daemon.
    for (let index = 0; index < 100; index += 1) {
      events.subscribe({ taskId: `probe-${index}`, deliver: () => {} }).subscription.unsubscribe();
    }
    expect(events.stats().tasks).toBeLessThanOrEqual(8);
    // A task whose empty ring was evicted still numbers from where it left off.
    events.publish("probe-1", delta("probe-1", "x"));
    events.publish("probe-1", delta("probe-1", "y"));
    const replay = events.subscribe({ taskId: "probe-1", from: "beginning", deliver: () => {} });
    expect(replay.replayed.map((event) => event.sequence)).toEqual([0, 1]);
  });

  it("carries a non-zero watermark across an eviction for count", () => {
    const events = bus({ maxRings: 2 });
    for (let index = 0; index < 5; index += 1) events.publish("task-1", delta("task-1", `${index}`));
    // Two younger live tasks push task-1 out as the oldest ring nobody watches.
    events.publish("task-2", delta("task-2", "x"));
    events.publish("task-3", delta("task-3", "y"));
    expect(events.stats().tasks).toBeLessThanOrEqual(2);
    const seen: number[] = [];
    events.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event.sequence) });
    events.publish("task-1", delta("task-1", "resumed"));
    expect(seen).toEqual([5]);
  });

  it("keeps a watched task's watermark however many others are evicted", () => {
    const events = bus({ maxRings: 1 });
    const seen: number[] = [];
    events.subscribe({ taskId: "watched", deliver: (event) => seen.push(event.sequence) });
    for (let index = 0; index < 3; index += 1) events.publish("watched", delta("watched", `${index}`));
    events.markCompleted("watched");
    // Far more evicted tasks than the watermark limit holds.
    for (let index = 0; index < 5_000; index += 1) events.publish(`churn-${index}`, delta(`churn-${index}`, "c"));
    events.publish("watched", delta("watched", "later"));
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("never restarts a task's numbering in the same epoch, however much churn follows its eviction", () => {
    // A forgotten watermark used to restart a task at 0, and a same-epoch cursor
    // from its earlier numbering was then answered against the new stream with
    // no resync. Rings that never published no longer write watermarks, and
    // a dropped watermark raises the floor every later ring starts from.
    const events = bus({ maxRings: 2 });
    for (let index = 0; index < 50; index += 1) events.publish("task-1", delta("task-1", `${index}`));
    events.markCompleted("task-1");
    events.publish("other-1", delta("other-1", "a"));
    events.publish("other-2", delta("other-2", "b"));
    for (let index = 0; index < 5_000; index += 1) {
      events.subscribe({ taskId: `probe-${index}`, deliver: () => {} }).subscription.unsubscribe();
    }
    for (let index = 0; index < 5_000; index += 1) events.publish(`busy-${index}`, delta(`busy-${index}`, "z"));

    events.publish("task-1", delta("task-1", "resumed"));
    const resumed = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(resumed.replayed[0]?.sequence).toBeGreaterThanOrEqual(50);
    // A cursor from the earlier numbering is either answered contiguously or
    // resynced — never answered against a restarted stream.
    const cursor = events.subscribe({ taskId: "task-1", from: { epoch: "session-1", sequence: 49 }, deliver: () => {} });
    if (cursor.resync === null) {
      expect(cursor.replayed[0]?.sequence).toBe(50);
    } else {
      expect(cursor.replayed).toEqual([]);
    }
  });

  it("evicts empty rings nobody watches before a finished transcript under count pressure", () => {
    const events = bus({ maxRings: 3 });
    events.publish("finished", delta("finished", "the whole transcript"));
    events.markCompleted("finished");
    events.publish("live", delta("live", "x"));
    for (let index = 0; index < 20; index += 1) {
      events.subscribe({ taskId: `probe-${index}`, deliver: () => {} }).subscription.unsubscribe();
    }
    const replay = events.subscribe({ taskId: "finished", from: "beginning", deliver: () => {} });
    expect(replay.replayed.map((event) => event.kind === "text.delta" && event.text)).toEqual(["the whole transcript"]);
  });

  it("holds the ring count with live tasks, rather than rescanning every ring on every publish", () => {
    const bounded = bus({ maxRings: 100 });
    const started = performance.now();
    for (let index = 0; index < 6_000; index += 1) bounded.publish(`live-${index}`, delta(`live-${index}`, "x"));
    const elapsed = performance.now() - started;
    expect(bounded.stats().tasks).toBeLessThanOrEqual(100);
    // Linear in the ring count per publish would be ~6 000 × 6 000 comparisons.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("keeps reporting the last delivered sequence after dropping a throwing subscriber", () => {
    const events = bus();
    let calls = 0;
    const { subscription } = events.subscribe({
      taskId: "task-1",
      deliver: () => {
        calls += 1;
        if (calls === 3) throw new Error("client went away");
      },
    });
    events.publish("task-1", delta("task-1", "a"));
    events.publish("task-1", delta("task-1", "b"));
    events.publish("task-1", delta("task-1", "c"));
    // Delivered 0 and 1; the third delivery threw and the subscriber was dropped.
    // The cursor must not revert to its subscribe-time value.
    expect(subscription.delivered()).toBe(1);
  });

  it("replays what was published, not what the producer changed its object into afterwards", () => {
    const events = bus();
    const output: { blob: string } = { blob: "original" };
    events.publish("task-1", {
      kind: "tool.completed",
      runId: "task-1",
      attemptId: "attempt-1",
      callId: "call-1",
      toolName: "fixture.write",
      output,
      durationMs: 1,
    });
    output.blob = "x".repeat(5_000);
    const { replayed } = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(replayed[0]?.kind === "tool.completed" && replayed[0].output).toEqual({ blob: "original" });
  });

  it("marks a task completed idempotently", () => {
    const events = bus({ totalBytes: 1_000, ringBytes: 1_000 });
    events.publish("first", delta("first", "x".repeat(400)));
    events.publish("second", delta("second", "y".repeat(400)));
    events.markCompleted("first");
    events.markCompleted("first");

    // `second` is younger and live, so it must survive while `first` is evictable.
    events.markCompleted("second");
    events.publish("third", delta("third", "z".repeat(400)));
    events.publish("third", delta("third", "z".repeat(400)));
    const { replayed } = events.subscribe({ taskId: "third", from: "beginning", deliver: () => {} });
    expect(replayed.length).toBeGreaterThan(0);
  });

  it("forgets a task's ring and its subscriptions", () => {
    const events = bus();
    events.publish("task-1", delta("task-1", "a"));
    events.subscribe({ taskId: "task-1", deliver: () => {} });
    events.forget("task-1");
    expect(events.stats().tasks).toBe(0);
    expect(events.stats().subscriptions).toBe(0);
  });

  it("lets go of what a task retains from before an instant, keeping its numbering", () => {
    const events = bus();
    events.publish("task-1", { ...delta("task-1", "old"), at: "2026-10-01T00:00:00.000Z" });
    events.publish("task-1", { ...delta("task-1", "older still"), at: "2026-10-01T00:00:01.000Z" });
    events.publish("task-1", { ...delta("task-1", "new"), at: "2026-10-03T00:00:00.000Z" });
    const before = events.stats().bytes;
    expect(events.dropRetained("task-1", "2026-10-02T00:00:00.000Z")).toBe(2);
    expect(events.stats().bytes).toBeLessThan(before);
    const late = events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} });
    expect(late.replayed.map((event) => event.sequence)).toEqual([2]);
    expect(late.truncated).toBe(true);
    // All of it, when no instant is named; the next event still follows on.
    expect(events.dropRetained("task-1")).toBe(1);
    expect(events.subscribe({ taskId: "task-1", from: "beginning", deliver: () => {} }).replayed).toEqual([]);
    expect(events.publish("task-1", delta("task-1", "next")).sequence).toBe(3);
    expect(events.dropRetained("no-such-task")).toBe(0);
  });
});

describe("onCompleted", () => {
  it("tells listeners each time a task is marked finished, held ring or not, and contains a listener that throws", () => {
    const diagnostics: string[] = [];
    const events = createRunEventBus({ epoch: "session-1", onDiagnostic: (message) => diagnostics.push(message) });
    const finished: string[] = [];
    events.onCompleted(() => {
      throw new Error("broken listener");
    });
    const stop = events.onCompleted((taskId) => finished.push(taskId));
    events.markCompleted("never-published");
    events.markCompleted("never-published");
    stop();
    events.markCompleted("after-stop");
    expect(finished).toEqual(["never-published", "never-published"]);
    expect(diagnostics.filter((message) => message === "a task-completed listener threw")).toHaveLength(3);
  });
});

describe("latestActivity", () => {
  it("names the newest tool call, or the newest text block's tail, clipped and on one line", () => {
    const events = bus();
    expect(events.latestActivity("task-1", 10)).toBeUndefined();
    events.publish("task-1", {
      kind: "tool.started",
      runId: "task-1",
      attemptId: "attempt-1",
      blockId: "b0",
      callId: "c1",
      toolName: "web.search",
      input: { secret: "never shown" },
    } as never);
    expect(events.latestActivity("task-1", 10)).toEqual({ kind: "tool", text: "web.search" });
    events.publish("task-1", delta("task-1", "The fares\n"));
    events.publish("task-1", delta("task-1", "are compared now"));
    expect(events.latestActivity("task-1", 10)).toEqual({ kind: "text", text: "…pared now" });
    expect(events.latestActivity("task-1", 100)).toEqual({ kind: "text", text: "The fares are compared now" });
    // A later event that is neither (the turn's end) leaves the last activity standing.
    events.publish("task-1", { ...delta("task-1", ""), kind: "task.completed", finalText: "done" } as never);
    expect(events.latestActivity("task-1", 100)).toEqual({ kind: "text", text: "The fares are compared now" });
  });

  it("reads one block's text across events that are not activity, and stops at a tool call or another block", () => {
    const events = bus();
    events.publish("task-1", {
      kind: "tool.completed",
      runId: "task-1",
      attemptId: "attempt-1",
      callId: "c1",
      toolName: "web.search",
      output: {},
      durationMs: 1,
    } as never);
    events.publish("task-1", { ...delta("task-1", "older block"), blockId: "block-0" } as never);
    events.publish("task-1", delta("task-1", "Hello "));
    events.publish("task-1", { kind: "run.started", runId: "task-1", attemptId: "attempt-1", threadId: "t", workspaceId: "w" } as never);
    events.publish("task-1", delta("task-1", "world"));
    expect(events.latestActivity("task-1", 100)).toEqual({ kind: "text", text: "Hello world" });
  });

  it("says nothing for a ring that holds no activity", () => {
    const events = bus();
    events.publish("task-1", { kind: "run.started", runId: "task-1", attemptId: "attempt-1", threadId: "t", workspaceId: "w" } as never);
    events.publish("task-1", { kind: "task.completed", runId: "task-1", attemptId: "attempt-1", finalText: "done" } as never);
    expect(events.latestActivity("task-1", 100)).toBeUndefined();
  });
});
