import type { AgentDefinition, AgentDefinitionRepositoryPort } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { BROWSER_WORKER_AGENT_ID, browserWorkerUses, withBuiltinAgents } from "../../src/features/agents/builtin.js";

describe("built-in agents", () => {
  const own: AgentDefinition = {
    agentId: "browser",
    workspaceId: "w1",
    name: "Our browser",
    systemPrompt: "ours",
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const repository = {
    get: async (workspaceId: string, agentId: string) => (workspaceId === "w1" && agentId === "browser" ? own : undefined),
  } as unknown as AgentDefinitionRepositoryPort;

  it("resolves the browser worker in a workspace that has none, and the workspace's own where it has one", async () => {
    const agents = withBuiltinAgents(repository);
    const builtin = await agents.get("w2", BROWSER_WORKER_AGENT_ID);
    expect(builtin).toMatchObject({ agentId: "browser", workspaceId: "w2", name: "Browser worker", enabled: true });
    expect(builtin?.systemPrompt).toContain("`browser.extract`");
    expect(builtin?.systemPrompt).toContain("Never try to solve a captcha");
    expect(await agents.get("w1", "browser")).toBe(own);
    expect(await agents.get("w2", "nobody")).toBeUndefined();
  });

  it("narrows the browser worker to the browser, its findings, flight search and page fetches", () => {
    for (const tool of [
      "browser.act",
      "browser.extract",
      "browser.request_handoff",
      "findings.check",
      "travel.flights_search",
      "web_fetch",
      "plan.update",
    ])
      expect(browserWorkerUses(tool)).toBe(true);
    for (const tool of ["sandbox.run", "fs.write", "messaging.send", "agents.spawn", "routines.create"])
      expect(browserWorkerUses(tool)).toBe(false);
  });
});
