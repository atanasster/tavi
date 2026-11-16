import { describe, expect, it } from "vitest";

import type { InboundEvent, OutboundMessage } from "@tavi/contracts";

import { FLOOD_NOTICE, createRoomInvitations, roomInvitationsSource } from "../../src/features/channels/group-pairing.js";

/**
 * Group pairing:
 * a room the agent was added to, or that spoke unlisted, waits for the
 * operator, and only the operator hears of it; a flooding room gets its notice.
 */

const AT = "2026-10-18T08:00:00.000Z";

const event = (changes: Partial<InboundEvent> = {}): InboundEvent => ({
  connectionId: "conn-1",
  providerEventId: "e",
  kind: "message",
  externalSenderId: "u-1",
  externalConversationId: "room-1",
  conversationKind: "group",
  occurredAt: AT,
  receivedAt: AT,
  ...changes,
});

function fixture() {
  let now = AT;
  const sent: OutboundMessage[] = [];
  const invitations = createRoomInvitations({
    now: () => now,
    messaging: {
      send: async (message) => {
        sent.push(message);
        return { status: "accepted", retryable: false, parts: [] };
      },
      buildReplyDestination: (_connectionId, replyTo) => ({ room: replyTo.externalConversationId }),
    },
    workspaceOf: async () => "default",
  });
  return {
    invitations,
    sent,
    at: (value: string) => {
      now = value;
    },
  };
}

describe("room invitations", () => {
  it("keep a room the agent was added to, and a room that spoke unlisted, until the operator settles it", async () => {
    const { invitations } = fixture();
    await invitations.notice({
      kind: "membership",
      event: event({ kind: "membership", membership: { change: "added", roomName: "Game night" } }),
    });
    await invitations.notice({ kind: "unlisted", event: event({ externalConversationId: "room-2", externalSenderId: "u-2" }) });
    // A later message from a room the agent was added to does not hide that it was added.
    await invitations.notice({ kind: "unlisted", event: event() });
    expect(invitations.list("conn-1")).toEqual([
      { connectionId: "conn-1", conversationId: "room-1", by: "u-1", roomName: "Game night", how: "added", at: AT },
      { connectionId: "conn-1", conversationId: "room-2", by: "u-2", how: "spoke", at: AT },
    ]);
    invitations.settle("conn-1", "room-2");
    await invitations.notice({ kind: "membership", event: event({ kind: "membership", membership: { change: "removed" } }) });
    expect(invitations.list("conn-1")).toEqual([]);
  });

  it("lapse after a week", async () => {
    const { invitations, at } = fixture();
    await invitations.notice({ kind: "unlisted", event: event() });
    at("2026-10-25T08:00:01.000Z");
    expect(invitations.list("conn-1")).toEqual([]);
  });

  it("answer a flooding room once, with an effect for the hour", async () => {
    const { invitations, sent } = fixture();
    await invitations.notice({ kind: "flood", event: event() });
    expect(sent).toEqual([
      expect.objectContaining({
        connectionId: "conn-1",
        workspaceId: "default",
        destination: { room: "room-1" },
        parts: [{ content: FLOOD_NOTICE }],
        effectId: expect.stringMatching(/^room-flood:[0-9a-f]{16}:2026-10-18T08$/),
      }),
    ]);
    expect(invitations.list("conn-1")).toEqual([]);
  });
});

describe("the rooms signal source", () => {
  it("tells the operator alone, once per room", async () => {
    const { invitations } = fixture();
    await invitations.notice({
      kind: "membership",
      event: event({ kind: "membership", membership: { change: "added", roomName: "Game night" } }),
    });
    const source = roomInvitationsSource({
      invitations,
      connections: {
        list: async () => [{ connectionId: "conn-1", providerId: "parrot", label: "Parrot", workspaceId: "default" }] as never,
      },
      operatorOf: () => "operator",
    });
    const scope = (principalId: string) => ({ workspaceId: "default", principalId, now: AT }) as never;
    const told = await source.collect(scope("operator"));
    expect(told).toEqual([
      expect.objectContaining({
        hash: "added:2026-10-18",
        title: "u-1 added Tavi to a room on Parrot (Game night): add it or leave",
        source: "Channels",
        data: { connectionId: "conn-1", conversationId: "room-1" },
      }),
    ]);
    expect(await source.collect(scope("friend"))).toEqual([]);
  });

  it("tells again of a room nobody listed each day it keeps talking, never twice a day", async () => {
    const { invitations, at } = fixture();
    const source = roomInvitationsSource({
      invitations,
      connections: {
        list: async () => [{ connectionId: "conn-1", providerId: "parrot", label: "Parrot", workspaceId: "default" }] as never,
      },
      operatorOf: () => "operator",
    });
    const hashOf = async () => {
      const told = await source.collect({ workspaceId: "default", principalId: "operator", now: AT } as never);
      return ("signals" in told ? told.signals : told)[0]?.hash;
    };
    // Added, and then talking: the same, day by day.
    await invitations.notice({ kind: "membership", event: event({ kind: "membership", membership: { change: "added" } }) });
    const first = await hashOf();
    at("2026-10-18T20:00:00.000Z");
    await invitations.notice({ kind: "unlisted", event: event() });
    expect(await hashOf()).toBe(first);
    at("2026-10-19T09:00:00.000Z");
    await invitations.notice({ kind: "unlisted", event: event() });
    expect(await hashOf()).not.toBe(first);
  });
});
