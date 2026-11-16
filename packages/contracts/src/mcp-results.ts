import { normalizeLabel, type ContentLabel } from "./content-label.js";

/** The label of anything an MCP server answers: untrusted, from `mcp`, said by `tool:<server>`. */
export function mcpResultLabel(server: string): ContentLabel {
  return normalizeLabel({ integrity: "untrusted", sources: ["mcp"], principals: [`tool:${server}`], confidentiality: "public", refs: [] });
}

/** An MCP tool's result and the label its content carries: what the host hands a tool plugin that calls one through it. */
export interface McpToolResult {
  readonly content: unknown;
  readonly label: ContentLabel;
}
