import { describe, expect, it } from "vitest";
import type { MemoryActor, MemoryScope } from "@tavi/contracts";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * The port's reads: what the operator's
 * page, the Center rail, the session list, the retention sweep and the
 * digest read through `MemoryServicePort` instead of SQL of their own. The
 * operator view (`view: "operator"`) spans every scope `operatorSeesMemory`
 * admits, every agent's among them, and the operator's chat notes; another
 * person's record is `NOT_FOUND` there as anywhere.
 */

const AT = "2026-10-11T08:00:00.000Z";

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  let counter = 0;
  const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
  return { store, service };
}

const operator: MemoryActor = { principalId: "operator", workspaceId: "w1", caller: "test", authority: "operator" };
const asAgent = (agentId: string): MemoryActor => ({ ...operator, agentId });
const inChat = (runId: string): MemoryActor => ({ ...operator, runId });
const model: MemoryActor = { ...operator, authority: "model" };
const personal: MemoryScope = { kind: "personal", principalId: "operator" };
const workspace: MemoryScope = { kind: "personal_workspace", principalId: "operator", workspaceId: "w1" };
const agentScope: MemoryScope = { kind: "personal_agent", principalId: "operator", agentId: "chief", workspaceId: "w1" };
const chat = (runId: string): MemoryScope => ({ kind: "run_local", principalId: "operator", workspaceId: "w1", runId });
const view = { actor: operator, view: "operator" } as const;

describe("the memory port's operator view", () => {
  it("reads every scope of the operator's page, an agent's among them, and nothing of another person's", () => {
    const { store, service } = fixture();
    try {
      const mine = service.remember({ actor: operator, scope: personal, kind: "fact", body: "Lives in Lisbon" });
      const chief = service.remember({ actor: asAgent("chief"), scope: agentScope, kind: "lesson", body: "Lead with the answer" });
      const note = service.remember({
        actor: inChat("t1"),
        scope: chat("t1"),
        kind: "fact",
        body: "The budget is 40k",
        durable: true,
        originTaskId: "t1",
      });
      const scratch = service.remember({ actor: inChat("t1"), scope: chat("t1"), kind: "fact", body: "Working memory" });
      const alice = { ...operator, principalId: "alice" };
      const theirs = service.remember({ actor: alice, scope: { kind: "personal", principalId: "alice" }, kind: "fact", body: "Alice's" });

      // The actor's own read of an agent's scope needs that agent; the operator's page does not.
      expect(() => service.get({ actor: operator, recordId: chief.recordId })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(service.get({ ...view, recordId: chief.recordId }).recordId).toBe(chief.recordId);
      expect(service.get({ ...view, recordId: note.recordId }).recordId).toBe(note.recordId);
      for (const hidden of [scratch, theirs]) {
        expect(() => service.get({ ...view, recordId: hidden.recordId })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
        expect(() => service.history({ ...view, recordId: hidden.recordId })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      }

      const page = service.operatorView({ actor: operator });
      expect(page.scopes.map((scope) => scope.target).sort()).toEqual(["agent:chief", "personal"]);
      expect(page.otherPeople).toEqual([]);
      const listed = service.list({ ...view });
      expect(listed.map((record) => record.recordId).sort()).toEqual([chief.recordId, mine.recordId].sort());
      // Narrowed to one of the page's scopes by key; a key outside them reads nothing.
      const personalKey = page.scopes.find((scope) => scope.target === "personal")?.scopeKey ?? "";
      expect(service.list({ ...view, scopeKeys: [personalKey] }).map((record) => record.recordId)).toEqual([mine.recordId]);
      expect(service.list({ ...view, scopeKeys: ["personal|p=alice"] })).toEqual([]);
      // A chat's notes when the chat is named, never its working memory; every chat's notes alone.
      expect(service.list({ ...view, scopeKeys: [], chats: ["t1"] }).map((record) => record.recordId)).toEqual([note.recordId]);
      expect(service.list({ ...view, chatNotes: true }).map((record) => record.recordId)).toEqual([note.recordId]);
      expect(service.list({ ...view, originTaskId: "t1", chats: ["t1"], scopeKeys: [] }).map((record) => record.recordId)).toEqual([
        note.recordId,
      ]);
      // Usage over the page's scopes: the agent's record counts, the chat's do not.
      expect(service.usage({ ...view }).records).toBe(2);
    } finally {
      store.close();
    }
  });

  it("searches the page with sensitive records included, and says a failed index is unavailable", () => {
    const { store, service } = fixture();
    try {
      const plain = service.remember({ actor: operator, scope: workspace, kind: "fact", body: "Flies to Porto on Friday" });
      const sensitive = service.remember({
        actor: operator,
        scope: personal,
        kind: "fact",
        body: "Porto clinic appointment",
        sensitivity: "sensitive",
      });
      const found = service.search({ ...view, query: "Porto" });
      expect(found.coverage).toBe("complete");
      expect(found.hits.map((hit) => hit.recordId).sort()).toEqual([plain.recordId, sensitive.recordId].sort());
      // Automatic recall leaves the sensitive one out, as before.
      expect(service.search({ actor: operator, query: "Porto" }).hits.map((hit) => hit.recordId)).toEqual([plain.recordId]);
      // Narrowed by key, and only the operator's view takes keys.
      const key = service.operatorView({ actor: operator }).scopes.find((scope) => scope.target === "workspace")?.scopeKey ?? "";
      expect(service.search({ ...view, query: "Porto", scopeKeys: [key] }).hits.map((hit) => hit.recordId)).toEqual([plain.recordId]);
      expect(() => service.search({ actor: operator, query: "Porto", scopeKeys: [key] })).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
      store.handle.exec("DROP TABLE tavi_memory_fts");
      expect(service.search({ ...view, query: "Porto" }).coverage).toBe("unavailable");
    } finally {
      store.close();
    }
  });

  it("answers a record's history, and what a waiting proposal updates or is similar to", () => {
    const { store, service } = fixture();
    try {
      const kept = service.remember({
        actor: operator,
        scope: personal,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "brief" },
        body: "Prefers brief answers",
      });
      const update = service.propose({
        actor: model,
        scope: personal,
        kind: "preference",
        preferenceKey: "tone",
        preference: { valueType: "string", value: "warm" },
        body: "Prefers warm answers",
      });
      const similar = service.remember({ actor: operator, scope: personal, kind: "fact", body: "Travels to Lisbon every spring for work" });
      const near = service.propose({ actor: model, scope: personal, kind: "fact", body: "Travels to Lisbon every spring for work trips" });

      const history = service.history({ ...view, recordId: kept.recordId });
      expect(history.revisions.map((revision) => revision.revisionId)).toEqual([kept.currentRevisionId]);
      expect(history.reviews.map((review) => review.decision)).toEqual(["approved"]);
      expect(service.related({ ...view, recordId: update.recordId })).toEqual({
        updates: { recordId: kept.recordId, title: "Prefers brief answers", currentRevisionId: kept.currentRevisionId },
      });
      expect(service.related({ ...view, recordId: near.recordId })).toMatchObject({ similarTo: { recordId: similar.recordId } });
      // A record that does not wait is related to nothing.
      expect(service.related({ ...view, recordId: kept.recordId })).toEqual({});
      // A worker granted only the proposal reads it, and no neighbour from the scope it was never granted.
      const worker: MemoryActor = { ...model, scopeRestricted: true, allowedRecordIds: [update.recordId] };
      expect(service.get({ actor: worker, recordId: update.recordId }).recordId).toBe(update.recordId);
      expect(service.related({ actor: worker, recordId: update.recordId })).toEqual({});
    } finally {
      store.close();
    }
  });

  it("counts the rail's proposals and each chat's notes, and names the workspace's people", () => {
    const { store, service } = fixture();
    try {
      service.propose({ actor: model, scope: personal, kind: "fact", body: "One" });
      service.propose({ actor: model, scope: workspace, kind: "fact", body: "Two" });
      service.remember({ actor: inChat("t1"), scope: chat("t1"), kind: "fact", body: "Note", durable: true });
      service.propose({ actor: { ...model, runId: "t1" }, scope: chat("t1"), kind: "fact", body: "Proposed note", durable: true });
      service.remember({ actor: inChat("t2"), scope: chat("t2"), kind: "fact", body: "Scratch" });
      const alice = { ...operator, principalId: "alice" };
      service.propose({
        actor: { ...alice, authority: "model" },
        scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "w1" },
        kind: "fact",
        body: "Alice's",
      });

      // Run-local proposals are not the rail's; another person's are not this operator's.
      expect(service.counts({ actor: operator, taskIds: ["t1", "t2", "t3"] })).toEqual({ proposed: 2, chatNotes: { t1: 2 } });
      expect(service.counts({ actor: operator })).toEqual({ proposed: 2, chatNotes: {} });
      expect(service.principals({ actor: operator, statuses: ["proposed"] })).toEqual(["alice", "operator"]);
      expect(service.operatorView({ actor: operator }).otherProposals).toEqual([{ principalId: "alice", count: 1 }]);
    } finally {
      store.close();
    }
  });

  it("is the operator's: a model reads no operator view, counts or people", () => {
    const { store, service } = fixture();
    try {
      const record = service.remember({ actor: operator, scope: personal, kind: "fact", body: "Kept" });
      for (const call of [
        () => service.get({ actor: model, recordId: record.recordId, view: "operator" }),
        () => service.list({ actor: model, view: "operator" }),
        () => service.search({ actor: model, query: "Kept", view: "operator" }),
        () => service.usage({ actor: model, view: "operator" }),
        () => service.operatorView({ actor: model }),
        () => service.counts({ actor: model }),
        () => service.principals({ actor: model, statuses: ["proposed"] }),
      ]) {
        expect(call).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
      }
      // An operator actor carrying a restriction (a group turn, a delegated worker) reads none of it either.
      for (const restricted of [
        { ...operator, reach: "chat-only" },
        { ...operator, scopeRestricted: true },
        { ...operator, allowedRecordIds: [record.recordId] },
      ] satisfies MemoryActor[]) {
        for (const call of [
          () => service.get({ actor: restricted, recordId: record.recordId, view: "operator" }),
          () => service.history({ actor: restricted, recordId: record.recordId, view: "operator" }),
          () => service.related({ actor: restricted, recordId: record.recordId, view: "operator" }),
          () => service.list({ actor: restricted, view: "operator" }),
          () => service.search({ actor: restricted, query: "Kept", view: "operator" }),
          () => service.usage({ actor: restricted, view: "operator" }),
          () => service.operatorView({ actor: restricted }),
          () => service.counts({ actor: restricted }),
          () => service.principals({ actor: restricted, statuses: ["proposed"] }),
        ]) {
          expect(call).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
        }
      }
      // Chats and every chat's notes narrow the operator's view only; a scope is the actor's.
      expect(() => service.list({ actor: operator, chats: ["t1"] })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => service.list({ actor: operator, chatNotes: true })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => service.list({ ...view, scope: personal })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => service.list({ ...view, chatNotes: true, chats: ["t1"] })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(() => service.counts({ actor: operator, taskIds: Array.from({ length: 501 }, (_, index) => `t${index}`) })).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    } finally {
      store.close();
    }
  });
});
