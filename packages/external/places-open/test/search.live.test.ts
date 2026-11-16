import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asyncBufferFromUrl } from "hyparquet";
import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * Live acceptance runs: tailors near a named area, and the discovery half of
 * a repair-shop search (independent BMW shops near 78701), against
 * OpenStreetMap's live services and, for the shops, an
 * Overture pack of central Austin. A handful of requests a person would make;
 * outside CI. Run with
 * `TAVI_REAL_TESTS=1 TAVI_LIVE_PLACES=1 pnpm --filter @tavi/plugin-places-open exec vitest run test/search.live.test.ts`;
 * the run prints what it found.
 */
const LIVE = process.env["TAVI_LIVE_PLACES"] === "1";

describe.skipIf(!LIVE)("tailors and BMW shops against live sources", () => {
  it("finds, resolves, attributes and logs only rounded areas", { timeout: 180_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "tavi-places-live-"));
    const places = createEngine({
      storePath: join(home, "places.db"),
      fetcher: workerFetcher,
      openParquet: (url) => asyncBufferFromUrl({ url }),
      config: { overtureArea: "30.27,-97.74,8" },
      version: "0.1.0",
    });
    try {
      const attended = { unattended: false };
      const signal = new AbortController().signal;
      const started = Date.now();
      const tailors = await places.search(
        { query: "tailor alterations", area: { text: "Shoreditch, London" }, country: "GB", limit: 8 },
        signal,
        attended,
      );
      const tailorsMs = Date.now() - started;
      const bmwStart = Date.now();
      const mechanics = await places.search(
        { query: "independent BMW mechanic", area: { text: "78701, United States" }, country: "US", limit: 10 },
        signal,
        attended,
      );
      const mechanicsMs = Date.now() - bmwStart;
      const sources = places.sources();
      const report = {
        at: new Date().toISOString(),
        useCase153: {
          ms: tailorsMs,
          area: tailors.area,
          sources: tailors.sources,
          found: tailors.found,
          places: tailors.places.map((place) => ({
            name: place.name,
            address: place.address,
            distanceKm: place.distanceKm,
            confidence: place.confidence,
            flags: place.flags,
            sources: Object.keys(place.ids),
            hours: place.hours,
          })),
          attribution: tailors.attribution,
        },
        useCase21: {
          ms: mechanicsMs,
          area: mechanics.area,
          sources: mechanics.sources,
          found: mechanics.found,
          places: mechanics.places.map((place) => ({
            name: place.name,
            address: place.address,
            distanceKm: place.distanceKm,
            confidence: place.confidence,
            flags: place.flags,
            sources: Object.keys(place.ids),
            phone: place.phone,
            website: place.website,
          })),
          attribution: mechanics.attribution,
        },
        requests: sources.recentRequests,
        overtureArea: sources.overtureArea,
      };
      console.log(JSON.stringify(report, null, 2));
      // OSM's public Overpass instances can both be down (as on 2026-10-17): then a search says so, and answers from what else it has.
      const overpassDown = (answer: typeof tailors) =>
        answer.sources.some((source) => source.source === "overpass" && source.outcome !== "ok");
      expect(tailors.places.length > 0 || overpassDown(tailors)).toBe(true);
      expect(mechanics.places.length).toBeGreaterThan(0);
      for (const entry of sources.recentRequests) {
        if (entry.roundedLatLon === undefined) continue;
        for (const value of [entry.roundedLatLon.lat, entry.roundedLatLon.lon])
          expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-6);
      }
    } finally {
      places.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
