import type { AgentDefinition } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { registerAgentTools } from "../../src/features/agents/tools.js";

/** `agents.spawn` naming an agent definition that is not on is refused before any card, with the ones there are. */
describe("agents.spawn's definition check", () => {
  const definition = (agentId: string, enabled = true, name = agentId) => ({ agentId, enabled, name }) as AgentDefinition;
  const all = [definition("browser"), definition("writer", true, "Story Writer"), definition("old", false)];
  const definitions = {
    get: async (_: string, id: string) => all.find((entry) => entry.agentId === id),
    list: async () => ({ agents: all }),
  };
  const spawned: string[] = [];
  const registry = new ToolRegistry();
  registerAgentTools(
    registry,
    { spawn: async (input: { agentDefinitionId: string }) => (spawned.push(input.agentDefinitionId), { created: true }) } as never,
    { definitions: definitions as never },
  );
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
    expect(await check("nobody")).toEqual({
      refused: "No agent definition nobody is on here; the ones there are: browser, writer, worker",
    });
    expect(await check("old")).toMatchObject({ refused: expect.stringContaining("No agent definition old") });
  });

  it("takes a definition named in another case, or by its name, as that definition (Mac mini tests)", async () => {
    const passed = { statuses: [], contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) };
    expect(await check("Writer")).toEqual(passed);
    expect(await check("story writer")).toEqual(passed);
    // The hash binds the definition it found, whatever its spelling.
    expect(await check("WRITER")).toEqual(await check("writer"));
    expect(await check("Old")).toMatchObject({ refused: expect.stringContaining("No agent definition Old") });
    // And the worker starts as it.
    await registry.get("agents.spawn")?.handler({
      input: { agentDefinitionId: "Story Writer", input: "a poem", operationKey: "k2" },
      context: { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" },
      signal: new AbortController().signal,
    } as never);
    expect(spawned).toEqual(["writer"]);
  });

  it("says the spawn runs in the background", () => {
    expect(registry.get("agents.spawn")?.description).toContain("runs in the background");
  });
});
