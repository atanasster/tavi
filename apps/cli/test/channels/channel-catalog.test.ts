import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelDescriptorSchema } from "@tavi/contracts";

import {
  channelDescriptorOf,
  isBuiltinChannel,
  parseSharedClients,
  setSharedClientBindings,
  registerBuiltinChannelDescriptor,
  registerChannelDescriptor,
  registerEnabledBuiltinChannels,
  unregisterChannelDescriptor,
} from "../../src/features/channels/catalog.js";
import { pairingAccountOf } from "../../src/features/channels/owner.js";
import { sharedProviderOf, signsInByCode } from "../../src/features/channels/oauth.js";
import { runPluginAction } from "../../src/features/plugins/actions.js";
import { BUILTIN_CHANNELS } from "../../src/features/plugins/catalog.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The channel catalog: each channel's plugin registers it, a built-in's as held by its plugin. */

const telegram = BUILTIN_CHANNELS.find((channel) => channel.pluginId === "tavi.telegram")?.descriptor;
if (telegram === undefined) throw new Error("no built-in Telegram");

describe("the channel catalog", () => {
  it("names a built-in channel only while one registration holds it, and refuses a plugin its provider id meanwhile", () => {
    expect(channelDescriptorOf("telegram")).toBeUndefined();
    const first = registerBuiltinChannelDescriptor(telegram);
    const second = registerBuiltinChannelDescriptor(telegram);
    expect(isBuiltinChannel("telegram")).toBe(true);
    expect(() => registerChannelDescriptor({ ...telegram, label: "Not Telegram" }, "acme.telegram")).toThrow(/already registered/);
    // A plugin's withdrawal never takes a built-in out.
    unregisterChannelDescriptor("telegram");
    first();
    first();
    expect(channelDescriptorOf("telegram")).toBe(telegram);
    second();
    expect(channelDescriptorOf("telegram")).toBeUndefined();
    expect(isBuiltinChannel("telegram")).toBe(false);
  });

  it("takes a plugin's channel under a built-in's provider id once the built-in is gone, never as built-in", () => {
    registerChannelDescriptor({ ...telegram, label: "Acme Telegram" }, "acme.telegram");
    try {
      expect(channelDescriptorOf("telegram")?.label).toBe("Acme Telegram");
      expect(isBuiltinChannel("telegram")).toBe(false);
      expect(() => registerBuiltinChannelDescriptor(telegram)).toThrow(/already registered/);
    } finally {
      unregisterChannelDescriptor("telegram");
    }
  });

  it("registers, for a reader with no owner, the built-in channels whose plugins are enabled", () => {
    const release = registerEnabledBuiltinChannels((pluginId) => pluginId !== "tavi.mailgun");
    expect(isBuiltinChannel("telegram")).toBe(true);
    expect(isBuiltinChannel("gmail")).toBe(true);
    expect(channelDescriptorOf("mailgun")).toBeUndefined();
    release();
    expect(channelDescriptorOf("telegram")).toBeUndefined();
  });
});

describe("a built-in channel's plugin", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  it("installs its channel while it is enabled, and leaves it out, its provider id free, once disabled", async () => {
    const dataDir = directories.create("tavi-channel-plugin-");
    const options = fixtureRuntimeOptions(dataDir, { scheduleSweepEnabled: false });
    const first = await composeTaviRuntime(options, { requireModelTransport: false });
    try {
      expect(isBuiltinChannel("telegram")).toBe(true);
      const answer = await runPluginAction(first.plugins.registry, { action: "disable", pluginId: "tavi.telegram" }, "operator");
      // Its saved connections stay, credentials included: the operator is told what may take them.
      expect(answer).toMatchObject({ cleanupWarning: expect.stringContaining("channel plugin approved for provider telegram") });
    } finally {
      await first.close();
    }
    expect(channelDescriptorOf("telegram")).toBeUndefined();
    const second = await composeTaviRuntime(options, { requireModelTransport: false });
    try {
      expect(channelDescriptorOf("telegram")).toBeUndefined();
      expect(isBuiltinChannel("gmail")).toBe(true);
    } finally {
      await second.close();
    }
    expect(channelDescriptorOf("gmail")).toBeUndefined();
  });
});

describe("a channel's declared pairing and sign-in", () => {
  const plugin = (overrides: Record<string, unknown>) => ChannelDescriptorSchema.safeParse({ ...telegram, ...overrides }).success;

  it("takes a pairing deep link only as an https template naming the account, then the code", () => {
    expect(plugin({ pairing: { deepLinkTemplate: "https://chat.example/{account}?start={code}", openLabel: "Open" } })).toBe(true);
    expect(plugin({ pairing: { deepLinkTemplate: "http://chat.example/{account}?start={code}", openLabel: "Open" } })).toBe(false);
    expect(plugin({ pairing: { deepLinkTemplate: "https://chat.example/{code}/{account}", openLabel: "Open" } })).toBe(false);
    expect(plugin({ pairing: { deepLinkTemplate: "javascript:{account}{code}", openLabel: "Open" } })).toBe(false);
  });

  it("reads the account from the connection test's setup link, past the template's prefix, and nothing else", () => {
    const pairing = { deepLinkTemplate: "https://t.me/{account}?start={code}", openLabel: "Open in Telegram" };
    expect(pairingAccountOf(pairing, "https://t.me/tavi_bot")).toBe("tavi_bot");
    expect(pairingAccountOf(pairing, "https://evil.example/tavi_bot")).toBeUndefined();
    expect(pairingAccountOf(pairing, "https://t.me/tavi bot?x=<script>")).toBeUndefined();
    expect(pairingAccountOf(pairing, undefined)).toBeUndefined();
  });

  it("offers no sign-in by code to a plugin channel bound to a provider whose own channel refuses it", () => {
    const release = registerEnabledBuiltinChannels((pluginId) => pluginId === "tavi.gmail");
    const gmail = channelDescriptorOf("gmail");
    if (gmail?.auth.kind !== "oauth2" || gmail.app === undefined) throw new Error("no built-in Gmail");
    const device = {
      ...gmail,
      providerId: "acme-gmail",
      auth: {
        ...gmail.auth,
        oauth: { ...gmail.auth.oauth, disallowsDeviceFlow: undefined, deviceAuthorizationUrl: "https://oauth2.googleapis.com/device/code" },
      },
    };
    registerChannelDescriptor(device, "acme.gmail", undefined, "2.0.0");
    try {
      // Unbound, it is a channel of its own: it may sign in by code.
      expect(signsInByCode(device)).toBe(true);
      setSharedClientBindings(parseSharedClients(JSON.stringify({ google: { pluginId: "acme.gmail", version: "2.0.0" } })));
      expect(sharedProviderOf("acme-gmail")).toBe("google");
      expect(signsInByCode(device)).toBe(false);
      // A binding the setting does not hold whole is ignored.
      expect(parseSharedClients(JSON.stringify({ google: "acme.gmail", other: { pluginId: "x" } })).size).toBe(0);
    } finally {
      setSharedClientBindings(new Map());
      unregisterChannelDescriptor("acme-gmail");
      release();
    }
  });
});
