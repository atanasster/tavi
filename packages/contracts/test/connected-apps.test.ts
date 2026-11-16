import { describe, expect, it } from "vitest";

import {
  AppSettingFieldSchema,
  appSettingFromChannelField,
  appSettingFromPluginConfig,
  appSettingsFromProvider,
  APPS_ABI,
  AppPresentationSchema,
  AppsPayloadSchema,
  CatalogEntrySchema,
  ConnectableAppSchema,
  PluginAppsBlockSchema,
  PluginManifestSchema,
  worseHealth,
} from "../src/index.js";

/** Connected apps' contract. */

const calendar = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "mcp-remote", packages: [] },
  id: "mcp.gcal",
  version: "1.0.0",
  name: "Google Calendar",
  mcp: { abi: "tavi.mcp/1", transport: "http", url: { value: "https://calendarmcp.googleapis.com/mcp/v1" }, auth: "oauth" },
};

const presentation = {
  id: "google-calendar",
  name: "Google Calendar",
  summary: "Read your schedule and add events, asking first.",
  icon: "assets/calendar.svg",
  category: "calendar",
  scopes: [{ scope: "https://www.googleapis.com/auth/calendar.events", says: "See and change events on your calendars", access: "change" }],
  tools: { list_events: { title: "List events" } },
  dataClass: "personal",
};

describe("the apps manifest block", () => {
  it("parses a manifest without one exactly as before", () => {
    const parsed = PluginManifestSchema.parse(calendar);
    expect(parsed.apps).toBeUndefined();
    expect(Object.keys(parsed)).not.toContain("apps");
  });

  it("round-trips a manifest with one, filling its defaults", () => {
    const parsed = PluginManifestSchema.parse({ ...calendar, apps: { abi: APPS_ABI, apps: [presentation] } });
    const app = parsed.apps?.apps[0];
    expect(app?.id).toBe("google-calendar");
    expect(app?.accountScope).toBe("owner");
    expect(app?.scopes[0]?.optional).toBe(false);
    expect(PluginManifestSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("refuses an unknown ABI", () => {
    expect(PluginAppsBlockSchema.safeParse({ abi: "tavi.apps/2", apps: [presentation] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...calendar, apps: { abi: "tavi.apps/2", apps: [presentation] } }).success).toBe(false);
  });

  it("refuses an icon path that escapes the snapshot", () => {
    for (const icon of ["../secret.svg", "/etc/icon.svg", "a/../../b.png", "icon.gif", "https://example.com/i.svg"]) {
      expect(AppPresentationSchema.safeParse({ ...presentation, icon }).success, icon).toBe(false);
    }
    expect(AppPresentationSchema.safeParse({ ...presentation, icon: "icons/app.png" }).success).toBe(true);
  });

  it("keeps the ids the canvas's routes use", () => {
    expect(AppPresentationSchema.safeParse({ ...presentation, id: "discover" }).success).toBe(false);
    expect(AppPresentationSchema.safeParse({ ...presentation, id: "mcp.gcal" }).success).toBe(true);
  });

  it("refuses a secret data class, which no app declares", () => {
    expect(AppPresentationSchema.safeParse({ ...presentation, dataClass: "secret" }).success).toBe(false);
  });
});

describe("the read model", () => {
  const app = {
    appId: "google-calendar",
    name: "Google Calendar",
    summary: "",
    category: "calendar",
    source: { kind: "mcp", pluginIds: ["mcp.gcal"], preset: "google-calendar", verified: "tavi-preset", isolation: "remote" },
    auth: { kind: "oauth", client: "shared-provider", provider: "google", identity: "oidc-email" },
    tools: [
      {
        toolId: "mcp.gcal.create_event",
        title: "Create an event",
        access: "send",
        effect: "external",
        sink: "network",
        state: "offered",
        decision: "ask",
        because: ["never-always"],
        canSetHere: ["ask", "block"],
      },
    ],
    egress: { hosts: ["calendarmcp.googleapis.com"], lan: false, anyNetwork: false },
    credentials: [{ name: "oauth", raw: false }],
    settings: [],
    trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
    accounts: [
      {
        accountId: "mcp.gcal",
        label: "you@gmail.com",
        owner: { kind: "owner" },
        health: "ready",
        workspaces: ["default"],
        people: false,
        sharing: "personal",
      },
    ],
    health: "ready",
    repairs: [],
  };

  it("round-trips an app", () => {
    const parsed = ConnectableAppSchema.parse(app);
    expect(parsed.accounts[0]?.expiresWeekly).toBe(false);
    expect(parsed.warnings).toEqual([]);
    expect(ConnectableAppSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("orders health worst first", () => {
    expect(worseHealth("ready", "needs-sign-in")).toBe("needs-sign-in");
    expect(worseHealth("error", "needs-review")).toBe("error");
    expect(worseHealth("paused", "paused")).toBe("paused");
  });

  it("describes a registry catalog entry with its options", () => {
    const entry = CatalogEntrySchema.parse({
      ref: { kind: "registry", name: "com.notion/mcp", version: "1.0.0", option: "remote" },
      name: "Notion",
      summary: "",
      category: "notes",
      auth: "oauth",
      badges: ["unreviewed-listing", "remote"],
      installed: false,
    });
    expect(entry.options).toEqual([]);
  });
});

describe("the apps command", () => {
  it("takes a permission target, never a raw rule", () => {
    expect(
      AppsPayloadSchema.safeParse({ action: "permission", appId: "google-calendar", toolId: "mcp.gcal.create_event", target: "block" })
        .success,
    ).toBe(true);
    expect(
      AppsPayloadSchema.safeParse({ action: "permission", appId: "google-calendar", toolId: "mcp.gcal.create_event", target: "default" })
        .success,
    ).toBe(false);
    expect(
      AppsPayloadSchema.safeParse({ action: "permission", appId: "google-calendar", toolId: "x", target: "allow", decision: "allow" })
        .success,
    ).toBe(false);
  });

  it("takes only a loopback origin for a sign-in here", () => {
    expect(
      AppsPayloadSchema.safeParse({ action: "connect", appId: "google-calendar", via: "here", origin: "http://127.0.0.1:8765" }).success,
    ).toBe(true);
    expect(
      AppsPayloadSchema.safeParse({ action: "connect", appId: "google-calendar", via: "here", origin: "https://evil.example" }).success,
    ).toBe(false);
  });

  it("bounds a pasted address", () => {
    expect(AppsPayloadSchema.safeParse({ action: "connect-finish", flowId: "f1", address: "x".repeat(8193) }).success).toBe(false);
    expect(
      AppsPayloadSchema.safeParse({
        action: "connect-finish",
        flowId: "f1",
        address: "http://127.0.0.1:8765/oauth/callback?state=s&code=c",
      }).success,
    ).toBe(true);
  });

  it("defaults the workspace and keeps configure values to plain scalars", () => {
    const listed = AppsPayloadSchema.parse({ action: "list" });
    expect(listed).toEqual({ action: "list", workspaceId: "default" });
    expect(AppsPayloadSchema.safeParse({ action: "configure", appId: "a", values: { clientId: { nested: true } } }).success).toBe(false);
  });
});

describe("one settings shape for every app", () => {
  it("adapts a plugin's config field, cutting its text to the field's bounds", () => {
    const long = "k".repeat(64);
    const field = appSettingFromPluginConfig(long, { type: "credential", description: "x".repeat(500), required: true });
    expect(AppSettingFieldSchema.parse(field)).toMatchObject({
      key: long,
      label: "k".repeat(60),
      type: "credential",
      required: true,
      advanced: false,
    });
    expect(field.help).toHaveLength(300);
    expect(appSettingFromPluginConfig("city", { type: "string" })).toEqual({
      key: "city",
      label: "city",
      type: "string",
      required: false,
      advanced: false,
    });
    // A manifest's own label, and a field folded under More settings.
    expect(appSettingFromPluginConfig("navToken", { type: "credential", label: "NAV token (Norway)", advanced: true })).toEqual({
      key: "navToken",
      label: "NAV token (Norway)",
      type: "credential",
      required: false,
      advanced: true,
    });
  });

  it("adapts a channel's field with its choices, default and pattern", () => {
    const field = appSettingFromChannelField({
      key: "mode",
      label: "Mode",
      type: "choice",
      choices: ["poll", "push"],
      default: "poll",
      help: "How it reads",
      required: true,
    });
    expect(AppSettingFieldSchema.parse(field)).toEqual({
      key: "mode",
      label: "Mode",
      help: "How it reads",
      type: "choice",
      required: true,
      default: "poll",
      choices: [
        { value: "poll", label: "poll" },
        { value: "push", label: "push" },
      ],
      advanced: false,
    });
    expect(appSettingFromChannelField({ key: "chat", label: "Chat", type: "string", pattern: "^-?[0-9]+$" })).toMatchObject({
      pattern: "^-?[0-9]+$",
      required: false,
    });
  });

  it("adapts a provider's settings, then its credentials", () => {
    const fields = appSettingsFromProvider({
      id: "search",
      kind: "search",
      disclosure: "Search terms",
      settings: {
        "end-point": { type: "string", required: true, description: "Endpoint" },
        region: { type: "string", required: false, description: "Region", choices: ["eu", "us"] },
        hosts: { type: "strings", required: false, description: "Hosts" },
      },
      credentials: ["key"],
    });
    expect(fields.map((field) => AppSettingFieldSchema.parse(field))).toEqual([
      { key: "end-point", label: "end-point", help: "Endpoint", type: "string", required: true, advanced: false },
      {
        key: "region",
        label: "region",
        help: "Region",
        type: "choice",
        required: false,
        choices: [
          { value: "eu", label: "eu" },
          { value: "us", label: "us" },
        ],
        advanced: false,
      },
      { key: "hosts", label: "hosts", help: "Hosts", type: "strings", required: false, advanced: false },
      { key: "key", label: "key", type: "credential", required: true, advanced: false },
    ]);
    // Only a text setting becomes a pick: a number with choices stays a number, a list stays a list.
    const typed = appSettingsFromProvider({
      id: "search",
      kind: "search",
      disclosure: "d",
      settings: {
        size: { type: "number", required: false, description: "Size", choices: [10, 20] },
        tags: { type: "strings", required: false, description: "Tags", choices: ["a"] },
      },
      credentials: [],
    });
    expect(typed.map((field) => [field.type, field.choices])).toEqual([
      ["number", undefined],
      ["strings", undefined],
    ]);
  });

  it("keeps a channel's whole pattern and every choice", () => {
    const pattern = `^(${"a|".repeat(200)}b)$`;
    const choices = Array.from({ length: 50 }, (_, index) => `c${String(index)}`);
    const field = appSettingFromChannelField({ key: "pick", label: "Pick", type: "choice", choices, pattern });
    expect(AppSettingFieldSchema.parse(field)).toMatchObject({ pattern });
    expect(field.choices).toHaveLength(50);
  });
});
