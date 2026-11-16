import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import type { ChannelRoomRecord, InboundEvent } from "@tavi/contracts";

import { createRoomPolicy } from "../src/messaging/room-policy.js";

/**
 * The room policy's flood buckets are bounded: 100,000 synthetic senders, in a
 * room and one-to-one, keep the policy's memory to its newest keys.
 */

const SENDERS = 100_000;
const room: ChannelRoomRecord = {
  connectionId: "conn",
  conversationId: "room",
  workspaceId: "w",
  label: "Room",
  trigger: ["mention"],
  members: "bound",
  context: "off",
  introState: "sent",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
};

const event = (sender: string, conversationKind: "group" | "direct", index: number): InboundEvent => ({
  connectionId: "conn",
  providerEventId: `evt-${index}`,
  kind: "message",
  externalSenderId: sender,
  externalConversationId: conversationKind === "group" ? "room" : sender,
  conversationKind,
  occurredAt: "2026-10-18T00:00:00.000Z",
  receivedAt: "2026-10-18T00:00:00.000Z",
  content: "hi",
  addressed: ["mention"],
  authorKind: "person",
});

const megabytes = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

describe("room policy memory", () => {
  it(`stays bounded over ${String(SENDERS)} synthetic senders`, async () => {
    let clock = Date.parse("2026-10-18T00:00:00.000Z");
    const policy = createRoomPolicy({
      repositories: {
        channelRooms: {
          get: async (connectionId, conversationId) => (connectionId === "conn" && conversationId === "room" ? room : undefined),
        },
        // Every room sender is bound; every one-to-one sender is not, which is the bucket that keeps pairing spam bounded.
        messagingIdentityBindings: {
          get: async (_connection, sender) =>
            sender.startsWith("member-")
              ? {
                  connectionId: "conn",
                  externalSenderId: sender,
                  workspaceId: "w",
                  principalId: sender,
                  approvedBy: "operator",
                  createdAt: "2026-10-18T00:00:00.000Z",
                }
              : undefined,
        },
        messagingInbox: { get: async () => undefined },
      },
      groupPolicyOf: () => ({ unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention"] }),
      // Buckets that never fill, so every decision keeps its sender's key: what is measured is the bound on keys alone.
      limits: { roomPerMinute: Number.MAX_SAFE_INTEGER, roomPerHour: Number.MAX_SAFE_INTEGER, senderPerMinute: Number.MAX_SAFE_INTEGER },
      now: () => (clock += 1_000),
    });
    // A full collection before each reading, so what is measured is what the policy keeps, not garbage not yet swept.
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const settle = (): void => {
      collect();
      collect();
    };
    const warm = async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        await policy.decide(event(`member-${String(index)}`, "group", index));
        await policy.decide(event(`stranger-${String(index)}`, "direct", SENDERS + index));
      }
    };
    await warm(1_000);
    settle();
    const before = process.memoryUsage();
    await warm(SENDERS);
    settle();
    const after = process.memoryUsage();
    const grown = { rssMb: megabytes(after.rss - before.rss), heapUsedMb: megabytes(after.heapUsed - before.heapUsed) };
    console.log(
      `room policy over ${String(SENDERS)} senders: rss ${String(megabytes(before.rss))} MB → ${String(megabytes(after.rss))} MB, heap ${String(megabytes(before.heapUsed))} MB → ${String(megabytes(after.heapUsed))} MB`,
      grown,
    );
    // Its maps keep their newest 2,000 keys: what 200,000 kept keys would take (tens of megabytes) never stays.
    expect(grown.heapUsedMb).toBeLessThan(8);
    expect(policy.drops("conn")).toEqual({});
  }, 120_000);
});
