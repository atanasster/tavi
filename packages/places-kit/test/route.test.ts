import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  corridorLine,
  customRoutingRecord,
  distanceKm,
  interpolate,
  lineLengthKm,
  orsRouteRequest,
  overpass,
  overpassAlong,
  overpassAlongQuery,
  osrmRouteRequest,
  parseOrsRoute,
  parseOsrmRoute,
  positionOnLine,
  ROUTING_EXCLUDED_HOSTS,
  splitLine,
  thinLine,
  type SourceCall,
} from "../src/index.js";

const NOW = "2026-10-17T12:00:00.000Z";
const fixture = (path: string): unknown => JSON.parse(readFileSync(join(domainFixtures("places"), path), "utf8"));
const call: SourceCall = { credential: () => undefined, userAgent: "Tavi-places/test", now: NOW };
const austin = { lat: 30.2701204, lon: -97.7429667 };
const sanAntonio = { lat: 29.4246002, lon: -98.4951405 };

describe("a route's line", () => {
  it("follows the great circle, a point at least every spacing, ends kept", () => {
    expect(interpolate({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, 0.5)).toEqual({ lat: 0, lon: expect.closeTo(5, 9) });
    const line = corridorLine([austin, sanAntonio], 10);
    expect(line[0]).toEqual(austin);
    expect(line.at(-1)?.lat).toBeCloseTo(sanAntonio.lat, 9);
    expect(line.length).toBe(Math.ceil(distanceKm(austin, sanAntonio) / 10) + 1);
    expect(lineLengthKm(line)).toBeCloseTo(distanceKm(austin, sanAntonio), 6);
    // A via point bends it.
    expect(lineLengthKm(corridorLine([austin, { lat: 29.88, lon: -97.94 }, sanAntonio], 10))).toBeGreaterThan(
      distanceKm(austin, sanAntonio),
    );
  });

  it("thins and splits a line, keeping its ends and its pieces joined", () => {
    const line = corridorLine([austin, sanAntonio], 1);
    const thin = thinLine(line, 20);
    expect(thin.length).toBeLessThanOrEqual(20);
    expect([thin[0], thin.at(-1)]).toEqual([line[0], line.at(-1)]);
    const pieces = splitLine(line, 3);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]?.at(-1)).toEqual(pieces[1]?.[0]);
    expect(pieces.reduce((total, piece) => total + lineLengthKm(piece), 0)).toBeCloseTo(lineLengthKm(line), 6);
  });

  it("places a point along the line and off it", () => {
    const equator = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ];
    const position = positionOnLine({ lat: 0.01, lon: 0.5 }, equator);
    expect(position.alongKm).toBeCloseTo(55.6, 0);
    expect(position.offKm).toBeCloseTo(1.11, 1);
    // Past the end: the end is nearest.
    expect(positionOnLine({ lat: 0, lon: 1.1 }, equator)).toMatchObject({
      alongKm: expect.closeTo(111.2, 0),
      offKm: expect.closeTo(11.1, 0),
    });
  });
});

describe("routers", () => {
  it("asks OpenRouteService only with a key, in its header, each point rounded", () => {
    expect(orsRouteRequest([austin, sanAntonio], call)).toBeUndefined();
    const request = orsRouteRequest([austin, sanAntonio], {
      ...call,
      credential: (key) => (key === "orsKey" ? "placeholder-key" : undefined),
    });
    expect(request).toMatchObject({
      source: "ors",
      method: "POST",
      url: "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
      headers: { Authorization: "placeholder-key" },
      area: { point: { lat: 30.27, lon: -97.74 }, precisionDecimals: 2 },
    });
    // Each point may snap to a road past ORS's default 350 m, as rounding can move it about 0.8 km.
    expect(JSON.parse(request?.payload ?? "")).toEqual({
      coordinates: [
        [-97.74, 30.27],
        [-98.5, 29.42],
      ],
      radiuses: [2_000, 2_000],
    });
    expect(request?.url).not.toContain("placeholder-key");
  });

  it("reads OpenRouteService's and OSRM's route shapes, and a changed one as drift", () => {
    const ors = parseOrsRoute({ status: 200, body: fixture("routing/ors-austin-san-antonio-synthetic.json") }, NOW);
    expect(ors).toMatchObject({ kind: "ok", distanceKm: 128.9004 });
    expect(ors.kind === "ok" ? ors.line[0] : undefined).toEqual({ lat: 30.2701, lon: -97.743 });
    expect(parseOsrmRoute({ status: 200, body: fixture("routing/osrm-austin-san-antonio-synthetic.json") }, NOW)).toMatchObject({
      kind: "ok",
      distanceKm: 130.2,
    });
    expect(parseOrsRoute({ status: 200, body: { features: [] } }, NOW)).toMatchObject({ kind: "drift" });
    expect(parseOsrmRoute({ status: 200, body: { code: "NoRoute", routes: [] } }, NOW)).toMatchObject({ kind: "drift" });
    expect(parseOrsRoute({ status: 403, body: null }, NOW)).toEqual({ kind: "unauthorized" });
  });

  it("refuses OSRM's and FOSSGIS's demo servers as the operator's router, and builds an OSRM request for another", () => {
    expect([...ROUTING_EXCLUDED_HOSTS.keys()]).toEqual(["router.project-osrm.org", "routing.openstreetmap.de"]);
    expect(customRoutingRecord("https://router.project-osrm.org")).toMatchObject({ refused: expect.stringMatching(/demo server/) });
    expect(customRoutingRecord("https://routing.openstreetmap.de/routed-car")).toMatchObject({
      refused: expect.stringMatching(/demo server/),
    });
    expect(customRoutingRecord("ftp://example.org")).toMatchObject({ refused: expect.stringMatching(/http/) });
    const record = customRoutingRecord("https://osrm.example.org/");
    if ("refused" in record) throw new Error(record.refused);
    expect(record).toMatchObject({ id: "custom-router", hosts: ["osrm.example.org"], kind: "route" });
    // Rounded like every other router's points, and logged so.
    expect(osrmRouteRequest(record, "https://osrm.example.org/", [austin, sanAntonio])).toMatchObject({
      url: "https://osrm.example.org/route/v1/driving/-97.74,30.27;-98.5,29.42?overview=full&geometries=geojson",
      area: { point: { lat: 30.27, lon: -97.74 }, precisionDecimals: 2 },
    });
  });
});

describe("stations along a line", () => {
  const line = corridorLine([austin, sanAntonio], 10);

  it("asks Overpass around every point of the rounded line, with the fuel's or connectors' filter", () => {
    const query = overpassAlongQuery({ line, radiusKm: 3.2, kind: "fuel", limit: 100 });
    expect(query).toMatch(/^\[out:json\]\[timeout:20\];nwr\["amenity"="fuel"\]\(around:3200,30\.27,-97\.74,/);
    expect(query).toContain("29.42,-98.5);out tags center 100;");
    expect(overpassAlongQuery({ line, radiusKm: 3.2, kind: "fuel", fuel: "lpg", limit: 10 })).toContain(
      '["amenity"="fuel"]["fuel:lpg"="yes"](around:',
    );
    expect(overpassAlongQuery({ line, radiusKm: 3.2, kind: "fuel", fuel: "e10", limit: 10 })).toContain('["amenity"="fuel"](around:');
    expect(overpassAlongQuery({ line, radiusKm: 5, kind: "ev", connectors: ["CCS1", "NACS"], limit: 10 })).toContain(
      'nwr["amenity"="charging_station"][~"^socket:(type1_combo|nacs)$"~"."](around:5000,',
    );
    expect(overpassAlongQuery({ line: [], radiusKm: 5, kind: "ev", limit: 10 })).toBe("");
    expect(overpassAlong({ line, radiusKm: 3.2, kind: "fuel", limit: 100 }, call)).toMatchObject({
      source: "overpass",
      area: { point: { lat: 30.27, lon: -97.74 }, precisionDecimals: 2 },
    });
  });

  it("reads the stations with Overpass's own parser", () => {
    const request = overpassAlong({ line, radiusKm: 3.2, kind: "fuel", limit: 100 }, call);
    if (request === undefined) throw new Error("no request");
    const outcome = overpass.parse({ status: 200, body: fixture("overpass/along-i35-synthetic.json") }, request, call);
    expect(outcome.kind === "ok" ? outcome.candidates.map((candidate) => candidate.name) : []).toContain("San Marcos Fuel Plaza");
  });
});
