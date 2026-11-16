import { describe, expect, it } from "vitest";

import { ChannelDescriptorSchema, GroupCapabilitiesSchema, PluginManifestSchema, channelDisclosureOf } from "@tavi/contracts";

import manifest from "../tavi-plugin.json" with { type: "json" };
import { DISCORD_CAPABILITIES, DISCORD_CHANNEL_DESCRIPTOR } from "../src/descriptor.js";

/** The plugin's manifest is what its review shows. */
describe("discord.channel's manifest", () => {
  it("is a channel ABI 2, in-process plugin whose channel is the connector's own descriptor", () => {
    const parsed = PluginManifestSchema.parse(manifest);
    expect(parsed).toMatchObject({
      id: "discord.channel",
      provides: ["channel"],
      channelAbi: 2,
      isolation: "in-process",
      provenance: { format: "bundled-esm", packages: [] },
    });
    expect(parsed.channels).toEqual([ChannelDescriptorSchema.parse(DISCORD_CHANNEL_DESCRIPTOR)]);
  });

  it("is reviewed as a channel that receives from outside, reaches Discord's hosts and purges on removal", () => {
    expect(channelDisclosureOf(DISCORD_CHANNEL_DESCRIPTOR)).toMatchObject({
      providerId: "discord",
      disclosure:
        "Receives messages from outside and can send as you on Discord. Removing one of its connections erases what it brought in after 24 hours",
      retention: "purge-on-remove",
    });
    expect(channelDisclosureOf(DISCORD_CHANNEL_DESCRIPTOR).endpoints).toEqual([
      "host discord.com",
      "host gateway.discord.gg",
      "host *.discord.gg",
      "host cdn.discordapp.com",
      "host media.discordapp.net",
    ]);
  });

  it("reports what its default trigger asks for", () => {
    const groups = GroupCapabilitiesSchema.parse(DISCORD_CAPABILITIES.groups);
    for (const kind of DISCORD_CHANNEL_DESCRIPTOR.groups?.defaultTrigger ?? []) expect(groups.addressing).toContain(kind);
  });
});
