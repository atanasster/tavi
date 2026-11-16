import {
  TOOL_LABEL_KEY,
  TaviError,
  mcpResultLabel,
  type McpToolResult,
  type TaskFindingRepositoryPort,
  type ToolRegistrar,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { z } from "zod";

/**
 * `travel.flights_search`: flight search
 * as a domain tool, before any browsing. The Sofia → Tampa run browsed Google
 * Flights, Kayak and Skyscanner, met an error page, a bot wall and a captcha,
 * and answered with ranges; the same question asked of a flight search answers
 * with itineraries — carriers, flight numbers, times, layovers, durations and
 * a price, each with a link to book it.
 *
 * - **Source.** Kiwi.com's public MCP server (`https://mcp.kiwi.com`): free,
 *   no key (no paid keys), date ranges both ways, a maximum flight
 *   time, sorted by price, each result with a booking link. Coverage is Kiwi's.
 * - **Checked in code.** The maximum duration is held per direction here too,
 *   whatever the server counts; self-transfer (separate tickets) is off unless
 *   asked for.
 * - **Links to check.** Every answer carries a Google Flights search and a
 *   Kayak search for the same trip, for the person — or the browser, when the
 *   source fails or a fare should be confirmed (`fallback`).
 * - **Kept.** The itineraries become the task's findings of kind `flight`.
 */

/** The built-in plugin this tool is: `tavi plugins disable tavi.flights` leaves it out of composition. */
export const FLIGHTS_PLUGIN_ID = "tavi.flights";

/** Kiwi.com's public MCP server: the source the host's MCP client calls for the tool (`FlightsToolOptions.search`). */
export const KIWI_MCP_URL = "https://mcp.kiwi.com";

/** The flight search tool's id: registered everywhere, answering only where a workspace turned flight search on. */
export const FLIGHT_SEARCH_TOOL_ID = "travel.flights_search";
/** How long a search's answer is reused for the same question. */
const CACHE_MS = 15 * 60_000;
const CACHE_MAX = 50;
const DEFAULT_RESULTS = 10;

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD");

const FlightsSearchInputSchema = z.object({
  from: z.string().min(2).max(80).describe("Origin: an IATA code (SOF) or a city or airport name"),
  to: z.string().min(2).max(80).describe("Destination: an IATA code or a city or airport name"),
  departDate: DateSchema.describe("The departure date, or the first of a range (YYYY-MM-DD)"),
  departDateTo: DateSchema.optional().describe("The last departure date of a range"),
  returnDate: DateSchema.optional().describe("The return date, or the first of a range; omit for one way"),
  returnDateTo: DateSchema.optional().describe("The last return date of a range"),
  maxDurationHours: z.number().positive().max(72).optional().describe("The longest each direction may take, door to door, in hours"),
  maxStops: z.number().int().min(0).max(4).optional(),
  allowSelfTransfer: z
    .boolean()
    .optional()
    .describe("Allow connections on separate tickets (cheaper, unprotected if a flight is late); default false"),
  cabin: z.enum(["economy", "premium", "business", "first"]).optional(),
  adults: z.number().int().min(1).max(9).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .describe("ISO code, default EUR"),
  sort: z.enum(["price", "duration"]).optional(),
  limit: z.number().int().min(1).max(30).optional(),
});
export type FlightsSearchInput = z.infer<typeof FlightsSearchInputSchema>;

const CABINS: Readonly<Record<NonNullable<FlightsSearchInput["cabin"]>, string>> = {
  economy: "M",
  premium: "W",
  business: "C",
  first: "F",
};

/** `YYYY-MM-DD` as Kiwi's `dd/mm/yyyy`. */
const kiwiDate = (date: string): string => date.split("-").reverse().join("/");

/** The search's arguments for Kiwi's `search-flight`. */
export function kiwiArguments(input: FlightsSearchInput): Record<string, unknown> {
  return {
    flyFrom: input.from,
    flyTo: input.to,
    departureDate: kiwiDate(input.departDate),
    ...(input.departDateTo === undefined ? {} : { departureDateTo: kiwiDate(input.departDateTo) }),
    ...(input.returnDate === undefined ? {} : { returnDate: kiwiDate(input.returnDate) }),
    ...(input.returnDateTo === undefined ? {} : { returnDateTo: kiwiDate(input.returnDateTo) }),
    // Rounded up for the server, which takes whole hours; the exact limit is held in code (`withinDuration`).
    ...(input.maxDurationHours === undefined ? {} : { max_fly_duration: Math.ceil(input.maxDurationHours) }),
    ...(input.maxStops === undefined ? {} : { max_sector_stopovers: input.maxStops }),
    allow_self_transfer: input.allowSelfTransfer === true,
    ...(input.cabin === undefined ? {} : { cabinClass: CABINS[input.cabin] }),
    adults: input.adults ?? 1,
    currency: input.currency ?? "EUR",
    sort: input.sort ?? "price",
  };
}

/** A leg as an answer lists it: where it goes through, when, how long, on what flights. */
interface FlightLeg {
  readonly route: string;
  readonly departure: string;
  readonly arrival: string;
  readonly hours: number;
  readonly stops: number;
  readonly flights: readonly string[];
}

export interface FlightItinerary {
  readonly price: number;
  readonly currency: string;
  readonly airlines: readonly string[];
  readonly outbound: FlightLeg;
  readonly inbound?: FlightLeg;
  readonly totalHours: number;
  readonly bookingUrl?: string;
}

const hours = (seconds: unknown): number => (typeof seconds === "number" ? Math.round((seconds / 3600) * 10) / 10 : Number.NaN);

function legOf(raw: unknown): FlightLeg | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const leg = raw as {
    route?: unknown;
    departureTime?: unknown;
    arrivalTime?: unknown;
    durationSeconds?: unknown;
    stops?: unknown;
    segments?: unknown;
  };
  const segments = Array.isArray(leg.segments)
    ? (leg.segments as { carrierName?: unknown; flightNumber?: unknown; from?: unknown; to?: unknown }[])
    : [];
  return {
    route: Array.isArray(leg.route) ? leg.route.filter((code): code is string => typeof code === "string").join(" → ") : "",
    departure: typeof leg.departureTime === "string" ? leg.departureTime : "",
    arrival: typeof leg.arrivalTime === "string" ? leg.arrivalTime : "",
    hours: hours(leg.durationSeconds),
    stops: typeof leg.stops === "number" ? leg.stops : Math.max(0, segments.length - 1),
    flights: segments
      .map((segment) => [segment.flightNumber, segment.carrierName].filter((part) => typeof part === "string" && part !== "").join(" "))
      .filter((flight) => flight !== ""),
  };
}

/** Kiwi's answer as itineraries, the malformed ones left out; `undefined` for an answer that is not a search's (no itinerary list). */
export function itinerariesOf(answer: unknown, currency: string): FlightItinerary[] | undefined {
  const items = typeof answer === "object" && answer !== null ? (answer as { itineraries?: unknown }).itineraries : undefined;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((raw): FlightItinerary[] => {
    const item = raw as { price?: unknown; totalDurationSeconds?: unknown; bookingUrl?: unknown; outbound?: unknown; inbound?: unknown };
    const outbound = legOf(item.outbound);
    if (typeof item.price !== "number" || outbound === undefined) return [];
    const inbound = legOf(item.inbound);
    const segments = [item.outbound, item.inbound].flatMap((leg) =>
      typeof leg === "object" && leg !== null && Array.isArray((leg as { segments?: unknown }).segments)
        ? (leg as { segments: { carrierName?: unknown }[] }).segments
        : [],
    );
    return [
      {
        price: item.price,
        currency,
        airlines: [...new Set(segments.map((segment) => segment.carrierName).filter((name): name is string => typeof name === "string"))],
        outbound,
        ...(inbound === undefined ? {} : { inbound }),
        totalHours: hours(item.totalDurationSeconds),
        ...(typeof item.bookingUrl === "string" && /^https:\/\//.test(item.bookingUrl) ? { bookingUrl: item.bookingUrl } : {}),
      },
    ];
  });
}

/** The itineraries whose every direction is within `maxHours`. */
export function withinDuration(itineraries: readonly FlightItinerary[], maxHours: number | undefined): FlightItinerary[] {
  if (maxHours === undefined) return [...itineraries];
  return itineraries.filter(
    (itinerary) => itinerary.outbound.hours <= maxHours && (itinerary.inbound === undefined || itinerary.inbound.hours <= maxHours),
  );
}

/**
 * Searches of the same trip elsewhere, to check a fare or book it there: Google
 * Flights by its plain-words query (`?q=`, which lists fares in Tavi's browser),
 * and Kayak by its path. The first date of each range.
 */
export function checkLinks(input: FlightsSearchInput): { readonly googleFlights: string; readonly kayak?: string } {
  const words = `Flights from ${input.from} to ${input.to} on ${input.departDate}${input.returnDate === undefined ? " one way" : ` returning ${input.returnDate}`}`;
  // Kayak's path takes airport codes only: for a city name, no Kayak link rather than a broken one.
  const iata = /^[A-Za-z]{3}$/;
  return {
    googleFlights: `https://www.google.com/travel/flights?q=${encodeURIComponent(words)}&curr=${input.currency ?? "EUR"}&hl=en`,
    ...(iata.test(input.from) && iata.test(input.to)
      ? {
          kayak: `https://www.kayak.com/flights/${input.from.toUpperCase()}-${input.to.toUpperCase()}/${input.departDate}${input.returnDate === undefined ? "" : `/${input.returnDate}`}?sort=${input.sort === "duration" ? "duration_a" : "price_a"}`,
        }
      : {}),
  };
}

export interface FlightsToolOptions {
  /**
   * Calls Kiwi's MCP tool `search-flight` with `kiwiArguments`, answering its content and label: the host's
   * MCP client over its guarded fetch, which this package never sees. A test's answers at once.
   */
  readonly search: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<McpToolResult>;
  readonly findings?: TaskFindingRepositoryPort;
  readonly now: () => string;
  readonly clock?: () => number;
  /** The workspace's flight settings: the search, and the Google Flights back end. Absent: both on. */
  readonly settings?: (workspaceId: string) => Promise<{ readonly search: boolean; readonly googleFlights: boolean }>;
  /**
   * Whether the host offers the browser's tools (`browser.create_session`, `browser.extract`). Absent: offered.
   * Without them every fallback is the `check` links, for the person to open.
   */
  readonly browser?: boolean;
}

export function registerFlightsTools(registry: ToolRegistrar, options: FlightsToolOptions): void {
  const search = options.search;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly answer: McpToolResult }>();
  // A failed search's reason can be the server's words: labelled as its results are.
  const kiwiLabel = { [TOOL_LABEL_KEY]: { stored: mcpResultLabel(new URL(KIWI_MCP_URL).host) } };
  /** The searches each task has kept the findings of: asking again keeps nothing twice. */
  const keptBy = new Set<string>();
  const browser = options.browser !== false;
  registry.register({
    id: FLIGHT_SEARCH_TOOL_ID,
    sink: "search",
    // Ideas about trips are offered while it answers.
    proves: ["travel"],
    version: "1.0.0",
    description:
      "Search flights — one way or return, over date ranges each way, within a maximum flight time per direction — and answer with itineraries: airlines, flight numbers, times, layovers, durations, price and a booking link, cheapest first. " +
      (browser
        ? "Use it before browsing for any flight question. Each answer has links to the same search on Google Flights and Kayak (`check`) to confirm a fare in the browser. "
        : "Each answer has links to the same search on Google Flights and Kayak (`check`) for the person to confirm a fare. ") +
      "Its itineraries are kept as the task's findings of kind flight, for findings.check.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    promptGuidance: browser
      ? "Domain tools first: for flights use `travel.flights_search` before browsing, and confirm a fare in the browser only when asked or when it fails; its `check` links are the same search on Google Flights and Kayak."
      : "For flights use `travel.flights_search`; its `check` links are the same search on Google Flights and Kayak, for the person to open.",
    inputSchema: FlightsSearchInputSchema,
    assess: (input) => {
      const call = input as Partial<FlightsSearchInput>;
      return {
        display: {
          title: `Search flights ${String(call.from ?? "?")} → ${String(call.to ?? "?")}`,
          detail: "Sends the trip (places, dates, passengers) to Kiwi.com's flight search",
        },
        subjects: [],
        risk: "low",
        reasons: ["sends the trip to Kiwi.com's flight search"],
        alwaysAnyCall: true,
        scopeGroup: "travel.*",
      };
    },
    // Fares, names and links are the source's words.
    untrustedOutput: true,
    outputSource: "search",
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "travel.flights_search was cancelled");
      const parsed = FlightsSearchInputSchema.safeParse(input);
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", "travel.flights_search received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      const query = parsed.data;
      const settings = (await options.settings?.(context.workspaceId)) ?? { search: true, googleFlights: true };
      if (!settings.search) {
        // Off, the same search opens directly in the browser: its address, not the site's form step by step.
        const direct = checkLinks(query);
        const open = settings.googleFlights ? direct.googleFlights : direct.kayak;
        const instead = browser
          ? `browse a flight site instead${open === undefined ? "" : ` — open this search directly with browser.create_session: ${open}`}`
          : `give the person the search to open themselves${open === undefined ? "" : `: ${open}`}`;
        throw new TaviError("NOT_AUTHORIZED", `flight search is off in this workspace's settings (travel.flightSearch): ${instead}`);
      }
      if (query.returnDateTo !== undefined && query.returnDate === undefined)
        throw new TaviError("INVALID_INPUT", "returnDateTo needs returnDate, the first return date");
      const links = checkLinks(query);
      // The Google Flights back end off, its link is left out and the fallback names another site.
      const check = settings.googleFlights ? links : (({ googleFlights: _off, ...rest }) => rest)(links);
      const browseAgain = !browser
        ? "give the person the check links to open themselves"
        : settings.googleFlights
          ? "open check.googleFlights with browser.create_session and read its results with browser.extract"
          : "browse another flight site (check.kayak when there is one) and read its results with browser.extract";
      const args = kiwiArguments(query);
      const key = JSON.stringify(args);
      let answer = cache.get(key);
      if (answer === undefined || clock() - answer.at > CACHE_MS) {
        try {
          answer = { at: clock(), answer: await search(args, signal) };
        } catch (error) {
          if (signal.aborted) throw error;
          return {
            source: "kiwi.com",
            itineraries: [],
            check,
            fallback: `the flight search failed (${errorMessage(error)}): ${browseAgain}`,
            ...kiwiLabel,
          };
        }
        cache.set(key, answer);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
      }
      const content = answer.answer.content;
      // Fares, names and links are the source's: `search`, and `mcp` from the server they came through (untrusted).
      const labelled = { [TOOL_LABEL_KEY]: { stored: answer.answer.label } };
      const currency =
        typeof (content as { currency?: unknown })?.currency === "string"
          ? (content as { currency: string }).currency
          : (query.currency ?? "EUR");
      const all = itinerariesOf(content, currency);
      if (all === undefined) {
        // A source that answered with no search at all is broken, not empty: the person's limits stay as they are.
        cache.delete(key);
        const reason = (content as { error?: unknown } | undefined)?.error;
        return {
          source: "kiwi.com",
          itineraries: [],
          check,
          fallback: `the flight search gave no results list${typeof reason === "string" && reason !== "" ? ` (${reason.slice(0, 200)})` : ""}: ${browseAgain}`,
          ...labelled,
        };
      }
      const fitting = withinDuration(all, query.maxDurationHours);
      const itineraries = fitting.slice(0, query.limit ?? DEFAULT_RESULTS);
      const keptKey = `${context.runId}\u0000${key}\u0000${query.limit ?? DEFAULT_RESULTS}`;
      const kept =
        options.findings === undefined || itineraries.length === 0 || keptBy.has(keptKey)
          ? []
          : await options.findings.add({
              taskId: context.runId,
              workspaceId: context.workspaceId,
              kind: "flight",
              records: itineraries,
              sourceUrl: KIWI_MCP_URL,
              createdAt: options.now(),
            });
      if (kept.length > 0) {
        keptBy.add(keptKey);
        if (keptBy.size > CACHE_MAX * 20) keptBy.delete(keptBy.values().next().value ?? "");
      }
      return {
        source: "kiwi.com",
        itineraries,
        found: all.length,
        ...(all.length > fitting.length ? { overDuration: all.length - fitting.length } : {}),
        check,
        ...(kept.length === 0 ? {} : { kept: { kind: "flight", from: kept[0]?.seq, to: kept.at(-1)?.seq } }),
        ...(itineraries.length === 0 ? { fallback: `no itinerary fits: widen the dates or the duration, or ${browseAgain}` } : {}),
        ...labelled,
      };
    },
  });
}
