import { join } from "node:path";

import { TaviError, type InboundEvent, type MessagingIdentityBinding, type OutboundMessage, type SendOutcome } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import {
  HELD_STRANGER_PER_SENDER,
  HELD_STRANGER_TOTAL,
  PRUNE_HELD_STRANGERS,
  PRUNE_HELD_STRANGER_SENDER,
} from "../src/persistence/store/messaging.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Messaging inbox/outbox persistence.
 *
 * Properties under test: `record` is idempotent by (connectionId,
 * providerEventId) — the dedup key a real connector's retries/reordered
 * updates rely on; `begin`/`resolve` for the outbox follow the same
 * idempotent-by-effectId pattern the effect ledger established elsewhere.
 */

const AT = "2026-01-01T00:00:00.000Z";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function fixture(): { readonly store: SqliteStore } {
  const directory = directories.create("tavi-messaging-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  return { store };
}

function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    connectionId: "conn-1",
    providerEventId: "evt-1",
    kind: "message",
    externalSenderId: "user-1",
    externalConversationId: "chat-1",
    occurredAt: AT,
    receivedAt: AT,
    content: "hello",
    ...overrides,
  };
}

function outboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    effectId: "eff-1",
    connectionId: "conn-1",
    destination: { chatId: "chat-1" },
    parts: [{ content: "hi" }],
    ...overrides,
  };
}

describe("messaging inbox", () => {
  it("round-trips an event through record and get", () => {
    const { store } = fixture();
    const inbox = store.asPort().repositories.messagingInbox;
    const event = inboundEvent();
    expect(inbox.record({ connectionId: "conn-1", providerEventId: "evt-1", kind: "message", payload: event, now: () => AT })).toEqual({
      created: true,
    });
    const stored = inbox.get("conn-1", "evt-1");
    expect(stored?.state).toBe("received");
    expect(stored?.payload).toEqual(event);
  });

  it("record is idempotent by (connectionId, providerEventId) — a duplicate/reordered event is a safe no-op", () => {
    const { store } = fixture();
    const inbox = store.asPort().repositories.messagingInbox;
    inbox.record({ connectionId: "conn-1", providerEventId: "evt-1", kind: "message", payload: inboundEvent(), now: () => AT });
    const second = inbox.record({
      connectionId: "conn-1",
      providerEventId: "evt-1",
      kind: "message",
      payload: inboundEvent({ content: "a different retry payload" }),
      now: () => AT,
    });
    expect(second.created).toBe(false);
    // The original payload wins — a later retry's content never overwrites it.
    expect(inbox.get("conn-1", "evt-1")?.payload.content).toBe("hello");
  });

  it("the same providerEventId under a different connectionId is a distinct row", () => {
    const { store } = fixture();
    const inbox = store.asPort().repositories.messagingInbox;
    inbox.record({ connectionId: "conn-1", providerEventId: "evt-1", kind: "message", payload: inboundEvent(), now: () => AT });
    const created = inbox.record({
      connectionId: "conn-2",
      providerEventId: "evt-1",
      kind: "message",
      payload: inboundEvent({ connectionId: "conn-2" }),
      now: () => AT,
    });
    expect(created.created).toBe(true);
  });

  it("markProcessed transitions received -> processed", () => {
    const { store } = fixture();
    const inbox = store.asPort().repositories.messagingInbox;
    inbox.record({ connectionId: "conn-1", providerEventId: "evt-1", kind: "message", payload: inboundEvent(), now: () => AT });
    inbox.markProcessed("conn-1", "evt-1");
    expect(inbox.get("conn-1", "evt-1")?.state).toBe("processed");
  });

  it("get returns undefined for an unknown event", () => {
    const { store } = fixture();
    expect(store.asPort().repositories.messagingInbox.get("conn-1", "no-such-event")).toBeUndefined();
  });
});

describe("held stranger messages", () => {
  // Anyone can message a bot, and every message from a sender nobody allowed is a held row: the caps and the
  // expiry bound that, and never touch a bound sender's row or one a turn has claimed.
  const at = (n: number): string => new Date(Date.parse(AT) + n * 1000).toISOString();

  function withConnection(): { readonly store: SqliteStore } {
    const { store } = fixture();
    store.asPort().repositories.messagingConnections.save(
      {
        connectionId: "conn-1",
        providerId: "telegram",
        workspaceId: "w1",
        accountIdentity: "bot",
        settings: {},
        credentialRefs: {},
        enabled: true,
        authState: "none" as const,
      },
      AT,
    );
    return { store };
  }

  function recordFrom(store: SqliteStore, sender: string, n: number): void {
    store.asPort().repositories.messagingInbox.record({
      connectionId: "conn-1",
      providerEventId: `${sender}-${n}`,
      kind: "message",
      payload: inboundEvent({ providerEventId: `${sender}-${n}`, externalSenderId: sender }),
      now: () => at(n),
    });
  }

  const held = (store: SqliteStore, sender: string): string[] =>
    (
      store.handle
        .prepare(
          "SELECT provider_event_id FROM tavi_messaging_inbox WHERE json_extract(payload_json, '$.externalSenderId') = ? ORDER BY rowid",
        )
        .all(sender) as { provider_event_id: string }[]
    ).map((row) => row.provider_event_id);

  it("keeps the newest messages of each unbound sender, and every message of a bound one", () => {
    const { store } = withConnection();
    store.asPort().repositories.messagingIdentityBindings.bind(identityBinding({ externalSenderId: "friend" }));
    for (let n = 0; n < HELD_STRANGER_PER_SENDER + 5; n += 1) {
      recordFrom(store, "stranger", n);
      recordFrom(store, "friend", n);
    }
    expect(held(store, "stranger")).toEqual(Array.from({ length: HELD_STRANGER_PER_SENDER }, (_, i) => `stranger-${i + 5}`));
    expect(held(store, "friend")).toHaveLength(HELD_STRANGER_PER_SENDER + 5);
    store.close();
  });

  it("never takes a claimed row (a turn in flight) or a processed one", () => {
    const { store } = withConnection();
    const inbox = store.asPort().repositories.messagingInbox;
    recordFrom(store, "stranger", 0);
    recordFrom(store, "stranger", 1);
    expect(inbox.claimForReplay({ connectionId: "conn-1", providerEventId: "stranger-0", now: at(2), staleBefore: AT })).toBe(true);
    inbox.markProcessed("conn-1", "stranger-1");
    for (let n = 2; n < HELD_STRANGER_PER_SENDER + 10; n += 1) recordFrom(store, "stranger", n);
    const kept = held(store, "stranger");
    expect(kept.slice(0, 2)).toEqual(["stranger-0", "stranger-1"]);
    expect(kept).toHaveLength(HELD_STRANGER_PER_SENDER + 2);
    store.close();
  });

  it("caps held strangers across senders, keeping the newest and the one just recorded", () => {
    const { store } = withConnection();
    const insert = store.handle.prepare(
      "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES ('conn-1', ?, 'message', ?, 'received', ?)",
    );
    store.transaction(() => {
      for (let n = 0; n < HELD_STRANGER_TOTAL; n += 1)
        insert.run(`seed-${n}`, JSON.stringify(inboundEvent({ externalSenderId: `s-${n}` })), at(n));
    });
    // A clock that stepped back: the new row is the oldest by time, and still kept.
    store.asPort().repositories.messagingInbox.record({
      connectionId: "conn-1",
      providerEventId: "late",
      kind: "message",
      payload: inboundEvent({ providerEventId: "late", externalSenderId: "s-late" }),
      now: () => "2025-01-01T00:00:00.000Z",
    });
    const count = (where: string): number =>
      (store.handle.prepare(`SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE ${where}`).get() as { n: number }).n;
    expect(count("1 = 1")).toBe(HELD_STRANGER_TOTAL);
    expect(count("provider_event_id = 'late'")).toBe(1);
    expect(count("provider_event_id = 'seed-0'")).toBe(0);
    expect(count(`provider_event_id = 'seed-${HELD_STRANGER_TOTAL - 1}'`)).toBe(1);
    store.close();
  });

  it("the caps walk the inbox through its index, never the whole table", () => {
    const { store } = withConnection();
    for (const sql of [PRUNE_HELD_STRANGER_SENDER, PRUNE_HELD_STRANGERS]) {
      const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({
        connectionId: "c",
        providerEventId: "e",
        externalSenderId: "s",
        limit: 1,
      }) as { detail: string }[];
      const scans = plan.map((row) => row.detail).filter((detail) => /^SCAN tavi_messaging_inbox\b/.test(detail));
      expect(scans).toEqual([]);
    }
    store.close();
  });

  it("the retention sweep expires an unbound sender's held message, never a bound one or one claimed since the cutoff", () => {
    const { store } = withConnection();
    const inbox = store.asPort().repositories.messagingInbox;
    store.asPort().repositories.messagingIdentityBindings.bind(identityBinding({ externalSenderId: "friend" }));
    recordFrom(store, "stranger", 0);
    recordFrom(store, "stranger", 1);
    recordFrom(store, "stranger", 2);
    recordFrom(store, "friend", 0);
    recordFrom(store, "stranger", 100);
    const cutoff = at(50);
    // Claimed after the cutoff: a turn in flight. Claimed before it: a crashed turn's claim, long stale.
    inbox.claimForReplay({ connectionId: "conn-1", providerEventId: "stranger-1", now: at(60), staleBefore: AT });
    inbox.claimForReplay({ connectionId: "conn-1", providerEventId: "stranger-2", now: at(3), staleBefore: AT });
    expect(store.pruneTransport({ olderThan: cutoff, dryRun: true }).inbox).toBe(2);
    expect(held(store, "stranger")).toHaveLength(4);
    expect(store.pruneTransport({ olderThan: cutoff, dryRun: false }).inbox).toBe(2);
    expect(held(store, "stranger")).toEqual(["stranger-1", "stranger-100"]);
    expect(held(store, "friend")).toEqual(["friend-0"]);
    store.close();
  });
});

describe("messaging outbox", () => {
  it("round-trips a send through begin, resolve and get", () => {
    const { store } = fixture();
    const outbox = store.asPort().repositories.messagingOutbox;
    const message = outboundMessage();
    expect(outbox.begin({ effectId: "eff-1", connectionId: "conn-1", message, now: () => AT })).toEqual({ created: true });
    expect(outbox.get("eff-1")?.state).toBe("pending");

    const outcome: SendOutcome = {
      status: "accepted",
      retryable: false,
      parts: [{ index: 0, status: "accepted", providerMessageId: "pm-1" }],
    };
    outbox.resolve({ effectId: "eff-1", outcome, now: () => AT });
    const resolved = outbox.get("eff-1");
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.outcome).toEqual(outcome);
  });

  it("begin is idempotent by effectId — a retried send resolves the same logical operation, not a duplicate", () => {
    const { store } = fixture();
    const outbox = store.asPort().repositories.messagingOutbox;
    outbox.begin({ effectId: "eff-1", connectionId: "conn-1", message: outboundMessage(), now: () => AT });
    const second = outbox.begin({
      effectId: "eff-1",
      connectionId: "conn-1",
      message: outboundMessage({ parts: [{ content: "a different retry" }] }),
      now: () => AT,
    });
    expect(second.created).toBe(false);
  });

  it("resolve is a no-op on an already-resolved row — never overwrites a settled outcome", () => {
    const { store } = fixture();
    const outbox = store.asPort().repositories.messagingOutbox;
    outbox.begin({ effectId: "eff-1", connectionId: "conn-1", message: outboundMessage(), now: () => AT });
    const first: SendOutcome = { status: "accepted", retryable: false, parts: [] };
    outbox.resolve({ effectId: "eff-1", outcome: first, now: () => AT });
    const second: SendOutcome = { status: "rejected", retryable: false, parts: [] };
    outbox.resolve({ effectId: "eff-1", outcome: second, now: () => AT });
    expect(outbox.get("eff-1")?.outcome).toEqual(first);
  });

  it("get returns undefined for an unknown effectId", () => {
    const { store } = fixture();
    expect(store.asPort().repositories.messagingOutbox.get("no-such-effect")).toBeUndefined();
  });

  it("listPending surfaces only pending rows, oldest first, for reconciliation", () => {
    const { store } = fixture();
    const outbox = store.asPort().repositories.messagingOutbox;
    outbox.begin({
      effectId: "eff-old",
      connectionId: "conn-1",
      message: outboundMessage({ effectId: "eff-old" }),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    outbox.begin({
      effectId: "eff-new",
      connectionId: "conn-1",
      message: outboundMessage({ effectId: "eff-new" }),
      now: () => "2026-01-01T00:05:00.000Z",
    });
    outbox.begin({
      effectId: "eff-resolved",
      connectionId: "conn-1",
      message: outboundMessage({ effectId: "eff-resolved" }),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    outbox.resolve({
      effectId: "eff-resolved",
      outcome: { status: "accepted", retryable: false, parts: [] },
      now: () => "2026-01-01T00:01:00.000Z",
    });

    const pending = outbox.listPending(10);
    expect(pending.map((row) => row.effectId)).toEqual(["eff-old", "eff-new"]);
    expect(pending[0]?.connectionId).toBe("conn-1");
    expect(pending[0]?.message.effectId).toBe("eff-old");
  });
});

function identityBinding(overrides: Partial<MessagingIdentityBinding> = {}): MessagingIdentityBinding {
  return {
    connectionId: "conn-1",
    externalSenderId: "tg-user-1",
    workspaceId: "w1",
    principalId: "alice",
    approvedBy: "operator",
    createdAt: AT,
    ...overrides,
  };
}

describe("messaging identity bindings", () => {
  it("binds an external sender to a principal, readable back by get and list", () => {
    const { store } = fixture();
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    bindings.bind(identityBinding());
    expect(bindings.get("conn-1", "tg-user-1")?.principalId).toBe("alice");
    expect(bindings.list("w1").map((b) => b.principalId)).toEqual(["alice"]);
  });

  it("stores connections as rows: a save bumps the revision, and a connection keeps its provider and workspace", () => {
    const { store } = fixture();
    const connections = store.asPort().repositories.messagingConnections;
    const input = {
      connectionId: "telegram-w1",
      providerId: "telegram",
      workspaceId: "w1",
      accountIdentity: "bot",
      settings: {},
      credentialRefs: { token: "channels.x.token" },
      enabled: true,
      authState: "none" as const,
    };
    expect(connections.save(input, AT)).toMatchObject({ configRevision: 1, enabled: true, createdAt: AT, updatedAt: AT });
    expect(connections.save({ ...input, enabled: false, label: "Ops bot" }, "2026-05-01T00:00:00.000Z")).toMatchObject({
      configRevision: 2,
      enabled: false,
      label: "Ops bot",
      createdAt: AT,
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(() => connections.save({ ...input, providerId: "mailgun" }, AT)).toThrow(/belongs to telegram/);
    connections.save({ ...input, connectionId: "mailgun-w2", providerId: "mailgun", workspaceId: "w2" }, AT);
    expect(connections.list("w1").map((row) => row.connectionId)).toEqual(["telegram-w1"]);
    expect(connections.list().map((row) => row.connectionId)).toEqual(["mailgun-w2", "telegram-w1"]);
    expect(connections.get("nope")).toBeUndefined();
  });

  it("removes a connection as a tombstone: gone from get and list, kept for history, and its id still its own", () => {
    const { store } = fixture();
    const connections = store.asPort().repositories.messagingConnections;
    const input = {
      connectionId: "telegram-w1",
      providerId: "telegram",
      workspaceId: "w1",
      accountIdentity: "bot",
      settings: {},
      credentialRefs: {},
      enabled: true,
      authState: "none" as const,
    };
    connections.save(input, AT);
    connections.remove("telegram-w1", "2026-05-01T00:00:00.000Z");
    expect(connections.get("telegram-w1")).toBeUndefined();
    expect(connections.list("w1")).toEqual([]);
    expect(connections.list("w1", { includeDeleted: true })).toEqual([
      expect.objectContaining({ connectionId: "telegram-w1", enabled: false, deletedAt: "2026-05-01T00:00:00.000Z" }),
    ]);
    // Another workspace or channel cannot take a removed connection's id.
    expect(() => connections.save({ ...input, workspaceId: "w2" }, AT)).toThrow(/belongs to telegram in workspace w1/);
    expect(() => connections.save({ ...input, providerId: "mailgun" }, AT)).toThrow(/belongs to telegram/);
    // Saved again as itself, it is back.
    expect(connections.save(input, AT)).not.toHaveProperty("deletedAt");
    expect(connections.get("telegram-w1")).toMatchObject({ enabled: true });
  });

  it("is idempotent for an identical re-bind — no error, no duplicate row", () => {
    const { store } = fixture();
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    bindings.bind(identityBinding());
    expect(() => bindings.bind(identityBinding())).not.toThrow();
    expect(bindings.list("w1")).toHaveLength(1);
  });

  it("refuses to rebind an already-bound sender to a different principal (CONFLICT)", () => {
    const { store } = fixture();
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    bindings.bind(identityBinding());
    expect(() => bindings.bind(identityBinding({ principalId: "bob" }))).toThrowError(TaviError);
    try {
      bindings.bind(identityBinding({ principalId: "bob" }));
    } catch (error) {
      expect(error).toBeInstanceOf(TaviError);
      expect((error as TaviError).code).toBe("CONFLICT");
    }
    // The original binding is untouched by the refused attempt — note this
    // alone doesn't prove transactional isolation (the conflicting path
    // throws before ever reaching the INSERT, so there's nothing to roll
    // back here); it only confirms the refusal has no side effect.
    expect(bindings.get("conn-1", "tg-user-1")?.principalId).toBe("alice");
  });

  it("bind() uses an IMMEDIATE transaction, not a deferred one — pins the fix for a genuine read-compare-write race", () => {
    // `bind`'s check-then-write is a real compare-and-set: a deferred
    // `transaction()` only takes a read lock during the read, so two
    // concurrent `bind()` calls on separate connections to the same file
    // could both observe "no existing row" before either writes, surfacing
    // a raw SQLITE_BUSY/constraint error instead of the intended typed
    // CONFLICT. Asserting `transactionImmediate` (not `transaction`) is
    // actually called is what a same-process, single-threaded test CAN
    // verify about this fix; a true multi-connection race additionally
    // needs a second OS-level SQLite connection racing the first, which
    // this synchronous, single-threaded test harness cannot drive.
    const { store } = fixture();
    const immediateSpy = vi.spyOn(store, "transactionImmediate");
    const deferredSpy = vi.spyOn(store, "transaction");
    store.asPort().repositories.messagingIdentityBindings.bind(identityBinding());
    expect(immediateSpy).toHaveBeenCalledTimes(1);
    expect(deferredSpy).not.toHaveBeenCalled();
  });

  it("same principal, two different connections — the whole 'same principal across bindings' gate", () => {
    const { store } = fixture();
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    bindings.bind(identityBinding({ connectionId: "telegram-conn", externalSenderId: "tg-42" }));
    bindings.bind(identityBinding({ connectionId: "mailgun-conn", externalSenderId: "alice@example.com" }));
    expect(bindings.get("telegram-conn", "tg-42")?.principalId).toBe("alice");
    expect(bindings.get("mailgun-conn", "alice@example.com")?.principalId).toBe("alice");
  });

  it("unbind removes a binding, and is idempotent on an already-unbound pair", () => {
    const { store } = fixture();
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    bindings.bind(identityBinding());
    bindings.unbind("conn-1", "tg-user-1");
    expect(bindings.get("conn-1", "tg-user-1")).toBeUndefined();
    expect(() => bindings.unbind("conn-1", "tg-user-1")).not.toThrow();
  });

  it("get returns undefined for an unbound (forged/unknown) sender — denied by absence, not a distinguishable error", () => {
    const { store } = fixture();
    expect(store.asPort().repositories.messagingIdentityBindings.get("conn-1", "never-bound")).toBeUndefined();
  });

  it("list scopes to the given workspace only", () => {
    const { store } = fixture();
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    bindings.bind(identityBinding({ workspaceId: "w1", connectionId: "c1", externalSenderId: "u1" }));
    bindings.bind(identityBinding({ workspaceId: "w2", connectionId: "c2", externalSenderId: "u2", principalId: "carol" }));
    expect(bindings.list("w1").map((b) => b.externalSenderId)).toEqual(["u1"]);
    expect(bindings.list("w2").map((b) => b.externalSenderId)).toEqual(["u2"]);
  });
});

/** Admits a minimal task directly, satisfying `tavi_messaging_conversation_tasks`'s foreign key — this file's own equivalent of `@tavi/test-support/fakes`'s `admitFixtureTask`, against the real store rather than an in-memory one. */
function admitTask(store: SqliteStore, taskId: string): void {
  store.asPort().repositories.tasks.admit({
    workspaceId: "w1",
    principalId: "alice",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: null,
    checkpointNamespace: "",
    newTaskId: () => taskId,
    newAdmissionId: () => `adm-${taskId}`,
    newThreadId: () => `thread-${taskId}`,
    now: () => AT,
  });
}

describe("messaging conversation tasks", () => {
  it("records a conversation's task, readable back by get", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    const conversations = store.asPort().repositories.messagingConversations;
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    expect(conversations.get("conn-a", "chat-1")?.taskId).toBe("task-1");
  });

  it("keeps a conversation's provider and kind, carries them to its next epoch, and lists each connection's provider", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    admitTask(store, "task-2");
    const conversations = store.asPort().repositories.messagingConversations;
    conversations.record({
      connectionId: "conn-a",
      externalConversationId: "chat-1",
      taskId: "task-1",
      createdAt: AT,
      providerId: "example",
      conversationKind: "group",
    });
    expect(conversations.get("conn-a", "chat-1")).toMatchObject({ providerId: "example", conversationKind: "group" });
    conversations.reset("conn-a", "chat-1", AT);
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-2", createdAt: AT });
    expect(conversations.get("conn-a", "chat-1")).toMatchObject({ taskId: "task-2", providerId: "example", conversationKind: "group" });
    expect(conversations.connectionProviders()).toEqual([{ connectionId: "conn-a", providerId: "example" }]);
  });

  it("is idempotent for an identical re-record (e.g. a retried admission)", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    const conversations = store.asPort().repositories.messagingConversations;
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    expect(() =>
      conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT }),
    ).not.toThrow();
  });

  it("refuses to remap a conversation to a different task (CONFLICT)", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    admitTask(store, "task-2");
    const conversations = store.asPort().repositories.messagingConversations;
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    expect(() =>
      conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-2", createdAt: AT }),
    ).toThrowError(TaviError);
    // The original mapping is untouched by the refused attempt.
    expect(conversations.get("conn-a", "chat-1")?.taskId).toBe("task-1");
  });

  it("ends an epoch on reset: the next task records the next epoch, the ended one stays found by its task", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    admitTask(store, "task-2");
    const conversations = store.asPort().repositories.messagingConversations;
    expect(conversations.nextEpoch("conn-a", "chat-1")).toBe(0);
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    expect(conversations.nextEpoch("conn-a", "chat-1")).toBe(0);
    expect(conversations.reset("conn-a", "chat-1", AT)?.taskId).toBe("task-1");
    expect(conversations.get("conn-a", "chat-1")).toBeUndefined();
    expect(conversations.nextEpoch("conn-a", "chat-1")).toBe(1);
    expect(conversations.reset("conn-a", "chat-1", AT)).toBeUndefined();
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-2", createdAt: AT });
    expect(conversations.get("conn-a", "chat-1")).toMatchObject({ taskId: "task-2", epoch: 1 });
    expect(conversations.getByTask("task-1")).toMatchObject({ epoch: 0 });
    // A retried record of an ended epoch's task does not reopen it.
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    expect(conversations.get("conn-a", "chat-1")?.taskId).toBe("task-2");
  });

  it("lists an ended epoch until its withdrawal is marked, once; an active or reopened epoch never", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    admitTask(store, "task-2");
    admitTask(store, "task-3");
    const conversations = store.asPort().repositories.messagingConversations;
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-2", taskId: "task-3", createdAt: AT });
    expect(conversations.listUnwithdrawn()).toEqual([]);
    // Not ended yet: nothing to mark.
    expect(conversations.markWithdrawn("conn-a", "chat-1", 0, AT)).toBe(false);

    conversations.reset("conn-a", "chat-1", "2026-01-02T00:00:00.000Z");
    expect(conversations.listUnwithdrawn().map((ended) => [ended.taskId, ended.epoch])).toEqual([["task-1", 0]]);
    // The next epoch's task is active, never listed.
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-2", createdAt: AT });
    expect(conversations.listUnwithdrawn().map((ended) => ended.taskId)).toEqual(["task-1"]);
    expect(conversations.markWithdrawn("conn-a", "chat-1", 1, AT)).toBe(false);
    expect(conversations.markWithdrawn("conn-a", "chat-1", 0, AT)).toBe(true);
    expect(conversations.markWithdrawn("conn-a", "chat-1", 0, AT)).toBe(false);
    expect(conversations.listUnwithdrawn()).toEqual([]);

    // An ended epoch whose task the conversation reopened is not over: it is left out.
    conversations.reset("conn-a", "chat-2", AT);
    expect(conversations.listUnwithdrawn().map((ended) => ended.taskId)).toEqual(["task-3"]);
    expect(conversations.reopen("conn-a", "chat-2", "task-3", AT)?.epoch).toBe(1);
    expect(conversations.listUnwithdrawn()).toEqual([]);
  });

  it("get returns undefined for a conversation with no recorded task yet", () => {
    const { store } = fixture();
    expect(store.asPort().repositories.messagingConversations.get("conn-a", "never-started")).toBeUndefined();
  });

  it("record() uses an IMMEDIATE transaction, not a deferred one — pins the fix for the same class of race as in bind()", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    const immediateSpy = vi.spyOn(store, "transactionImmediate");
    const deferredSpy = vi.spyOn(store, "transaction");
    store.asPort().repositories.messagingConversations.record({
      connectionId: "conn-a",
      externalConversationId: "chat-1",
      taskId: "task-1",
      createdAt: AT,
    });
    expect(immediateSpy).toHaveBeenCalledTimes(1);
    expect(deferredSpy).not.toHaveBeenCalled();
  });

  it("the same connection's two different conversations map independently", () => {
    const { store } = fixture();
    admitTask(store, "task-1");
    admitTask(store, "task-2");
    const conversations = store.asPort().repositories.messagingConversations;
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-1", taskId: "task-1", createdAt: AT });
    conversations.record({ connectionId: "conn-a", externalConversationId: "chat-2", taskId: "task-2", createdAt: AT });
    expect(conversations.get("conn-a", "chat-1")?.taskId).toBe("task-1");
    expect(conversations.get("conn-a", "chat-2")?.taskId).toBe("task-2");
  });
});
