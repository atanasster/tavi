import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { removeMcpServer, type McpRemovalDeps } from "../../src/features/mcp/remove.js";

/**
 * Removing an MCP server whose grant another app shares: who
 * keeps it is weighed while it is still an app, before it goes,
 * and a check that fails keeps the grant at the provider.
 */

const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

function deps(keptBy: McpRemovalDeps["keptBy"]) {
  const directory = directories.create("tavi-mcp-remove-");
  const order: string[] = [];
  const revoked: unknown[] = [];
  const removal = {
    registry: {
      show: async () => ({ id: "mcp.gcal", kind: "mcp", versions: [{ version: "1.0.0" }], config: {} }),
      remove: async () => {
        order.push("removed");
        return { removed: ["1.0.0"] };
      },
      snapshotDirectory: () => join(directory, "missing"),
    },
    mcp: { listTools: async () => [], deleteNotices: async () => 0 },
    dataDirectory: directory,
    deleteSecret: async () => undefined,
    deleteSessionGrants: async () => 0,
    rules: async () => [],
    workspaceSettings: { list: async () => [] },
    now: () => "2026-10-16T12:00:00.000Z",
    clearSearchLine: async () => undefined,
    revokeGrant: async (pluginId: string, _lan: boolean, options?: { readonly upstream?: boolean }) => {
      revoked.push({ pluginId, options });
      return { hadGrant: true, confirmed: options?.upstream !== false };
    },
    ...(keptBy === undefined
      ? {}
      : {
          keptBy: async (pluginId: string) => {
            order.push("weighed");
            return await keptBy(pluginId);
          },
        }),
  } as unknown as McpRemovalDeps;
  return { removal, order, revoked };
}

describe("removing a server another app shares a grant with", () => {
  it("weighs who keeps the grant before it goes, and leaves the grant at the provider while one does", async () => {
    const shared = deps(async () => ["Gmail"]);
    await removeMcpServer(shared.removal, "mcp.gcal", undefined, "operator:cli");
    expect(shared.order).toEqual(["weighed", "removed"]);
    expect(shared.revoked).toEqual([{ pluginId: "mcp.gcal", options: { upstream: false } }]);
    const alone = deps(async () => []);
    await removeMcpServer(alone.removal, "mcp.gcal", undefined, "operator:cli");
    expect(alone.revoked).toEqual([{ pluginId: "mcp.gcal", options: {} }]);
  });

  it("keeps the grant at the provider when who keeps it cannot be told", async () => {
    const unknown = deps(async () => {
      throw new Error("the apps could not be read");
    });
    await removeMcpServer(unknown.removal, "mcp.gcal", undefined, "operator:cli");
    expect(unknown.revoked).toEqual([{ pluginId: "mcp.gcal", options: { upstream: false } }]);
  });
});
