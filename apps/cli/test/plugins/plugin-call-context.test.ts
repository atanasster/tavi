import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATTENDED_TASK_POLICY,
  PluginManifestSchema,
  UNATTENDED_TASK_POLICY,
  type PluginIsolationPort,
  type PluginToolCallContext,
  type PluginVersionRecord,
} from "@tavi/contracts";
import { PluginHost, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/** A plugin tool handler's call context. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

describe("a plugin tool's call context", () => {
  it("names the principal and workspace, and says whether the run is unattended", async () => {
    const directory = directories.create("tavi-plugin-context-");
    const entryPath = join(directory, "index.mjs");
    writeFileSync(
      entryPath,
      "export function register({ registerTool, z }) { registerTool({ name: 'whom', inputSchema: z.object({}), handler: async (_input, _options, context) => context }); }\n",
    );
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.jobs",
      version: "1.0.0",
      name: "Jobs fixture",
      entry: "index.mjs",
      tools: [{ name: "whom", effect: "read-only", description: "Whom", sink: "none" }],
      config: {},
    });
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
    const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "context-test" });
    await host.start();
    try {
      const call = (executionPolicy?: unknown) =>
        tools.get("acme.jobs.whom")?.handler({
          input: {},
          context: { workspaceId: "home", principalId: "ana", runId: "task-1", caller: "test" },
          signal: new AbortController().signal,
          ...(executionPolicy === undefined ? {} : { executionPolicy }),
        } as never);
      expect(await call(UNATTENDED_TASK_POLICY)).toEqual({ principalId: "ana", workspaceId: "home", unattended: true });
      expect(await call(ATTENDED_TASK_POLICY)).toEqual({ principalId: "ana", workspaceId: "home", unattended: false });
      expect(await call()).toEqual({ principalId: "ana", workspaceId: "home", unattended: false });
    } finally {
      await host.stop();
    }
  });

  it("reaches a confined worker's handle with the call", async () => {
    const directory = directories.create("tavi-plugin-context-worker-");
    const manifest = PluginManifestSchema.parse({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.jobs",
      version: "1.0.0",
      name: "Jobs fixture",
      entry: "index.mjs",
      tools: [{ name: "whom", effect: "read-only", description: "Whom", sink: "none" }],
      config: {},
    });
    const record: PluginVersionRecord = {
      pluginId: "acme.jobs",
      version: "1.0.0",
      contentHash: "a".repeat(64),
      manifest,
      reviewState: "approved",
      installedBy: "test",
      installedAt: "2026-10-16T00:00:00.000Z",
      isolation: "process",
    };
    const seen: (PluginToolCallContext | undefined)[] = [];
    // A worker as the owner sees it, recording what each call carried.
    const isolation: PluginIsolationPort = {
      start: async () => ({
        registrations: {
          tools: [{ name: "whom", inputJsonSchema: { type: "object" }, beforeCall: false }],
          hooks: [],
          commands: [],
          signalSources: [],
        },
        callTool: async (_name, _input, _signal, _effect, context) => {
          seen.push(context);
          return "ok";
        },
        beforeCall: async () => undefined,
        collect: async () => [],
        hook: async () => undefined,
        command: async () => ({ text: "" }),
        status: () => ({ state: "running", restarts: 0 }),
        stop: async () => undefined,
      }),
    };
    const tools = new ToolRegistry();
    const load = await loadExternalPlugins(
      [{ ok: true, record, directory, entryPath: join(directory, "index.mjs"), config: {}, instances: [] }],
      tools,
      silentLog,
      async () => null,
      { bind: () => async () => {} },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      isolation,
    );
    const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "context-worker-test" });
    await host.start();
    try {
      expect(
        await tools.get("acme.jobs.whom")?.handler({
          input: {},
          context: { workspaceId: "home", principalId: "ana", runId: "task-1", caller: "test" },
          signal: new AbortController().signal,
          executionPolicy: UNATTENDED_TASK_POLICY,
        } as never),
      ).toBe("ok");
      expect(seen).toEqual([{ principalId: "ana", workspaceId: "home", unattended: true }]);
    } finally {
      await host.stop();
    }
  });
});
