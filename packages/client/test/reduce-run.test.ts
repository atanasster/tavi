import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLIENT_PROTOCOL_VERSION, ClientEventSchema, type ClientEvent } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  initialRunState,
  isEventOrderError,
  PLUGIN_NOTICES_KEPT,
  reduceRun,
  replayRun,
  resumeFrom,
  seedSuspension,
  type RunState,
  type TextBlock,
  type ToolCard,
} from "../src/reduce-run.js";

const FIXTURES = [
  "two-call-round",
  "reused-call-id",
  "settled-by-another-client",
  "review-required",
  "waiting-question",
  "resync-after-restart",
  "denied-then-failed",
  "one-admission-reuse",
] as const;

/**
 * `reduceRun` over streams recorded from a real owner (`apps/cli`'s
 * `client-fixtures.test.ts` records and checks them), replayed event by event.
 */

function fixture(name: string): ClientEvent[] {
  return readFileSync(join(import.meta.dirname, "fixtures", `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ClientEventSchema.parse(JSON.parse(line)));
}

/** The state after the events up to and including `events[index]`. */
function upTo(events: readonly ClientEvent[], index: number): RunState {
  return replayRun(events.slice(0, index + 1));
}

const tools = (state: RunState): ToolCard[] => state.transcript.filter((entry): entry is ToolCard => entry.kind === "tool");
const texts = (state: RunState): TextBlock[] => state.transcript.filter((entry): entry is TextBlock => entry.kind === "text");

/** Freeze a state and everything in it, so a reducer that mutates throws. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

describe("reduceRun over recorded streams", () => {
  it("two-call-round: one pending round of two calls, cleared by its settlement, then two cards", () => {
    const events = fixture("two-call-round");
    const asked = upTo(
      events,
      events.findLastIndex((event) => event.kind === "approval.required"),
    );
    expect(asked.status).toBe("awaiting_approval");
    expect(asked.pending).toEqual([
      expect.objectContaining({
        taskId: "task-0",
        steps: 1,
        requests: [expect.objectContaining({ callId: "call-a" }), expect.objectContaining({ callId: "call-b" })],
      }),
    ]);

    const done = replayRun(events);
    expect(done.status).toBe("completed");
    expect(done.outcome).toEqual({ kind: "completed", finalText: "done" });
    expect(done.pending).toEqual([]);
    expect(done.settled).toEqual([
      {
        steps: 1,
        decisions: [
          { callId: "call-a", approved: true },
          { callId: "call-b", approved: true },
        ],
        decidedBy: "auto:operator",
        at: expect.any(String),
      },
    ]);
    expect(tools(done).map((card) => [card.callId, card.status])).toEqual([
      ["call-a", "completed"],
      ["call-b", "completed"],
    ]);
  });

  it("reused-call-id: a call id and a block id reused every turn stay distinct cards and blocks, across three admissions", () => {
    const events = fixture("reused-call-id");
    // The second round names call-1 again; only it is pending.
    const second = upTo(
      events,
      events.findLastIndex((event) => event.kind === "approval.required"),
    );
    expect(second.pending.map((round) => [round.steps, round.requests.map((request) => request.callId)])).toEqual([[2, ["call-1"]]]);
    expect(second.pending[0]?.requests[0]?.approvalId).toBe("approval:6:task-0:2:6:call-1");

    const done = replayRun(events);
    expect(tools(done).map((card) => [card.attemptId, card.callId, card.status, card.output])).toEqual([
      ["attempt-1", "call-1", "completed", { sessionId: "browser-session-1", state: "open" }],
      ["attempt-3", "call-1", "completed", { sessionId: "browser-session-2", state: "open" }],
    ]);
    // `txt-0` in three model calls: three blocks, not one run-on block.
    expect(texts(done).map((block) => [block.attemptId, block.text])).toEqual([
      ["attempt-1", "working… "],
      ["attempt-3", "working… "],
      ["attempt-5", "done"],
    ]);
    expect(done.transcript.filter((entry) => entry.kind === "boundary")).toHaveLength(2);
    expect(done.settled.map((round) => round.steps)).toEqual([1, 2]);
  });

  it("settled-by-another-client: a round decided elsewhere clears here too, naming who decided", () => {
    const events = fixture("settled-by-another-client");
    const settledAt = events.findIndex((event) => event.kind === "approval.settled");
    expect(upTo(events, settledAt - 1).pending).toHaveLength(1);
    const settled = upTo(events, settledAt);
    expect(settled.pending).toEqual([]);
    expect(settled.status).toBe("running");
    expect(settled.settled).toEqual([
      { steps: 1, decisions: [{ callId: "call-1", approved: true }], decidedBy: "another-client", at: expect.any(String) },
    ]);
    expect(replayRun(events).status).toBe("completed");
  });

  it("review-required: a review suspends the run, and the resume ends the suspension", () => {
    const events = fixture("review-required");
    const suspended = upTo(
      events,
      events.findIndex((event) => event.kind === "task.review_required"),
    );
    expect(suspended.status).toBe("review_required");
    expect(suspended.review).toEqual({ steps: 1, requests: [{ artifactId: "artifact-0", toolName: "fixture.capture", callId: "call-a" }] });
    const done = replayRun(events);
    expect(done.review).toBeUndefined();
    expect(done.status).toBe("completed");
    expect(done.outcome).toEqual({ kind: "completed", finalText: "reviewed" });
  });

  it("waiting-question: the question is shown while the task waits; the tool it suspended on is interrupted, then run again in the same row (QA 2101)", () => {
    const events = fixture("waiting-question");
    const waiting = upTo(
      events,
      events.findIndex((event) => event.kind === "task.waiting"),
    );
    expect(waiting.status).toBe("waiting");
    expect(waiting.waiting).toEqual({
      on: "its deadline",
      deadlineAt: "2026-01-02T00:00:00.000Z",
      question: "Which projects should I track?",
      waitId: "wait:6:task-0:1:call-ask",
    });
    expect(tools(waiting).map((card) => card.status)).toEqual(["running"]);
    const resumed = upTo(
      events,
      events.findIndex((event) => event.kind === "attempt.replaced"),
    );
    expect(tools(resumed).map((card) => card.status)).toEqual(["interrupted"]);

    // The answer, from whichever front end, turns the question into a receipt.
    const answered = upTo(
      events,
      events.findIndex((event) => event.kind === "wait.settled"),
    );
    expect(answered.waiting).toBeUndefined();
    expect(answered.settledWaits).toEqual([
      {
        waitId: "wait:6:task-0:1:call-ask",
        question: "Which projects should I track?",
        outcome: "answered",
        replyText: "ai-crucible and elections-bg",
        decidedBy: "operator",
        via: "chat-main",
        at: expect.any(String),
      },
    ]);

    const done = replayRun(events);
    expect(done.waiting).toBeUndefined();
    // The re-run is the same call: its row is reopened and finished, not drawn a second time.
    expect(tools(done).map((card) => [card.attemptId, card.toolName, card.status])).toEqual([
      ["attempt-1", "operator.ask_user", "completed"],
    ]);
    expect(tools(done)[0]?.key).toBe(tools(waiting)[0]?.key);
    expect(texts(done).map((block) => block.text)).toEqual(["tracking them"]);
  });

  it("resync-after-restart: a resync resets what the stream said, and the new epoch carries on", () => {
    const events = fixture("resync-after-restart");
    const resyncAt = events.findIndex((event) => event.kind === "resync.required");
    const before = upTo(events, resyncAt - 1);
    expect(before.pending).toHaveLength(1);
    expect(before.truncated).toBe(false);

    const reset = upTo(events, resyncAt);
    expect(reset).toMatchObject({ status: "unknown", truncated: true, pending: [], transcript: [], settled: [], taskId: "task-0" });
    expect(reset.cursor).toEqual({ epoch: "epoch-1", sequence: 0 });
    // The marker's attempt is the bus's placeholder, not one of the task's.
    expect(reset.attemptId).toBeUndefined();
    // Still suspended, and nothing will say so until it is decided: a front end
    // fetches the round and seeds it.
    const round = before.pending[0];
    const seeded = seedSuspension(reset, { pending: round === undefined ? [] : [round] });
    expect(seeded).toMatchObject({ status: "awaiting_approval", pending: [round] });
    // Its settlement, the next event, clears it and says the task runs again.
    const settled = reduceRun(seeded, events[resyncAt + 1] as ClientEvent);
    expect(settled).toMatchObject({ status: "running", pending: [] });
    // Unseeded, the same settlement still says the task is running again.
    expect(reduceRun(reset, events[resyncAt + 1] as ClientEvent).status).toBe("running");

    const done = replayRun(events);
    expect(done.status).toBe("completed");
    expect(done.truncated).toBe(true);
    expect(done.settled).toEqual([
      { steps: 1, decisions: [{ callId: "call-1", approved: true }], decidedBy: "operator", at: expect.any(String) },
    ]);
  });

  it("denied-then-failed: a denied round leaves no card, and the failure ends the run", () => {
    const done = replayRun(fixture("denied-then-failed"));
    expect(done.settled).toEqual([
      { steps: 1, decisions: [{ callId: "call-1", approved: false }], decidedBy: "auto:operator", at: expect.any(String) },
    ]);
    expect(done.pending).toEqual([]);
    expect(tools(done)).toEqual([]);
    expect(done.status).toBe("failed");
    expect(done.outcome).toEqual({ kind: "failed", errorCode: "MODEL_FAILED", message: "the provider gave up" });
  });

  it.each([false, true])("one-admission-reuse: distinct failures survive call-id reuse (shared attempt=%s)", (sharedAttempt) => {
    const events = fixture("one-admission-reuse");
    // Preserve coverage for older producers that reuse one attempt across
    // rounds as well as current per-provider-call attempt identities.
    const done = replayRun(sharedAttempt ? events.map((event) => ({ ...event, attemptId: "attempt-shared" })) : events);
    const cards = tools(done);
    expect(cards.map((card) => [card.attemptId, card.callId, card.status, card.input, card.errorCode])).toEqual([
      [sharedAttempt ? "attempt-shared" : "attempt-1", "call-1", "failed", { taskId: "task-missing-1" }, "TOOL_FAILED"],
      [sharedAttempt ? "attempt-shared" : "attempt-2", "call-1", "failed", { taskId: "task-missing-2" }, "TOOL_FAILED"],
    ]);
    expect(cards[0]?.message).toContain("task-missing-1");
    expect(cards[1]?.message).toContain("task-missing-2");
    expect(new Set(cards.map((card) => card.key)).size).toBe(2);
  });

  it("gives every transcript entry a key of its own, in every fixture", () => {
    for (const name of FIXTURES) {
      const keys = replayRun(fixture(name)).transcript.map((entry) => entry.key);
      expect(new Set(keys).size, name).toBe(keys.length);
    }
  });
});

describe("reduceRun keeps a stream's state honest when the producer is silent", () => {
  const events = fixture("reused-call-id");

  it("clears a round a resume took over without announcing its settlement", () => {
    const required = events.find((event) => event.kind === "approval.required") as ClientEvent;
    const replaced = events.find((event) => event.kind === "attempt.replaced") as ClientEvent;
    const state = reduceRun(reduceRun(upTo(events, 1), required), { ...replaced, sequence: 3 });
    expect(state).toMatchObject({ pending: [], settled: [], status: "running" });
  });

  it("carries a request's rule subjects, so a card names the rule an always decision saves", () => {
    const required = events.find((event) => event.kind === "approval.required") as ClientEvent;
    const withSubjects = ClientEventSchema.parse({ ...required, subjects: ["git status", "a*b"] });
    expect(reduceRun(upTo(events, 1), withSubjects).pending[0]?.requests[0]?.subjects).toEqual(["git status", "a*b"]);
    expect(reduceRun(upTo(events, 1), required).pending[0]?.requests[0]).not.toHaveProperty("subjects");
  });

  it("retires a lower round a newer one supersedes", () => {
    const first = events.find((event) => event.kind === "approval.required" && event.steps === 1) as ClientEvent;
    const second = events.find((event) => event.kind === "approval.required" && event.steps === 2) as ClientEvent;
    const state = reduceRun(reduceRun(upTo(events, 1), first), { ...second, sequence: 3 });
    expect(state.pending.map((round) => round.steps)).toEqual([2]);
  });

  it("marks a failed-over attempt's text discarded, and keeps a resumed attempt's", () => {
    const events = fixture("waiting-question");
    const text = events.find((event) => event.kind === "text.delta") as ClientEvent;
    const before = reduceRun(upTo(events, 0), { ...text, sequence: 1 });
    const boundary = (discarded: boolean): ClientEvent =>
      ClientEventSchema.parse({
        protocolVersion: text.protocolVersion,
        epoch: text.epoch,
        sequence: 2,
        runId: text.runId,
        at: text.at,
        kind: "attempt.replaced",
        attemptId: "attempt-next",
        supersededAttemptId: text.attemptId,
        reason: "the model call failed over",
        ...(discarded ? { discarded: true } : {}),
      });
    const failedOver = reduceRun(before, boundary(true));
    expect(texts(failedOver).map((block) => block.discarded)).toEqual([true]);
    expect(failedOver.transcript.at(-1)).toMatchObject({ kind: "boundary", discarded: true });
    const resumed = reduceRun(before, boundary(false));
    expect(texts(resumed).map((block) => block.discarded)).toEqual([undefined]);
  });

  it("interrupts a running card once another attempt's activity begins, boundary or not", () => {
    const waiting = fixture("waiting-question");
    const started = waiting.find((event) => event.kind === "tool.started") as ClientEvent;
    const text = waiting.find((event) => event.kind === "text.delta") as ClientEvent;
    const state = reduceRun(reduceRun(upTo(waiting, 0), started), { ...text, sequence: 2 });
    expect(tools(state).map((card) => card.status)).toEqual(["interrupted"]);
  });

  it("finishes the interrupted row when the resumed attempt reports the call's end alone, and leaves other calls their own rows (QA 2101)", () => {
    const waiting = fixture("waiting-question");
    const resumedAt = waiting.findIndex((event) => event.kind === "attempt.replaced");
    const replaced = waiting[resumedAt] as ClientEvent & { readonly kind: "attempt.replaced" };
    const done = waiting.find((event) => event.kind === "tool.completed") as Extract<ClientEvent, { kind: "tool.completed" }>;
    const late = reduceRun(upTo(waiting, resumedAt), { ...done, sequence: resumedAt + 1, attemptId: replaced.attemptId });
    expect(tools(late).map((card) => [card.attemptId, card.status])).toEqual([[replaced.attemptId, "completed"]]);
    expect(tools(late)[0]?.input).toMatchObject({ question: "Which projects should I track?" });
    // Another call, or the same call id under an attempt nothing superseded, is a call of its own.
    const other = reduceRun(upTo(waiting, resumedAt), {
      ...done,
      sequence: resumedAt + 1,
      callId: "call-other",
      attemptId: replaced.attemptId,
    });
    expect(tools(other).map((card) => card.status)).toEqual(["interrupted", "completed"]);
    const unrelated = reduceRun(upTo(waiting, resumedAt), { ...done, sequence: resumedAt + 1, attemptId: "attempt-elsewhere" });
    expect(tools(unrelated).map((card) => card.status)).toEqual(["interrupted", "completed"]);
  });
});

describe("reduceRun continues the newest text block in place", () => {
  const events = fixture("waiting-question");
  const text = events.find((event) => event.kind === "text.delta") as ClientEvent & { kind: "text.delta" };
  const started = events.find((event) => event.kind === "tool.started") as ClientEvent;
  const delta = (sequence: number, extra: object = {}): ClientEvent =>
    ClientEventSchema.parse({ ...text, sequence, text: `${sequence}`, ...extra });

  it("appends to the last block without touching the entries before it or the state it was given", () => {
    let state = reduceRun(reduceRun(upTo(events, 0), started), delta(2));
    const before = state.transcript[0];
    for (let sequence = 3; sequence <= 6; sequence += 1) state = reduceRun(frozen(state), delta(sequence));
    expect(state.transcript[0]).toBe(before);
    expect(texts(state).map((block) => block.text)).toEqual(["23456"]);
    expect(state.transcript).toHaveLength(2);
    expect(state.status).toBe("running");
  });

  it("is what the full path makes of the same stream", () => {
    const state = reduceRun(reduceRun(upTo(events, 0), delta(1)), delta(2, { tainted: true, knownUrls: ["https://a.example/"] }));
    // The same event applied where the block is not the last entry takes the full path.
    const viaSlow = reduceRun(
      { ...reduceRun(upTo(events, 0), delta(1)), attemptId: undefined },
      delta(2, { tainted: true, knownUrls: ["https://a.example/"] }),
    );
    expect(state.transcript).toEqual(viaSlow.transcript);
    expect(state).toMatchObject({ tainted: true, knownUrls: ["https://a.example/"] });
  });

  it("continues a block that is no longer the newest entry where it is", () => {
    const tool = ClientEventSchema.parse({ ...started, sequence: 2 });
    const state = reduceRun(reduceRun(reduceRun(upTo(events, 0), delta(1)), tool), delta(3));
    expect(state.transcript.map((entry) => entry.kind)).toEqual(["text", "tool"]);
    expect(texts(state).map((block) => block.text)).toEqual(["13"]);
  });

  it("agrees with the full path over random streams of blocks, cards, steers and boundaries", () => {
    // A fixed-seed generator (mulberry32), so a failure replays.
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const attempts = ["attempt-1", "attempt-2", "attempt-3"];
    const blocks = ["b-0", "b-1"];
    const calls = ["call-0", "call-1"];
    let fastCases = 0;
    for (let run = 0; run < 300; run += 1) {
      let state = initialRunState();
      let attemptId = "attempt-1";
      const at = (sequence: number) => ({
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        epoch: "epoch-0",
        sequence,
        runId: "task-0",
        at: "2026-01-01T00:00:00.000Z",
      });
      state = reduceRun(
        state,
        ClientEventSchema.parse({ ...at(0), attemptId, kind: "run.started", threadId: "thread-0", workspaceId: "default" }),
      );
      for (let sequence = 1; sequence <= 40; sequence += 1) {
        // Mostly the attempt the stream follows, sometimes another (a failover, a stale card's end).
        if (random() < 0.1) attemptId = pick(attempts);
        const callId = pick(calls);
        const roll = random();
        const raw =
          roll < 0.55
            ? {
                kind: "text.delta",
                attemptId,
                blockId: pick(blocks),
                text: `${sequence};`,
                ...(random() < 0.2 ? { tainted: true, ...(random() < 0.5 ? { knownUrls: [`https://${sequence}.example/`] } : {}) } : {}),
              }
            : roll < 0.68
              ? { kind: "tool.started", attemptId, blockId: callId, callId, toolName: "t", input: { sequence } }
              : roll < 0.76
                ? { kind: "tool.completed", attemptId, callId, toolName: "t", output: null, durationMs: 0 }
                : roll < 0.8
                  ? { kind: "tool.failed", attemptId, callId, toolName: "t", errorCode: "TOOL_FAILED", message: "no", durationMs: 0 }
                  : roll < 0.86
                    ? { kind: "turn.steered", attemptId, messageId: `m-${Math.floor(random() * 3)}`, text: "steer" }
                    : roll < 0.92
                      ? {
                          kind: "attempt.replaced",
                          attemptId: pick(attempts),
                          supersededAttemptId: attemptId,
                          reason: "failover",
                          ...(random() < 0.5 ? { discarded: true } : {}),
                        }
                      : { kind: "plugin.status", attemptId, pluginId: "p", line: `${sequence}` };
        const event = ClientEventSchema.parse({ ...at(sequence), ...raw });
        const next = reduceRun(state, event);
        if (event.kind === "text.delta") {
          const last = state.transcript.at(-1);
          if (state.attemptId === event.attemptId && last?.key === `text:${event.attemptId}:${event.blockId}`) fastCases += 1;
          // Without the attempt the stream follows, the same event takes the full path.
          expect(next).toEqual(reduceRun({ ...state, attemptId: undefined }, event));
        }
        state = next;
      }
    }
    expect(fastCases).toBeGreaterThan(500);
  });
});

describe("reduceRun keeps a tainted turn's known URLs", () => {
  const events = fixture("waiting-question");
  const text = events.find((event) => event.kind === "text.delta") as ClientEvent;
  const delta = (sequence: number, taint: object): ClientEvent => ClientEventSchema.parse({ ...text, sequence, ...taint });

  it("leaves a clean stream untainted", () => {
    const state = reduceRun(upTo(events, 0), delta(1, {}));
    expect(state.tainted).toBeUndefined();
    expect(state.knownUrls).toBeUndefined();
  });

  it("sets them from a delta, keeps them through one that carries none, and replaces them with newer ones", () => {
    const first = reduceRun(upTo(events, 0), delta(1, { tainted: true, knownUrls: ["https://a.example/"] }));
    expect(first).toMatchObject({ tainted: true, knownUrls: ["https://a.example/"] });
    const kept = reduceRun(first, delta(2, { tainted: true }));
    // The same list, so a view drawing the links does not redraw them.
    expect(kept.knownUrls).toBe(first.knownUrls);
    const clean = reduceRun(kept, delta(3, {}));
    expect(clean).toMatchObject({ tainted: true, knownUrls: ["https://a.example/"] });
    const newer = reduceRun(clean, delta(4, { tainted: true, knownUrls: ["https://a.example/", "https://b.example/"] }));
    expect(newer.knownUrls).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("takes them from task.completed", () => {
    const completed = ClientEventSchema.parse({
      protocolVersion: text.protocolVersion,
      epoch: text.epoch,
      sequence: 1,
      runId: text.runId,
      attemptId: text.attemptId,
      at: text.at,
      kind: "task.completed",
      finalText: "done",
      tainted: true,
      knownUrls: ["https://a.example/"],
    });
    expect(reduceRun(upTo(events, 0), completed)).toMatchObject({ tainted: true, knownUrls: ["https://a.example/"] });
  });
});

describe("reduceRun refuses a stream it cannot trust", () => {
  const events = fixture("two-call-round");

  it("throws on out-of-order delivery", () => {
    const swapped = [...events];
    [swapped[5], swapped[6]] = [swapped[6] as ClientEvent, swapped[5] as ClientEvent];
    let caught: unknown;
    try {
      replayRun(swapped);
    } catch (error) {
      caught = error;
    }
    expect(isEventOrderError(caught)).toBe(true);
    expect(String(caught)).toContain("expected sequence 5, received 6");
  });

  it("throws on a duplicate, a gap, an epoch change without a resync, another task's event, and a resync going back", () => {
    const state = upTo(events, 3);
    const next = events[4] as ClientEvent;
    for (const event of [
      events[3] as ClientEvent,
      events[5] as ClientEvent,
      { ...next, epoch: "epoch-9" },
      { ...next, runId: "task-9" },
      { ...next, kind: "resync.required", reason: "back", sequence: 1 } as ClientEvent,
    ]) {
      expect(() => reduceRun(state, event), `${event.kind} ${event.sequence}`).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    }
  });

  it("accepts a stream joined midway, and says on its own that it is truncated", () => {
    // Joined at call-a's end: its card is shown without the input it started with.
    const late = replayRun(events.slice(7));
    expect(late.status).toBe("completed");
    expect(late.truncated).toBe(true);
    expect(tools(late).map((card) => [card.callId, card.status])).toEqual([
      ["call-a", "completed"],
      ["call-b", "completed"],
    ]);
    expect(tools(late)[0]).not.toHaveProperty("input");
    expect(tools(late)[1]).toHaveProperty("input");
    // From its start, it is whole.
    expect(replayRun(events).truncated).toBe(false);
  });

  it("follows a resync within an epoch that shares the head's sequence, or names the cursor itself", () => {
    const state = upTo(events, 3);
    const marker = {
      ...(events[4] as ClientEvent),
      kind: "resync.required",
      reason: "the requested sequence is no longer retained",
      sequence: 9,
    } as ClientEvent;
    const reset = reduceRun(state, marker);
    expect(reset).toMatchObject({ status: "unknown", truncated: true, pending: [], cursor: { epoch: "epoch-0", sequence: 9 } });
    expect(reduceRun(reset, { ...(events[10] as ClientEvent), sequence: 10 }).status).toBe("running");
    expect(reduceRun(state, { ...marker, sequence: 3 }).cursor).toEqual({ epoch: "epoch-0", sequence: 3 });
  });

  it("resumes from the last event it applied", () => {
    expect(resumeFrom(initialRunState())).toBe("beginning");
    expect(resumeFrom(upTo(events, 3))).toEqual({ epoch: "epoch-0", sequence: 3 });
  });

  it("refuses an event of a kind it does not know", () => {
    const unknown = { ...(events[1] as ClientEvent), kind: "task.teleported" } as unknown as ClientEvent;
    expect(() => reduceRun(upTo(events, 0), unknown)).toThrow(/unknown event kind task.teleported/);
  });

  it("never modifies the state it is given, in any fixture", () => {
    for (const name of FIXTURES) {
      let state = frozen(initialRunState());
      for (const event of fixture(name)) state = frozen(reduceRun(state, event));
      expect(state.status, name).not.toBe("idle");
    }
  });
});

it("bounds spawn hints while preserving the running state", () => {
  const start = fixture("two-call-round")[0]!;
  let state = reduceRun(initialRunState(), start);
  for (let i = 1; i <= 205; i++)
    state = reduceRun(state, {
      ...start,
      kind: "task.spawned",
      sequence: start.sequence + i,
      childRunId: `child-${i}`,
      workerAgentId: `worker-${i}`,
      depth: 1,
    });
  expect(state.spawned).toHaveLength(200);
  expect(state.spawned[0]?.childRunId).toBe("child-6");
  expect(state.status).toBe("running");
});

it("retains execution metrics on outcomes and clears them when execution resumes", () => {
  const events = fixture("one-admission-reuse");
  const last = events.at(-1)!;
  const terminal = {
    ...last,
    kind: "task.completed" as const,
    finalText: "done",
    metrics: { models: ["local/model"], totalTokens: 42, partial: false },
  };
  const before = replayRun(events.slice(0, -1));
  const done = reduceRun(before, terminal);
  expect(done.metrics).toEqual(terminal.metrics);
  const next = reduceRun(done, { ...last, kind: "text.delta", sequence: last.sequence + 1, blockId: "new", text: "Next response" });
  expect(next.metrics).toBeUndefined();
});

describe("wait.settled", () => {
  const base = {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "e",
    runId: "task-1",
    attemptId: "a1",
    at: "2026-10-02T12:00:00.000Z",
  } as const;
  const waiting = (waitId: string, sequence: number): ClientEvent => ({
    ...base,
    sequence,
    kind: "task.waiting",
    on: "its deadline",
    deadlineAt: "2026-10-03T00:00:00.000Z",
    question: `Q ${waitId}?`,
    waitId,
  });
  const settled = (waitId: string, sequence: number, replyText = "yes"): ClientEvent => ({
    ...base,
    sequence,
    kind: "wait.settled",
    waitId,
    outcome: "answered",
    replyText,
  });

  it("keeps a browser handoff on the wait, and how the person handed back on its receipt", () => {
    const handoff = { sessionId: "6f1d2c3b-0000-4000-8000-000000000001", reason: "sign-in" as const, instructions: "Sign in" };
    const asked = replayRun([
      {
        ...base,
        sequence: 0,
        kind: "task.waiting",
        on: "its deadline",
        deadlineAt: "2026-10-03T00:00:00.000Z",
        waitId: "w1",
        handoff,
      } as ClientEvent,
    ]);
    expect(asked.waiting).toMatchObject({ waitId: "w1", handoff });
    const back = reduceRun(asked, {
      ...base,
      sequence: 1,
      kind: "wait.settled",
      waitId: "w1",
      outcome: "answered",
      replyText: "Signed in",
      handoff: { outcome: "done", controlledMs: 72_000 },
    } as ClientEvent);
    expect(back.waiting).toBeUndefined();
    expect(back.settledWaits).toEqual([
      expect.objectContaining({
        waitId: "w1",
        handedOver: true,
        handoff: { outcome: "done", controlledMs: 72_000 },
        replyText: "Signed in",
      }),
    ]);
  });

  it("keeps a person's hold of the browser the task did not wait for, without changing how the task stands", () => {
    const done = replayRun([{ ...base, sequence: 0, kind: "task.completed", finalText: "Done." } as ClientEvent]);
    const held = reduceRun(done, {
      ...base,
      sequence: 1,
      kind: "browser.controlled",
      sessionId: "6f1d2c3b-0000-4000-8000-000000000001",
      outcome: "done",
      controlledMs: 72_000,
      replyText: "Logged in",
    } as ClientEvent);
    expect(held.status).toBe(done.status);
    expect(held.outcome).toEqual(done.outcome);
    expect(held.cursor).toEqual({ epoch: "e", sequence: 1 });
    expect(held.browserControls).toEqual([
      { sessionId: "6f1d2c3b-0000-4000-8000-000000000001", outcome: "done", controlledMs: 72_000, note: "Logged in", at: base.at },
    ]);
  });

  it("shows a message sent into the running turn where it was read, once per message", () => {
    const state = replayRun([
      { ...base, sequence: 0, kind: "text.delta", blockId: "b1", text: "Checking." },
      { ...base, sequence: 1, kind: "turn.steered", messageId: "m-1", text: "in kilometres" },
      { ...base, sequence: 2, kind: "turn.steered", messageId: "m-1", text: "in kilometres" },
      { ...base, sequence: 3, kind: "text.delta", blockId: "b2", text: "12 km." },
    ] as ClientEvent[]);
    expect(state.transcript.map((entry) => entry.kind)).toEqual(["text", "steer", "text"]);
    expect(state.transcript[1]).toEqual({ kind: "steer", key: "steer:m-1", messageId: "m-1", text: "in kilometres" });
    expect(state.status).toBe("running");
  });

  it("keeps why a question was asked", () => {
    expect(replayRun([{ ...waiting("w1", 0), context: "Needed for the report." } as ClientEvent]).waiting).toMatchObject({
      waitId: "w1",
      context: "Needed for the report.",
    });
  });

  it("leaves the open question alone when another wait settles", () => {
    const state = replayRun([waiting("w1", 0), settled("w-other", 1)]);
    expect(state.waiting?.waitId).toBe("w1");
    expect(state.settledWaits).toEqual([expect.objectContaining({ waitId: "w-other" })]);
    expect(state.settledWaits[0]).not.toHaveProperty("question");
  });

  it("clears a wait seeded without an id, keeps one receipt per wait, and keeps the latest twenty", () => {
    const seeded: RunState = {
      ...initialRunState({ taskId: "task-1" }),
      status: "waiting",
      waiting: { on: "its deadline", deadlineAt: "2026-10-03T00:00:00.000Z", question: "Seeded?" },
    };
    const cleared = reduceRun(seeded, settled("w-seeded", 0));
    expect(cleared.waiting).toBeUndefined();
    expect(cleared.settledWaits).toEqual([expect.objectContaining({ waitId: "w-seeded", question: "Seeded?" })]);

    const repeated = replayRun([settled("w1", 0, "first"), settled("w1", 1, "second")]);
    expect(repeated.settledWaits.map((wait) => wait.replyText)).toEqual(["second"]);

    const many = replayRun(Array.from({ length: 25 }, (_, index) => settled(`w${index}`, index)));
    expect(many.settledWaits).toHaveLength(20);
    expect(many.settledWaits[0]?.waitId).toBe("w5");
  });
});

describe("plugin status and notices", () => {
  const at = "2026-10-09T12:00:00.000Z";
  const head = { protocolVersion: CLIENT_PROTOCOL_VERSION, epoch: "e", runId: "task-1", attemptId: "a1", at } as const;
  it("keeps each plugin's newest line, clears it, and keeps its notices bounded", () => {
    let sequence = 0;
    const next = (event: Record<string, unknown>) => ({ ...head, sequence: (sequence += 1), ...event }) as ClientEvent;
    let state = replayRun([
      next({ kind: "plugin.status", pluginId: "acme.cache", line: "cache warm 4:59" }),
      next({ kind: "plugin.status", pluginId: "acme.other", line: "ok" }),
    ]);
    expect(state.pluginStatus).toEqual({ "acme.cache": "cache warm 4:59", "acme.other": "ok" });
    state = reduceRun(state, next({ kind: "plugin.status", pluginId: "acme.cache" }));
    expect(state.pluginStatus).toEqual({ "acme.other": "ok" });
    for (let index = 0; index < PLUGIN_NOTICES_KEPT + 5; index += 1)
      state = reduceRun(state, next({ kind: "plugin.notice", pluginId: "acme.cache", notice: `n${index}` }));
    expect(state.pluginNotices).toHaveLength(PLUGIN_NOTICES_KEPT);
    expect(state.pluginNotices.at(-1)).toEqual({ pluginId: "acme.cache", text: `n${PLUGIN_NOTICES_KEPT + 4}`, at });
  });
});

describe("turn suggestions", () => {
  it("keeps the newest turn's suggestions until a turn starts", () => {
    const head = {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      epoch: "e",
      runId: "task-1",
      attemptId: "a1",
      at: "2026-10-09T12:00:00.000Z",
    } as const;
    let state = replayRun([{ ...head, sequence: 1, kind: "turn.suggested", suggestions: ["Run the tests"] } as ClientEvent]);
    expect(state.suggestions).toEqual(["Run the tests"]);
    state = reduceRun(state, { ...head, sequence: 2, kind: "run.started", threadId: "thread-1", workspaceId: "ws" } as ClientEvent);
    expect(state.suggestions).toEqual([]);
  });
});

describe("plugin state", () => {
  it("keeps each plugin's newest value per key", () => {
    const head = {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      epoch: "e",
      runId: "task-1",
      attemptId: "a1",
      at: "2026-10-09T12:00:00.000Z",
    } as const;
    const state = replayRun([
      { ...head, sequence: 1, kind: "plugin.state", pluginId: "acme.mod", stateKey: "plan", value: ["a"] },
      { ...head, sequence: 2, kind: "plugin.state", pluginId: "acme.mod", stateKey: "done", value: false },
      { ...head, sequence: 3, kind: "plugin.state", pluginId: "acme.mod", stateKey: "plan", value: ["a", "b"] },
    ] as ClientEvent[]);
    expect(state.pluginState).toEqual({ "acme.mod": { plan: ["a", "b"], done: false } });
  });
});
