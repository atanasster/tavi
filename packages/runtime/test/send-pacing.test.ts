import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import type { MessagingCapabilities, OutboundMessage, SendOutcome } from "@tavi/contracts";

import { DatabaseClient } from "../src/persistence/client.js";
import { createMessagingService } from "../src/messaging/service.js";
import { createSendPacer } from "../src/messaging/send-pacer.js";

/**
 * A connection's send pace, delivery statuses and activity: sends are paced by the
 * channel's `sendRate`, a provider's "too fast" holds the queue back instead
 * of failing the send, a delivery status finds the send it names, and the
 * connection's status says when it last took a message in or sent one.
 */

const AT = "2026-10-09T00:00:00.000Z";
const capabilities: MessagingCapabilities = {
  receiveMode: "webhook",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: false,
  interactions: false,
  deliveryReceipts: true,
  maxTextLength: 4096,
  approvals: "none",
};

const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** A clock that only moves when something waits on it. */
function fakeClock() {
  let at = Date.parse(AT);
  const slept: number[] = [];
  return {
    nowMs: () => at,
    now: () => new Date(at).toISOString(),
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
    slept,
  };
}

describe("createSendPacer", () => {
  it("lets a short burst through, then paces overall and to one target, and holds back after a pause", async () => {
    const clock = fakeClock();
    const pacer = createSendPacer(clock.nowMs, clock.sleep);
    const rate = { perMinute: 60, perTargetPerMinute: 20 };
    // A burst of three seconds' worth: one to a target at 20 a minute.
    await pacer.take("c", rate, "a");
    expect(clock.slept).toEqual([]);
    await pacer.take("c", rate, "a");
    expect(clock.slept).toEqual([3000]);
    // Another target is not held by the first's pace.
    await pacer.take("c", rate, "b");
    expect(clock.slept).toEqual([3000]);
    pacer.backOff("c", 10_000);
    await pacer.take("c", rate, "b");
    expect(clock.slept.at(-1)).toBe(10_000);
  });
});

describe("the send queue", () => {
  async function owner(answers: SendOutcome[], grant: () => boolean = () => true) {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const clock = fakeClock();
    const sent: OutboundMessage[] = [];
    const messaging = createMessagingService(db, {
      now: clock.now,
      sleep: clock.sleep,
      sendRateOf: () => ({ perMinute: 600 }),
      hasGrant: () => grant(),
    });
    messaging.registerConnector({
      providerId: "hooky",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true }),
        send: async (message) => {
          sent.push(message);
          return (
            answers.shift() ?? {
              status: "accepted",
              retryable: false,
              parts: [{ index: 0, status: "accepted", providerMessageId: `m${sent.length}` }],
            }
          );
        },
      }),
    });
    await messaging.openConnection({
      connection: { connectionId: "c1", providerId: "hooky", accountIdentity: "a", workspaceId: "w", configRevision: 1, enabled: true },
      config: {},
    });
    const message = (effectId: string): OutboundMessage => ({
      effectId,
      connectionId: "c1",
      destination: { to: "x" },
      parts: [{ content: "hi" }],
    });
    return { db, messaging, sent, clock, message };
  }

  it("holds a send the provider said was too fast and sends it again, rather than failing it", async () => {
    const tooFast: SendOutcome = {
      status: "rejected",
      retryable: false,
      retryAfterMs: 2000,
      parts: [{ index: 0, status: "rejected", error: "Too Many Requests: retry after 2" }],
    };
    const { messaging, sent, clock, message } = await owner([tooFast]);
    expect((await messaging.send(message("e1"))).status).toBe("accepted");
    expect(sent).toHaveLength(2);
    expect(clock.slept).toContain(2000);
  });

  it("gives up on a wait too long or after its retries, and reports the provider's refusal", async () => {
    const tooFast = (retryAfterMs: number): SendOutcome => ({
      status: "rejected",
      retryable: false,
      retryAfterMs,
      parts: [{ index: 0, status: "rejected", error: "slow down" }],
    });
    const long = await owner([tooFast(120_000)]);
    expect((await long.messaging.send(long.message("e1"))).status).toBe("rejected");
    expect(long.sent).toHaveLength(1);
    const stubborn = await owner([tooFast(10), tooFast(10), tooFast(10), tooFast(10)]);
    expect((await stubborn.messaging.send(stubborn.message("e1"))).status).toBe("rejected");
    expect(stubborn.sent).toHaveLength(4);
    // Why it failed, and when nothing came in or went out, on the connection's status.
    expect(stubborn.messaging.statusOf("c1")).toEqual({ state: "running", since: AT, lastError: "slow down" });
  });

  it("never tries again a send the provider took part of, and holds the next send for the provider's wait", async () => {
    const partly: SendOutcome = {
      status: "rejected",
      retryable: false,
      retryAfterMs: 120_000,
      parts: [
        { index: 0, status: "accepted", providerMessageId: "m1" },
        { index: 1, status: "rejected", error: "slow down" },
      ],
    };
    const { messaging, sent, clock, message } = await owner([partly]);
    expect((await messaging.send(message("e1"))).status).toBe("rejected");
    expect(sent).toHaveLength(1);
    // Not retried, but the provider's wait still holds what comes next.
    await messaging.send(message("e2"));
    expect(clock.slept).toContain(120_000);
  });

  it("sends nothing whose grant was revoked while it waited its turn, and records it as sent nothing", async () => {
    const tooFast: SendOutcome = {
      status: "rejected",
      retryable: false,
      retryAfterMs: 1000,
      parts: [{ index: 0, status: "rejected", error: "slow down" }],
    };
    // Revoked once the first try has gone out.
    const { db, messaging, sent, message } = await owner([tooFast], () => sent.length === 0);
    await expect(messaging.send(message("e1"))).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(sent).toHaveLength(1);
    expect(await db.repositories.messagingOutbox.get("e1")).toMatchObject({ state: "resolved", outcome: { status: "rejected" } });
  });

  it("records a delivery status on the send it names, only forward, and says when it last sent and took a message in", async () => {
    const { db, messaging, message, clock } = await owner([]);
    await messaging.send(message("e1"));
    expect(messaging.statusOf("c1")?.lastSendAt).toBe(clock.now());
    expect(
      await messaging.recordDelivery({
        connectionId: "c1",
        providerMessageId: "m1",
        status: "read",
        occurredAt: "2026-10-09T00:01:00.000Z",
      }),
    ).toBe(true);
    // Arriving late, "delivered" does not take a read message back.
    expect(
      await messaging.recordDelivery({
        connectionId: "c1",
        providerMessageId: "m1",
        status: "delivered",
        occurredAt: "2026-10-09T00:00:30.000Z",
      }),
    ).toBe(true);
    expect((await db.repositories.messagingOutbox.get("e1"))?.delivery).toEqual({ status: "read", at: "2026-10-09T00:01:00.000Z" });
    expect(await messaging.recordDelivery({ connectionId: "c1", providerMessageId: "nobody", status: "delivered", occurredAt: AT })).toBe(
      false,
    );
    // A delivery event comes in like a message, and is recorded, never admitted.
    await messaging.ingest({
      connectionId: "c1",
      providerEventId: "d1",
      kind: "delivery",
      externalSenderId: "x",
      externalConversationId: "x",
      occurredAt: "2026-10-09T00:02:00.000Z",
      receivedAt: AT,
      delivery: { providerMessageId: "m1", status: "failed", detail: "blocked" },
    });
    expect((await db.repositories.messagingOutbox.get("e1"))?.delivery).toEqual({
      status: "failed",
      at: "2026-10-09T00:02:00.000Z",
      detail: "blocked",
    });
    expect(messaging.statusOf("c1")).not.toHaveProperty("lastInboundAt");
    await messaging.ingest({
      connectionId: "c1",
      providerEventId: "in1",
      kind: "message",
      externalSenderId: "x",
      externalConversationId: "x",
      occurredAt: AT,
      receivedAt: AT,
      content: "hello",
    });
    expect(messaging.statusOf("c1")?.lastInboundAt).toBe(clock.now());
  });
});
