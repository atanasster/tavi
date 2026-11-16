import { describe, expect, it } from "vitest";

import { ChannelDescriptorSchema, channelIdentity, normalizeChannelIdentity, type ChannelDescriptor } from "../src/channels.js";
import { LOCAL_CONNECTION_PREFIX, answersNoChannelConversation } from "../src/messaging.js";

/** Channel descriptors. */

const descriptor: ChannelDescriptor = {
  providerId: "example-chat",
  label: "Example",
  kind: "chat",
  description: "A chat channel for tests.",
  settings: [{ key: "region", label: "Region", type: "choice", choices: ["eu", "us"] }],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token" }] },
  sender: { label: "User ID", placeholder: "12345", pattern: "[1-9]\\d{0,19}", normalize: "none", authentication: "provider" },
  target: { label: "Chat ID", placeholder: "-100123", pattern: "-?\\d{1,20}", normalize: "none" },
};

describe("ChannelDescriptorSchema", () => {
  it("accepts a well-formed descriptor", () => {
    expect(ChannelDescriptorSchema.safeParse(descriptor).success).toBe(true);
  });

  it("refuses a setting and a secret with one key, a choice without choices, a bad pattern and a non-https OAuth URL", () => {
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, settings: [{ key: "token", label: "T", type: "string" }] }).success).toBe(
      false,
    );
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, settings: [{ key: "region", label: "R", type: "choice" }] }).success).toBe(
      false,
    );
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, sender: { ...descriptor.sender, pattern: "(" } }).success).toBe(false);
    const oauth = {
      authorizeUrl: "http://example.com/auth",
      tokenUrl: "https://example.com/token",
      scopes: [],
      pkce: true,
      client: { source: "operator" },
      redirect: "loopback-any-port",
      tokenAuthMethod: "none",
    };
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, auth: { kind: "oauth2", oauth } }).success).toBe(false);
    expect(
      ChannelDescriptorSchema.safeParse({
        ...descriptor,
        auth: { kind: "oauth2", oauth: { ...oauth, authorizeUrl: "https://example.com/auth" } },
      }).success,
    ).toBe(true);
  });

  it("aims OAuth only at public addresses, and keeps a plugin's client secret under its own channel's name", () => {
    const oauth = {
      authorizeUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      scopes: [],
      pkce: true,
      client: { source: "operator" },
      redirect: "loopback-any-port",
      tokenAuthMethod: "none",
    };
    const withOAuth = (changes: Record<string, unknown>) =>
      ChannelDescriptorSchema.safeParse({ ...descriptor, auth: { kind: "oauth2", oauth: { ...oauth, ...changes } } }).success;
    for (const inward of [
      "https://127.0.0.1/token",
      "https://localhost/token",
      "https://169.254.169.254/latest",
      "https://10.0.0.5/token",
      "https://[::1]/token",
      "https://user:pass@example.com/token",
      "https://router.local/token",
    ]) {
      expect(withOAuth({ tokenUrl: inward }), inward).toBe(false);
    }
    expect(
      withOAuth({ client: { source: "plugin", clientId: "c", clientSecretRef: `channels.plugin-client.${descriptor.providerId}.secret` } }),
    ).toBe(true);
    // Any other credential would be sent to the plugin's own token address.
    expect(withOAuth({ client: { source: "plugin", clientId: "c", clientSecretRef: "channels.telegram-default.token" } })).toBe(false);
    expect(withOAuth({ client: { source: "plugin", clientId: "c", clientSecretRef: "channels.oauth-client.gmail.secret" } })).toBe(false);
  });

  it("takes a builtin icon name or a small PNG, never an SVG", () => {
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, icon: { name: "chat" } }).success).toBe(true);
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, icon: { png: "data:image/png;base64,iVBORw0KGgo=" } }).success).toBe(true);
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, icon: { png: "data:image/svg+xml;base64,PHN2Zz4=" } }).success).toBe(false);
    expect(ChannelDescriptorSchema.safeParse({ ...descriptor, icon: {} }).success).toBe(false);
    expect(
      ChannelDescriptorSchema.safeParse({ ...descriptor, icon: { name: "chat", png: "data:image/png;base64,iVBORw0KGgo=" } }).success,
    ).toBe(false);
  });

  it("holds a field's default to its type and choices, and choices to choice fields", () => {
    const field = (extra: object) =>
      ChannelDescriptorSchema.safeParse({ ...descriptor, settings: [{ key: "f", label: "F", ...extra }] }).success;
    expect(field({ type: "number", default: 3 })).toBe(true);
    expect(field({ type: "number", default: "3" })).toBe(false);
    expect(field({ type: "choice", choices: ["eu"], default: "us" })).toBe(false);
    expect(field({ type: "string", choices: ["eu"] })).toBe(false);
  });
});

describe("channelIdentity", () => {
  it("normalizes, then matches the whole value against the pattern", () => {
    expect(channelIdentity(" 42 ", descriptor.sender)).toBe("42");
    expect(channelIdentity("42abc", descriptor.sender)).toBeUndefined();
    expect(channelIdentity("Ana@Example.com", { pattern: "[^\\s@]+@[^\\s@]+", normalize: "lowercase" })).toBe("ana@example.com");
  });

  it("writes phone numbers as E.164, and refuses one with too few digits", () => {
    expect(normalizeChannelIdentity("+1 (415) 555-0100", "e164")).toBe("+14155550100");
    expect(normalizeChannelIdentity("0044 20 7946 0958", "e164")).toBe("+442079460958");
    expect(normalizeChannelIdentity("123", "e164")).toBeUndefined();
    // A national number names no country: refused rather than guessed.
    expect(normalizeChannelIdentity("4155550100", "e164")).toBeUndefined();
  });
});

describe("answersNoChannelConversation", () => {
  it("is true with no reply target and for a local chat, false for a channel's conversation", () => {
    expect(answersNoChannelConversation(undefined)).toBe(true);
    expect(answersNoChannelConversation({ connectionId: `${LOCAL_CONNECTION_PREFIX}default` })).toBe(true);
    expect(answersNoChannelConversation({ connectionId: "telegram-1" })).toBe(false);
  });
});
