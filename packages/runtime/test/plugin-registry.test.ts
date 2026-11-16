import { PluginRegistry } from "../src/plugins/registry.js";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_PLUGIN_HOOK_EVENTS, MAX_PLUGIN_HOOK_FAILURES, type BuiltinPluginInfo } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * The plugin registry. The properties under test: installing never runs
 * code and pins the bytes by hash; a version is immutable; only an approved
 * version can be enabled; core built-ins cannot be disabled; settings follow the
 * manifest's types; and a snapshot changed on disk after approval never runs.
 */

const directories = temporaryDirectories();
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

const BUILTINS: readonly BuiltinPluginInfo[] = [
  { id: "tavi.persistence", description: "store", core: true },
  { id: "tavi.schedules", description: "schedules", core: false },
];

function temp(): string {
  return directories.create("tavi-plugins-");
}

function registry(): { readonly registry: PluginRegistry; readonly dataDirectory: string } {
  const dataDirectory = temp();
  const store = new SqliteStore({ databasePath: join(dataDirectory, "tavi.sqlite"), artifactsDirectory: join(dataDirectory, "artifacts") });
  stores.push(store);
  let tick = 0;
  return {
    dataDirectory,
    registry: new PluginRegistry({
      repository: store.asPort().repositories.plugins,
      directory: join(dataDirectory, "plugins"),
      builtins: BUILTINS,
      now: () => new Date(Date.UTC(2026, 8, 26, 12, 0, tick++)).toISOString(),
    }),
  };
}

function pluginSource(overrides: Record<string, unknown> = {}, code = "export function register() {}\n"): string {
  const directory = temp();
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.weather",
      version: "1.0.0",
      name: "Weather",
      description: "Forecasts",
      entry: "index.mjs",
      tools: [{ name: "forecast", effect: "external", description: "Get a forecast" }],
      config: { city: { type: "string", required: true }, days: { type: "number" }, metric: { type: "boolean" } },
      ...overrides,
    }),
  );
  writeFileSync(join(directory, "index.mjs"), code);
  return directory;
}

describe("plugin registry", () => {
  it("checks the complete prepared module closure offline", () => {
    const { registry: plugins } = registry();
    const source = pluginSource({}, 'import { value } from "./dependency.mjs"; export function register() { throw new Error(value); }');
    expect(() => plugins.install(source, "operator")).toThrow(/missing/);
    writeFileSync(join(source, "dependency.mjs"), 'export const value = "never executed";');
    expect(plugins.install(source, "operator").created).toBe(true);
    for (const code of [
      'import "unbundled-package";',
      'import "../outside.mjs";',
      "export function register() { return import(globalThis.path); }",
      'import "@tavi/contracts";',
    ])
      expect(() => plugins.install(pluginSource({}, code), "operator")).toThrow(/artifact|bundle|computed/);
    // A template literal names a pattern of files, not one; a concatenation names none.
    for (const code of [
      "export function register(name) { return import(`./locales/${name}.mjs`); }",
      'export function register(name) { return import("./" + name + ".mjs"); }',
    ])
      expect(() => plugins.install(pluginSource({}, code), "operator")).toThrow(/computed/);
    expect(
      plugins.install(pluginSource({ version: "1.0.1" }, "export const here = import.meta.url; export function register() {}"), "operator")
        .created,
    ).toBe(true);
  });

  it("refuses CommonJS entries and dependencies that escape ESM closure inspection", () => {
    const { registry: plugins } = registry();
    const source = pluginSource({}, 'import "./dependency.cjs"; export function register() {}');
    writeFileSync(join(source, "dependency.cjs"), 'module.exports = require("unbundled-package");');
    expect(() => plugins.install(source, "operator")).toThrow(/prepared .mjs/);
    const commonjs = pluginSource({ entry: "entry.js" });
    writeFileSync(join(commonjs, "entry.js"), 'module.exports = require("unbundled-package");');
    expect(() => plugins.install(commonjs, "operator")).toThrow(/entry/);
  });

  it("validates account instances offline and persists them through enable and disable", () => {
    const { registry: plugins } = registry();
    const source = pluginSource({
      capabilities: [
        {
          id: "search",
          kind: "search",
          settings: { endpoint: { type: "string", required: true, description: "Endpoint" } },
          credentials: ["key"],
          disclosure: "Search terms",
        },
      ],
    });
    plugins.install(source, "operator");
    const instance = {
      id: "work",
      factory: "search",
      workspaceId: "workspace",
      accountId: "account",
      settings: { endpoint: "https://api.example" },
      credentials: { key: "plugins.acme.weather.work.key" },
    };
    expect(() =>
      plugins.configure("acme.weather", {}, [], "operator", undefined, [
        { ...instance, credentials: { key: "plugins.acme.weather.other.key" } },
      ]),
    ).toThrow(/instance namespace/);
    expect(() => plugins.configure("acme.weather", {}, [], "operator", undefined, [{ ...instance, settings: {} }])).toThrow(
      /endpoint is required/,
    );
    expect(() => plugins.configure("acme.weather", {}, [], "operator", undefined, [instance, instance])).toThrow(/duplicate instance/);
    plugins.configure("acme.weather", { city: "Sofia" }, [], "operator", undefined, [instance]);
    plugins.decide("acme.weather", "1.0.0", "approved", "operator");
    expect(plugins.enable("acme.weather", "operator").instances).toEqual([instance]);
    expect(plugins.resolveEnabled()[0]).toMatchObject({ instances: [instance] });
    expect(plugins.disable("acme.weather", "operator").instances).toEqual([instance]);
    expect(plugins.show("acme.weather").instances).toEqual([instance]);
  });

  it("installs a proposed, hash-pinned snapshot; the same bytes again are a no-op; changed bytes need a new version", () => {
    const { registry: plugins, dataDirectory } = registry();
    const source = pluginSource();
    const installed = plugins.install(source, "operator:cli");
    expect(installed.created).toBe(true);
    expect(installed.record.reviewState).toBe("proposed");
    expect(installed.record.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(dataDirectory, "plugins", "acme.weather", "1.0.0", "index.mjs"))).toBe(true);
    expect(plugins.install(source, "operator:cli").created).toBe(false);
    appendFileSync(join(source, "index.mjs"), "// changed\n");
    expect(() => plugins.install(source, "operator:cli")).toThrow(/immutable/);
    const [view] = plugins.list().filter((plugin) => plugin.kind === "external");
    expect(view).toMatchObject({
      id: "acme.weather",
      name: "Weather",
      enabled: false,
      tools: [{ id: "acme.weather.forecast", effect: "external" }],
    });
  });

  it("shows a version's declared hooks, with what each can read, on the version and the plugin", () => {
    const { registry: plugins } = registry();
    plugins.install(
      pluginSource({
        mods: {
          abi: "tavi.mods/1",
          hooks: [{ event: "tool.check", match: { tools: ["sandbox.run"] }, disclosure: "Asks before deleting files." }],
        },
      }),
      "operator:cli",
    );
    const hook = {
      event: "tool.check",
      match: { tools: ["sandbox.run"] },
      onFailure: "ask",
      disclosure: "Asks before deleting files.",
      reads: "Sees the input of `sandbox.run`, and can refuse the call. It sees this in every workspace.",
    };
    const view = plugins.show("acme.weather");
    expect(view.mods).toEqual([hook]);
    expect(view.versions[0]?.mods).toEqual([hook]);
  });

  it("shows each tool's output trust: silent is untrusted, an explicit false trusted", () => {
    const { registry: plugins } = registry();
    const tools = [
      { name: "forecast", effect: "external", description: "Get a forecast" },
      { name: "own", effect: "read-only", description: "Its own data", untrustedOutput: false },
    ];
    plugins.install(pluginSource({ tools }), "operator:cli");
    // Awaiting review, the silent tool is untrusted (no note) and the explicit false is shown.
    expect(plugins.show("acme.weather").versions[0]?.tools).toEqual([
      { id: "acme.weather.forecast", effect: "external", description: "Get a forecast" },
      { id: "acme.weather.own", effect: "read-only", description: "Its own data", output: "trusted" },
    ]);
    // Approved, the silent tool stays untrusted, and the approval is dated by the clock.
    expect(plugins.decide("acme.weather", "1.0.0", "approved", "operator").reviewedAt).toMatch(/^2026-09-26T12:00:/);
    expect(plugins.show("acme.weather").versions[0]?.tools.map((tool) => tool.output)).toEqual([undefined, "trusted"]);
  });

  it("finds the newest rows of one kind through the kind index, not by walking every row of the plugin", () => {
    registry();
    const store = stores.at(-1);
    if (store === undefined) throw new Error("no store");
    const plan = store.handle
      .prepare(
        "EXPLAIN QUERY PLAN SELECT event_seq FROM tavi_plugin_hook_events WHERE plugin_id = ? AND kind = ? ORDER BY event_seq DESC LIMIT 1 OFFSET ?",
      )
      .all("acme.weather", "failure", MAX_PLUGIN_HOOK_FAILURES) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain("tavi_plugin_hook_events_kind_idx");
  });

  it("keeps a plugin's newest hook events, and forgets them when the plugin is removed", () => {
    const { registry: plugins } = registry();
    const store = stores.at(-1);
    if (store === undefined) throw new Error("no store");
    const repository = store.asPort().repositories.plugins;
    plugins.install(pluginSource(), "operator:cli");
    // Each kind within its own bound: the failures are pruned at theirs, and do not prune a decision.
    repository.appendHookEvent({
      pluginId: "acme.weather",
      kind: "decision",
      event: "tool.check",
      tool: "sandbox.run",
      ruleId: "mod:acme.weather",
      detail: "allow → ask",
      at: "2026-10-09T00:00:00.000Z",
    });
    for (let index = 0; index < MAX_PLUGIN_HOOK_FAILURES + 2; index += 1) {
      repository.appendHookEvent({
        pluginId: "acme.weather",
        kind: "failure",
        event: "tool.check",
        tool: "sandbox.run",
        detail: `throw: ${index}`,
        at: "2026-10-09T00:00:00.000Z",
      });
    }
    const activity = repository.hookActivity("acme.weather", 3);
    expect(activity).toMatchObject({ decisions: 1, failures: MAX_PLUGIN_HOOK_FAILURES, pruned: true });
    // Pruned means rows were removed: another plugin with exactly its bound kept is not.
    for (let index = 0; index < MAX_PLUGIN_HOOK_FAILURES; index += 1) {
      repository.appendHookEvent({
        pluginId: "acme.exact",
        kind: "failure",
        event: "tool.check",
        detail: `throw: ${index}`,
        at: "2026-10-09T00:00:00.000Z",
      });
    }
    expect(repository.hookActivity("acme.exact", 0)).toMatchObject({ failures: MAX_PLUGIN_HOOK_FAILURES });
    expect(repository.hookActivity("acme.exact", 0)).not.toHaveProperty("pruned");
    expect(activity.recent.map((event) => event.detail)).toEqual([
      `throw: ${MAX_PLUGIN_HOOK_FAILURES + 1}`,
      `throw: ${MAX_PLUGIN_HOOK_FAILURES}`,
      `throw: ${MAX_PLUGIN_HOOK_FAILURES - 1}`,
    ]);
    expect(repository.listHookEvents("acme.weather", 1000)).toHaveLength(MAX_PLUGIN_HOOK_EVENTS);
    expect(repository.hookActivity("acme.weather", 0).decisions).toBe(1);
    plugins.remove("acme.weather");
    expect(repository.listHookEvents("acme.weather", 10)).toEqual([]);
  });

  it("refuses relative paths, invalid manifests, the reserved namespace, missing entries and symbolic links", () => {
    const { registry: plugins } = registry();
    expect(() => plugins.install("relative/path", "operator:cli")).toThrow(/absolute/);
    expect(() => plugins.install(pluginSource({ version: "one" }), "operator:cli")).toThrow(/semantic versioning/);
    expect(() => plugins.install(pluginSource({ id: "tavi.evil" }), "operator:cli")).toThrow(/reserved/);
    expect(() => plugins.install(pluginSource({ entry: "../escape.mjs" }), "operator:cli")).toThrow(/entry/);
    expect(() => plugins.install(pluginSource({ entry: "missing.mjs" }), "operator:cli")).toThrow(/does not exist/);
    const linked = pluginSource();
    symlinkSync("/etc/hosts", join(linked, "hosts"));
    expect(() => plugins.install(linked, "operator:cli")).toThrow(/symbolic link/);
  });

  it("enables only an approved version, and only once required settings are present, typed by the manifest", () => {
    const { registry: plugins } = registry();
    plugins.install(pluginSource(), "operator:cli");
    expect(() => plugins.enable("acme.weather", "operator:cli")).toThrow(/no approved version/);
    plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli");
    expect(() => plugins.enable("acme.weather", "operator:cli")).toThrow(/city is required/);
    expect(() => plugins.configure("acme.weather", { colour: "red" }, [], "operator:cli")).toThrow(/not a setting/);
    expect(() => plugins.configure("acme.weather", { days: "soon" }, [], "operator:cli")).toThrow(/days must be a number/);
    const configured = plugins.configure("acme.weather", { city: "Sofia", days: "3", metric: "true" }, [], "operator:cli");
    expect(configured.config).toEqual({ city: "Sofia", days: 3, metric: true });
    const enabled = plugins.enable("acme.weather", "operator:cli");
    expect(enabled).toMatchObject({ enabled: true, activeVersion: "1.0.0" });
    const [resolved] = plugins.resolveEnabled();
    expect(resolved).toMatchObject({ ok: true, config: { city: "Sofia", days: 3, metric: true } });
    // A required setting cannot be cleared from a plugin that runs.
    expect(() => plugins.configure("acme.weather", {}, ["city"], "operator:cli")).toThrow(/city is required/);
    // Approving again is a no-op; revoking trust is a decision, and it stops the version that runs.
    expect(plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli").reviewState).toBe("approved");
    plugins.decide("acme.weather", "1.0.0", "rejected", "operator:cli");
    expect(plugins.show("acme.weather").enabled).toBe(false);
    expect(plugins.resolveEnabled()).toEqual([]);
    // A rejection is final: trusting it again needs a new version.
    expect(() => plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli")).toThrow(/already rejected/);
  });

  it("approves an approved version again only to change where it runs, recording who and keeping when it was reviewed", () => {
    const { registry: plugins } = registry();
    plugins.install(pluginSource(), "operator:cli");
    // Approved before workers: no isolation recorded, so it runs in-process.
    const before = plugins.decide("acme.weather", "1.0.0", "approved", "operator");
    expect(before.isolation).toBeUndefined();
    const worker = plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli", {});
    expect(worker).toMatchObject({
      reviewState: "approved",
      isolation: "process",
      reviewedBy: "operator:cli",
      reviewedAt: before.reviewedAt,
    });
    expect(plugins.show("acme.weather").versions[0]).toMatchObject({ isolation: "process" });
    // The same choice again changes nothing; another one is recorded.
    expect(plugins.decide("acme.weather", "1.0.0", "approved", "operator:canvas", {})).toMatchObject({
      isolation: "process",
      reviewedBy: "operator:cli",
    });
    expect(plugins.decide("acme.weather", "1.0.0", "approved", "operator:canvas", { inProcess: true })).toMatchObject({
      isolation: "in-process",
      reviewedBy: "operator:canvas",
    });
    // Without a choice (tests, internals) nothing is recorded, as before.
    expect(plugins.decide("acme.weather", "1.0.0", "approved", "operator")).toMatchObject({
      isolation: "in-process",
      reviewedBy: "operator:canvas",
    });
  });

  it("never resolves a snapshot that changed on disk after approval", () => {
    const { registry: plugins, dataDirectory } = registry();
    plugins.install(pluginSource(), "operator:cli");
    plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli");
    plugins.configure("acme.weather", { city: "Sofia" }, [], "operator:cli");
    plugins.enable("acme.weather", "operator:cli");
    writeFileSync(
      join(dataDirectory, "plugins", "acme.weather", "1.0.0", "index.mjs"),
      "export function register() { globalThis.pwned = true; }\n",
    );
    const [resolved] = plugins.resolveEnabled();
    expect(resolved).toMatchObject({ ok: false, pluginId: "acme.weather" });
    expect(resolved?.ok === false ? resolved.error : "").toMatch(/no longer matches its approved hash/);
  });

  it("keeps core built-ins running, lets the others be disabled, and removes only disabled external plugins", () => {
    const { registry: plugins, dataDirectory } = registry();
    expect(() => plugins.disable("tavi.persistence", "operator:cli")).toThrow(/cannot be disabled/);
    plugins.disable("tavi.schedules", "operator:ui");
    expect([...plugins.disabledBuiltins()]).toEqual(["tavi.schedules"]);
    plugins.enable("tavi.schedules", "operator:ui");
    expect([...plugins.disabledBuiltins()]).toEqual([]);
    expect(() => plugins.remove("tavi.schedules")).toThrow(/built in/);

    plugins.install(pluginSource(), "operator:cli");
    plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli");
    plugins.configure("acme.weather", { city: "Sofia" }, [], "operator:cli");
    plugins.enable("acme.weather", "operator:cli");
    expect(() => plugins.remove("acme.weather")).toThrow(/disable it first/);
    plugins.disable("acme.weather", "operator:cli");
    expect(plugins.remove("acme.weather").removed).toEqual(["1.0.0"]);
    expect(existsSync(join(dataDirectory, "plugins", "acme.weather"))).toBe(false);
    expect(plugins.list().some((plugin) => plugin.id === "acme.weather")).toBe(false);
  });

  it("keeps a plugin's state while a version remains and clears it with the last one", () => {
    const { registry: plugins, dataDirectory } = registry();
    const store = stores.at(-1)!;
    plugins.install(pluginSource(), "operator:cli");
    plugins.install(pluginSource({ version: "1.1.0" }), "operator:cli");
    const state = store.asPort().repositories.plugins;
    state.putPluginState("acme.weather", "settings", { city: "Sofia" }, "2026-10-07T12:00:00.000Z");

    plugins.remove("acme.weather", "1.0.0");
    expect(state.loadPluginState("acme.weather")).toEqual({ settings: { city: "Sofia" } });
    plugins.remove("acme.weather", "1.1.0");
    expect(state.loadPluginState("acme.weather")).toEqual({});
    expect(existsSync(join(dataDirectory, "plugins", "acme.weather"))).toBe(false);
  });

  it("rejecting the version that runs stops it, and a second version is enabled explicitly", () => {
    const { registry: plugins } = registry();
    plugins.install(pluginSource(), "operator:cli");
    const second = pluginSource({ version: "1.1.0" });
    mkdirSync(join(second, "lib"));
    writeFileSync(join(second, "lib", "helper.mjs"), "export const helper = 1;\n");
    plugins.install(second, "operator:cli");
    plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli");
    plugins.configure("acme.weather", { city: "Sofia" }, [], "operator:cli");
    expect(plugins.enable("acme.weather", "operator:cli").activeVersion).toBe("1.0.0");
    expect(() => plugins.enable("acme.weather", "operator:cli", "1.1.0")).toThrow(/proposed/);
    plugins.decide("acme.weather", "1.1.0", "approved", "operator:cli");
    expect(plugins.enable("acme.weather", "operator:cli", "1.1.0").activeVersion).toBe("1.1.0");
    plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli");
    const view = plugins.show("acme.weather");
    expect(view.versions.map((version) => version.version)).toEqual(["1.0.0", "1.1.0"]);
  });
});

describe("plugin registry hardening", () => {
  it("prepares an upgrade's new settings against the version that will run, and drops the old version's", () => {
    const { registry: plugins } = registry();
    plugins.install(pluginSource(), "operator:cli");
    plugins.decide("acme.weather", "1.0.0", "approved", "operator:cli");
    plugins.configure("acme.weather", { city: "Sofia" }, [], "operator:cli");
    plugins.enable("acme.weather", "operator:cli");
    plugins.install(pluginSource({ version: "2.0.0", config: { apiKey: { type: "string", required: true } } }), "operator:cli");
    plugins.decide("acme.weather", "2.0.0", "approved", "operator:cli");
    // Against the running version, apiKey is unknown; against 2.0.0 it is the setting to prepare.
    expect(() => plugins.configure("acme.weather", { apiKey: "k" }, [], "operator:cli")).toThrow(/not a setting/);
    plugins.configure("acme.weather", { apiKey: "k" }, [], "operator:cli", "2.0.0");
    const upgraded = plugins.enable("acme.weather", "operator:cli", "2.0.0");
    expect(upgraded).toMatchObject({ activeVersion: "2.0.0", config: { apiKey: "k" } });
    expect(upgraded.config).not.toHaveProperty("city");
    // Each version's own declarations are in the view, for its review.
    expect(plugins.show("acme.weather").versions.map((version) => Object.keys(version.configFields))).toEqual([
      ["city", "days", "metric"],
      ["apiKey"],
    ]);
  });

  it("bounds versions to lower-case prereleases of 32 characters, and tool ids to 64", () => {
    const { registry: plugins } = registry();
    expect(() => plugins.install(pluginSource({ version: "1.0.0-RC1" }), "operator:cli")).toThrow(/lower case/);
    expect(() => plugins.install(pluginSource({ version: `1.0.0-${"a".repeat(30)}` }), "operator:cli")).toThrow();
    expect(() =>
      plugins.install(pluginSource({ tools: [{ name: "x".repeat(60), effect: "read-only", description: "long" }] }), "operator:cli"),
    ).toThrow(/longer than 64/);
    expect(plugins.install(pluginSource({ version: "1.0.0-rc.1" }), "operator:cli").created).toBe(true);
  });

  it("refuses FIFOs and deep trees, and stages outside every version's directory", () => {
    const { registry: plugins, dataDirectory } = registry();
    const fifo = pluginSource();
    execFileSync("mkfifo", [join(fifo, "pipe")]);
    expect(() => plugins.install(fifo, "operator:cli")).toThrow(/special file/);
    const deep = pluginSource();
    let path = deep;
    for (let depth = 0; depth < 34; depth += 1) {
      path = join(path, "d");
      mkdirSync(path);
    }
    expect(() => plugins.install(deep, "operator:cli")).toThrow(/depth/);
    plugins.install(pluginSource(), "operator:cli");
    expect(readdirSync(join(dataDirectory, "plugins", "acme.weather"))).toEqual(["1.0.0"]);
    expect(readdirSync(join(dataDirectory, "plugins", ".staging"))).toEqual([]);
  });
});

describe("credential settings", () => {
  it("accept only a reference in the plugin's own credential namespace, never a value or another's key", () => {
    const { registry: plugins } = registry();
    plugins.install(pluginSource({ config: { apiKey: { type: "credential", required: true } } }), "operator:cli");
    for (const bad of ["sk-live-secret value", "openai.apiKey", "plugins.other.key", "plugins.acme.weather."]) {
      expect(() => plugins.configure("acme.weather", { apiKey: bad }, [], "operator:ui"), bad).toThrow(
        /credential reference under plugins\.acme\.weather\./,
      );
    }
    expect(plugins.configure("acme.weather", { apiKey: "plugins.acme.weather.key" }, [], "operator:ui").config).toEqual({
      apiKey: "plugins.acme.weather.key",
    });
  });
});

describe("UI plugins", () => {
  const ui = {
    abi: "tavi.ui/1",
    contributions: [
      {
        id: "live",
        role: "browser-view",
        title: "Browser",
        icon: "ui/icon.svg",
        document: "ui/live.html",
        channels: ["browser.live"],
        placements: [
          { slot: "chat.panel.top", show: "while-active", height: { min: 140, default: 220, max: 480 } },
          { slot: "chat.panel.tab" },
        ],
        disclosure: "Receives live images of the pages the agent browses, and the address of each page.",
      },
    ],
  };

  /** A UI-only plugin: no entry, browser files in `.js`. */
  function uiSource(
    files: Record<string, string> = {
      "ui/live.html": '<!doctype html><script src="live.js"></script>',
      "ui/live.js": "import('./x.js');",
      "ui/icon.svg": "<svg/>",
    },
  ): string {
    const directory = temp();
    writeFileSync(
      join(directory, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.browserview",
        version: "1.0.0",
        name: "Acme view",
        ui,
      }),
    );
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
    return directory;
  }

  it("installs a plugin with no entry, holding its .js files to no module rules but every file to the hash, and never resolves it for import", () => {
    const { registry: plugins } = registry();
    const { record } = plugins.install(uiSource(), "operator");
    expect(record.manifest.entry).toBeUndefined();
    expect(record.manifest.ui?.contributions[0]?.channels).toEqual(["browser.live"]);
    plugins.decide("acme.browserview", "1.0.0", "approved", "operator");
    plugins.enable("acme.browserview", "operator");
    // Nothing for composition to import: a UI-only plugin runs no owner code.
    expect(plugins.resolveEnabled()).toEqual([]);
    const view = plugins.show("acme.browserview");
    expect(view).toMatchObject({ uiOnly: true, ui: { abi: "tavi.ui/1" } });
    expect(view.versions[0]).toMatchObject({ uiOnly: true, ui: { contributions: [{ id: "live" }] } });
  });

  it("lists an MCP server's plugin as kind mcp that runs no owner code, never as UI-only, and never resolves it for import", () => {
    const { registry: plugins } = registry();
    const directory = temp();
    writeFileSync(
      join(directory, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "mcp-remote", packages: [] },
        id: "mcp.docs",
        version: "1.0.0",
        name: "Docs",
        mcp: { abi: "tavi.mcp/1", transport: "http", url: { value: "https://docs.example/mcp" } },
      }),
    );
    plugins.install(directory, "operator");
    plugins.decide("mcp.docs", "1.0.0", "approved", "operator");
    plugins.enable("mcp.docs", "operator");
    expect(plugins.resolveEnabled()).toEqual([]);
    const view = plugins.show("mcp.docs");
    expect(view).toMatchObject({
      kind: "mcp",
      runsOwnerCode: false,
      mcp: { transport: "http", url: { value: "https://docs.example/mcp" } },
    });
    expect(view.uiOnly).toBeUndefined();
    expect(view.versions[0]).toMatchObject({ runsOwnerCode: false, mcp: { auth: "none" } });
    expect(view.versions[0]?.uiOnly).toBeUndefined();
    // A plugin with an entry says outright that it runs owner code.
    plugins.install(pluginSource(), "operator");
    expect(plugins.show("acme.weather")).toMatchObject({ kind: "external", runsOwnerCode: true });
  });

  it("shows each version's heartbeat provider and signal sources, for its review", () => {
    const { registry: plugins } = registry();
    const directory = temp();
    writeFileSync(
      join(directory, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.watch",
        version: "1.0.0",
        name: "Watch",
        entry: "index.mjs",
        provides: ["heartbeat", "heartbeat-signals"],
        heartbeat: { abi: "tavi.heartbeat/1", receives: ["signals"] },
        heartbeatSignals: { abi: "tavi.heartbeat/1", sources: ["queue"] },
      }),
    );
    writeFileSync(join(directory, "index.mjs"), "export function register() {}\n");
    plugins.install(directory, "operator");
    expect(plugins.show("acme.watch").versions[0]).toMatchObject({
      heartbeat: { receives: ["signals"] },
      heartbeatSignals: { sources: ["queue"] },
    });
  });

  it("shows each version's memory provider, for its review", () => {
    const { registry: plugins } = registry();
    const directory = temp();
    writeFileSync(
      join(directory, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.recall",
        version: "1.0.0",
        name: "Recall",
        entry: "index.mjs",
        provides: ["memory"],
        memory: { abi: "tavi.memory/1", capabilities: ["recall"], index: "host", receives: ["records"] },
      }),
    );
    writeFileSync(join(directory, "index.mjs"), "export function register() {}\n");
    plugins.install(directory, "operator");
    expect(plugins.show("acme.recall").versions[0]).toMatchObject({
      memory: { abi: "tavi.memory/1", capabilities: ["recall"], index: "host", receives: ["records"] },
    });
    // Without its declaration, or with another contract's, a memory provider is refused before its code runs.
    const bare = temp();
    writeFileSync(
      join(bare, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.bare",
        version: "1.0.0",
        name: "Bare",
        entry: "index.mjs",
        provides: ["memory"],
      }),
    );
    writeFileSync(join(bare, "index.mjs"), "export function register() {}\n");
    expect(() => plugins.install(bare, "operator")).toThrow(/memory provider needs both/);
    const wrong = temp();
    writeFileSync(
      join(wrong, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.wrong",
        version: "1.0.0",
        name: "Wrong",
        entry: "index.mjs",
        provides: ["memory"],
        memory: { abi: "tavi.memory/2", capabilities: ["recall"], index: "host" },
      }),
    );
    writeFileSync(join(wrong, "index.mjs"), "export function register() {}\n");
    expect(() => plugins.install(wrong, "operator")).toThrow();
  });

  it("refuses a ui file the manifest names but the plugin lacks, and a manifest with neither entry nor ui", () => {
    const { registry: plugins } = registry();
    expect(() => plugins.install(uiSource({ "ui/live.html": "<!doctype html>" }), "operator")).toThrow(
      /ui file ui\/icon.svg does not exist/,
    );
    expect(() => plugins.install(pluginSource({ entry: undefined, tools: [] }), "operator")).toThrow(/entry is required unless/);
    expect(() => plugins.install(pluginSource({ entry: undefined, ui }), "operator")).toThrow(/need an entry module/);
  });

  it("refuses an app icon the apps block names but the plugin lacks, and lists the block on its version", () => {
    const { registry: plugins } = registry();
    const apps = { abi: "tavi.apps/1", apps: [{ id: "acme-weather", name: "Weather", icon: "assets/weather.svg" }] };
    expect(() => plugins.install(pluginSource({ apps }), "operator")).toThrow(/app icon assets\/weather.svg does not exist/);
    const source = pluginSource({ apps });
    mkdirSync(join(source, "assets"));
    writeFileSync(join(source, "assets", "weather.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    plugins.install(source, "operator");
    expect(plugins.show("acme.weather").versions[0]?.apps?.apps[0]).toMatchObject({ id: "acme-weather", icon: "assets/weather.svg" });
  });

  it("shows a built-in's own ui", () => {
    const dataDirectory = temp();
    const store = new SqliteStore({
      databasePath: join(dataDirectory, "tavi.sqlite"),
      artifactsDirectory: join(dataDirectory, "artifacts"),
    });
    stores.push(store);
    const plugins = new PluginRegistry({
      repository: store.asPort().repositories.plugins,
      directory: join(dataDirectory, "plugins"),
      builtins: [{ id: "tavi.browserview", description: "The live browser view.", core: false, uiOnly: true, ui: ui as never }],
    });
    expect(plugins.show("tavi.browserview")).toMatchObject({
      kind: "builtin",
      uiOnly: true,
      ui: { contributions: [{ id: "live", role: "browser-view" }] },
    });
  });
});
