import type { SandboxStatus } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { weakerSandboxServers } from "../../src/features/mcp/sandbox-nudge.js";

/**
 * A server approved `--unsandboxed` or `--nested` while the sandbox could not
 * run keeps that state once the host is fixed: `tavi serve` and `tavi doctor`
 * name it, with the way to move it, and never move it themselves.
 */

const full: SandboxStatus = { tier: "full", checks: [] };
const nested: SandboxStatus = { tier: "nested", checks: [] };
const unavailable: SandboxStatus = {
  tier: "unavailable",
  checks: [],
  cause: "bwrap missing",
};
const checking: SandboxStatus = { tier: "checking", checks: [] };

const server = (pluginId: string, sandboxState: "srt" | "nested" | "none", transport: "stdio" | "http" = "stdio") => ({
  pluginId,
  version: "1.0.0",
  sandboxState,
  transport,
});

describe("MCP servers running weaker than the host now confines", () => {
  it("names an unsandboxed server once the sandbox works, with a new version as the way to move it", () => {
    const [weaker, ...rest] = weakerSandboxServers(full, [server("mcp.raw", "none"), server("mcp.boxed", "srt")]);
    expect(rest).toEqual([]);
    expect(weaker).toMatchObject({
      pluginId: "mcp.raw",
      version: "1.0.0",
      sandboxState: "none",
      available: "srt",
    });
    expect(weaker?.warning).toContain("mcp.raw@1.0.0 runs unsandboxed");
    expect(weaker?.warning).toContain("`tavi mcp add` it again with a new --version");
    // `tavi mcp probe` re-probes an approved version in its approved state: not the way to move it.
    expect(weaker?.warning).not.toContain("tavi mcp probe");
  });

  it("names a nested server once the full sandbox works", () => {
    expect(weakerSandboxServers(full, [server("mcp.box", "nested")])).toMatchObject([
      { pluginId: "mcp.box", sandboxState: "nested", available: "srt" },
    ]);
  });

  it("on a nested host names only unsandboxed servers, and points to --nested", () => {
    const weaker = weakerSandboxServers(nested, [server("mcp.raw", "none"), server("mcp.box", "nested")]);
    expect(weaker.map((entry) => entry.pluginId)).toEqual(["mcp.raw"]);
    expect(weaker[0]?.warning).toContain("--nested");
  });

  it("says nothing while the sandbox cannot run, or has not been checked", () => {
    for (const status of [unavailable, checking]) expect(weakerSandboxServers(status, [server("mcp.raw", "none")])).toEqual([]);
  });

  it("leaves remote servers alone: no code of theirs runs here", () => {
    expect(weakerSandboxServers(full, [server("mcp.remote", "none", "http")])).toEqual([]);
  });
});
