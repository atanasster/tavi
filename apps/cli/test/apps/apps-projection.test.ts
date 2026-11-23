import { chmodSync } from "node:fs";

import { SiteProfileSchema, TaviError } from "@tavi/contracts";
import type { ChannelDescriptor, McpPayload, MessagingConnectionRecord, PluginManifest, PluginView, ToolRule } from "@tavi/contracts";
import { GMAIL_CHANNEL_DESCRIPTOR } from "@tavi/plugin-gmail/connector";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { appsCommand, nextSlug } from "../../src/features/apps/owner.js";
import {
  channelAccountHealth,
  mcpAccountHealth,
  mcpAccountRepair,
  pluginRepair,
  type McpAccountFacts,
} from "../../src/features/apps/health.js";
import { pageRuleId, resolvePermission, toolPolicy } from "../../src/features/apps/permissions.js";
import { appRepairList, type AppsContext } from "../../src/features/apps/registry.js";
import { accountSetup } from "../../src/features/apps/sources/channel.js";
import type { McpGrantFacts } from "../../src/features/apps/sources/mcp.js";
import { parseSharing, sharingOf, withSharing } from "../../src/features/apps/sharing.js";
import { parseClientFile } from "../../src/features/apps/oauth-clients.js";
import type { McpReview, McpServerRow } from "../../src/features/mcp/actions.js";
import { TODOIST_PRESET, TODOIST_TOKEN_PRESET } from "../../src/features/mcp/presets/todoist.js";
import { GOOGLE_MAPS_PRESET } from "../../src/features/mcp/presets/google-maps.js";
import { mcpDataClassOf } from "../../src/features/mcp/bridge.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import {
  registerChannelDescriptor,
  unregisterChannelDescriptor,
  registerEnabledBuiltinChannels,
} from "../../src/features/channels/catalog.js";

// No owner runs here: the built-in channels are registered as an owner whose channel plugins are all enabled would.
registerEnabledBuiltinChannels(() => true);

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** Connected apps' projection and its pure parts against a fake owner. */

const NOW = "2026-10-15T12:00:00.000Z";

const calendarManifest = (id: string): PluginManifest =>
  ({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "mcp-remote", packages: [] },
    capabilities: [],
    id,
    version: "1.0.0",
    name: "Todoist",
    description: "",
    config: TODOIST_PRESET.config,
    tools: [],
    provides: [],
    channels: [],
    mcp: {
      abi: "tavi.mcp/1",
      transport: "http",
      url: { value: "https://ai.todoist.net/mcp" },
      auth: "oauth",
      exposure: "auto",
      preset: "todoist",
      maxMessageBytes: 1_048_576,
      concurrency: 4,
    },
  }) as unknown as PluginManifest;

const mcpView = (id: string, extra: Partial<PluginView> = {}): PluginView =>
  ({
    id,
    kind: "mcp",
    name: "Todoist",
    description: "",
    enabled: true,
    core: false,
    activeVersion: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        reviewState: "approved",
        contentHash: "h",
        installedAt: NOW,
        tools: [],
        configFields: TODOIST_PRESET.config,
        runsOwnerCode: false,
      },
    ],
    tools: [],
    configFields: TODOIST_PRESET.config,
    config: {},
    runsOwnerCode: false,
    ...extra,
  }) as PluginView;

/** A server added and never approved: its one version waits for review. */
const proposedOnly = ({ activeVersion: _active, ...view }: PluginView): PluginView => ({
  ...view,
  versions: view.versions.map((version) => ({ ...version, reviewState: "proposed" as const })),
});

const row = (pluginId: string, extra: Partial<McpServerRow> = {}): McpServerRow => ({
  pluginId,
  name: "Todoist",
  enabled: true,
  activeVersion: "1.0.0",
  state: "running",
  transport: "http",
  exposure: "auto",
  pendingVersions: [],
  waitingTools: 0,
  allowed: true,
  people: false,
  openNotices: [],
  ...extra,
});

const review = (pluginId: string): McpReview =>
  ({
    pluginId,
    version: "1.0.0",
    reviewState: "approved",
    sandboxState: "srt",
    transport: "http",
    launch: [],
    disclosure: [],
    notices: [],
    searchLine: { text: "", operator: false },
    schemaTokens: 0,
    tools: [
      {
        pluginId,
        version: "1.0.0",
        name: "find-tasks",
        toolId: `${pluginId}.find-tasks`,
        observedDefHash: "a",
        observedDef: { name: "find-tasks", inputSchema: { type: "object" } },
        suggestedEffect: "read-only",
        doubtful: false,
        flagged: false,
        state: "approved",
        decision: { effect: "read-only", timeoutMs: 60_000, askTainted: false },
        shown: { name: "find-tasks" },
        schema: { form: "json", wrapped: false },
      },
      {
        pluginId,
        version: "1.0.0",
        name: "add-tasks",
        toolId: `${pluginId}.add-tasks`,
        observedDefHash: "b",
        observedDef: { name: "add-tasks", inputSchema: { type: "object" } },
        suggestedEffect: "external",
        doubtful: false,
        flagged: false,
        state: "approved",
        decision: { effect: "external", timeoutMs: 60_000, askTainted: true },
        shown: { name: "add-tasks", description: "Server text" },
        schema: { form: "json", wrapped: false },
      },
    ],
  }) as unknown as McpReview;

const gmail: ChannelDescriptor = {
  providerId: "gmail",
  label: "Gmail",
  kind: "email",
  description: "Gmail as a channel",
  settings: [
    { key: "label", label: "Label", type: "string", default: "tavi" },
    { key: "receive", label: "Reach Tavi by email", type: "boolean", default: true },
  ],
  auth: {
    kind: "oauth2",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      pkce: true,
      client: { source: "operator" },
      redirect: "loopback-any-port",
      tokenAuthMethod: "client_secret_post",
    },
  },
  sender: { label: "Email", authentication: "per-message" },
  target: { label: "Email" },
  // Its app, as the channel's own package presents it.
  app: GMAIL_CHANNEL_DESCRIPTOR.app,
} as unknown as ChannelDescriptor;

const connection = (extra: Partial<MessagingConnectionRecord> = {}): MessagingConnectionRecord => ({
  connectionId: "conn-1",
  providerId: "gmail",
  workspaceId: "default",
  accountIdentity: "you@gmail.com",
  settings: {},
  credentialRefs: {},
  enabled: true,
  configRevision: 1,
  authState: "connected",
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

interface Fake {
  readonly context: AppsContext;
  readonly rules: ToolRule[];
  readonly meta: Map<string, string>;
  readonly mcpCalls: McpPayload[];
}

function fake(
  input: {
    readonly views?: readonly PluginView[];
    readonly rows?: readonly McpServerRow[];
    readonly connections?: readonly MessagingConnectionRecord[];
    readonly refs?: readonly string[];
    readonly rules?: readonly ToolRule[];
    readonly people?: readonly string[];
    readonly workspaces?: readonly string[];
    readonly workspaceRules?: Readonly<Record<string, readonly ToolRule[]>>;
    readonly grants?: Readonly<Record<string, McpGrantFacts>>;
    readonly now?: string;
    readonly dataDirectory?: string;
    readonly channels?: AppsContext["channels"];
    readonly descriptors?: readonly ChannelDescriptor[];
    /** A server's manifest in place of Todoist's. */
    readonly manifests?: Readonly<Record<string, PluginManifest>>;
  } = {},
): Fake {
  const rules: ToolRule[] = [...(input.rules ?? [])];
  const meta = new Map<string, string>();
  const mcpCalls: McpPayload[] = [];
  const views = input.views ?? [];
  const context: AppsContext = {
    mcp: async (payload) => {
      mcpCalls.push(payload);
      if (payload.action === "list")
        return { ok: true, result: { servers: { enabled: true, workspaceId: "default", servers: input.rows ?? [] } } };
      if (payload.action === "show") return { ok: true, result: { review: review(payload.pluginId) } };
      if (payload.action === "add") return { ok: true, result: { added: { pluginId: `mcp.${payload.slug}`, version: "1.0.0" } } };
      return { ok: false, error: { code: "UNSUPPORTED", message: "not in this fake" } };
    },
    plugins: async () => ({ ok: true, result: {} }),
    views: async () => views,
    manifestOf: (pluginId) =>
      input.manifests?.[pluginId] ??
      (views.some((view) => view.id === pluginId && view.kind === "mcp") ? calendarManifest(pluginId) : undefined),
    connections: async () => input.connections ?? [],
    descriptorOf: (providerId) => (input.descriptors ?? [gmail]).find((descriptor) => descriptor.providerId === providerId),
    descriptors: () => [...(input.descriptors ?? [gmail])],
    rules: {
      inForce: async (workspaceId) => [...rules, ...(input.workspaceRules?.[workspaceId] ?? [])],
      put: async (rule) => {
        const index = rules.findIndex((candidate) => candidate.ruleId === rule.ruleId);
        if (index >= 0) rules.splice(index, 1, rule);
        else rules.push(rule);
      },
      remove: async (_workspaceId, ruleId) => {
        const index = rules.findIndex((candidate) => candidate.ruleId === ruleId);
        if (index < 0) return false;
        rules.splice(index, 1);
        return true;
      },
    },
    getMeta: async (key) => meta.get(key),
    setMeta: async (key, value) => {
      meta.set(key, value);
    },
    workspaceSettings: async () => ({ mcpServers: views.map((view) => view.id), mcpPeople: [...(input.people ?? [])] }),
    workspaceIds: () => input.workspaces ?? ["default"],
    credentialRefs: async () => new Set(input.refs ?? []),
    dataDirectory: input.dataDirectory ?? "/nonexistent",
    ...(input.channels === undefined ? {} : { channels: input.channels }),
    ...(input.grants === undefined ? {} : { mcpGrant: async (pluginId: string) => input.grants?.[pluginId] }),
    now: () => input.now ?? NOW,
    actor: "operator:ui",
  };
  return { context, rules, meta, mcpCalls };
}

async function list(context: AppsContext) {
  const answer = await appsCommand(context, { action: "list", workspaceId: "default" });
  if (!answer.ok) throw new Error(answer.error.message);
  return (answer.result as { readonly apps: readonly import("@tavi/contracts").ConnectableApp[] }).apps;
}

describe("projecting MCP servers", () => {
  it("gives a keyed preset its key's field and Tavi's steps for getting the key", async () => {
    const todoist = calendarManifest("mcp.gmaps");
    const maps = {
      ...todoist,
      name: "Google Maps",
      config: GOOGLE_MAPS_PRESET.config,
      mcp: {
        ...todoist.mcp,
        url: { value: "https://mapstools.googleapis.com/mcp" },
        headers: { "X-Goog-Api-Key": { setting: "apiKey" } },
        auth: "headers",
        preset: "google-maps",
      },
    } as unknown as PluginManifest;
    const { context } = fake({
      views: [mcpView("mcp.gmaps", { name: "Google Maps", configFields: GOOGLE_MAPS_PRESET.config })],
      rows: [row("mcp.gmaps", { name: "Google Maps" })],
      manifests: { "mcp.gmaps": maps },
    });
    const [app] = await list(context);
    expect(app?.auth).toMatchObject({ kind: "api-key", fields: [{ key: "apiKey", type: "credential" }] });
    const steps = app?.auth.kind === "api-key" ? (app.auth.keySteps ?? []) : [];
    expect(steps.map((step) => step.link?.label)).toEqual(["Get a Demo Key", "Enable the API", "Create a key"]);
  });

  it("labels a preset's key field in words, even on a server added before the preset named it", async () => {
    const { label: _label, ...unlabelled } = GOOGLE_MAPS_PRESET.config["apiKey"]!;
    const maps = {
      ...calendarManifest("mcp.gmaps"),
      config: { apiKey: unlabelled },
      mcp: { ...calendarManifest("mcp.gmaps").mcp, auth: "headers", preset: "google-maps" },
    } as unknown as PluginManifest;
    const { context } = fake({
      views: [mcpView("mcp.gmaps", { name: "Google Maps", configFields: { apiKey: unlabelled } })],
      rows: [row("mcp.gmaps", { name: "Google Maps" })],
      manifests: { "mcp.gmaps": maps },
    });
    const [app] = await list(context);
    expect(app?.auth).toMatchObject({ kind: "api-key", fields: [{ key: "apiKey", label: "Your Maps API key" }] });
    expect(app?.settings).toMatchObject([{ key: "apiKey", label: "Your Maps API key" }]);
    expect(TODOIST_TOKEN_PRESET.config["apiToken"]?.label).toBe("Your Todoist API token");
  });

  it("names a tool Tavi has no words for by its name in words, with the first sentence of what its server says", async () => {
    const base = fake({ views: [mcpView("mcp.notes", { name: "notes", configFields: {} })], rows: [row("mcp.notes")] }).context;
    const long = `Finds tasks completed in a date range. ${"Use it for reviews of what was done. ".repeat(80)}`;
    const [app] = await list({
      ...base,
      manifestOf: () => undefined,
      mcp: async (payload) => {
        if (payload.action !== "show") return base.mcp(payload);
        const shown = review(payload.pluginId);
        const tool = shown.tools[1]!;
        const renamed = { ...tool, name: "find-completed-tasks", toolId: "mcp.notes.find-completed-tasks" };
        return {
          ok: true,
          result: {
            review: {
              ...shown,
              tools: [
                { ...renamed, shown: { name: "find-completed-tasks", description: long } },
                {
                  ...tool,
                  name: "getOverview",
                  toolId: "mcp.notes.getOverview",
                  shown: { name: "getOverview", title: "Overview of it all" },
                },
              ],
            },
          },
        };
      },
    });
    expect(app?.tools.map((tool) => [tool.title, tool.says])).toEqual([
      ["Find completed tasks", "Finds tasks completed in a date range."],
      ["Overview of it all", undefined],
    ]);
  });

  it("tests a key whose server lists its tools without it as listed, not as checked", async () => {
    const maps = {
      ...calendarManifest("mcp.gmaps"),
      config: GOOGLE_MAPS_PRESET.config,
      mcp: { ...calendarManifest("mcp.gmaps").mcp, auth: "headers", preset: "google-maps" },
    } as unknown as PluginManifest;
    const probing = (context: AppsContext): AppsContext => ({
      ...context,
      mcp: async (payload) => (payload.action === "probe" ? { ok: true, result: {} } : context.mcp(payload)),
    });
    const keyed = fake({
      views: [mcpView("mcp.gmaps", { name: "Google Maps", configFields: GOOGLE_MAPS_PRESET.config })],
      rows: [row("mcp.gmaps", { name: "Google Maps" })],
      manifests: { "mcp.gmaps": maps },
    });
    const [app] = await list(keyed.context);
    expect(
      await appsCommand(probing(keyed.context), { action: "test", appId: app!.appId, accountId: "mcp.gmaps", workspaceId: "default" }),
    ).toMatchObject({
      ok: true,
      result: { tested: { accountId: "mcp.gmaps", keyChecked: false } },
    });
    const signedIn = fake({ views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")] });
    const tested = await appsCommand(probing(signedIn.context), {
      action: "test",
      appId: "todoist",
      accountId: "mcp.todoist",
      workspaceId: "default",
    });
    expect(tested.ok && (tested.result as { tested: Record<string, unknown> }).tested["keyChecked"]).toBeUndefined();
  });

  it("groups two instances of one preset into one app with two accounts", async () => {
    const { context } = fake({
      views: [mcpView("mcp.todoist"), mcpView("mcp.todoist2")],
      rows: [row("mcp.todoist"), row("mcp.todoist2")],
      refs: ["plugins.mcp.todoist.oauth", "plugins.mcp.todoist2.oauth"],
    });
    const apps = await list(context);
    expect(apps).toHaveLength(1);
    const [app] = apps;
    expect(app).toMatchObject({
      appId: "todoist",
      name: "Todoist",
      category: "tasks",
      health: "ready",
      source: {
        kind: "mcp",
        pluginIds: ["mcp.todoist", "mcp.todoist2"],
        preset: "todoist",
        verified: "tavi-preset",
        isolation: "remote",
      },
    });
    expect(app?.accounts.map((account) => account.accountId)).toEqual(["mcp.todoist", "mcp.todoist2"]);
    expect(app?.trust.confidentiality).toBe("personal");
    expect(app?.egress.hosts).toEqual(["ai.todoist.net"]);
    // Tavi's words for its tools, the gate's static decision, and what the page may pick.
    const create = app?.tools.find((tool) => tool.toolId === "mcp.todoist.add-tasks");
    expect(create).toMatchObject({
      title: "Add tasks",
      access: "send",
      decision: "ask",
      canSetHere: ["ask", "block"],
    });
    expect(create?.because).toContain("never-always");
    expect(app?.tools.find((tool) => tool.toolId === "mcp.todoist.find-tasks")).toMatchObject({
      decision: "allow",
      canSetHere: ["allow", "ask", "block"],
    });
  });

  it("names a server's client its own only once a client id is set on it, not because its manifest has the field", async () => {
    const notes = (id: string): PluginManifest =>
      ({
        ...calendarManifest(id),
        name: "Notes",
        mcp: {
          abi: "tavi.mcp/1",
          transport: "http",
          url: { value: "https://notes.example/mcp" },
          auth: "oauth",
          exposure: "auto",
          maxMessageBytes: 1_048_576,
          concurrency: 4,
        },
      }) as unknown as PluginManifest;
    const client = async (config: Record<string, string>) => {
      const { context } = fake({ views: [mcpView("mcp.notes", { name: "Notes", config })], rows: [row("mcp.notes")] });
      const [app] = await list({ ...context, manifestOf: (pluginId) => notes(pluginId) });
      return app?.auth.kind === "oauth" ? app.auth.client : undefined;
    };
    expect(await client({})).toBe("registration");
    expect(await client({ clientId: "" })).toBe("registration");
    expect(await client({ clientId: "abc.apps.example" })).toBe("own");
  });

  it("maps each source state onto one health word, worst first", () => {
    const base: McpAccountFacts = {
      pluginId: "mcp.todoist",
      state: "running",
      enabled: true,
      activeVersion: "1.0.0",
      pendingVersions: [],
      waitingTools: 0,
      openNotices: [],
      missingSettings: [],
      oauth: true,
      signedIn: true,
    };
    expect(mcpAccountHealth(base)).toBe("ready");
    expect(mcpAccountHealth({ ...base, state: "stopped" })).toBe("ready");
    expect(mcpAccountHealth({ ...base, state: "login-required" })).toBe("needs-sign-in");
    expect(mcpAccountHealth({ ...base, openNotices: ["scope"] })).toBe("needs-access");
    expect(mcpAccountHealth({ ...base, waitingTools: 2 })).toBe("needs-review");
    expect(mcpAccountHealth({ ...base, openNotices: ["drift"] })).toBe("needs-review");
    expect(mcpAccountHealth({ ...base, signedIn: false })).toBe("not-set-up");
    expect(mcpAccountHealth({ ...base, missingSettings: ["clientId"] })).toBe("not-set-up");
    expect(mcpAccountHealth({ ...base, enabled: false, state: "disabled" })).toBe("paused");
    expect(mcpAccountHealth({ ...base, state: "off" })).toBe("off");
    expect(mcpAccountHealth({ ...base, state: "failed", openNotices: ["login"] })).toBe("error");
    expect(mcpAccountHealth({ ...base, state: "backing-off" })).toBe("error");
  });

  it("offers a preset left before its key or sign-in its setup, not a review of a version never probed", () => {
    const keyless: McpAccountFacts = {
      pluginId: "mcp.gmaps",
      state: "disabled",
      enabled: false,
      pendingVersions: ["1.0.0"],
      waitingTools: 0,
      openNotices: [],
      missingSettings: ["apiKey"],
      oauth: false,
      signedIn: false,
    };
    expect(mcpAccountHealth(keyless)).toBe("not-set-up");
    expect(mcpAccountRepair("Google Maps", "not-set-up", keyless)).toMatchObject({
      kind: "finish-setup",
      title: "Finish setting up Google Maps",
    });
    const unsigned: McpAccountFacts = { ...keyless, pluginId: "mcp.todoist", missingSettings: [], oauth: true };
    expect(mcpAccountHealth(unsigned)).toBe("not-set-up");
    expect(mcpAccountRepair("Todoist", "not-set-up", unsigned)).toMatchObject({ kind: "sign-in", title: "Sign in to Todoist" });
    // Set up, a version still waiting is its review.
    expect(mcpAccountHealth({ ...unsigned, signedIn: true })).toBe("needs-review");
  });

  it("names a missing key by its label, and its fix stores the key before naming it", async () => {
    const maps = {
      ...calendarManifest("mcp.gmaps"),
      config: GOOGLE_MAPS_PRESET.config,
      mcp: { ...calendarManifest("mcp.gmaps").mcp, auth: "headers", preset: "google-maps" },
    } as unknown as PluginManifest;
    const { context } = fake({
      views: [proposedOnly(mcpView("mcp.gmaps", { name: "Google Maps", enabled: false, configFields: GOOGLE_MAPS_PRESET.config }))],
      rows: [row("mcp.gmaps", { name: "Google Maps", state: "disabled", enabled: false, pendingVersions: ["1.0.0"] })],
      manifests: { "mcp.gmaps": maps },
    });
    const [app] = await list(context);
    expect(app?.health).toBe("not-set-up");
    expect(app?.repairs[0]).toEqual({
      kind: "finish-setup",
      accountId: "mcp.gmaps",
      title: "Finish setting up Google Maps",
      titleRef: { key: "app.repair.finishSetup", params: { app: "Google Maps" } },
      detail: "It needs your Maps API key.",
      detailRef: { key: "app.repair.needs", params: { settings: "your Maps API key" } },
      cli: "tavi credentials set plugins.mcp.gmaps.apiKey --file … && tavi plugins config mcp.gmaps --set apiKey=plugins.mcp.gmaps.apiKey",
    });
    // Data and privacy names it so too, not by its config key (QA 2104).
    expect(app?.credentials).toEqual([{ name: "Your Maps API key", raw: false }]);
  });

  it("names a plain plugin's missing setting by its manifest's label", () => {
    const fields = { token: { type: "credential" as const, label: "Your Weather token" }, city: { type: "string" as const } };
    expect(pluginRepair("Weather", "plugin.weather", "not-set-up", ["token", "city"], fields)).toMatchObject({
      detail: "It needs your Weather token and city.",
      cli: "tavi credentials set plugins.plugin.weather.token --file … && tavi plugins config plugin.weather --set token=plugins.plugin.weather.token",
    });
  });

  it("offers a key its server refused at its test its setup again, not a review that cannot be probed", async () => {
    const token = {
      ...calendarManifest("mcp.todoist"),
      config: TODOIST_TOKEN_PRESET.config,
      mcp: { ...calendarManifest("mcp.todoist").mcp, auth: "headers", preset: "todoist-token" },
    } as unknown as PluginManifest;
    const view = proposedOnly(
      mcpView("mcp.todoist", {
        name: "Todoist (API token)",
        enabled: false,
        configFields: TODOIST_TOKEN_PRESET.config,
        config: { apiToken: "plugins.mcp.todoist.apiToken" },
      }),
    );
    const fakeOwner = fake({
      views: [view],
      rows: [row("mcp.todoist", { state: "disabled", enabled: false, pendingVersions: ["1.0.0"] })],
      manifests: { "mcp.todoist": token },
    });
    let refuse = true;
    const context: AppsContext = {
      ...fakeOwner.context,
      mcp: async (payload) =>
        payload.action !== "probe"
          ? fakeOwner.context.mcp(payload)
          : refuse
            ? {
                ok: false,
                error: {
                  code: "NOT_AUTHORIZED",
                  message: "the MCP server refused its credentials (HTTP 401, connect): check its token setting",
                  details: { mcpFailure: "auth", where: "connect", status: 401 },
                },
              }
            : { ok: true, result: {} },
    };
    const test = { action: "test", appId: "todoist-token", accountId: "mcp.todoist", workspaceId: "default" } as const;
    expect((await list(context))[0]?.health).toBe("needs-review");
    expect(await appsCommand(context, test)).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    const [refused] = await list(context);
    expect(refused?.health).toBe("not-set-up");
    expect(refused?.accounts[0]?.health).toBe("not-set-up");
    expect(refused?.repairs[0]).toEqual({
      kind: "finish-setup",
      accountId: "mcp.todoist",
      title: "Finish setting up Todoist (API token)",
      titleRef: { key: "app.repair.finishSetup", params: { app: "Todoist (API token)" } },
      detail: "Its server refused your Todoist API token: check it and paste it again.",
      detailRef: { key: "app.repair.keyRefused", params: { key: "your Todoist API token" } },
      cli: "tavi credentials set plugins.mcp.todoist.apiToken --file … && tavi mcp probe mcp.todoist",
    });
    // A setting changed since, or a probe since, is not what was refused.
    const changed = { ...view, config: { apiToken: "plugins.mcp.todoist.other" } };
    expect((await list({ ...context, views: async () => [changed] }))[0]?.health).toBe("needs-review");
    const probedSince: AppsContext = {
      ...context,
      mcp: async (payload) =>
        payload.action === "show"
          ? { ok: true, result: { review: { ...review(payload.pluginId), probedAt: "2099-01-01T00:00:00.000Z" } } }
          : context.mcp(payload),
    };
    expect((await list(probedSince))[0]?.health).toBe("needs-review");
    // A token it takes clears the refusal: its version is then the review it waits for.
    refuse = false;
    expect(await appsCommand(context, test)).toMatchObject({ ok: true });
    expect((await list(context))[0]?.health).toBe("needs-review");
  });

  it("names the app as its tools' owner in plain English, whether or not its name ends in s", () => {
    const facts: McpAccountFacts = {
      pluginId: "mcp.notes",
      state: "running",
      enabled: true,
      activeVersion: "1.0.0",
      pendingVersions: ["1.1.0"],
      waitingTools: 0,
      openNotices: [],
      missingSettings: [],
      oauth: false,
      signedIn: false,
    };
    expect(mcpAccountRepair("notes", "needs-review", facts)?.title).toBe("Review notes' tools");
    expect(mcpAccountRepair("Calendar", "needs-review", facts)?.title).toBe("Review Calendar's tools");
  });

  it("asks for a sign-in again when the server says its sign-in lapsed", async () => {
    const { context } = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist", { state: "login-required", reason: "Todoist refused its sign-in" })],
    });
    const [app] = await list(context);
    expect(app?.health).toBe("needs-sign-in");
    expect(app?.repairs[0]).toMatchObject({ kind: "sign-in", title: "Sign in to Todoist again", cli: "tavi mcp login mcp.todoist" });
  });

  it("takes the data class from the preset, so calendar results are personal", () => {
    expect(mcpDataClassOf(calendarManifest("mcp.todoist"))).toBe("personal");
    expect(mcpDataClassOf({ mcp: undefined, apps: { apps: [{ dataClass: "public" }] } })).toBe("public");
    expect(mcpDataClassOf({})).toBeUndefined();
  });
});

describe("the household rule", () => {
  it("defaults to Personal for personal data, Shared otherwise, and keeps the choice as made", () => {
    expect(sharingOf({}, "mcp.todoist", "personal")).toBe("personal");
    expect(sharingOf({}, "mcp.ha", undefined)).toBe("shared");
    const shared = withSharing({}, "mcp.todoist", "shared");
    expect(shared).toEqual({ "mcp.todoist": "shared" });
    expect(withSharing(shared, "mcp.todoist", "personal")).toEqual({ "mcp.todoist": "personal" });
    expect(parseSharing("not json")).toEqual({});
    expect(parseSharing(JSON.stringify({ a: "shared", b: "bogus" }))).toEqual({ a: "shared" });
  });

  it("raises the one-time repair for a Personal account other people were using, and shows it lent to no one", async () => {
    const { context } = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist")],
      refs: ["plugins.mcp.todoist.oauth"],
      people: ["mcp.todoist"],
    });
    const [app] = await list(context);
    expect(app?.accounts[0]).toMatchObject({ sharing: "personal", people: false });
    expect(app?.repairs).toContainEqual(expect.objectContaining({ kind: "sharing", accountId: "mcp.todoist" }));
  });

  it("marks an account shared on the page, and then it is lent as before", async () => {
    const { context, meta } = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist")],
      refs: ["plugins.mcp.todoist.oauth"],
      people: ["mcp.todoist"],
    });
    const set = await appsCommand(context, {
      action: "sharing",
      appId: "todoist",
      accountId: "mcp.todoist",
      sharing: "shared",
      workspaceId: "default",
    });
    expect(set.ok).toBe(true);
    expect(JSON.parse(meta.get("apps.sharing") ?? "{}")).toEqual({ "mcp.todoist": "shared" });
    const [app] = await list(context);
    expect(app?.accounts[0]).toMatchObject({ sharing: "shared", people: true });
    expect(app?.repairs.some((repair) => repair.kind === "sharing")).toBe(false);
  });
});

describe("channels and plugins", () => {
  it("lists a Gmail connection read-only, with a reconnect that opens Settings → Channels", async () => {
    const { context } = fake({ connections: [connection({ authState: "expired" })] });
    const [app] = await list(context);
    expect(app).toMatchObject({
      appId: "gmail",
      name: "Google",
      category: "email",
      health: "needs-sign-in",
      channel: { kinds: ["email"] },
      source: { kind: "channel", verified: "built-in" },
    });
    // Gmail signs in, so it is connected from its page.
    expect(app?.accounts[0]).toMatchObject({ accountId: "conn-1", identity: "you@gmail.com", readOnly: false, sharing: "personal" });
    expect(app?.repairs[0]).toMatchObject({ kind: "sign-in", cli: "tavi channels connect conn-1" });
    expect(app?.auth).toMatchObject({ kind: "oauth", provider: "google", client: "shared-provider" });
    expect(channelAccountHealth({ enabled: true, authState: "needs-consent" }, true)).toBe("needs-access");
    expect(channelAccountHealth({ enabled: false, authState: "connected" }, true)).toBe("paused");
  });

  it("maps a failed channel's named repair to a sign-in or an access, with a key channel's fix as a command", async () => {
    const chat: ChannelDescriptor = {
      ...gmail,
      providerId: "acme-chat",
      label: "Acme chat",
      kind: "chat",
      app: undefined,
      auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token" }] },
      hosts: ["api.acme.example", "gateway.acme.example"],
    } as unknown as ChannelDescriptor;
    const records = [
      connection({ connectionId: "c-cred", providerId: "acme-chat", accountIdentity: "bot" }),
      connection({ connectionId: "c-set", providerId: "acme-chat", accountIdentity: "bot2" }),
      connection({ connectionId: "c-down", providerId: "acme-chat", accountIdentity: "bot3" }),
    ];
    const statuses: Record<string, { state: string; repair?: "credentials" | "provider-settings" }> = {
      "c-cred": { state: "failed", repair: "credentials" },
      "c-set": { state: "failed", repair: "provider-settings" },
      "c-down": { state: "failed" },
    };
    registerChannelDescriptor(chat, "acme.chat");
    try {
      const { context } = fake({ connections: records, descriptors: [chat] });
      const [app] = await list({ ...context, channelStatus: (connectionId) => statuses[connectionId] });
      expect(app?.accounts.map((account) => account.health)).toEqual(["needs-sign-in", "needs-access", "error"]);
      expect(app?.repairs.find((repair) => repair.accountId === "c-cred")).toMatchObject({
        kind: "sign-in",
        title: "Paste a new Acme chat token",
        cli: "tavi channels secret c-cred token --file …",
      });
      expect(app?.repairs.find((repair) => repair.accountId === "c-set")).toMatchObject({
        kind: "grant-access",
        cli: "tavi channels test c-set --to …",
      });
      // What it reaches is its declared hosts, and its source the plugin that registered it.
      expect(app?.egress.hosts).toEqual(["api.acme.example", "gateway.acme.example"]);
      expect(app?.source).toMatchObject({ kind: "channel", pluginIds: ["acme.chat"], verified: "reviewed" });
    } finally {
      unregisterChannelDescriptor("acme-chat");
    }
    expect(channelAccountHealth({ enabled: true, authState: "connected" }, false, { state: "running", repair: "credentials" })).toBe(
      "ready",
    );
  });

  it("presents a plugin with no apps block as a bare app named from its manifest", async () => {
    const plugin = {
      id: "acme.notes",
      kind: "external",
      name: "Acme notes",
      description: "Notes in Acme.",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      versions: [
        { version: "1.0.0", reviewState: "approved", contentHash: "h", installedAt: NOW, tools: [], configFields: {}, runsOwnerCode: true },
      ],
      tools: [{ id: "acme.notes.search", effect: "read-only", description: "Search notes" }],
      configFields: { token: { type: "credential", required: true } },
      config: {},
      runsOwnerCode: true,
      isolation: "process",
    } as unknown as PluginView;
    const { context } = fake({ views: [plugin] });
    const [app] = await list(context);
    expect(app).toMatchObject({
      appId: "acme.notes",
      name: "Acme notes",
      category: "other",
      health: "not-set-up",
      source: { kind: "plugin", isolation: "sandboxed" },
      auth: { kind: "api-key" },
    });
    expect(app?.tools[0]).toMatchObject({ toolId: "acme.notes.search", title: "search", decision: "allow" });
  });

  it("lists an approved plugin's site profiles, each off until the operator turns it on, and forgets them with the app", async () => {
    const plugin = {
      id: "acme.jobs",
      kind: "external",
      name: "Jobs",
      description: "",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      versions: [
        { version: "1.0.0", reviewState: "approved", contentHash: "h", installedAt: NOW, tools: [], configFields: {}, runsOwnerCode: true },
      ],
      tools: [{ id: "acme.jobs.search", effect: "read-only", description: "Search" }],
      configFields: {},
      config: {},
      runsOwnerCode: true,
      isolation: "process",
    } as unknown as PluginView;
    const site = SiteProfileSchema.parse({
      abi: "tavi.sites/1",
      id: "board",
      name: "Board",
      countries: ["*"],
      hosts: ["board.example"],
      kind: "jobs-board",
      access: {
        mode: "assist-only",
        navigate: false,
        reason: "Its terms ban bots",
        termsUrl: "https://board.example/terms",
        reviewedAt: "2026-10-17",
      },
      notes: "",
    });
    const { context, meta } = fake({ views: [plugin] });
    const sited: AppsContext = {
      ...context,
      sitesOf: (pluginId, version) => (pluginId === "acme.jobs" && version === "1.0.0" ? [site] : []),
      siteNotesOf: (pluginId, version) => (pluginId === "acme.jobs" && version === "1.0.0" ? ["board-tips"] : []),
    };
    expect((await list(sited))[0]?.sites).toEqual([
      {
        siteId: "board",
        name: "Board",
        hosts: ["board.example"],
        mode: "assist-only",
        navigate: false,
        watchable: false,
        reason: "Its terms ban bots",
        termsUrl: "https://board.example/terms",
        on: false,
      },
    ]);
    expect(
      await appsCommand(sited, { action: "sites", appId: "acme.jobs", siteId: "board", on: true, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { sites: { siteId: "board", on: true } } });
    expect(JSON.parse(meta.get("apps.sites") ?? "{}")).toEqual({ "acme.jobs": ["board"] });
    expect((await list(sited))[0]?.sites?.[0]?.on).toBe(true);
    expect(
      await appsCommand(sited, { action: "sites", appId: "acme.jobs", siteId: "other", on: true, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    // A site note with no profile of its id is switched by its own id.
    expect(
      await appsCommand(sited, { action: "sites", appId: "acme.jobs", siteId: "board-tips", on: true, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { sites: { siteId: "board-tips", on: true } } });
    expect(JSON.parse(meta.get("apps.sites") ?? "{}")).toEqual({ "acme.jobs": ["board", "board-tips"] });
    await appsCommand(sited, { action: "remove", appId: "acme.jobs", workspaceId: "default" });
    expect(JSON.parse(meta.get("apps.sites") ?? "{}")).toEqual({});
  });

  it("shows each tool's sink as its manifest declares it, and the external default when it is silent", async () => {
    const tools = [
      { id: "acme.notes.search", effect: "read-only", description: "Search", sink: "search" },
      { id: "acme.notes.count", effect: "read-only", description: "Count", sink: "none" },
      { id: "acme.notes.save", effect: "mutating", description: "Save", sink: "persist" },
      { id: "acme.notes.list", effect: "read-only", description: "List" },
    ];
    const plugin = {
      id: "acme.notes",
      kind: "external",
      name: "Notes",
      description: "",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      versions: [
        { version: "1.0.0", reviewState: "approved", contentHash: "h", installedAt: NOW, tools: [], configFields: {}, runsOwnerCode: true },
      ],
      tools,
      configFields: {},
      config: {},
      runsOwnerCode: true,
      isolation: "process",
    } as unknown as PluginView;
    const { context } = fake({ views: [plugin] });
    const [app] = await list(context);
    expect(app?.tools.map((tool) => [tool.toolId, tool.sink])).toEqual([
      ["acme.notes.search", "search"],
      ["acme.notes.count", "none"],
      ["acme.notes.save", "persist"],
      ["acme.notes.list", "network"],
    ]);
  });
});

describe("an author's app id names its own server only", () => {
  const notesManifest = (pluginId: string, url: string) =>
    ({
      ...calendarManifest(pluginId),
      mcp: { ...calendarManifest(pluginId).mcp, preset: undefined, url: { value: url } },
      apps: {
        abi: "tavi.apps/1",
        apps: [{ id: "notes", name: "Notes", summary: "", category: "notes", scopes: [], tools: {}, accountScope: "owner" }],
      },
    }) as unknown as PluginManifest;
  const views = [mcpView("mcp.notes"), mcpView("mcp.notes2"), mcpView("mcp.evil")];
  const urls: Record<string, string> = {
    "mcp.notes": "https://notes.example/mcp",
    "mcp.notes2": "https://notes.example/mcp",
    "mcp.evil": "https://evil.example/mcp",
  };

  it("groups a second account of the same server, and keeps another server claiming the id apart", async () => {
    const { context } = fake({ views, rows: views.map((view) => row(view.id)) });
    const apps = await list({ ...context, manifestOf: (pluginId) => notesManifest(pluginId, urls[pluginId] ?? "") });
    expect(apps.find((app) => app.appId === "notes")?.source.pluginIds).toEqual(["mcp.notes", "mcp.notes2"]);
    expect(apps.find((app) => app.source.pluginIds.includes("mcp.evil"))?.appId).toBe("notes.mcp.evil");
  });

  it("keeps the plain id with the server installed first, whatever its plugin id, and groups a server reached through a setting", async () => {
    const installed = (id: string, at: string) =>
      ({ ...mcpView(id), versions: [{ ...mcpView(id).versions[0]!, installedAt: at }] }) as PluginView;
    // `mcp.anotes` sorts first but came later: it does not take `notes`.
    const ordered = [installed("mcp.anotes", "2026-10-16T00:00:00.000Z"), installed("mcp.notes", "2026-10-01T00:00:00.000Z")];
    const first = fake({ views: ordered, rows: ordered.map((view) => row(view.id)) });
    const named = await list({
      ...first.context,
      manifestOf: (pluginId) =>
        notesManifest(pluginId, pluginId === "mcp.anotes" ? "https://other.example/mcp" : "https://notes.example/mcp"),
    });
    expect(named.find((app) => app.appId === "notes")?.source.pluginIds).toEqual(["mcp.notes"]);
    expect(named.find((app) => app.source.pluginIds.includes("mcp.anotes"))?.appId).toBe("notes.mcp.anotes");
    // The URL in a setting: two accounts of the same server still group.
    const bySetting = (pluginId: string) =>
      ({
        ...notesManifest(pluginId, ""),
        mcp: { ...notesManifest(pluginId, "").mcp, url: { setting: "url" } },
      }) as unknown as PluginManifest;
    const configured = ["mcp.notes", "mcp.notes2"].map(
      (id) => ({ ...mcpView(id), config: { url: "https://notes.example/mcp" } }) as PluginView,
    );
    const second = fake({ views: configured, rows: configured.map((view) => row(view.id)) });
    expect((await list({ ...second.context, manifestOf: bySetting })).find((app) => app.appId === "notes")?.source.pluginIds).toEqual([
      "mcp.notes",
      "mcp.notes2",
    ]);
  });
});

describe("an approved app not turned on yet", () => {
  it("asks to turn it on, not to review it again: an MCP server and a plugin alike", async () => {
    const server = { ...mcpView("mcp.todoist", { enabled: false }), activeVersion: undefined } as unknown as PluginView;
    const [calendar] = await list(
      fake({
        views: [server],
        rows: [{ ...row("mcp.todoist", { enabled: false, state: "disabled" }), activeVersion: undefined } as unknown as McpServerRow],
        refs: ["plugins.mcp.todoist.oauth"],
        grants: { "mcp.todoist": { signedInAt: "2026-10-09T09:00:00.000Z", missingScopes: [] } },
      }).context,
    );
    expect(calendar).toMatchObject({ health: "paused", source: { verified: "tavi-preset" } });
    expect(calendar?.repairs[0]).toMatchObject({ kind: "enable", title: "Turn Todoist on" });
    // Off: its page offers no off.
    expect(calendar?.accounts[0]?.on).toBe(false);
    const plugin = {
      id: "acme.notes",
      kind: "external",
      name: "Notes",
      description: "",
      enabled: false,
      core: false,
      versions: [
        { version: "1.0.0", reviewState: "approved", contentHash: "h", installedAt: NOW, tools: [], configFields: {}, runsOwnerCode: true },
      ],
      tools: [{ id: "acme.notes.search", effect: "read-only", description: "Search" }],
      configFields: {},
      config: {},
      runsOwnerCode: true,
    } as unknown as PluginView;
    const [notes] = await list(fake({ views: [plugin] }).context);
    expect(notes).toMatchObject({ health: "paused", source: { verified: "reviewed" } });
    expect(notes?.tools[0]).toMatchObject({ state: "offered" });
    expect(notes?.repairs[0]).toMatchObject({ kind: "enable" });
  });
});

describe("an app's icon", () => {
  const HASH = "a".repeat(64);
  const block = {
    abi: "tavi.apps/1",
    apps: [
      {
        id: "acme-notes",
        name: "Notes",
        summary: "",
        icon: "assets/notes.svg",
        category: "notes",
        scopes: [],
        tools: {},
        accountScope: "owner",
      },
    ],
  };
  const notes = (extra: Partial<PluginView> = {}, reviewState = "approved") =>
    ({
      id: "acme.notes",
      kind: "external",
      name: "Notes",
      description: "",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      versions: [{ version: "1.0.0", reviewState, contentHash: HASH, installedAt: NOW, tools: [], configFields: {}, runsOwnerCode: true }],
      tools: [],
      configFields: {},
      config: {},
      runsOwnerCode: true,
      ...extra,
    }) as unknown as PluginView;
  const withManifests = (context: AppsContext): AppsContext => {
    const original = context.manifestOf;
    return {
      ...context,
      manifestOf: (pluginId, version) =>
        pluginId === "acme.notes"
          ? ({ ...calendarManifest(pluginId), mcp: undefined, apps: block } as unknown as PluginManifest)
          : pluginId === "mcp.notes"
            ? ({
                ...calendarManifest(pluginId),
                mcp: { ...calendarManifest(pluginId).mcp, preset: undefined },
                apps: block,
              } as unknown as PluginManifest)
            : original(pluginId, version),
    };
  };

  it("gives a plugin's app its author's icon from the approved snapshot, and none before approval or while off", async () => {
    expect((await list(withManifests(fake({ views: [notes()] }).context)))[0]?.icon).toBe(`/plugin-ui/acme.notes/${HASH}/assets/notes.svg`);
    expect((await list(withManifests(fake({ views: [notes({}, "proposed")] }).context)))[0]?.icon).toBeUndefined();
    expect((await list(withManifests(fake({ views: [notes({ enabled: false })] }).context)))[0]?.icon).toBeUndefined();
  });

  it("gives an MCP server's app its author's icon, and a preset server none", async () => {
    const server = mcpView("mcp.notes", {
      versions: [
        {
          version: "1.0.0",
          reviewState: "approved",
          contentHash: HASH,
          installedAt: NOW,
          tools: [],
          configFields: {},
          runsOwnerCode: false,
        },
      ],
    } as Partial<PluginView>);
    const apps = await list(
      withManifests(fake({ views: [server, mcpView("mcp.todoist")], rows: [row("mcp.notes"), row("mcp.todoist")] }).context),
    );
    expect(apps.find((app) => app.source.pluginIds.includes("mcp.notes"))?.icon).toBe(`/plugin-ui/mcp.notes/${HASH}/assets/notes.svg`);
    expect(apps.find((app) => app.appId === "todoist")?.icon).toBeUndefined();
  });

  it("shows an author's words only from an approved version: one awaiting its first review is its bare name", async () => {
    // Nothing approved yet: no version is active, and the only one waits for its review.
    const waiting = (view: PluginView): PluginView => {
      const { activeVersion: _none, ...rest } = view;
      return { ...rest, versions: view.versions.map((candidate) => ({ ...candidate, reviewState: "proposed" })) } as PluginView;
    };
    const [plugin] = await list(withManifests(fake({ views: [waiting(notes())] }).context));
    expect(plugin).toMatchObject({ appId: "acme.notes", category: "other" });
    const server = waiting(
      mcpView("mcp.notes", {
        name: "notes",
        versions: [
          {
            version: "1.0.0",
            reviewState: "approved",
            contentHash: HASH,
            installedAt: NOW,
            tools: [],
            configFields: {},
            runsOwnerCode: false,
          },
        ],
      } as Partial<PluginView>),
    );
    const [app] = await list(withManifests(fake({ views: [server], rows: [row("mcp.notes")] }).context));
    expect(app).toMatchObject({ appId: "mcp.notes", name: "notes", category: "other" });
    // Once approved, the same block names it.
    expect((await list(withManifests(fake({ views: [notes()] }).context)))[0]).toMatchObject({ appId: "acme-notes", category: "notes" });
  });

  it("marks a summary Tavi wrote for a server that describes itself nowhere as Tavi's, and an author's own as not", async () => {
    const bare = (description: string) => mcpView("mcp.notes", { name: "notes", description, configFields: {} });
    const [ours] = await list({
      ...fake({ views: [bare("A local MCP server (notes)")], rows: [row("mcp.notes")] }).context,
      manifestOf: () => undefined,
    });
    expect(ours).toMatchObject({ summary: "A local MCP server (notes)", summaryByTavi: true });
    const [theirs] = await list({
      ...fake({ views: [bare("Keeps your notes")], rows: [row("mcp.notes")] }).context,
      manifestOf: () => undefined,
    });
    expect(theirs?.summaryByTavi).toBeUndefined();
  });
});

describe("per-tool decisions from the page", () => {
  const read = { toolId: "mcp.todoist.find-tasks", effect: "read-only" as const, mcp: true };
  const write = { toolId: "mcp.todoist.add-tasks", effect: "external" as const, mcp: true };
  const by = { actor: "operator:ui", now: NOW };
  const cliAllow: ToolRule = {
    ruleId: "rule-cli",
    workspaceId: "default",
    toolPattern: "acme.notes.put",
    decision: "allow",
    source: "operator",
    createdBy: "operator:cli",
    createdVia: "cli",
    createdAt: NOW,
  };

  it("blocks and asks with the page's own owner-wide rule, and Allow on a read undoes it", () => {
    const blocked = resolvePermission([[]], read, "block", by);
    expect(blocked).toMatchObject({
      kind: "put",
      rule: { ruleId: pageRuleId(read.toolId), workspaceId: "*", decision: "deny", toolPattern: read.toolId },
    });
    const rules = blocked.kind === "put" ? [blocked.rule] : [];
    expect(toolPolicy(rules, read)).toMatchObject({ decision: "block", canSetHere: ["allow", "ask", "block"] });
    expect(resolvePermission([rules], read, "allow", by)).toEqual({ kind: "delete", ruleId: pageRuleId(read.toolId) });
    expect(resolvePermission([[]], read, "ask", by)).toMatchObject({ kind: "put", rule: { decision: "ask" } });
  });

  it("refuses Allow on an MCP write, and Ask undoes the page's own Block", () => {
    expect(() => resolvePermission([[]], write, "allow", by)).toThrow(/approval card/);
    const blocked = resolvePermission([[]], write, "block", by);
    const rules = blocked.kind === "put" ? [blocked.rule] : [];
    expect(resolvePermission([rules], write, "ask", by)).toEqual({ kind: "delete", ruleId: pageRuleId(write.toolId) });
    expect(toolPolicy([], write).canSetHere).toEqual(["ask", "block"]);
  });

  it("adds an ask rule that wins over a CLI allow, and never touches the CLI's rule", () => {
    const plugin = { toolId: "acme.notes.put", effect: "mutating" as const, mcp: false };
    expect(toolPolicy([cliAllow], plugin)).toMatchObject({ decision: "allow", because: ["rule", "set-in-cli"] });
    const asked = resolvePermission([[cliAllow]], plugin, "ask", by);
    expect(asked).toMatchObject({ kind: "put", rule: { decision: "ask", ruleId: pageRuleId(plugin.toolId) } });
    const rules = asked.kind === "put" ? [cliAllow, asked.rule] : [cliAllow];
    expect(toolPolicy(rules, plugin).decision).toBe("ask");
    // Allow again removes only the page's rule; the CLI's stays.
    expect(resolvePermission([rules], plugin, "allow", by)).toEqual({ kind: "delete", ruleId: pageRuleId(plugin.toolId) });
  });

  it("leaves a deny made in the CLI in force", () => {
    const cliDeny: ToolRule = { ...cliAllow, ruleId: "rule-deny", toolPattern: read.toolId, decision: "deny" };
    expect(toolPolicy([cliDeny], read)).toMatchObject({ decision: "block", canSetHere: ["block"] });
    expect(() => resolvePermission([[cliDeny]], read, "ask", by)).toThrow(/rule made in the CLI/);
  });

  it("asks a critical tool every time, even under an allow rule", () => {
    expect(
      toolPolicy([{ ...cliAllow, toolPattern: "mcp.ha.lock" }], {
        toolId: "mcp.ha.lock",
        effect: "external",
        floor: "critical",
        mcp: true,
      }),
    ).toMatchObject({ decision: "ask", because: ["critical"] });
  });

  it("applies a target through the command, and refuses an allow it would have to add", async () => {
    const { context, rules } = fake({ views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")], refs: ["plugins.mcp.todoist.oauth"] });
    expect(
      (
        await appsCommand(context, {
          action: "permission",
          appId: "todoist",
          toolId: "mcp.todoist.add-tasks",
          target: "block",
          workspaceId: "default",
        })
      ).ok,
    ).toBe(true);
    expect(rules).toEqual([
      expect.objectContaining({ ruleId: pageRuleId("mcp.todoist.add-tasks"), decision: "deny", workspaceId: "*", createdVia: "bridge" }),
    ]);
    const refused = await appsCommand(context, {
      action: "permission",
      appId: "todoist",
      toolId: "mcp.todoist.add-tasks",
      target: "allow",
      workspaceId: "default",
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect((await appsCommand(context, { action: "remove", appId: "todoist", workspaceId: "default" })).ok).toBe(true);
    expect(rules).toEqual([]);
  });
});

describe("adding and the catalog", () => {
  it("names a second account of a preset with the next free slug", async () => {
    expect(nextSlug("todoist", new Set())).toBe("todoist");
    expect(nextSlug("todoist", new Set(["mcp.todoist", "mcp.todoist2"]))).toBe("todoist3");
    const { context, mcpCalls } = fake({ views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")] });
    const added = await appsCommand(context, { action: "add", entry: { kind: "preset", id: "todoist" }, workspaceId: "default" });
    expect(added.ok).toBe(true);
    expect(mcpCalls).toContainEqual({ action: "add", slug: "todoist2", form: { kind: "preset", preset: "todoist" } });
  });

  it("keeps one Todoist: adding its other way in offers to switch the server already added, and adds no second", async () => {
    const { context, mcpCalls } = fake({ views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")] });
    const offered = await appsCommand(context, { action: "add", entry: { kind: "preset", id: "todoist-token" }, workspaceId: "default" });
    expect(offered).toMatchObject({
      ok: false,
      error: {
        code: "CONFLICT",
        details: {
          switch: { appId: "todoist", name: "Todoist", pluginIds: ["mcp.todoist"], to: "todoist-token", toName: "Todoist (API token)" },
        },
      },
    });
    if (offered.ok) throw new Error("added");
    expect(offered.error.message).toBe(
      "mcp.todoist is already added as Todoist, which reaches the same server by signing in: Tavi keeps one. Switch it to Todoist (API token) with `tavi apps add todoist-token --switch`: its sign-in is removed and its tools are reviewed again",
    );
    expect(mcpCalls.some((call) => call.action === "add")).toBe(false);
  });

  it("switches Todoist's way in: the server added is removed with its rules, and the other preset takes its name", async () => {
    const { context, mcpCalls, rules } = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist")],
      rules: [
        {
          ruleId: pageRuleId("mcp.todoist.add-tasks"),
          workspaceId: "*",
          decision: "allow",
          toolPattern: "mcp.todoist.add-tasks",
        } as ToolRule,
      ],
    });
    const removed: string[] = [];
    const switching: AppsContext = {
      ...context,
      plugins: async (payload) => {
        if (payload.action === "remove") removed.push(payload.pluginId);
        return { ok: true, result: {} };
      },
    };
    const switched = await appsCommand(switching, {
      action: "add",
      entry: { kind: "preset", id: "todoist-token" },
      switch: true,
      workspaceId: "default",
    });
    expect(switched).toMatchObject({
      ok: true,
      result: { added: { pluginId: "mcp.todoist", switched: { from: "todoist", pluginIds: ["mcp.todoist"] } } },
    });
    expect(removed).toEqual(["mcp.todoist"]);
    expect(rules).toEqual([]);
    expect(mcpCalls).toContainEqual({ action: "add", slug: "todoist", form: { kind: "preset", preset: "todoist-token" } });
  });

  it("lists the presets and the channels, and searches the registry only for words", async () => {
    const { context, mcpCalls } = fake();
    const answer = await appsCommand(context, { action: "catalog", query: "", workspaceId: "default" });
    if (!answer.ok) throw new Error(answer.error.message);
    const { catalog } = answer.result as { readonly catalog: import("@tavi/contracts").AppsCatalogAnswer };
    const presets = catalog.sections.find((section) => section.section === "presets")?.entries ?? [];
    // Todoist: the to-do list's own-app preset (`tasks.home`).
    expect(presets.map((entry) => entry.name)).toEqual([
      "Home Assistant",
      "Google Maps",
      "Todoist",
      "Todoist (API token)",
      "Linear",
      "Notion",
      "Sentry",
      "Stripe",
      "Figma",
    ]);
    expect(presets.find((entry) => entry.name === "Google Maps")?.badges).toEqual(["tavi-preset", "remote"]);
    expect(presets.find((entry) => entry.name === "Todoist")?.badges).toEqual(["tavi-preset", "remote"]);
    expect(presets.find((entry) => entry.name === "Todoist (API token)")).toMatchObject({
      auth: "api-key",
      badges: ["tavi-preset", "remote"],
    });
    expect(catalog.sections.find((section) => section.section === "channels")?.entries[0]).toMatchObject({
      name: "Google",
      badges: ["built-in", "own-client"],
    });
    expect(mcpCalls.some((call) => call.action === "search")).toBe(false);
    await appsCommand(context, { action: "catalog", query: "notion", workspaceId: "default" });
    expect(mcpCalls).toContainEqual({ action: "search", query: "notion" });
  });
});

describe("the projection's edge cases", () => {
  const blockPlugin: PluginView = {
    id: "acme.notes",
    kind: "external",
    name: "Acme notes",
    description: "",
    enabled: true,
    core: false,
    activeVersion: "1.0.0",
    versions: [
      { version: "1.0.0", reviewState: "approved", contentHash: "h", installedAt: NOW, tools: [], configFields: {}, runsOwnerCode: true },
    ],
    tools: [{ id: "acme.notes.put", effect: "mutating", description: "Put a note" }],
    configFields: { region: { type: "string" } },
    config: {},
    runsOwnerCode: true,
    isolation: "process",
  } as unknown as PluginView;

  it("decides a page rule against every workspace's rules, as it applies in every one", async () => {
    const cliAllow: ToolRule = {
      ruleId: "rule-cli",
      workspaceId: "other",
      toolPattern: "acme.notes.put",
      decision: "allow",
      source: "operator",
      createdBy: "operator:cli",
      createdVia: "cli",
      createdAt: NOW,
    };
    const { context, rules } = fake({ views: [blockPlugin], workspaces: ["default", "other"], workspaceRules: { other: [cliAllow] } });
    // Its default asks in `default`, but the CLI allows it in `other`: Ask needs the page's ask rule there.
    expect(
      (
        await appsCommand(context, {
          action: "permission",
          appId: "acme.notes",
          toolId: "acme.notes.put",
          target: "ask",
          workspaceId: "default",
        })
      ).ok,
    ).toBe(true);
    expect(rules).toEqual([expect.objectContaining({ ruleId: pageRuleId("acme.notes.put"), decision: "ask" })]);
  });

  it("offers only the targets the owner will take, held against every workspace's rules", async () => {
    const reader = {
      ...blockPlugin,
      tools: [{ id: "acme.notes.find", effect: "read-only", description: "Find notes" }],
    } as unknown as PluginView;
    const cli = (decision: "ask" | "deny"): ToolRule => ({
      ruleId: `rule-${decision}`,
      workspaceId: "other",
      toolPattern: "acme.notes.find",
      decision,
      source: "operator",
      createdBy: "operator:cli",
      createdVia: "cli",
      createdAt: NOW,
    });
    const toolIn = async (rule: ToolRule | undefined) => {
      const { context } = fake({
        views: [reader],
        workspaces: ["default", "other"],
        workspaceRules: rule === undefined ? {} : { other: [rule] },
      });
      const tool = (await list(context)).find((app) => app.appId === "acme.notes")?.tools[0];
      return {
        tool,
        allow: await appsCommand(context, {
          action: "permission",
          appId: "acme.notes",
          toolId: "acme.notes.find",
          target: "allow",
          workspaceId: "default",
        }),
      };
    };
    expect((await toolIn(undefined)).tool).toMatchObject({ decision: "allow", canSetHere: ["allow", "ask", "block"] });
    // Asked in `other`: here it runs unasked, but the page cannot make it so everywhere.
    const asked = await toolIn(cli("ask"));
    expect(asked.tool).toMatchObject({ decision: "allow", canSetHere: ["ask", "block"] });
    expect(asked.allow).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect((await toolIn(cli("deny"))).tool?.canSetHere).toEqual(["block"]);
  });

  it("refuses a target for a tool that waits for its review", async () => {
    const { context } = fake({ views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")], refs: ["plugins.mcp.todoist.oauth"] });
    const pending = {
      ...blockPlugin,
      activeVersion: undefined,
      versions: [{ ...blockPlugin.versions[0], reviewState: "proposed" }],
    } as unknown as PluginView;
    const withPending = fake({ views: [pending] });
    expect(
      await appsCommand(withPending.context, {
        action: "permission",
        appId: "acme.notes",
        toolId: "acme.notes.put",
        target: "block",
        workspaceId: "default",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      (
        await appsCommand(context, {
          action: "permission",
          appId: "todoist",
          toolId: "mcp.todoist.find-tasks",
          target: "block",
          workspaceId: "default",
        })
      ).ok,
    ).toBe(true);
  });

  it("keeps Tavi's app ids for Tavi: a plugin claiming one is shown under its own id", async () => {
    const claiming = { ...blockPlugin, id: "evil.cal" } as PluginView;
    const { context } = fake({
      views: [mcpView("mcp.todoist"), claiming],
      rows: [row("mcp.todoist")],
      refs: ["plugins.mcp.todoist.oauth"],
    });
    context.manifestOf.bind(context);
    const original = context.manifestOf;
    const withBlock: AppsContext = {
      ...context,
      manifestOf: (pluginId, version) =>
        pluginId === "evil.cal"
          ? ({
              ...calendarManifest("evil.cal"),
              mcp: undefined,
              apps: {
                abi: "tavi.apps/1",
                apps: [
                  {
                    id: "todoist",
                    name: "Todoist",
                    summary: "",
                    category: "calendar",
                    scopes: [],
                    tools: {},
                    accountScope: "owner",
                  },
                ],
              },
            } as unknown as PluginManifest)
          : original(pluginId, version),
    };
    const apps = await list(withBlock);
    expect(apps.find((app) => app.appId === "todoist")?.source.pluginIds).toEqual(["mcp.todoist"]);
    expect(apps.find((app) => app.appId === "evil.cal")).toBeDefined();
  });

  it("checks every value before configure writes anything", async () => {
    const calls: unknown[] = [];
    const { context } = fake({ views: [blockPlugin] });
    const counting: AppsContext = {
      ...context,
      plugins: async (payload) => {
        calls.push(payload);
        return { ok: true, result: {} };
      },
    };
    expect(
      await appsCommand(counting, { action: "configure", appId: "acme.notes", values: { region: 3 }, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await appsCommand(counting, { action: "configure", appId: "acme.notes", values: { nope: "x" }, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(calls).toEqual([]);
    expect(
      (await appsCommand(counting, { action: "configure", appId: "acme.notes", values: { region: "eu" }, workspaceId: "default" })).ok,
    ).toBe(true);
    expect(calls).toEqual([{ action: "config", pluginId: "acme.notes", set: { region: "eu" }, unset: [] }]);
  });

  it("keeps a Telegram account marked Personal as Personal", async () => {
    const telegram = {
      ...gmail,
      providerId: "telegram",
      label: "Telegram",
      kind: "chat",
      auth: { kind: "none" },
    } as unknown as ChannelDescriptor;
    const { context, meta } = fake({ connections: [connection({ connectionId: "tg-1", providerId: "telegram" })] });
    const withTelegram: AppsContext = { ...context, descriptorOf: (providerId) => (providerId === "telegram" ? telegram : undefined) };
    expect(
      (
        await appsCommand(withTelegram, {
          action: "sharing",
          appId: "telegram",
          accountId: "tg-1",
          sharing: "personal",
          workspaceId: "default",
        })
      ).ok,
    ).toBe(true);
    expect(JSON.parse(meta.get("apps.sharing") ?? "{}")).toEqual({ "tg-1": "personal" });
    const [app] = await list(withTelegram);
    expect(app?.accounts[0]?.sharing).toBe("personal");
  });
});

describe("another account, and disconnecting one", () => {
  it("signs in with the shared Desktop client from any port the page is on", async () => {
    const { context, mcpCalls } = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist")],
      refs: ["plugins.mcp.todoist.oauth"],
    });
    for (const origin of ["http://127.0.0.1:8765", "http://127.0.0.1:51234"]) {
      await appsCommand(context, {
        action: "connect",
        appId: "todoist",
        accountId: "mcp.todoist",
        via: "here",
        origin,
        addAccount: false,
        workspaceId: "default",
      });
      expect(mcpCalls).toContainEqual(expect.objectContaining({ action: "login", pluginId: "mcp.todoist", origin }));
    }
  });

  it("adds no second account to a server not added from a preset: another is added from Discover", async () => {
    const fakes = fake({ views: [mcpView("mcp.notes")], rows: [row("mcp.notes")] });
    const { mcpCalls } = fakes;
    // Its manifest names no preset: a server added by its address.
    const context: AppsContext = {
      ...fakes.context,
      manifestOf: (pluginId) =>
        ({ ...calendarManifest(pluginId), mcp: { ...calendarManifest(pluginId).mcp, preset: undefined } }) as unknown as PluginManifest,
    };
    const app = (await list(context)).find((candidate) => candidate.source.pluginIds.includes("mcp.notes"));
    expect(
      await appsCommand(context, {
        action: "connect",
        appId: app?.appId ?? "",
        addAccount: true,
        via: "here",
        origin: "http://127.0.0.1:8765",
        workspaceId: "default",
      }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: expect.stringContaining("add it again from Discover") } });
    expect(mcpCalls.some((call) => call.action === "add" || call.action === "login")).toBe(false);
  });

  it("adds a second account as another instance, and takes it away again when its sign-in cannot start", async () => {
    const removed: string[] = [];
    const { context, mcpCalls } = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist")],
      refs: ["plugins.mcp.todoist.oauth"],
    });
    const failing: AppsContext = {
      ...context,
      plugins: async (payload) => {
        if (payload.action === "remove") removed.push(payload.pluginId);
        return { ok: true, result: {} };
      },
      // Its sign-in cannot start: the provider's discovery did not answer.
      mcp: async (payload) => {
        if (payload.action === "login") return { ok: false, error: { code: "UNAVAILABLE", message: "no answer" } };
        return await context.mcp(payload);
      },
    };
    const refused = await appsCommand(failing, {
      action: "connect",
      appId: "todoist",
      addAccount: true,
      via: "here",
      origin: "http://127.0.0.1:8765",
      workspaceId: "default",
    });
    expect(refused.ok).toBe(false);
    expect(mcpCalls).toContainEqual({ action: "add", slug: "todoist2", form: { kind: "preset", preset: "todoist" } });
    expect(removed).toEqual(["mcp.todoist2"]);
    // Without the page's own address, nothing is added at all.
    expect(
      await appsCommand(failing, { action: "connect", appId: "todoist", addAccount: true, via: "here", workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(mcpCalls.filter((call) => call.action === "add")).toHaveLength(1);
  });
  it("disconnects a second account and removes it with its sharing choice, revoking its sign-in", async () => {
    const removed: string[] = [];
    const { context, meta } = fake({
      views: [mcpView("mcp.todoist"), mcpView("mcp.todoist2")],
      rows: [row("mcp.todoist"), row("mcp.todoist2")],
      refs: ["plugins.mcp.todoist.oauth", "plugins.mcp.todoist2.oauth"],
    });
    meta.set("apps.sharing", JSON.stringify({ "mcp.todoist2": "shared" }));
    const counting: AppsContext = {
      ...context,
      mcp: async (payload) =>
        payload.action === "logout"
          ? { ok: true, result: { loggedOut: { pluginId: payload.pluginId, hadGrant: true, confirmed: true } } }
          : await context.mcp(payload),
      plugins: async (payload) => {
        if (payload.action === "remove") removed.push(payload.pluginId);
        return { ok: true, result: {} };
      },
    };
    const answer = await appsCommand(counting, {
      action: "disconnect",
      appId: "todoist",
      accountId: "mcp.todoist2",
      remove: true,
      workspaceId: "default",
    });
    expect(answer).toMatchObject({ ok: true, result: { disconnected: { accountId: "mcp.todoist2", revoked: true, removed: true } } });
    expect(removed).toEqual(["mcp.todoist2"]);
    expect(JSON.parse(meta.get("apps.sharing") ?? "{}")).toEqual({});
    // The first account only signs out, even when asked to go too.
    const first = await appsCommand(counting, {
      action: "disconnect",
      appId: "todoist",
      accountId: "mcp.todoist",
      remove: true,
      workspaceId: "default",
    });
    expect(first).toMatchObject({ ok: true, result: { disconnected: { accountId: "mcp.todoist", removed: false } } });
    expect(removed).toEqual(["mcp.todoist2"]);
  });
});

describe("the client's setup", () => {
  it("lists the console steps with their pages on Google's account, and says when a client is ready", async () => {
    const { context } = fake({ connections: [connection()] });
    const [before] = await list(context);
    expect(before?.clientSetup).toMatchObject({ provider: "google", title: "Set up Google", ready: false });
    expect(before?.clientSetup?.steps.map((step) => step.link?.url).filter((url) => url !== undefined)).toEqual([
      "https://console.cloud.google.com/projectcreate",
      "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com",
      "https://console.cloud.google.com/auth/overview/create",
      "https://console.cloud.google.com/auth/branding",
      "https://console.cloud.google.com/auth/clients/create",
    ]);
    expect(before?.clientSetup?.steps.at(-1)?.text).toMatch(/Download JSON before you close it/);
    const { context: withShared } = fake({ connections: [connection()], refs: ["oauth-clients.google.id"] });
    expect((await list(withShared))[0]?.clientSetup?.ready).toBe(true);
  });

  it("takes a Desktop app client's file as the shared client, and refuses a Web client's", async () => {
    const sent: unknown[] = [];
    const { context } = fake({
      connections: [connection()],
      channels: async (payload) => {
        sent.push(payload);
        return { ok: true, result: { ok: true } };
      },
    });
    const configure = (clientFile: string, values: Record<string, string> = {}) =>
      appsCommand(context, { action: "configure", appId: "gmail", values, clientFile, workspaceId: "default" });
    const installed = JSON.stringify({
      installed: { client_id: "1-desk.apps.googleusercontent.com", client_secret: "GOCSPX-test", redirect_uris: ["http://localhost"] },
    });
    expect((await configure(installed)).ok).toBe(true);
    expect(sent).toEqual([
      { action: "oauth-client", providerId: "gmail", clientId: "1-desk.apps.googleusercontent.com", clientSecret: "GOCSPX-test" },
    ]);
    expect(await configure(JSON.stringify({ web: { client_id: "1-web.apps.googleusercontent.com" } }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("create a Desktop app client instead") },
    });
    expect(await configure("not json")).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await configure(installed, { clientId: "other" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(sent).toHaveLength(1);
  });
});

describe("a client file", () => {
  it("reads a Desktop client's id and secret, and refuses anything else, saying what to make instead", () => {
    expect(parseClientFile(JSON.stringify({ installed: { client_id: "1-a.apps.googleusercontent.com" } }))).toEqual({
      clientId: "1-a.apps.googleusercontent.com",
    });
    expect(parseClientFile(JSON.stringify({ installed: { client_id: "1-a.apps.googleusercontent.com", client_secret: "" } }))).toEqual({
      clientId: "1-a.apps.googleusercontent.com",
    });
    expect(() => parseClientFile(JSON.stringify({ web: { client_id: "1-w" } }))).toThrow(/Desktop app client instead/);
    expect(() => parseClientFile("[]")).toThrow(/names no Desktop app client/);
    expect(() => parseClientFile(JSON.stringify({ installed: { client_id: "has space" } }))).toThrow(/names no Desktop app client/);
    expect(() => parseClientFile(JSON.stringify({ installed: { client_id: "1-a", client_secret: 5 } }))).toThrow(/secret is not one/);
    expect(() => parseClientFile("{")).toThrow(/not JSON/);
    expect(() => parseClientFile(" ".repeat(9_000))).toThrow(/too large/);
  });
});

describe("the weekly sign-in's forecast", () => {
  const signedIn = { signedInAt: "2026-10-09T09:00:00.000Z", missingScopes: [] };
  const signedInView = () => ({
    views: [mcpView("mcp.todoist")],
    rows: [row("mcp.todoist")],
    refs: ["plugins.mcp.todoist.oauth"],
  });

  it("reminds a day before an app it learned is in Testing signs out, worded as a reminder, and not before", async () => {
    const at = async (now: string, extra: { readonly learned?: boolean } = {}) => {
      const { context } = fake({
        ...signedInView(),
        grants: { "mcp.todoist": { ...signedIn, ...(extra.learned !== false ? { learnedWeekly: true } : {}) } },
        now,
      });
      return (await list(context))[0];
    };
    const early = await at("2026-10-14T09:00:00.000Z");
    expect(early?.health).toBe("ready");
    expect(early?.accounts[0]).toMatchObject({ expiresWeekly: true, nextSignInBy: "2026-10-16T09:00:00.000Z" });
    expect(early?.repairs).toEqual([]);
    const dayBefore = await at("2026-10-15T09:00:00.000Z");
    expect(dayBefore?.health).toBe("ready");
    expect(dayBefore?.repairs).toEqual([
      expect.objectContaining({ kind: "sign-in", accountId: "mcp.todoist", title: "Sign in to Todoist again by 2026-10-16" }),
    ]);
    const published = await at("2026-10-15T09:00:00.000Z", { learned: false });
    expect(published?.accounts[0]?.expiresWeekly).toBe(false);
    expect(published?.repairs).toEqual([]);
    // Past its date and not yet refused, it says the sign-in is due, not a date gone by.
    const due = await at("2026-10-17T09:00:00.000Z");
    expect(due?.repairs).toEqual([
      expect.objectContaining({ title: "Sign in to Todoist again", detail: expect.stringMatching(/^Its weekly sign-in is due/) }),
    ]);
  });

  it("says a lapse it learned is a weekly sign-out, and lists every app's repairs worst first", async () => {
    const lapsed = fake({
      views: [mcpView("mcp.todoist")],
      rows: [row("mcp.todoist", { state: "login-required" })],
      refs: ["plugins.mcp.todoist.oauth"],
      grants: { "mcp.todoist": { ...signedIn, learnedWeekly: true } },
    });
    const apps = await list(lapsed.context);
    expect(apps[0]?.health).toBe("needs-sign-in");
    expect(apps[0]?.repairs[0]?.detail).toMatch(/^It was signed out 7 days after signing in/);
    expect(appRepairList(apps)).toEqual([expect.objectContaining({ appId: "todoist", appName: "Todoist", kind: "sign-in" })]);
    // An app turned off on purpose asks nothing of the rail.
    const paused = fake({
      views: [mcpView("mcp.todoist", { enabled: false })],
      rows: [row("mcp.todoist", { enabled: false })],
      refs: ["plugins.mcp.todoist.oauth"],
      grants: { "mcp.todoist": signedIn },
    });
    const off = await list(paused.context);
    expect(off[0]?.repairs).toEqual([expect.objectContaining({ kind: "enable" })]);
    expect(appRepairList(off)).toEqual([]);
  });
});

describe("the shared Google client", () => {
  const temp = () => {
    const directory = directories.create("tavi-apps-shared-");
    chmodSync(directory, 0o700);
    return directory;
  };

  it("sets the shared Google client from Gmail's app, and nothing else of a channel's (tavi apps client)", async () => {
    const directory = temp();
    const { context } = fake({ connections: [connection()], dataDirectory: directory });
    expect(
      await appsCommand(context, {
        action: "configure",
        appId: "gmail",
        values: { clientId: "123-web.apps.googleusercontent.com" },
        workspaceId: "default",
      }),
    ).toMatchObject({ ok: true });
    expect(await createLocalCredentialStore(directory).getSecret("oauth-clients.google.id")).toBe("123-web.apps.googleusercontent.com");
    expect(
      await appsCommand(context, { action: "configure", appId: "gmail", values: { label: "x" }, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  });
});

describe("a channel that signs in with a code", () => {
  const boxed = {
    ...gmail,
    app: undefined,
    providerId: "boxed",
    label: "Boxed",
    auth: {
      kind: "oauth2",
      oauth: {
        authorizeUrl: "https://auth.boxed.example/authorize",
        tokenUrl: "https://auth.boxed.example/token",
        deviceAuthorizationUrl: "https://auth.boxed.example/device",
        scopes: ["mail"],
        pkce: true,
        client: { source: "operator" },
        redirect: "loopback-any-port",
        tokenAuthMethod: "none",
      },
    },
  } as unknown as ChannelDescriptor;
  const FLOW = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

  it("is a device app, connected by a code with no address to come back to", async () => {
    const sent: Record<string, unknown>[] = [];
    const { context } = fake({
      descriptors: [boxed],
      connections: [connection({ connectionId: "boxed-1", providerId: "boxed", authState: "none", accountIdentity: "" })],
      channels: async (payload) => {
        sent.push(payload as Record<string, unknown>);
        if (payload.action === "oauth-start")
          return {
            ok: true,
            result: {
              flowId: FLOW,
              userCode: "WDJB-MJHT",
              verificationUri: "https://auth.boxed.example/activate",
              verificationUriComplete: "https://auth.boxed.example/activate?code=WDJB-MJHT",
              expiresAt: "2026-10-15T12:15:00.000Z",
            },
          };
        return { ok: true, result: { ok: true } };
      },
    });
    const [app] = await list(context);
    expect(app?.auth).toEqual({ kind: "device", scopes: [{ scope: "mail", says: "mail", access: "send", optional: false }] });
    expect(
      await appsCommand(context, { action: "connect", appId: "boxed", via: "here", addAccount: false, workspaceId: "default" }),
    ).toEqual({
      ok: true,
      result: {
        connect: {
          flowId: FLOW,
          authorizeUrl: "https://auth.boxed.example/activate?code=WDJB-MJHT",
          redirectUri: "",
          via: "here",
          accountId: "boxed-1",
          device: { userCode: "WDJB-MJHT", verificationUri: "https://auth.boxed.example/activate", expiresAt: "2026-10-15T12:15:00.000Z" },
        },
      },
    });
    expect(sent[0]).toEqual({ action: "oauth-start", workspaceId: "default", connectionId: "boxed-1", device: true });
  });
});

describe("a channel's account on its page", () => {
  const FLOW = "0f8fad5b-d9cb-469f-a165-70867728950e";
  function channelOwner(status: Readonly<Record<string, unknown>> = { state: "connected", accountIdentity: "you@gmail.com" }) {
    const sent: Record<string, unknown>[] = [];
    const { context } = fake({
      connections: [connection()],
      channels: async (payload) => {
        sent.push(payload as Record<string, unknown>);
        if (payload.action === "oauth-start")
          return {
            ok: true,
            result: {
              flowId: FLOW,
              authorizeUrl:
                "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Foauth%2Fcallback&state=s",
            },
          };
        if (payload.action === "oauth-status") return { ok: true, result: status };
        if (payload.action === "oauth-finish") return { ok: true, result: { ok: true, message: "Connected as you@gmail.com." } };
        return { ok: true, result: { ok: true } };
      },
    });
    return { context, sent };
  }

  it("signs a Gmail connection in through the channels' own flow, back here or to the public address", async () => {
    const { context, sent } = channelOwner();
    expect(
      await appsCommand(context, {
        action: "connect",
        appId: "gmail",
        via: "here",
        origin: "http://127.0.0.1:8765",
        addAccount: false,
        workspaceId: "default",
      }),
    ).toEqual({
      ok: true,
      result: {
        connect: {
          flowId: FLOW,
          authorizeUrl: expect.any(String),
          redirectUri: "http://127.0.0.1:8765/oauth/callback",
          via: "here",
          accountId: "conn-1",
        },
      },
    });
    expect(sent[0]).toEqual({ action: "oauth-start", workspaceId: "default", connectionId: "conn-1", origin: "http://127.0.0.1:8765" });
    await appsCommand(context, { action: "connect", appId: "gmail", via: "public", addAccount: false, workspaceId: "default" });
    expect(sent.at(-1)).toEqual({ action: "oauth-start", workspaceId: "default", connectionId: "conn-1", public: true });
    expect(await appsCommand(context, { action: "connect-status", flowId: FLOW, workspaceId: "default" })).toEqual({
      ok: true,
      result: { status: { state: "done", identity: "you@gmail.com" } },
    });
    expect(
      await appsCommand(context, {
        action: "connect-finish",
        flowId: FLOW,
        address: "http://127.0.0.1:8765/oauth/callback?state=s&code=c",
        workspaceId: "default",
      }),
    ).toEqual({ ok: true, result: { finished: { flowId: FLOW } } });
    expect(sent.at(-1)).toEqual({
      action: "oauth-finish",
      workspaceId: "default",
      flowId: FLOW,
      address: "http://127.0.0.1:8765/oauth/callback?state=s&code=c",
    });
  });

  it("says a reconnect as another account in the flow's own words, and disconnects through Channels", async () => {
    const { context, sent } = channelOwner({
      state: "failed",
      detail:
        "You signed in as work@acme.com, but this connection is you@gmail.com. Add it as another account instead, or disconnect this one first.",
    });
    expect(await appsCommand(context, { action: "connect-status", flowId: FLOW, workspaceId: "default" })).toMatchObject({
      ok: true,
      result: { status: { state: "failed", message: expect.stringContaining("Add it as another account instead") } },
    });
    expect(
      await appsCommand(context, { action: "disconnect", appId: "gmail", accountId: "conn-1", remove: false, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { disconnected: { accountId: "conn-1" } } });
    expect(sent.at(-1)).toEqual({ action: "oauth-disconnect", workspaceId: "default", connectionId: "conn-1" });
  });

  it("cancels a channel's sign-in through Channels, and leaves an MCP flow's to MCP though the page names its workspace", async () => {
    const { context, sent } = channelOwner({ state: "pending" });
    expect(await appsCommand(context, { action: "connect-cancel", flowId: FLOW, workspaceId: "default" })).toEqual({
      ok: true,
      result: { cancelled: { flowId: FLOW } },
    });
    expect(sent.at(-1)).toEqual({ action: "oauth-cancel", workspaceId: "default", flowId: FLOW });
    const before = sent.length;
    // An MCP flow's id is not a channel's: the channels command is not asked.
    await appsCommand(context, { action: "connect-status", flowId: "mcp-flow-1", workspaceId: "default" });
    expect(sent).toHaveLength(before);
  });

  it("does not say a channel's sign-in was revoked at the provider, which it cannot confirm", async () => {
    const { context } = channelOwner();
    expect(
      await appsCommand(context, { action: "disconnect", appId: "gmail", accountId: "conn-1", remove: false, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { disconnected: { revoked: false } } });
  });

  it("adds another Gmail account as a new connection and signs it in, removing it if the sign-in cannot start", async () => {
    const { context, sent } = channelOwner();
    const wrapped: AppsContext = {
      ...context,
      channels: async (payload) => {
        if (payload.action === "save") {
          sent.push(payload as Record<string, unknown>);
          return { ok: true, result: { connectionId: "gmail-2" } };
        }
        return await (context.channels as NonNullable<AppsContext["channels"]>)(payload);
      },
    };
    expect(
      await appsCommand(wrapped, { action: "connect", appId: "gmail", via: "public", addAccount: true, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { connect: { accountId: "gmail-2" } } });
    expect(sent.slice(-2)).toEqual([
      { action: "save", workspaceId: "default", providerId: "gmail", enabled: true, settings: {} },
      { action: "oauth-start", workspaceId: "default", connectionId: "gmail-2", public: true },
    ]);
    const deleted: unknown[] = [];
    const failing: AppsContext = {
      ...context,
      channels: async (payload) => {
        if (payload.action === "save") return { ok: true, result: { connectionId: "gmail-3" } };
        if (payload.action === "delete") {
          deleted.push(payload);
          return { ok: true, result: { ok: true } };
        }
        throw new TaviError("NOT_CONFIGURED", "Gmail signs in through your public address: set it under Webhooks first");
      },
    };
    expect(
      await appsCommand(failing, { action: "connect", appId: "gmail", via: "public", addAccount: true, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "NOT_CONFIGURED" } });
    expect(deleted).toEqual([{ action: "delete", workspaceId: "default", connectionId: "gmail-3" }]);
  });

  it("leaves Gmail's settings to Channels", async () => {
    const { context } = channelOwner();
    expect(
      await appsCommand(context, { action: "configure", appId: "gmail", values: { label: "x" }, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  });
});

describe("a Google account added from Discover", () => {
  it("makes a connection with its settings' defaults through the channels command, to sign in from its sheet", async () => {
    const sent: Record<string, unknown>[] = [];
    const { context } = fake({
      channels: async (payload) => {
        sent.push(payload as Record<string, unknown>);
        return { ok: true, result: { connectionId: "gmail-9" } };
      },
    });
    expect(
      await appsCommand(context, { action: "add", entry: { kind: "channel", providerId: "gmail" }, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { added: { appId: "gmail", accountId: "gmail-9" } } });
    expect(sent).toEqual([
      { action: "save", workspaceId: "default", providerId: "gmail", enabled: true, settings: { label: "tavi", receive: true } },
    ]);
  });

  it("turns taking mail in off and on through the channels command, keeping the account's other settings", async () => {
    const sent: Record<string, unknown>[] = [];
    const { context } = fake({
      connections: [connection({ settings: { label: "inbox-tavi" } })],
      channels: async (payload) => {
        sent.push(payload as Record<string, unknown>);
        return { ok: true, result: { connectionId: "conn-1" } };
      },
    });
    const gmailOf = async () => (await list(context)).find((candidate) => candidate.appId === "gmail");
    expect((await gmailOf())?.accounts[0]?.receives).toBe(true);
    expect(
      await appsCommand(context, { action: "receive", appId: "gmail", accountId: "conn-1", on: false, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { receive: { on: false } } });
    expect(sent).toEqual([
      {
        action: "save",
        workspaceId: "default",
        connectionId: "conn-1",
        providerId: "gmail",
        enabled: true,
        settings: { label: "inbox-tavi", receive: false },
      },
    ]);
    const off = fake({ connections: [connection({ settings: { receive: false } })] });
    expect((await list(off.context)).find((candidate) => candidate.appId === "gmail")?.accounts[0]?.receives).toBe(false);
  });
});

describe("an account's calendar opt-in", () => {
  it("shows a Google account's calendar off until turned on, lists its tools then, and refuses an account with no calendar", async () => {
    const { context, meta } = fake({ connections: [connection()], views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")] });
    const gmailOf = async () => (await list(context)).find((candidate) => candidate.appId === "gmail");
    expect((await gmailOf())?.accounts[0]?.calendar).toBe(false);
    expect((await gmailOf())?.tools).toEqual([]);
    expect(
      await appsCommand(context, { action: "calendar", appId: "gmail", accountId: "conn-1", on: true, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { calendar: { accountId: "conn-1", on: true } } });
    expect(JSON.parse(meta.get("apps.calendar") ?? "{}")).toEqual({ "conn-1": true });
    const on = await gmailOf();
    expect(on?.accounts[0]?.calendar).toBe(true);
    expect(on?.tools.map((tool) => tool.toolId)).toContain("gmail.conn_1.list_events");
    expect(on?.tools.find((tool) => tool.toolId === "gmail.conn_1.delete_event")).toMatchObject({
      effect: "external",
      decision: "ask",
    });
    await appsCommand(context, { action: "calendar", appId: "gmail", accountId: "conn-1", on: false, workspaceId: "default" });
    expect(JSON.parse(meta.get("apps.calendar") ?? "{}")).toEqual({});
    expect(
      await appsCommand(context, { action: "calendar", appId: "todoist", accountId: "mcp.todoist", on: true, workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  });
});

describe("a mailbox's opt-in", () => {
  it("names an app's accounts when one asked for is not among them, so an address given for an id finds its id", async () => {
    const { context } = fake({ connections: [connection()] });
    expect(
      await appsCommand(context, {
        action: "mailbox",
        appId: "gmail",
        accountId: "you@gmail.com",
        mailbox: "read",
        workspaceId: "default",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Google has no account you@gmail.com: its accounts are conn-1 (you@gmail.com)" },
    });
  });

  it("shows a Gmail account's mailbox off until the person turns it on, and refuses one that is not a mailbox", async () => {
    const { context, meta } = fake({ connections: [connection()], views: [mcpView("mcp.todoist")], rows: [row("mcp.todoist")] });
    const gmailOf = async () => (await list(context)).find((candidate) => candidate.appId === "gmail");
    expect((await gmailOf())?.accounts[0]?.mailbox).toBe("off");
    expect(
      await appsCommand(context, { action: "mailbox", appId: "gmail", accountId: "conn-1", mailbox: "send", workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { mailbox: { mailbox: "send" } } });
    expect(JSON.parse(meta.get("apps.mailbox") ?? "{}")).toEqual({ "conn-1": "send" });
    expect((await gmailOf())?.accounts[0]?.mailbox).toBe("send");
    await appsCommand(context, { action: "mailbox", appId: "gmail", accountId: "conn-1", mailbox: "off", workspaceId: "default" });
    expect(JSON.parse(meta.get("apps.mailbox") ?? "{}")).toEqual({});
    expect(
      await appsCommand(context, {
        action: "mailbox",
        appId: "todoist",
        accountId: "mcp.todoist",
        mailbox: "read",
        workspaceId: "default",
      }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  });

  it("lists an opted-in mailbox's tools on its app's page, and their activity by account", async () => {
    const { context } = fake({ connections: [connection()] });
    const gmailOf = async () => (await list(context)).find((candidate) => candidate.appId === "gmail");
    expect((await gmailOf())?.tools).toEqual([]);
    await appsCommand(context, { action: "mailbox", appId: "gmail", accountId: "conn-1", mailbox: "read", workspaceId: "default" });
    expect((await gmailOf())?.tools.map((tool) => tool.toolId)).toEqual([
      "gmail.conn_1.search",
      "gmail.conn_1.read",
      "gmail.conn_1.thread",
      "gmail.conn_1.label",
      "gmail.conn_1.draft",
    ]);
    await appsCommand(context, { action: "mailbox", appId: "gmail", accountId: "conn-1", mailbox: "send", workspaceId: "default" });
    const send = (await gmailOf())?.tools.find((tool) => tool.toolId === "gmail.conn_1.send_draft");
    expect(send).toMatchObject({ access: "send", effect: "external", sink: "message", state: "offered", decision: "ask" });
    const asked: string[][] = [];
    const activity: NonNullable<AppsContext["activity"]> = {
      effects: async (query) => {
        asked.push([...query.prefixes]);
        return [{ effectKey: "e1", taskId: "t1", toolId: "gmail.conn_1.draft", state: "accepted", createdAt: NOW }];
      },
      approvals: async () => ({ items: [] }),
      calls: async () => [],
    };
    const shown = await appsCommand(
      { ...context, activity },
      { action: "activity", appId: "gmail", accountId: "conn-1", workspaceId: "default" },
    );
    expect(shown).toMatchObject({
      ok: true,
      result: { activity: { rows: [{ toolId: "gmail.conn_1.draft", accountId: "conn-1", title: "Write a draft" }] } },
    });
    expect(asked).toEqual([["gmail.conn_1."]]);
    expect(
      await appsCommand({ ...context, activity }, { action: "activity", appId: "gmail", accountId: "conn-9", workspaceId: "default" }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("a disconnect that would end other apps' sign-ins", () => {
  it("names the other connection of the same Google project and account, and forgets this one's sign-in here only", async () => {
    const directory = directories.create("tavi-apps-revoke-");
    chmodSync(directory, 0o700);
    await createLocalCredentialStore(directory).setSecret("oauth-clients.google.id", "111-shared.apps.googleusercontent.com");
    const signedIn = (connectionId: string, accountIdentity = "you@gmail.com") =>
      connection({ connectionId, accountIdentity, credentialRefs: { oauth: `channels.${connectionId}.oauth` } });
    const { context } = fake({ dataDirectory: directory, connections: [signedIn("conn-1"), signedIn("conn-2")] });
    const accounts = (await list(context)).find((app) => app.appId === "gmail")?.accounts;
    expect(accounts?.map((account) => account.keptBy)).toEqual([["Google (conn-2)"], ["Google (conn-1)"]]);
    // Another account's grant is its own: nothing is kept for it.
    const other = fake({ dataDirectory: directory, connections: [signedIn("conn-1"), signedIn("conn-2", "ana@gmail.com")] });
    expect((await list(other.context)).find((app) => app.appId === "gmail")?.accounts.map((account) => account.keptBy)).toEqual([
      undefined,
      undefined,
    ]);
    const sent: unknown[] = [];
    const withChannels: AppsContext = {
      ...context,
      channels: async (payload) => {
        sent.push(payload);
        return { ok: true, result: { ok: true } };
      },
    };
    expect(
      await appsCommand(withChannels, { action: "disconnect", appId: "gmail", accountId: "conn-1", remove: false, workspaceId: "default" }),
    ).toMatchObject({ ok: true, result: { disconnected: { keptBy: ["Google (conn-2)"] } } });
    expect(sent).toEqual([{ action: "oauth-disconnect", workspaceId: "default", connectionId: "conn-1", upstream: false }]);
  });
});

describe("a channel account's setup notes", () => {
  const hosts = ["discord.com", "*.discord.gg"];

  it("shows the probe's link on a host its channel declares, and drops one elsewhere, keeping its lines", () => {
    const invite = "https://discord.com/oauth2/authorize?client_id=1&permissions=2";
    expect(accountSetup({ lines: ["Bot tavi."], link: { label: "Invite the bot", url: invite } }, hosts)).toEqual({
      setup: { lines: ["Bot tavi."], link: { label: "Invite the bot", url: invite } },
    });
    expect(
      accountSetup({ lines: ["Bot tavi."], link: { label: "Invite the bot", url: "https://gateway.discord.gg/x" } }, hosts).setup?.link
        ?.url,
    ).toBe("https://gateway.discord.gg/x");
    for (const url of [
      "https://evil.example/discord.com",
      "http://discord.com/x",
      "https://user:pw@discord.com/x",
      "https://discord.com.evil.example/",
      "https://discord.com:8443/x",
      "javascript:alert(1)",
    ]) {
      expect(accountSetup({ lines: ["Bot tavi."], link: { label: "Invite", url } }, hosts), url).toEqual({
        setup: { lines: ["Bot tavi."] },
      });
    }
    // Nothing to show: no field.
    expect(accountSetup(undefined, hosts)).toEqual({});
    expect(accountSetup({ lines: [], link: { label: "Invite", url: "https://evil.example/" } }, hosts)).toEqual({});
  });
});
