import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, pluginToolViews, type PluginVersionRecord } from "@tavi/contracts";
import { PluginHost, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/** A plugin tool's declared sink: checked in the manifest, carried to the gate. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const manifestOf = (tools: readonly Record<string, unknown>[]) => ({
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.jobs",
  version: "1.0.0",
  name: "Jobs fixture",
  entry: "index.mjs",
  tools,
  config: {},
});

describe("a manifest tool's sink", () => {
  it("is one of network, search, persist or none, and absent by default", () => {
    const parsed = PluginManifestSchema.parse(
      manifestOf([
        { name: "search", effect: "read-only", description: "Search", sink: "search" },
        { name: "track", effect: "mutating", description: "Track", sink: "persist" },
        { name: "match", effect: "read-only", description: "Match", sink: "none" },
        { name: "plain", effect: "external", description: "Plain" },
      ]),
    );
    expect(parsed.tools.map((tool) => tool.sink)).toEqual(["search", "persist", "none", undefined]);
    expect(
      PluginManifestSchema.safeParse(manifestOf([{ name: "x", effect: "read-only", description: "x", sink: "message" }])).success,
    ).toBe(false);
  });

  it("refuses persist on a tool that is not mutating, and none on one that is not read-only", () => {
    const persist = PluginManifestSchema.safeParse(manifestOf([{ name: "x", effect: "read-only", description: "x", sink: "persist" }]));
    expect(persist.success).toBe(false);
    expect(persist.error?.issues[0]?.message).toContain('only a mutating tool may declare sink "persist"');
    const none = PluginManifestSchema.safeParse(manifestOf([{ name: "y", effect: "mutating", description: "y", sink: "none" }]));
    expect(none.success).toBe(false);
    expect(none.error?.issues[0]?.message).toContain('only a read-only tool may declare sink "none"');
  });

  it("is in the tool's listing when declared", () => {
    const manifest = PluginManifestSchema.parse(
      manifestOf([
        { name: "match", effect: "read-only", description: "Match", sink: "none" },
        { name: "plain", effect: "read-only", description: "Plain" },
      ]),
    );
    const views = pluginToolViews({ pluginId: "acme.jobs", manifest });
    expect(views.map((view) => view.sink)).toEqual(["none", undefined]);
  });

  it("reaches the registry as declared, a network sink with urlOnly false, and the external default when silent", async () => {
    const directory = directories.create("tavi-plugin-sink-");
    const entryPath = join(directory, "index.mjs");
    writeFileSync(
      entryPath,
      "export function register({ registerTool, z }) { for (const name of ['search', 'track', 'match', 'fetchit', 'plain']) registerTool({ name, inputSchema: z.object({}), handler: async () => name }); }\n",
    );
    const manifest = PluginManifestSchema.parse(
      manifestOf([
        { name: "search", effect: "read-only", description: "Search", sink: "search" },
        { name: "track", effect: "mutating", description: "Track", sink: "persist" },
        { name: "match", effect: "read-only", description: "Match", sink: "none" },
        { name: "fetchit", effect: "read-only", description: "Fetch", sink: "network" },
        { name: "plain", effect: "read-only", description: "Plain" },
      ]),
    );
    const record: PluginVersionRecord = {
      pluginId: "acme.jobs",
      version: "1.0.0",
      contentHash: "a".repeat(64),
      manifest,
      reviewState: "approved",
      installedBy: "test",
      installedAt: "2026-10-16T00:00:00.000Z",
    };
    const tools = new ToolRegistry();
    const load = await loadExternalPlugins(
      [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
      tools,
      silentLog,
      async () => null,
      { bind: () => async () => {} },
    );
    const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "sink-test" });
    await host.start();
    try {
      const sinkOf = (name: string) => {
        const tool = tools.get(`acme.jobs.${name}`);
        return { sink: tool?.sink, urlOnly: tool?.urlOnly };
      };
      expect(sinkOf("search")).toEqual({ sink: "search", urlOnly: undefined });
      expect(sinkOf("track")).toEqual({ sink: "persist", urlOnly: undefined });
      expect(sinkOf("match")).toEqual({ sink: "none", urlOnly: undefined });
      expect(sinkOf("fetchit")).toEqual({ sink: "network", urlOnly: false });
      expect(sinkOf("plain")).toEqual({ sink: "network", urlOnly: false });
    } finally {
      await host.stop();
    }
  });
});
