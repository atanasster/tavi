import { labelSummary, trustedLabel, untrustedLabel, type ApprovalCallScopes } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { describe, expect, it } from "vitest";

import { SqliteApprovalInboxRepository, UNDER_ROOT_SQL } from "../src/persistence/approval-inbox.js";
import type { Database } from "../src/persistence/sqlite-loader.js";
import { SqliteStore } from "../src/persistence/store.js";

/** The approvals inbox and its history. */

const T0 = "2026-09-29T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const port = store.asPort().repositories;
  const db = store.handle;
  const task = (taskId: string, prompt = `Title of ${taskId}\nmore`, workspaceId = "default", principalId = "operator") =>
    port.tasks.admit({
      workspaceId,
      principalId,
      operationKey: taskId,
      kind: "start",
      intent: { prompt },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => T0,
      newTaskId: () => taskId,
      newThreadId: () => `thread-${taskId}`,
      newAdmissionId: () => `admission-${taskId}`,
    });
  const approval = (input: {
    id: string;
    taskId: string;
    toolId?: string;
    callId?: string;
    steps?: number;
    inputs?: unknown;
    state?: string;
    decidedBy?: string | null;
    decidedAt?: string | null;
    createdAt?: string;
    note?: string | null;
  }) =>
    db
      .prepare(
        "INSERT INTO tavi_approvals(approval_id,task_id,admission_id,tool_id,call_id,steps,inputs,inputs_hash,state,decided_by,decided_at,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'h',?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.taskId,
        `admission-${input.taskId}`,
        input.toolId ?? "http.request",
        input.callId ?? `call-${input.id}`,
        input.steps ?? 1,
        JSON.stringify(input.inputs ?? { url: "https://example.com/a\nsecond line", body: "x".repeat(10_000) }),
        input.state ?? "pending",
        input.decidedBy ?? null,
        input.decidedAt ?? null,
        input.note ?? null,
        input.createdAt ?? T0,
        T0,
      );
  const round = (
    taskId: string,
    steps: number,
    extra: { risk?: "low" | "medium" | "high" | "critical"; expiresAt?: string; announced?: boolean; callScopes?: ApprovalCallScopes } = {},
  ) => {
    port.approvalRounds.create({
      taskId,
      steps,
      token: "abcdefghijkmnpqr".slice(steps, steps + 8),
      workspaceId: "default",
      connectionId: "telegram-main",
      conversationId: "chat-1",
      ...definedOnly({ expiresAt: extra.expiresAt, risk: extra.risk, callScopes: extra.callScopes }),
      createdAt: T0,
    });
    if (extra.announced !== false) port.approvalRounds.appendEvent({ taskId, steps, kind: "announced", via: "telegram-main", at: T0 });
  };
  const question = (waitId: string, taskId: string, text: string | undefined, outcome: object, settledAt: string) => {
    port.agentWaits.prepare({ waitId, taskId, deadlineAt: "2099-01-01T00:00:00.000Z" });
    port.agentWaits.activate(waitId);
    db.prepare(
      "INSERT INTO tavi_admissions(admission_id,task_id,operation_key,kind,intent,intent_hash,state,result,created_at,updated_at) VALUES(?,?,?,'reply','{}','h','committed',?,?,?)",
    ).run(
      `ask-${waitId}`,
      taskId,
      `ask-${waitId}`,
      JSON.stringify({ waitInterrupt: { wait: { waitId }, ...(text === undefined ? {} : { question: text }) } }),
      T0,
      T0,
    );
    port.agentWaits.settle({ waitId, outcome: outcome as never });
    db.prepare("UPDATE tavi_agent_wait_intents SET settled_at = ? WHERE wait_id = ?").run(settledAt, waitId);
  };
  const review = (artifactId: string, taskId: string | null, state: string, reviewedAt: string | null, workspaceId = "default") =>
    db
      .prepare(
        "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state,reviewed_by,reviewed_at,review_note) VALUES(?,?,?,'a','text/plain',1,'hash',?,?,?,?,?)",
      )
      .run(
        artifactId,
        workspaceId,
        taskId,
        T0,
        state,
        reviewedAt === null ? null : "ana",
        reviewedAt,
        state === "rejected" ? "not this" : null,
      );
  return { store, port, db, task, approval, round, question, review };
}

describe("needs: open questions and pending reviews", () => {
  it("lists a workspace's open questions with their text, choices, deadline, origin and chats, soonest deadline first", () => {
    const { store, port, db, task, review } = fixture();
    try {
      task("t-late");
      task("t-soon");
      task("t-peer");
      task("foreign", "Foreign", "other");
      const open = (
        waitId: string,
        taskId: string,
        deadlineAt: string,
        text: string | undefined,
        extra: { correlationId?: string } = {},
      ) => {
        port.agentWaits.prepare({
          waitId,
          taskId,
          deadlineAt,
          ...(extra.correlationId === undefined ? {} : { correlationId: extra.correlationId }),
          choices: {
            header: "Ship",
            options: [{ label: "Yes" }, { label: "No", description: "wait a day" }],
            multiSelect: false,
            allowOther: true,
          },
        });
        port.agentWaits.activate(waitId);
        db.prepare(
          "INSERT INTO tavi_admissions(admission_id,task_id,operation_key,kind,intent,intent_hash,state,result,created_at,updated_at) VALUES(?,?,?,'reply','{}','h','committed',?,?,?)",
        ).run(
          `ask-${waitId}`,
          taskId,
          `ask-${waitId}`,
          JSON.stringify({ waitInterrupt: { wait: { waitId }, ...(text === undefined ? {} : { question: text }) } }),
          T0,
          at(5),
        );
      };
      open("w-late", "t-late", at(120), "Deploy later?");
      open("w-soon", "t-soon", at(30), "Deploy now?");
      // Why it was asked travels on the suspension, as the question does.
      db.prepare(
        "UPDATE tavi_admissions SET result = json_set(result, '$.waitInterrupt.context', 'Staging is green.') WHERE admission_id = 'ask-w-soon'",
      ).run();
      // A peer agent's reply is no person's question, nor a wait whose suspension carried no text.
      open("w-peer", "t-peer", at(10), "Not a person's", { correlationId: "msg-1" });
      open("w-foreign", "foreign", at(1), "Theirs");
      db.prepare("UPDATE tavi_tasks SET origin = 'schedule', origin_schedule_id = 'sch-1' WHERE task_id = 't-soon'").run();
      db.prepare(
        "INSERT INTO tavi_schedules(schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy, auto_approve_tools_json, created_at, updated_at) VALUES('sch-1','default','operator','Daily release','go','{}','skip','[]',?,?)",
      ).run(T0, T0);
      port.needDeliveries.record({
        waitId: "w-soon",
        taskId: "t-soon",
        connectionId: "telegram-main",
        destination: { chatId: 1 },
        text: "❓ Deploy now?",
        token: "tok",
        createdAt: T0,
      });
      review("art-1", "t-late", "pending", null);
      review("art-2", "t-late", "pending", null);
      review("art-3", "t-soon", "approved", at(1));

      const waits = port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 });
      expect(waits.truncated).toBe(false);
      expect(waits.questions.map((row) => row.waitId)).toEqual(["w-soon", "w-late"]);
      expect(waits.questions[0]).toEqual({
        taskId: "t-soon",
        workspaceId: "default",
        principalId: "operator",
        taskTitle: "Title of t-soon",
        origin: "schedule",
        originLabel: "Daily release",
        waitId: "w-soon",
        question: "Deploy now?",
        context: "Staging is green.",
        choices: {
          header: "Ship",
          options: [{ label: "Yes" }, { label: "No", description: "wait a day" }],
          multiSelect: false,
          allowOther: true,
        },
        deadlineAt: at(30),
        askedAt: at(5),
        deliveries: [{ connectionId: "telegram-main" }],
      });
      expect(waits.questions[1]).toMatchObject({ origin: "ipc", deliveries: [] });
      expect(waits.reviews).toEqual([
        {
          taskId: "t-late",
          workspaceId: "default",
          principalId: "operator",
          taskTitle: "Title of t-late",
          origin: "ipc",
          artifactCount: 2,
          askedAt: T0,
        },
      ]);
      expect(
        port.approvalInbox.pendingWaits({ workspaceId: "default", taskId: "t-late", limit: 10 }).questions.map((row) => row.waitId),
      ).toEqual(["w-late"]);
      expect(port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 1 })).toMatchObject({
        truncated: true,
        questions: [{ waitId: "w-soon" }],
      });
      expect(port.approvalInbox.pendingWaits({ workspaceId: "other", limit: 10 }).questions.map((row) => row.waitId)).toEqual([
        "w-foreign",
      ]);
      // Reviews too: by task, by limit, and never another workspace's.
      review("art-foreign", "foreign", "pending", null, "other");
      review("art-4", "t-soon", "pending", null);
      expect(
        port.approvalInbox.pendingWaits({ workspaceId: "default", taskId: "t-soon", limit: 10 }).reviews.map((row) => row.taskId),
      ).toEqual(["t-soon"]);
      expect(port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 1 }).reviews).toHaveLength(1);
      expect(port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 }).reviews.map((row) => row.taskId)).not.toContain(
        "foreign",
      );
      expect(port.approvalInbox.pendingWaits({ workspaceId: "other", limit: 10 }).reviews.map((row) => row.taskId)).toEqual(["foreign"]);
      // A choices column that does not parse leaves its question without choices, not the listing failed.
      db.prepare("UPDATE tavi_agent_wait_intents SET choices_json = 'not json' WHERE wait_id = 'w-late'").run();
      expect(
        port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 }).questions.find((row) => row.waitId === "w-late"),
      ).not.toHaveProperty("choices");
    } finally {
      store.close();
    }
  });
});

describe("needs of a root chat's workers", () => {
  it("lists the open questions and browser handoffs of a root's workers at any depth, named by their agent, and nobody else's", () => {
    const { store, port, db, task } = fixture();
    try {
      for (const id of ["root", "w1", "w2", "w3", "other-root", "w-other"]) task(id);
      const delegate = (worker: string, parent: string | null, root: string | null, agent: string, definition?: string) =>
        db
          .prepare(
            "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,parent_task_id,root_task_id,agent_definition_id) VALUES('default','operator',?,?,?,?,?,?,?)",
          )
          .run(`spawn-${worker}`, worker, agent, T0, parent, root, definition ?? null);
      db.prepare(
        "INSERT INTO tavi_agent_definitions(agent_id,workspace_id,name,system_prompt,created_at,updated_at) VALUES('def-research','default','Researcher','x',?,?)",
      ).run(T0, T0);
      delegate("w1", "root", "root", "agent-1", "def-research");
      db.prepare(
        "INSERT INTO tavi_approvals(approval_id,task_id,admission_id,tool_id,call_id,steps,inputs,inputs_hash,state,created_at,updated_at) VALUES('approval-w1','w1','admission-w1','sandbox.run','call-w1',1,'{}','h','pending',?,?)",
      ).run(T0, T0);
      expect(port.approvalInbox.pending({ workspaceId: "default", rootTaskId: "root", limit: 10 }).rows).toMatchObject([
        { taskId: "w1", rootTaskId: "root" },
      ]);
      expect(port.approvalInbox.pending({ workspaceId: "default", rootTaskId: "other-root", limit: 10 }).rows).toEqual([]);
      // A worker of a worker: under the same root.
      delegate("w2", "w1", "root", "agent-2");
      // A row from before parents were recorded names its root only.
      delegate("w3", null, "root", "agent-3");
      delegate("w-other", "other-root", "other-root", "agent-x");
      const ask = (waitId: string, taskId: string, deadlineAt: string, extra: { question?: string; handoff?: object } = {}) => {
        port.agentWaits.prepare({
          waitId,
          taskId,
          deadlineAt,
          ...(extra.handoff === undefined ? {} : { handoff: extra.handoff as never }),
        });
        port.agentWaits.activate(waitId);
        db.prepare(
          "INSERT INTO tavi_admissions(admission_id,task_id,operation_key,kind,intent,intent_hash,state,result,created_at,updated_at) VALUES(?,?,?,'reply','{}','h','committed',?,?,?)",
        ).run(
          `ask-${waitId}`,
          taskId,
          `ask-${waitId}`,
          JSON.stringify({ waitInterrupt: { wait: { waitId }, question: extra.question ?? "Act in the page" } }),
          T0,
          at(1),
        );
      };
      ask("q-root", "root", at(5), { question: "The root's own?" });
      ask("q-1", "w1", at(30), { question: "Which source?" });
      ask("q-2", "w2", at(20), { question: "Deeper?" });
      ask("h-3", "w3", at(10), { handoff: { sessionId: "session-1", reason: "sign-in", instructions: "Sign in, then hand back" } });
      ask("q-other", "w-other", at(1), { question: "Not this root's" });

      const waits = port.approvalInbox.pendingWaits({ workspaceId: "default", rootTaskId: "root", limit: 10 });
      expect(waits.questions.map((row) => [row.waitId, row.taskId, row.workerLabel])).toEqual([
        ["q-2", "w2", "agent-2"],
        ["q-1", "w1", "Researcher"],
      ]);
      expect(waits.handoffs).toEqual([
        {
          taskId: "w3",
          workspaceId: "default",
          principalId: "operator",
          taskTitle: "Title of w3",
          origin: "ipc",
          workerLabel: "agent-3",
          waitId: "h-3",
          handoff: { sessionId: "session-1", reason: "sign-in", instructions: "Sign in, then hand back" },
          deadlineAt: at(10),
          askedAt: at(1),
        },
      ]);
      // Without a root, a handoff is no question, and no handoffs are listed.
      const all = port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 });
      expect(all.questions.map((row) => row.waitId)).toEqual(["q-other", "q-root", "q-2", "q-1"]);
      expect(all).not.toHaveProperty("handoffs");
      expect(port.approvalInbox.pendingWaits({ workspaceId: "other", rootTaskId: "root", limit: 10 })).toMatchObject({
        questions: [],
        handoffs: [],
      });
      expect(() => port.approvalInbox.pendingWaits({ workspaceId: "default", taskId: "w1", rootTaskId: "root", limit: 10 })).toThrow();
    } finally {
      store.close();
    }
  });
});

describe("a root's workers, walked down their delegation rows", () => {
  it("ends on a cycle, lists each worker once, and reads every step through the parent index", () => {
    const { store, port, db, task } = fixture();
    try {
      for (const id of ["root", "w1", "w2"]) task(id);
      const delegate = (worker: string, parent: string) =>
        db
          .prepare(
            "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,parent_task_id,root_task_id) VALUES('default','operator',?,?,'agent',?,?,'root')",
          )
          .run(`spawn-${worker}`, worker, T0, parent);
      delegate("w1", "root");
      // A broken history: w1 under w2 and w2 under w1.
      delegate("w2", "w1");
      db.prepare("UPDATE tavi_agent_delegation_admissions SET parent_task_id = 'w2' WHERE worker_task_id = 'w1'").run();
      db.prepare(
        "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,parent_task_id,root_task_id) VALUES('default','operator','spawn-w1-again','root','agent',?,'root','root')",
      ).run(T0);
      const listed = db
        .prepare(`SELECT t.task_id FROM tavi_tasks t WHERE ${UNDER_ROOT_SQL} ORDER BY t.task_id`)
        .all("default", "w1", "default", "w1", "default") as { task_id: string }[];
      expect(listed.map((row) => row.task_id)).toEqual(["w1", "w2"]);
      // A self-parented row never lists the root as its own worker.
      port.agentWaits.prepare({ waitId: "q-root", taskId: "root", deadlineAt: at(5), question: "The root's own?" });
      port.agentWaits.activate("q-root");
      expect(port.approvalInbox.pendingWaits({ workspaceId: "default", rootTaskId: "root", limit: 10 }).questions).toEqual([]);
      const plan = (
        db
          .prepare(`EXPLAIN QUERY PLAN SELECT t.task_id FROM tavi_tasks t WHERE t.workspace_id = ? AND ${UNDER_ROOT_SQL}`)
          .all("default", "default", "root", "default", "root", "default") as { detail: string }[]
      ).map((row) => row.detail);
      expect(plan.some((detail) => detail.includes("AUTOMATIC"))).toBe(false);
      expect(
        plan.filter((detail) => detail.includes("tavi_delegation_parent_idx (workspace_id=? AND parent_task_id=?)")).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      store.close();
    }
  });
});

describe("approvals history: who answered a question", () => {
  it("reports who settled a question and through what, and nothing for one settled before that was recorded", () => {
    const { store, port, task, question } = fixture();
    try {
      task("t1");
      question("w-old", "t1", "Which day?", { kind: "answered", replyText: "Monday" }, at(1));
      port.agentWaits.prepare({ waitId: "w-new", taskId: "t1", deadlineAt: "2099-01-01T00:00:00.000Z" });
      port.agentWaits.activate("w-new");
      store.handle
        .prepare(
          "INSERT INTO tavi_admissions(admission_id,task_id,operation_key,kind,intent,intent_hash,state,result,created_at,updated_at) VALUES('ask-new','t1','ask-new','reply','{}','h','committed',?,?,?)",
        )
        .run(JSON.stringify({ waitInterrupt: { wait: { waitId: "w-new" }, question: "Which time?" } }), T0, T0);
      port.agentWaits.settle({ waitId: "w-new", outcome: { kind: "answered", replyText: "9:00" }, by: "operator", via: "telegram-main" });
      const items = port.approvalInbox.history({ workspaceId: "default", limit: 10, kinds: ["question"] }).items;
      expect(items.find((item) => item.kind === "question" && item.waitId === "w-new")).toMatchObject({
        decidedBy: "operator",
        via: "telegram-main",
      });
      const old = items.find((item) => item.kind === "question" && item.waitId === "w-old");
      expect(old).not.toHaveProperty("decidedBy");
      expect(old).not.toHaveProperty("via");
    } finally {
      store.close();
    }
  });
});

describe("approvals inbox: a headline is masked", () => {
  it("never shows a secret a waiting call's input carries", () => {
    const { store, port, task, approval, round } = fixture();
    try {
      task("t1");
      approval({
        id: "a-key",
        taskId: "t1",
        toolId: "sandbox.run",
        inputs: { command: "aws s3 ls --key AKIAIOSFODNN7EXAMPLE" },
        createdAt: at(1),
      });
      round("t1", 1, { risk: "high" });
      approval({
        id: "a-long",
        taskId: "t1",
        callId: "c2",
        toolId: "sandbox.run",
        inputs: { command: `${"echo ok ".repeat(30)}AKIAIOSFODNN7EXAMPLE` },
        createdAt: at(2),
      });
      const [row, long] = port.approvalInbox.pending({ workspaceId: "default", limit: 10 }).rows;
      expect(row?.summary).toBe("aws s3 ls --key [redacted:aws-key]");
      // A key the clip would cut in two is left out with the word it is in.
      expect(long?.summary).not.toMatch(/AKIA/);
      expect(long?.summary?.endsWith("…")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("a round's stored risk carries its context label", () => {
  it("round-trips the label beside the level, and the inbox still reads the level", () => {
    const { store, port, db, task, approval } = fixture();
    try {
      task("t1");
      approval({ id: "a-1", taskId: "t1", createdAt: at(1) });
      const label = labelSummary(untrustedLabel("web", { principal: "host:example.com", ref: { ref: "c1", host: "example.com", at: T0 } }));
      port.approvalRounds.create({
        taskId: "t1",
        steps: 1,
        token: "bcdefghi",
        workspaceId: "default",
        risk: "high",
        riskLabel: label,
        createdAt: T0,
      });
      expect(port.approvalRounds.get("t1", 1)).toMatchObject({ risk: "high", riskLabel: label });
      // No migration: the TEXT column holds both, as JSON.
      expect(JSON.parse((db.prepare("SELECT risk FROM tavi_approval_rounds WHERE task_id = 't1'").get() as { risk: string }).risk)).toEqual(
        { level: "high", label },
      );
      expect(port.approvalInbox.pending({ workspaceId: "default", limit: 10 }).rows[0]).toMatchObject({
        risk: "high",
        allowedScopes: ["once", "session"],
        label,
      });
      // A round from before labels reads as it did.
      port.approvalRounds.create({ taskId: "t1", steps: 2, token: "cdefghij", workspaceId: "default", risk: "medium", createdAt: T0 });
      expect(port.approvalRounds.get("t1", 2)).not.toHaveProperty("riskLabel");
    } finally {
      store.close();
    }
  });
});

describe("an inbox row says where its chat read untrusted content", () => {
  it("carries the round's untrusted label, and none for a trusted one", () => {
    const { store, port, task, approval } = fixture();
    try {
      task("t1");
      task("t2");
      approval({ id: "a-1", taskId: "t1", createdAt: at(1) });
      approval({ id: "a-2", taskId: "t2", createdAt: at(2) });
      const untrusted = labelSummary(untrustedLabel("web", { ref: { ref: "c1", host: "news.example", at: T0 } }));
      port.approvalRounds.create({
        taskId: "t1",
        steps: 1,
        token: "bcdefghi",
        workspaceId: "default",
        risk: "high",
        riskLabel: untrusted,
        createdAt: T0,
      });
      port.approvalRounds.create({
        taskId: "t2",
        steps: 1,
        token: "cdefghij",
        workspaceId: "default",
        risk: "high",
        riskLabel: labelSummary(trustedLabel("personal")),
        createdAt: T0,
      });
      const [tainted, clean] = port.approvalInbox.pending({ workspaceId: "default", limit: 10 }).rows;
      expect(tainted?.label).toEqual(untrusted);
      expect(clean).not.toHaveProperty("label");
    } finally {
      store.close();
    }
  });
});

describe("approvals inbox: pending", () => {
  it("lists the workspace's pending approvals oldest first, enriched, and never another workspace's", () => {
    const { store, port, task, approval, round } = fixture();
    try {
      task("t1");
      task("foreign", "Foreign", "other");
      approval({ id: "a-old", taskId: "t1", createdAt: at(1) });
      approval({
        id: "a-new",
        taskId: "t1",
        steps: 2,
        callId: "c2",
        createdAt: at(2),
        toolId: "sandbox.run",
        inputs: { command: "ls -la" },
      });
      approval({ id: "a-foreign", taskId: "foreign", createdAt: at(0) });
      approval({ id: "a-done", taskId: "t1", callId: "c3", state: "granted", decidedBy: "ana", decidedAt: at(3), createdAt: at(0) });
      round("t1", 1, { risk: "medium", expiresAt: at(60) });
      round("t1", 2, { risk: "high", announced: false });

      const page = port.approvalInbox.pending({ workspaceId: "default", limit: 10 });
      expect(page.truncated).toBe(false);
      expect(page.rows.map((row) => row.approvalId)).toEqual(["a-old", "a-new"]);
      expect(page.rows[0]).toEqual({
        approvalId: "a-old",
        taskId: "t1",
        toolId: "http.request",
        callId: "call-a-old",
        steps: 1,
        createdAt: at(1),
        workspaceId: "default",
        principalId: "operator",
        taskStatus: "admitted",
        taskOrigin: "ipc",
        taskTitle: "Title of t1",
        summary: "https://example.com/a",
        risk: "medium",
        expiresAt: at(60),
        allowedScopes: ["once", "session", "always"],
        announcedIn: { connectionId: "telegram-main", conversationId: "chat-1" },
      });
      // High risk: no standing rule; a round never sent to a chat is not announced there.
      expect(page.rows[1]).toMatchObject({ summary: "ls -la", risk: "high", allowedScopes: ["once", "session"] });
      expect(page.rows[1]).not.toHaveProperty("announcedIn");
      expect(JSON.stringify(page)).not.toContain("xxxx");

      expect(port.approvalInbox.pending({ workspaceId: "other", limit: 10 }).rows.map((row) => row.approvalId)).toEqual(["a-foreign"]);
      expect(port.approvalInbox.pending({ workspaceId: "default", taskId: "foreign", limit: 10 }).rows).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("offers each call the scopes its round recorded for it, and a round recorded before them what its risk allows", () => {
    const { store, port, task, approval, round } = fixture();
    try {
      task("t1");
      task("t2");
      approval({ id: "a-tainted", taskId: "t1", callId: "c-tainted", createdAt: at(1) });
      approval({ id: "a-plain", taskId: "t1", callId: "c-plain", createdAt: at(2) });
      approval({ id: "a-unlisted", taskId: "t1", callId: "c-unlisted", createdAt: at(3) });
      approval({ id: "a-old", taskId: "t2", callId: "c-old", steps: 2, createdAt: at(4) });
      round("t1", 1, {
        risk: "high",
        callScopes: [
          { callId: "c-tainted", allowedScopes: ["once"] },
          { callId: "c-plain", allowedScopes: ["once", "session"] },
        ],
      });
      round("t2", 2, { risk: "medium" });
      const rows = port.approvalInbox.pending({ workspaceId: "default", limit: 10 }).rows;
      expect(Object.fromEntries(rows.map((row) => [row.approvalId, row.allowedScopes]))).toEqual({
        "a-tainted": ["once"],
        "a-plain": ["once", "session"],
        // A call its round does not list was never offered more than once.
        "a-unlisted": ["once"],
        "a-old": ["once", "session", "always"],
      });
      expect(port.approvalRounds.get("t2", 2)).not.toHaveProperty("callScopes");
      expect(port.approvalRounds.get("t1", 1)?.callScopes).toEqual([
        { callId: "c-tainted", allowedScopes: ["once"] },
        { callId: "c-plain", allowedScopes: ["once", "session"] },
      ]);
    } finally {
      store.close();
    }
  });

  it("pages by cursor, offers only once without a recorded risk, and refuses a cursor from other filters", () => {
    const { store, port, task, approval } = fixture();
    try {
      task("t1");
      for (let index = 0; index < 5; index += 1) approval({ id: `a${index}`, taskId: "t1", callId: `c${index}`, createdAt: at(index % 2) });
      const first = port.approvalInbox.pending({ workspaceId: "default", limit: 2 });
      expect(first.truncated).toBe(true);
      expect(first.rows[0]?.allowedScopes).toEqual(["once"]);
      const second = port.approvalInbox.pending({ workspaceId: "default", limit: 2, cursor: first.nextCursor! });
      const third = port.approvalInbox.pending({ workspaceId: "default", limit: 2, cursor: second.nextCursor! });
      expect([...first.rows, ...second.rows, ...third.rows].map((row) => row.approvalId)).toEqual(["a0", "a2", "a4", "a1", "a3"]);
      expect(third.truncated).toBe(false);
      expect(third).not.toHaveProperty("nextCursor");
      expect(() => port.approvalInbox.pending({ workspaceId: "default", taskId: "t1", limit: 2, cursor: first.nextCursor! })).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    } finally {
      store.close();
    }
  });
});

describe("approvals inbox: history", () => {
  function seeded() {
    const f = fixture();
    const { port, task, approval, round, question, review } = f;
    task("t1");
    task("t2", "Second task", "default", "alice");
    task("foreign", "Foreign", "other");
    // Granted for good in Telegram: a rule was created for it.
    approval({ id: "g-always", taskId: "t1", callId: "c1", state: "granted", decidedBy: "ana", decidedAt: at(10) });
    approval({ id: "d-denied", taskId: "t1", callId: "c2", state: "denied", decidedBy: "ana", decidedAt: at(10), note: "no" });
    round("t1", 1, { risk: "medium" });
    port.approvalRounds.appendEvent({
      taskId: "t1",
      steps: 1,
      kind: "settled",
      via: "telegram-main",
      actor: "ana",
      at: at(10),
      detail: {
        decisions: [
          { callId: "c1", toolName: "http.request", approved: true, scope: "always" },
          { callId: "c2", toolName: "http.request", approved: false, scope: "once" },
        ],
        notice: "long text",
      },
    });
    port.approvalRounds.appendEvent({
      taskId: "t1",
      steps: 1,
      kind: "rule_created",
      via: "telegram-main",
      detail: { toolName: "http.request", callId: "c1", created: ["rule-7"] },
      at: at(10),
    });
    // Expired, and one cancelled with its task.
    approval({
      id: "e-expired",
      taskId: "t2",
      steps: 1,
      callId: "c1",
      state: "denied",
      decidedBy: "policy:expired",
      decidedAt: at(20),
      toolId: "sandbox.run",
      inputs: { command: "rm -rf /tmp/x" },
    });
    approval({ id: "x-cancelled", taskId: "t2", steps: 2, callId: "c1", state: "cancelled", decidedAt: at(5) });
    approval({ id: "p-pending", taskId: "t1", steps: 3, callId: "c9" });
    approval({ id: "f-foreign", taskId: "foreign", state: "granted", decidedBy: "ana", decidedAt: at(30) });
    review("r-approved", "t1", "approved", at(15));
    review("r-rejected", null, "rejected", at(10));
    review("r-unreviewed", "t1", "approved", null);
    review("r-foreign", "foreign", "approved", at(40), "other");
    question("w-answered", "t1", `What colour? ${"y".repeat(400)}`, { kind: "answered", replyText: "Blue" }, at(25));
    question("w-choice", "t2", "Pick one", { kind: "answered", answers: ["A", "B"] }, at(8));
    question("w-timeout", "t1", "Still there?", { kind: "wait-timeout" }, at(12));
    question("w-not-a-question", "t1", undefined, { kind: "answered", replyText: "x" }, at(26));
    return f;
  }

  it("merges approvals, reviews and questions newest first, with scope, channel, rule and answers", () => {
    const { store, port } = seeded();
    try {
      const { items, nextCursor } = port.approvalInbox.history({ workspaceId: "default", limit: 50 });
      expect(nextCursor).toBeUndefined();
      expect(
        items.map(
          (item) =>
            `${item.kind}:${item.state}:${"approvalId" in item ? item.approvalId : "artifactId" in item ? item.artifactId : item.waitId}`,
        ),
      ).toEqual([
        "question:answered:w-answered",
        "approval:expired:e-expired",
        "review:approved:r-approved",
        "question:expired:w-timeout",
        // Same instant: kinds in order, then ids newest (descending) first.
        "approval:granted:g-always",
        "approval:denied:d-denied",
        "review:rejected:r-rejected",
        "question:answered:w-choice",
        "approval:cancelled:x-cancelled",
      ]);
      const byId = (id: string) =>
        items.find(
          (item) =>
            ("approvalId" in item && item.approvalId === id) ||
            ("artifactId" in item && item.artifactId === id) ||
            ("waitId" in item && item.waitId === id),
        );
      expect(byId("g-always")).toEqual({
        kind: "approval",
        approvalId: "g-always",
        taskId: "t1",
        taskTitle: "Title of t1",
        principalId: "operator",
        toolId: "http.request",
        callId: "c1",
        steps: 1,
        summary: "https://example.com/a",
        state: "granted",
        decidedBy: "ana",
        decidedAt: at(10),
        via: "telegram-main",
        scope: "always",
        risk: "medium",
        note: null,
        ruleId: "rule-7",
      });
      // A denial has no scope and no rule, whatever the settlement recorded for it.
      expect(byId("d-denied")).toMatchObject({ state: "denied", via: "telegram-main", note: "no" });
      expect(byId("d-denied")).not.toHaveProperty("scope");
      expect(byId("e-expired")).toMatchObject({ decidedBy: "policy:expired", summary: "rm -rf /tmp/x", principalId: "alice" });
      expect(byId("x-cancelled")).toMatchObject({ decidedBy: null });
      expect(byId("r-rejected")).toEqual({
        kind: "review",
        artifactId: "r-rejected",
        state: "rejected",
        decidedBy: "ana",
        decidedAt: at(10),
        note: "not this",
        contentType: "text/plain",
      });
      expect(byId("r-approved")).toMatchObject({ taskId: "t1", taskTitle: "Title of t1", principalId: "operator" });
      const answered = byId("w-answered");
      expect(answered).toMatchObject({ answer: "Blue", taskTitle: "Title of t1" });
      expect(answered?.kind === "question" && answered.question.length).toBe(300);
      expect(byId("w-choice")).toMatchObject({ answer: "A, B" });
      expect(byId("w-timeout")).toMatchObject({ answer: null });
      expect(JSON.stringify(items)).not.toContain("xxxx");
      expect(JSON.stringify(items)).not.toContain("long text");
    } finally {
      store.close();
    }
  });

  it("titles every kind by the task's generated title once it has one, as tasks list does", () => {
    const { store, port, db } = seeded();
    try {
      db.prepare("UPDATE tavi_tasks SET title = 'Colour survey' WHERE task_id = 't1'").run();
      // A blank generated title is none: t2 keeps its prompt's first line.
      db.prepare("UPDATE tavi_tasks SET title = '   ' WHERE task_id = 't2'").run();
      const titles = Object.fromEntries(
        port.approvalInbox
          .history({ workspaceId: "default", limit: 50 })
          .items.map((item) => [
            "approvalId" in item ? item.approvalId : "artifactId" in item ? item.artifactId : item.waitId,
            item.taskTitle,
          ]),
      );
      expect(titles).toMatchObject({
        "g-always": "Colour survey",
        "r-approved": "Colour survey",
        "w-answered": "Colour survey",
        "e-expired": "Second task",
        "w-choice": "Second task",
      });
      expect(port.approvalInbox.pending({ workspaceId: "default", limit: 10 }).rows.map((row) => row.taskTitle)).toEqual(["Colour survey"]);
    } finally {
      store.close();
    }
  });

  it("pages across kinds by cursor without losing or repeating an item", () => {
    const { store, port } = seeded();
    try {
      const all = port.approvalInbox.history({ workspaceId: "default", limit: 50 }).items;
      const paged: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const answer = port.approvalInbox.history({ workspaceId: "default", limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        paged.push(...answer.items);
        cursor = answer.nextCursor;
        if (cursor === undefined) break;
      }
      expect(paged).toEqual(all);
      const first = port.approvalInbox.history({ workspaceId: "default", limit: 2 });
      expect(() =>
        port.approvalInbox.history({ workspaceId: "default", kinds: ["approval"], limit: 2, cursor: first.nextCursor! }),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    } finally {
      store.close();
    }
  });

  it("filters by kind, state, tool, person and time", () => {
    const { store, port } = seeded();
    try {
      const ids = (input: Parameters<typeof port.approvalInbox.history>[0]) =>
        port.approvalInbox
          .history(input)
          .items.map((item) => ("approvalId" in item ? item.approvalId : "artifactId" in item ? item.artifactId : item.waitId));
      expect(ids({ workspaceId: "default", kinds: ["review"], limit: 50 })).toEqual(["r-approved", "r-rejected"]);
      expect(ids({ workspaceId: "default", states: ["expired"], limit: 50 })).toEqual(["e-expired", "w-timeout"]);
      expect(ids({ workspaceId: "default", states: ["denied"], limit: 50 })).toEqual(["d-denied"]);
      expect(ids({ workspaceId: "default", toolId: "sandbox.run", limit: 50 })).toEqual(["e-expired"]);
      expect(ids({ workspaceId: "default", principalId: "alice", limit: 50 })).toEqual(["e-expired", "w-choice", "x-cancelled"]);
      expect(ids({ workspaceId: "default", since: at(10), until: at(15), limit: 50 })).toEqual([
        "r-approved",
        "w-timeout",
        "g-always",
        "d-denied",
        "r-rejected",
      ]);
      expect(ids({ workspaceId: "other", limit: 50 })).toEqual(["r-foreign", "f-foreign"]);
      // A chat's own record: every kind, of that task only.
      expect(ids({ workspaceId: "default", taskId: "t2", limit: 50 })).toEqual(
        ids({ workspaceId: "default", limit: 50 }).filter((id) => ["e-expired", "w-choice", "x-cancelled"].includes(id)),
      );
      expect(ids({ workspaceId: "default", taskId: "t1", kinds: ["approval"], limit: 50 })).toEqual(["g-always", "d-denied"]);
      expect(() => port.approvalInbox.history({ workspaceId: "default", since: at(10), until: at(5), limit: 50 })).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    } finally {
      store.close();
    }
  });

  it("reports how a round was settled, and nothing while it is pending", () => {
    const { store, port } = seeded();
    try {
      // One call granted and one denied: the round says so, rather than whichever row sorts last.
      expect(port.approvalInbox.settlement({ taskId: "t1", steps: 1 })).toEqual({
        taskId: "t1",
        steps: 1,
        state: "mixed",
        decidedBy: "ana",
        decidedAt: at(10),
        via: "telegram-main",
      });
      expect(port.approvalInbox.settlement({ taskId: "t1", steps: 3 })).toBeUndefined();
      // Without a round: the task's most recently decided one.
      expect(port.approvalInbox.settlement({ taskId: "t2" })).toMatchObject({ steps: 1, state: "expired", decidedBy: "policy:expired" });
      expect(port.approvalInbox.settlement({ taskId: "nothing" })).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("approvals inbox: query plans", () => {
  /** Run every statement the repository prepares under EXPLAIN QUERY PLAN, with the arguments it was run with. */
  function plans(db: Database, run: (repository: SqliteApprovalInboxRepository) => void): string[][] {
    const captured: { sql: string; args: unknown[] }[] = [];
    const spy = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver) as unknown;
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(inner, name, innerReceiver) {
              if (name !== "all" && name !== "get") return Reflect.get(inner, name, innerReceiver) as unknown;
              return (...args: unknown[]) => {
                captured.push({ sql, args });
                return (inner[name] as (...values: unknown[]) => unknown).apply(inner, args);
              };
            },
          });
        };
      },
    });
    run(new SqliteApprovalInboxRepository(() => spy));
    return captured.map(({ sql, args }) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((row) => row.detail),
    );
  }

  /** A full scan of the approvals table (`SCAN a` with no index), as opposed to a search or an index scan. */
  const scansApprovals = (details: readonly string[]) => details.some((detail) => /^SCAN (a|tavi_approvals)$/.test(detail));

  it("reads pending and decided approvals through an index, never a full scan of tavi_approvals", () => {
    const { store, db, task, approval } = fixture();
    try {
      task("t1");
      approval({ id: "a1", taskId: "t1" });
      approval({ id: "a2", taskId: "t1", callId: "c2", state: "granted", decidedBy: "ana", decidedAt: at(1) });
      approval({ id: "a3", taskId: "t1", callId: "c3", state: "denied", decidedBy: "ana", decidedAt: at(2) });
      const pending = plans(db, (repository) => repository.pending({ workspaceId: "default", limit: 10 }));
      const history = plans(db, (repository) => repository.history({ workspaceId: "default", kinds: ["approval"], limit: 10 }));
      const { nextCursor } = store.asPort().repositories.approvalInbox.history({ workspaceId: "default", kinds: ["approval"], limit: 1 });
      const later = plans(db, (repository) =>
        repository.history({
          workspaceId: "default",
          kinds: ["approval"],
          limit: 1,
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        }),
      );
      expect(nextCursor).toBeDefined();
      const all = plans(db, (repository) => repository.history({ workspaceId: "default", limit: 10 }));
      const chat = plans(db, (repository) => repository.history({ workspaceId: "default", taskId: "t1", kinds: ["approval"], limit: 10 }));
      for (const plan of [...pending, ...history, ...all, ...chat]) expect(scansApprovals(plan), plan.join("\n")).toBe(false);
      expect(pending.flat().join("\n")).toMatch(/SEARCH a USING INDEX tavi_approvals_state_idx/);
      // Decided approvals are read in the history's order from their index,
      // never gathered and sorted: a page costs its rows, not the whole history.
      expect(history[0]?.join("\n")).toMatch(/tavi_approvals_decided_idx/);
      expect(history[0]?.join("\n")).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
      // A later page starts inside that index, not over it.
      expect(later[0]?.join("\n")).toMatch(/SEARCH a USING INDEX tavi_approvals_decided_idx \(/);
      expect(later[0]?.join("\n")).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
      // Reviews and questions: never a full scan of their tables either.
      for (const plan of all)
        expect(
          plan.some((detail) => /^SCAN (ar|w)$/.test(detail)),
          plan.join("\n"),
        ).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("settled waits", () => {
  it("stamps a settled wait with the time it was settled", () => {
    const { store, port, task } = fixture();
    try {
      task("t1");
      port.agentWaits.prepare({ waitId: "w", taskId: "t1", deadlineAt: "2099-01-01T00:00:00.000Z" });
      port.agentWaits.activate("w");
      port.agentWaits.settle({ waitId: "w", outcome: { kind: "answered", replyText: "yes" } });
      const row = store.handle.prepare("SELECT settled_at FROM tavi_agent_wait_intents WHERE wait_id = 'w'").get() as {
        settled_at: string;
      };
      expect(row.settled_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      store.close();
    }
  });
});

describe("need deliveries by chat and thread", () => {
  it("lists a topic's open questions only from that topic; with no thread named, all the chat's, newest first", () => {
    const { store, port, task } = fixture();
    try {
      task("t-a");
      task("t-b");
      const open = (waitId: string, taskId: string) => {
        port.agentWaits.prepare({ waitId, taskId, deadlineAt: "2099-01-01T00:00:00.000Z" });
        port.agentWaits.activate(waitId);
      };
      open("w-a", "t-a");
      open("w-b", "t-b");
      port.needDeliveries.record({
        waitId: "w-a",
        taskId: "t-a",
        connectionId: "telegram-main",
        destination: { chatId: -100 },
        chatId: "-100",
        threadId: "7",
        text: "A?",
        token: "tok-a",
        createdAt: T0,
      });
      port.needDeliveries.record({
        waitId: "w-b",
        taskId: "t-b",
        connectionId: "telegram-main",
        destination: { chatId: -100 },
        chatId: "-100",
        threadId: "8",
        text: "B?",
        token: "tok-b",
        createdAt: at(1),
      });
      expect(port.needDeliveries.listOpenInChat("telegram-main", "-100", "7", 20)).toMatchObject([{ waitId: "w-a", threadId: "7" }]);
      expect(port.needDeliveries.listOpenInChat("telegram-main", "-100", "8", 20).map((row) => row.waitId)).toEqual(["w-b"]);
      expect(port.needDeliveries.listOpenInChat("telegram-main", "-100", "9", 20)).toEqual([]);
      // No thread named: the chat's, newest first, bounded.
      expect(port.needDeliveries.listOpenInChat("telegram-main", "-100", undefined, 20).map((row) => row.waitId)).toEqual(["w-b", "w-a"]);
      expect(port.needDeliveries.listOpenInChat("telegram-main", "-100", undefined, 1).map((row) => row.waitId)).toEqual(["w-b"]);
      // A repeat record keeps the first thread.
      port.needDeliveries.record({
        waitId: "w-a",
        taskId: "t-a",
        connectionId: "telegram-main",
        destination: { chatId: -100 },
        chatId: "-100",
        threadId: "99",
        text: "A?",
        token: "tok-a",
        createdAt: T0,
      });
      expect(port.needDeliveries.listForWait("w-a")[0]?.threadId).toBe("7");
    } finally {
      store.close();
    }
  });
});
