import { describe, expect, it } from "vitest";

import { MEMORY_USED_RECORDS_MAX, TranscriptTurnSchema, type AdmissionOutcome, type UnsequencedClientEvent } from "@tavi/contracts";

import { createTurnRecorder } from "../../src/features/run/turn-recorder.js";

const base = { runId: "task-1", attemptId: "attempt-1" };

describe("a turn as a person saw it", () => {
  it("keeps text in block order, tools by how they ended, and drops a failed-over attempt's text", () => {
    const recorder = createTurnRecorder("reply", "find the docs");
    const events: UnsequencedClientEvent[] = [
      { ...base, kind: "text.delta", blockId: "b1", text: "Looking" },
      { ...base, kind: "text.delta", blockId: "b1", text: " now." },
      { ...base, kind: "tool.started", blockId: "t1", callId: "c1", toolName: "web_search", input: { q: "docs" } },
      { ...base, kind: "tool.failed", callId: "c1", toolName: "web_search", errorCode: "TIMEOUT", message: "slow", durationMs: 5 },
      { ...base, kind: "text.delta", blockId: "b2", text: "lost" },
      { ...base, attemptId: "attempt-2", kind: "attempt.replaced", supersededAttemptId: "attempt-1", reason: "failover", discarded: true },
      { ...base, attemptId: "attempt-2", kind: "text.delta", blockId: "b3", text: "Found it." },
      { ...base, attemptId: "attempt-2", kind: "tool.started", blockId: "t2", callId: "c2", toolName: "operator.ask_user", input: {} },
    ] as UnsequencedClientEvent[];
    for (const event of events) recorder.observe(event);
    const turn = recorder.turn({ status: "waiting", finalText: "" });
    expect(turn).toEqual({
      admissionKind: "reply",
      prompt: "find the docs",
      items: [
        { kind: "tool", callId: "c1", toolName: "web_search", status: "failed", errorCode: "TIMEOUT", message: "slow", durationMs: 5 },
        { kind: "text", text: "Found it." },
        { kind: "tool", callId: "c2", toolName: "operator.ask_user", status: "interrupted" },
      ],
      outcome: { status: "waiting" },
      // Recorded on every turn, none used included.
      memoryUsed: { records: [], preferences: 0, more: 0 },
    });
  });

  it("keeps the question a turn waits on, and bounds a tool's name as the stream does", () => {
    const recorder = createTurnRecorder("start", "pick one");
    recorder.observe({
      ...base,
      kind: "tool.started",
      blockId: "t",
      callId: "c",
      toolName: "x".repeat(300),
      input: {},
    } as UnsequencedClientEvent);
    const waitInterrupt: NonNullable<AdmissionOutcome["waitInterrupt"]> = {
      wait: { waitId: "w", deadlineAt: "2099-01-01T00:00:00Z" },
      question: "Which one?",
    };
    const turn = recorder.turn({ status: "waiting", finalText: "", waitInterrupt });
    expect(turn.items.at(-1)).toEqual({ kind: "question", text: "Which one?" });
    expect(turn.items[0]?.kind === "tool" ? turn.items[0].toolName.length : 0).toBe(128);
    expect(TranscriptTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("names an approval round and a failure, and bounds what it keeps", () => {
    const approval = createTurnRecorder("start", "go");
    expect(approval.turn({ status: "waiting", finalText: "", interrupt: { requests: [] } }).outcome.status).toBe("approval");
    const failed = createTurnRecorder("approval", undefined);
    failed.observe({ ...base, kind: "text.delta", blockId: "b", text: "x".repeat(70_000) } as UnsequencedClientEvent);
    const turn = failed.turn({ status: "failed", finalText: "", error: { code: "MODEL_FAILED", message: "down" } });
    expect(turn.prompt).toBeUndefined();
    expect(turn.truncated).toBe(true);
    expect(turn.items[0]?.kind === "text" ? turn.items[0].text.length : 0).toBe(64_000);
    expect(turn.outcome).toEqual({ status: "failed", errorCode: "MODEL_FAILED", message: "down" });
  });

  it("keeps a message sent into the turn where the model read it, once", () => {
    const recorder = createTurnRecorder("start", "how far?");
    const events = [
      { ...base, kind: "text.delta", blockId: "b1", text: "Checking." },
      { ...base, kind: "turn.steered", messageId: "m-1", text: "in kilometres" },
      // A model call retried after a crash reports it again.
      { ...base, kind: "turn.steered", messageId: "m-1", text: "in kilometres" },
      { ...base, kind: "text.delta", blockId: "b2", text: "12 km." },
    ] as UnsequencedClientEvent[];
    for (const event of events) recorder.observe(event);
    const turn = recorder.turn({ status: "completed", finalText: "12 km." });
    expect(turn.items).toEqual([
      { kind: "text", text: "Checking." },
      { kind: "steer", text: "in kilometres" },
      { kind: "text", text: "12 km." },
    ]);
    expect(TranscriptTurnSchema.parse(turn)).toEqual(turn);
  });

  it("counts a steer's words toward the turn's bound, clipping it to what is left", () => {
    const recorder = createTurnRecorder("start", "go");
    const events = [
      { ...base, kind: "text.delta", blockId: "b1", text: "x".repeat(63_990) },
      { ...base, kind: "turn.steered", messageId: "m-1", text: "y".repeat(30) },
      { ...base, kind: "turn.steered", messageId: "m-2", text: "dropped" },
      { ...base, kind: "text.delta", blockId: "b2", text: "also dropped" },
    ] as UnsequencedClientEvent[];
    for (const event of events) recorder.observe(event);
    const turn = recorder.turn({ status: "completed", finalText: "" });
    expect(turn.truncated).toBe(true);
    expect(turn.items.map((item) => item.kind)).toEqual(["text", "steer"]);
    expect(turn.items[1]).toEqual({ kind: "steer", text: "y".repeat(10) });
    expect(turn.items.reduce((total, item) => total + (item.kind === "text" || item.kind === "steer" ? item.text.length : 0), 0)).toBe(
      64_000,
    );
  });
});

describe("the memory a turn used", () => {
  it("memory invariant 12: keeps each revision a call was given or a tool fetched once, in the order first used, the most preferences any call applied, and counts past 20", () => {
    const recorder = createTurnRecorder("start", "where do I live?");
    recorder.noteMemory({
      records: [
        { recordId: "r1", revisionId: "v1" },
        { recordId: "r2", revisionId: "v2" },
      ],
      preferences: 2,
    });
    // The second call is given the same evidence, and fewer preferences: nothing is counted twice.
    recorder.noteMemory({
      records: [
        { recordId: "r2", revisionId: "v2" },
        { recordId: "r1", revisionId: "v1" },
      ],
      preferences: 1,
    });
    // A tool's read, then a corrected record's newer revision: each a revision of its own.
    recorder.noteMemory({
      records: [
        { recordId: "r3", revisionId: "v3" },
        { recordId: "r1", revisionId: "v1b" },
      ],
    });
    const turn = recorder.turn({ status: "completed", finalText: "Lisbon." });
    expect(turn.memoryUsed).toEqual({
      records: [
        { recordId: "r1", revisionId: "v1" },
        { recordId: "r2", revisionId: "v2" },
        { recordId: "r3", revisionId: "v3" },
        { recordId: "r1", revisionId: "v1b" },
      ],
      preferences: 2,
      more: 0,
    });
    expect(TranscriptTurnSchema.parse(turn)).toEqual(turn);
    const many = createTurnRecorder("start", "everything");
    many.noteMemory({
      records: Array.from({ length: MEMORY_USED_RECORDS_MAX + 5 }, (_, index) => ({ recordId: `r${index}`, revisionId: `v${index}` })),
    });
    const bounded = many.turn({ status: "completed", finalText: "" }).memoryUsed;
    expect(bounded?.records).toHaveLength(MEMORY_USED_RECORDS_MAX);
    expect(bounded?.records[0]).toEqual({ recordId: "r0", revisionId: "v0" });
    expect(bounded?.more).toBe(5);
  });

  it("keeps what a listing returned apart from what was used: a record used too counts once, as used", () => {
    const recorder = createTurnRecorder("start", "from what you know I like");
    recorder.noteMemory({
      records: [{ recordId: "r1", revisionId: "v1" }],
      listed: [
        { recordId: "r1", revisionId: "v1" },
        { recordId: "r2", revisionId: "v2" },
        { recordId: "r2", revisionId: "v2" },
      ],
    });
    // Fetched after it was listed: used, whichever came first.
    recorder.noteMemory({
      records: [{ recordId: "r3", revisionId: "v3" }],
      listed: [{ recordId: "r3", revisionId: "v3" }],
    });
    const turn = recorder.turn({ status: "completed", finalText: "Arrival." });
    expect(turn.memoryUsed).toEqual({
      records: [
        { recordId: "r1", revisionId: "v1" },
        { recordId: "r3", revisionId: "v3" },
      ],
      preferences: 0,
      more: 0,
      listed: { records: [{ recordId: "r2", revisionId: "v2" }], more: 0 },
    });
    expect(TranscriptTurnSchema.parse(turn)).toEqual(turn);
    const many = createTurnRecorder("start", "everything");
    many.noteMemory({
      records: [],
      listed: Array.from({ length: MEMORY_USED_RECORDS_MAX + 42 }, (_, index) => ({ recordId: `r${index}`, revisionId: `v${index}` })),
    });
    const bounded = many.turn({ status: "completed", finalText: "" }).memoryUsed;
    expect(bounded?.records).toEqual([]);
    expect(bounded?.listed?.records).toHaveLength(MEMORY_USED_RECORDS_MAX);
    expect(bounded?.listed?.more).toBe(42);
  });

  it("records none, and no preferences, for a turn whose calls were given nothing", () => {
    expect(createTurnRecorder("start", "hi").turn({ status: "completed", finalText: "Hello." }).memoryUsed).toEqual({
      records: [],
      preferences: 0,
      more: 0,
    });
  });

  it("marks a turn tainted once a call of it read untrusted data that came with it, and only then", () => {
    const clean = createTurnRecorder("start", "hi").turn({ status: "completed", finalText: "Hello." });
    expect(clean.tainted).toBeUndefined();
    const recorder = createTurnRecorder("reply", "read this page");
    recorder.noteUntrusted();
    recorder.noteUntrusted();
    const tainted = recorder.turn({ status: "completed", finalText: "It says…" });
    expect(tainted.tainted).toBe(true);
    // The saved shape takes it: the schema is strict.
    expect(TranscriptTurnSchema.parse(tainted).tainted).toBe(true);
  });

  it("keeps a tainted turn's known URLs as last told, URL keys only, for the canvas to read back", () => {
    const recorder = createTurnRecorder("reply", "read this page");
    recorder.noteUntrusted(["https://a.example/"]);
    recorder.noteUntrusted(["https://a.example/", "https://b.example/x#part", "HTTPS://C.example/page"]);
    const tainted = recorder.turn({ status: "completed", finalText: "It says…" });
    // A navigation key keeps its fragment, as a link is compared with one; a URL not in key form is left out.
    expect(tainted.knownUrls).toEqual(["https://a.example/", "https://b.example/x#part"]);
    expect(TranscriptTurnSchema.parse(tainted).knownUrls).toEqual(["https://a.example/", "https://b.example/x#part"]);
    const none = createTurnRecorder("reply", "read");
    none.noteUntrusted([]);
    expect(none.turn({ status: "completed", finalText: "" }).knownUrls).toBeUndefined();
  });

  it("records a turn held to a messaging conversation, and none otherwise (memory invariant 6)", () => {
    expect(createTurnRecorder("start", "hi").turn({ status: "completed", finalText: "Hello." }).channel).toBeUndefined();
    const recorder = createTurnRecorder("reply", "from my phone");
    recorder.noteChannel("messaging");
    const held = recorder.turn({ status: "completed", finalText: "Got it." });
    expect(held.channel).toBe("messaging");
    expect(TranscriptTurnSchema.parse(held).channel).toBe("messaging");
  });
});
