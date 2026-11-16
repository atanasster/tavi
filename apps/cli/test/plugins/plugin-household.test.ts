import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, type PluginVersionRecord } from "@tavi/contracts";
import { PluginHost, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/**
 * The household rule for a plugin's account, as the MCP bridge applies it: a plugin whose `apps` block
 * says `dataClass: personal`, or whose account the page made Personal, is
 * offered and answers only in its operator's own chats, and its results are
 * personal data.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

async function loaded(dataClass: "personal" | undefined, personalChoice?: boolean) {
  const directory = directories.create("tavi-plugin-household-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(
    entryPath,
    "export function register({ registerTool, z }) { registerTool({ name: 'events', inputSchema: z.object({}), handler: async () => 'lunch' }); }\n",
  );
  const manifest = PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.cal",
    version: "1.0.0",
    name: "Calendar fixture",
    entry: "index.mjs",
    tools: [{ name: "events", effect: "read-only", description: "Today's events" }],
    config: {},
    ...(dataClass === undefined
      ? {}
      : { apps: { abi: "tavi.apps/1", apps: [{ id: "acme-cal", name: "Calendar", category: "calendar", dataClass }] } }),
  });
  const record: PluginVersionRecord = {
    pluginId: "acme.cal",
    version: "1.0.0",
    contentHash: "a".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-16T00:00:00.000Z",
  };
  const tools = new ToolRegistry();
  const household = {
    personal: async (_pluginId: string, declared: "public" | "personal" | undefined) => personalChoice ?? declared === "personal",
    operatorOf: () => "operator",
  };
  const load = await loadExternalPlugins(
    [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
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
    undefined,
    household,
  );
  const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "household-test" });
  await host.start();
  return { tools, host };
}

const offer = { workspaceId: "default", principalId: "operator" };
/** Whether the registry offers the tool in this scope, as a turn's tool list is assembled. */
const offered = async (tools: ToolRegistry, context: Record<string, unknown>): Promise<boolean> =>
  (await tools.listOffered(context as never)).some((tool) => tool.id === "acme.cal.events");
const call = (principalId: string, memoryReach?: "chat-only") => ({
  workspaceId: "default",
  principalId,
  runId: "task-1",
  caller: "test",
  ...(memoryReach === undefined ? {} : { memoryReach }),
});

describe("a plugin's Personal account (household rule)", () => {
  it("is offered and answers only in its operator's own chats, its results personal data", async () => {
    const { tools, host } = await loaded("personal");
    try {
      const tool = tools.get("acme.cal.events");
      expect(tool?.outputConfidentiality).toBe("personal");
      expect(await offered(tools, { ...offer, operator: true })).toBe(true);
      expect(await offered(tools, { ...offer, operator: false })).toBe(false);
      expect(await offered(tools, { ...offer, operator: true, memoryReach: "chat-only" })).toBe(false);
      expect(await tool?.handler({ input: {}, context: call("operator"), signal: new AbortController().signal } as never)).toBe("lunch");
      await expect(tool?.handler({ input: {}, context: call("ana"), signal: new AbortController().signal } as never)).rejects.toMatchObject(
        { code: "NOT_AUTHORIZED" },
      );
      await expect(
        tool?.handler({ input: {}, context: call("operator", "chat-only"), signal: new AbortController().signal } as never),
      ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    } finally {
      await host.stop();
    }
  });

  it("is offered to people the operator allowed once the page makes it Shared, and a plain plugin is not held back", async () => {
    const shared = await loaded("personal", false);
    try {
      expect(await offered(shared.tools, { ...offer, operator: false })).toBe(true);
    } finally {
      await shared.host.stop();
    }
    const plain = await loaded(undefined);
    try {
      const tool = plain.tools.get("acme.cal.events");
      expect(tool?.outputConfidentiality).toBeUndefined();
      expect(await offered(plain.tools, { ...offer, operator: false })).toBe(true);
    } finally {
      await plain.host.stop();
    }
  });
});
