import {
  TOOL_LABEL_KEY,
  TaviError,
  joinLabels,
  mcpResultLabel,
  searchResultLabel,
  type ContentLabel,
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
 * - **Sources.** Kiwi.com's public MCP server (`https://mcp.kiwi.com`): free,
 *   no key, date ranges both ways, a maximum flight time, sorted by price,
 *   each result with a booking link. Kiwi is a reseller: on the big airlines
 *   its fares carry its own fee and often run well above the airline's, so
 *   every answer says so. Beside it, the host's Google Flights sources
 *   (`FlightsToolOptions.sources`) answer the same search when Google Flights
 *   is on; each fare names its source, and each source says how it went —
 *   a source that could not be read is unavailable, never "no flights".
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

/** How Kiwi's fares and status name it. */
export const KIWI_SOURCE = "kiwi.com";

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
  /** Where the fare came from: `kiwi.com`, or a Google Flights source's id. */
  readonly source: string;
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
        source: KIWI_SOURCE,
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

/** What a source besides Kiwi answers a search with. */
export interface FlightSourceAnswer {
  readonly itineraries: readonly FlightItinerary[];
  /** How many it found before any were left out. */
  readonly found: number;
  /** The label its fares carry: untrusted, `search`, from where they came. */
  readonly label: ContentLabel;
  /** What the person should know of these fares, in a few words: how a round trip's return is chosen, which dates were asked. */
  readonly note?: string;
}

/** A source of fares besides Kiwi, answering the same search: Google Flights', through the host. */
export interface FlightSource {
  /** How its fares and status name it. */
  readonly id: string;
  /** Where its fares come from, kept with them as findings. */
  readonly url: string;
  /** Why it cannot answer this search (a city name where it takes airport codes, a round trip), else `undefined`. */
  readonly cannot?: (query: FlightsSearchInput) => string | undefined;
  /** Throws when the source cannot be read: it is unavailable, which is never "no flights". */
  readonly search: (query: FlightsSearchInput, signal: AbortSignal) => Promise<FlightSourceAnswer>;
}

/** How one source went for a search, as the answer reports it. */
export interface FlightSourceStatus {
  readonly source: string;
  readonly state: "ok" | "empty" | "unavailable" | "skipped";
  readonly found?: number;
  /** Its cheapest fare that fits, to compare the sources at a glance. */
  readonly cheapest?: number;
  readonly reason?: string;
  readonly note?: string;
}

export interface FlightsToolOptions {
  /**
   * Calls Kiwi's MCP tool `search-flight` with `kiwiArguments`, answering its content and label: the host's
   * MCP client over its guarded fetch, which this package never sees. A test's answers at once.
   */
  readonly search: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<McpToolResult>;
  /**
   * The Google Flights sources a workspace searches beside Kiwi while Google Flights is on in its settings:
   * the host's choice (with the person's SerpApi key, else Google's own page). Absent: Kiwi alone.
   */
  readonly sources?: (workspaceId: string) => Promise<readonly FlightSource[]>;
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

/** How many of each source's cheapest fares an answer keeps before the rest compete on price, so the sources can be compared. */
const PER_SOURCE = 3;

/** Said with every answer that has Kiwi's fares: whose prices they are. */
const KIWI_NOTE =
  "Fares from kiwi.com are a reseller's: they include Kiwi's own fee, and on the big airlines they often run well above the airline's own price or Google Flights'. Give the person the check links with them.";

/** The answer's itineraries: each source's cheapest first, then the rest by price (or flight time), within `limit`. */
export function mergeItineraries(
  bySource: readonly (readonly FlightItinerary[])[],
  limit: number,
  sort: FlightsSearchInput["sort"],
): FlightItinerary[] {
  const order = (a: FlightItinerary, b: FlightItinerary): number =>
    sort === "duration" ? a.totalHours - b.totalHours || a.price - b.price : a.price - b.price || a.totalHours - b.totalHours;
  const sorted = bySource.map((list) => [...list].sort(order));
  const kept = new Set(sorted.flatMap((list) => list.slice(0, Math.min(PER_SOURCE, Math.floor(limit / Math.max(1, sorted.length))))));
  const rest = sorted
    .flat()
    .filter((itinerary) => !kept.has(itinerary))
    .sort(order);
  return [...kept, ...rest].slice(0, limit).sort(order);
}

export function registerFlightsTools(registry: ToolRegistrar, options: FlightsToolOptions): void {
  const search = options.search;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly answer: McpToolResult | FlightSourceAnswer }>();
  const remember = (key: string, answer: McpToolResult | FlightSourceAnswer): void => {
    cache.set(key, { at: clock(), answer });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
  };
  const fresh = (key: string): McpToolResult | FlightSourceAnswer | undefined => {
    const hit = cache.get(key);
    return hit !== undefined && clock() - hit.at <= CACHE_MS ? hit.answer : undefined;
  };
  // A failed search's reason can be the server's words: labelled as its results are.
  const kiwiLabel = mcpResultLabel(new URL(KIWI_MCP_URL).host);
  /** The searches each task has kept the findings of: asking again keeps nothing twice. */
  const keptBy = new Set<string>();
  const browser = options.browser !== false;

  /** One source's outcome: its fitting fares (all of them), its status, and the label they carry. */
  interface Outcome {
    readonly itineraries: readonly FlightItinerary[];
    readonly status: FlightSourceStatus;
    /** Absent for a source that was not asked: nothing of it reached the answer. */
    readonly label?: ContentLabel;
    readonly url: string;
    readonly key: string;
  }

  const fromKiwi = async (query: FlightsSearchInput, signal: AbortSignal): Promise<Outcome> => {
    const args = kiwiArguments(query);
    const key = `${KIWI_SOURCE}\u0000${JSON.stringify(args)}`;
    const failed = (reason: string, label: ContentLabel): Outcome => ({
      itineraries: [],
      status: { source: KIWI_SOURCE, state: "unavailable", reason },
      label,
      url: KIWI_MCP_URL,
      key,
    });
    let answer = fresh(key) as McpToolResult | undefined;
    if (answer === undefined) {
      try {
        answer = await search(args, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return failed(`the search failed (${errorMessage(error)})`, kiwiLabel);
      }
    }
    const content = answer.content;
    const currency =
      typeof (content as { currency?: unknown })?.currency === "string"
        ? (content as { currency: string }).currency
        : (query.currency ?? "EUR");
    const all = itinerariesOf(content, currency);
    if (all === undefined) {
      // A source that answered with no search at all is broken, not empty: the person's limits stay as they are.
      const reason = (content as { error?: unknown } | undefined)?.error;
      return failed(
        `it gave no results list${typeof reason === "string" && reason !== "" ? ` (${reason.slice(0, 200)})` : ""}`,
        answer.label,
      );
    }
    remember(key, answer);
    // Whose prices these are is said once, at the answer's top (`note`).
    return outcomeOf(KIWI_SOURCE, KIWI_MCP_URL, key, all, all.length, answer.label, query, undefined);
  };

  const fromSource = async (source: FlightSource, query: FlightsSearchInput, signal: AbortSignal): Promise<Outcome> => {
    const key = `${source.id}\u0000${JSON.stringify(query)}`;
    // A failure's reason can be the source's words: labelled as its fares are, `search` from its host.
    const label = searchResultLabel(new URL(source.url).host);
    const cannot = source.cannot?.(query);
    if (cannot !== undefined)
      return { itineraries: [], status: { source: source.id, state: "skipped", reason: cannot }, url: source.url, key };
    let answer = fresh(key) as FlightSourceAnswer | undefined;
    if (answer === undefined) {
      try {
        answer = await source.search(query, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          itineraries: [],
          status: {
            source: source.id,
            state: "unavailable",
            reason: `it could not be read (${errorMessage(error)}): this says nothing of the flights`,
          },
          label,
          url: source.url,
          key,
        };
      }
      remember(key, answer);
    }
    return outcomeOf(source.id, source.url, key, answer.itineraries, answer.found, answer.label, query, answer.note);
  };

  const outcomeOf = (
    id: string,
    url: string,
    key: string,
    all: readonly FlightItinerary[],
    found: number,
    label: ContentLabel,
    query: FlightsSearchInput,
    note: string | undefined,
  ): Outcome => {
    const fitting = withinDuration(all, query.maxDurationHours);
    const cheapest = fitting.reduce<number | undefined>(
      (low, itinerary) => (low === undefined || itinerary.price < low ? itinerary.price : low),
      undefined,
    );
    return {
      itineraries: fitting,
      status: {
        source: id,
        state: fitting.length > 0 ? "ok" : "empty",
        found,
        ...(cheapest === undefined ? {} : { cheapest }),
        ...(all.length > fitting.length ? { reason: `${String(all.length - fitting.length)} over the maximum flight time` } : {}),
        ...(note === undefined ? {} : { note }),
      },
      label,
      url,
      key,
    };
  };

  registry.register({
    id: FLIGHT_SEARCH_TOOL_ID,
    sink: "search",
    // Ideas about trips are offered while it answers.
    proves: ["travel"],
    version: "1.1.0",
    description:
      "Search flights — one way or return, over date ranges each way, within a maximum flight time per direction — and answer with itineraries: airlines, flight numbers, times, layovers, durations, price, source and a booking link, cheapest first. " +
      "Fares come from Kiwi.com (a reseller, often dearer on the big airlines) and, where Google Flights is on, from Google Flights; `sources` says how each went. " +
      (browser
        ? "Use it before browsing for any flight question. Each answer has links to the same search on Google Flights and Kayak (`check`): give them to the person with the fares, and open one in the browser to confirm a fare. "
        : "Each answer has links to the same search on Google Flights and Kayak (`check`): give them to the person with the fares. ") +
      "Its itineraries are kept as the task's findings of kind flight, for findings.check.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    promptGuidance: browser
      ? "Domain tools first: for flights use `travel.flights_search` before browsing. Always give the person its `check.googleFlights` link with the fares, say which source each fare is from, and that Kiwi's are a reseller's; confirm a fare in the browser when asked or when every source fails."
      : "For flights use `travel.flights_search`. Always give the person its `check.googleFlights` link with the fares, say which source each fare is from, and that Kiwi's are a reseller's.",
    inputSchema: FlightsSearchInputSchema,
    assess: (input) => {
      const call = input as Partial<FlightsSearchInput>;
      return {
        display: {
          title: `Search flights ${String(call.from ?? "?")} → ${String(call.to ?? "?")}`,
          detail: "Sends the trip (places, dates, passengers) to Kiwi.com's flight search, and to Google Flights where that is on",
        },
        subjects: [],
        risk: "low",
        reasons: ["sends the trip to Kiwi.com's flight search and to Google Flights"],
        alwaysAnyCall: true,
        scopeGroup: "travel.*",
      };
    },
    // Fares, names and links are the sources' words.
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
      // The Google Flights back end off, its link and sources are left out and the fallback names another site.
      const check = settings.googleFlights ? links : (({ googleFlights: _off, ...rest }) => rest)(links);
      const browseAgain = !browser
        ? "give the person the check links to open themselves"
        : settings.googleFlights
          ? "open check.googleFlights with browser.create_session and read its results with browser.extract"
          : "browse another flight site (check.kayak when there is one) and read its results with browser.extract";
      const others = settings.googleFlights ? ((await options.sources?.(context.workspaceId)) ?? []) : [];
      const outcomes = await Promise.all([fromKiwi(query, signal), ...others.map((source) => fromSource(source, query, signal))]);
      if (signal.aborted) throw new TaviError("CANCELLED", "travel.flights_search was cancelled");
      const limit = query.limit ?? DEFAULT_RESULTS;
      const itineraries = mergeItineraries(
        outcomes.map((outcome) => outcome.itineraries),
        limit,
        query.sort,
      );
      // Fares, names and links are the sources': `search`, and where each came from (untrusted).
      const label = outcomes
        .flatMap((outcome) => (outcome.label === undefined ? [] : [outcome.label]))
        .reduce((joined, next) => joinLabels(joined, next));
      let keptFrom: number | undefined;
      let keptTo: number | undefined;
      for (const outcome of outcomes) {
        const records = itineraries.filter((itinerary) => outcome.itineraries.includes(itinerary));
        const keptKey = `${context.runId}\u0000${outcome.key}\u0000${String(limit)}`;
        if (options.findings === undefined || records.length === 0 || keptBy.has(keptKey)) continue;
        const rows = await options.findings.add({
          taskId: context.runId,
          workspaceId: context.workspaceId,
          kind: "flight",
          records,
          sourceUrl: outcome.url,
          createdAt: options.now(),
        });
        if (rows.length === 0) continue;
        keptBy.add(keptKey);
        if (keptBy.size > CACHE_MAX * 20) keptBy.delete(keptBy.values().next().value ?? "");
        keptFrom ??= rows[0]?.seq;
        keptTo = rows.at(-1)?.seq;
      }
      const statuses = outcomes.map((outcome) => outcome.status);
      const answered = statuses.some((status) => status.state === "ok" || status.state === "empty");
      const overDuration = statuses.some((status) => status.state === "empty" && (status.found ?? 0) > 0);
      return {
        itineraries,
        found: statuses.reduce((total, status) => total + (status.found ?? 0), 0),
        sources: statuses,
        check,
        ...(itineraries.some((itinerary) => itinerary.source === KIWI_SOURCE) ? { note: KIWI_NOTE } : {}),
        ...(keptFrom === undefined ? {} : { kept: { kind: "flight", from: keptFrom, to: keptTo } }),
        ...(itineraries.length > 0
          ? {}
          : {
              fallback: answered
                ? `no itinerary fits${overDuration ? " (some are over the maximum flight time)" : ""}: widen the dates or the duration, or ${browseAgain}`
                : `no flight source could be read (${statuses.map((status) => `${status.source}: ${status.reason ?? status.state}`).join("; ")}): ${browseAgain}`,
            }),
        [TOOL_LABEL_KEY]: { stored: label },
      };
    },
  });
}
