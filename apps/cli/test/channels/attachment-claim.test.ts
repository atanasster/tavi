import type { InboundEvent } from "@tavi/contracts";
import { untrustedLabel } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createFixtureMessagingConnectorDefinition } from "@tavi/test-support/messaging";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A channel message's attachment is given the chat the message starts or
 * joins, so only that chat's tools read it; a second chat never takes it.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const message = (providerEventId: string, conversation: string, attachment: string): InboundEvent => ({
  connectionId: "conn-a",
  providerEventId,
  kind: "message",
  externalSenderId: "user-1",
  externalConversationId: conversation,
  occurredAt: "2026-01-01T00:00:00.000Z",
  receivedAt: "2026-01-01T00:00:00.000Z",
  content: "what did I say here?",
  conversationKind: "direct",
  attachments: [{ artifactId: attachment, filename: "voice.ogg" }],
});

describe("a channel message's attachments", () => {
  it("belong to the chat the message starts, and to no other", async () => {
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directories.create("tavi-attachment-claim-"), {
        workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      }),
      { modelOverride: createFixtureModel({ turns: [{ text: "heard you" }, { text: "heard you again" }] }) },
    );
    try {
      runtime.messaging.registerConnector({
        ...createFixtureMessagingConnectorDefinition(),
        destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
      });
      await runtime.messaging.openConnection({
        connection: {
          connectionId: "conn-a",
          providerId: "fixture",
          accountIdentity: "acct-a",
          workspaceId: "default",
          configRevision: 1,
          enabled: true,
        },
        config: {},
      });
      const repositories = runtime.store.asPort().repositories;
      await repositories.messagingIdentityBindings.bind({
        connectionId: "conn-a",
        externalSenderId: "user-1",
        workspaceId: "default",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      // As intake keeps it: an untrusted `attachment`, with no run yet.
      const voice = await repositories.artifacts.putArtifact({
        artifactId: "art-in-voice",
        workspaceId: "default",
        contentType: "audio/ogg",
        body: new TextEncoder().encode("OggS"),
        extension: "ogg",
        untrusted: true,
        label: untrustedLabel("attachment"),
      });
      expect(voice.runId).toBeNull();
      await runtime.messaging.ingest(message("evt-1", "chat-1", voice.artifactId));
      const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId;
      expect(taskId).toBeDefined();
      expect((await repositories.artifacts.getArtifact(voice.artifactId))?.runId).toBe(taskId);
      // The same file named again from another chat stays the first chat's.
      await runtime.messaging.ingest(message("evt-2", "chat-2", voice.artifactId));
      const other = (await repositories.messagingConversations.get("conn-a", "chat-2"))?.taskId;
      expect(other).toBeDefined();
      expect(other).not.toBe(taskId);
      expect((await repositories.artifacts.getArtifact(voice.artifactId))?.runId).toBe(taskId);
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
