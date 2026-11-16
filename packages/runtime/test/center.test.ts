import { MEMORY_OTHER_PEOPLE_LIMIT } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/** The Command Center's reads: the summary and the change fingerprints. */

const NOW = "2026-09-29T10:00:00.000Z";

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const port = store.asPort().repositories;
  const add = (id: string, at = NOW, workspaceId = "default", principalId = "operator") =>
    port.tasks.admit({
      workspaceId,
      principalId,
      operationKey: id,
      kind: "start",
      intent: { prompt: `Prompt ${id}` },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => at,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${id}`,
    });
  const schedule = (
    scheduleId: string,
    nextRunAt: string | null,
    enabled = true,
    workspaceId = "default",
    spec: { at: string; timezone: string; daysOfWeek?: number[] } = { at: "07:00", timezone: "UTC" },
  ) =>
    port.schedules.create({
      scheduleId,
      workspaceId,
      principalId: "operator",
      name: `Schedule ${scheduleId}`,
      prompt: "fixture",
      spec,
      missedRunPolicy: "skip",
      autoApproveTools: [],
      enabled,
      nextRunAt,
      now: NOW,
    });
  const memory = (recordId: string, scopeKind: string, workspaceId: string | null, principalId = "operator", status = "proposed") =>
    store.handle
      .prepare(
        "INSERT INTO tavi_memory_records(record_id,scope_key,scope_kind,principal_id,workspace_id,kind,status,sensitivity,recorded_at,updated_at) VALUES (?,?,?,?,?,'fact',?,'normal',?,?)",
      )
      .run(recordId, `${scopeKind}:${recordId}`, scopeKind, principalId, workspaceId, status, NOW, NOW);
  // Memory is read through its service, never by the center repository: the owner counts proposals there and passes them in.
  const memoryService = new MemoryService(store.asPort());
  const operator = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" } as const;
  const summary = (input: { timezone?: string; days?: number; workspaceId?: string } = {}) =>
    port.center.summary({
      workspaceId: input.workspaceId ?? "default",
      principalId: "operator",
      timezone: input.timezone ?? "UTC",
      days: input.days ?? 14,
      now: NOW,
      memoryProposals: memoryService.counts({ actor: { ...operator, workspaceId: input.workspaceId ?? "default" } }).proposed,
    });
  const changes = (cursor?: string, workspaceId = "default") =>
    port.center.changes({ workspaceId, principalId: "operator", ...(cursor === undefined ? {} : { cursor }) });
  return { store, port, add, schedule, memory, summary, changes, memoryService, operator };
}

describe("center fingerprints", () => {
  it("names the kind that changed, and ignores a change in another workspace", () => {
    const { store, port, add, schedule, memory, changes } = fixture();
    try {
      add("t1");
      const start = changes();
      expect(start.changed).toEqual([]);
      expect(changes(start.cursor)).toEqual({ cursor: start.cursor, changed: [] });

      add("elsewhere", NOW, "other");
      schedule("foreign", "2026-09-30T07:00:00.000Z", true, "other");
      memory("foreign-memory", "shared_workspace", "other");
      expect(changes(start.cursor).changed).toEqual([]);

      port.tasks.updateStatus("t1", "completed", "done");
      const touched = changes(start.cursor);
      expect(touched.changed).toEqual(["task"]);
      expect(changes(touched.cursor).changed).toEqual([]);

      store.handle
        .prepare(
          "INSERT INTO tavi_approvals(approval_id,task_id,admission_id,tool_id,call_id,steps,inputs,inputs_hash,state,created_at,updated_at) VALUES('a','t1','admission-t1','read','c',1,'{}','h','pending',?,?)",
        )
        .run(NOW, NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state) VALUES('r','default','t1','a','text/plain',1,'hash',?,'pending')",
        )
        .run(NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_agent_wait_intents(wait_id,task_id,deadline_at,state) VALUES('w','t1','2099-01-01T00:00:00.000Z','active')",
        )
        .run();
      schedule("s1", "2026-09-30T07:00:00.000Z");
      memory("m1", "shared_workspace", "default");
      expect(changes(touched.cursor).changed).toEqual(["approval", "review", "question", "schedule", "memory"]);

      // Another person's personal memory is not this operator's to see change.
      const settled = changes(touched.cursor).cursor;
      memory("alice-private", "personal_workspace", "default", "alice");
      expect(changes(settled).changed).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("lets a memory override bump the memory kind as the built-in's triggers do", () => {
    const { store, port, changes } = fixture();
    try {
      const start = changes().cursor;
      // A chat's own memory and another person's bump nothing this operator's page reads.
      port.center.memoryChanged({ scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "t1" } });
      port.center.memoryChanged({ scope: { kind: "personal", principalId: "alice" } });
      port.center.memoryChanged({ scope: { kind: "shared_workspace", workspaceId: "other" } });
      expect(changes(start).changed).toEqual([]);
      port.center.memoryChanged({ scope: { kind: "personal_workspace", principalId: "operator", workspaceId: "default" } });
      const mine = changes(start);
      expect(mine.changed).toEqual(["memory"]);
      port.center.memoryChanged({ scope: { kind: "shared_workspace", workspaceId: "default" } });
      expect(changes(mine.cursor).changed).toEqual(["memory"]);
    } finally {
      store.close();
    }
  });

  it("reads a kind an older cursor lacks as changed, and refuses a foreign or broken cursor", () => {
    const { store, changes } = fixture();
    try {
      const { cursor } = changes();
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { kinds: Record<string, string> };
      delete decoded.kinds["memory"];
      decoded.kinds["gadget"] = "from-a-newer-build";
      const older = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      expect(changes(older).changed).toEqual(["memory"]);
      expect(() => changes(cursor, "other")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => changes("bm90LWpzb24")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    } finally {
      store.close();
    }
  });
});

describe("center summary", () => {
  it("asks to reconnect the workspace's enabled OAuth connections whose sign-in lapsed", () => {
    const { store, port, summary } = fixture();
    try {
      const save = (connectionId: string, extra: { workspaceId?: string; enabled?: boolean; label?: string } = {}) =>
        port.messagingConnections.save(
          {
            connectionId,
            providerId: "inbox",
            workspaceId: extra.workspaceId ?? "default",
            accountIdentity: "a",
            settings: {},
            credentialRefs: {},
            enabled: extra.enabled ?? true,
            authState: "connected",
            ...(extra.label === undefined ? {} : { label: extra.label }),
          },
          NOW,
        );
      save("fine");
      save("lapsed", { label: "Work mail" });
      save("narrow");
      save("off", { enabled: false });
      save("elsewhere", { workspaceId: "other" });
      for (const id of ["lapsed", "off", "elsewhere"])
        port.messagingConnections.setAuthState({ connectionId: id, authState: "expired", now: NOW });
      port.messagingConnections.setAuthState({ connectionId: "narrow", authState: "needs-consent", now: NOW });
      expect([...(summary().reconnect ?? [])].sort((a, b) => a.connectionId.localeCompare(b.connectionId))).toEqual([
        { connectionId: "lapsed", providerId: "inbox", label: "Work mail", authState: "expired" },
        { connectionId: "narrow", providerId: "inbox", authState: "needs-consent" },
      ]);
    } finally {
      store.close();
    }
  });

  it("buckets tasks by the day they were created in the workspace zone", () => {
    const { store, port, add, summary } = fixture();
    try {
      // 23:30 UTC on the 28th is 01:30 on the 29th in Berlin.
      add("late", "2026-09-28T23:30:00.000Z");
      add("early", "2026-09-28T08:00:00.000Z");
      add("outside", "2026-09-01T08:00:00.000Z");
      // A worker counts with nothing, not as a task of its own day.
      add("worker", "2026-09-29T09:00:00.000Z");
      port.agentDelegations.recordSpawn({
        operationKey: "spawn",
        workspaceId: "default",
        principalId: "operator",
        workerTaskId: "worker",
        workerAgentId: "agent",
        parentTaskId: "late",
        rootTaskId: "late",
        depth: 1,
        createdAt: NOW,
      });

      const utc = summary({ days: 3 });
      expect(utc).toMatchObject({ timezone: "UTC", today: "2026-09-29" });
      expect(utc.perDay).toEqual([
        { date: "2026-09-27", tasks: 0 },
        { date: "2026-09-28", tasks: 2 },
        { date: "2026-09-29", tasks: 0 },
      ]);

      const berlin = summary({ timezone: "Europe/Berlin", days: 3 });
      expect(berlin.perDay).toEqual([
        { date: "2026-09-27", tasks: 0 },
        { date: "2026-09-28", tasks: 1 },
        { date: "2026-09-29", tasks: 1 },
      ]);

      // Thirteen hours ahead (NZ daylight time): 10:00 UTC is 23:00 on the 29th,
      // and 23:30 UTC on the 28th is the 29th there too.
      const auckland = summary({ timezone: "Pacific/Auckland", days: 2 });
      expect(auckland.today).toBe("2026-09-29");
      expect(auckland.perDay).toEqual([
        { date: "2026-09-28", tasks: 1 },
        { date: "2026-09-29", tasks: 1 },
      ]);
      expect(summary({ timezone: "America/Los_Angeles", days: 1 }).perDay).toEqual([{ date: "2026-09-29", tasks: 0 }]);
      expect(summary().perDay).toHaveLength(14);
      expect(() => summary({ timezone: "Mars/Olympus" })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    } finally {
      store.close();
    }
  });

  it("lists the next three fires, a routine's as its routine, and counts what waits", () => {
    const { store, add, schedule, memory, summary } = fixture();
    try {
      // NOW is Tuesday 2026-09-29 10:00 UTC; each time comes from the spec.
      schedule("later", "2026-10-02T07:00:00.000Z", true, "default", { at: "07:00", timezone: "UTC", daysOfWeek: [5] });
      schedule("soonest", "2026-09-29T12:00:00.000Z", true, "default", { at: "12:00", timezone: "UTC", daysOfWeek: [2] });
      schedule("off", "2026-09-29T11:00:00.000Z", false, "default", { at: "11:00", timezone: "UTC" });
      schedule("last", "2026-10-05T07:00:00.000Z", true, "default", { at: "07:00", timezone: "UTC", daysOfWeek: [1] });
      schedule("routine-trigger", "2026-09-30T05:00:00.000Z");
      store.handle
        .prepare(
          "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('routine-1','default','operator','Morning news',1,1,1,'active',NULL,?,?)",
        )
        .run(NOW, NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES('routine-2','default','operator','Draft',1,NULL,1,'draft',NULL,?,?)",
        )
        .run(NOW, NOW);
      store.handle
        .prepare(
          "INSERT INTO tavi_routine_triggers(routine_id,trigger_id,schedule_id,spec_json) VALUES('routine-1','morning','routine-trigger',?)",
        )
        .run(JSON.stringify({ id: "morning", kind: "daily", at: "05:00", timezone: "UTC", daysOfWeek: [3] }));

      add("running");
      memory("shared", "shared_workspace", "default");
      memory("mine", "personal", null);
      memory("mine-here", "personal_workspace", "default");
      memory("theirs", "personal_workspace", "default", "alice");
      memory("scratch", "run_local", "default");
      memory("approved", "shared_workspace", "default", "operator", "approved");
      memory("foreign", "shared_workspace", "other");

      const answer = summary();
      expect(answer.next).toEqual([
        { kind: "schedule", id: "soonest", title: "Schedule soonest", at: "2026-09-29T12:00:00.000Z" },
        { kind: "routine", id: "routine-1", title: "Morning news", at: "2026-09-30T05:00:00.000Z" },
        { kind: "schedule", id: "later", title: "Schedule later", at: "2026-10-02T07:00:00.000Z" },
      ]);
      expect(answer.counts).toEqual({
        approvals: 0,
        reviews: 0,
        questions: 0,
        handoffs: 0,
        connects: 0,
        runningTasks: 1,
        memoryProposals: 3,
        activeRoutines: 1,
        schedules: 3,
        reminders: 0,
        unseenReminders: 0,
        liveBrowserSessions: 0,
      });
    } finally {
      store.close();
    }
  });

  it("counts a task waiting for a person in its browser as a handoff, not a question", () => {
    const { store, add, summary } = fixture();
    try {
      add("asked");
      store.handle
        .prepare(
          "INSERT INTO tavi_agent_wait_intents(wait_id, task_id, deadline_at, state, handoff_json) VALUES ('h', 'asked', '2099-01-01T00:00:00.000Z', 'active', ?)",
        )
        .run(JSON.stringify({ sessionId: "6f1d2c3b-0000-4000-8000-000000000001", reason: "sign-in" }));
      expect(summary().counts).toMatchObject({ questions: 0, handoffs: 1 });
      store.handle.prepare("UPDATE tavi_agent_wait_intents SET state = 'settled' WHERE wait_id = 'h'").run();
      expect(summary().counts).toMatchObject({ handoffs: 0 });
    } finally {
      store.close();
    }
  });

  it("names the people whose tasks fall in the window", () => {
    const { store, add, summary } = fixture();
    try {
      add("mine");
      add("hers", "2026-09-28T10:00:00.000Z", "default", "alice");
      add("long-ago", "2026-06-01T10:00:00.000Z", "default", "bob");
      add("elsewhere", NOW, "other", "carol");
      expect(summary().people).toEqual({ alice: "alice", operator: "operator" });
      expect(summary({ workspaceId: "other" }).people).toEqual({ carol: "carol" });
    } finally {
      store.close();
    }
  });

  it("names a person as the operator named them when allowing their sender, else by id", () => {
    const { store, port, add, summary } = fixture();
    try {
      add("mine");
      add("hers", NOW, "default", "alice");
      add("theirs", NOW, "other", "carol");
      const bind = (externalSenderId: string, workspaceId: string, principalId: string, displayName?: string) =>
        port.messagingIdentityBindings.bind({
          connectionId: "telegram-default",
          externalSenderId,
          workspaceId,
          principalId,
          approvedBy: "operator",
          createdAt: NOW,
          ...(displayName === undefined ? {} : { displayName }),
        });
      bind("42", "default", "alice", "Alice Smith");
      // A name another workspace gave is not this one's.
      bind("7", "other", "operator", "Someone else");
      expect(summary().people).toEqual({ alice: "Alice Smith", operator: "operator" });
      expect(port.messagingIdentityBindings.get("telegram-default", "42")).toMatchObject({ displayName: "Alice Smith" });
      // Binding the sender again with a new name renames them; without one keeps it.
      bind("42", "default", "alice", "Ali");
      bind("42", "default", "alice");
      expect(summary().people).toEqual({ alice: "Ali", operator: "operator" });
      expect(port.messagingIdentityBindings.list("default").map((binding) => binding.displayName)).toEqual(["Ali"]);
    } finally {
      store.close();
    }
  });

  it("keeps one name per person across their bindings, whichever binding is renamed", () => {
    const { store, port, add, summary } = fixture();
    try {
      add("hers", NOW, "default", "alice");
      const bind = (connectionId: string, externalSenderId: string, displayName: string, createdAt: string) =>
        port.messagingIdentityBindings.bind({
          connectionId,
          externalSenderId,
          workspaceId: "default",
          principalId: "alice",
          approvedBy: "operator",
          createdAt,
          displayName,
        });
      bind("telegram-default", "42", "Alice", "2026-09-01T00:00:00.000Z");
      bind("mailgun-default", "alice@example.com", "Ali", "2026-09-02T00:00:00.000Z");
      expect(summary().people).toEqual({ alice: "Ali" });
      // Renaming the older binding renames the person, not only that row.
      bind("telegram-default", "42", "Alice Smith", "2026-09-03T00:00:00.000Z");
      expect(summary().people).toEqual({ alice: "Alice Smith" });
      expect(port.messagingIdentityBindings.list("default").map((binding) => binding.displayName)).toEqual(["Alice Smith", "Alice Smith"]);
    } finally {
      store.close();
    }
  });
});

describe("routine agent pins", () => {
  it("names the routines that may still run each agent, by the revision they run", () => {
    const { store, port } = fixture();
    try {
      const routine = (id: string, name: string, status: string, active: number | null, latest: number, workspaceId = "default") =>
        store.handle
          .prepare(
            "INSERT INTO tavi_routines(routine_id,workspace_id,principal_id,name,version,active_revision,latest_revision,status,conversation_id,created_at,updated_at) VALUES(?,?,'operator',?,1,?,?,?,NULL,?,?)",
          )
          .run(id, workspaceId, name, active, latest, status, NOW, NOW);
      const revision = (id: string, revision: number, agentId: string) =>
        store.handle
          .prepare(
            "INSERT INTO tavi_routine_revisions(routine_id,revision,snapshot_json,hash,author,change_summary,created_at) VALUES(?,?,?,'h','operator','c',?)",
          )
          .run(
            id,
            revision,
            JSON.stringify({ agent: { agentId, name: agentId, instructions: "Pinned.", revision: 1, hash: "0".repeat(64) } }),
            NOW,
          );
      routine("r-news", "Morning news", "active", 1, 2);
      revision("r-news", 1, "chief");
      revision("r-news", 2, "editor");
      routine("r-draft", "Draft digest", "draft", null, 1);
      revision("r-draft", 1, "writer");
      routine("r-old", "Old digest", "archived", 1, 1);
      revision("r-old", 1, "chief");
      routine("r-there", "Elsewhere", "active", 1, 1, "other");
      revision("r-there", 1, "chief");
      expect(port.center.agentPins({ workspaceId: "default" })).toEqual([
        // The active revision is what runs, not a newer draft of it.
        { agentId: "writer", routineId: "r-draft", name: "Draft digest" },
        { agentId: "chief", routineId: "r-news", name: "Morning news" },
      ]);
      expect(port.center.agentPins({ workspaceId: "nobody" })).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("the memory service's operator view (once the center repository's)", () => {
  it("names the scopes the operator sees and counts other people's personal records per person", () => {
    const { store, add, memory, memoryService, operator } = fixture();
    try {
      const agent = (recordId: string, workspaceId: string | null, principalId = "operator") =>
        store.handle
          .prepare(
            "INSERT INTO tavi_memory_records(record_id,scope_key,scope_kind,principal_id,workspace_id,agent_id,kind,status,sensitivity,recorded_at,updated_at) VALUES (?,?,'personal_agent',?,?,'chief','fact','proposed','normal',?,?)",
          )
          .run(recordId, `personal_agent:${recordId}`, principalId, workspaceId, NOW, NOW);
      memory("shared", "shared_workspace", "default");
      memory("mine", "personal", null);
      memory("mine-here", "personal_workspace", "default");
      agent("agent-here", "default");
      agent("agent-anywhere", null);
      memory("scratch", "run_local", "default");
      memory("foreign", "shared_workspace", "other");
      memory("elsewhere", "personal_workspace", "other");
      memory("gone", "personal", null, "operator", "deleted");
      memory("alice-1", "personal_workspace", "default", "alice");
      memory("alice-2", "personal", null, "alice", "approved");
      agent("alice-3", "default", "alice");
      memory("bob-1", "personal", null, "bob");
      memory("carol-there", "personal_workspace", "other", "carol");
      // Memory naming no workspace counts only for people this workspace
      // knows: bob has a task here, alice is an allowed messaging sender, and
      // dave and carol belong to another workspace only.
      add("bob-task", NOW, "default", "bob");
      store.handle
        .prepare(
          "INSERT INTO tavi_messaging_identity_bindings(connection_id,external_sender_id,workspace_id,principal_id,approved_by,created_at) VALUES ('telegram','42','default','alice','operator',?)",
        )
        .run(NOW);
      add("dave-task", NOW, "other", "dave");
      memory("dave-1", "personal", null, "dave");
      memory("carol-anywhere", "personal", null, "carol");

      const view = memoryService.operatorView({ actor: operator });
      expect(view.scopes).toEqual([
        { scopeKey: "personal:mine", target: "personal" },
        { scopeKey: "personal_agent:agent-anywhere", target: "agent:chief" },
        { scopeKey: "personal_agent:agent-here", target: "agent:chief" },
        { scopeKey: "personal_workspace:mine-here", target: "workspace" },
        { scopeKey: "shared_workspace:shared", target: "shared" },
      ]);
      expect(view.otherPeople).toEqual([
        { principalId: "alice", count: 3 },
        { principalId: "bob", count: 1 },
      ]);
      // alice's second record is approved: two of hers wait for review.
      expect(view.otherProposals).toEqual([
        { principalId: "alice", count: 2 },
        { principalId: "bob", count: 1 },
      ]);
      // Without the binding, alice's memory naming no workspace is not this workspace's to count.
      store.handle.prepare("DELETE FROM tavi_messaging_identity_bindings").run();
      expect(memoryService.operatorView({ actor: operator }).otherPeople).toEqual([
        { principalId: "alice", count: 2 },
        { principalId: "bob", count: 1 },
      ]);
      // Filtered as the listing is.
      expect(memoryService.operatorView({ actor: operator, statuses: ["approved"] }).otherPeople).toEqual([]);
      // Proposals are counted whatever the statuses asked for, and filtered by kind.
      expect(memoryService.operatorView({ actor: operator, statuses: ["approved"] }).otherProposals).toEqual([
        { principalId: "alice", count: 2 },
        { principalId: "bob", count: 1 },
      ]);
      expect(memoryService.operatorView({ actor: operator, kinds: ["preference"] }).otherProposals).toEqual([]);
      expect(() => memoryService.operatorView({ actor: operator, statuses: ["deleted" as "approved"] })).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    } finally {
      store.close();
    }
  });
});

describe("the memory service's principals (once the center repository's)", () => {
  it("names every person with personal memory in the statuses, past the display cap", () => {
    const { store, add, memory, memoryService, operator } = fixture();
    try {
      for (let index = 0; index < MEMORY_OTHER_PEOPLE_LIMIT + 10; index += 1) {
        const principalId = `person-${String(index).padStart(3, "0")}`;
        add(`task-${principalId}`, NOW, "default", principalId);
        memory(`proposal-${principalId}`, "personal", null, principalId);
      }
      memory("rejected-here", "personal_workspace", "default", "erin", "rejected");
      memory("approved-here", "personal_workspace", "default", "frank", "approved");
      memory("stranger", "personal", null, "stranger");
      memory("scratch", "run_local", "default", "gina");
      const principals = memoryService.principals({ actor: operator, statuses: ["proposed", "rejected", "expired"] });
      expect(principals).toHaveLength(MEMORY_OTHER_PEOPLE_LIMIT + 11);
      expect(principals).toContain("erin");
      expect(principals).toContain("person-059");
      expect(principals).not.toContain("frank");
      expect(principals).not.toContain("stranger");
      expect(principals).not.toContain("gina");
    } finally {
      store.close();
    }
  });
});
