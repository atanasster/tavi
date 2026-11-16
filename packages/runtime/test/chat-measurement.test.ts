import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/**
 * `doctor`'s local measurement: model use by chat
 * kind, joined from the provider ledger to the task at read time, and side-chat
 * use from admissions and settle notices.
 */

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (hours: number): string => new Date(T0 + hours * 3_600_000).toISOString();

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const { tasks } = store.asPort().repositories;
  const db = store.handle;
  let sequence = 0;
  /** One turn with the person's prompt, committed and dated `hours` after T0. */
  const turn = (taskId: string, hours: number, prompt = "p", origin: "ipc" | "messaging" = "ipc") => {
    sequence += 1;
    const admissionId = `admission-${sequence}`;
    const first = db.prepare("SELECT 1 FROM tavi_tasks WHERE task_id = ?").get(taskId) === undefined;
    tasks.admit({
      workspaceId: "w1",
      principalId: "alice",
      operationKey: `op-${sequence}`,
      kind: first ? "start" : "reply",
      intent: { prompt },
      checkpointNamespace: "",
      ...(first ? { origin } : { taskId }),
      now: () => at(hours),
      newTaskId: () => taskId,
      newThreadId: () => `thread-${taskId}`,
      newAdmissionId: () => admissionId,
    });
    db.prepare("UPDATE tavi_admissions SET state = 'committed', created_at = ? WHERE admission_id = ?").run(at(hours), admissionId);
    return admissionId;
  };
  const kind = (taskId: string, chatKind: string, parent?: string) =>
    db.prepare("UPDATE tavi_tasks SET chat_kind = ?, parent_chat_id = ? WHERE task_id = ?").run(chatKind, parent ?? null, taskId);
  const call = (runId: string, purpose: string, attemptId: string, inputTokens?: number) => {
    sequence += 1;
    const data = {
      callId: `call-${sequence}`,
      runId,
      attemptId,
      purpose,
      usage: inputTokens === undefined ? {} : { inputTokens, outputTokens: 1 },
    };
    // The measurement reads the purpose and input_tokens columns, never `data`.
    db.prepare(
      "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, input_tokens, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(`call-${sequence}`, runId, attemptId, "session", "completed", at(0), purpose, inputTokens ?? null, JSON.stringify(data));
  };
  const settle = (sideId: string, parentId: string, hours: number) =>
    db
      .prepare(
        "INSERT INTO tavi_chat_notices (notice_id, task_id, source_key, kind, source_task_id, title, summary, after_seq, read_by, created_at) VALUES (?, ?, ?, 'side-chat-settled', ?, 't', 's', 0, NULL, ?)",
      )
      .run(`notice-${sideId}`, parentId, `side-chat:${sideId}`, sideId, at(hours));
  return { store, db, turn, kind, call, settle };
}

describe("chat measurement", () => {
  it("reports per-turn input tokens and summarizer calls by chat kind, and side-chat use", () => {
    const { store, db, turn, kind, call, settle } = fixture();
    // Home: three turns (the last one a return from side-a), three model calls, a compaction and an epoch flush.
    turn("home", -10);
    turn("home", -5);
    turn("home", 1);
    kind("home", "home");
    call("home", "generation", "a-1", 100);
    call("home", "generation", "a-2", 200);
    call("home", "generation", "a-3", 300);
    call("home", "summary", "compaction-attempt-x-1", 5000);
    call("home", "summary", "epoch-flush-attempt-x-2", 4000);
    // side-a: 3 messages, settled at T0, its parent answered an hour later.
    turn("side-a", -3);
    turn("side-a", -2);
    turn("side-a", -1);
    kind("side-a", "side", "home");
    call("side-a", "generation", "b-1", 50);
    call("side-a", "generation", "b-2");
    call("side-a", "summary", "summary-b-3", 10);
    settle("side-a", "home", 0);
    // side-b: 1 message, settled at T0+2h, the parent never spoke again within 24 h.
    turn("side-b", -1);
    kind("side-b", "side", "home");
    settle("side-b", "home", 2);
    // side-c: 2 messages, settled an hour before "now": still inside its window.
    turn("side-c", 20);
    turn("side-c", 25);
    kind("side-c", "side", "home");
    settle("side-c", "home", 29);
    // side-d: 1 message plus a refused follow-up and a wake with no text; never settled.
    turn("side-d", 0);
    kind("side-d", "side", "home");
    const refused = turn("side-d", 1);
    db.prepare("UPDATE tavi_admissions SET state = 'refused' WHERE admission_id = ?").run(refused);
    turn("side-d", 2, "  ");
    // A messaging conversation, a worker, an ordinary chat and a call naming no task.
    turn("dm", 0, "hi", "messaging");
    call("dm", "generation", "c-1", 400);
    turn("worker", 0);
    kind("worker", "worker");
    call("worker", "generation", "d-1", 70);
    call("worker", "evaluation", "d-2", 9);
    turn("plain", 0);
    call("router-1", "router", "r-1", 3);

    const measured = store.chatMeasurement({ now: at(30) });
    expect(measured.usageByChatKind.map((row) => row.kind)).toEqual(["home", "side", "messaging", "worker", "chat", "unattributed"]);
    const byKind = Object.fromEntries(measured.usageByChatKind.map((row) => [row.kind, row]));
    expect(byKind["home"]).toEqual({
      kind: "home",
      turns: 3,
      modelCalls: 5,
      generationCalls: 3,
      generationCallsWithoutUsage: 0,
      inputTokens: 600,
      inputTokensPerTurn: 200,
      summarizerCalls: { total: 2, compaction: 1, epochFlush: 1, taskSummary: 0, other: 0 },
      otherCalls: 0,
    });
    // side-d's three admissions: two that ran, one refused; the blank wake counts as a turn but not a message.
    expect(byKind["side"]).toMatchObject({
      turns: 8,
      modelCalls: 3,
      generationCalls: 2,
      generationCallsWithoutUsage: 1,
      inputTokens: 50,
      inputTokensPerTurn: 6,
      summarizerCalls: { total: 1, taskSummary: 1 },
    });
    expect(byKind["messaging"]).toMatchObject({ turns: 1, inputTokens: 400, inputTokensPerTurn: 400 });
    expect(byKind["worker"]).toMatchObject({ turns: 1, modelCalls: 2, inputTokens: 70, otherCalls: 1 });
    expect(byKind["chat"]).toMatchObject({ turns: 1, modelCalls: 0, inputTokensPerTurn: 0 });
    expect(byKind["unattributed"]).toMatchObject({ turns: 0, modelCalls: 1, otherCalls: 1, inputTokensPerTurn: null });

    expect(measured.sideChats).toEqual({
      created: 4,
      messages: { total: 7, average: 1.75, median: 1.5 },
      settled: 3,
      returned: 1,
      awaitingWindow: 1,
      returnToParentRate: 0.5,
      returnWindowHours: 24,
    });
    store.close();
  });

  it("reports nothing on an empty store, and a return outside the window is not one", () => {
    const { store, turn, kind, settle } = fixture();
    expect(store.chatMeasurement({ now: at(0) })).toEqual({
      usageByChatKind: [],
      promptCacheByChatKind: [],
      usageBySite: [],
      prefixChurn: { windowDays: 30, modelSwitches: 0, chatsWithModelSwitch: 0, folds: 0, chatsWithFold: 0 },
      sideChats: {
        created: 0,
        messages: { total: 0, average: null, median: null },
        settled: 0,
        returned: 0,
        awaitingWindow: 0,
        returnToParentRate: null,
        returnWindowHours: 24,
      },
    });
    turn("parent", -1);
    turn("side", 0);
    kind("side", "side", "parent");
    settle("side", "parent", 0);
    turn("parent", 25);
    expect(store.chatMeasurement({ now: at(48) }).sideChats).toMatchObject({
      settled: 1,
      returned: 0,
      awaitingWindow: 0,
      returnToParentRate: 0,
    });
    expect(store.chatMeasurement({ now: at(48), returnWindowHours: 26 }).sideChats).toMatchObject({
      returned: 1,
      returnToParentRate: 1,
      returnWindowHours: 26,
    });
    store.close();
  });

  it("reports the cache-read share of first and later steps and how often a turn's first call kept the previous turn's system text", () => {
    const { store, db, turn, kind } = fixture();
    let sequence = 0;
    /** A completed generation call as the ledger records it: `step` and `systemHash` in `data`. */
    const measured = (
      runId: string,
      minute: number,
      fields: { step?: number; systemHash?: string; inputTokens?: number; cacheRead?: number; state?: string },
    ) => {
      sequence += 1;
      const usage = {
        ...(fields.inputTokens === undefined ? {} : { inputTokens: fields.inputTokens }),
        ...(fields.cacheRead === undefined ? {} : { inputCacheReadTokens: fields.cacheRead }),
      };
      const data = {
        callId: `m-${sequence}`,
        runId,
        attemptId: `m-${sequence}`,
        purpose: "generation",
        usage,
        ...(fields.step === undefined ? {} : { step: fields.step }),
        ...(fields.systemHash === undefined ? {} : { systemHash: fields.systemHash }),
      };
      db.prepare(
        "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, input_tokens, data) VALUES (?, ?, ?, ?, ?, ?, 'generation', ?, ?)",
      ).run(
        `m-${sequence}`,
        runId,
        `m-${sequence}`,
        "session",
        fields.state ?? "completed",
        new Date(T0 + minute * 60_000).toISOString(),
        fields.inputTokens ?? null,
        JSON.stringify(data),
      );
    };
    turn("home", 0);
    kind("home", "home");
    // Four turns: the system text changes once (turn 3), so 2 of 3 comparisons match.
    measured("home", 1, { step: 1, systemHash: "aaaaaaaaaaaaaaaa", inputTokens: 1000, cacheRead: 0 });
    measured("home", 2, { step: 2, systemHash: "aaaaaaaaaaaaaaaa", inputTokens: 1200, cacheRead: 1000 });
    measured("home", 3, { step: 1, systemHash: "aaaaaaaaaaaaaaaa", inputTokens: 1400, cacheRead: 700 });
    // A failed first call and its retry: only the completed one counts.
    measured("home", 4, { step: 1, systemHash: "bbbbbbbbbbbbbbbb", inputTokens: 1600, cacheRead: 0, state: "failed" });
    measured("home", 5, { step: 1, systemHash: "bbbbbbbbbbbbbbbb", inputTokens: 1600, cacheRead: 0 });
    measured("home", 6, { step: 2, systemHash: "bbbbbbbbbbbbbbbb", inputTokens: 1800, cacheRead: 1600 });
    measured("home", 7, { step: 3, systemHash: "bbbbbbbbbbbbbbbb", inputTokens: 2000 });
    measured("home", 8, { step: 1, systemHash: "bbbbbbbbbbbbbbbb", inputTokens: 2000, cacheRead: 1000 });
    // An older call: no step, no hash — left out.
    measured("home", 0, { inputTokens: 9999, cacheRead: 9999 });
    // Another chat's first calls are never compared with Home's.
    turn("plain", 0);
    measured("plain", 1, { step: 1, systemHash: "cccccccccccccccc", inputTokens: 500, cacheRead: 250 });
    measured("plain", 2, { step: 1, systemHash: "cccccccccccccccc", inputTokens: 500 });

    expect(store.chatMeasurement({ now: at(1) }).promptCacheByChatKind).toEqual([
      {
        kind: "home",
        firstStep: { calls: 4, inputTokens: 6000, cacheReadTokens: 1700, share: 0.283 },
        laterSteps: { calls: 2, inputTokens: 3000, cacheReadTokens: 2600, share: 0.867 },
        callsWithoutCacheUsage: 1,
        firstStepPrefix: { turnsCompared: 3, sameAsPreviousTurn: 2, share: 0.667 },
      },
      {
        kind: "chat",
        firstStep: { calls: 1, inputTokens: 500, cacheReadTokens: 250, share: 0.5 },
        laterSteps: { calls: 0, inputTokens: 0, cacheReadTokens: 0, share: null },
        callsWithoutCacheUsage: 1,
        firstStepPrefix: { turnsCompared: 1, sameAsPreviousTurn: 1, share: 1 },
      },
    ]);
    store.close();
  });

  it("reports token use by call site over the window, and the model switches and folds that re-send a chat's prefix", () => {
    const { store, db } = fixture();
    let sequence = 0;
    /** A settled call as the ledger records it, `days` before the measurement. */
    const recorded = (fields: {
      runId?: string;
      site?: string;
      days?: number;
      minute?: number;
      purpose?: string;
      attemptId?: string;
      model?: string;
      step?: number;
      usage?: Record<string, unknown>;
      estimatedUsd?: number;
      state?: string;
    }) => {
      sequence += 1;
      const data = {
        callId: `s-${sequence}`,
        runId: fields.runId ?? "chat",
        attemptId: fields.attemptId ?? `s-${sequence}`,
        purpose: fields.purpose ?? "generation",
        connectionId: "openrouter",
        model: fields.model ?? "anthropic/claude-sonnet-5-5",
        usage: fields.usage ?? {},
        ...(fields.site === undefined ? {} : { site: fields.site }),
        ...(fields.step === undefined ? {} : { step: fields.step }),
        ...(fields.estimatedUsd === undefined ? {} : { estimatedUsd: fields.estimatedUsd }),
      };
      const startedAt = new Date(T0 - (fields.days ?? 1) * 86_400_000 + (fields.minute ?? 0) * 60_000).toISOString();
      db.prepare(
        "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, input_tokens, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        `s-${sequence}`,
        data.runId,
        data.attemptId,
        "session",
        fields.state ?? "completed",
        startedAt,
        data.purpose,
        (fields.usage?.["inputTokens"] as number | undefined) ?? null,
        JSON.stringify(data),
      );
    };
    recorded({
      site: "chat-stepN",
      step: 2,
      usage: { inputTokens: 1000, inputCacheReadTokens: 800, inputCacheWriteTokens: 100, outputTokens: 50, cacheUsageReported: true },
      estimatedUsd: 0.01,
    });
    recorded({
      site: "chat-stepN",
      step: 3,
      usage: { inputTokens: 1000, inputCacheReadTokens: 0, outputTokens: 30, outputReasoningTokens: 20, cacheUsageReported: false },
      estimatedUsd: 0.02,
    });
    recorded({ site: "find", purpose: "extraction", usage: { inputTokens: 300, outputTokens: 10 } });
    // No site recorded: an older attempt.
    recorded({ usage: { inputTokens: 50 } });
    // Outside the 30-day window: left out.
    recorded({ site: "find", purpose: "extraction", days: 31, usage: { inputTokens: 9999 } });

    // Turns' first calls: one switch of model in "chat", none in "other"; and two stage-2 folds in "chat".
    recorded({ runId: "chat", step: 1, minute: 1, site: "chat-step1" });
    recorded({ runId: "chat", step: 1, minute: 2, site: "chat-step1", model: "openai/gpt-5.6" });
    recorded({ runId: "other", step: 1, minute: 1, site: "chat-step1" });
    recorded({ runId: "other", step: 1, minute: 2, site: "chat-step1" });
    recorded({ runId: "chat", purpose: "summary", attemptId: "compaction-attempt-1", site: "compaction" });
    recorded({ runId: "chat", purpose: "summary", attemptId: "compaction-attempt-2", site: "compaction" });
    // A fold whose summary call failed rewrote nothing.
    recorded({ runId: "other", purpose: "summary", attemptId: "compaction-attempt-3", site: "compaction", state: "failed" });

    const measurement = store.chatMeasurement({ now: at(0) });
    expect(measurement.usageBySite.find((row) => row.site === "chat-stepN")).toEqual({
      site: "chat-stepN",
      calls: 2,
      callsWithoutUsage: 0,
      inputTokens: 2000,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      outputTokens: 80,
      reasoningTokens: 20,
      cacheUsageUnreported: 1,
      cacheReadShare: 0.4,
      estimatedUsd: 0.03,
    });
    expect(measurement.usageBySite.map((row) => row.site)).toEqual(["chat-stepN", "find", "unlabelled", "chat-step1", "compaction"]);
    expect(measurement.usageBySite.find((row) => row.site === "find")).toMatchObject({ calls: 1, inputTokens: 300, estimatedUsd: null });
    expect(measurement.usageBySite.find((row) => row.site === "chat-step1")).toMatchObject({ calls: 4, callsWithoutUsage: 4 });
    expect(measurement.usageBySite.find((row) => row.site === "compaction")).toMatchObject({ calls: 3 });
    expect(measurement.prefixChurn).toEqual({ windowDays: 30, modelSwitches: 1, chatsWithModelSwitch: 1, folds: 2, chatsWithFold: 1 });
    store.close();
  });
});
