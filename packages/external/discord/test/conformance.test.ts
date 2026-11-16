import { z } from "zod";

import {
  describeChannelConformance,
  describeGroupChannelConformance,
  type GroupFake,
  type GroupScript,
  type ProviderMood,
} from "@tavi/channel-kit/conformance";

import { createDiscordConnectorDefinition } from "../src/connector.js";
import { DISCORD_CHANNEL_DESCRIPTOR } from "../src/descriptor.js";
import { APP, BOT, CLOSED_USER, GUILD, OPEN_USER, ROOM, TOKEN, fakeDiscord, turns } from "@tavi/test-support/discord";

/** Discord passes both conformance suites over a fake Discord. */

const connection = {
  connectionId: "discord-conformance",
  providerId: "discord",
  accountIdentity: "tavi",
  workspaceId: "w",
  configRevision: 1,
  enabled: true,
  credentialRefs: { token: "ref.token" },
};
const definitionOver = (discord: ReturnType<typeof fakeDiscord>, fetch: typeof globalThis.fetch = discord.fetch) =>
  createDiscordConnectorDefinition({
    z,
    version: "0.1.0",
    fetch,
    webSocket: discord.webSocket,
    gatewayClock: discord.clock,
    requestTimeoutMs: 40,
  });

describeChannelConformance("Discord", {
  descriptor: DISCORD_CHANNEL_DESCRIPTOR,
  provider: (mood: ProviderMood) => fakeDiscord({ sendMood: mood }).fetch,
  create: (fetch) => {
    // A Gateway that greets each connection; REST is the suite's provider in its mood.
    const discord = fakeDiscord();
    return definitionOver(discord, fetch);
  },
  connection,
  config: {},
  secret: TOKEN,
  target: ROOM,
});

let messages = 0;
const message = (fields: Record<string, unknown>): Record<string, unknown> => {
  messages += 1;
  return {
    id: (BigInt("742000000000000000") + BigInt(messages)).toString(),
    channel_id: ROOM,
    guild_id: GUILD,
    type: 0,
    author: { id: OPEN_USER, username: "operator" },
    content: "",
    timestamp: "2026-10-18T09:00:00.000000+00:00",
    mentions: [],
    mention_roles: [],
    attachments: [],
    ...fields,
  };
};

async function groupFake(): Promise<GroupFake> {
  // With the Message Content intent on: the bot may read a room's history (check 8).
  const discord = fakeDiscord({ application: { flags: 1 << 18 } });
  const definition = definitionOver(discord);
  const instance = definition.createConnection({
    connection,
    config: {},
    credentials: { get: async () => TOKEN, accessToken: async () => TOKEN },
  });
  const script = (step: GroupScript): void => {
    switch (step.kind) {
      case "mention":
        discord.dispatch("MESSAGE_CREATE", message({ content: `<@${BOT}> hello`, mentions: [{ id: BOT, bot: true }] }));
        return;
      case "reply":
        discord.dispatch(
          "MESSAGE_CREATE",
          message({
            type: 19,
            content: "yes",
            message_reference: { message_id: "742999999999999999" },
            referenced_message: { id: "742999999999999999", author: { id: BOT, bot: true } },
          }),
        );
        return;
      case "plain":
        discord.dispatch("MESSAGE_CREATE", message({ content: "" }));
        return;
      case "bot":
        discord.dispatch("MESSAGE_CREATE", message({ author: { id: "800000000000000099", bot: true }, content: "beep" }));
        return;
      case "system":
        discord.dispatch("MESSAGE_CREATE", message({ type: 7 }));
        return;
      case "press":
        discord.dispatch("INTERACTION_CREATE", {
          id: (BigInt("761000000000000000") + BigInt((messages += 1))).toString(),
          application_id: APP,
          type: 3,
          token: `token-${String(messages)}`,
          channel_id: ROOM,
          guild_id: GUILD,
          member: { user: { id: step.presser } },
          message: { id: "742999999999999998" },
          data: { custom_id: step.data, component_type: 2 },
        });
        return;
      case "direct":
        discord.dispatch(
          "MESSAGE_CREATE",
          message({ guild_id: undefined, channel_id: "720000000000000099", author: { id: step.sender }, content: "hi" }),
        );
        return;
      case "thread":
        // A message in a thread the bot opened in the room.
        discord.dispatch("THREAD_CREATE", {
          id: "712000000000000050",
          guild_id: GUILD,
          parent_id: ROOM,
          owner_id: BOT,
          type: 11,
          name: "A task",
        });
        discord.dispatch("MESSAGE_CREATE", message({ channel_id: "712000000000000050", content: "and then?" }));
        return;
      case "command":
        discord.dispatch("INTERACTION_CREATE", {
          id: (BigInt("761000000000000000") + BigInt((messages += 1))).toString(),
          application_id: APP,
          type: 2,
          token: `token-${String(messages)}`,
          channel_id: ROOM,
          guild_id: GUILD,
          member: { user: { id: OPEN_USER } },
          data: { name: "tavi", type: 1, options: [{ type: 1, name: "ask", options: [{ type: 3, name: "question", value: "hello" }] }] },
        });
        return;
      case "picked":
        discord.dispatch("INTERACTION_CREATE", {
          id: (BigInt("761000000000000000") + BigInt((messages += 1))).toString(),
          application_id: APP,
          type: 2,
          token: `token-${String(messages)}`,
          channel_id: ROOM,
          guild_id: GUILD,
          member: { user: { id: OPEN_USER } },
          data: {
            name: "Ask Tavi about this",
            type: 3,
            target_id: "742999999999999990",
            resolved: {
              messages: {
                "742999999999999990": { id: "742999999999999990", author: { id: "800000000000000002" }, content: "the plan is Friday" },
              },
            },
          },
        });
        return;
      default:
        throw new Error("Discord reports no such step");
    }
  };
  return {
    definition,
    // The seeded history: a person's, a member joining (the platform's), a bot's.
    recentKinds: ["person", "system", "bot"],
    instance,
    connection,
    room: ROOM,
    openSender: OPEN_USER,
    closedSender: CLOSED_USER,
    secret: TOKEN,
    polls: { count: () => discord.polls.size, vote: (messageId, voter, answer) => discord.vote(messageId, voter, answer) },
    async emit(step) {
      // The direct case's DM channel is the one the platform opens for that sender.
      if (step.kind === "direct") discord.dmChannels.set(step.sender, "720000000000000099");
      script(step);
      await turns();
    },
    sent: () =>
      discord.posted.map((post) => ({
        conversation: post.channel,
        visibleInRoom: !post.ephemeral && !post.channel.startsWith("interaction:"),
        text: post.content,
        // SUPPRESS_EMBEDS off, with a link, is a preview; a parse other than none can ping everyone.
        linkPreview: (post.flags & 4) === 0 && /https?:\/\//.test(post.content),
        massMention: post.allowedMentions?.parse === undefined || post.allowedMentions.parse.includes("everyone"),
      })),
  };
}

describeGroupChannelConformance("Discord", { descriptor: DISCORD_CHANNEL_DESCRIPTOR, fake: groupFake });
