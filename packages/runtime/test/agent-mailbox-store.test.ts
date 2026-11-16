import { join } from "node:path";

import { TRUSTED_PUBLIC, UNTRUSTED_UNKNOWN_SOURCE, untrustedLabel, type AgentMailboxEnvelopeRecord } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Agent mailbox/wait/delegation persistence.
 *
 * The properties under test: an envelope round-trips through insert/read
 * (every optional field, not just the ones other assertions happen to
 * cover); `claim` atomically leases a bounded batch and `acknowledge` only
 * settles envelopes still under that exact lease; a `waitFor` intent moves
 * through its prepared -> active -> settled states, and `settle` is a
 * conditional transition that never re-settles an already-settled wait; a
 * spawn's idempotency key resolves the same worker on a repeated lookup;
 * and every task-scoped table's foreign key into `tavi_tasks` is actually
 * enforced, not merely declared.
 */

const AT = "2026-01-01T00:00:00.000Z";

// A real temp directory, not `:memory:`, so `putArtifact` works for the
// artifactId round-trip test (matching `skill-service.test.ts`'s own
// artifact fixture pattern — an in-memory store has no artifacts directory).
const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function fixture(): { readonly store: SqliteStore } {
  const directory = directories.create("tavi-agent-mailbox-");
  const store = new SqliteStore({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  return { store };
}

/** Creates a real, addressable task row so FK-constrained inserts (mailbox/wait/delegation) succeed. */
function createTask(store: SqliteStore, taskId: string, workspaceId = "w1"): void {
  store.asPort().repositories.tasks.admit({
    workspaceId,
    principalId: "operator",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: () => taskId,
    newAdmissionId: () => `adm-${taskId}`,
    newThreadId: () => `thread-${taskId}`,
    now: () => AT,
  });
}

function envelope(overrides: Partial<AgentMailboxEnvelopeRecord> = {}): AgentMailboxEnvelopeRecord {
  return {
    messageId: "m1",
    protocolVersion: 1,
    workspaceId: "w1",
    senderAgentId: "orchestrator",
    senderTaskId: "t-orchestrator",
    recipientAgentId: "worker-1",
    recipientTaskId: "t-worker-1",
    kind: "message" as const,
    createdAt: AT,
    deliveryState: "pending" as const,
    retentionState: "active" as const,
    ...overrides,
  };
}

describe("agent mailbox", () => {
  it("round-trips an envelope through insert and read", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(envelope({ content: "hello worker" }));
    const stored = mailbox.getEnvelope("m1");
    expect(stored?.content).toBe("hello worker");
    expect(stored?.deliveryState).toBe("pending");
    expect(stored?.retentionState).toBe("active");
  });

  it("keeps an envelope's sender label; one from before labels has none, and one that no longer parses reads untrusted", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    const web = untrustedLabel("web", { principal: "host:news.example", ref: { ref: "c1", host: "news.example", at: AT } });
    mailbox.insertEnvelope(envelope({ messageId: "m-web", content: "a page said", label: web }));
    mailbox.insertEnvelope(envelope({ messageId: "m-clean", content: "clean", label: TRUSTED_PUBLIC }));
    mailbox.insertEnvelope(envelope({ messageId: "m-old", content: "old" }));
    mailbox.insertEnvelope(envelope({ messageId: "m-bad", content: "bad" }));
    store.handle.prepare("UPDATE tavi_agent_mailbox SET label_json = ? WHERE message_id = ?").run('{"integrity":"maybe"}', "m-bad");
    expect(mailbox.getEnvelope("m-web")?.label).toEqual(web);
    expect(mailbox.getEnvelope("m-clean")?.label).toEqual(TRUSTED_PUBLIC);
    expect(mailbox.getEnvelope("m-old")?.label).toBeUndefined();
    expect(mailbox.getEnvelope("m-bad")?.label).toEqual(UNTRUSTED_UNKNOWN_SOURCE);
  });

  it("round-trips causationId, expiresAt and artifactId", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const artifact = store.putArtifact({ workspaceId: "w1", contentType: "text/plain", body: "offloaded content" });
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(
      envelope({
        messageId: "m-full",
        causationId: "cause-1",
        expiresAt: "2026-01-02T00:00:00.000Z",
        artifactId: artifact.artifactId,
      }),
    );
    const stored = mailbox.getEnvelope("m-full");
    expect(stored?.causationId).toBe("cause-1");
    expect(stored?.expiresAt).toBe("2026-01-02T00:00:00.000Z");
    expect(stored?.artifactId).toBe(artifact.artifactId);
  });

  it("lists only pending envelopes for a task, oldest first", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(envelope({ messageId: "m1", createdAt: "2026-01-01T00:00:01.000Z" }));
    mailbox.insertEnvelope(envelope({ messageId: "m2", createdAt: "2026-01-01T00:00:00.000Z" }));
    mailbox.insertEnvelope(envelope({ messageId: "m3", deliveryState: "acknowledged" }));
    const pending = mailbox.listPending("t-worker-1", 10);
    expect(pending.map((e) => e.messageId)).toEqual(["m2", "m1"]);
  });

  it("claim atomically leases a bounded batch, and acknowledge only settles envelopes still under that lease", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(envelope({ messageId: "m1" }));
    mailbox.insertEnvelope(envelope({ messageId: "m2" }));
    mailbox.insertEnvelope(envelope({ messageId: "m3" }));

    const claimed = mailbox.claim({ taskId: "t-worker-1", limit: 2, leaseId: "lease-1", leaseExpiresAt: "2026-01-01T00:05:00.000Z" });
    expect(claimed).toHaveLength(2);
    expect(claimed.every((e) => e.deliveryState === "delivered" && e.leaseId === "lease-1")).toBe(true);
    // The third envelope is untouched by this claim.
    expect(mailbox.getEnvelope("m3")?.deliveryState).toBe("pending");

    // A stale lease id cannot acknowledge what a different (later) lease claimed.
    mailbox.acknowledge({ taskId: "t-worker-1", leaseId: "wrong-lease", messageIds: claimed.map((e) => e.messageId) });
    expect(mailbox.getEnvelope(claimed[0]?.messageId ?? "")?.deliveryState).toBe("delivered");

    mailbox.acknowledge({ taskId: "t-worker-1", leaseId: "lease-1", messageIds: claimed.map((e) => e.messageId) });
    for (const e of claimed) {
      const after = mailbox.getEnvelope(e.messageId);
      expect(after?.deliveryState).toBe("acknowledged");
      expect(after?.leaseId).toBeUndefined();
    }
  });

  it("listByCorrelation finds an envelope regardless of delivery state, for waitFor's recheck rule", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(envelope({ messageId: "m1", correlationId: "c1", deliveryState: "acknowledged" }));
    const hits = mailbox.listByCorrelation("c1");
    expect(hits.map((e) => e.messageId)).toEqual(["m1"]);
  });

  it("setDeliveryState and setRetentionState transition a single envelope", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(envelope({ messageId: "m1" }));
    mailbox.setDeliveryState("m1", "dead-letter");
    mailbox.setRetentionState("m1", "tombstoned");
    const after = mailbox.getEnvelope("m1");
    expect(after?.deliveryState).toBe("dead-letter");
    expect(after?.retentionState).toBe("tombstoned");
  });

  it("rejects an envelope addressed to a task that was never created", () => {
    const { store } = fixture();
    // No createTask() call: "t-worker-1" was never admitted.
    const mailbox = store.asPort().repositories.agentMailbox;
    expect(() => mailbox.insertEnvelope(envelope())).toThrowError(/FOREIGN KEY/i);
  });
});

describe("agent mailbox: a turn's mail", () => {
  it("claims a turn's mail newest first under its lease, counts the rest, and takes it again on a re-run of the same admission", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    for (const [index, at] of ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z"].entries()) {
      mailbox.insertEnvelope(envelope({ messageId: `m${index}`, createdAt: at }));
    }
    const first = mailbox.claimForTurn({ taskId: "t-worker-1", leaseId: "mailbox-adm-1", limit: 2 });
    expect(first.envelopes.map((row) => row.messageId)).toEqual(["m2", "m1"]);
    expect(first.more).toBe(1);
    expect(first.envelopes.every((row) => row.deliveryState === "delivered" && row.leaseId === "mailbox-adm-1")).toBe(true);
    // The same admission run again (a restart) takes exactly what it held — nothing newer, at any limit.
    mailbox.insertEnvelope(envelope({ messageId: "m-newer", createdAt: "2026-01-01T00:00:09.000Z" }));
    const again = mailbox.claimForTurn({ taskId: "t-worker-1", leaseId: "mailbox-adm-1", limit: 8 });
    expect(again.envelopes.map((row) => row.messageId)).toEqual(["m2", "m1"]);
    expect(mailbox.getEnvelope("m-newer")?.deliveryState).toBe("pending");
    mailbox.setDeliveryState("m-newer", "acknowledged");
    // A turn that ran reads what it showed for good; what it could not show goes back.
    mailbox.acknowledge({ taskId: "t-worker-1", leaseId: "mailbox-adm-1", messageIds: ["m2"] });
    mailbox.releaseClaim({ taskId: "t-worker-1", leaseId: "mailbox-adm-1", messageIds: ["m1"] });
    expect(mailbox.getEnvelope("m2")?.deliveryState).toBe("acknowledged");
    expect(mailbox.listPending("t-worker-1", 10).map((row) => row.messageId)).toEqual(["m0", "m1"]);
    // The next admission takes what is pending; one that never ran hands it all back.
    expect(
      mailbox.claimForTurn({ taskId: "t-worker-1", leaseId: "mailbox-adm-2", limit: 8 }).envelopes.map((row) => row.messageId),
    ).toEqual(["m1", "m0"]);
    mailbox.releaseClaim({ taskId: "t-worker-1", leaseId: "mailbox-adm-2" });
    expect(mailbox.getEnvelope("m0")?.deliveryState).toBe("pending");
    expect(mailbox.getEnvelope("m0")?.leaseId).toBeUndefined();
  });

  it("settles what a turn that died left held: read when its block reached the chat, claimed again otherwise", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    // Held by two turns that died: one whose block reached the chat, one whose did not.
    mailbox.insertEnvelope(
      envelope({ messageId: "shown", createdAt: "2026-01-01T00:00:01.000Z", deliveryState: "delivered", leaseId: "mailbox-adm-shown" }),
    );
    mailbox.insertEnvelope(
      envelope({ messageId: "lost", createdAt: "2026-01-01T00:00:02.000Z", deliveryState: "delivered", leaseId: "mailbox-adm-lost" }),
    );
    // A `receive` lease is no turn's: left alone.
    mailbox.insertEnvelope(envelope({ messageId: "received", createdAt: "2026-01-01T00:00:03.000Z" }));
    mailbox.claim({ taskId: "t-worker-1", limit: 8, leaseId: "lease-1", leaseExpiresAt: "2099-01-01T00:00:00.000Z" });
    const next = mailbox.claimForTurn({ taskId: "t-worker-1", leaseId: "mailbox-adm-next", limit: 8, readLeases: ["mailbox-adm-shown"] });
    expect(next.envelopes.map((row) => row.messageId)).toEqual(["lost"]);
    expect(mailbox.getEnvelope("shown")?.deliveryState).toBe("acknowledged");
    expect(mailbox.getEnvelope("received")?.leaseId).toBe("lease-1");
  });

  it("acknowledges what came before a forget, and lists what a sender sent since an instant", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const mailbox = store.asPort().repositories.agentMailbox;
    mailbox.insertEnvelope(envelope({ messageId: "old", kind: "result", createdAt: "2026-01-01T00:00:01.000Z" }));
    mailbox.insertEnvelope(envelope({ messageId: "new", kind: "result", createdAt: "2026-01-01T00:00:05.000Z" }));
    expect(
      mailbox
        .listSent({ senderTaskId: "t-orchestrator", recipientTaskId: "t-worker-1", kind: "result", since: "2026-01-01T00:00:02.000Z" })
        .map((row) => row.messageId),
    ).toEqual(["new"]);
    expect(mailbox.listSent({ senderTaskId: "someone-else", recipientTaskId: "t-worker-1", kind: "result", since: AT })).toEqual([]);
    expect(mailbox.acknowledgeBefore("t-worker-1", "2026-01-01T00:00:02.000Z")).toBe(1);
    expect(mailbox.listPending("t-worker-1", 10).map((row) => row.messageId)).toEqual(["new"]);
  });
});

describe("agent wait intents", () => {
  it("moves through prepared -> active -> settled, and settle is conditional on active", () => {
    const { store } = fixture();
    createTask(store, "t-orchestrator");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w1", taskId: "t-orchestrator", deadlineAt: "2026-01-01T00:05:00.000Z" });
    expect(waits.get("w1")?.state).toBe("prepared");

    waits.activate("w1");
    expect(waits.get("w1")?.state).toBe("active");

    const settled = waits.settle({ waitId: "w1", outcome: { kind: "worker-completed" } });
    expect(settled).toBe(true);
    expect(waits.get("w1")?.state).toBe("settled");
    expect(waits.get("w1")?.settledOutcome).toEqual({ kind: "worker-completed" });

    // A second settle on an already-settled wait is a no-op that reports failure,
    // never a silent re-settle (a late reply/timeout race settles once).
    const secondSettle = waits.settle({ waitId: "w1", outcome: { kind: "wait-timeout" } });
    expect(secondSettle).toBe(false);
    expect(waits.get("w1")?.settledOutcome).toEqual({ kind: "worker-completed" });
  });

  it("reads back a wait a peer's envelope settled, including one stored with the mailbox's bookkeeping", () => {
    const { store } = fixture();
    createTask(store, "t1");
    createTask(store, "t2");
    const waits = store.asPort().repositories.agentWaits;
    const { deliveryState: _delivery, retentionState: _retention, ...wire } = envelope();
    waits.prepare({ waitId: "w1", taskId: "t1", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    waits.activate("w1");
    waits.settle({ waitId: "w1", outcome: { kind: "replied", envelope: wire } });
    expect(waits.get("w1")?.settledOutcome).toEqual({ kind: "replied", envelope: wire });

    // As a build before `wireEnvelope` stored it: the mailbox record, whose
    // delivery fields the outcome's schema does not know. Read back as the
    // wire envelope, instead of refused.
    waits.prepare({ waitId: "w2", taskId: "t2", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    waits.activate("w2");
    store.handle
      .prepare("UPDATE tavi_agent_wait_intents SET state = 'settled', settled_outcome_json = ? WHERE wait_id = 'w2'")
      .run(JSON.stringify({ kind: "replied", envelope: envelope() }));
    expect(waits.get("w2")?.settledOutcome).toEqual({ kind: "replied", envelope: wire });
  });

  it("keeps a browser handoff on its wait, with how it was handed back, and lists the active ones", () => {
    const { store } = fixture();
    createTask(store, "t1");
    createTask(store, "t2");
    const waits = store.asPort().repositories.agentWaits;
    const handoff = {
      sessionId: "6f1d2c3b-0000-4000-8000-000000000001",
      reason: "sign-in" as const,
      instructions: "Sign in, then hand back",
    };
    waits.prepare({ waitId: "w1", taskId: "t1", deadlineAt: "2026-01-01T00:15:00.000Z", handoff });
    waits.activate("w1");
    waits.prepare({ waitId: "w2", taskId: "t2", deadlineAt: "2026-01-01T00:15:00.000Z", question: "Which one?" });
    waits.activate("w2");
    expect(waits.get("w1")?.handoff).toEqual(handoff);
    expect(waits.get("w2")?.handoff).toBeUndefined();
    expect(waits.listActiveHandoffs().map((wait) => wait.waitId)).toEqual(["w1"]);
    const outcome = { kind: "answered" as const, replyText: "Signed in", handoff: { outcome: "done" as const, controlledMs: 72_000 } };
    expect(waits.settle({ waitId: "w1", outcome })).toBe(true);
    expect(waits.get("w1")?.settledOutcome).toEqual(outcome);
    expect(waits.listActiveHandoffs()).toEqual([]);
  });

  it("activate is a no-op on a wait that is not prepared (e.g. already active or settled)", () => {
    const { store } = fixture();
    createTask(store, "t1");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w1", taskId: "t1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    waits.activate("w1");
    waits.settle({ waitId: "w1", outcome: { kind: "cancelled" } });
    waits.activate("w1");
    expect(waits.get("w1")?.state).toBe("settled");
  });

  it("listActivePastDeadline finds only active waits whose deadline has passed", () => {
    // Three separate tasks, one wait each: a task can have at most one
    // active wait, so this cannot be modeled as three waits on a single
    // task.
    const { store } = fixture();
    createTask(store, "t1");
    createTask(store, "t2");
    createTask(store, "t3");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w-overdue", taskId: "t1", deadlineAt: "2025-01-01T00:00:00.000Z" });
    waits.activate("w-overdue");
    waits.prepare({ waitId: "w-future", taskId: "t2", deadlineAt: "2099-01-01T00:00:00.000Z" });
    waits.activate("w-future");
    waits.prepare({ waitId: "w-not-active", taskId: "t3", deadlineAt: "2025-01-01T00:00:00.000Z" });

    const overdue = waits.listActivePastDeadline("2026-01-01T00:00:00.000Z");
    expect(overdue.map((w) => w.waitId)).toEqual(["w-overdue"]);
  });

  it("keeps a settled wait's promised resume pending until it is marked admitted", () => {
    const { store } = fixture();
    createTask(store, "t1");
    createTask(store, "t2");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w-resume", taskId: "t1", deadlineAt: "2099-01-01T00:00:00.000Z" });
    waits.activate("w-resume");
    waits.prepare({ waitId: "w-plain", taskId: "t2", deadlineAt: "2099-01-01T00:00:00.000Z" });
    waits.activate("w-plain");
    expect(waits.settle({ waitId: "w-resume", outcome: { kind: "answered", replyText: "yes" }, resume: true })).toBe(true);
    expect(waits.settle({ waitId: "w-plain", outcome: { kind: "cancelled" } })).toBe(true);

    expect(waits.listPendingResumes("2000-01-01T00:00:00.000Z")).toEqual([]);
    expect(waits.listPendingResumes("2999-01-01T00:00:00.000Z").map((wait) => wait.waitId)).toEqual(["w-resume"]);
    waits.markResumed("w-resume");
    expect(waits.listPendingResumes("2999-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("finds a task's most recently settled wait only within the window asked for", () => {
    const { store } = fixture();
    createTask(store, "t1");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w-old", taskId: "t1", deadlineAt: "2099-01-01T00:00:00.000Z" });
    waits.activate("w-old");
    waits.settle({ waitId: "w-old", outcome: { kind: "answered", replyText: "first" } });
    expect(waits.getRecentlySettledByTask("t1", "2000-01-01T00:00:00.000Z")?.waitId).toBe("w-old");
    expect(waits.getRecentlySettledByTask("t1", "2999-01-01T00:00:00.000Z")).toBeUndefined();
    expect(waits.getRecentlySettledByTask("t-other", "2000-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("rejects a wait intent for a task that was never created", () => {
    const { store } = fixture();
    const waits = store.asPort().repositories.agentWaits;
    expect(() => waits.prepare({ waitId: "w1", taskId: "no-such-task", deadlineAt: "2026-01-01T00:05:00.000Z" })).toThrowError(
      /FOREIGN KEY/i,
    );
  });

  it("getActiveByCorrelation finds only an active wait matching the task and correlation id", () => {
    const { store } = fixture();
    createTask(store, "t1");
    const waits = store.asPort().repositories.agentWaits;
    expect(waits.getActiveByCorrelation("t1", "c1")).toBeUndefined();

    waits.prepare({ waitId: "w1", taskId: "t1", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    // Not yet active: prepared alone doesn't match.
    expect(waits.getActiveByCorrelation("t1", "c1")).toBeUndefined();

    waits.activate("w1");
    expect(waits.getActiveByCorrelation("t1", "c1")?.waitId).toBe("w1");
    // A different correlation id, or a different task, doesn't match.
    expect(waits.getActiveByCorrelation("t1", "c2")).toBeUndefined();

    waits.settle({ waitId: "w1", outcome: { kind: "replied" } });
    // Settled: no longer active, no longer found.
    expect(waits.getActiveByCorrelation("t1", "c1")).toBeUndefined();
  });

  it("getActiveByTask finds the task's one active wait, ignoring prepared/settled rows and other tasks", () => {
    const { store } = fixture();
    createTask(store, "t1");
    createTask(store, "t2");
    const waits = store.asPort().repositories.agentWaits;
    expect(waits.getActiveByTask("t1")).toBeUndefined();

    waits.prepare({ waitId: "w1", taskId: "t1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    expect(waits.getActiveByTask("t1")).toBeUndefined();

    waits.activate("w1");
    expect(waits.getActiveByTask("t1")?.waitId).toBe("w1");
    expect(waits.getActiveByTask("t2")).toBeUndefined();

    waits.settle({ waitId: "w1", outcome: { kind: "cancelled" } });
    expect(waits.getActiveByTask("t1")).toBeUndefined();
  });

  it("rejects a second active wait for the same task and correlation id at the DB layer", () => {
    // getActiveByCorrelation assumes at most one 'active' row per
    // (task_id, correlation_id); the schema enforces that with a
    // partial unique index rather than leaving it an unenforced
    // application-level assumption.
    const { store } = fixture();
    createTask(store, "t1");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w1", taskId: "t1", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    waits.activate("w1");

    waits.prepare({ waitId: "w2", taskId: "t1", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    expect(() => waits.activate("w2")).toThrowError(/UNIQUE constraint/i);
  });

  it("rejects a second active wait for the same task regardless of correlation id, at the DB layer", () => {
    // getActiveByTask (used by agents.cancel to find the one wait a
    // suspended task is waiting on) assumes at most one 'active' row per
    // task_id, full stop — not merely per (task_id, correlation_id). A
    // second partial unique index, on task_id alone, enforces that:
    // neither of these two waits shares a correlation id (one has none,
    // one has a different one than any other active row for this task),
    // so the per-correlation index would not catch this pair; the
    // per-task one does.
    const { store } = fixture();
    createTask(store, "t1");
    const waits = store.asPort().repositories.agentWaits;
    waits.prepare({ waitId: "w1", taskId: "t1", correlationId: "c1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    waits.activate("w1");

    waits.prepare({ waitId: "w2", taskId: "t1", deadlineAt: "2026-01-01T00:05:00.000Z" });
    expect(() => waits.activate("w2")).toThrowError(/UNIQUE constraint/i);
  });
});

describe("agent delegation admissions", () => {
  it("resolves the same worker for a repeated spawn operation key", () => {
    const { store } = fixture();
    createTask(store, "t-worker-1");
    const delegations = store.asPort().repositories.agentDelegations;
    expect(delegations.getByOperationKey("w1", "alice", "op-1")).toBeUndefined();

    delegations.recordSpawn({
      operationKey: "op-1",
      workspaceId: "w1",
      principalId: "alice",
      workerTaskId: "t-worker-1",
      workerAgentId: "worker-1",
      createdAt: AT,
      depth: 1,
    });

    const resolved = delegations.getByOperationKey("w1", "alice", "op-1");
    expect(resolved?.workerTaskId).toBe("t-worker-1");
    expect(resolved?.workerAgentId).toBe("worker-1");
    expect(resolved?.parentTaskId).toBeUndefined();
    expect(resolved?.rootTaskId).toBeUndefined();

    // Scoped to the spawning actor: another principal's identical key resolves nothing.
    expect(delegations.getByOperationKey("w1", "bob", "op-1")).toBeUndefined();
  });

  it("lists a tree's workers that have not ended, and the ended ones whose result no owner announced", () => {
    const { store } = fixture();
    const repositories = store.asPort().repositories;
    for (const taskId of ["t-root", "t-a", "t-b"]) createTask(store, taskId);
    for (const [workerTaskId, agentDefinitionId] of [
      ["t-a", "researcher"],
      ["t-b", "writer"],
    ] as const) {
      repositories.agentDelegations.recordSpawn({
        operationKey: `op-${workerTaskId}`,
        workspaceId: "w1",
        principalId: "operator",
        workerTaskId,
        workerAgentId: `agent-${workerTaskId}`,
        parentTaskId: "t-root",
        rootTaskId: "t-root",
        agentDefinitionId,
        createdAt: AT,
        depth: 1,
      });
    }
    repositories.tasks.updateStatus("t-b", "waiting", null);
    expect(repositories.agentDelegations.listRunningInTree("w1", "t-root", 10)).toEqual([
      { workerTaskId: "t-a", agentDefinitionId: "researcher", status: "admitted" },
      { workerTaskId: "t-b", agentDefinitionId: "writer", status: "waiting" },
    ]);
    repositories.tasks.updateStatus("t-a", "completed", "done");
    expect(repositories.agentDelegations.listUnannouncedEnded("2000-01-01T00:00:00.000Z", 10)).toEqual(["t-a"]);
    // Ended before the window: not looked at.
    expect(repositories.agentDelegations.listUnannouncedEnded("2999-01-01T00:00:00.000Z", 10)).toEqual([]);
    // Announced: the result envelope of its last admission exists.
    repositories.agentMailbox.insertEnvelope(
      envelope({ messageId: "worker-result-adm-t-a", kind: "result", senderTaskId: "t-a", recipientTaskId: "t-root" }),
    );
    expect(repositories.agentDelegations.listUnannouncedEnded("2000-01-01T00:00:00.000Z", 10)).toEqual([]);
  });

  it("rejects a spawn admission for a worker task that was never created", () => {
    const { store } = fixture();
    const delegations = store.asPort().repositories.agentDelegations;
    expect(() =>
      delegations.recordSpawn({
        operationKey: "op-1",
        workspaceId: "w1",
        principalId: "alice",
        workerTaskId: "no-such-task",
        workerAgentId: "worker-1",
        createdAt: AT,
        depth: 1,
      }),
    ).toThrowError(/FOREIGN KEY/i);
  });
});

it("persists scoped parent/root edges and bounds direct child queries", () => {
  const { store } = fixture();
  const repo = store.asPort().repositories.agentDelegations;
  for (const [id, parent, workspace] of [
    ["child-a", "root", "w1"],
    ["child-b", "root", "w1"],
    ["grandchild", "child-a", "w1"],
    ["foreign", "root", "w2"],
  ]) {
    createTask(store, id!, workspace!);
    repo.recordSpawn({
      operationKey: id!,
      workspaceId: workspace!,
      principalId: "alice",
      workerTaskId: id!,
      workerAgentId: `agent-${id}`,
      parentTaskId: parent!,
      rootTaskId: "root",
      depth: parent === "root" ? 1 : 2,
      createdAt: AT,
    });
  }
  expect(repo.listChildren("w1", "root", 1).map((row) => row.workerTaskId)).toEqual(["child-a"]);
  expect(repo.listChildren("w1", "root", 10).map((row) => row.workerTaskId)).toEqual(["child-a", "child-b"]);
  expect(repo.getByWorkerTaskId("grandchild")).toMatchObject({ parentTaskId: "child-a", rootTaskId: "root", depth: 2 });
  expect(repo.listChildren("w1", "child-a", 10)).toHaveLength(1);
  store.close();
});

it("counts a tree's unended workers at every depth, in its own workspace only", () => {
  const { store } = fixture();
  const repo = store.asPort().repositories.agentDelegations;
  for (const [id, parent, root, workspace] of [
    ["child-a", "root", "root", "w1"],
    ["child-b", "root", "root", "w1"],
    ["grandchild", "child-a", "root", "w1"],
    ["legacy", "root", undefined, "w1"],
    ["other-tree", "elsewhere", "elsewhere", "w1"],
    ["foreign", "root", "root", "w2"],
  ]) {
    createTask(store, id!, workspace!);
    repo.recordSpawn({
      operationKey: id!,
      workspaceId: workspace!,
      principalId: "alice",
      workerTaskId: id!,
      workerAgentId: `agent-${id}`,
      parentTaskId: parent!,
      ...(root === undefined ? {} : { rootTaskId: root }),
      depth: 1,
      createdAt: AT,
    });
  }
  expect(repo.countRunningInTree("w1", "root")).toBe(4);
  store.asPort().repositories.tasks.updateStatus("child-b", "completed", "done");
  store.asPort().repositories.tasks.updateStatus("grandchild", "cancelled", null);
  expect(repo.countRunningInTree("w1", "root")).toBe(2);
  store.close();
});
