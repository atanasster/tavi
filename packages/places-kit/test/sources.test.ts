import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  nextOverpassInstance,
  nominatim,
  overpass,
  overpassQuery,
  photonGeocoder,
  photonPlaces,
  planMatches,
  planQuery,
  resolvePlaces,
  safeWords,
  type PoiQuery,
  type SourceCall,
} from "../src/index.js";

/** Answers recorded on GET on 2026-10-17 with `Tavi-places/0.1.0 (fixture recording)`; queries as in each test. */
const fixture = (path: string): unknown => JSON.parse(readFileSync(join(domainFixtures("places"), path), "utf8"));
const NOW = "2026-10-17T12:00:00Z";
const call: SourceCall = { credential: () => undefined, userAgent: "Tavi-places/test", now: NOW };
const austin: PoiQuery = {
  point: { lat: 30.27, lon: -97.74 },
  radiusKm: 5,
  country: "US",
  tags: [
    ["shop", "car_repair"],
    ["craft", "car_repair"],
  ],
  words: ["bmw"],
  limit: 10,
};

describe("query plans", () => {
  it("finds the category and leaves the rest for names", () => {
    // Qualifiers ("independent", "specialist") are no one's name: only "bmw" is left for names.
    expect(planQuery("independent BMW mechanic near me")).toMatchObject({
      label: "car repair",
      tags: [
        ["shop", "car_repair"],
        ["craft", "car_repair"],
      ],
      words: ["bmw"],
    });
    expect(planQuery("dedicated 100% gluten-free bakery")).toMatchObject({ label: "bakery", words: ["gluten", "free"] });
    expect(planQuery("tailor for jeans")).toMatchObject({
      tags: [
        ["craft", "tailor"],
        ["shop", "tailor"],
        ["craft", "dressmaker"],
      ],
      words: ["jeans"],
    });
    expect(planQuery("Chambelland")).toMatchObject({ tags: [], words: ["chambelland"], patterns: [] });
    // A specific phrase is taken whole before a broader word in it is tried.
    expect(planQuery("dental clinic").label).toBe("dentist");
    expect(planQuery("animal clinic").label).toBe("vet");
    expect(planQuery("nail salon").label).toBe("beauty");
    expect(planQuery("dentist and pharmacy").label).toBe("dentist, pharmacy");
  });

  it("keeps a model's text out of the query's shape", () => {
    expect(safeWords(['bmw"];out;', "a", "x".repeat(3)])).toEqual(["bmw out", "xxx"]);
    expect(safeWords(["y".repeat(500)])[0]).toHaveLength(40);
    expect(overpassQuery({ ...austin, tags: [], words: ['bmw"]](around:9e9,0,0);out;//'] })).toBe(
      '[out:json][timeout:20];(nwr["name"~"bmw around 9e9 0 0 out",i](around:5000,30.27,-97.74););out tags center 50;',
    );
    expect(overpassQuery({ ...austin, tags: [["shop", 'car"]{evil'] as unknown as readonly [string, string]] })).toBe("");
  });

  it("writes Overpass QL around the coarsened point, with diet and wheelchair filters", () => {
    expect(overpassQuery(austin)).toBe(
      '[out:json][timeout:20];(nwr["shop"="car_repair"](around:5000,30.27,-97.74);nwr["craft"="car_repair"](around:5000,30.27,-97.74););out tags center 50;',
    );
    expect(overpassQuery({ ...austin, tags: [["amenity", "restaurant"]], diet: ["gluten_free"], wheelchair: true })).toContain(
      'nwr["amenity"="restaurant"]["diet:gluten_free"~"^(yes|only)$"]["wheelchair"~"^(yes|limited)$"](around:5000,30.27,-97.74);',
    );
    expect(overpass.search(austin, call)).toMatchObject({
      source: "overpass",
      body: "json",
      area: { point: { lat: 30.27, lon: -97.74 }, precisionDecimals: 2, country: "US" },
    });
    // The retry goes to the instance not asked first, whatever the setting.
    expect([undefined, "https://example.org/api/interpreter", "https://overpass-api.de/api/interpreter"].map(nextOverpassInstance)).toEqual(
      Array(3).fill("https://overpass.private.coffee/api/interpreter"),
    );
    expect(nextOverpassInstance("https://overpass.private.coffee/api/interpreter")).toBe("https://overpass-api.de/api/interpreter");
    // Another instance only when it is one Tavi knows.
    expect(overpass.search(austin, { ...call, baseUrl: "https://overpass.private.coffee/api/interpreter" })?.url).toMatch(
      /^https:\/\/overpass\.private\.coffee\//,
    );
    expect(overpass.search(austin, { ...call, baseUrl: "https://evil.example/api" })?.url).toMatch(/^https:\/\/overpass-api\.de\//);
  });
});

describe("Overpass answers (recorded)", () => {
  it("reads Austin's car repair shops into named candidates with OSM's tags", () => {
    const outcome = overpass.parse(
      { status: 200, body: fixture("overpass/austin-car-repair.json") },
      { source: "overpass", url: "", body: "json" },
      call,
    );
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    expect(outcome.osm).toHaveLength(25);
    expect(outcome.candidates.length).toBeGreaterThan(15);
    for (const candidate of outcome.candidates) {
      expect(candidate).toMatchObject({ source: "osm", licence: "ODbL-1.0", attribution: "© OpenStreetMap contributors (ODbL)" });
      expect(candidate.sourceId).toMatch(/^(node|way|relation)\/\d+$/);
      expect(candidate.url).toBe(`https://www.openstreetmap.org/${candidate.sourceId}`);
    }
    // Resolved, each listing is one place.
    expect(resolvePlaces(outcome.candidates, { now: NOW }).length).toBeGreaterThan(10);
  });

  it("reads diet tags in Paris and tailors in London", () => {
    const paris = overpass.parse(
      { status: 200, body: fixture("overpass/paris-gluten-free.json") },
      { source: "overpass", url: "", body: "json" },
      call,
    );
    if (paris.kind !== "ok") throw new Error(paris.kind);
    expect(paris.candidates.length).toBeGreaterThan(20);
    expect(paris.candidates.every((candidate) => candidate.diet.includes("gluten_free"))).toBe(true);
    const london = overpass.parse(
      { status: 200, body: fixture("overpass/london-tailor.json") },
      { source: "overpass", url: "", body: "json" },
      call,
    );
    if (london.kind !== "ok") throw new Error(london.kind);
    expect(london.candidates.some((candidate) => candidate.categories.includes("tailor"))).toBe(true);
  });

  it("reads a closed or reshaped answer as what it is", () => {
    expect(overpass.parse({ status: 429, retryAfter: "30", body: "" }, { source: "overpass", url: "", body: "json" }, call)).toEqual({
      kind: "rate-limited",
      retryAfterMs: 30_000,
    });
    expect(overpass.parse({ status: 504, body: "" }, { source: "overpass", url: "", body: "json" }, call)).toMatchObject({
      kind: "rate-limited",
    });
    expect(
      overpass.parse({ status: 200, body: { remark: "runtime error" } }, { source: "overpass", url: "", body: "json" }, call),
    ).toMatchObject({ kind: "drift" });
    expect(
      overpass.parse(
        { status: 200, body: { elements: [{ type: "node" }, { type: "node" }, { type: "node", id: 1, lat: 1, lon: 1 }] } },
        { source: "overpass", url: "", body: "json" },
        call,
      ),
    ).toMatchObject({ kind: "drift" });
  });

  it("asks for one element's details by its OSM id, and nothing else", () => {
    expect(decodeURIComponent(overpass.details?.("way/123", call)?.url ?? "")).toContain("way(123);out tags center 1;");
    expect(overpass.details?.("way/1;out", call)).toBeUndefined();
  });
});

describe("Photon and Nominatim answers (recorded)", () => {
  it("searches places only inside a bounding box, since Photon's bias is weak", () => {
    const request = photonPlaces.search(austin, call);
    // The category's tags filter Photon's answer; streets come in OSM's own names, as Overpass gives them.
    expect(request?.url).toBe(
      "https://photon.komoot.io/api/?q=bmw&bbox=-97.79,30.23,-97.69,30.31&limit=20&osm_tag=shop:car_repair&osm_tag=craft:car_repair",
    );
    expect(photonPlaces.search({ ...austin, words: [] }, call)).toBeUndefined();
    const outcome = photonPlaces.parse(
      { status: 200, body: fixture("photon/austin-bmw-bbox.json") },
      request ?? { source: "photon", url: "", body: "json" },
      call,
    );
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    expect(outcome.candidates.map((candidate) => [candidate.name, candidate.source, candidate.country])).toEqual([
      ["BMW of South Austin", "osm", "US"],
      ["BMW of South Austin Service Center", "osm", "US"],
    ]);
  });

  it("geocodes an area on its place layers, and a postcode with Nominatim", () => {
    expect(photonGeocoder.geocode("Shoreditch, London", call)?.url).toBe(
      "https://photon.komoot.io/api/?q=Shoreditch%20London&limit=1&lang=en&layer=city&layer=district&layer=locality&layer=county",
    );
    const district = photonGeocoder.parseGeocode(
      { status: 200, body: fixture("photon/geocode-shoreditch.json") },
      { source: "photon", url: "", body: "json" },
      call,
    );
    expect(district).toMatchObject({ kind: "ok", points: [{ lat: 51.5266694, lon: -0.0798926, country: "GB" }] });
    expect(nominatim.geocode("78701, United States", call, "US")?.url).toBe(
      "https://nominatim.openstreetmap.org/search?q=78701%2C%20United%20States&format=jsonv2&limit=1&addressdetails=1&countrycodes=us",
    );
    expect(
      nominatim.parseGeocode(
        { status: 200, body: fixture("nominatim/austin-78701.json") },
        { source: "nominatim", url: "", body: "json" },
        call,
      ),
    ).toMatchObject({ kind: "ok", points: [{ lat: 30.2701204, lon: -97.7429667 }] });
    expect(
      nominatim.parseGeocode(
        { status: 200, body: fixture("nominatim/paris-3e.json") },
        { source: "nominatim", url: "", body: "json" },
        call,
      ),
    ).toMatchObject({ kind: "ok", points: [{ lat: 48.864212 }] });
    expect(
      nominatim.parseGeocode({ status: 200, body: { error: "x" } }, { source: "nominatim", url: "", body: "json" }, call),
    ).toMatchObject({ kind: "drift" });
  });

  it("reads a reshaped or failed Photon or Nominatim answer as drift or a failure, not an empty success", () => {
    const req = { source: "photon", url: "", body: "json" as const };
    expect(photonPlaces.parse({ status: 200, body: { features: [{ type: "Feature" }, { type: "Feature" }] } }, req, call)).toMatchObject({
      kind: "drift",
    });
    expect(photonGeocoder.parseGeocode({ status: 200, body: { results: [] } }, req, call)).toMatchObject({ kind: "drift" });
    expect(photonPlaces.parse({ status: 500, body: "" }, req, call)).toEqual({ kind: "failed", status: 500 });
    expect(
      nominatim.parseGeocode(
        { status: 200, body: [{ lat: "1", lon: "x", display_name: "a" }, { name: "b" }, { lat: "1", lon: "2", display_name: "c" }] },
        { ...req, source: "nominatim" },
        call,
      ),
    ).toMatchObject({ kind: "drift" });
    expect(nominatim.parseGeocode({ status: 403, body: "" }, { ...req, source: "nominatim" }, call)).toEqual({ kind: "unauthorized" });
    expect(nominatim.parseGeocode({ status: 200, body: [] }, { ...req, source: "nominatim" }, call)).toEqual({ kind: "ok", points: [] });
  });

  it("rounds the point it sends and logs, whatever it is given, and sends no odd country", () => {
    const exact = { ...austin, point: { lat: 30.267153, lon: -97.743061 } };
    expect(overpass.search(exact, call)?.area?.point).toEqual({ lat: 30.27, lon: -97.74 });
    expect(decodeURIComponent(overpass.search(exact, call)?.url ?? "")).toContain("(around:5000,30.27,-97.74)");
    expect(photonPlaces.search(exact, call)?.area?.point).toEqual({ lat: 30.27, lon: -97.74 });
    expect(nominatim.geocode("78701", call, "us&x=1")?.url).not.toContain("countrycodes");
  });

  it("names Nominatim as for a person's own typing only", () => {
    expect(nominatim.record.terms.userTriggeredOnly).toBe(true);
    expect(photonGeocoder.record.terms.userTriggeredOnly).toBe(false);
  });
});

describe("Bulgaria: Cyrillic names and a query's words", () => {
  const sofia: PoiQuery = { point: { lat: 42.6977, lon: 23.3219 }, radiusKm: 5, country: "BG", tags: [], words: [], limit: 10 };

  it("sends a name as written, each Cyrillic letter in both cases: 'Двойка' is never asked as 'двоика'", () => {
    const plan = planQuery("Хлебарница Двойка");
    expect(plan.words).toEqual(["хлебарница", "двоика"]);
    expect(plan.nameWords).toEqual(["хлебарница", "двойка"]);
    expect(overpassQuery({ ...sofia, words: plan.nameWords })).toContain(
      'nwr["name"~"(х|Х)(л|Л)(е|Е)(б|Б)(а|А)(р|Р)(н|Н)(и|И)(ц|Ц)(а|А)|(д|Д)(в|В)(о|О)(й|Й)(к|К)(а|А)",i]',
    );
    expect(planQuery("Crêperie Bretonne").nameWords).toEqual(["crêperie", "bretonne"]);
    // Matched against a source's names as written, so "й" is "y" on both sides.
    expect(planMatches(plan, { name: "Хлебарница Двойка", categories: [] })).toBe(true);
    expect(planMatches(planQuery("Dvoyka"), { name: "Хлебарница Двойка", categories: [] })).toBe(true);
  });

  it("takes 'car' with 'mechanic', so no name word 'car' is left to find a carpet shop", () => {
    expect(planQuery("car mechanic")).toMatchObject({ label: "car repair", words: [] });
    expect(planQuery("independent BMW mechanic").words).toEqual(["bmw"]);
  });
});
