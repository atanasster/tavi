import { describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../src/persistence/store.js";
import {
  reminderTaskOperationKey,
  TASK_CHANNEL_KINDS,
  TASK_NEEDS_LIMIT,
  TASK_PROMPT_TEXT_MAX,
  TASK_PROMPTS_LIMIT,
  type TaskOrigin,
} from "@tavi/contracts";

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const tasks = store.asPort().repositories.tasks;
  const add = (id: string, workspaceId = "default", at = "2026-09-20T00:00:00.000Z") =>
    tasks.admit({
      workspaceId,
      principalId: "operator",
      operationKey: id,
      kind: "start",
      intent: { prompt: `Prompt ${id}\nSecond line` },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => at,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${id}`,
    });
  return { store, tasks, add };
}

describe("durable session list", () => {
  it("never lists a heartbeat tick, whatever the filters, nor counts it in the Center (principle 9)", () => {
    const { store, tasks, add } = fixture();
    try {
      add("chat");
      tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: "tick",
        kind: "start",
        intent: { prompt: "heartbeat check" },
        checkpointNamespace: "",
        origin: "heartbeat",
        now: () => "2026-09-20T00:00:00.000Z",
        newTaskId: () => "tick",
        newThreadId: () => "thread-tick",
        newAdmissionId: () => "admission-tick",
      });
      expect(store.listTaskSessions({ workspaceId: "default" }).rows.map((row) => row.taskId)).toEqual(["chat"]);
      expect(store.listTaskSessions({ workspaceId: "default", origin: ["heartbeat"] }).rows).toEqual([]);
      expect(
        store.listTaskSessions({ workspaceId: "default", includeDelegated: true, order: "created" }).rows.map((row) => row.taskId),
      ).toEqual(["chat"]);
      const summary = store.asPort().repositories.center.summary({
        workspaceId: "default",
        principalId: "operator",
        timezone: "UTC",
        days: 7,
        now: "2026-09-20T12:00:00.000Z",
      });
      expect(summary.counts.runningTasks).toBe(1);
      expect(summary.perDay.reduce((total, day) => total + day.tasks, 0)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("never lists an idea's prepared step either: plumbing, not a chat", () => {
    const { store, tasks, add } = fixture();
    try {
      add("chat");
      tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: "prep",
        kind: "start",
        intent: { prompt: "Find flights" },
        checkpointNamespace: "",
        origin: "ideas",
        now: () => "2026-09-20T00:00:00.000Z",
        newTaskId: () => "prep",
        newThreadId: () => "thread-prep",
        newAdmissionId: () => "admission-prep",
      });
      expect(store.listTaskSessions({ workspaceId: "default" }).rows.map((row) => row.taskId)).toEqual(["chat"]);
      expect(store.listTaskSessions({ workspaceId: "default", origin: ["ideas"] }).rows).toEqual([]);
      const summary = store.asPort().repositories.center.summary({
        workspaceId: "default",
        principalId: "operator",
        timezone: "UTC",
        days: 7,
        now: "2026-09-20T12:00:00.000Z",
      });
      expect(summary.counts.runningTasks).toBe(1);
    } finally {
      store.close();
    }
  });

  it("lists a chat the person stopped as stopped, a resumable status of its own, and a real failure as failed", () => {
    const { store, tasks, add } = fixture();
    try {
      const ended = (id: string, code: string) => {
        add(id);
        tasks.commitAdmission({
          admissionId: `admission-${id}`,
          taskId: id,
          state: "failed",
          result: { status: "failed", finalText: "", error: { code, message: "ended" } },
        });
      };
      add("stopped");
      tasks.commitAdmission({
        admissionId: "admission-stopped",
        taskId: "stopped",
        state: "committed",
        result: { status: "stopped", finalText: "You stopped this.", error: { code: "STOPPED", message: "You stopped this." } },
      });
      ended("broke", "MODEL_FAILED");
      ended("shutdown", "ABORTED");
      const status = (filter?: "stopped") =>
        Object.fromEntries(
          store
            .listTaskSessions({ workspaceId: "default", ...(filter === undefined ? {} : { status: [filter] }) })
            .rows.map((row) => [row.taskId, row.status]),
        );
      expect(status()).toEqual({ stopped: "stopped", broke: "failed", shutdown: "failed" });
      expect(status("stopped")).toEqual({ stopped: "stopped" });
      expect(tasks.get("stopped")?.status).toBe("stopped");
      // Not `cancelled`, which is final: a stopped chat's summary is queued as any ending's, and a later cancel still wins.
      expect(tasks.get("stopped")?.summaryState).toBe("pending");
      tasks.updateStatus("stopped", "cancelled", null);
      tasks.commitAdmission({
        admissionId: "admission-stopped",
        taskId: "stopped",
        state: "committed",
        result: { status: "stopped", finalText: "You stopped this.", error: { code: "STOPPED", message: "You stopped this." } },
      });
      expect(tasks.get("stopped")?.status).toBe("cancelled");
    } finally {
      store.close();
    }
  });

  it("pages ties without duplicates, projects bounded text, and rejects a cursor from another scope", () => {
    const { store, tasks, add } = fixture();
    try {
      for (let i = 0; i < 8; i++) add(`t${i}`);
      add("other", "other");
      tasks.updateStatus("t7", "completed", "final needle");
      const first = store.listTaskSessions({ workspaceId: "default", limit: 3 });
      expect(first.rows).toHaveLength(3);
      const second = store.listTaskSessions({ workspaceId: "default", limit: 3, cursor: first.nextCursor! });
      expect(new Set([...first.rows, ...second.rows].map((row) => row.taskId)).size).toBe(6);
      expect(() => store.listTaskSessions({ workspaceId: "other", cursor: first.nextCursor! })).toThrow(/cursor/);
      expect(store.listTaskSessions({ query: "needle" }).rows.map((row) => row.taskId)).toEqual(["t7"]);
      expect(store.listTaskSessions({ status: ["completed"], origin: ["ipc"] }).rows[0]).toMatchObject({
        title: "Prompt t7",
        lastText: "final needle",
        counts: { admissions: 1, tools: 0 },
      });
      expect(() => store.listTaskSessions({ cursor: "malformed" })).toThrow(/cursor/);
    } finally {
      store.close();
    }
  });
  it("finds old questions beyond a full page and ignores an inbox cursor and limit", () => {
    const { store, add } = fixture();
    try {
      for (let i = 0; i < 60; i++) add(`new${i}`);
      add("old", "default", "2025-01-01T00:00:00.000Z");
      add("other-pending", "other");
      store.handle
        .prepare(
          "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state) VALUES('other-artifact','other','other-pending','other','text/plain',1,'hash','2026-09-20T00:00:00.000Z','pending')",
        )
        .run();
      expect(store.listTaskSessions({ workspaceId: "default", needs: ["review"] }).rows).toEqual([]);
      expect(store.listTaskSessions({ workspaceId: "other", needs: ["review"] }).rows.map((row) => row.taskId)).toEqual(["other-pending"]);
      const wait = { waitId: "w", deadlineAt: "2099-01-01T00:00:00.000Z" };
      store.handle
        .prepare("INSERT INTO tavi_agent_wait_intents(wait_id, task_id, deadline_at, state) VALUES (?, ?, ?, 'active')")
        .run("w", "old", wait.deadlineAt);
      store.handle
        .prepare("UPDATE tavi_admissions SET result=?, state='committed' WHERE task_id='old'")
        .run(JSON.stringify({ status: "waiting", waitInterrupt: { wait, question: "Which?" } }));
      expect(store.listTaskSessions({ limit: 50 }).rows.some((row) => row.taskId === "old")).toBe(false);
      const inbox = store.listTaskSessions({ workspaceId: "default", needs: ["question"], limit: 1, cursor: "ignored" });
      expect(inbox.rows.map((row) => row.taskId)).toEqual(["old"]);
      expect(inbox.rows[0]?.needs).toEqual(["question"]);
      expect(inbox.nextCursor).toBeUndefined();
      store.handle
        .prepare(
          "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state) VALUES('artifact','default','old','a','text/plain',1,'hash','2026-09-20T00:00:00.000Z','pending')",
        )
        .run();
      expect(store.listTaskSessions({ needs: ["question"] }).rows[0]?.needs).toEqual(["review", "question"]);
      store.handle.prepare("UPDATE tavi_agent_wait_intents SET state='settled' WHERE wait_id='w'").run();
      expect(store.listTaskSessions({ needs: ["question"] }).rows).toEqual([]);
      expect(store.listTaskSessions({ workspaceId: "default", needs: ["review"] }).rows[0]?.taskId).toBe("old");
      expect(store.listTaskSessions({ workspaceId: "other", needs: ["question"] }).rows).toEqual([]);
      // A browser handoff is a need of its own, not a question to answer.
      store.handle
        .prepare("INSERT INTO tavi_agent_wait_intents(wait_id, task_id, deadline_at, state, handoff_json) VALUES (?, ?, ?, 'active', ?)")
        .run("h", "new0", wait.deadlineAt, JSON.stringify({ sessionId: "6f1d2c3b-0000-4000-8000-000000000001", reason: "sign-in" }));
      store.handle.prepare("UPDATE tavi_admissions SET result=?, state='committed' WHERE task_id='new0'").run(
        JSON.stringify({
          status: "waiting",
          waitInterrupt: {
            wait: { waitId: "h", deadlineAt: wait.deadlineAt },
            handoff: { sessionId: "6f1d2c3b-0000-4000-8000-000000000001", reason: "sign-in" },
          },
        }),
      );
      expect(store.listTaskSessions({ workspaceId: "default", needs: ["handoff"] }).rows.map((row) => [row.taskId, row.needs])).toEqual([
        ["new0", ["handoff"]],
      ]);
      expect(store.listTaskSessions({ workspaceId: "default", needs: ["question"] }).rows).toEqual([]);
    } finally {
      store.close();
    }
  });
  it("caps needs independently and counts calls idempotently without inventing old totals", () => {
    const { store, tasks, add } = fixture();
    try {
      for (let i = 0; i <= TASK_NEEDS_LIMIT; i++) {
        const id = `t${i}`;
        add(id);
        store.handle
          .prepare(
            "INSERT INTO tavi_approvals(approval_id,task_id,admission_id,tool_id,call_id,steps,inputs,inputs_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,1,'{}','hash','pending',?,?)",
          )
          .run(`a${i}`, id, `admission-${id}`, "read", "c", "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
      }
      const inbox = store.listTaskSessions({ needs: ["approval"], limit: 1 });
      expect(inbox.rows).toHaveLength(TASK_NEEDS_LIMIT);
      expect(inbox.truncated).toBe(true);
      tasks.recordToolCall("t0", 1, "c");
      tasks.recordToolCall("t0", 1, "c");
      tasks.recordToolCall("t0", 2, "c");
      expect(store.listTaskSessions({ query: "Prompt t0" }).rows[0]?.counts.tools).toBe(2);
      store.handle.prepare("UPDATE tavi_tasks SET tool_count=NULL WHERE task_id='t0'").run();
      tasks.recordToolCall("t0", 3, "c");
      expect(store.listTaskSessions({ query: "Prompt t0" }).rows[0]?.counts.tools).toBeNull();
    } finally {
      store.close();
    }
  });
});

it("hoists descendant needs beyond loaded rows, isolates workspaces, and terminates cycles", () => {
  const { store, add } = fixture();
  try {
    for (const id of ["root", "child", "leaf"]) add(id);
    add("foreign", "other");
    const repo = store.asPort().repositories.agentDelegations;
    for (const [workerTaskId, parentTaskId] of [
      ["leaf", "child"],
      ["child", "root"],
      ["root", "leaf"],
      ["foreign", "root"],
    ]) {
      repo.recordSpawn({
        operationKey: workerTaskId!,
        workspaceId: workerTaskId === "foreign" ? "other" : "default",
        principalId: "operator",
        workerTaskId: workerTaskId!,
        workerAgentId: `agent-${workerTaskId}`,
        parentTaskId: parentTaskId!,
        rootTaskId: "root",
        depth: 1,
        createdAt: "2026-09-20T00:00:00.000Z",
      });
    }
    const insert = store.handle.prepare(
      "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state) VALUES(?,?,?,'a','text/plain',1,'hash','2026-09-20T00:00:00.000Z','pending')",
    );
    insert.run("a", "default", "leaf");
    insert.run("b", "other", "foreign");
    expect(store.taskNeeds("default", ["root"])).toEqual({ root: ["review"] });
    // The cycle makes `root` a worker too, so only the flat list shows its row.
    expect(store.listTaskSessions({ query: "Prompt root", limit: 1, includeDelegated: true }).rows[0]).toMatchObject({
      needs: ["review"],
      ownNeeds: [],
      descendantNeeds: ["review"],
    });
    // The inbox's own needs: only the worker that asked carries the review as its own.
    const inbox = store.listTaskSessions({ workspaceId: "default", needs: ["review"] }).rows;
    expect(Object.fromEntries(inbox.map((row) => [row.taskId, row.ownNeeds]))).toEqual({ leaf: ["review"], child: [], root: [] });
    expect(
      store
        .listTaskSessions({ workspaceId: "default", needs: ["review"] })
        .rows.map((row) => row.taskId)
        .sort(),
    ).toEqual(["child", "leaf", "root"]);
    store.handle.prepare("UPDATE tavi_artifacts SET review_state='approved' WHERE artifact_id='a'").run();
    expect(store.taskNeeds("default", ["root", "child", "leaf", "foreign"])).toEqual({});
  } finally {
    store.close();
  }
});

describe("delegated nesting and creation order", () => {
  it("nests workers under their root, counts them, and flattens them on request", () => {
    const { store, add } = fixture();
    try {
      for (const id of ["root", "child", "leaf", "legacy-parent", "legacy-worker"]) add(id);
      add("foreign-worker", "other");
      const repo = store.asPort().repositories.agentDelegations;
      const spawn = (workerTaskId: string, parentTaskId: string, rootTaskId: string | undefined, workspaceId = "default") =>
        repo.recordSpawn({
          operationKey: workerTaskId,
          workspaceId,
          principalId: "operator",
          workerTaskId,
          workerAgentId: `agent-${workerTaskId}`,
          parentTaskId,
          ...(rootTaskId === undefined ? {} : { rootTaskId }),
          depth: 1,
          createdAt: "2026-09-20T00:00:00.000Z",
        });
      spawn("child", "root", "root");
      spawn("leaf", "child", "root");
      spawn("legacy-worker", "legacy-parent", undefined);
      // A worker in another workspace naming this root is not this root's.
      spawn("foreign-worker", "root", "root", "other");

      const nested = store.listTaskSessions({ workspaceId: "default" });
      expect(nested.rows.map((row) => row.taskId).sort()).toEqual(["legacy-parent", "root"]);
      expect(nested.rows.find((row) => row.taskId === "root")).toMatchObject({ delegated: 2, principalId: "operator" });
      expect(nested.rows.find((row) => row.taskId === "root")?.rootTaskId).toBeUndefined();
      // Without a root the parent is the anchor.
      expect(nested.rows.find((row) => row.taskId === "legacy-parent")?.delegated).toBe(1);

      const flat = store.listTaskSessions({ workspaceId: "default", includeDelegated: true });
      expect(flat.rows).toHaveLength(5);
      expect(flat.rows.find((row) => row.taskId === "leaf")).toMatchObject({ rootTaskId: "root", delegated: 0 });
      expect(flat.rows.find((row) => row.taskId === "legacy-worker")?.rootTaskId).toBe("legacy-parent");
      // A cursor from the nested list is not one for the flat list.
      const page = store.listTaskSessions({ workspaceId: "default", limit: 1 });
      expect(() => store.listTaskSessions({ workspaceId: "default", limit: 1, includeDelegated: true, cursor: page.nextCursor! })).toThrow(
        /cursor/,
      );
    } finally {
      store.close();
    }
  });

  it("orders by creation with its own keyset and bounds since/until on created_at", () => {
    const { store, tasks, add } = fixture();
    try {
      add("old", "default", "2026-09-01T00:00:00.000Z");
      add("mid-a", "default", "2026-09-10T00:00:00.000Z");
      add("mid-b", "default", "2026-09-10T00:00:00.000Z");
      add("new", "default", "2026-09-20T00:00:00.000Z");
      // Touched last, so first by `updated` but still oldest by `created`.
      tasks.updateStatus("old", "completed", "done");

      expect(store.listTaskSessions({ workspaceId: "default" }).rows[0]?.taskId).toBe("old");
      const first = store.listTaskSessions({ workspaceId: "default", order: "created", limit: 2 });
      expect(first.rows.map((row) => row.taskId)).toEqual(["new", "mid-b"]);
      const second = store.listTaskSessions({ workspaceId: "default", order: "created", limit: 2, cursor: first.nextCursor! });
      expect(second.rows.map((row) => row.taskId)).toEqual(["mid-a", "old"]);
      expect(second.nextCursor).toBeUndefined();
      // A cursor belongs to its order.
      expect(() => store.listTaskSessions({ workspaceId: "default", limit: 2, cursor: first.nextCursor! })).toThrow(/cursor/);
      const updatedPage = store.listTaskSessions({ workspaceId: "default", limit: 2 });
      expect(() => store.listTaskSessions({ workspaceId: "default", order: "created", limit: 2, cursor: updatedPage.nextCursor! })).toThrow(
        /cursor/,
      );

      // `old` was updated today, but it was created on the 1st.
      const window = store.listTaskSessions({
        workspaceId: "default",
        order: "created",
        since: "2026-09-05T00:00:00.000Z",
        until: "2026-09-15T00:00:00.000Z",
      });
      expect(window.rows.map((row) => row.taskId)).toEqual(["mid-b", "mid-a"]);
    } finally {
      store.close();
    }
  });
});

describe("where a task came from, and its follow-ups", () => {
  const T = "2026-09-20T00:00:00.000Z";
  function channels() {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    let tick = 0;
    const at = () => new Date(Date.parse(T) + tick++ * 1000).toISOString();
    const add = (
      id: string,
      origin: TaskOrigin | undefined,
      extra: { operationKey?: string; originScheduleId?: string; workspaceId?: string } = {},
    ) => {
      const now = at();
      tasks.admit({
        workspaceId: extra.workspaceId ?? "default",
        principalId: "operator",
        operationKey: extra.operationKey ?? id,
        kind: "start",
        intent: { prompt: `Prompt ${id}` },
        checkpointNamespace: "",
        ...(origin === undefined ? {} : { origin }),
        ...(extra.originScheduleId === undefined ? {} : { originScheduleId: extra.originScheduleId }),
        now: () => now,
        newTaskId: () => id,
        newThreadId: () => `thread-${id}`,
        newAdmissionId: () => `admission-${id}`,
      });
    };
    const reply = (taskId: string, n: number, intent: unknown, state = "committed") => {
      const now = at();
      store.handle
        .prepare(
          "INSERT INTO tavi_admissions(admission_id,task_id,operation_key,kind,intent,intent_hash,state,created_at,updated_at) VALUES(?,?,?,'reply',?,'h',?,?,?)",
        )
        .run(`${taskId}-reply-${n}`, taskId, `${taskId}-key-${n}`, JSON.stringify(intent), state, now, now);
    };
    return { store, tasks, add, reply };
  }

  it("names every kind of channel in the one list query", () => {
    const { store, add } = channels();
    try {
      const db = store.handle;
      add("web", "web");
      add("ipc", "ipc");
      add("cli", "cli");
      add("tg", "messaging");
      db.prepare(
        "INSERT INTO tavi_messaging_conversation_tasks(connection_id,external_conversation_id,task_id,created_at) VALUES('telegram-default','chat-1','tg',?)",
      ).run(T);
      db.prepare("UPDATE tavi_messaging_conversation_tasks SET provider_id='telegram' WHERE task_id='tg'").run();
      add("mail", "messaging");
      db.prepare(
        "INSERT INTO tavi_messaging_conversation_tasks(connection_id,external_conversation_id,task_id,created_at) VALUES('mailgun-default','thread-1','mail',?)",
      ).run(T);
      db.prepare("UPDATE tavi_messaging_conversation_tasks SET provider_id='mailgun' WHERE task_id='mail'").run();
      add("other-chat", "messaging");
      db.prepare(
        "INSERT INTO tavi_messaging_conversation_tasks(connection_id,external_conversation_id,task_id,created_at) VALUES('slack-default','c','other-chat',?)",
      ).run(T);
      // An attached run's conversation is on the local connection: its origin names it, not that row.
      db.prepare(
        "INSERT INTO tavi_messaging_conversation_tasks(connection_id,external_conversation_id,task_id,created_at) VALUES('local-default','op-1','ipc',?)",
      ).run(T);
      db.prepare(
        "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('r1','default','operator','Morning news',1,1,1,'active',NULL,?,?)",
      ).run(T, T);
      add("routine", undefined);
      db.prepare(
        "INSERT INTO tavi_routine_runs(run_id,routine_id,workspace_id,principal_id,occurrence_key,trigger_id,revision,snapshot_json,mode,status,generation,task_id,scheduled_for,claimed_at,started_at,ended_at,data_json) VALUES('run-1','r1','default','operator','occ',NULL,1,'{}','production','succeeded',0,'routine',NULL,?,NULL,NULL,'{}')",
      ).run(T);
      const long = "Call the dentist about the appointment next Tuesday, and ask about the invoice too";
      db.prepare(
        "INSERT INTO tavi_reminders(reminder_id,workspace_id,principal_id,text,prompt,when_json,timezone,deliver_to_json,status,next_fire_at,last_fired_at,schedule_cursor_at,created_by,origin_task_id,operation_key,created_at,updated_at) VALUES('rem:1','default','operator',?,'check','{}','UTC','{}','active',NULL,NULL,?,'user',NULL,'k',?,?)",
      ).run(long, T, T, T);
      add("reminded", "reminder", { operationKey: reminderTaskOperationKey("rem:1", T) });
      add("reminder-gone", "reminder", { operationKey: reminderTaskOperationKey("rem-gone", T) });
      db.prepare(
        "INSERT INTO tavi_schedules(schedule_id,workspace_id,principal_id,name,prompt,spec_json,missed_run_policy,auto_approve_tools_json,created_at,updated_at) VALUES('s1','default','operator','Nightly backup','p','{}','skip','[]',?,?)",
      ).run(T, T);
      add("scheduled", "schedule", { originScheduleId: "s1" });
      add("agent", "agent");
      add("unknown", undefined);
      const spy = vi.spyOn(db, "prepare");
      const listed = store.listTaskSessions({ workspaceId: "default", limit: 100, includeDelegated: true });
      // One statement for the page, channels included: no read per row.
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      const byId = Object.fromEntries(listed.rows.map((row) => [row.taskId, row.channel]));
      expect(byId).toEqual({
        web: { kind: "web" },
        ipc: { kind: "terminal" },
        cli: { kind: "terminal" },
        tg: { kind: "telegram", label: "telegram-default" },
        mail: { kind: "mailgun", label: "mailgun-default" },
        "other-chat": { kind: "messaging", label: "slack-default" },
        routine: { kind: "routine", label: "Morning news" },
        reminded: { kind: "reminder", label: `${long.slice(0, 59)}…` },
        "reminder-gone": { kind: "reminder" },
        scheduled: { kind: "schedule", label: "Nightly backup" },
        agent: { kind: "agent" },
        unknown: undefined,
      });
      expect(listed.rows.find((row) => row.taskId === "unknown")).not.toHaveProperty("channel");
      expect(store.listTaskSessions({ origin: ["web"] }).rows.map((row) => row.taskId)).toEqual(["web"]);
      // An `ipc` filter still covers the canvas runs recorded as `web`.
      expect(
        store
          .listTaskSessions({ origin: ["ipc"] })
          .rows.map((row) => row.taskId)
          .sort(),
      ).toEqual(["ipc", "web"]);
      // The server-side channel filter selects exactly what each row's channel names.
      for (const kind of TASK_CHANNEL_KINDS) {
        const named = Object.entries(byId)
          .filter(([, channel]) => channel?.kind === kind)
          .map(([id]) => id)
          .sort();
        expect(
          store
            .listTaskSessions({ workspaceId: "default", limit: 100, includeDelegated: true, channelKinds: [kind] })
            .rows.map((row) => row.taskId)
            .sort(),
        ).toEqual(named);
      }
      expect(
        store
          .listTaskSessions({ channelKinds: ["telegram", "mailgun"] })
          .rows.map((row) => row.taskId)
          .sort(),
      ).toEqual(["mail", "tg"]);
    } finally {
      store.close();
    }
  });

  it("marks a channel conversation's current epoch as its Home, read from the mapping, never the local connection's or a topic's", () => {
    const { store, add } = channels();
    try {
      const db = store.handle;
      // The kind each conversation recorded: never read from its ids.
      const map = (connection: string, conversation: string, taskId: string, kind: string | null, epoch = 0, active = 1) =>
        db
          .prepare(
            "INSERT INTO tavi_messaging_conversation_tasks(connection_id,external_conversation_id,epoch,active,task_id,created_at,conversation_kind) VALUES(?,?,?,?,?,?,?)",
          )
          .run(connection, conversation, epoch, active, taskId, T, kind);
      // An active epoch-0 mapping is its conversation's Home.
      add("dm", "messaging");
      map("telegram-default", "12345", "dm", "direct");
      add("group-old", "messaging");
      map("telegram-default", "-100777", "group-old", "group", 0, 0);
      add("group", "messaging");
      map("telegram-default", "-100777", "group", "group", 1);
      add("mail", "messaging");
      map("mailgun-default", "thread-1", "mail", "thread");
      add("local", "messaging");
      map("local-default", "op-1", "local", "direct");
      add("topic", "messaging");
      map("telegram-default", "-100777#topic:7", "topic", "thread");
      const rows = Object.fromEntries(
        store.listTaskSessions({ workspaceId: "default", limit: 100 }).rows.map((row) => [row.taskId, row.conversationHome]),
      );
      expect(rows).toEqual({
        dm: { kind: "direct", epoch: 0 },
        "group-old": undefined,
        group: { kind: "group", epoch: 1 },
        mail: { kind: "direct", epoch: 0 },
        local: undefined,
        topic: undefined,
      });
    } finally {
      store.close();
    }
  });

  it("filters by person, and binds a cursor to the narrower filters without changing an older one", () => {
    const { store, add } = channels();
    try {
      for (const id of ["a1", "a2", "a3"]) add(id, "web");
      add("b1", "web");
      store.handle.prepare("UPDATE tavi_tasks SET principal_id='ana' WHERE task_id IN ('a1','a2','a3')").run();
      expect(store.listTaskSessions({ principalId: "ana" }).rows.map((row) => row.taskId)).toEqual(["a3", "a2", "a1"]);
      expect(store.listTaskSessions({ principalId: "nobody" }).rows).toEqual([]);
      const page = store.listTaskSessions({ principalId: "ana", limit: 2 });
      expect(store.listTaskSessions({ principalId: "ana", limit: 2, cursor: page.nextCursor! }).rows.map((row) => row.taskId)).toEqual([
        "a1",
      ]);
      expect(() => store.listTaskSessions({ limit: 2, cursor: page.nextCursor! })).toThrow(/cursor/);
      // A cursor issued without the newer filters pages as it did before them.
      const plain = store.listTaskSessions({ limit: 2 });
      expect(store.listTaskSessions({ limit: 2, cursor: plain.nextCursor! }).rows.map((row) => row.taskId)).toEqual(["a2", "a1"]);
    } finally {
      store.close();
    }
  });

  it("counts follow-ups with text only, and lists them oldest first, clipped, within the workspace", () => {
    const { store, add, reply } = channels();
    try {
      add("t", "web");
      add("elsewhere", "ipc", { workspaceId: "other" });
      reply("t", 1, { prompt: "Make it shorter" });
      reply("t", 2, { prompt: "" }); // a system wake
      reply("t", 3, { resume: { kind: "approval" } }); // a resume carries no prompt
      reply("t", 4, { prompt: " \n\t " }); // nothing but whitespace
      reply("t", 5, { prompt: "refused" }, "refused");
      reply("t", 6, { prompt: "x".repeat(600) }, "pending");
      expect(store.listTaskSessions({ workspaceId: "default" }).rows[0]).toMatchObject({
        taskId: "t",
        followUps: 2,
        counts: { admissions: 7 },
      });
      const prompts = store.taskPrompts({ taskId: "t", workspaceId: "default" });
      expect(prompts?.truncated).toBe(false);
      expect(prompts?.items.map((item) => item.text)).toEqual(["Make it shorter", "x".repeat(TASK_PROMPT_TEXT_MAX)]);
      expect(prompts!.items[0]!.at < prompts!.items[1]!.at).toBe(true);
      // The start prompt is the row's own.
      expect(prompts?.items.some((item) => item.text === "Prompt t")).toBe(false);
      expect(store.taskPrompts({ taskId: "t" })?.items).toHaveLength(2);
      // Another workspace's task, and a missing one, are both not found.
      expect(store.taskPrompts({ taskId: "elsewhere", workspaceId: "default" })).toBeUndefined();
      expect(store.taskPrompts({ taskId: "missing", workspaceId: "default" })).toBeUndefined();
      expect(store.taskPrompts({ taskId: "elsewhere", workspaceId: "other" })).toEqual({ action: "prompts", items: [], truncated: false });
    } finally {
      store.close();
    }
  });

  it("keeps the oldest fifty follow-ups and says more exist", () => {
    const { store, add, reply } = channels();
    try {
      add("busy", "ipc");
      for (let i = 0; i < TASK_PROMPTS_LIMIT + 3; i++) reply("busy", i, { prompt: `p${i}` });
      const prompts = store.taskPrompts({ taskId: "busy" });
      expect(prompts?.truncated).toBe(true);
      expect(prompts?.items).toHaveLength(TASK_PROMPTS_LIMIT);
      expect(prompts?.items[0]?.text).toBe("p0");
      expect(store.listTaskSessions({}).rows[0]?.followUps).toBe(TASK_PROMPTS_LIMIT + 3);
    } finally {
      store.close();
    }
  });
});

describe("a task's title from its prompt", () => {
  it("is the prompt's first line, ending in an ellipsis when it is cut", async () => {
    const { displayTitleOf } = await import("../src/persistence/task-list.js");
    const { TASK_TITLE_MAX } = await import("@tavi/contracts");
    expect(displayTitleOf(null, "Short ask\nmore below")).toBe("Short ask");
    const long = displayTitleOf(null, "word ".repeat(60));
    expect(long).toHaveLength(TASK_TITLE_MAX);
    expect(long?.endsWith("…")).toBe(true);
    expect(displayTitleOf(null, "   ")).toBeUndefined();
  });
});
