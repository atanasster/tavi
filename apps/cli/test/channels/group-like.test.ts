import { z } from "zod";

import { describeGroupChannelConformance, type GroupFake, type GroupScript } from "@tavi/channel-kit/conformance";
import { PluginManifestSchema, TaviError, type ChannelDescriptor } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createGroupLikeDefinition, createGroupLikePlatform } from "../../../../tests/fixtures/channel-group-like/index.mjs";
import manifest from "../../../../tests/fixtures/channel-group-like/tavi-plugin.json" with { type: "json" };

/**
 * The group-like fixture plugin passes the group conformance suite over its own fake platform.
 */

const descriptor = (manifest as unknown as { channels: ChannelDescriptor[] }).channels[0] as ChannelDescriptor;

async function fake(): Promise<GroupFake> {
  const platform = createGroupLikePlatform({ closed: ["closed-1"] });
  // A room with a little history, for `fetchRecent`.
  platform.say({ author: "ann", room: "room-1", text: "morning", past: true });
  platform.say({ author: "helper-bot", room: "room-1", text: "beep", bot: true, past: true });
  platform.say({ author: "ann", room: "room-1", text: "who's in?", past: true });
  const definition = createGroupLikeDefinition({ z, TaviError, fetch: platform.fetch });
  const connection = {
    connectionId: "gl-conformance",
    providerId: "group-like",
    accountIdentity: "bot-1",
    workspaceId: "w",
    configRevision: 1,
    enabled: true,
    credentialRefs: { token: "ref.token" },
  };
  const instance = definition.createConnection({
    connection,
    config: {},
    credentials: { get: async () => platform.token, accessToken: async () => platform.token },
  });
  const scripted = (script: GroupScript): void => {
    switch (script.kind) {
      case "mention":
        platform.say({ author: "user-1", room: "room-1", text: "hello", mention: true });
        return;
      case "reply":
        platform.say({ author: "user-1", room: "room-1", text: "yes", replyTo: { id: "msg-0", author: platform.botId } });
        return;
      case "thread":
        platform.say({ author: "user-1", room: "room-1", text: "and then?", thread: { id: "thread-1", startedByBot: true } });
        return;
      case "command":
        platform.say({ author: "user-1", room: "room-1", command: "ask", text: "what's next" });
        return;
      case "picked":
        platform.say({ author: "user-1", room: "room-1", picked: { id: "msg-9", author: "ann", text: "the plan" } });
        return;
      case "plain":
        platform.say({ author: "user-1", room: "room-1", text: "just talking" });
        return;
      case "bot":
        platform.say({ author: "helper-bot", room: "room-1", text: "beep", bot: true });
        return;
      case "system":
        platform.say({ author: "system", room: "room-1", text: "ann joined", system: true });
        return;
      case "press":
        platform.press({ presser: script.presser, data: script.data });
        return;
      case "direct":
        platform.say({ author: script.sender, text: "hi" });
        return;
    }
  };
  return {
    definition,
    instance,
    connection,
    room: "room-1",
    // The history said above: ann's, a bot's, ann's.
    recentKinds: ["person", "bot", "person"],
    openSender: "user-1",
    closedSender: "closed-1",
    secret: platform.token,
    async emit(script) {
      scripted(script);
      await platform.settled();
    },
    sent: () => platform.sent(),
    polls: { count: () => platform.polls().size, vote: (messageId, voter, answer) => platform.vote(messageId, voter, answer) },
  };
}

describeGroupChannelConformance("Group-like (fixture plugin)", { descriptor, fake });

describe("the group-like fixture's manifest", () => {
  it("is a valid channel ABI 2 manifest declaring a group channel, its host and its purge on removal", () => {
    const parsed = PluginManifestSchema.parse(manifest);
    expect(parsed.channelAbi).toBe(2);
    expect(parsed.channels[0]).toMatchObject({
      providerId: "group-like",
      groups: { unlistedRooms: "drop" },
      hosts: ["group-like.test"],
      retention: "purge-on-remove",
    });
  });
});
