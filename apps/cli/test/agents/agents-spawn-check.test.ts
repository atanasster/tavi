import type { AgentCommunicationServicePort, AgentDefinition } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { registerAgentTools } from "../../src/features/agents/tools.js";

/** `agents.spawn` naming an agent definition that is not on is refused before any card, with the ones there are. */
describe("agents.spawn's definition check", () => {
  const definition = (agentId: string, enabled = true) => ({ agentId, enabled }) as AgentDefinition;
  const definitions = {
    get: async (_: string, id: string) =>
      [definition("browser"), definition("writer"), definition("old", false)].find((entry) => entry.agentId === id),
    list: async () => ({ agents: [definition("browser"), definition("writer"), definition("old", false)] }),
  };
  const registry = new ToolRegistry();
  registerAgentTools(registry, {} as AgentCommunicationServicePort, { definitions: definitions as never });
  const check = (agentDefinitionId: string) =>
    registry
      .get("agents.spawn")
      ?.checkSources?.(
        { agentDefinitionId, input: "find flights", operationKey: "k1" },
        { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" },
        { personMessages: [] } as never,
      );

  it("lets a definition that is on through, and refuses one that is not there or off", async () => {
    // The gate denies a check whose hash is not a SHA-256 hex ("could not be checked"), so a pass carries one.
    expect(await check("browser")).toEqual({ statuses: [], contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await check("nobody")).toEqual({ refused: "No agent definition nobody is on here; the ones there are: browser, writer" });
    expect(await check("old")).toMatchObject({ refused: expect.stringContaining("No agent definition old") });
  });

  it("says the spawn runs in the background", () => {
    expect(registry.get("agents.spawn")?.description).toContain("runs in the background");
  });
});
