/**
 * Tavi's own line for a server that describes itself nowhere: never shown as its author's words. Takes the add
 * form's shape, not its type, so reading these lines never imports the add path.
 */
export function taviDescription(form: { readonly kind: string; readonly url?: string; readonly spec?: string }, slug: string): string {
  return form.kind === "url"
    ? `The MCP server at ${form.url ?? ""}`
    : form.kind === "npm"
      ? `The npm MCP server ${form.spec ?? ""}`
      : form.kind === "pypi"
        ? `The Python MCP server ${form.spec ?? ""}`
        : `A local MCP server (${slug})`;
}

/** Whether `description` is a line `taviDescription` wrote, not the server's author's or the operator's. */
export const isTaviMcpDescription = (description: string): boolean =>
  /^(?:The MCP server at \S+|The npm MCP server \S+|The Python MCP server \S+|A local MCP server \([^()]+\))$/.test(description);
