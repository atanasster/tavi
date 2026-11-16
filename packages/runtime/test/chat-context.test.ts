import { CHAT_INSTRUCTIONS_MAX, allChatNotesKey, type MemoryActor, type MemoryScope } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore, countChatNotesSql } from "../src/persistence/store.js";

/**
 * A chat's own context: its instructions' revisions and the revision each
 * turn is admitted under, and chat notes — durable run-local memory a
 * delegated task may read but no sweep erases.
 */

const AT = "2026-10-01T10:00:00.000Z";

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const { tasks, chatInstructions } = store.asPort().repositories;
  const start = (id: string, chat?: string) =>
    tasks.admit({
      workspaceId: "w1",
      principalId: "alice",
      operationKey: id,
      kind: "start",
      intent: { prompt: "p" },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => AT,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${id}`,
      ...(chat === undefined ? {} : { chatInstructions: { text: chat, author: "operator:ui" } }),
    });
  const next = (id: string, key: string, kind: "reply" | "approval" | "deadline") =>
    tasks.admit({
      workspaceId: "w1",
      principalId: "alice",
      taskId: id,
      operationKey: key,
      kind,
      intent: kind === "reply" ? { prompt: key } : { key },
      checkpointNamespace: "",
      now: () => AT,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${key}`,
    });
  return { store, tasks, chatInstructions, start, next };
}

describe("a chat's instructions", () => {
  it("saves each revision under a compare-and-set, and lists them newest first", () => {
    const { store, chatInstructions, start } = fixture();
    start("t1");
    expect(chatInstructions.current("t1")).toBeUndefined();
    expect(
      chatInstructions.record({ taskId: "t1", text: "Answer in French.", author: "operator:ui", expectedRevision: 0, now: AT }),
    ).toMatchObject({ revision: 1, text: "Answer in French." });
    // A writer who read revision 0 is told it changed, with the revision now current and never the text.
    try {
      chatInstructions.record({ taskId: "t1", text: "Stale", author: "operator:cli", expectedRevision: 0, now: AT });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFLICT", details: { currentRevision: 1, expectedRevision: 0 } });
      expect(JSON.stringify((error as { details?: unknown }).details)).not.toContain("French");
    }
    chatInstructions.record({ taskId: "t1", text: "", author: "operator:ui", expectedRevision: 1, now: AT });
    expect(chatInstructions.current("t1")).toMatchObject({ revision: 2, text: "" });
    expect(chatInstructions.history("t1", 10).map((item) => item.revision)).toEqual([2, 1]);
    expect(chatInstructions.get("t1", 1)?.text).toBe("Answer in French.");
    expect(() => chatInstructions.record({ taskId: "nope", text: "x", author: "operator:ui", expectedRevision: 0, now: AT })).toThrow(
      /does not exist/,
    );
    expect(() =>
      chatInstructions.record({
        taskId: "t1",
        text: "x".repeat(CHAT_INSTRUCTIONS_MAX + 1),
        author: "operator:ui",
        expectedRevision: 2,
        now: AT,
      }),
    ).toThrow(/at most/);
    store.close();
  });

  it("pins a prompt to the revision current when it is admitted, and keeps it for the rest of its turn", () => {
    const { store, chatInstructions, start, next } = fixture();
    // Started with instructions: its first turn has them.
    expect(start("t1", "Be brief.").admission.instructionsRevision).toBe(1);
    expect(chatInstructions.forAdmission("admission-t1")?.text).toBe("Be brief.");
    // The first turn suspends on an approval; the reader edits the instructions,
    // and a follow-up is queued behind the paused turn under the new revision.
    const suspend = (admissionId: string) =>
      store.handle
        .prepare("UPDATE tavi_admissions SET state = 'committed', result = ? WHERE admission_id = ?")
        .run(JSON.stringify({ status: "waiting", finalText: "" }), admissionId);
    suspend("admission-t1");
    chatInstructions.record({ taskId: "t1", text: "Be thorough.", author: "operator:ui", expectedRevision: 1, now: AT });
    expect(next("t1", "reply-1", "reply").admission.instructionsRevision).toBe(2);
    expect(chatInstructions.forAdmission("admission-reply-1")?.text).toBe("Be thorough.");
    // The approval resumes the paused turn, under the revision that turn started with, not the queued prompt's…
    expect(next("t1", "approve-1", "approval").admission.instructionsRevision).toBe(1);
    // …and so does a later resume of the same turn.
    suspend("admission-approve-1");
    expect(next("t1", "deadline-1", "deadline").admission.instructionsRevision).toBe(1);
    // The revision is read back with the admission.
    expect(store.asPort().repositories.tasks.getAdmission("t1", "reply-1")?.instructionsRevision).toBe(2);
    expect(() => chatInstructions.record({ taskId: "t1", text: "x", author: "", expectedRevision: 2, now: AT })).toThrow(/1 to 256/);
    expect(() => chatInstructions.record({ taskId: "t1", text: "x", author: "operator:ui", expectedRevision: -1, now: AT })).toThrow(
      /non-negative/,
    );
    store.close();
  });

  it("leaves a chat without instructions unpinned, and does not count blank instructions as a revision", () => {
    const { store, chatInstructions, start, next } = fixture();
    expect(start("t1", "   ").admission.instructionsRevision).toBeUndefined();
    expect(chatInstructions.current("t1")).toBeUndefined();
    expect(next("t1", "reply-1", "reply").admission.instructionsRevision).toBeUndefined();
    expect(chatInstructions.forAdmission("admission-reply-1")).toBeUndefined();
    store.close();
  });
});

describe("chat notes", () => {
  const actor = (runId: string, extra: Partial<MemoryActor> = {}): MemoryActor => ({
    principalId: "alice",
    workspaceId: "w1",
    runId,
    caller: "cli",
    authority: "operator",
    ...extra,
  });
  const chatScope = (runId: string): MemoryScope => ({ kind: "run_local", principalId: "alice", workspaceId: "w1", runId });

  function memory() {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    let counter = 0;
    const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
    return { store, service };
  }

  it("keeps a chat note and where a record came from, and refuses a durable record outside a chat", () => {
    const { store, service } = memory();
    const note = service.remember({
      actor: actor("chat-1"),
      scope: chatScope("chat-1"),
      kind: "fact",
      body: "The site is shop.example.com",
      durable: true,
      originTaskId: "chat-1",
    });
    expect(note).toMatchObject({ durable: true, originTaskId: "chat-1" });
    const learned = service.remember({
      actor: actor("chat-1"),
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Prefers metric",
      originTaskId: "chat-1",
    });
    expect(learned.originTaskId).toBe("chat-1");
    expect(learned.durable).toBeUndefined();
    expect(() =>
      service.propose({
        actor: actor("chat-1"),
        scope: { kind: "personal", principalId: "alice" },
        kind: "fact",
        body: "x",
        durable: true,
      }),
    ).toThrow(/chat note/);
    store.close();
  });

  it("is never swept with the run's working memory", () => {
    const { store, service } = memory();
    const note = service.remember({ actor: actor("chat-1"), scope: chatScope("chat-1"), kind: "fact", body: "Keep me", durable: true });
    const working = service.remember({ actor: actor("chat-1"), scope: chatScope("chat-1"), kind: "fact", body: "Scratch" });
    const later = new MemoryService(store.asPort(), { now: () => "2026-11-01T00:00:00.000Z" });
    expect(later.sweepExpired({ actor: actor("chat-1") }).map((item) => item.recordId)).toEqual([working.recordId]);
    expect(service.get({ actor: actor("chat-1"), recordId: note.recordId }).status).toBe("approved");
    store.close();
  });

  it("lists every chat's notes of one person in one workspace exactly, whatever their ids hold", () => {
    const { store, service } = memory();
    const as = (principalId: string, workspaceId: string, runId: string): MemoryActor => ({
      principalId,
      workspaceId,
      runId,
      caller: "cli",
      authority: "operator",
    });
    const note = (principalId: string, workspaceId: string, runId: string, body: string) =>
      service.remember({
        actor: as(principalId, workspaceId, runId),
        scope: { kind: "run_local", principalId, workspaceId, runId },
        kind: "fact",
        body,
        durable: true,
      });
    const mine = [note("alice", "w1", "chat-1", "Alice note one"), note("alice", "w1", "chat-2", "Alice note two")];
    // Ids whose keys share Alice's text prefix: another person, and Alice in another workspace.
    note("alice|w=w1|r=x", "w2", "chat-3", "Alice note lookalike");
    note("alice", "w1|r=x", "chat-4", "Alice note elsewhere");
    service.remember({
      actor: as("alice", "w1", "chat-1"),
      scope: { kind: "run_local", principalId: "alice", workspaceId: "w1", runId: "chat-1" },
      kind: "fact",
      body: "Alice note scratch",
    });
    const repository = store.asPort().repositories.memory;
    const key = allChatNotesKey("alice", "w1");
    expect(
      repository
        .listRecords({ scopeKeys: [key], limit: 10 })
        .map((record) => record.recordId)
        .sort(),
    ).toEqual(mine.map((record) => record.recordId).sort());
    expect(
      repository
        .search({ scopeKeys: [key], query: "Alice", limit: 10, now: AT })
        .map((hit) => hit.record.recordId)
        .sort(),
    ).toEqual(mine.map((record) => record.recordId).sort());
    expect(() => repository.listRecords({ scopeKeys: ["chat-notes:*not json"], limit: 10 })).toThrow(/Unreadable/);
    store.close();
  });

  it("is read by a task delegated from the chat, which never sees the chat's working memory", () => {
    const { store, service } = memory();
    const note = service.remember({
      actor: actor("chat-1"),
      scope: chatScope("chat-1"),
      kind: "fact",
      body: "The client is called Acme",
      durable: true,
    });
    const working = service.remember({ actor: actor("chat-1"), scope: chatScope("chat-1"), kind: "fact", body: "Acme draft scratch" });
    const worker = actor("worker-1", { authority: "model", scopeRestricted: true, chatTaskId: "chat-1" });
    expect(service.list({ actor: worker, limit: 10 }).map((record) => record.recordId)).toEqual([note.recordId]);
    expect(service.search({ actor: worker, query: "Acme", limit: 10 }).hits.map((hit) => hit.recordId)).toEqual([note.recordId]);
    expect(service.get({ actor: worker, recordId: note.recordId }).recordId).toBe(note.recordId);
    expect(() => service.get({ actor: worker, recordId: working.recordId })).toThrow(/does not exist/);
    // Another chat's delegate reads neither.
    expect(
      service.list({ actor: actor("worker-2", { authority: "model", scopeRestricted: true, chatTaskId: "chat-2" }), limit: 10 }),
    ).toEqual([]);
    store.close();
  });

  it("is read by a side chat opened from the chat, besides its own, never its working memory nor its parent's parent's", () => {
    const { store, service } = memory();
    const parentNote = service.remember({
      actor: actor("chat-1"),
      scope: chatScope("chat-1"),
      kind: "fact",
      body: "The client is called Acme",
      durable: true,
    });
    service.remember({ actor: actor("chat-1"), scope: chatScope("chat-1"), kind: "fact", body: "Acme draft scratch" });
    service.remember({ actor: actor("chat-0"), scope: chatScope("chat-0"), kind: "fact", body: "Acme grandparent note", durable: true });
    const own = service.remember({
      actor: actor("side-1"),
      scope: chatScope("side-1"),
      kind: "fact",
      body: "Acme side note",
      durable: true,
    });
    const side = actor("side-1", { authority: "model", parentChatId: "chat-1" });
    expect(
      service
        .search({ actor: side, query: "Acme", limit: 10 })
        .hits.map((hit) => hit.recordId)
        .sort(),
    ).toEqual([parentNote.recordId, own.recordId].sort());
    expect(service.get({ actor: side, recordId: parentNote.recordId }).recordId).toBe(parentNote.recordId);
    // Read, never written: the parent's notes are the parent's.
    expect(() =>
      service.remember({ actor: side, scope: chatScope("chat-1"), kind: "fact", body: "Acme from the side", durable: true }),
    ).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
    expect(() =>
      service.propose({ actor: side, scope: chatScope("chat-1"), kind: "fact", body: "Acme from the side", durable: true }),
    ).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
    // Without a parent, a chat reads its own notes alone.
    expect(
      service.search({ actor: actor("side-1", { authority: "model" }), query: "Acme", limit: 10 }).hits.map((hit) => hit.recordId),
    ).toEqual([own.recordId]);
    store.close();
  });
});

describe("what a chat used", () => {
  it("notes each record once per chat, moves its last use on, lists the most recent first, and goes with the task", () => {
    const { store, start } = fixture();
    start("t1");
    const { memoryUse } = store.asPort().repositories;
    memoryUse.record({ taskId: "t1", admissionId: "a1", recordIds: ["m1", "m2", "m1"], at: "2026-10-01T10:00:00.000Z" });
    memoryUse.record({ taskId: "t1", admissionId: "a2", recordIds: ["m1"], at: "2026-10-01T11:00:00.000Z" });
    memoryUse.record({ taskId: "t1", admissionId: "a3", recordIds: [], at: "2026-10-01T12:00:00.000Z" });
    expect(memoryUse.list("t1", 10)).toEqual([
      {
        taskId: "t1",
        recordId: "m1",
        firstUsedAt: "2026-10-01T10:00:00.000Z",
        lastUsedAt: "2026-10-01T11:00:00.000Z",
        lastAdmissionId: "a2",
      },
      {
        taskId: "t1",
        recordId: "m2",
        firstUsedAt: "2026-10-01T10:00:00.000Z",
        lastUsedAt: "2026-10-01T10:00:00.000Z",
        lastAdmissionId: "a1",
      },
    ]);
    expect(memoryUse.list("t1", 1).map((use) => use.recordId)).toEqual(["m1"]);
    expect(() => memoryUse.list("t1", 0)).toThrow(/positive/);
    store.handle.pragma("foreign_keys = ON");
    store.handle.prepare("DELETE FROM tavi_tasks WHERE task_id = 't1'").run();
    expect(memoryUse.list("t1", 10)).toEqual([]);
    store.close();
  });
});

describe("a chat's name", () => {
  it("shows the reader's name before the generated title, which the summarizer keeps writing, and goes back to it", () => {
    const { store, start } = fixture();
    start("t1");
    const { taskSummaries, tasks } = store.asPort().repositories;
    store.handle.prepare("UPDATE tavi_tasks SET title = 'Generated title' WHERE task_id = 't1'").run();
    taskSummaries.rename({ taskId: "t1", title: "  Site audit  " });
    expect(tasks.get("t1")).toMatchObject({ title: "Site audit", titleRenamed: true });
    expect(store.listTaskSessions({ workspaceId: "w1" }).rows[0]).toMatchObject({ title: "Site audit", titleSource: "reader" });
    // Found by its name, and named so wherever a task's title is shown.
    expect(store.listTaskSessions({ workspaceId: "w1", query: "site aud" }).rows.map((row) => row.taskId)).toEqual(["t1"]);
    const history = store.asPort().repositories.browserHistory;
    history.open({ sessionId: "b1", workspaceId: "w1", taskId: "t1", openedAt: AT });
    expect(history.sessions({ workspaceId: "w1", limit: 5 })[0]?.taskTitle).toBe("Site audit");
    // A later summary changes the generated title, not the reader's name.
    store.handle.prepare("UPDATE tavi_tasks SET title = 'Newer generated' WHERE task_id = 't1'").run();
    expect(tasks.get("t1")?.title).toBe("Site audit");
    taskSummaries.rename({ taskId: "t1", title: null });
    expect(tasks.get("t1")).toMatchObject({ title: "Newer generated" });
    expect(tasks.get("t1")?.titleRenamed).toBeUndefined();
    expect(() => taskSummaries.rename({ taskId: "t1", title: "   " })).toThrow(/1 to 120/);
    expect(() => taskSummaries.rename({ taskId: "t1", title: "x".repeat(121) })).toThrow(/1 to 120/);
    expect(() => taskSummaries.rename({ taskId: "nope", title: "x" })).toThrow(/does not exist/);
    store.close();
  });
});

describe("a chat's marks in the session list", () => {
  it("says which chats have instructions in force and how many notes they keep", () => {
    const { store, chatInstructions, start } = fixture();
    start("t1");
    start("t2");
    start("t3");
    chatInstructions.record({ taskId: "t1", text: "Be brief.", author: "operator:ui", expectedRevision: 0, now: AT });
    // Cleared instructions are not in force.
    chatInstructions.record({ taskId: "t3", text: "Old", author: "operator:ui", expectedRevision: 0, now: AT });
    chatInstructions.record({ taskId: "t3", text: "", author: "operator:ui", expectedRevision: 1, now: AT });
    let counter = 0;
    const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
    const actor: MemoryActor = { principalId: "alice", workspaceId: "w1", runId: "t2", caller: "cli", authority: "operator" };
    const scope: MemoryScope = { kind: "run_local", principalId: "alice", workspaceId: "w1", runId: "t2" };
    service.remember({ actor, scope, kind: "fact", body: "One", durable: true });
    service.remember({ actor, scope, kind: "fact", body: "Two", durable: true });
    // The chat's working memory is not a note.
    service.remember({ actor, scope, kind: "fact", body: "Scratch" });
    const rows = new Map(store.listTaskSessions({ workspaceId: "w1" }).rows.map((row) => [row.taskId, row]));
    expect(rows.get("t1")).toMatchObject({ chatInstructions: true });
    expect(rows.get("t2")?.chatInstructions).toBeUndefined();
    // Notes are counted by the memory service after the page query; the list reads no memory table.
    expect(rows.get("t2")?.chatNotes).toBeUndefined();
    expect(service.counts({ actor, taskIds: [...rows.keys()] }).chatNotes).toEqual({ t2: 2 });
    expect(rows.get("t3")?.chatInstructions).toBeUndefined();
    store.close();
  });

  it("counts the operator's notes through the memory service, proposed ones too, never forgotten ones, and treats whitespace-only instructions as blank", () => {
    const { store, chatInstructions, start } = fixture();
    start("t1");
    chatInstructions.record({ taskId: "t1", text: "\n\t \n", author: "operator:ui", expectedRevision: 0, now: AT });
    let counter = 0;
    const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
    const as = (principalId: string): MemoryActor => ({
      principalId,
      workspaceId: "w1",
      runId: "t1",
      caller: "cli",
      authority: "operator",
    });
    const scope = (principalId: string): MemoryScope => ({ kind: "run_local", principalId, workspaceId: "w1", runId: "t1" });
    service.remember({ actor: as("operator"), scope: scope("operator"), kind: "fact", body: "Kept", durable: true });
    service.propose({ actor: as("operator"), scope: scope("operator"), kind: "fact", body: "Proposed", durable: true });
    const gone = service.remember({ actor: as("operator"), scope: scope("operator"), kind: "fact", body: "Gone", durable: true });
    service.forget({ actor: as("operator"), recordId: gone.recordId, reason: "test" });
    // The task's own principal keeps a note the operator's page cannot open.
    service.remember({ actor: as("alice"), scope: scope("alice"), kind: "fact", body: "Alice's", durable: true });
    const row = store.listTaskSessions({ workspaceId: "w1" }).rows[0];
    expect(service.counts({ actor: as("operator"), taskIds: ["t1"] }).chatNotes).toEqual({ t1: 2 });
    expect(row?.chatInstructions).toBeUndefined();
    expect(service.counts({ actor: as("alice"), taskIds: ["t1"] }).chatNotes).toEqual({ t1: 1 });
    const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${countChatNotesSql(2)}`).all("operator", "w1", "t1", "t2") as {
      detail: string;
    }[];
    expect(plan.map((step) => step.detail).join(" ")).toContain("tavi_memory_chat_notes_idx");
    store.close();
  });
});
