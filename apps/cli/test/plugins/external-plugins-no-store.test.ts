import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, type PluginVersionRecord } from "@tavi/contracts";
import { ToolRegistry, PluginHost } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, expect, it } from "vitest";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/** `context.state` without a persistence service fails closed: a read or a write is refused, never dropped. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it("refuses state reads and writes when the host has no persistence service", async () => {
  const directory = directories.create("tavi-plugin-no-store-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(
    entryPath,
    `export function register({ registerTool, z, state }) {
  const outcome = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
  registerTool({ name: "probe", inputSchema: z.object({}), handler: async () => JSON.stringify({ load: await outcome(() => state.load()), put: await outcome(() => state.put("settings", { a: 1 })) }) });
}
`,
  );
  const manifest = PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.nostore",
    version: "1.0.0",
    name: "No store",
    entry: "index.mjs",
    tools: [{ name: "probe", effect: "read-only", description: "Try the state store" }],
    config: {},
  });
  const record: PluginVersionRecord = {
    pluginId: "acme.nostore",
    version: "1.0.0",
    contentHash: "a".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-07T00:00:00.000Z",
  };
  const tools = new ToolRegistry();
  const load = await loadExternalPlugins(
    [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
    tools,
    silentLog,
    async () => null,
    { bind: () => async () => {} },
  );
  const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "no-store-test" });
  await host.start();
  try {
    expect(load.failures.size).toBe(0);
    const probe = tools.get("acme.nostore.probe");
    expect(probe).toBeDefined();
    const answer = JSON.parse(
      String(
        await probe?.handler({
          input: {},
          context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
          signal: AbortSignal.timeout(5000),
        }),
      ),
    );
    expect(answer.load).toMatch(/needs the persistence service/);
    expect(answer.put).toMatch(/needs the persistence service/);
  } finally {
    await host.stop();
  }
});
