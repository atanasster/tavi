import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/** An app's Recent activity by tool-id prefix. */

const T0 = "2026-10-16T09:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const port = store.asPort().repositories;
  const db = store.handle;
  const task = (taskId: string, workspaceId = "default") =>
    port.tasks.admit({
      workspaceId,
      principalId: "operator",
      operationKey: taskId,
      kind: "start",
      intent: { prompt: `Title of ${taskId}` },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => T0,
      newTaskId: () => taskId,
      newThreadId: () => `thread-${taskId}`,
      newAdmissionId: () => `admission-${taskId}`,
    });
  const effect = (key: string, taskId: string, toolId: string, createdAt: string, state = "accepted") =>
    db
      .prepare(
        "INSERT INTO tavi_effects(effect_key,task_id,admission_id,tool_id,inputs,inputs_hash,state,created_at,updated_at) VALUES(?,?,?,?,'{}','h',?,?,?)",
      )
      .run(key, taskId, `admission-${taskId}`, toolId, state, createdAt, createdAt);
  const approval = (id: string, taskId: string, toolId: string, decidedAt: string) =>
    db
      .prepare(
        "INSERT INTO tavi_approvals(approval_id,task_id,admission_id,tool_id,call_id,steps,inputs,inputs_hash,state,decided_by,decided_at,note,created_at,updated_at) VALUES(?,?,?,?,?,1,'{}','h','granted','operator',?,NULL,?,?)",
      )
      .run(id, taskId, `admission-${taskId}`, toolId, `call-${id}`, decidedAt, decidedAt, decidedAt);
  return { store, port, task, effect, approval };
}

describe("effects by tool prefix", () => {
  it("lists an app's effects newest first, paged, in its workspace only, never another app's", () => {
    const { store, port, task, effect } = fixture();
    try {
      task("t1");
      task("t2");
      task("theirs", "other");
      effect("e1", "t1", "mcp.gcal.create_event", at(1));
      effect("e2", "t2", "mcp.gcal2.create_event", at(2));
      effect("e3", "t1", "mcp.gcal.delete_event", at(3), "uncertain");
      effect("e4", "t1", "mcp.gcalendar.create_event", at(4));
      effect("e5", "theirs", "mcp.gcal.create_event", at(5));
      const first = port.effects.listForTools({ workspaceId: "default", prefixes: ["mcp.gcal.", "mcp.gcal2."], limit: 2 });
      expect(first.map((row) => row.effectKey)).toEqual(["e3", "e2"]);
      expect(first[0]).toEqual({
        effectKey: "e3",
        taskId: "t1",
        taskTitle: "Title of t1",
        toolId: "mcp.gcal.delete_event",
        state: "uncertain",
        createdAt: at(3),
      });
      const last = first.at(-1);
      if (last === undefined) throw new Error("no page");
      expect(
        port.effects
          .listForTools({
            workspaceId: "default",
            prefixes: ["mcp.gcal.", "mcp.gcal2."],
            limit: 2,
            before: { at: last.createdAt, effectKey: last.effectKey },
          })
          .map((row) => row.effectKey),
      ).toEqual(["e1"]);
      expect(port.effects.listForTools({ workspaceId: "default", prefixes: [], limit: 5 })).toEqual([]);
      expect(() => port.effects.listForTools({ workspaceId: "default", prefixes: ["mcp.gcal"], limit: 5 })).toThrow(/ends in a dot/);
    } finally {
      store.close();
    }
  });

  it("filters the approval history to the same prefixes", () => {
    const { store, port, task, approval } = fixture();
    try {
      task("t1");
      approval("a1", "t1", "mcp.gcal.create_event", at(1));
      approval("a2", "t1", "mcp.gcalendar.create_event", at(2));
      approval("a3", "t1", "http.request", at(3));
      const history = port.approvalInbox.history({ workspaceId: "default", toolPrefixes: ["mcp.gcal."], limit: 10 });
      expect(history.items.map((item) => (item.kind === "approval" ? item.approvalId : item.kind))).toEqual(["a1"]);
    } finally {
      store.close();
    }
  });

  it("lists an app's recorded reads by tool, newest first, paged, in its workspace only; a call recorded without its tool is not listed", () => {
    const { store, port, task } = fixture();
    try {
      task("t1");
      task("theirs", "other");
      port.tasks.recordToolCall("t1", 1, "c1", "mcp.gcal.list_events", at(1));
      port.tasks.recordToolCall("t1", 2, "c2", "mcp.gcal.list_events", at(2));
      port.tasks.recordToolCall("t1", 2, "c3", "mcp.gcal.create_event", at(3));
      port.tasks.recordToolCall("t1", 3, "c4", "mcp.gcal.list_events", at(4));
      port.tasks.recordToolCall("theirs", 1, "c5", "mcp.gcal.list_events", at(5));
      // Recorded before calls kept their tool: counted, never listed.
      port.tasks.recordToolCall("t1", 4, "c6");
      // The same call again is one call.
      port.tasks.recordToolCall("t1", 3, "c4", "mcp.gcal.list_events", at(6));
      const first = port.tasks.listCallsForTools({ workspaceId: "default", toolIds: ["mcp.gcal.list_events"], limit: 2 });
      expect(first).toEqual([
        { callKey: "t1:3:c4", taskId: "t1", taskTitle: "Title of t1", toolId: "mcp.gcal.list_events", at: at(4) },
        { callKey: "t1:2:c2", taskId: "t1", taskTitle: "Title of t1", toolId: "mcp.gcal.list_events", at: at(2) },
      ]);
      const last = first.at(-1);
      if (last === undefined) throw new Error("no page");
      expect(
        port.tasks
          .listCallsForTools({
            workspaceId: "default",
            toolIds: ["mcp.gcal.list_events"],
            limit: 2,
            before: { at: last.at, callKey: last.callKey },
          })
          .map((row) => row.callKey),
      ).toEqual(["t1:1:c1"]);
      expect(port.tasks.listCallsForTools({ workspaceId: "default", toolIds: [], limit: 5 })).toEqual([]);
      expect(store.handle.prepare("SELECT tool_count FROM tavi_tasks WHERE task_id='t1'").get()).toEqual({ tool_count: 5 });
    } finally {
      store.close();
    }
  });
});
