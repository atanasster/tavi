import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  newYorkFloating,
  nyc311,
  nycDob,
  open311Adapter,
  Open311CitySchema,
  policeUk,
  type CivicFetch,
  type SourceCall,
} from "../src/index.js";
import type { PlacesRequest } from "../src/sources/types.js";

const NOW = "2026-10-17T10:00:00.000Z";
const json = (name: string): unknown => JSON.parse(readFileSync(join(domainFixtures("places"), "civic", name), "utf8"));
const call: SourceCall = { credential: () => undefined, userAgent: "Tavi-places/test", now: NOW };
function fetcher(body: unknown): { readonly fetch: CivicFetch; readonly asked: PlacesRequest[] } {
  const asked: PlacesRequest[] = [];
  return { asked, fetch: async (request) => (asked.push(request), { status: 200, body }) };
}
const village = { point: { lat: 40.7301, lon: -73.9902 }, radiusKm: 0.5, since: "2026-09-17T10:00:00.000Z" };

describe("neighbourhood sources", () => {
  it("NYC 311: within a circle of the point rounded to 3 decimals, kinds and dates only", async () => {
    const net = fetcher(json("nyc-311-e-village.json"));
    const outcome = await nyc311.run(village, call, net.fetch);
    expect(decodeURIComponent(net.asked[0]?.url ?? "")).toContain(
      "$where=within_circle(location, 40.73, -73.99, 500) AND created_date > '2026-09-17T06:00:00'",
    );
    expect(net.asked[0]?.area).toMatchObject({ point: { lat: 40.73, lon: -73.99 }, precisionDecimals: 3 });
    expect(outcome).toMatchObject({
      kind: "ok",
      report: {
        topic: "complaints",
        items: expect.arrayContaining([
          { kind: "Noise - Commercial: Loud Talking", status: "Closed", at: "2026-10-16", distanceKm: expect.any(Number) },
        ]),
      },
    });
    expect(nyc311.covers({ lat: 40.73, lon: -73.99 }, "US")).toBe(true);
    expect(nyc311.covers({ lat: 51.5, lon: -0.1 }, "GB")).toBe(false);
  });

  it("NYC permits: a box around the point, narrowed to the radius; the work type, never the filing's own words", async () => {
    const net = fetcher(json("nyc-dob-now-e-village.json"));
    const outcome = await nycDob.run(village, call, net.fetch);
    expect(decodeURIComponent(net.asked[0]?.url ?? "")).toMatch(
      /latitude between 40\.725\d and 40\.734\d AND longitude between -73\.99\d+ and -73\.98\d+ AND issued_date >= '2026-09-17T00:00:00'/,
    );
    const items = outcome.kind === "ok" ? outcome.report.items : [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.distanceKm <= 0.5)).toBe(true);
    expect(JSON.stringify(outcome)).not.toMatch(/Intuit|Propose removal/);
  });

  it("data.police.uk: the latest month's crimes within the radius, by category", async () => {
    const net = fetcher(json("police-uk-shoreditch.json"));
    const outcome = await policeUk.run(
      { point: { lat: 51.5234, lon: -0.0776 }, radiusKm: 0.5, since: "2026-09-17T10:00:00.000Z" },
      call,
      net.fetch,
    );
    // Within 0.8 km, the point is rounded to about a kilometre: the service's mile still holds the radius.
    expect(net.asked[0]?.url).toBe("https://data.police.uk/api/crimes-street/all-crime?lat=51.52&lng=-0.08");
    expect(outcome).toMatchObject({ kind: "ok", report: { topic: "crime", period: "2026-08" } });
    const items = outcome.kind === "ok" ? outcome.report.items : [];
    expect(items.every((item) => item.distanceKm <= 0.5 && !item.kind.includes("-"))).toBe(true);
    expect(JSON.stringify(outcome)).not.toMatch(/On or near/);
  });

  it("data.police.uk: a wider radius sends a finer point; no crime in a whole mile is said to be no data", async () => {
    const wide = fetcher(json("police-uk-shoreditch.json"));
    await policeUk.run({ point: { lat: 51.5234, lon: -0.0776 }, radiusKm: 1.5, since: "2026-09-17T10:00:00.000Z" }, call, wide.fetch);
    expect(wide.asked[0]?.url).toBe("https://data.police.uk/api/crimes-street/all-crime?lat=51.523&lng=-0.078");
    expect(
      await policeUk.run({ point: { lat: 55.95, lon: -3.19 }, radiusKm: 0.5, since: "2026-09-17T10:00:00.000Z" }, call, fetcher([]).fetch),
    ).toMatchObject({ kind: "ok", report: { items: [], caveat: expect.stringMatching(/no data, not no crime/) } });
    expect(
      await policeUk.run(
        { point: { lat: 51.52, lon: -0.08 }, radiusKm: 0.5, since: "2026-09-17T10:00:00.000Z" },
        call,
        fetcher([{ nope: 1 }, { nope: 2 }]).fetch,
      ),
    ).toMatchObject({ kind: "drift" });
  });

  it("NYC: Socrata's floating time is New York's; its token rides in a header; a full page says there are more; New Jersey is not New York", async () => {
    expect(newYorkFloating("2026-01-15T12:00:00.000Z")).toBe("2026-01-15T07:00:00");
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      complaint_type: "Noise",
      created_date: "2026-10-16T01:00:00.000",
      latitude: "40.7301",
      longitude: String(-73.9902 + index * 1e-6),
    }));
    const net = fetcher(rows);
    const outcome = await nyc311.run(
      village,
      { ...call, credential: (key) => (key === "socrataAppToken" ? "token" : undefined) },
      net.fetch,
    );
    expect(net.asked[0]?.headers).toEqual({ "X-App-Token": "token" });
    expect(outcome).toMatchObject({ report: { caveat: expect.stringMatching(/at least this many/) } });
    expect([
      nyc311.covers({ lat: 40.72, lon: -74.04 }, "US"),
      nyc311.covers({ lat: 40.74, lon: -74.03 }, "US"),
      nyc311.covers({ lat: 40.58, lon: -74.15 }, "US"),
      nyc311.covers({ lat: 40.85, lon: -73.97 }, "US"),
      nyc311.covers({ lat: 40.85, lon: -73.93 }, "US"),
    ]).toEqual([false, false, true, false, true]);
  });

  it("an Open311 city: its requests within the radius and window, never their descriptions, addresses or photos", async () => {
    const sf = open311Adapter(
      Open311CitySchema.parse({
        id: "sf",
        name: "San Francisco",
        country: "US",
        endpoint: "https://mobile311.sfgov.org/open311/v2",
        box: { south: 37.7, west: -122.52, north: 37.84, east: -122.35 },
        reviewedAt: "2026-10-17",
      }),
    );
    expect(sf.record).toMatchObject({ id: "open311-sf", hosts: ["mobile311.sfgov.org"] });
    const net = fetcher(json("open311-sf.json"));
    const outcome = await sf.run(
      { point: { lat: 37.7814, lon: -122.4062 }, radiusKm: 1, since: "2026-10-01T00:00:00.000Z" },
      call,
      net.fetch,
    );
    // The server ignores a point, so none is sent; its answer is a sample of the city's latest, and says so.
    expect(net.asked[0]?.url).toBe("https://mobile311.sfgov.org/open311/v2/requests.json?start_date=2026-10-01T00%3A00%3A00Z");
    expect(net.asked[0]?.area).toBeUndefined();
    expect(outcome).toMatchObject({
      report: { caveat: expect.stringMatching(/^a sample: San Francisco's server answers its latest 15 requests citywide/) },
    });
    const items = outcome.kind === "ok" ? outcome.report.items : [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.distanceKm <= 1)).toBe(true);
    expect(JSON.stringify(outcome)).not.toMatch(/cloudinary|Natoma|parked in white zone/);
  });
});
