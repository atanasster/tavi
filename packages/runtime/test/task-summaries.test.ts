import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Task titles and summaries: the
 * triggers that queue a finished or continued task, what the summarizer reads,
 * the compare-and-set that records its answer, the backfill, and the list.
 */

const AT = "2026-09-20T00:00:00.000Z";

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const { tasks, taskSummaries } = store.asPort().repositories;
  const add = (id: string, prompt = `Prompt ${id}\nSecond line`, at = AT) =>
    tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: id,
      kind: "start",
      intent: { prompt },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => at,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${id}`,
    });
  const reply = (id: string, key: string, prompt: string) =>
    tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      taskId: id,
      operationKey: key,
      kind: "reply",
      intent: { prompt },
      checkpointNamespace: "",
      now: () => AT,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${key}`,
    });
  const settle = (id: string) => store.handle.prepare("UPDATE tavi_admissions SET state = 'committed' WHERE task_id = ?").run(id);
  const state = (id: string) =>
    store.handle.prepare("SELECT summary_state, title, summary FROM tavi_tasks WHERE task_id = ?").get(id) as {
      summary_state: string | null;
      title: string | null;
      summary: string | null;
    };
  return { store, tasks, taskSummaries, add, reply, settle, state };
}

describe("the summary queue", () => {
  it("marks a heartbeat tick's work as such, so the summarizer skips it with no model call (principle 9)", () => {
    const { store, tasks, taskSummaries, add, settle } = fixture();
    try {
      add("chat");
      add("tick");
      store.handle.prepare("UPDATE tavi_tasks SET origin = 'heartbeat' WHERE task_id = 'tick'").run();
      for (const id of ["chat", "tick"]) {
        settle(id);
        tasks.updateStatus(id, "completed", "done");
      }
      const work = taskSummaries.pending(5);
      expect(work.find((item) => item.taskId === "tick")?.heartbeat).toBe(true);
      expect(work.find((item) => item.taskId === "chat")?.heartbeat).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("queues a task when it finishes, reads its text and model, and records the answer", () => {
    const { store, tasks, taskSummaries, add, settle, state } = fixture();
    try {
      add("t1");
      // Pending from its admission, but running: not work yet.
      expect(state("t1").summary_state).toBe("pending");
      expect(tasks.get("t1")).toMatchObject({ title: null, summary: null, summaryState: "pending" });
      expect(taskSummaries.pending(5)).toEqual([]);
      settle("t1");
      tasks.updateStatus("t1", "completed", "Here is the plan");
      store.handle
        .prepare(
          "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, data) VALUES ('c1','t1','a1','s','completed',?,'generation',?)",
        )
        .run(AT, JSON.stringify({ connectionId: "ollama", model: "llama3", purpose: "generation" }));
      store.handle
        .prepare(
          "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, data) VALUES ('c2','t1','a2','s','completed','2026-09-21T00:00:00.000Z','summary',?)",
        )
        .run(JSON.stringify({ connectionId: "cloud", model: "big", purpose: "summary" }));
      const [work] = taskSummaries.pending(5);
      expect(work).toMatchObject({
        taskId: "t1",
        status: "completed",
        prompt: "Prompt t1\nSecond line",
        followUps: [],
        finalText: "Here is the plan",
        error: null,
        delegated: false,
        target: { connectionId: "ollama", model: "llama3" },
      });
      expect(
        taskSummaries.record({
          taskId: "t1",
          expectedUpdatedAt: work?.updatedAt ?? "",
          state: "done",
          title: "Plan the week",
          summary: "Wrote the plan",
          now: AT,
        }),
      ).toBe(true);
      expect(state("t1")).toEqual({ summary_state: "done", title: "Plan the week", summary: "Wrote the plan" });
      // The task record carries them too (`tavi tasks`, a reminder's chat title).
      expect(tasks.get("t1")).toMatchObject({ title: "Plan the week", summary: "Wrote the plan", summaryState: "done" });
      expect(taskSummaries.pending(5)).toEqual([]);
      // A second record finds nothing pending.
      expect(taskSummaries.record({ taskId: "t1", expectedUpdatedAt: work?.updatedAt ?? "", state: "failed", now: AT })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("is queued again by a follow-up, not summarized mid-run, and keeps the old text meanwhile", () => {
    const { store, tasks, taskSummaries, add, reply, settle, state } = fixture();
    try {
      add("t1");
      settle("t1");
      tasks.updateStatus("t1", "completed", "First answer");
      const [first] = taskSummaries.pending(5);
      taskSummaries.record({
        taskId: "t1",
        expectedUpdatedAt: first?.updatedAt ?? "",
        state: "done",
        title: "First",
        summary: "First summary",
        now: AT,
      });
      reply("t1", "r1", "Now make it shorter");
      expect(state("t1")).toEqual({ summary_state: "pending", title: "First", summary: "First summary" });
      // Still `completed` while the follow-up runs, so the running admission is what holds it back.
      expect(taskSummaries.pending(5)).toEqual([]);
      settle("t1");
      store.handle
        .prepare("UPDATE tavi_tasks SET final_text = 'Shorter answer', updated_at = '2026-09-22T00:00:00.000Z' WHERE task_id = 't1'")
        .run();
      const [again] = taskSummaries.pending(5);
      expect(again).toMatchObject({ followUps: ["Now make it shorter"], finalText: "Shorter answer", title: "First" });
    } finally {
      store.close();
    }
  });

  it("keeps a chat's first title as its summary follows it, stores what the summary was written from, and keeps both unasked", () => {
    const { store, tasks, taskSummaries, add, reply, settle, state } = fixture();
    const hash = (char: string) => char.repeat(64);
    try {
      add("t1");
      settle("t1");
      tasks.updateStatus("t1", "completed", "First answer");
      const [first] = taskSummaries.pending(5);
      taskSummaries.record({
        taskId: "t1",
        expectedUpdatedAt: first?.updatedAt ?? "",
        state: "done",
        title: "First",
        summary: "One",
        inputHash: hash("a"),
        now: AT,
      });
      reply("t1", "r1", "More");
      settle("t1");
      const [second] = taskSummaries.pending(5);
      expect(second).toMatchObject({ title: "First", inputHash: hash("a") });
      taskSummaries.record({
        taskId: "t1",
        expectedUpdatedAt: second?.updatedAt ?? "",
        state: "done",
        title: "Second",
        summary: "Two",
        inputHash: hash("b"),
        now: AT,
      });
      expect(state("t1")).toEqual({ summary_state: "done", title: "First", summary: "Two" });
      reply("t1", "r2", "Again");
      settle("t1");
      const [third] = taskSummaries.pending(5);
      expect(
        taskSummaries.record({ taskId: "t1", expectedUpdatedAt: third?.updatedAt ?? "", state: "done", unchanged: true, now: AT }),
      ).toBe(true);
      expect(state("t1")).toEqual({ summary_state: "done", title: "First", summary: "Two" });
    } finally {
      store.close();
    }
  });

  it("names the latest attempt's connection whatever its state, and every connection the task used", () => {
    const { store, tasks, taskSummaries, add, settle } = fixture();
    try {
      add("t1");
      settle("t1");
      tasks.updateStatus("t1", "failed", null);
      // A completed first turn in the cloud, then a follow-up on a local model that failed.
      store.handle
        .prepare(
          "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, data) VALUES ('c1','t1','a1','s','completed','2026-09-20T00:00:00.000Z','generation',?)",
        )
        .run(JSON.stringify({ connectionId: "cloud", model: "big", purpose: "generation" }));
      store.handle
        .prepare(
          "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, purpose, data) VALUES ('c2','t1','a2','s','failed','2026-09-21T00:00:00.000Z','generation',?)",
        )
        .run(JSON.stringify({ connectionId: "ollama", model: "llama3", purpose: "generation" }));
      const [work] = taskSummaries.pending(5);
      expect(work?.target).toEqual({ connectionId: "ollama", model: "llama3" });
      expect([...(work?.usedConnections ?? [])].sort()).toEqual(["cloud", "ollama"]);
    } finally {
      store.close();
    }
  });

  it("passes over the tasks it is told to exclude", () => {
    const { tasks, taskSummaries, add, settle, store } = fixture();
    try {
      for (const id of ["a", "b"]) {
        add(id);
        settle(id);
        tasks.updateStatus(id, "completed", "ok");
      }
      expect(taskSummaries.pending(5, ["a"]).map((entry) => entry.taskId)).toEqual(["b"]);
    } finally {
      store.close();
    }
  });

  it("is not queued again by an admission that changes nothing, or on a cancelled task", () => {
    const { store, tasks, taskSummaries, add, settle, state } = fixture();
    try {
      for (const id of ["done", "cancelled"]) {
        add(id);
        settle(id);
        tasks.updateStatus(id, id === "done" ? "completed" : "cancelled", null);
      }
      for (const work of taskSummaries.pending(5))
        taskSummaries.record({ taskId: work.taskId, expectedUpdatedAt: work.updatedAt, state: "done", title: "T", now: AT });
      const admission = store.handle.prepare(
        "INSERT INTO tavi_admissions (admission_id, task_id, operation_key, kind, intent, intent_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 'h', 'refused', ?, ?)",
      );
      admission.run("approval-1", "done", "approval-1", "approval", AT, AT);
      admission.run("deadline-1", "done", "deadline-1", "deadline", AT, AT);
      admission.run("reply-1", "cancelled", "reply-1", "reply", AT, AT);
      expect(state("done").summary_state).toBe("done");
      expect(state("cancelled").summary_state).toBe("done");
    } finally {
      store.close();
    }
  });

  it("leaves a task that changed since it was read pending", () => {
    const { store, tasks, taskSummaries, add, settle, state } = fixture();
    try {
      add("t1");
      settle("t1");
      tasks.updateStatus("t1", "failed", null);
      const [work] = taskSummaries.pending(5);
      store.handle.prepare("UPDATE tavi_tasks SET updated_at = '2026-09-23T00:00:00.000Z' WHERE task_id = 't1'").run();
      expect(taskSummaries.record({ taskId: "t1", expectedUpdatedAt: work?.updatedAt ?? "", state: "done", title: "Stale", now: AT })).toBe(
        false,
      );
      expect(state("t1").summary_state).toBe("pending");
    } finally {
      store.close();
    }
  });

  it("reads why a failed task failed, and a cancelled task whatever its admissions say", () => {
    const { store, tasks, taskSummaries, add } = fixture();
    try {
      add("failed");
      store.handle
        .prepare("UPDATE tavi_admissions SET state = 'failed', result = ? WHERE task_id = 'failed'")
        .run(JSON.stringify({ status: "failed", finalText: "", error: { code: "MODEL_FAILED", message: "rate limited" } }));
      tasks.updateStatus("failed", "failed", null);
      add("cancelled");
      tasks.updateStatus("cancelled", "cancelled", null);
      const work = [...taskSummaries.pending(5)].sort((left, right) => left.taskId.localeCompare(right.taskId));
      expect(work.map((entry) => [entry.taskId, entry.status, entry.error])).toEqual([
        ["cancelled", "cancelled", null],
        ["failed", "failed", "rate limited"],
      ]);
      expect(work[1]?.target).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("tasks list with summaries", () => {
  it("shows the generated title and summary, says where the title came from, and searches both", () => {
    const { store, tasks, taskSummaries, add, settle } = fixture();
    try {
      add("t1", "please look at the seo stuff we talked about");
      add("t2");
      settle("t1");
      tasks.updateStatus("t1", "completed", "Delivered the roadmap");
      const [work] = taskSummaries.pending(5);
      taskSummaries.record({
        taskId: "t1",
        expectedUpdatedAt: work?.updatedAt ?? "",
        state: "done",
        title: "Finish the SEO action plan",
        summary: "Delivered the 90-day SEO roadmap",
        now: AT,
      });
      const rows = store.listTaskSessions({ workspaceId: "default" }).rows;
      expect(rows.find((row) => row.taskId === "t1")).toMatchObject({
        title: "Finish the SEO action plan",
        titleSource: "generated",
        summary: "Delivered the 90-day SEO roadmap",
        summaryState: "done",
        promptPreview: "please look at the seo stuff we talked about",
      });
      expect(rows.find((row) => row.taskId === "t2")).toMatchObject({
        title: "Prompt t2",
        titleSource: "prompt",
        summary: null,
        summaryState: "pending",
      });
      expect(store.listTaskSessions({ query: "action plan" }).rows.map((row) => row.taskId)).toEqual(["t1"]);
      expect(store.listTaskSessions({ query: "90-DAY" }).rows.map((row) => row.taskId)).toEqual(["t1"]);
    } finally {
      store.close();
    }
  });
});
