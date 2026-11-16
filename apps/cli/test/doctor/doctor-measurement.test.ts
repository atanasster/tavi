import type { ChatMeasurement } from "@tavi/runtime";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { SqliteStore } from "../support/database-fixture.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * `tavi doctor`'s local measurement:
 * per-turn input tokens and summarizer calls by chat kind, and side chats
 * created, messages per side chat and the return-to-parent rate — read from
 * the directory's own rows, the same from an offline doctor and an attached one.
 */

const owners = useAttachedOwners("tavi-doctor-measure-");

async function doctorMeasurement(directory: string): Promise<ChatMeasurement> {
  const out = capture();
  expect(await main(["doctor", "--data-dir", directory], { io: out.io }), out.stderr()).toBe(EXIT.ok);
  return (JSON.parse(out.stdout()) as { chatMeasurement: ChatMeasurement }).chatMeasurement;
}

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

async function seed(directory: string): Promise<void> {
  const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
  const { tasks } = store.asPort().repositories;
  const db = store.handle;
  let sequence = 0;
  const turn = async (taskId: string, at: string) => {
    sequence += 1;
    const admissionId = `adm-${sequence}`;
    const first = db.prepare("SELECT 1 FROM tavi_tasks WHERE task_id = ?").get(taskId) === undefined;
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: `op-${sequence}`,
      kind: first ? "start" : "reply",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      ...(first ? {} : { taskId }),
      now: at,
      newTaskId: taskId,
      newAdmissionId: admissionId,
      newThreadId: `thread-${taskId}`,
    });
    db.prepare("UPDATE tavi_admissions SET state = 'committed', created_at = ? WHERE admission_id = ?").run(at, admissionId);
  };
  const call = (runId: string, purpose: string, attemptId: string, inputTokens: number) => {
    sequence += 1;
    db.prepare(
      "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, input_tokens, data) VALUES (?, ?, ?, 'session', 'completed', ?, ?, ?, ?)",
    ).run(
      `call-${sequence}`,
      runId,
      attemptId,
      hoursAgo(50),
      purpose,
      inputTokens,
      JSON.stringify({ runId, attemptId, purpose, usage: { inputTokens, outputTokens: 1 } }),
    );
  };
  const settle = (sideId: string, at: string) =>
    db
      .prepare(
        "INSERT INTO tavi_chat_notices (notice_id, task_id, source_key, kind, source_task_id, title, summary, after_seq, read_by, created_at) VALUES (?, 'home', ?, 'side-chat-settled', ?, 't', 's', 0, NULL, ?)",
      )
      .run(`notice-${sideId}`, `side-chat:${sideId}`, sideId, at);
  try {
    await turn("home", hoursAgo(60));
    db.prepare("UPDATE tavi_tasks SET chat_kind = 'home' WHERE task_id = 'home'").run();
    call("home", "generation", "g-1", 1000);
    call("home", "generation", "g-2", 3000);
    call("home", "summary", "compaction-attempt-1", 9000);
    call("home", "summary", "epoch-flush-attempt-2", 8000);
    for (const side of ["side-a", "side-b", "side-c"]) {
      await turn(side, hoursAgo(55));
      db.prepare("UPDATE tavi_tasks SET chat_kind = 'side', parent_chat_id = 'home' WHERE task_id = ?").run(side);
    }
    await turn("side-a", hoursAgo(54));
    await turn("side-a", hoursAgo(53));
    call("side-a", "generation", "g-3", 500);
    // side-a settled 50 h ago and the person came back to Home an hour later; side-b's
    // notice went unanswered for its whole window; side-c's settled an hour ago.
    settle("side-a", hoursAgo(50));
    settle("side-b", hoursAgo(40));
    settle("side-c", hoursAgo(1));
    await turn("home", hoursAgo(49));
  } finally {
    await store.close();
  }
}

describe("tavi doctor: local measurement", ATTACHED, () => {
  it("reports model use by chat kind and side-chat use", async () => {
    const directory = owners.tempDirectory();
    await seed(directory);
    const measured = await doctorMeasurement(directory);
    expect(measured.usageByChatKind).toEqual([
      {
        kind: "home",
        turns: 2,
        modelCalls: 4,
        generationCalls: 2,
        generationCallsWithoutUsage: 0,
        inputTokens: 4000,
        inputTokensPerTurn: 2000,
        summarizerCalls: { total: 2, compaction: 1, epochFlush: 1, taskSummary: 0, other: 0 },
        otherCalls: 0,
      },
      {
        kind: "side",
        turns: 5,
        modelCalls: 1,
        generationCalls: 1,
        generationCallsWithoutUsage: 0,
        inputTokens: 500,
        inputTokensPerTurn: 100,
        summarizerCalls: { total: 0, compaction: 0, epochFlush: 0, taskSummary: 0, other: 0 },
        otherCalls: 0,
      },
    ]);
    // Calls recorded without a turn step are left out of the cache measurement.
    expect(measured.promptCacheByChatKind).toEqual([]);
    expect(measured.sideChats).toEqual({
      created: 3,
      messages: { total: 5, average: 1.667, median: 1 },
      settled: 3,
      returned: 1,
      awaitingWindow: 1,
      returnToParentRate: 0.5,
      returnWindowHours: 24,
    });
  });

  it("an attached doctor reports the same measurement", async () => {
    const directory = owners.tempDirectory();
    await seed(directory);
    const offline = await doctorMeasurement(directory);
    await owners.startOwner(turns([]), { directory });
    expect(await doctorMeasurement(directory)).toEqual(offline);
  });
});
