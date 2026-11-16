import { flightSearchOn, mcpResultLabel, TaviError, type McpToolResult, type WorkspaceSettings } from "@tavi/contracts";
import { FLIGHT_SEARCH_TOOL_ID, KIWI_MCP_URL, registerFlightsTools, type FlightsToolOptions } from "@tavi/plugin-flights";

export { FLIGHTS_PLUGIN_ID } from "@tavi/plugin-flights";

import { McpConnection, type FetchLike } from "../mcp/client.js";
import { guardedFetch } from "../mcp/fetch.js";

/**
 * Where the owner puts flight search together: `@tavi/plugin-flights`'s tool
 * over Kiwi's server, called through the owner's own MCP client and guarded
 * fetch. This module alone names `@tavi/plugin-flights`.
 */

/** The most bytes one of Kiwi's answers may take: a flight search's results run to tens of kilobytes. */
const KIWI_MAX_BYTES = 4 * 1024 * 1024;
/** The handshake and the call together stay within 45 s, as one exchange always did. */
const KIWI_CONNECT_TIMEOUT_MS = 15_000;
const KIWI_TIMEOUT_MS = 30_000;

/** The flight tools that answer nothing in a workspace with flight search off: they prove nothing to Ideas there. */
export function flightToolsSilentIn(settings: WorkspaceSettings): ReadonlySet<string> {
  return flightSearchOn(settings) ? new Set() : new Set([FLIGHT_SEARCH_TOOL_ID]);
}

/**
 * Kiwi's `search-flight` over Tavi's MCP client:
 * https only, no redirects, a 4 MiB cap per message, and the 2025 handshake
 * without a probe (Kiwi speaks the legacy era). The answer is its first text
 * item parsed as JSON, else its structured content, else that text, with the
 * label every MCP result carries.
 */
export function kiwiSearch(
  options: { readonly url?: string; readonly fetch?: FetchLike } = {},
): (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<McpToolResult> {
  const url = options.url ?? KIWI_MCP_URL;
  const host = new URL(url).host;
  let connection: McpConnection | undefined;
  return async (args, signal) => {
    // The trip goes to the server named here and nowhere else: never in the clear, never redirected.
    if (new URL(url).protocol !== "https:") throw new TaviError("INVALID_INPUT", `the MCP server ${host} must be reached over https`);
    // Through the guard like every MCP request: its name resolved once and pinned, no private or metadata address.
    connection ??= new McpConnection({
      endpoint: { transport: "http", url, fetch: options.fetch ?? guardedFetch({ lan: false }) },
      maxMessageBytes: KIWI_MAX_BYTES,
      connectTimeoutMs: KIWI_CONNECT_TIMEOUT_MS,
      prior: { kind: "legacy" },
    });
    const result = await connection.callTool("search-flight", args, { signal, timeoutMs: KIWI_TIMEOUT_MS });
    let content: unknown = result.content;
    if (result.text !== undefined) {
      try {
        content = JSON.parse(result.text) as unknown;
      } catch {
        // Not JSON: the structured content, else the text, as given.
      }
    }
    return { content, label: mcpResultLabel(host) };
  };
}

/** `travel.flights_search` on `registry`, searching through Kiwi's server. */
export function registerOwnerFlightsTools(
  registry: Parameters<typeof registerFlightsTools>[0],
  options: Omit<FlightsToolOptions, "search">,
): void {
  registerFlightsTools(registry, { ...options, search: kiwiSearch() });
}
