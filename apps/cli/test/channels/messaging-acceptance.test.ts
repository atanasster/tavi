import { join } from "node:path";

import type { InboundEvent, MessagingConnection, OutboundMessage, SendOutcome } from "@tavi/contracts";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createMessagingService } from "@tavi/runtime";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Messaging connector contract-compliance suite, run against the fixture
 * connector instead of live Telegram/Mailgun.
 *
 * Lives here (not `packages/runtime/test/`) because it needs both the
 * real `createMessagingService` (`@tavi/runtime`) and the fixture
 * connector (`@tavi/test-support/messaging`) together — `@tavi/runtime`
 * must not import `@tavi/agent-host`, so an integration test
 * combining both belongs in `apps/cli`, the same reasoning
 * `agent-delegation-fault.test.ts` already documents for combining
 * `SqliteStore` with `createAgentCommunicationService`.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

async function tempStore(): Promise<SqliteStore> {
  const directory = directories.create("tavi-messaging-acceptance-");
  return await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    connectionId: "conn-a",
    providerEventId: "evt-1",
    kind: "message",
    externalSenderId: "user-1",
    externalConversationId: "chat-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: "hi",
    ...overrides,
  };
}

function fixtureConnection(connectionId: string): MessagingConnection {
  return {
    connectionId,
    providerId: "fixture",
    accountIdentity: `${connectionId}-account`,
    workspaceId: "w1",
    configRevision: 1,
    enabled: true,
  };
}

async function bindUser1(store: SqliteStore): Promise<void> {
  await store.asPort().repositories.messagingIdentityBindings.bind({
    connectionId: "conn-a",
    externalSenderId: "user-1",
    workspaceId: "w1",
    principalId: "alice",
    approvedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function outboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    effectId: "eff-1",
    connectionId: "conn-a",
    destination: { chatId: "chat-1" },
    parts: [{ content: "hello" }],
    ...overrides,
  };
}

describe("messaging contract compliance (fixture connector)", () => {
  it("two connector instances under distinct connections never cross credentials or conversations", async () => {
    const store = await tempStore();
    const definition = createFixtureMessagingConnectorDefinition();
    const service = createMessagingService(store.asPort());
    service.registerConnector(definition);

    await service.openConnection({
      connection: {
        connectionId: "bot-a",
        providerId: "fixture",
        accountIdentity: "bot-a-account",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    await service.openConnection({
      connection: {
        connectionId: "bot-b",
        providerId: "fixture",
        accountIdentity: "bot-b-account",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });

    const sentA = await service.send(outboundMessage({ effectId: "eff-a", connectionId: "bot-a" }));
    const sentB = await service.send(outboundMessage({ effectId: "eff-b", connectionId: "bot-b" }));
    expect(sentA.status).toBe("accepted");
    expect(sentB.status).toBe("accepted");

    // Each connection's own outbox row is scoped to it — a lookup under
    // the other connection's effectId is not just "not found by
    // coincidence" but genuinely never written there.
    const outbox = store.asPort().repositories.messagingOutbox;
    expect((await outbox.get("eff-a"))?.state).toBe("resolved");
    expect((await outbox.get("eff-b"))?.state).toBe("resolved");

    await service.closeConnection("bot-a");
    await service.closeConnection("bot-b");
    store.close();
  });

  it("duplicate inbound events are deduplicated by (connectionId, providerEventId)", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());

    const first = await service.ingest(inboundEvent({ providerEventId: "evt-1" }));
    expect(first).toEqual({ accepted: true, duplicate: false });

    // A duplicate delivery of the identical event.
    const dup = await service.ingest(inboundEvent({ providerEventId: "evt-1" }));
    expect(dup).toEqual({ accepted: true, duplicate: true });

    const inbox = store.asPort().repositories.messagingInbox;
    expect((await inbox.get("conn-a", "evt-1"))?.payload.content).toBe("hi");
    store.close();
  });

  it("ingest resolves a bound sender's principal, and denies (omits resolvedPrincipalId) an unbound one — the whole channel-identity gate", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    await store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-1",
      workspaceId: "w1",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const bound = await service.ingest(inboundEvent({ providerEventId: "evt-bound", externalSenderId: "user-1" }));
    expect(bound.resolvedPrincipalId).toBe("alice");

    // The event is still durably recorded and deduped either way — an
    // unbound sender's message is held for an operator to inspect and
    // bind, never silently dropped by identity resolution.
    const forged = await service.ingest(inboundEvent({ providerEventId: "evt-forged", externalSenderId: "unknown-user" }));
    expect(forged.accepted).toBe(true);
    expect(forged.duplicate).toBe(false);
    expect(forged.resolvedPrincipalId).toBeUndefined();
    store.close();
  });

  it("the same principal resolves identically from two different connections (Telegram-shaped and Mailgun-shaped ids)", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    const bindings = store.asPort().repositories.messagingIdentityBindings;
    await bindings.bind({
      connectionId: "telegram-conn",
      externalSenderId: "tg-42",
      workspaceId: "w1",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await bindings.bind({
      connectionId: "mailgun-conn",
      externalSenderId: "alice@example.com",
      workspaceId: "w1",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const viaTelegram = await service.ingest(
      inboundEvent({ connectionId: "telegram-conn", providerEventId: "evt-tg", externalSenderId: "tg-42" }),
    );
    const viaMailgun = await service.ingest(
      inboundEvent({ connectionId: "mailgun-conn", providerEventId: "evt-mg", externalSenderId: "alice@example.com" }),
    );
    expect(viaTelegram.resolvedPrincipalId).toBe("alice");
    expect(viaMailgun.resolvedPrincipalId).toBe("alice");
    store.close();
  });

  it("admits a workflow turn only for a new event from a bound sender", async () => {
    const store = await tempStore();
    const admitCalls: { readonly event: InboundEvent; readonly actor: { readonly principalId: string } }[] = [];
    const service = createMessagingService(store.asPort(), {
      admit: async (input) => {
        admitCalls.push(input);
      },
    });
    await store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-1",
      workspaceId: "w1",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await service.ingest(inboundEvent({ providerEventId: "evt-new", externalSenderId: "user-1" }));
    expect(admitCalls).toHaveLength(1);
    expect(admitCalls[0]?.actor.principalId).toBe("alice");
    expect(admitCalls[0]?.event.providerEventId).toBe("evt-new");

    // A duplicate/redelivered event never re-admits a turn: the content
    // was already processed once.
    await service.ingest(inboundEvent({ providerEventId: "evt-new", externalSenderId: "user-1" }));
    expect(admitCalls).toHaveLength(1);

    // An unbound sender's new event is durably recorded — held for an
    // operator to inspect and bind, never dropped — but never admitted.
    await service.ingest(inboundEvent({ providerEventId: "evt-unbound", externalSenderId: "unknown-user" }));
    expect(admitCalls).toHaveLength(1);
    const unbound = await store.asPort().repositories.messagingInbox.get("conn-a", "evt-unbound");
    expect(unbound).toBeDefined();
    // Held, not processed: it is still waiting for an operator to bind the
    // sender, which is what the retention sweep must never delete.
    expect(unbound?.state).toBe("received");
    // An admitted message is `processed`, so `tavi prune` may delete it once it
    // is old and `doctor`'s `inboxUnprocessed` is the count that will not shrink
    // on its own (`markProcessed` had no caller at all before this).
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-new"))?.state).toBe("processed");
    store.close();
  });

  it("answers onRecorded once the event is recorded, before the turn it admits has run", async () => {
    const store = await tempStore();
    await bindUser1(store);
    let releaseTurn = (): void => {};
    const turn = new Promise<void>((resolve) => (releaseTurn = resolve));
    let admitStarted = (): void => {};
    const started = new Promise<void>((resolve) => (admitStarted = resolve));
    const order: string[] = [];
    const service = createMessagingService(store.asPort(), {
      admit: async () => {
        order.push("admit started");
        admitStarted();
        await turn;
        order.push("admit finished");
      },
    });
    const ingested = service.ingest(inboundEvent({ providerEventId: "evt-hook" }), {
      onRecorded: async (receipt) => {
        // Recorded, and resolved to its sender, before the turn runs.
        order.push(`recorded duplicate=${receipt.duplicate} principal=${receipt.resolvedPrincipalId}`);
        expect(await store.asPort().repositories.messagingInbox.get("conn-a", "evt-hook")).toBeDefined();
      },
    });
    await started;
    expect(order).toEqual(["recorded duplicate=false principal=alice", "admit started"]);
    releaseTurn();
    await ingested;
    expect(order.at(-1)).toBe("admit finished");

    // A redelivery is answered as a duplicate, and admits nothing.
    const again: boolean[] = [];
    await service.ingest(inboundEvent({ providerEventId: "evt-hook" }), {
      onRecorded: (receipt) => {
        again.push(receipt.duplicate);
      },
    });
    expect(again).toEqual([true]);
    expect(order.filter((step) => step === "admit started")).toHaveLength(1);

    // A hook that throws is contained: the event is recorded and admitted all the same.
    await service.ingest(inboundEvent({ providerEventId: "evt-broken" }), {
      onRecorded: () => {
        throw new Error("a broken hook");
      },
    });
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-broken"))?.state).toBe("processed");
    // So is one whose promise rejects: contained, never an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await service.ingest(inboundEvent({ providerEventId: "evt-async-broken" }), {
        onRecorded: async () => {
          throw new Error("a broken async hook");
        },
      });
      await delay(20);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-async-broken"))?.state).toBe("processed");
    store.close();
  });

  it("answers onRecorded before a turn that then fails, whose ingest rejects and whose row stays received", async () => {
    const store = await tempStore();
    await bindUser1(store);
    const service = createMessagingService(store.asPort(), {
      admit: async () => {
        throw new Error("the turn failed");
      },
    });
    const recorded: boolean[] = [];
    await expect(
      service.ingest(inboundEvent({ providerEventId: "evt-late-fail" }), {
        onRecorded: (receipt) => {
          recorded.push(receipt.accepted);
        },
      }),
    ).rejects.toThrow("the turn failed");
    // The answer said "recorded", which stays true: the row is held for a replay.
    expect(recorded).toEqual([true]);
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-late-fail"))?.state).toBe("received");
    store.close();
  });

  it("propagates a thrown admit() error, but the event stays durably recorded (the design this step's error-handling relies on)", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort(), {
      admit: async () => {
        throw new Error("workflow admission failed");
      },
    });
    await store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-1",
      workspaceId: "w1",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(service.ingest(inboundEvent({ providerEventId: "evt-fail", externalSenderId: "user-1" }))).rejects.toThrow(
      "workflow admission failed",
    );

    // Durable recording happened before admission ran, so it survives the throw —
    // and it stays `received`, because a message whose admission threw has not
    // been handled: a redelivery must still be visible as unprocessed.
    const failed = await store.asPort().repositories.messagingInbox.get("conn-a", "evt-fail");
    expect(failed).toBeDefined();
    expect(failed?.state).toBe("received");
    store.close();
  });

  it("omitting the admit option leaves ingest()'s record+dedup behavior unchanged (no regression to earlier messaging behavior)", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    await store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-1",
      workspaceId: "w1",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const first = await service.ingest(inboundEvent({ providerEventId: "evt-1", externalSenderId: "user-1" }));
    expect(first).toEqual({ accepted: true, duplicate: false, resolvedPrincipalId: "alice" });
    const dup = await service.ingest(inboundEvent({ providerEventId: "evt-1", externalSenderId: "user-1" }));
    expect(dup).toEqual({ accepted: true, duplicate: true, resolvedPrincipalId: "alice" });
    store.close();
  });

  it("openConnection routes the connector's inbound handler into ingest, registered before start() so an event received while starting still arrives", async () => {
    // Regression: `openConnection` registered no handler at all, so a
    // connector's own receive loop delivered into nothing — and Telegram's
    // poller acknowledged each update anyway. This connector delivers from
    // inside `start()`, the earliest point a poller could.
    const store = await tempStore();
    const admitted: string[] = [];
    const service = createMessagingService(store.asPort(), {
      admit: async ({ event }) => {
        admitted.push(event.providerEventId);
      },
    });
    await bindUser1(store);
    const fixture = createFixtureMessagingConnectorDefinition();
    const instances: FixtureMessagingConnectorInstance[] = [];
    service.registerConnector({
      ...fixture,
      createConnection: (context) => {
        const created = fixture.createConnection(context) as FixtureMessagingConnectorInstance;
        instances.push(created);
        return {
          ...created,
          start: async () => {
            await created.start();
            await created.deliverInbound(inboundEvent({ providerEventId: "evt-at-start" }));
          },
        };
      },
    });

    await service.openConnection({ connection: fixtureConnection("conn-a"), config: {} });
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-at-start"))?.payload.content).toBe("hi");
    const [instance] = instances;
    if (instance === undefined) throw new Error("the connector was never created");
    await instance.deliverInbound(inboundEvent({ providerEventId: "evt-later" }));
    expect(admitted).toEqual(["evt-at-start", "evt-later"]);

    await service.closeConnection("conn-a");
    store.close();
  });

  it("a failed ingest rejects the connector's inbound handler, so the connector withholds its acknowledgement; the redelivery resolves as a duplicate", async () => {
    // The connector keys its acknowledgement on this promise (Telegram leaves
    // its poll offset unadvanced on a rejection), so the service must not
    // swallow the failure on the connector's behalf.
    const store = await tempStore();
    const service = createMessagingService(store.asPort(), {
      admit: async () => {
        throw new Error("workflow admission failed");
      },
    });
    await bindUser1(store);
    const instances: FixtureMessagingConnectorInstance[] = [];
    service.registerConnector(createFixtureMessagingConnectorDefinition({ onInstanceCreated: (created) => instances.push(created) }));
    await service.openConnection({ connection: fixtureConnection("conn-a"), config: {} });
    const [instance] = instances;
    if (instance === undefined) throw new Error("the connector was never created");

    await expect(instance.deliverInbound(inboundEvent({ providerEventId: "evt-fail" }))).rejects.toThrow("workflow admission failed");
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-fail"))?.state).toBe("received");
    // `ingest` admits only a newly recorded event, so the redelivery completes
    // and the connector can acknowledge it rather than retrying forever.
    await expect(instance.deliverInbound(inboundEvent({ providerEventId: "evt-fail" }))).resolves.toBeUndefined();

    await service.closeConnection("conn-a");
    store.close();
  });

  it("admits a held event on its redelivery once admission works again, once, and never twice", async () => {
    const store = await tempStore();
    let failing = true;
    const admitted: string[] = [];
    const service = createMessagingService(store.asPort(), {
      admit: async ({ event }) => {
        if (failing) throw new Error("workflow admission failed");
        admitted.push(event.providerEventId);
      },
    });
    await bindUser1(store);
    const instances: FixtureMessagingConnectorInstance[] = [];
    service.registerConnector(createFixtureMessagingConnectorDefinition({ onInstanceCreated: (created) => instances.push(created) }));
    await service.openConnection({ connection: fixtureConnection("conn-a"), config: {} });
    const [instance] = instances;
    if (instance === undefined) throw new Error("the connector was never created");
    await expect(instance.deliverInbound(inboundEvent({ providerEventId: "evt-later" }))).rejects.toThrow("workflow admission failed");
    failing = false;
    await instance.deliverInbound(inboundEvent({ providerEventId: "evt-later" }));
    await instance.deliverInbound(inboundEvent({ providerEventId: "evt-later" }));
    expect(admitted).toEqual(["evt-later"]);
    expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-later"))?.state).toBe("processed");
    await service.closeConnection("conn-a");
    store.close();
  });

  it("a connector cannot deliver an inbound event on another connection's behalf", async () => {
    // Identity bindings and the inbox are keyed by connection, so an event
    // labelled with a different connection id would be resolved against that
    // connection's bound senders.
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    const instances: FixtureMessagingConnectorInstance[] = [];
    service.registerConnector(createFixtureMessagingConnectorDefinition({ onInstanceCreated: (created) => instances.push(created) }));
    await service.openConnection({ connection: fixtureConnection("conn-b"), config: {} });
    const [instance] = instances;
    if (instance === undefined) throw new Error("the connector was never created");

    await expect(instance.deliverInbound(inboundEvent({ connectionId: "conn-a", providerEventId: "evt-forged" }))).rejects.toThrow(
      /delivered an event for connection conn-a/,
    );
    expect(await store.asPort().repositories.messagingInbox.get("conn-a", "evt-forged")).toBeUndefined();

    await service.closeConnection("conn-b");
    store.close();
  });

  it("reordered inbound events (a later id arriving before an earlier one) are each tracked independently, not merged or dropped", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());

    // evt-2 arrives (is ingested) before evt-1 — genuine reordering, not
    // just two distinct events in sequence.
    const outOfOrder = await service.ingest(inboundEvent({ providerEventId: "evt-2" }));
    const thenEarlier = await service.ingest(inboundEvent({ providerEventId: "evt-1" }));
    expect(outOfOrder).toEqual({ accepted: true, duplicate: false });
    expect(thenEarlier).toEqual({ accepted: true, duplicate: false });

    const inbox = store.asPort().repositories.messagingInbox;
    expect(await inbox.get("conn-a", "evt-1")).toBeDefined();
    expect(await inbox.get("conn-a", "evt-2")).toBeDefined();
    store.close();
  });

  it("recovers after a crash between the inbox commit and acknowledgment", async () => {
    // "Crash" is modeled the same way `agent-delegation-fault.test.ts`
    // already establishes: close the store (releasing locks the way
    // process death does), then reopen a fresh store over the same data
    // directory — the durable row survives the boundary untouched.
    const directory = directories.create("tavi-messaging-crash-");
    const databasePath = join(directory, "tavi.sqlite");
    const artifactsDirectory = join(directory, "artifacts");

    const first = await SqliteStore.open({ databasePath, artifactsDirectory });
    const firstService = createMessagingService(first.asPort());
    await firstService.ingest(inboundEvent({ providerEventId: "evt-crash" }));
    // Simulated crash: the process dies before ever acknowledging upstream
    // or calling markProcessed.
    first.close();

    const second = await SqliteStore.open({ databasePath, artifactsDirectory });
    const recovered = await second.asPort().repositories.messagingInbox.get("conn-a", "evt-crash");
    expect(recovered?.state).toBe("received");
    expect(recovered?.payload.content).toBe("hi");
    // The restarted process can still ingest the identical event again
    // (a legitimate provider retry after the crash) without duplicating it.
    const secondService = createMessagingService(second.asPort());
    const retried = await secondService.ingest(inboundEvent({ providerEventId: "evt-crash" }));
    expect(retried.duplicate).toBe(true);
    second.close();
  });

  it("reports a partial multi-part send as uncertain, never silently success", async () => {
    const store = await tempStore();
    const definition = createFixtureMessagingConnectorDefinition({
      sendOutcome: (message): SendOutcome => ({
        status: "uncertain",
        retryable: true,
        parts: message.parts.map((_, index) => ({
          index,
          status: index === 0 ? "accepted" : "uncertain",
          ...(index === 0 ? { providerMessageId: "pm-0" } : {}),
        })),
      }),
    });
    const service = createMessagingService(store.asPort());
    service.registerConnector(definition);
    await service.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });

    const outcome = await service.send(outboundMessage({ parts: [{ content: "part one" }, { content: "part two" }] }));
    expect(outcome.status).toBe("uncertain");
    expect(outcome.parts[0]?.status).toBe("accepted");
    expect(outcome.parts[1]?.status).toBe("uncertain");

    const stored = await store.asPort().repositories.messagingOutbox.get("eff-1");
    expect(stored?.state).toBe("resolved");
    expect(stored?.outcome?.status).toBe("uncertain");
    store.close();
  });

  it("never calls connector.send when the destination lacks a grant — denied operations make no call", async () => {
    const store = await tempStore();
    let instance: FixtureMessagingConnectorInstance | undefined;
    const definition = createFixtureMessagingConnectorDefinition({ onInstanceCreated: (created) => (instance = created) });
    const service = createMessagingService(store.asPort(), { hasGrant: () => false });
    service.registerConnector(definition);
    await service.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });

    await expect(service.send(outboundMessage())).rejects.toThrow(/not granted/);

    // No outbox row was ever begun — the denial happened before any
    // durable write, let alone before the connector was ever reached.
    expect(await store.asPort().repositories.messagingOutbox.get("eff-1")).toBeUndefined();
    // The acceptance criterion is about the connector, not the outbox row
    // — assert directly on it so a future reordering of send()'s checks
    // can't silently reach the connector while still passing on the
    // outbox-row assertion alone.
    expect(instance?.sent).toEqual([]);
    store.close();
  });

  it("does not retry a pending (crashed-mid-send) effect — returns uncertain instead of risking a duplicate delivery", async () => {
    // A `pending` row (between `begin()` committing and `resolve()` ever
    // running) is ambiguous: the connector may already have been invoked
    // before the simulated crash. `send()` must not guess by calling the
    // connector again — see packages/runtime/src/messaging/service.ts's
    // own doc comment. Forcing the row into `pending` directly here
    // (mirroring how the agent-wait suite drives mid-flight interleavings
    // explicitly rather than relying on real timing) simulates exactly
    // that ambiguous crash window.
    const store = await tempStore();
    let instance: FixtureMessagingConnectorInstance | undefined;
    const definition = createFixtureMessagingConnectorDefinition({ onInstanceCreated: (created) => (instance = created) });
    const service = createMessagingService(store.asPort());
    service.registerConnector(definition);
    await service.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    await store.asPort().repositories.messagingOutbox.begin({
      effectId: "eff-1",
      connectionId: "conn-a",
      message: outboundMessage(),
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    expect((await store.asPort().repositories.messagingOutbox.get("eff-1"))?.state).toBe("pending");

    const outcome = await service.send(outboundMessage());
    expect(outcome).toEqual({ status: "uncertain", retryable: false, parts: [] });
    // Still pending — this call didn't resolve it either, since it never
    // learned anything new about what actually happened.
    expect((await store.asPort().repositories.messagingOutbox.get("eff-1"))?.state).toBe("pending");
    // The connector was never invoked — proves no duplicate delivery risk.
    expect(instance?.sent).toEqual([]);
    store.close();
  });

  it("never calls the connector twice for the same effect once an outcome is durably resolved", async () => {
    const store = await tempStore();
    let instance: FixtureMessagingConnectorInstance | undefined;
    const definition = createFixtureMessagingConnectorDefinition({ onInstanceCreated: (created) => (instance = created) });
    const service = createMessagingService(store.asPort());
    service.registerConnector(definition);
    await service.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });

    const first = await service.send(outboundMessage());
    const second = await service.send(outboundMessage()); // retried call, same effectId
    expect(second).toEqual(first);
    expect(instance?.sent).toHaveLength(1);
  });

  it("buildReplyDestination delegates to the open connection's own connector definition", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    service.registerConnector({
      ...createFixtureMessagingConnectorDefinition(),
      destinationFromInbound: (replyTo, connection) => ({ fixtureChat: replyTo.externalConversationId, via: connection.accountIdentity }),
    });
    await service.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct-a",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });

    expect(service.buildReplyDestination("conn-a", { externalConversationId: "chat-9", externalSenderId: "user-9" })).toEqual({
      fixtureChat: "chat-9",
      via: "acct-a",
    });
  });

  it("buildReplyDestination returns undefined for a connection that isn't open", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    expect(service.buildReplyDestination("no-such-connection", { externalConversationId: "x", externalSenderId: "y" })).toBeUndefined();
  });

  it("buildReplyDestination returns undefined when the connector defines no destinationFromInbound", async () => {
    const store = await tempStore();
    const service = createMessagingService(store.asPort());
    service.registerConnector(createFixtureMessagingConnectorDefinition());
    await service.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct-a",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    expect(service.buildReplyDestination("conn-a", { externalConversationId: "chat-9", externalSenderId: "user-9" })).toBeUndefined();
  });
});
