import { searchResultLabel, TaviError } from "@tavi/contracts";

import type { FetchLike } from "../mcp/client.js";
import { guardedFetch } from "../mcp/fetch.js";
import type { FlightItinerary, FlightSource, FlightsSearchInput } from "./host.js";

/**
 * Google Flights' own search page as a free source of one-way fares, no key:
 * the approach of fli (github.com/punitarani/fli, MIT), written for Node.
 * Google's search page inlines a one-way search's results in its `ds:1` data
 * blob; a round trip's it loads afterwards through a request only the page's
 * own script can sign, so a round trip is asked each way, its fares a reference
 * beside Kiwi's (`oneWayOnly`), and priced whole only through SerpApi. A page
 * that comes back without the blob, or rows that no longer read, mean the
 * page changed: the source is unavailable, never "no flights".
 */

const GOOGLE_PAGE_SOURCE = "google-flights";
const PAGE_URL = "https://www.google.com/travel/flights";
/** The page runs to about 2 MB; a page past this is not the search page. */
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/**
 * Google's consent cookie, already answered: from the EU/EEA the page is
 * otherwise a consent step with no results (fli's value, `FLI_SOCS_COOKIE`).
 */
const CONSENT_COOKIE = "SOCS=CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMzE3LjA5X3AwGgJlbiADGgYIgLC_rwY";
/** The page is served to a browser: a plain client gets a different one. */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const IATA = /^[A-Za-z]{3}$/;
const CABINS: Readonly<Record<NonNullable<FlightsSearchInput["cabin"]>, number>> = { economy: 1, premium: 2, business: 3, first: 4 };

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
};
const varintField = (field: number, value: number): number[] => [...varint(field << 3), ...varint(value)];
const bytesField = (field: number, value: readonly number[]): number[] => [...varint((field << 3) | 2), ...varint(value.length), ...value];
const text = (value: string): number[] => [...Buffer.from(value, "utf8")];

/** The page's `tfs` parameter for a one-way search: base64url protobuf, as Google's own links carry it. */
export function oneWayTfs(query: FlightsSearchInput): string {
  const segment = [
    ...bytesField(2, text(query.departDate)),
    ...(query.maxStops === undefined ? [] : varintField(5, query.maxStops)),
    ...bytesField(13, [...varintField(1, 1), ...bytesField(2, text(query.from.toUpperCase()))]),
    ...bytesField(14, [...varintField(1, 1), ...bytesField(2, text(query.to.toUpperCase()))]),
  ];
  const payload = [
    ...varintField(1, 28),
    ...varintField(2, 2),
    ...bytesField(3, segment),
    ...Array.from({ length: query.adults ?? 1 }, () => varintField(8, 1)).flat(),
    ...varintField(9, CABINS[query.cabin ?? "economy"]),
    ...varintField(14, 1),
    // 2: one way.
    ...varintField(19, 2),
  ];
  return Buffer.from(payload).toString("base64url");
}

/** The search page's address for a one-way search. */
export function pageUrl(query: FlightsSearchInput): string {
  return `${PAGE_URL}?tfs=${oneWayTfs(query)}&hl=en&curr=${query.currency ?? "EUR"}`;
}

/** The page's `ds:1` data, or `undefined` where it has none (a consent step, a changed page). */
function pagePayload(html: string): unknown {
  for (const match of html.matchAll(/AF_initDataCallback\((\{.*?\})\);/gs)) {
    const blob = match[1] ?? "";
    if (!/key:\s*'ds:1'/.test(blob)) continue;
    const data = /data:(.*?), sideChannel/s.exec(blob)?.[1];
    if (data === undefined) return undefined;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const at = (value: unknown, ...path: number[]): unknown =>
  path.reduce<unknown>((node, index) => (Array.isArray(node) ? (node as unknown[])[index] : undefined), value);
const pad = (value: unknown): string => String(typeof value === "number" ? value : 0).padStart(2, "0");
/** `[y, m, d]` and `[h, m]` as `YYYY-MM-DDTHH:MM:00`. */
const stamp = (date: unknown, time: unknown): string =>
  Array.isArray(date) && date.length === 3 && typeof date[0] === "number"
    ? `${String(date[0])}-${pad(date[1])}-${pad(date[2])}T${pad(at(time, 0))}:${pad(at(time, 1))}:00`
    : "";
const hoursOf = (minutes: unknown): number => (typeof minutes === "number" ? Math.round((minutes / 60) * 10) / 10 : Number.NaN);

/** One result row as an itinerary; `undefined` for a row without a price or flights (an advert, a half row). */
function rowItinerary(row: unknown, currency: string, link: string): FlightItinerary | undefined {
  const price = at(row, 1, 0);
  const amount = Array.isArray(price) ? price.at(-1) : undefined;
  const legs = at(row, 0, 2);
  if (typeof amount !== "number" || !Array.isArray(legs) || legs.length === 0) return undefined;
  const airports = (legs as unknown[]).flatMap((leg, index) => [...(index === 0 ? [at(leg, 3)] : []), at(leg, 6)]);
  if (!airports.every((code) => typeof code === "string")) return undefined;
  const names = at(row, 0, 1);
  const airlines = Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  const first = legs[0];
  const last = legs.at(-1);
  const minutes = at(row, 0, 9);
  return {
    source: GOOGLE_PAGE_SOURCE,
    price: amount,
    currency,
    airlines,
    outbound: {
      route: (airports as string[]).join(" → "),
      departure: stamp(at(first, 20), at(first, 8)),
      arrival: stamp(at(last, 21), at(last, 10)),
      hours: hoursOf(minutes),
      stops: legs.length - 1,
      flights: (legs as unknown[]).flatMap((leg) => {
        const code = at(leg, 22, 0);
        const number = at(leg, 22, 1);
        const name = at(leg, 22, 3);
        return typeof code === "string" && typeof number === "string"
          ? [`${code}${number}${typeof name === "string" && name !== "" ? ` ${name}` : ""}`]
          : [];
      }),
    },
    totalHours: hoursOf(minutes),
    bookingUrl: link,
  };
}

/** The page's results as itineraries. Throws where the page carries none to read: it changed, or was not the search page. */
export function pageItineraries(
  html: string,
  currency: string,
  link: string,
): { readonly itineraries: FlightItinerary[]; readonly found: number } {
  const payload = pagePayload(html);
  if (!Array.isArray(payload))
    throw new TaviError("UNAVAILABLE", "Google Flights' page carried no results data (a consent step, or the page changed)");
  const rows = [2, 3].flatMap((index) => {
    const list = at(payload, index, 0);
    return Array.isArray(list) ? (list as unknown[]) : [];
  });
  const itineraries = rows.flatMap((row) => {
    const itinerary = rowItinerary(row, currency, link);
    return itinerary === undefined ? [] : [itinerary];
  });
  if (rows.length > 0 && itineraries.length === 0)
    throw new TaviError("UNAVAILABLE", `none of Google Flights' ${String(rows.length)} results could be read (the page changed)`);
  return { itineraries, found: itineraries.length };
}

/**
 * Google Flights' page as a `FlightSource`: one-way fares between airport
 * codes, one date (the first of a range), over the guarded fetch.
 */
export function googlePageSource(options: { readonly fetch?: FetchLike } = {}): FlightSource {
  const fetch = options.fetch ?? guardedFetch({ lan: false });
  return {
    id: GOOGLE_PAGE_SOURCE,
    url: PAGE_URL,
    cannot: (query) => (!IATA.test(query.from) || !IATA.test(query.to) ? "it takes airport codes (SOF), not place names" : undefined),
    oneWayOnly:
      "Google's page lists one-way fares only, so its fares each way are in oneWayFares; with a SerpApi key (Settings → General → Flight search), round trips are priced on Google Flights too",
    search: async (query, signal) => {
      const url = pageUrl(query);
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, "accept-language": "en", cookie: CONSENT_COOKIE },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!response.ok) throw new TaviError("UNAVAILABLE", `Google Flights answered HTTP ${String(response.status)}`);
      const html = await response.text();
      if (html.length > MAX_BYTES) throw new TaviError("UNAVAILABLE", "Google Flights' page was larger than a search page");
      const read = pageItineraries(html, query.currency ?? "EUR", url);
      return {
        ...read,
        label: searchResultLabel(new URL(PAGE_URL).host),
        ...(query.departDateTo === undefined ? {} : { note: `one-way fares on ${query.departDate} only, the first date of the range` }),
      };
    },
  };
}
