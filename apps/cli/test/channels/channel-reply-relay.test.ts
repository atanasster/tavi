import { describe, expect, it } from "vitest";

import type { AdmissionOutcome, OutboundMessage } from "@tavi/contracts";

import { createChannelReplyRelay, type ChannelReplyRelayDeps } from "../../src/features/channels/reply-relay.js";

const REPLY_TO = {
  connectionId: "mail-1",
  externalConversationId: "thread-9",
  externalSenderId: "ana@example.com",
  externalMessageId: "<m2@example.com>",
  externalReferences: ["<m1@example.com>"],
  subject: "Trip",
  audience: "one-to-one" as const,
};
const CHANNEL_REPLY = { content: "Hello there", replyTo: REPLY_TO };
const OUTCOME: AdmissionOutcome = { status: "completed", finalText: "Hello there", channelReply: CHANNEL_REPLY };

function harness(rejected = false) {
  const sent: OutboundMessage[] = [];
  const addressed: unknown[] = [];
  const warnings: string[] = [];
  const deps: ChannelReplyRelayDeps = {
    repositories: {
      tasks: { get: async (taskId: string) => (taskId === "task-1" ? { workspaceId: "default" } : undefined) },
    } as unknown as ChannelReplyRelayDeps["repositories"],
    messaging: {
      buildReplyDestination: (connectionId, replyTo) => {
        addressed.push(replyTo);
        return connectionId === "local-default" ? undefined : { to: replyTo.externalSenderId };
      },
      send: async (message) => {
        sent.push(message);
        return { status: rejected ? "rejected" : "accepted", retryable: false, parts: [] } as unknown as Awaited<
          ReturnType<ChannelReplyRelayDeps["messaging"]["send"]>
        >;
      },
    },
    isLocalConnection: (connectionId) => connectionId === "local-default",
    warn: (message) => warnings.push(message),
  };
  return { relay: createChannelReplyRelay(deps), sent, addressed, warnings };
}

describe("channel reply relay", () => {
  it("sends the turn's owed answer to the turn's own message, keyed by the admission", async () => {
    const { relay, sent, addressed } = harness();
    await relay.onTaskEnded("task-1", "admission-1", OUTCOME);
    expect(sent).toEqual([
      {
        effectId: "turn-reply:task-1:admission-1",
        connectionId: "mail-1",
        workspaceId: "default",
        destination: { to: "ana@example.com" },
        parts: [{ content: "Hello there" }],
      },
    ]);
    // An email answer keeps its subject and thread.
    expect(addressed).toEqual([
      {
        externalConversationId: "thread-9",
        externalSenderId: "ana@example.com",
        externalMessageId: "<m2@example.com>",
        externalReferences: ["<m1@example.com>"],
        subject: "Trip",
      },
    ]);
  });

  it.each<[string, AdmissionOutcome, string | undefined]>([
    ["no answer owed", { status: "completed", finalText: "Sent already" }, "admission-1"],
    ["a failed turn", { status: "failed", finalText: "x", channelReply: CHANNEL_REPLY }, "admission-1"],
    ["an end with no admission", OUTCOME, undefined],
    [
      "the local connection",
      { ...OUTCOME, channelReply: { content: "x", replyTo: { ...REPLY_TO, connectionId: "local-default" } } },
      "admission-1",
    ],
  ])("sends nothing for %s", async (_label, outcome, admissionId) => {
    const { relay, sent } = harness();
    await relay.onTaskEnded("task-1", admissionId, outcome);
    expect(sent).toEqual([]);
  });

  it("logs a refused send instead of throwing", async () => {
    const { relay, warnings } = harness(true);
    await expect(relay.onTaskEnded("task-1", "admission-1", OUTCOME)).resolves.toBeUndefined();
    expect(warnings).toEqual(["a chat's answer could not be relayed to its channel"]);
  });
});
