import {
  flightSearchOn,
  mcpResultLabel,
  SERPAPI_CREDENTIAL_REF,
  TaviError,
  type McpToolResult,
  type WorkspaceSettings,
} from "@tavi/contracts";
import {
  FLIGHT_SEARCH_TOOL_ID,
  KIWI_MCP_URL,
  registerFlightsTools,
  type FlightSource,
  type FlightsToolOptions,
} from "@tavi/plugin-flights";

export { FLIGHTS_PLUGIN_ID } from "@tavi/plugin-flights";
/** The plugin's types its Google Flights sources are written to: this module alone names the package. */
export type { FlightItinerary, FlightSource, FlightsSearchInput } from "@tavi/plugin-flights";

import { McpConnection, type FetchLike } from "../mcp/client.js";
import { guardedFetch } from "../mcp/fetch.js";
import { googlePageSource } from "./google-page.js";
import { serpApiSource } from "./serpapi.js";

/**
 * Where the owner puts flight search together: `@tavi/plugin-flights`'s tool
 * over Kiwi's server, called through the owner's own MCP client and guarded
 * fetch, and Google Flights beside it (SerpApi with the person's key, else
 * Google's own page). This module and its sources alone name `@tavi/plugin-flights`.
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

/**
 * The Google Flights source a search asks beside Kiwi: SerpApi while the
 * person's key is stored (`serpapi`), else Google's own page, free and one
 * way only. The key is read at each search, so storing one takes effect at
 * the next.
 */
export function googleFlightsSources(options: {
  readonly secret: (reference: string) => Promise<string | null>;
  readonly fetch?: FetchLike;
}): () => Promise<readonly FlightSource[]> {
  const key = async (): Promise<string | undefined> => {
    try {
      return (await options.secret(SERPAPI_CREDENTIAL_REF))?.trim() || undefined;
    } catch {
      // An unreadable store is no key: the free source answers instead.
      return undefined;
    }
  };
  const fetch = options.fetch === undefined ? {} : { fetch: options.fetch };
  const serpApi = serpApiSource({ key, ...fetch });
  const page = googlePageSource(fetch);
  return async () => ((await key()) === undefined ? [page] : [serpApi]);
}

/** `travel.flights_search` on `registry`, searching through Kiwi's server and Google Flights. */
export function registerOwnerFlightsTools(
  registry: Parameters<typeof registerFlightsTools>[0],
  options: Omit<FlightsToolOptions, "search" | "sources"> & { readonly secret: (reference: string) => Promise<string | null> },
): void {
  const { secret, ...rest } = options;
  const sources = googleFlightsSources({ secret });
  registerFlightsTools(registry, { ...rest, search: kiwiSearch(), sources: async () => await sources() });
}
