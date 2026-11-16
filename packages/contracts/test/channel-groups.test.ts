import { describe, expect, it } from "vitest";

import {
  CHANNEL_ABI,
  ChannelDescriptorSchema,
  GroupCapabilitiesSchema,
  PluginManifestSchema,
  SUPPORTED_CHANNEL_ABIS,
  channelDisclosureOf,
  triggerAdmits,
  type ChannelDescriptor,
} from "../src/index.js";

/** The group-chat seam's contracts. */

const descriptor: ChannelDescriptor = {
  providerId: "parrot",
  label: "Parrot",
  kind: "chat",
  description: "Group chats by parrot.",
  settings: [],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Token" }] },
  sender: { label: "User ID", placeholder: "1", pattern: "\\d+", normalize: "none", authentication: "provider" },
  target: { label: "Room ID", placeholder: "1", pattern: "\\d+", normalize: "none" },
};

const manifest = (fields: Record<string, unknown>) =>
  PluginManifestSchema.safeParse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.parrot",
    version: "1.0.0",
    name: "Parrot",
    entry: "index.mjs",
    provides: ["channel"],
    ...fields,
  });

describe("the descriptor's group fields", () => {
  it("takes a group policy, hosts and a retention", () => {
    const parsed = ChannelDescriptorSchema.safeParse({
      ...descriptor,
      groups: { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention", "reply"] },
      hosts: ["parrot.example", "*.cdn.parrot.example"],
      retention: "purge-on-remove",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an unknown policy, an empty trigger, a host that is not one, and an unknown retention", () => {
    const groups = { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention"] };
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, groups: { ...groups, unboundSenders: "ignore" } }).success).toBe(false);
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, groups: { ...groups, defaultTrigger: [] } }).success).toBe(false);
    // `any` is a backfilled room's trigger, never a default.
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, groups: { ...groups, defaultTrigger: ["any"] } }).success).toBe(false);
    for (const host of ["https://parrot.example", "Parrot.Example", "localhost", "parrot.example/path"]) {
      expect(ChannelDescriptorSchema.safeParse({ ...descriptor, hosts: [host] }).success, host).toBe(false);
    }
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, retention: "forever" }).success).toBe(false);
  });
});

describe("GroupCapabilitiesSchema", () => {
  it("bounds what a connector says it can do", () => {
    const capabilities = { addressing: ["mention"], directToSender: true, listRooms: false, membershipEvents: false, leaveRoom: false };
    expect(GroupCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      GroupCapabilitiesSchema.safeParse({
        ...capabilities,
        polls: { maxQuestion: 300, maxAnswers: 10, maxAnswerLength: 55, maxHours: 768, multiSelect: true, results: "fetch" },
      }).success,
    ).toBe(true);
    expect(GroupCapabilitiesSchema.safeParse({ ...capabilities, addressing: [] }).success).toBe(false);
    expect(
      GroupCapabilitiesSchema.safeParse({
        ...capabilities,
        polls: { maxQuestion: 300, maxAnswers: 1, maxAnswerLength: 55, maxHours: 768, multiSelect: true, results: "fetch" },
      }).success,
    ).toBe(false);
    expect(GroupCapabilitiesSchema.safeParse({ ...capabilities, recentHistory: { maxMessages: 500 } }).success).toBe(false);
  });
});

describe("triggerAdmits", () => {
  it("takes a message in when its address kinds meet the trigger, and none that addressed nothing", () => {
    expect(triggerAdmits(["mention", "reply"], ["reply"])).toBe(true);
    expect(triggerAdmits(["mention"], ["reply"])).toBe(false);
    expect(triggerAdmits(["mention"], undefined)).toBe(false);
    expect(triggerAdmits(["mention"], [])).toBe(false);
  });
});

describe("channel ABI 2", () => {
  it("is the current ABI, and the host still loads ABI 1", () => {
    expect(CHANNEL_ABI).toBe(2);
    expect(SUPPORTED_CHANNEL_ABIS).toEqual([1, 2]);
  });

  it("refuses an ABI 1 plugin that declares groups, and takes an ABI 2 one", () => {
    const grouped = { ...descriptor, groups: { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention"] } };
    expect(manifest({ channels: [grouped], channelAbi: 1 }).success).toBe(false);
    expect(manifest({ channels: [grouped], channelAbi: 2 }).success).toBe(true);
    expect(manifest({ channels: [descriptor], channelAbi: 1 }).success).toBe(true);
  });
});

describe("channelDisclosureOf", () => {
  it("lists the hosts a channel reaches and says when removing a connection erases what it brought in", () => {
    const disclosed = channelDisclosureOf({ ...descriptor, hosts: ["parrot.example"], retention: "purge-on-remove" });
    expect(disclosed.endpoints).toContain("host parrot.example");
    expect(disclosed.retention).toBe("purge-on-remove");
    expect(disclosed.disclosure).toMatch(/erases what it brought in after 24 hours/);
    const kept = channelDisclosureOf(descriptor);
    expect(kept.retention).toBe("keep");
    expect(kept.disclosure).not.toMatch(/erases/);
  });
});
