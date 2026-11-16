import { join } from "node:path";

import type { InboundEvent } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createMessagingService } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi inbox list|replay`.
 *
 * A message from an unbound sender is held rather than dropped, and if the
 * sender is bound only *after* that exact event was recorded, nothing ever
 * admits it: `created` is false on every redelivery, so the ordinary path treats
 * it as a duplicate. It stays `received` forever — invisible and unreplayable —
 * until this command exists.
 */

const directories = temporaryDirectories({ prefix: "tavi-inbox-" });

afterEach(() => directories.cleanup());

function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    connectionId: "conn-a",
    providerEventId: "evt-1",
    kind: "message",
    externalConversationId: "chat-1",
    externalSenderId: "user-1",
    externalMessageId: "m-1",
    content: "hello",
    receivedAt: "2026-04-05T04:00:00.000Z",
    ...overrides,
  } as InboundEvent;
}

async function tempStore(directory: string): Promise<SqliteStore> {
  return await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

describe("held inbound messages", () => {
  it("lists a held message with the principal it would resolve to now", async () => {
    const directory = directories.create();
    const store = await tempStore(directory);
    try {
      const service = createMessagingService(store.asPort());
      // Recorded while the sender is unbound: held, not admitted.
      await service.ingest(inboundEvent());
      expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-1"))?.state).toBe("received");

      const before = capture();
      expect(await main(["inbox", "list", "--format", "json", "--data-dir", directory], { io: before.io })).toBe(EXIT.ok);
      const listing = JSON.parse(before.stdout()) as {
        held: { providerEventId: string; externalSenderId: string; resolvedPrincipalId: string | null }[];
        total: number;
        truncated: boolean;
      };
      expect(listing.total).toBe(1);
      expect(listing.truncated).toBe(false);
      expect(listing.held[0]).toMatchObject({ providerEventId: "evt-1", externalSenderId: "user-1", resolvedPrincipalId: null });

      // Binding the sender afterwards is exactly the case `replay` exists for.
      await store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "w1",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-04-05T05:00:00.000Z",
      });
      const after = capture();
      expect(await main(["inbox", "list", "--format", "json", "--data-dir", directory], { io: after.io })).toBe(EXIT.ok);
      const rebound = JSON.parse(after.stdout()) as { held: { resolvedPrincipalId: string | null }[] };
      expect(rebound.held[0]?.resolvedPrincipalId).toBe("alice");
    } finally {
      store.close();
    }
  });

  it("takes in a sender id and name without control characters, and prints neither with one", async () => {
    const directory = directories.create();
    const store = await tempStore(directory);
    try {
      const service = createMessagingService(store.asPort());
      await service.ingest(inboundEvent({ externalSenderId: "user\u001b]8;;https://x.example\u0007-1", senderName: "Ana\u001b[31m\tB" }));
      const row = await store.asPort().repositories.messagingInbox.get("conn-a", "evt-1");
      // Each control in the id is replaced, never dropped: it must not read as `user-1`, a sender who may be bound.
      expect(row?.payload.externalSenderId).toBe("user\ufffd]8;;https://x.example\ufffd-1");
      expect(row?.payload.senderName).toBe("Ana B");
      const listed = capture();
      expect(await main(["inbox", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
      expect(listed.stdout()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(listed.stdout()).toContain("user\ufffd]8;;https://x.example\ufffd-1\n");
    } finally {
      store.close();
    }
  });

  it("replays a held event once its sender is bound, through the same admit path as a fresh message", async () => {
    const directory = directories.create();
    const store = await tempStore(directory);
    const admitted: string[] = [];
    try {
      const service = createMessagingService(store.asPort(), {
        admit: async ({ event, actor }) => {
          admitted.push(`${event.providerEventId}:${actor.principalId}`);
        },
      });
      await service.ingest(inboundEvent());
      // Unbound: the replay refuses by *outcome*, not by throwing, because it is
      // a normal thing for an operator to hit.
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).toEqual({
        outcome: "unbound",
        externalSenderId: "user-1",
      });
      expect(admitted).toHaveLength(0);

      await store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "w1",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-04-05T05:00:00.000Z",
      });
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).toEqual({
        outcome: "admitted",
        principalId: "alice",
      });
      expect(admitted).toEqual(["evt-1:alice"]);
      // Processed now, so the retention sweep may retire it and `doctor`'s
      // unprocessed count drops.
      expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-1"))?.state).toBe("processed");

      // Idempotent: a second replay says so rather than admitting twice.
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).toEqual({ outcome: "already-processed" });
      expect(admitted).toHaveLength(1);
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-missing" })).toEqual({ outcome: "not-found" });
    } finally {
      store.close();
    }
  });

  it("holds a bound sender's unverified message unless the binding trusts unverified mail", async () => {
    const directory = directories.create();
    const store = await tempStore(directory);
    const admitted: string[] = [];
    const told: string[] = [];
    try {
      const bindings = store.asPort().repositories.messagingIdentityBindings;
      const service = createMessagingService(store.asPort(), {
        admit: async ({ event, actor }) => {
          admitted.push(`${event.providerEventId}:${actor.principalId}`);
        },
        onUnverified: async ({ event }) => {
          told.push(event.providerEventId);
        },
      });
      await bindings.bind({
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "w1",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-04-05T05:00:00.000Z",
      });

      // A forged From of a bound address: recorded and held, never a turn.
      const forged = await service.ingest(inboundEvent({ providerEventId: "evt-forged", senderAuthentication: "fail" }));
      expect(forged).toMatchObject({ accepted: true, duplicate: false, resolvedPrincipalId: "alice", unverified: true });
      expect(admitted).toEqual([]);
      expect(told).toEqual(["evt-forged"]);
      expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-forged"))?.state).toBe("received");
      // A redelivery is a duplicate: the sender is not told twice.
      await service.ingest(inboundEvent({ providerEventId: "evt-forged", senderAuthentication: "fail" }));
      expect(told).toEqual(["evt-forged"]);
      // A replay must not admit what ingest held.
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-forged" })).toEqual({
        outcome: "unverified",
        externalSenderId: "user-1",
      });

      // Verified mail and channels without per-message authentication are admitted as before.
      await service.ingest(inboundEvent({ providerEventId: "evt-pass", senderAuthentication: "pass" }));
      await service.ingest(inboundEvent({ providerEventId: "evt-chat" }));
      expect(admitted).toEqual(["evt-pass:alice", "evt-chat:alice"]);

      // The per-person override admits unverified mail, and the held message can now be replayed.
      expect(await bindings.setTrustUnverified("conn-a", "user-1", { setBy: "operator", setAt: "2026-04-05T06:00:00.000Z" })).toBe(true);
      expect((await bindings.get("conn-a", "user-1"))?.trustUnverified).toEqual({ setBy: "operator", setAt: "2026-04-05T06:00:00.000Z" });
      await service.ingest(inboundEvent({ providerEventId: "evt-unknown", senderAuthentication: "unknown" }));
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-forged" })).toEqual({
        outcome: "admitted",
        principalId: "alice",
      });
      expect(admitted).toEqual(["evt-pass:alice", "evt-chat:alice", "evt-unknown:alice", "evt-forged:alice"]);

      // Turned off, and never for a pair that is not bound.
      expect(await bindings.setTrustUnverified("conn-a", "user-1", null)).toBe(true);
      expect((await bindings.get("conn-a", "user-1"))?.trustUnverified).toBeUndefined();
      expect(await bindings.setTrustUnverified("conn-a", "nobody", { setBy: "operator", setAt: "2026-04-05T06:00:00.000Z" })).toBe(false);
    } finally {
      store.close();
    }
  });

  it("claims a held row so two replays cannot admit it twice, and gives the claim back when admission fails", async () => {
    // `markProcessed` lands only after admission, so the claim is what makes a
    // concurrent replay (or a crash plus a retry) safe.
    const store = await tempStore(directories.create());
    try {
      const admitted: string[] = [];
      let failNext = true;
      const service = createMessagingService(store.asPort(), {
        admit: async ({ event }) => {
          if (failNext) throw new Error("admission failed");
          admitted.push(event.providerEventId);
        },
      });
      await service.ingest(inboundEvent());
      await store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "w1",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-04-05T05:00:00.000Z",
      });

      // A failed admission releases the claim, so the message is not lost.
      await expect(service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).rejects.toThrow("admission failed");
      expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-1"))?.state).toBe("received");

      // A claim held by an in-flight replay makes the second attempt refuse
      // rather than admit a duplicate.
      const claimed = await store.asPort().repositories.messagingInbox.claimForReplay({
        connectionId: "conn-a",
        providerEventId: "evt-1",
        now: nowTimestamp(),
        staleBefore: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(claimed).toBe(true);
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).toEqual({ outcome: "in-flight" });

      // A *stale* claim is takeable again, so a crashed replay retries.
      await store.asPort().repositories.messagingInbox.releaseReplayClaim("conn-a", "evt-1");
      const stale = await store.asPort().repositories.messagingInbox.claimForReplay({
        connectionId: "conn-a",
        providerEventId: "evt-1",
        now: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        staleBefore: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      expect(stale).toBe(true);

      failNext = false;
      await store.asPort().repositories.messagingInbox.releaseReplayClaim("conn-a", "evt-1");
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).toMatchObject({ outcome: "admitted" });
      expect(admitted).toEqual(["evt-1"]);
    } finally {
      store.close();
    }
  });

  it("reports admission-closed instead of marking a message processed that was never admitted", async () => {
    // Composition always supplies an `admit` wrapper, and it is a no-op without a
    // model transport — so the service must ask, not assume.
    const store = await tempStore(directories.create());
    try {
      let admitted = false;
      const service = createMessagingService(store.asPort(), {
        admit: async () => {
          admitted = true;
        },
        admissionOpen: () => false,
      });
      await service.ingest(inboundEvent());
      await store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "w1",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-04-05T05:00:00.000Z",
      });
      expect(await service.replay({ connectionId: "conn-a", providerEventId: "evt-1" })).toEqual({ outcome: "admission-closed" });
      expect(admitted).toBe(false);
      // Still held: the operator can retry once a model is configured.
      expect((await store.asPort().repositories.messagingInbox.get("conn-a", "evt-1"))?.state).toBe("received");
    } finally {
      store.close();
    }
  });

  it("says the queue is empty rather than printing nothing", async () => {
    const directory = directories.create();
    expect(await main(["models", "list", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const shown = capture();
    expect(await main(["inbox", "list", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain("no held inbound messages");
  });

  it("looks the held event up before starting anything, so a wrong id is one line with no owner logs", async () => {
    const directory = directories.create();
    const store = await tempStore(directory);
    try {
      await createMessagingService(store.asPort()).ingest(inboundEvent());
    } finally {
      store.close();
    }
    // No model is set up here: an owner composed for the replay would refuse before saying anything about the event.
    const missing = capture();
    expect(await main(["inbox", "replay", "evt-missing", "--connection", "conn-a", "--data-dir", directory], { io: missing.io })).toBe(
      EXIT.usage,
    );
    expect(missing.stdout()).toBe("no held message evt-missing on connection conn-a\n");
    expect(missing.stderr()).toBe("");
  });

  it("requires a connection and an event id for replay, and its own help page", async () => {
    const directory = directories.create();
    const missingConnection = capture();
    expect(await main(["inbox", "replay", "evt-1", "--data-dir", directory], { io: missingConnection.io })).toBe(EXIT.usage);
    expect(missingConnection.stderr()).toMatch(/needs --connection/);
    const missingAction = capture();
    expect(await main(["inbox", "--data-dir", directory], { io: missingAction.io })).toBe(EXIT.usage);
    expect(missingAction.stderr()).toMatch(/inbox needs an action/);
    const help = capture();
    expect(await main(["inbox", "--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toMatch(/^tavi inbox <action>/);
  });
});
