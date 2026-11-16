import { describe, expect, it, vi } from "vitest";

import type { AdmissionOutcome, AdmissionResult, AdmitInput, ClientEvent, UnsequencedClientEvent, WorkflowPort } from "@tavi/contracts";
import { createRunEventBus, type RunEventBus } from "@tavi/runtime";

import { ARG_PROVENANCE_LIMITS, ApprovalProvenanceSchema, CONTENT_LABEL_LIMITS, TaviError, argumentOrigins } from "@tavi/contracts";

import { IPC_MAX_MESSAGE_CHARS } from "@tavi/contracts";

import {
  attemptIdFor,
  createAbortRegistry,
  createAdmissionTracker,
  createDeltaCoalescer,
  DELTA_COALESCE_CHARS,
  DELTA_COALESCE_MS,
  emitOutcomeEvents,
  withRunEvents,
} from "../../src/features/run/run-events.js";

/**
 * The admission decorator.
 *
 * These are the properties the daemon's whole event surface rests on: every
 * admission emits a start and a terminal event, a subscriber is not left waiting
 * on a replay, an abort reaches the running admission, and a rejection before
 * admission is the caller's to report rather than a phantom event.
 */

const context = { workspaceId: "w1", principalId: "operator", caller: "cli", runId: "pending-admission" } as const;

const admitInput = (overrides: Partial<AdmitInput> = {}): AdmitInput => ({
  context,
  operationKey: "op-1",
  kind: "start",
  prompt: "hello",
  ...overrides,
});

/** A `WorkflowPort` whose single `admit` is supplied by the test. */
const port = (admit: WorkflowPort["admit"]): WorkflowPort => ({ admit, checkpoints: {} as never });

const completed = (taskId: string): AdmissionResult => ({
  taskId,
  threadId: "thread-1",
  created: true,
  replay: false,
  outcome: { status: "completed", finalText: "done" },
});

/** Collect everything published for a task, in order. */
function collected(bus: RunEventBus, taskId: string): UnsequencedClientEvent[] {
  const events: UnsequencedClientEvent[] = [];
  const original = bus.publish.bind(bus);
  vi.spyOn(bus, "publish").mockImplementation((id: string, event: UnsequencedClientEvent) => {
    if (id === taskId) events.push(event);
    return original(id, event);
  });
  return events;
}

/** The admitted-then-claimed callbacks a real admission fires, in order. */
function claim(input: AdmitInput, value: { taskId: string; admissionId: string; created: boolean }): void {
  const admitted = { taskId: value.taskId, threadId: "thread-1", admissionId: value.admissionId, created: value.created };
  input.onAdmitted?.(admitted);
  input.onClaimed?.(admitted);
}

describe("withRunEvents", () => {
  it("starts the stream when an admission that creates its task is claimed, and ends it", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        return completed("task-1");
      }),
      { bus },
    );

    await wrapped.admit(admitInput());

    expect(events.map((event) => event.kind)).toEqual(["run.started", "task.completed"]);
    // The start carries the stream identity a client needs to render a thread,
    // and an attempt id derived from the admission, so every observer agrees.
    expect(events[0]).toMatchObject({
      kind: "run.started",
      threadId: "thread-1",
      workspaceId: "w1",
      attemptId: attemptIdFor("adm-1"),
    });
  });

  it("masks a round's inputs as the workspace's setting says, and masks them when the setting cannot be read", async () => {
    const waiting = (taskId: string): AdmissionResult => ({
      taskId,
      threadId: "thread-1",
      created: true,
      replay: false,
      outcome: {
        status: "waiting",
        finalText: "",
        interrupt: {
          requests: [
            {
              callId: "c1",
              toolName: "fs.write",
              summary: "Write it",
              input: { content: "key AKIAIOSFODNN7EXAMPLE" },
              steps: 1,
              effect: "mutating",
            },
          ],
        },
      },
    });
    const inputs = async (maskInputs: (workspaceId: string) => Promise<boolean>) => {
      const bus = createRunEventBus({ epoch: "session-1" });
      const events = collected(bus, "task-1");
      const wrapped = withRunEvents(
        port(async (input) => {
          claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
          return waiting("task-1");
        }),
        { bus, maskInputs },
      );
      await wrapped.admit(admitInput());
      return events
        .filter((event) => event.kind === "approval.required")
        .map((event) => (event.kind === "approval.required" ? event.input : undefined));
    };
    expect(await inputs(async () => true)).toEqual([{ content: "key [redacted:aws-key]" }]);
    expect(await inputs(async () => false)).toEqual([{ content: "key AKIAIOSFODNN7EXAMPLE" }]);
    expect(
      await inputs(async () => {
        throw new Error("settings unavailable");
      }),
    ).toEqual([{ content: "key [redacted:aws-key]" }]);
  });

  it("masks a round's argument origins whole and within their bound, so the provenance still parses", () => {
    const token = "abcdefghijklmnop";
    const input = {
      whole: `Bearer ${token}qrstuv`,
      // A 16-character token inside a 120-character value: its placeholder is longer than it.
      inside: `${"x ".repeat(48)}Bearer ${token} ${"y".repeat(20)}`.slice(0, ARG_PROVENANCE_LIMITS.maxValueChars),
      // A token the 120-character clip would cut.
      cut: `${"z ".repeat(53)}Bearer ${token}qrstuvwxyz`,
    };
    const provenance = {
      gateReason: "tainted-payload" as const,
      sources: ["web" as const],
      principals: [],
      refs: [],
      argOrigins: [...argumentOrigins(input, [])],
    };
    const emitted: UnsequencedClientEvent[] = [];
    emitOutcomeEvents(
      {
        status: "waiting",
        finalText: "",
        interrupt: {
          requests: [{ callId: "c1", toolName: "http.request", summary: "Send", input, steps: 1, effect: "external", provenance }],
        },
      },
      "task-1",
      (event) => void emitted.push(event),
      "attempt-1",
      true,
    );
    const shown = emitted.find((event) => event.kind === "approval.required");
    const shownProvenance = shown?.kind === "approval.required" ? shown.provenance : undefined;
    expect(ApprovalProvenanceSchema.safeParse(shownProvenance).success).toBe(true);
    const values = Object.fromEntries((shownProvenance?.argOrigins ?? []).map((origin) => [origin.path, origin.value]));
    expect(values["whole"]).toBe("Bearer [redacted:bearer-token]");
    expect(values["inside"]?.length).toBeLessThanOrEqual(ARG_PROVENANCE_LIMITS.maxValueChars);
    for (const value of Object.values(values)) expect(value).not.toMatch(/abcdefg/);
  });

  it("masks a page's title in a round's provenance whole and within its bound, so a title cannot drop the provenance", () => {
    // A 120-character title, the bound, holding a 16-character bearer token: its placeholder is longer than it.
    const title = `${"t ".repeat(48)}Bearer abcdefghijklmnop ${"u".repeat(40)}`.slice(0, CONTENT_LABEL_LIMITS.maxTitleLength);
    expect(title).toHaveLength(CONTENT_LABEL_LIMITS.maxTitleLength);
    const provenance = {
      gateReason: "novel-url" as const,
      sources: ["web" as const],
      principals: ["host:news.example"],
      refs: [{ source: "web" as const, ref: "c1", host: "news.example", title, at: "2026-10-13T10:00:00.000Z" }],
      argOrigins: [],
    };
    const emitted: UnsequencedClientEvent[] = [];
    emitOutcomeEvents(
      {
        status: "waiting",
        finalText: "",
        interrupt: {
          requests: [{ callId: "c1", toolName: "http.request", summary: "Send", input: {}, steps: 1, effect: "external", provenance }],
        },
      },
      "task-1",
      (event) => void emitted.push(event),
      "attempt-1",
      true,
    );
    const shown = emitted.find((event) => event.kind === "approval.required");
    const shownProvenance = shown?.kind === "approval.required" ? shown.provenance : undefined;
    expect(ApprovalProvenanceSchema.safeParse(shownProvenance).success).toBe(true);
    const shownTitle = shownProvenance?.refs[0]?.title ?? "";
    expect(shownTitle.length).toBeLessThanOrEqual(CONTENT_LABEL_LIMITS.maxTitleLength);
    expect(shownTitle).toContain("[redacted");
    expect(shownTitle).not.toMatch(/abcdefg/);
  });

  it("tells a finished task's follow-up once it ended — and not for a turn that suspends, nor one never claimed", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const ended: string[] = [];
    const seen: { admissionId: string | undefined; ending: AdmissionResult["outcome"] | undefined }[] = [];
    let outcome: AdmissionResult["outcome"] = { status: "completed", finalText: "done" };
    let claims = true;
    const wrapped = withRunEvents(
      port(async (input) => {
        if (claims) claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        return { ...completed("task-1"), outcome };
      }),
      {
        bus,
        onTaskEnded: async (taskId, admissionId, ending) => {
          ended.push(taskId);
          seen.push({ admissionId, ending });
        },
      },
    );
    await wrapped.admit(admitInput());
    expect(ended).toEqual(["task-1"]);
    // With the admission and how it ended: what the channel reply relay sends from.
    expect(seen).toEqual([{ admissionId: "adm-1", ending: { status: "completed", finalText: "done" } }]);
    outcome = { status: "waiting", finalText: "" };
    await wrapped.admit(admitInput({ operationKey: "op-2" }));
    claims = false;
    outcome = { status: "completed", finalText: "done" };
    await wrapped.admit(admitInput({ operationKey: "op-3" }));
    expect(ended).toEqual(["task-1"]);
  });

  it("goes on when a finished task's follow-up fails", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        return completed("task-1");
      }),
      {
        bus,
        onTaskEnded: async () => {
          throw new Error("mailbox unavailable");
        },
      },
    );
    await expect(wrapped.admit(admitInput())).resolves.toMatchObject({ taskId: "task-1" });
  });

  it("marks a resume as an attempt boundary, never a second start, whatever `created` says", async () => {
    // `created` says an admission *row* was written, which a fresh resume's row
    // also is: keying the start on it began a second stream for every reply.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    let admission = 1;
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: `adm-${admission}`, created: true });
        admission += 1;
        return completed("task-1");
      }),
      { bus },
    );

    await wrapped.admit(admitInput());
    await wrapped.admit(admitInput({ kind: "reply", taskId: "task-1", prompt: "again" }));

    // One start; the reply is a boundary on the same stream — even after the
    // task completed, because a chat reply resumes a completed conversation.
    expect(events.map((event) => event.kind)).toEqual(["run.started", "task.completed", "attempt.replaced", "task.completed"]);
  });

  it("names the previous attempt when a resume follows an admission it observed", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    let admission = 1;
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: `adm-${admission}`, created: true });
        admission += 1;
        // The first admission suspends, so its stream is not finished.
        return admission === 2
          ? {
              ...completed("task-1"),
              outcome: {
                status: "waiting",
                finalText: "",
                waitInterrupt: { wait: { waitId: "w", deadlineAt: "2026-01-01T00:10:00.000Z" } },
              },
            }
          : completed("task-1");
      }),
      { bus },
    );

    await wrapped.admit(admitInput());
    await wrapped.admit(admitInput({ kind: "deadline", taskId: "task-1", resume: { waitOutcome: { kind: "replied" } } }));

    const boundary = events.find((event) => event.kind === "attempt.replaced");
    expect(boundary).toMatchObject({
      kind: "attempt.replaced",
      reason: expect.stringContaining("deadline"),
      supersededAttemptId: attemptIdFor("adm-1"),
      attemptId: attemptIdFor("adm-2"),
    });
  });

  it("claims no boundary for a resume whose earlier admission it never saw", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-2", created: true });
        return { ...completed("task-1"), created: false };
      }),
      { bus },
    );

    await wrapped.admit(admitInput({ kind: "reply", taskId: "task-1" }));

    // A fresh process has not observed the task's earlier admission, so there is
    // no superseded attempt to name; the schema requires one, so no boundary is
    // claimed rather than one invented.
    expect(events.map((event) => event.kind)).toEqual(["task.completed"]);
  });

  it("emits only the recorded outcome for a replay, with no boundary", async () => {
    // A retry under a committed key replays: admitted, never claimed, nothing
    // ran — so no start or boundary, but a subscriber still sees the end.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async (input) => {
        input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-1", created: false });
        return { ...completed("task-1"), created: false, replay: true };
      }),
      { bus },
    );

    await wrapped.admit(admitInput());

    expect(events.map((event) => event.kind)).toEqual(["task.completed"]);
  });

  it("adds nothing for a replay onto a stream that already holds events", async () => {
    // The stream carries its own end (or the progress past it): a second
    // `task.completed`, or a stale `approval.required` for a round decided since,
    // would mislead every subscriber. Only an empty stream — a new process, an
    // evicted ring — needs the recorded outcome re-reported.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    let replay = false;
    const wrapped = withRunEvents(
      port(async (input) => {
        if (!replay) {
          claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
          return completed("task-1");
        }
        input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-1", created: false });
        return { ...completed("task-1"), created: false, replay: true };
      }),
      { bus },
    );
    await wrapped.admit(admitInput());
    replay = true;
    await wrapped.admit(admitInput());
    expect(events.map((event) => event.kind)).toEqual(["run.started", "task.completed"]);
  });

  it("rethrows a rejection before admission, emitting nothing", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async () => {
        // An unknown agent definition or a conflicting operation key fails here,
        // before any task row exists.
        throw new Error("no such agent definition");
      }),
      { bus },
    );

    await expect(wrapped.admit(admitInput())).rejects.toThrow(/no such agent definition/);
    expect(events).toEqual([]);
  });

  it("emits nothing for a resume refused before it was claimed", async () => {
    // A resume names its task up front, but a refusal — another principal's
    // task, a stale round, a busy lease — runs nothing. A `task.failed` would
    // report a task that is still waiting (or somebody else's) as failed.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async (input) => {
        input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-2", created: true });
        throw new TaviError("CONFLICT", "the round moved on");
      }),
      { bus },
    );

    await expect(wrapped.admit(admitInput({ kind: "approval", taskId: "task-1" }))).rejects.toThrow(/round moved on/);
    expect(events).toEqual([]);
  });

  it("emits task.failed, with the error's own code, when a claimed admission fails", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        throw new TaviError("CONFLICT", "execution was superseded");
      }),
      { bus },
    );

    await expect(wrapped.admit(admitInput())).rejects.toThrow(/superseded/);
    // The subscriber must see an end even on the failure path, or it waits
    // forever for a stream that already stopped.
    expect(events.map((event) => event.kind)).toEqual(["run.started", "task.failed"]);
    expect(events[1]).toMatchObject({ errorCode: "CONFLICT" });
  });

  it("registers the abort controller only for the admission that holds the slot", async () => {
    // An admission queued behind another of the same task used to take over the
    // registration at `onAdmitted`: `abort` then signalled the queued one and
    // left the running turn untouched.
    const bus = createRunEventBus({ epoch: "session-1" });
    const aborts = createAbortRegistry();
    let releaseRunning: () => void = () => {};
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const signals: Record<string, AbortSignal | undefined> = {};
    let claimQueued: () => void = () => {};
    const wrapped = withRunEvents(
      port(async (input, options) => {
        signals[input.operationKey] = options?.signal;
        if (input.operationKey === "op-running") {
          claim(input, { taskId: "task-1", admissionId: "adm-running", created: true });
          await runningGate;
        } else {
          // Admitted now, claimed only once the running admission settles.
          input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-queued", created: true });
          await new Promise<void>((resolve) => {
            claimQueued = resolve;
          });
          input.onClaimed?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-queued", created: true });
        }
        return completed("task-1");
      }),
      { bus, aborts },
    );

    const running = wrapped.admit(admitInput({ operationKey: "op-running" }));
    const queued = wrapped.admit(admitInput({ operationKey: "op-queued", kind: "reply", taskId: "task-1" }));
    await vi.waitFor(() => expect(signals["op-queued"]).toBeDefined());

    expect(aborts.abort("task-1")).toBe(true);
    expect(signals["op-running"]?.aborted).toBe(true);
    expect(signals["op-queued"]?.aborted).toBe(false);

    releaseRunning();
    await running;
    claimQueued();
    await queued;
    expect(aborts.has("task-1")).toBe(false);
  });

  it("composes the caller's own signal with the registry's", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const callers = new AbortController();
    let seen: AbortSignal | undefined;
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        seen = options?.signal;
        return completed("task-1");
      }),
      { bus },
    );

    await wrapped.admit(admitInput(), { signal: callers.signal });
    callers.abort();
    // The caller's SIGINT and an IPC `abort` must both reach the running turn.
    expect(seen?.aborted).toBe(true);
  });

  it("composes the caller's event handlers rather than replacing them", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const callerSaw: string[] = [];
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-1", blockId: "block-1", text: "hi" });
        return completed("task-1");
      }),
      { bus },
    );

    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });

    await wrapped.admit(admitInput(), {
      onModelEvent: (event) => callerSaw.push(event.type),
    });

    expect(callerSaw).toEqual(["text.delta"]);
    expect(published.filter((event) => event.kind === "text.delta")).toHaveLength(1);
  });

  it("tells a tainted turn's taint and known URLs with the next text delta, again only when they change, and whole at its end", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const callerSaw: (readonly string[])[] = [];
    const delta = (text: string) => ({ type: "text.delta" as const, attemptId: "attempt-1", blockId: `block-${text}`, text });
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        options?.onModelEvent?.(delta("clean"));
        options?.onUntrustedInput?.(["https://a.example/", "https://a.example/#top"]);
        options?.onModelEvent?.(delta("first"));
        options?.onModelEvent?.(delta("second"));
        // The next call of the turn, its known URLs unchanged; then one that read a page with a link.
        options?.onUntrustedInput?.(["https://a.example/", "https://a.example/#top"]);
        options?.onModelEvent?.(delta("third"));
        options?.onUntrustedInput?.(["https://a.example/", "https://b.example/page"]);
        options?.onModelEvent?.(delta("fourth"));
        return completed("task-1");
      }),
      { bus },
    );
    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
    await wrapped.admit(admitInput(), { onUntrustedInput: (urls) => callerSaw.push(urls) });

    const taintOf = (event: ClientEvent) => ("tainted" in event ? { tainted: event.tainted, knownUrls: event.knownUrls } : {});
    expect(published.filter((event) => event.kind === "text.delta" || event.kind === "task.completed").map(taintOf)).toEqual([
      { tainted: undefined, knownUrls: undefined },
      // A fragment key is kept: a link is compared with its fragment.
      { tainted: true, knownUrls: ["https://a.example/", "https://a.example/#top"] },
      { tainted: undefined, knownUrls: undefined },
      { tainted: true, knownUrls: undefined },
      { tainted: true, knownUrls: ["https://a.example/", "https://b.example/page"] },
      { tainted: true, knownUrls: ["https://a.example/", "https://b.example/page"] },
    ]);
    // The caller's own observer still hears the URLs as told.
    expect(callerSaw).toHaveLength(3);
  });

  it("tells a tainted turn whose conversation holds no URLs without an empty list", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        options?.onUntrustedInput?.([]);
        options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-1", blockId: "b", text: "hi" });
        return completed("task-1");
      }),
      { bus },
    );
    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
    await wrapped.admit(admitInput());
    const told = published.filter((event) => event.kind === "text.delta" || event.kind === "task.completed");
    expect(told.map((event) => ("tainted" in event ? event.tainted : undefined))).toEqual([true, true]);
    expect(told.some((event) => "knownUrls" in event)).toBe(false);
  });

  it("tells nothing of taint for a clean turn", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-1", blockId: "b", text: "hi" });
        return completed("task-1");
      }),
      { bus },
    );
    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
    await wrapped.admit(admitInput());
    expect(published.some((event) => "tainted" in event || "knownUrls" in event)).toBe(false);
  });

  it("announces a failover before the new attempt's first event, discarding the old, and follows the new attempt", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const callerSaw: string[] = [];
    const failover = {
      attemptId: "attempt-b",
      supersededAttemptId: "attempt-a",
      from: { connectionId: "limited", model: "m" },
      to: { connectionId: "backup", model: "n" },
      errorCode: "rate_limit" as const,
      reason: "the model call failed over",
    };
    const wrapped = withRunEvents(
      port(async (input, options) => {
        if (input.kind !== "start") {
          // A later resume of the same task.
          claim(input, { taskId: "task-1", admissionId: "adm-2", created: false });
          return completed("task-1");
        }
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-a", blockId: "b", text: "half" });
        options?.onFailover?.(failover);
        options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-b", blockId: "b", text: "whole" });
        return completed("task-1");
      }),
      { bus },
    );
    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
    await wrapped.admit(admitInput(), { onFailover: (event) => callerSaw.push(event.attemptId) });

    expect(published.slice(0, 5).map((event) => [event.kind, event.attemptId])).toEqual([
      ["run.started", attemptIdFor("adm-1")],
      ["text.delta", "attempt-a"],
      ["attempt.replaced", "attempt-b"],
      ["text.delta", "attempt-b"],
      ["task.completed", "attempt-b"],
    ]);
    expect(published[2]).toMatchObject({ supersededAttemptId: "attempt-a", discarded: true, reason: "the model call failed over" });
    // The caller's own observer still hears it.
    expect(callerSaw).toEqual(["attempt-b"]);

    // A later resume names the attempt the failover moved to as the one it supersedes.
    await wrapped.admit(admitInput({ taskId: "task-1", kind: "deadline", operationKey: "op-2" }), {});
    expect(published.find((event) => event.kind === "attempt.replaced" && event.attemptId === attemptIdFor("adm-2"))).toMatchObject({
      supersededAttemptId: "attempt-b",
    });
  });

  it("publishes a tool failure whose message exceeds the event bound, clamped, without failing the admission", async () => {
    // A tool's error body is outside anyone's control; the bus refusing it used
    // to throw out of the graph's own handler and fail the task.
    const bus = createRunEventBus({ epoch: "session-1" });
    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        options?.onToolEvent?.({
          phase: "failed",
          callId: "call-1",
          toolName: "http.request",
          message: "e".repeat(5_000),
          durationMs: 1,
        } as never);
        return {
          ...completed("task-1"),
          outcome: { status: "failed", finalText: "f".repeat(3_000), error: { code: "MODEL_FAILED", message: "x" } },
        };
      }),
      { bus },
    );

    const result = await wrapped.admit(admitInput());
    expect(result.outcome.status).toBe("failed");
    const toolFailed = published.find((event) => event.kind === "tool.failed");
    const taskFailed = published.find((event) => event.kind === "task.failed");
    for (const event of [toolFailed, taskFailed]) {
      const message = event?.kind === "tool.failed" || event?.kind === "task.failed" ? event.message : "";
      // Clamped to exactly the bound and marked — not emptied, not dropped.
      expect(message).toHaveLength(IPC_MAX_MESSAGE_CHARS);
      expect(message.endsWith("…")).toBe(true);
    }
  });

  it("never throws into the admission when the bus refuses an event", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    vi.spyOn(bus, "publish").mockImplementation(() => {
      throw new Error("bus refused");
    });
    const diagnostics: string[] = [];
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        return completed("task-1");
      }),
      { bus, onDiagnostic: (message) => diagnostics.push(message) },
    );

    await expect(wrapped.admit(admitInput())).resolves.toMatchObject({ taskId: "task-1" });
    expect(diagnostics.some((message) => message.includes("could not be published"))).toBe(true);
  });

  it("marks a finished task's events evictable, first", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const marked = vi.spyOn(bus, "markCompleted");
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        return completed("task-1");
      }),
      { bus },
    );
    await wrapped.admit(admitInput());
    expect(marked).toHaveBeenCalledWith("task-1");
  });
});

describe("withRunEvents and a decided approval round", () => {
  const decision = {
    decisions: [
      { callId: "c1", approved: true, decidedBy: "alice" },
      { callId: "c2", approved: false, note: "no", decidedBy: "alice" },
    ],
    expectedSteps: 3,
  };

  it("announces the settled round on the claim, naming the attempt it answers, before the boundary", async () => {
    // From the decorator, so every front end's decision — the foreground loop,
    // the offline command, chat, a schedule's policy, IPC — clears attached
    // clients' cards alike.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    let admission = 1;
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: `adm-${admission}`, created: true });
        admission += 1;
        return admission === 2
          ? { ...completed("task-1"), outcome: { status: "waiting", finalText: "", interrupt: { requests: [] } } }
          : completed("task-1");
      }),
      { bus },
    );
    await wrapped.admit(admitInput());
    await wrapped.admit(admitInput({ kind: "approval", taskId: "task-1", resume: decision }));

    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("approval.settled")).toBeGreaterThan(-1);
    expect(kinds.indexOf("approval.settled")).toBeLessThan(kinds.indexOf("attempt.replaced"));
    expect(events.find((event) => event.kind === "approval.settled")).toMatchObject({
      steps: 3,
      decisions: [
        { callId: "c1", approved: true },
        { callId: "c2", approved: false },
      ],
      decidedBy: "alice",
      attemptId: attemptIdFor("adm-1"),
    });
  });

  it("names the resumed attempt, with no boundary, when this process never saw the round's", async () => {
    // An owner restarted while the round waited: the attempt that raised it is
    // unknown here, so the event names the resumed one.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-9", created: true });
        return completed("task-1");
      }),
      { bus },
    );
    await wrapped.admit(admitInput({ kind: "approval", taskId: "task-1", resume: decision }));
    expect(events.map((event) => event.kind)).toEqual(["approval.settled", "task.completed"]);
    expect(events[0]).toMatchObject({ attemptId: attemptIdFor("adm-9") });
  });

  it("announces nothing for a refused decision, or for one that names no round", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const refused = withRunEvents(
      port(async (input) => {
        input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-2", created: true });
        throw new TaviError("CONFLICT", "the round moved on");
      }),
      { bus },
    );
    await expect(refused.admit(admitInput({ kind: "approval", taskId: "task-1", resume: decision }))).rejects.toThrow();
    const unnamed = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-3", created: true });
        return completed("task-1");
      }),
      { bus },
    );
    // A resume that names no round (`tavi approvals`) gives the event no `steps`, so none is announced.
    await unnamed.admit(admitInput({ kind: "approval", taskId: "task-1", resume: { decisions: decision.decisions } }));
    expect(events.map((event) => event.kind)).not.toContain("approval.settled");
  });
});

describe("withRunEvents and a settled question", () => {
  const answered = {
    waitOutcome: { kind: "answered" as const, replyText: "Acme", answers: ["Acme"] },
    waitId: "wait:6:task-1:1:c1",
    via: "telegram-main",
    decidedBy: "alice",
  };

  it("announces the answer on the claim of its resume, with who and through what, before the boundary", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    let admission = 1;
    const wrapped = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: `adm-${admission}`, created: true });
        admission += 1;
        return completed("task-1");
      }),
      { bus },
    );
    await wrapped.admit(admitInput());
    await wrapped.admit(admitInput({ kind: "deadline", taskId: "task-1", resume: answered }));
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("wait.settled")).toBeGreaterThan(-1);
    expect(kinds.indexOf("wait.settled")).toBeLessThan(kinds.indexOf("attempt.replaced"));
    expect(events.find((event) => event.kind === "wait.settled")).toEqual(
      expect.objectContaining({
        waitId: "wait:6:task-1:1:c1",
        outcome: "answered",
        answers: ["Acme"],
        replyText: "Acme",
        via: "telegram-main",
        decidedBy: "alice",
        attemptId: attemptIdFor("adm-1"),
      }),
    );
  });

  it("announces nothing for a refused resume, or for one that names no wait", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const refused = withRunEvents(
      port(async (input) => {
        input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-2", created: true });
        throw new TaviError("CONFLICT", "no longer waiting");
      }),
      { bus },
    );
    await expect(refused.admit(admitInput({ kind: "deadline", taskId: "task-1", resume: answered }))).rejects.toThrow();
    const unnamed = withRunEvents(
      port(async (input) => {
        claim(input, { taskId: "task-1", admissionId: "adm-3", created: true });
        return completed("task-1");
      }),
      { bus },
    );
    await unnamed.admit(admitInput({ kind: "deadline", taskId: "task-1", resume: { waitOutcome: { kind: "wait-timeout" } } }));
    expect(events.map((event) => event.kind)).not.toContain("wait.settled");
  });
});

describe("withRunEvents edge cases", () => {
  it("ends a stream answered by a cancellation, with no start, and marks it finished", async () => {
    // A cancelled task's admission is answered without a claim: nothing ran, but
    // a subscriber still needs its end.
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    const marked = vi.spyOn(bus, "markCompleted");
    const wrapped = withRunEvents(
      port(async (input) => {
        input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-2", created: true });
        return {
          taskId: "task-1",
          threadId: "thread-1",
          created: true,
          replay: false,
          outcome: { status: "failed", finalText: "cancelled", error: { code: "CANCELLED", message: "stop" } },
        };
      }),
      { bus },
    );
    await wrapped.admit(admitInput({ kind: "reply", taskId: "task-1" }));
    expect(events).toEqual([expect.objectContaining({ kind: "task.failed", errorCode: "CANCELLED" })]);
    expect(marked).toHaveBeenCalledWith("task-1");
  });

  it("treats a start retried after a claimed attempt threw as a new attempt, not a second start", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const events = collected(bus, "task-1");
    let attempt = 0;
    const wrapped = withRunEvents(
      port(async (input) => {
        attempt += 1;
        // The retry resolves the same admission row: not created, not a replay.
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: attempt === 1 });
        if (attempt === 1) throw new TaviError("INTERNAL", "the process was interrupted");
        return completed("task-1");
      }),
      { bus },
    );
    await expect(wrapped.admit(admitInput())).rejects.toThrow(/interrupted/);
    await wrapped.admit(admitInput());
    expect(events.map((event) => event.kind)).toEqual(["run.started", "task.failed", "attempt.replaced", "task.completed"]);
  });

  it("closes admission for every producer once closed, and counts only what it admitted", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const admissions = createAdmissionTracker();
    let inner = 0;
    const wrapped = withRunEvents(
      port(async (input) => {
        inner += 1;
        claim(input, { taskId: "task-1", admissionId: `adm-${inner}`, created: true });
        return completed("task-1");
      }),
      { bus, admissions },
    );
    await wrapped.admit(admitInput());
    admissions.close();
    await expect(wrapped.admit(admitInput({ operationKey: "op-2" }))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    // Refused before any work: the inner port never saw it, and nothing is counted.
    expect(inner).toBe(1);
    expect(admissions.active()).toBe(0);
  });

  it("uncounts an admission whose inner port rejects", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const admissions = createAdmissionTracker();
    const wrapped = withRunEvents(
      port(async () => {
        throw new Error("refused");
      }),
      { bus, admissions },
    );
    await expect(wrapped.admit(admitInput())).rejects.toThrow(/refused/);
    expect(admissions.active()).toBe(0);
    await expect(admissions.idle(0)).resolves.toBe(true);
  });
});

describe("createAdmissionTracker", () => {
  it("is idle at once with nothing in flight, even with a zero deadline", async () => {
    await expect(createAdmissionTracker().idle(0)).resolves.toBe(true);
  });

  it("reports false at the deadline, and true for every waiter when the last admission ends", async () => {
    const tracker = createAdmissionTracker();
    tracker.begin();
    tracker.begin();
    await expect(tracker.idle(20)).resolves.toBe(false);

    const first = tracker.idle(5_000);
    const second = tracker.idle(5_000);
    tracker.end();
    expect(tracker.active()).toBe(1);
    tracker.end();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("refuses to begin once closed", () => {
    const tracker = createAdmissionTracker();
    tracker.close();
    expect(() => tracker.begin()).toThrowError(/shutting down/);
  });
});

describe("emitOutcomeEvents", () => {
  const emitInto = () => {
    const seen: UnsequencedClientEvent[] = [];
    return { seen, emit: (event: UnsequencedClientEvent) => seen.push(event) };
  };

  it("masks a round's call inputs for clients when asked, keeping the round's own", () => {
    const input = { path: "a.txt", content: "key AKIAIOSFODNN7EXAMPLE" };
    const outcome: AdmissionOutcome = {
      status: "waiting",
      finalText: "",
      interrupt: { requests: [{ callId: "c1", toolName: "fs.write", summary: "Write it", input, steps: 1, effect: "mutating" }] },
    };
    const masked = emitInto();
    emitOutcomeEvents(outcome, "task-1", masked.emit, "attempt-1", true);
    expect(masked.seen).toMatchObject([{ kind: "approval.required", input: { path: "a.txt", content: "key [redacted:aws-key]" } }]);
    const plain = emitInto();
    emitOutcomeEvents(outcome, "task-1", plain.emit, "attempt-1");
    expect(plain.seen).toMatchObject([{ kind: "approval.required", input: { content: "key AKIAIOSFODNN7EXAMPLE" } }]);
    expect(input.content).toBe("key AKIAIOSFODNN7EXAMPLE");
  });

  it("masks a round's summary, display and risk with its input, as the event carries them", () => {
    const input = { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://x" };
    const outcome: AdmissionOutcome = {
      status: "waiting",
      finalText: "",
      interrupt: {
        requests: [
          {
            callId: "c1",
            toolName: "sandbox.run",
            summary: `Run ${input.command}`,
            input,
            steps: 1,
            effect: "external",
            display: { title: `Run ${input.command}`, command: input.command },
            risk: { level: "medium", reasons: [`Sends ${input.command}`], tainted: false },
          },
        ],
      },
    };
    const masked = emitInto();
    emitOutcomeEvents(outcome, "task-1", masked.emit, "attempt-1", true);
    expect(JSON.stringify(masked.seen)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("maps a completed outcome to task.completed", () => {
    const { seen, emit } = emitInto();
    emitOutcomeEvents({ status: "completed", finalText: "all done" }, "task-1", emit, "attempt-1");
    expect(seen).toEqual([{ kind: "task.completed", runId: "task-1", attemptId: "attempt-1", finalText: "all done" }]);
  });

  it("maps a review suspension to task.review_required, carrying the round", () => {
    const { seen, emit } = emitInto();
    emitOutcomeEvents(
      {
        status: "waiting",
        finalText: "",
        reviewInterrupt: { requests: [{ artifactId: "art-1", callId: "call-1", toolName: "sandbox.run", steps: 4 }] },
      },
      "task-1",
      emit,
      "attempt-1",
    );
    expect(seen[0]).toMatchObject({ kind: "task.review_required", steps: 4 });
  });

  it("maps a wait suspension to task.waiting with the question when there is one", () => {
    const { seen, emit } = emitInto();
    emitOutcomeEvents(
      {
        status: "waiting",
        finalText: "",
        waitInterrupt: {
          wait: { waitId: "wait-1", deadlineAt: "2026-01-01T00:10:00.000Z" },
          question: "Which environment?",
        },
      },
      "task-1",
      emit,
      "attempt-1",
    );
    expect(seen[0]).toMatchObject({
      kind: "task.waiting",
      on: "its deadline",
      question: "Which environment?",
    });
  });

  it("emits one approval.required per gated call", () => {
    const { seen, emit } = emitInto();
    emitOutcomeEvents(
      {
        status: "waiting",
        finalText: "",
        interrupt: {
          requests: [
            { callId: "call-1", toolName: "fixture.write", summary: "one", input: {}, effect: "mutating", steps: 2 },
            { callId: "call-2", toolName: "fixture.write", summary: "two", input: {}, effect: "mutating", steps: 2 },
          ],
        },
      },
      "task-1",
      emit,
      "attempt-1",
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ kind: "approval.required", callId: "call-1", steps: 2 });
  });

  it("carries a request's rule subjects onto approval.required, and none for a payload without them", () => {
    const { seen, emit } = emitInto();
    const request = { callId: "call-1", toolName: "shell.exec", summary: "one", input: {}, effect: "mutating", steps: 2 };
    emitOutcomeEvents(
      { status: "waiting", finalText: "", interrupt: { requests: [{ ...request, subjects: ["git status"] } as typeof request, request] } },
      "task-1",
      emit,
      "attempt-1",
    );
    expect(seen[0]).toMatchObject({ kind: "approval.required", subjects: ["git status"] });
    expect(seen[1]).not.toHaveProperty("subjects");
  });
});

it("publishes spawn hints only for a durable edge belonging to this parent", async () => {
  const bus = createRunEventBus({ epoch: "spawn-epoch" });
  const events = collected(bus, "task-1");
  const edge = {
    operationKey: "spawn",
    workspaceId: "w1",
    principalId: "operator",
    workerTaskId: "child",
    workerAgentId: "worker",
    parentTaskId: "task-1",
    rootTaskId: "task-1",
    depth: 1,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const wrapped = withRunEvents(
    port(async (input, options) => {
      claim(input, { taskId: "task-1", admissionId: "adm", created: true });
      for (const child of ["child", "unrecorded"])
        options?.onToolEvent?.({
          phase: "completed",
          callId: child,
          toolName: "agents.spawn",
          output: { workerTaskId: child },
          durationMs: 1,
        });
      return completed("task-1");
    }),
    {
      bus,
      delegations: {
        recordSpawn: async () => {},
        getByOperationKey: async () => undefined,
        listChildren: async () => [],
        countRunningInTree: async () => 0,
        listRunningInTree: async () => [],
        listUnannouncedEnded: async () => [],
        getByWorkerTaskId: async (id) => (id === "child" ? edge : undefined),
      },
    },
  );
  await wrapped.admit(admitInput());
  expect(events.filter((event) => event.kind === "task.spawned")).toEqual([
    expect.objectContaining({ childRunId: "child", workerAgentId: "worker", depth: 1, runId: "task-1", attemptId: "attempt-adm" }),
  ]);
});

it("reports actual models and accumulated usage, marking unknown calls partial", async () => {
  const bus = createRunEventBus({ epoch: "metrics" });
  const events = collected(bus, "task-metrics");
  const wrapped = withRunEvents(
    port(async (input, options) => {
      claim(input, { taskId: "task-metrics", admissionId: "adm-metrics", created: true });
      options?.onModelEvent?.({
        type: "model.result",
        attemptId: "a1",
        connectionId: "primary",
        model: "small",
        usage: { inputTokens: 12, outputTokens: 4 },
      });
      options?.onModelEvent?.({
        type: "model.result",
        attemptId: "a2",
        connectionId: "fallback",
        model: "large",
        usage: { totalTokens: 20 },
      });
      options?.onModelEvent?.({ type: "model.result", attemptId: "a3", connectionId: "fallback", model: "large", usage: {} });
      return completed("task-metrics");
    }),
    { bus },
  );
  await wrapped.admit(admitInput());
  expect(events.at(-1)).toMatchObject({
    kind: "task.completed",
    metrics: { models: ["primary/small", "fallback/large"], totalTokens: 36, partial: true },
  });
  expect((events.at(-1) as { metrics?: object }).metrics).not.toHaveProperty("cacheReadTokens");
});

it("reports the tokens providers read from their cache, when any did", async () => {
  const bus = createRunEventBus({ epoch: "metrics-cache" });
  const events = collected(bus, "task-cache");
  const wrapped = withRunEvents(
    port(async (input, options) => {
      claim(input, { taskId: "task-cache", admissionId: "adm-cache", created: true });
      options?.onModelEvent?.({
        type: "model.result",
        attemptId: "a1",
        connectionId: "primary",
        model: "small",
        usage: { inputTokens: 900, outputTokens: 10, inputCacheReadTokens: 600 },
      });
      options?.onModelEvent?.({
        type: "model.result",
        attemptId: "a2",
        connectionId: "primary",
        model: "small",
        usage: { inputTokens: 950, outputTokens: 10, inputCacheReadTokens: 800 },
      });
      return completed("task-cache");
    }),
    { bus },
  );
  await wrapped.admit(admitInput());
  expect(events.at(-1)).toMatchObject({ kind: "task.completed", metrics: { totalTokens: 1_870, cacheReadTokens: 1_400 } });
});

describe("text delta coalescing", () => {
  const delta = (text: string, extra: Partial<UnsequencedClientEvent & { kind: "text.delta" }> = {}): UnsequencedClientEvent => ({
    kind: "text.delta",
    runId: "task-1",
    attemptId: "attempt-1",
    blockId: "b",
    text,
    ...extra,
  });
  const recorder = () => {
    const published: UnsequencedClientEvent[] = [];
    return { published, coalescer: createDeltaCoalescer((_taskId, event) => published.push(event)) };
  };
  const textsOf = (events: readonly UnsequencedClientEvent[]) =>
    events.map((event) => (event.kind === "text.delta" ? event.text : event.kind));

  it("merges one block's deltas until its window passes", () => {
    vi.useFakeTimers();
    try {
      const { published, coalescer } = recorder();
      coalescer.send("task-1", delta("a"));
      coalescer.send("task-1", delta("b"));
      expect(published).toEqual([]);
      vi.advanceTimersByTime(DELTA_COALESCE_MS);
      coalescer.send("task-1", delta("c"));
      vi.advanceTimersByTime(DELTA_COALESCE_MS);
      expect(textsOf(published)).toEqual(["ab", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes the held delta before any other event, a new block or a new attempt", () => {
    const { published, coalescer } = recorder();
    coalescer.send("task-1", delta("a"));
    coalescer.send("task-1", delta("b", { blockId: "other" }));
    coalescer.send("task-1", delta("c", { blockId: "other", attemptId: "attempt-2" }));
    coalescer.send("task-1", {
      kind: "tool.started",
      runId: "task-1",
      attemptId: "attempt-2",
      blockId: "x",
      callId: "x",
      toolName: "t",
      input: null,
    });
    coalescer.send("task-1", delta("d", { attemptId: "attempt-2" }));
    coalescer.flush();
    expect(textsOf(published)).toEqual(["a", "b", "c", "tool.started", "d"]);
  });

  it("never splits a chunk, and merges only below the bound", () => {
    const { published, coalescer } = recorder();
    const big = "x".repeat(2 * DELTA_COALESCE_CHARS);
    coalescer.send("task-1", delta(big));
    coalescer.send("task-1", delta(big));
    expect(textsOf(published)).toEqual([big, big]);
    const half = "y".repeat(DELTA_COALESCE_CHARS / 2);
    coalescer.send("task-1", delta(half));
    coalescer.send("task-1", delta(half));
    coalescer.flush();
    expect(textsOf(published.slice(2))).toEqual([half, half]);
  });

  it("taints a merged delta when any part was, with the newest known URLs", () => {
    const { published, coalescer } = recorder();
    coalescer.send("task-1", delta("a", { tainted: true, knownUrls: ["https://a.example/"] }));
    coalescer.send("task-1", delta("b"));
    coalescer.flush();
    coalescer.send("task-1", delta("c"));
    coalescer.send("task-1", delta("d", { tainted: true, knownUrls: ["https://b.example/"] }));
    coalescer.send("task-1", delta("e", { tainted: true }));
    coalescer.flush();
    expect(published).toEqual([
      delta("ab", { tainted: true, knownUrls: ["https://a.example/"] }),
      delta("cde", { tainted: true, knownUrls: ["https://b.example/"] }),
    ]);
  });

  it("publishes an admission's merged deltas before its tool events and its end", async () => {
    const bus = createRunEventBus({ epoch: "session-1" });
    const wrapped = withRunEvents(
      port(async (input, options) => {
        claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
        for (const text of ["one ", "two ", "three"])
          options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-1", blockId: "b", text });
        await options?.onToolEvent?.({ phase: "started", callId: "c1", toolName: "t", input: {} } as never);
        options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-1", blockId: "b2", text: "after" });
        return completed("task-1");
      }),
      { bus },
    );
    const published: ClientEvent[] = [];
    bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
    await wrapped.admit(admitInput());
    expect(published.map((event) => (event.kind === "text.delta" ? event.text : event.kind))).toEqual([
      "run.started",
      "one two three",
      "tool.started",
      "after",
      "task.completed",
    ]);
  });

  it("publishes a failed admission's held delta before its failure, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const bus = createRunEventBus({ epoch: "session-1" });
      const wrapped = withRunEvents(
        port(async (input, options) => {
          claim(input, { taskId: "task-1", admissionId: "adm-1", created: true });
          for (const text of ["one ", "two"]) options?.onModelEvent?.({ type: "text.delta", attemptId: "attempt-1", blockId: "b", text });
          throw new Error("cancelled");
        }),
        { bus },
      );
      const published: ClientEvent[] = [];
      bus.subscribe({ taskId: "task-1", deliver: (event) => published.push(event) });
      await expect(wrapped.admit(admitInput())).rejects.toThrow(/cancelled/);
      expect(published.map((event) => (event.kind === "text.delta" ? event.text : event.kind))).toEqual([
        "run.started",
        "one two",
        "task.failed",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
