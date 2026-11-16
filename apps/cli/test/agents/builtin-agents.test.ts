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

  it("always has a general worker, so a task that is not browsing is not handed to the browser worker", async () => {
    const worker = await withBuiltinAgents(repository, false).get("w2", "worker");
    expect(worker).toMatchObject({ agentId: "worker", name: "Worker", enabled: true });
    expect(worker?.systemPrompt).not.toContain("browser");
  });

  it("leaves the browser worker out while its Chromium is not installed, and keeps the workspace's own", async () => {
    let installed = false;
    const agents = withBuiltinAgents(repository, async () => installed);
    expect(await agents.get("w2", BROWSER_WORKER_AGENT_ID)).toBeUndefined();
    expect(await agents.get("w1", "browser")).toBe(own);
    installed = true;
    expect(await agents.get("w2", BROWSER_WORKER_AGENT_ID)).toMatchObject({ name: "Browser worker" });
    expect(await withBuiltinAgents(repository, false).get("w2", BROWSER_WORKER_AGENT_ID)).toBeUndefined();
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
