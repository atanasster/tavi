import { V1_DISCOVERED_TOOLS_MAX } from "@tavi/contracts";
import { TOOL_SEARCH_ID, ToolSearchInput, appendDiscovered, discoverTools } from "../../../tools/tool-routing.js";
import { invalidInputOutput } from "../../dispatch.js";
import type { ToolCall, ToolRound } from "./round.js";

/** `tools.search`, answered here: `true` when `call` was it and its result is pushed. */
export async function runToolSearch(round: ToolRound, call: ToolCall): Promise<boolean> {
  const { current, messages } = round;
  const { authorizedTools, stepFactsOf } = round.scope;
  // Routed, or unrouted where it was offered because deferred tools were left out: only
  // where its permission holds and no rule hides it, as `authorizedTools` decides.
  // One read of the search's facts: the authorized set and the layout it is offered under.
  const searchFacts = call.name === TOOL_SEARCH_ID ? stepFactsOf(current.invocation, current.runId) : undefined;
  const authorized = searchFacts === undefined ? undefined : await authorizedTools(current, searchFacts);
  if (
    searchFacts !== undefined &&
    authorized !== undefined &&
    (current.toolDisclosureRequired || authorized.some((tool) => tool.id === TOOL_SEARCH_ID))
  ) {
    const parsed = ToolSearchInput.safeParse(call.input);
    // A tool the step was given is no news: the search names others. What it was given: a routed turn's routed
    // tools under v2 (none known under v1); an unrouted turn's tools found before, and under v2 the tools listed up
    // front but a server's (one may have been dropped to fit the list, so it stays findable).
    const layout = await searchFacts.layout();
    const offered = new Set(
      current.toolDisclosureRequired
        ? layout === "v2"
          ? (current.routedToolIds ?? [])
          : []
        : [
            ...round.discoveredToolIds,
            ...(layout === "v2"
              ? authorized.filter((tool) => tool.deferred !== true && tool.outputSource !== "mcp").map((tool) => tool.id)
              : []),
          ],
    );
    const matches = parsed.success ? discoverTools(parsed.data.query, authorized, parsed.data.limit, offered) : [];
    if (parsed.success)
      round.discoveredToolIds =
        layout === "v2"
          ? appendDiscovered(
              round.discoveredToolIds,
              matches.map((tool) => tool.id),
            )
          : [...new Set([...matches.map((tool) => tool.id), ...round.discoveredToolIds])].slice(0, V1_DISCOVERED_TOOLS_MAX);
    messages.push({
      id: `tool-${current.steps}-${call.id}`,
      role: "tool",
      text: "",
      toolCallId: call.id,
      toolName: call.name,
      // A description an external server wrote is marked as its text, never Tavi's own words.
      output: parsed.success
        ? {
            tools: matches.map((tool) => ({
              id: tool.id,
              description: tool.description,
              ...(tool.outputSource === "mcp" ? { serverText: true } : {}),
            })),
            availableOn: "next-generation",
          }
        : invalidInputOutput("tools.search requires a bounded query and limit from 1 to 8"),
      isError: !parsed.success,
    });
    return true;
  }
  return false;
}
