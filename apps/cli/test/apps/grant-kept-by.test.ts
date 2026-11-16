import { describe, expect, it } from "vitest";

import { mcpCommand, setGrantKeptBy } from "../../src/server/config-commands.js";

/**
 * Every path that revokes an MCP server's grant weighs who else keeps it:
 * `tavi mcp logout` as well as
 * Connected apps' Disconnect, so signing one app out never ends another's.
 */

function runtime(kept: readonly string[]) {
  const logouts: unknown[] = [];
  const fake = {
    plugins: { registry: {} },
    dataDirectory: "/nonexistent",
    store: { asPort: () => ({ repositories: {} }), getMeta: async () => undefined, setMeta: async () => undefined },
    resolveSecret: async () => null,
    tools: { list: () => [] },
    clock: { now: () => "2026-10-16T12:00:00.000Z" },
    mcp: {
      oauth: {
        tokens: {},
        logins: {},
        logout: async (pluginId: string, options?: { readonly upstream?: boolean }) => {
          logouts.push({ pluginId, options });
          return { hadGrant: true, confirmed: options?.upstream !== false };
        },
      },
    },
  };
  setGrantKeptBy(fake, async (accountId) => (accountId === "mcp.gcal" ? kept : []));
  return { fake: fake as unknown as Parameters<typeof mcpCommand>[0], logouts };
}

describe("signing out an MCP server another app shares a grant with", () => {
  it("forgets its sign-in here only while another app keeps the grant, and revokes it for the last one", async () => {
    const shared = runtime(["Gmail"]);
    expect(await mcpCommand(shared.fake, { action: "logout", pluginId: "mcp.gcal" }, "operator:cli")).toMatchObject({
      ok: true,
      result: { loggedOut: { confirmed: false } },
    });
    expect(shared.logouts).toEqual([{ pluginId: "mcp.gcal", options: { upstream: false } }]);
    const alone = runtime([]);
    await mcpCommand(alone.fake, { action: "logout", pluginId: "mcp.gcal" }, "operator:cli");
    expect(alone.logouts).toEqual([{ pluginId: "mcp.gcal", options: {} }]);
  });
});
