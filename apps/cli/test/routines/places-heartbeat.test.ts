import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HEARTBEAT_FETCH_TOOL_ID, SiteProfileSchema, type SiteUsage } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { HeartbeatReports, registerHeartbeatFetchTool } from "../../src/features/heartbeat/turns.js";
import { createSitePolicy } from "../../src/features/browser/site-policy.js";

/**
 * A heartbeat `watch:` line on a places profile's host: the shipped Tabelog profile is assist-only, never watchable,
 * so the heartbeat does not read it, while a page no profile names is read.
 */
const sitesDir = join(import.meta.dirname, "..", "..", "..", "..", "packages", "external", "places-open", "sites");
const tabelog = SiteProfileSchema.parse(JSON.parse(readFileSync(join(sitesDir, "tabelog.json"), "utf8")));

describe("a heartbeat watch line on a places profile's host", () => {
  it("is not read on Tabelog (assist-only), and a page no profile names is", async () => {
    const counts = new Map<string, SiteUsage>();
    const sites = createSitePolicy({
      profiles: async () => [{ pluginId: "places.open", profile: tabelog }],
      usage: {
        take: async ({ workspaceId, profile, day, counter, limit }) => {
          const at = `${workspaceId}|${profile}|${day}`;
          const known = counts.get(at) ?? { pages: 0, finalSteps: 0 };
          if (known[counter] >= limit) return { ok: false, usage: known };
          counts.set(at, { ...known, [counter]: known[counter] + 1 });
          return { ok: true, usage: counts.get(at) ?? known };
        },
        get: async () => ({ pages: 0, finalSteps: 0 }),
      },
      robots: async () => ({ text: "User-agent: *\nAllow: /\n" }),
      now: () => Date.now(),
      sleep: async () => undefined,
    });
    await sites.refresh();
    const tools = new ToolRegistry();
    const reports = new HeartbeatReports();
    const fetched: string[] = [];
    registerHeartbeatFetchTool(tools, reports, async (url) => (fetched.push(url), { status: 200, text: "ok" }), sites);
    reports.open("task-1", "tavi.heartbeatagent", {
      hosts: ["tabelog.com", "example.com"],
      pages: ["https://tabelog.com/tokyo/A1301/", "https://example.com/menu"],
    });
    const call = (url: string) =>
      tools.get(HEARTBEAT_FETCH_TOOL_ID)?.handler({
        input: { url },
        context: { workspaceId: "default", principalId: "alice", runId: "task-1", caller: "test" },
        signal: new AbortController().signal,
      } as never);
    // The profile's own rule, not a budget, robots or a block: read only while the person attends.
    await expect(call("https://tabelog.com/tokyo/A1301/")).rejects.toMatchObject({
      message: expect.stringMatching(/Tabelog is read only while the person attends/),
      details: expect.objectContaining({ host: "tabelog.com" }),
    });
    await expect(call("https://example.com/menu")).resolves.toMatchObject({ status: 200 });
    expect(fetched).toEqual(["https://example.com/menu"]);
  });
});
