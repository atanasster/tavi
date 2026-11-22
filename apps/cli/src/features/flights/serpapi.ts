import { searchResultLabel, TaviError } from "@tavi/contracts";

import type { FetchLike } from "../mcp/client.js";
import { guardedFetch } from "../mcp/fetch.js";
import type { FlightItinerary, FlightSource, FlightsSearchInput } from "./host.js";

/**
 * Google Flights through SerpApi (serpapi.com), with the person's own key:
 * one-way and round trips, the fares Google Flights shows. Its free plan has
 * 250 searches a month; each search here is one. `deep_search` asks for the
 * same results the browser gets (SerpApi's default can miss the cheapest).
 * A round trip's fares are the whole trip's price for the outbound flights
 * listed; the return is chosen on Google Flights, through the answer's link.
 */

export const SERPAPI_SOURCE = "google-flights (serpapi)";
const ENDPOINT = "https://serpapi.com/search.json";
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const IATA = /^[A-Za-z]{3}$/;
const CLASSES: Readonly<Record<NonNullable<FlightsSearchInput["cabin"]>, string>> = {
  economy: "1",
  premium: "2",
  business: "3",
  first: "4",
};

/** SerpApi's query for the search: the first date of each range, the key apart (`api_key`, added at the call). */
export function serpApiParameters(query: FlightsSearchInput): URLSearchParams {
  const parameters = new URLSearchParams({
    engine: "google_flights",
    departure_id: query.from.toUpperCase(),
    arrival_id: query.to.toUpperCase(),
    outbound_date: query.departDate,
    type: query.returnDate === undefined ? "2" : "1",
    currency: query.currency ?? "EUR",
    hl: "en",
    adults: String(query.adults ?? 1),
    travel_class: CLASSES[query.cabin ?? "economy"],
    deep_search: "true",
  });
  if (query.returnDate !== undefined) parameters.set("return_date", query.returnDate);
  // SerpApi's stops: 1 non-stop, 2 one stop or fewer, 3 two or fewer; 0 any.
  if (query.maxStops !== undefined && query.maxStops <= 2) parameters.set("stops", String(query.maxStops + 1));
  return parameters;
}

interface SerpFlight {
  readonly departure_airport?: { readonly id?: unknown; readonly time?: unknown };
  readonly arrival_airport?: { readonly id?: unknown; readonly time?: unknown };
  readonly airline?: unknown;
  readonly flight_number?: unknown;
}
interface SerpOption {
  readonly flights?: unknown;
  readonly total_duration?: unknown;
  readonly price?: unknown;
}

/** `2026-11-25 06:25` as `2026-11-25T06:25:00`. */
const stamp = (time: unknown): string =>
  typeof time === "string" && /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(time)
    ? `${time.replace(" ", "T").replace(/T(\d):/, "T0$1:")}:00`
    : "";
const hoursOf = (minutes: unknown): number => (typeof minutes === "number" ? Math.round((minutes / 60) * 10) / 10 : Number.NaN);

/** SerpApi's answer as itineraries: its best and other flights, those without a price or flights left out. */
export function serpApiItineraries(answer: unknown, currency: string, link: string): FlightItinerary[] {
  const body = (typeof answer === "object" && answer !== null ? answer : {}) as { best_flights?: unknown; other_flights?: unknown };
  const options = [body.best_flights, body.other_flights].flatMap((list) => (Array.isArray(list) ? (list as SerpOption[]) : []));
  return options.flatMap((option): FlightItinerary[] => {
    const flights = Array.isArray(option.flights) ? (option.flights as SerpFlight[]) : [];
    if (typeof option.price !== "number" || flights.length === 0) return [];
    const codes = [flights[0]?.departure_airport?.id, ...flights.map((flight) => flight.arrival_airport?.id)];
    if (!codes.every((code) => typeof code === "string")) return [];
    const airlines = [...new Set(flights.map((flight) => flight.airline).filter((name): name is string => typeof name === "string"))];
    return [
      {
        source: SERPAPI_SOURCE,
        price: option.price,
        currency,
        airlines,
        outbound: {
          route: (codes as string[]).join(" → "),
          departure: stamp(flights[0]?.departure_airport?.time),
          arrival: stamp(flights.at(-1)?.arrival_airport?.time),
          hours: hoursOf(option.total_duration),
          stops: flights.length - 1,
          flights: flights.flatMap((flight) =>
            typeof flight.flight_number === "string"
              ? [`${flight.flight_number.replace(/\s+/g, "")}${typeof flight.airline === "string" ? ` ${flight.airline}` : ""}`]
              : [],
          ),
        },
        totalHours: hoursOf(option.total_duration),
        bookingUrl: link,
      },
    ];
  });
}

/** SerpApi's "no results" answer: an empty search, not a failure. */
const NO_RESULTS = /hasn't returned any results/i;

/**
 * Google Flights through SerpApi as a `FlightSource`, with `key()` read at
 * each search (the stored credential): airport codes only, one date each
 * way, over the guarded fetch. The key never appears in what it answers.
 */
export function serpApiSource(options: { readonly key: () => Promise<string | undefined>; readonly fetch?: FetchLike }): FlightSource {
  const fetch = options.fetch ?? guardedFetch({ lan: false });
  return {
    id: SERPAPI_SOURCE,
    url: ENDPOINT,
    cannot: (query) => (!IATA.test(query.from) || !IATA.test(query.to) ? "it takes airport codes (SOF), not place names" : undefined),
    search: async (query, signal) => {
      const key = (await options.key())?.trim();
      if (key === undefined || key === "") throw new TaviError("UNAVAILABLE", "no SerpApi key is stored (tavi credentials set serpapi)");
      const parameters = serpApiParameters(query);
      parameters.set("api_key", key);
      let response: Response;
      try {
        response = await fetch(`${ENDPOINT}?${parameters.toString()}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        // The address carries the key: the reason never names it.
        throw new TaviError("UNAVAILABLE", `SerpApi could not be reached (${error instanceof Error ? error.name : "network error"})`);
      }
      const raw = await response.text();
      if (raw.length > MAX_BYTES) throw new TaviError("UNAVAILABLE", "SerpApi's answer was too large");
      let answer: { error?: unknown; search_metadata?: { google_flights_url?: unknown } } = {};
      try {
        answer = JSON.parse(raw) as typeof answer;
      } catch {
        throw new TaviError("UNAVAILABLE", `SerpApi answered HTTP ${String(response.status)} without JSON`);
      }
      const label = searchResultLabel(new URL(ENDPOINT).host);
      const failure = typeof answer.error === "string" ? answer.error.replaceAll(key, "<key>").slice(0, 200) : undefined;
      if (failure !== undefined && NO_RESULTS.test(failure)) return { itineraries: [], found: 0, label };
      if (!response.ok || failure !== undefined)
        throw new TaviError("UNAVAILABLE", `SerpApi: ${failure ?? `HTTP ${String(response.status)}`}`);
      const search = answer.search_metadata?.google_flights_url;
      const link =
        typeof search === "string" && /^https:\/\/www\.google\.com\//.test(search) ? search : "https://www.google.com/travel/flights";
      const itineraries = serpApiItineraries(answer, query.currency ?? "EUR", link);
      const ranges = query.departDateTo !== undefined || query.returnDateTo !== undefined;
      const notes = [
        ...(query.returnDate === undefined
          ? []
          : ["round-trip prices for the outbound flights listed; the return is chosen on Google Flights (bookingUrl)"]),
        ...(ranges
          ? [
              `asked for ${query.departDate}${query.returnDate === undefined ? "" : ` and ${query.returnDate}`} only, the first date of each range`,
            ]
          : []),
      ];
      return { itineraries, found: itineraries.length, label, ...(notes.length === 0 ? {} : { note: notes.join("; ") }) };
    },
  };
}
