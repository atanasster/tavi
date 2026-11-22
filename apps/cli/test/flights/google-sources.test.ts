import { readFileSync } from "node:fs";

import type { FlightsSearchInput } from "@tavi/plugin-flights";
import { describe, expect, it } from "vitest";

import { googlePageSource, oneWayTfs, pageItineraries, pageUrl } from "../../src/features/flights/google-page.js";
import { googleFlightsSources } from "../../src/features/flights/host.js";
import { serpApiItineraries, serpApiParameters, serpApiSource, SERPAPI_SOURCE } from "../../src/features/flights/serpapi.js";

/**
 * Google Flights beside Kiwi: Google's own page for one-way trips, free, and
 * SerpApi with the person's key for round trips too — chosen by whether the
 * key is stored, and never "no flights" where a source could not be read.
 */

const PAGE = readFileSync(new URL("../fixtures/flights/google-one-way-sof-tpa.html", import.meta.url), "utf8");
const oneWay: FlightsSearchInput = { from: "SOF", to: "TPA", departDate: "2026-11-25" };
const roundTrip: FlightsSearchInput = { ...oneWay, returnDate: "2027-02-07" };
const signal = new AbortController().signal;

/** A fetch that answers `body` with `status`, keeping what it was asked. */
function fakeFetch(body: string, status = 200) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    asked.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(body, { status });
  };
  return { fetch, asked };
}

describe("Google Flights' page", () => {
  it("addresses a one-way search by the tfs Google's own links carry", () => {
    // The value fli builds for the same search.
    expect(oneWayTfs(oneWay)).toBe("CBwQAhoeEgoyMDI2LTExLTI1agcIARIDU09GcgcIARIDVFBBQAFIAXABmAEC");
    expect(pageUrl({ ...oneWay, currency: "USD" })).toBe(
      "https://www.google.com/travel/flights?tfs=CBwQAhoeEgoyMDI2LTExLTI1agcIARIDU09GcgcIARIDVFBBQAFIAXABmAEC&hl=en&curr=USD",
    );
  });

  it("reads the page's results as itineraries, and calls a page without them unavailable", () => {
    const read = pageItineraries(PAGE, "EUR", "https://www.google.com/travel/flights?tfs=x");
    expect(read.found).toBeGreaterThan(0);
    expect(read.itineraries[0]).toMatchObject({
      source: "google-flights",
      price: 814,
      currency: "EUR",
      airlines: ["Lufthansa", "Discover Airlines"],
      outbound: {
        route: "SOF → FRA → TPA",
        departure: "2026-11-25T06:25:00",
        stops: 1,
        flights: ["LH1431 Lufthansa", expect.stringMatching(/^4Y/)],
      },
      bookingUrl: "https://www.google.com/travel/flights?tfs=x",
    });
    expect(read.itineraries[0]?.outbound.hours).toBeCloseTo(17.2, 1);
    expect(() => pageItineraries("<html>Before you continue to Google</html>", "EUR", "x")).toThrow(/no results data/);
    // Rows that no longer read are a changed page, not an empty search.
    const changed = "AF_initDataCallback({key: 'ds:1', hash: '2', data:[null,null,[[[1],[2]]]], sideChannel: {}});";
    expect(() => pageItineraries(changed, "EUR", "x")).toThrow(/none of Google Flights' 2 results could be read/);
  });

  it("answers one-way trips between airport codes, sending the consent answer, and leaves round trips to the others", async () => {
    const { fetch, asked } = fakeFetch(PAGE);
    const source = googlePageSource({ fetch });
    expect(source.cannot?.(roundTrip)).toBeUndefined();
    expect(source.oneWayOnly).toMatch(/one-way fares only.*SerpApi key/);
    expect(source.cannot?.({ ...oneWay, from: "Sofia" })).toMatch(/airport codes/);
    expect(source.cannot?.(oneWay)).toBeUndefined();
    const answer = await source.search({ ...oneWay, departDateTo: "2026-11-27" }, signal);
    expect(answer.itineraries.length).toBeGreaterThan(0);
    expect(answer.note).toContain("first date of the range");
    expect(answer.label).toMatchObject({ integrity: "untrusted", sources: ["search"], principals: ["tool:www.google.com"] });
    expect(asked[0]?.url).toBe(pageUrl(oneWay));
    expect(asked[0]?.headers["cookie"]).toMatch(/^SOCS=/);
    await expect(googlePageSource({ fetch: fakeFetch("", 429).fetch }).search(oneWay, signal)).rejects.toThrow(/HTTP 429/);
  });
});

const serpAnswer = {
  search_metadata: { status: "Success", google_flights_url: "https://www.google.com/travel/flights?hl=en&tfs=abc" },
  best_flights: [
    {
      flights: [
        {
          departure_airport: { id: "SOF", time: "2026-11-25 6:00" },
          arrival_airport: { id: "FRA", time: "2026-11-25 7:30" },
          airline: "Lufthansa",
          flight_number: "LH 1427",
        },
        {
          departure_airport: { id: "FRA", time: "2026-11-25 10:15" },
          arrival_airport: { id: "IAD", time: "2026-11-25 13:40" },
          airline: "United",
          flight_number: "UA 989",
        },
        {
          departure_airport: { id: "IAD", time: "2026-11-25 16:00" },
          arrival_airport: { id: "TPA", time: "2026-11-25 18:07" },
          airline: "United",
          flight_number: "UA 1734",
        },
      ],
      total_duration: 1147,
      price: 947,
    },
  ],
  other_flights: [
    { flights: [], price: 900 },
    { flights: [{ departure_airport: { id: "SOF" } }], price: "cheap" },
  ],
};

describe("Google Flights through SerpApi", () => {
  it("asks for the trip in SerpApi's terms, deep search on, the first date of each range", () => {
    const parameters = serpApiParameters({
      ...roundTrip,
      returnDateTo: "2027-02-14",
      maxStops: 1,
      cabin: "business",
      adults: 2,
      currency: "USD",
    });
    expect(Object.fromEntries(parameters)).toEqual({
      engine: "google_flights",
      departure_id: "SOF",
      arrival_id: "TPA",
      outbound_date: "2026-11-25",
      return_date: "2027-02-07",
      type: "1",
      currency: "USD",
      hl: "en",
      adults: "2",
      travel_class: "3",
      deep_search: "true",
      stops: "2",
    });
    expect(serpApiParameters(oneWay).get("type")).toBe("2");
    expect(serpApiParameters({ ...oneWay, maxStops: 4 }).has("stops")).toBe(false);
  });

  it("reads best and other flights, leaving out those without a price or flights", () => {
    const itineraries = serpApiItineraries(serpAnswer, "EUR", "https://www.google.com/travel/flights?tfs=abc");
    expect(itineraries).toEqual([
      {
        source: SERPAPI_SOURCE,
        price: 947,
        currency: "EUR",
        airlines: ["Lufthansa", "United"],
        outbound: {
          route: "SOF → FRA → IAD → TPA",
          departure: "2026-11-25T06:00:00",
          arrival: "2026-11-25T18:07:00",
          hours: 19.1,
          stops: 2,
          flights: ["LH1427 Lufthansa", "UA989 United", "UA1734 United"],
        },
        totalHours: 19.1,
        bookingUrl: "https://www.google.com/travel/flights?tfs=abc",
      },
    ]);
  });

  it("searches with the stored key, says a round trip's return is chosen on Google, and never shows the key", async () => {
    const { fetch, asked } = fakeFetch(JSON.stringify(serpAnswer));
    const source = serpApiSource({ key: async () => " sk-test-123 ", fetch });
    const answer = await source.search(roundTrip, signal);
    expect(answer.itineraries.map((itinerary) => itinerary.price)).toEqual([947]);
    expect(answer.note).toContain("the return is chosen on Google Flights");
    expect(new URL(asked[0]?.url ?? "").searchParams.get("api_key")).toBe("sk-test-123");
    // SerpApi's "no results" is an empty search; any other error is the source unavailable, without the key.
    const empty = serpApiSource({
      key: async () => "k",
      fetch: fakeFetch(JSON.stringify({ error: "Google Flights hasn't returned any results for this query." })).fetch,
    });
    expect(await empty.search(oneWay, signal)).toMatchObject({ itineraries: [], found: 0 });
    const refused = serpApiSource({
      key: async () => "sk-secret",
      fetch: fakeFetch(JSON.stringify({ error: "Invalid API key sk-secret." }), 401).fetch,
    });
    await expect(refused.search(oneWay, signal)).rejects.toThrow("SerpApi: Invalid API key <key>.");
    await expect(serpApiSource({ key: async () => undefined, fetch }).search(oneWay, signal)).rejects.toThrow(/no SerpApi key is stored/);
    expect(source.cannot?.({ ...oneWay, to: "Tampa" })).toMatch(/airport codes/);
  });
});

describe("which Google Flights source a search asks", () => {
  it("is SerpApi while the key is stored, else Google's page; an unreadable store is no key", async () => {
    let stored: string | null = null;
    let broken = false;
    const sources = googleFlightsSources({
      secret: async () => {
        if (broken) throw new Error("keychain locked");
        return stored;
      },
      fetch: fakeFetch("").fetch,
    });
    expect((await sources()).map((source) => source.id)).toEqual(["google-flights"]);
    stored = "sk-1";
    expect((await sources()).map((source) => source.id)).toEqual([SERPAPI_SOURCE]);
    stored = "  ";
    expect((await sources()).map((source) => source.id)).toEqual(["google-flights"]);
    broken = true;
    expect((await sources()).map((source) => source.id)).toEqual(["google-flights"]);
  });
});

describe("Google Flights' page, live", () => {
  it.skipIf(process.env["TAVI_LIVE_NETWORK"] !== "1")(
    "reads a real one-way search",
    async () => {
      const departDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const answer = await googlePageSource().search({ from: "SOF", to: "LHR", departDate }, signal);
      expect(answer.itineraries.length).toBeGreaterThan(0);
      expect(answer.itineraries.every((itinerary) => itinerary.price > 0 && itinerary.outbound.route.startsWith("SOF"))).toBe(true);
    },
    60_000,
  );
});
