import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_PRESET_IDS,
  type AppsCatalogAnswer,
  type ConnectableApp,
  type McpPayload,
  type PluginManifest,
  type PluginView,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { BUILTIN_CHANNEL_DESCRIPTORS } from "../../src/features/plugins/catalog.js";
import { appsCommand, PRESET_SLUGS } from "../../src/features/apps/owner.js";
import type { AppsContext } from "../../src/features/apps/registry.js";
import type { McpReview, McpServerRow } from "../../src/features/mcp/actions.js";
import { AVAILABLE_PRESETS, presetOf } from "../../src/features/mcp/presets/index.js";

/**
 * No per-app UI code. The canvas's
 * Connected apps names no app, preset or provider: it draws whatever the
 * owner's read model says. Two halves, one chain:
 * - here, three apps Tavi knows nothing about — an external plugin with an
 *   `apps` block, an external plugin without one, a registry MCP server — go through
 *   the owner's real projection, and what it answers is the fixture
 *   `apps/ui/test/features/apps/fixtures/generic-apps.json` (`UPDATE_FIXTURES=1` rewrites it);
 * - `apps/ui/test/features/apps/apps-generic.test.tsx` draws that fixture in Discover and
 *   Connected with the canvas's code as it is.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_APPS = resolve(HERE, "../../../ui/src/features/apps");
/** What Connected apps renders from elsewhere on the canvas: the MCP review, Discover's registry search and its add-by-address form. */
const UI_RENDERED = [resolve(HERE, "../../../ui/src/features/settings/McpServers.tsx")];
const FIXTURE = resolve(HERE, "../../../ui/test/features/apps/fixtures/generic-apps.json");
const NOW = "2026-10-16T12:00:00.000Z";

/** Every name Tavi's own apps are known by: its presets', their slugs and plugin ids, their apps' and providers', its channels', and their names. */
function taviNames(): { readonly ids: readonly string[]; readonly names: readonly string[] } {
  const ids = new Set<string>(MCP_PRESET_IDS);
  const names = new Set<string>();
  for (const id of AVAILABLE_PRESETS) {
    ids.add(id);
    const slug = PRESET_SLUGS[id];
    if (slug !== undefined) {
      ids.add(slug);
      ids.add(`mcp.${slug}`);
    }
    const app = presetOf(id)?.app;
    if (app !== undefined) {
      ids.add(app.id);
      names.add(app.name);
      if (app.auth?.kind === "oauth" && app.auth.provider !== undefined) ids.add(app.auth.provider);
    }
  }
  for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
    ids.add(descriptor.providerId);
    names.add(descriptor.label);
    if (descriptor.app !== undefined) names.add(descriptor.app.name);
    if (descriptor.app?.provider !== undefined) ids.add(descriptor.app.provider);
  }
  return { ids: [...ids], names: [...names] };
}

/** The canvas's Connected apps sources, in every folder under it. */
function uiFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return uiFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Code without its comments: prose may name an app, code may not. */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const camel = (id: string): string => id.replace(/[-.]([a-z])/g, (_, letter: string) => letter.toUpperCase());

describe("no per-app UI code", () => {
  it("names no app, preset or provider anywhere under apps/ui/src/features/apps", () => {
    const { ids, names } = taviNames();
    expect(ids).toEqual(
      expect.arrayContaining(["todoist", "homeassistant", "mcp.todoist", "google", "gmail", "telegram", "mailgun", "google-maps"]),
    );
    expect(names).toEqual(expect.arrayContaining(["Gmail", "Todoist"]));
    // An id anywhere it is not part of a longer word (its camelCase form too); a name in a string.
    const patterns = [
      ...ids.flatMap((id) =>
        [...new Set([id, camel(id)])].map((form) => [id, new RegExp(`(?<![A-Za-z0-9_])${escape(form)}(?![a-z0-9_])`)] as const),
      ),
      ...names.map((name) => [name, new RegExp(`["'\`]${escape(name)}["'\`]`)] as const),
    ];
    const found = (text: string): string[] => {
      const code = withoutComments(text);
      return [...new Set(patterns.filter(([, pattern]) => pattern.test(code)).map(([name]) => name))];
    };
    // The check itself finds what it looks for, and leaves prose alone.
    expect(found(`if (app.appId === "google-maps") return;`)).toEqual(expect.arrayContaining(["google-maps"]));
    expect(found("const icons = { gmail: mail };")).toEqual(["gmail"]);
    expect(found(`server.startsWith("mcp.todoist")`)).toEqual(expect.arrayContaining(["mcp.todoist"]));
    expect(found(`const css = "apps-gmail";`)).toEqual(["gmail"]);
    expect(found("const googleMaps = 1;")).toEqual(expect.arrayContaining(["google-maps"]));
    expect(found(`if (app.name === "Gmail") return;`)).toEqual(["Gmail"]);
    expect(found("// gmail: Gmail, Google Calendar and Telegram are apps like any other\n/* telegram: too */")).toEqual([]);
    const files = [...uiFiles(UI_APPS), ...UI_RENDERED];
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap((file) => found(readFileSync(file, "utf8")).map((name) => `${relative(UI_APPS, file)}: ${name}`))).toEqual([]);
  });
});

// ——— three apps Tavi knows nothing about ———

const HASH = "c".repeat(64);
const version = (extra: Record<string, unknown> = {}) => ({
  version: "1.0.0",
  reviewState: "approved",
  contentHash: HASH,
  installedAt: NOW,
  tools: [],
  configFields: {},
  runsOwnerCode: true,
  ...extra,
});

const notesTools = [
  { id: "acme.notes.search", effect: "read-only", description: "Search notes" },
  { id: "acme.notes.save", effect: "mutating", description: "Save a note" },
];
const notesApps = {
  abi: "tavi.apps/1",
  apps: [
    {
      id: "acme-notes",
      name: "Acme Notes",
      summary: "Your notes in Acme.",
      icon: "assets/notes.svg",
      category: "notes",
      publisher: "Acme",
      scopes: [],
      tools: { search: { title: "Search notes", says: "Finds notes by their words." }, save: { title: "Save a note" } },
      accountScope: "owner",
    },
  ],
};
const notes = {
  id: "acme.notes",
  kind: "external",
  name: "acme notes",
  description: "",
  enabled: true,
  core: false,
  activeVersion: "1.0.0",
  versions: [version({ tools: notesTools, apps: notesApps })],
  tools: notesTools,
  configFields: {},
  config: {},
  runsOwnerCode: true,
  isolation: "process",
} as unknown as PluginView;

const weatherTools = [{ id: "example.weather.forecast", effect: "read-only", description: "Get the forecast for a city" }];
const weather = {
  id: "example.weather",
  kind: "external",
  name: "Weather",
  description: "Forecasts from a weather service.",
  enabled: false,
  core: false,
  activeVersion: "1.0.0",
  versions: [version({ tools: weatherTools })],
  tools: weatherTools,
  configFields: { apiKey: { type: "credential", required: true, description: "The forecast service's key" } },
  config: {},
  runsOwnerCode: true,
  isolation: "process",
} as unknown as PluginView;

const docsManifest = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "mcp-remote", packages: [] },
  capabilities: [],
  id: "mcp.docs",
  version: "1.0.0",
  name: "docs",
  description: "Team docs over MCP.",
  config: {
    clientId: {
      type: "string",
      required: false,
      description: "A client registered at the server's authorization server (optional: CIMD or registration otherwise)",
    },
    clientSecret: { type: "credential", required: false, description: "That client's secret, if it has one" },
  },
  tools: [],
  provides: [],
  channels: [],
  mcp: {
    abi: "tavi.mcp/1",
    transport: "http",
    url: { value: "https://mcp.docs.example/mcp" },
    auth: "oauth",
    exposure: "auto",
    maxMessageBytes: 1_048_576,
    concurrency: 4,
  },
} as unknown as PluginManifest;
const docs = {
  id: "mcp.docs",
  kind: "mcp",
  name: "docs",
  description: "Team docs over MCP.",
  enabled: true,
  core: false,
  activeVersion: "1.0.0",
  versions: [version({ runsOwnerCode: false, configFields: docsManifest.config })],
  tools: [],
  configFields: docsManifest.config,
  config: {},
  runsOwnerCode: false,
} as unknown as PluginView;
const docsRow: McpServerRow = {
  pluginId: "mcp.docs",
  name: "docs",
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
};
const docsReview = {
  pluginId: "mcp.docs",
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
      pluginId: "mcp.docs",
      version: "1.0.0",
      name: "search_docs",
      toolId: "mcp.docs.search_docs",
      observedDefHash: "a",
      observedDef: { name: "search_docs", inputSchema: { type: "object" } },
      suggestedEffect: "read-only",
      doubtful: false,
      flagged: false,
      state: "approved",
      decision: { effect: "read-only", timeoutMs: 60_000, askTainted: false },
      shown: { name: "search_docs" },
      schema: { form: "json", wrapped: false },
    },
    {
      pluginId: "mcp.docs",
      version: "1.0.0",
      name: "edit_page",
      toolId: "mcp.docs.edit_page",
      observedDefHash: "b",
      observedDef: { name: "edit_page", inputSchema: { type: "object" } },
      suggestedEffect: "mutating",
      doubtful: false,
      flagged: false,
      state: "approved",
      decision: { effect: "mutating", timeoutMs: 60_000, askTainted: true },
      shown: { name: "edit_page" },
      schema: { form: "json", wrapped: false },
    },
  ],
} as unknown as McpReview;

function owner(): AppsContext {
  const views = [notes, weather, docs];
  const meta = new Map<string, string>();
  return {
    mcp: async (payload: McpPayload) => {
      if (payload.action === "list")
        return { ok: true, result: { servers: { enabled: true, workspaceId: "default", servers: [docsRow] } } };
      if (payload.action === "show") return { ok: true, result: { review: docsReview } };
      return { ok: false, error: { code: "UNSUPPORTED", message: "not in this fake" } };
    },
    plugins: async () => ({ ok: true, result: {} }),
    views: async () => views,
    manifestOf: (pluginId) =>
      pluginId === "mcp.docs"
        ? docsManifest
        : pluginId === "acme.notes"
          ? ({ ...docsManifest, id: pluginId, mcp: undefined, config: {}, apps: notesApps } as unknown as PluginManifest)
          : undefined,
    connections: async () => [],
    descriptorOf: () => undefined,
    descriptors: () => [],
    rules: { inForce: async () => [], put: async () => undefined, remove: async () => false },
    getMeta: async (key) => meta.get(key),
    setMeta: async (key, value) => {
      meta.set(key, value);
    },
    workspaceSettings: async () => ({ mcpServers: views.map((view) => view.id), mcpPeople: [] }),
    workspaceIds: () => ["default"],
    credentialRefs: async () => new Set<string>(),
    dataDirectory: "/nonexistent",
    now: () => NOW,
    actor: "operator:ui",
  };
}

async function answered<T>(context: AppsContext, payload: Parameters<typeof appsCommand>[1]): Promise<T> {
  const answer = await appsCommand(context, payload);
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.result as T;
}

describe("three apps Tavi knows nothing about, through the owner", () => {
  it("are projected with their health and tools, and are what the canvas's fixture holds", async () => {
    const context = owner();
    const { apps } = await answered<{ readonly apps: readonly ConnectableApp[] }>(context, { action: "list", workspaceId: "default" });
    const { catalog } = await answered<{ readonly catalog: AppsCatalogAnswer }>(context, {
      action: "catalog",
      workspaceId: "default",
      query: "",
    });
    const byId = new Map(apps.map((app) => [app.appId, app]));
    expect(byId.get("acme-notes")).toMatchObject({
      name: "Acme Notes",
      category: "notes",
      health: "ready",
      icon: `/plugin-ui/acme.notes/${HASH}/assets/notes.svg`,
      source: { kind: "plugin" },
    });
    expect(byId.get("acme-notes")?.tools.map((tool) => [tool.title, tool.effect])).toEqual([
      ["Search notes", "read-only"],
      ["Save a note", "mutating"],
    ]);
    expect(byId.get("example.weather")).toMatchObject({
      name: "Weather",
      health: "not-set-up",
      source: { kind: "plugin" },
      auth: { kind: "api-key" },
    });
    expect(byId.get("example.weather")?.tools.map((tool) => tool.title)).toEqual(["forecast"]);
    const server = apps.find((app) => app.source.pluginIds.includes("mcp.docs"));
    // Never signed in: set up by connecting it.
    expect(server).toMatchObject({ source: { kind: "mcp" }, auth: { kind: "oauth" }, health: "not-set-up" });
    expect(server?.tools.map((tool) => [tool.toolId, tool.effect])).toEqual([
      ["mcp.docs.search_docs", "read-only"],
      ["mcp.docs.edit_page", "mutating"],
    ]);
    // Tavi's own presets are left out: their wording is not what this checks.
    const fixture = { apps, catalog: { ...catalog, sections: catalog.sections.filter((section) => section.section !== "presets") } };
    if (process.env["UPDATE_FIXTURES"] === "1") {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fixture)));
  });
});
