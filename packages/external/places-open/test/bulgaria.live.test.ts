import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asyncBufferFromUrl } from "hyparquet";
import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * Bulgaria as a locality, against the live services: Cyrillic and English
 * queries, a postcode, details, fuel as the EU's Weekly Oil Bulletin's
 * national average, and the tools Tavi has no Bulgarian source for (chargers
 * without an Open Charge Map key, neighbourhood data, licensing, a watch),
 * each of which must say so. OSM's public
 * Overpass instances may be down; then Photon answers a category by its name.
 * Outside CI. Run with
 * `TAVI_REAL_TESTS=1 TAVI_LIVE_PLACES=1 pnpm --filter @tavi/plugin-places-open exec vitest run test/bulgaria.live.test.ts`;
 * the run prints what it found.
 */
const LIVE = process.env["TAVI_LIVE_PLACES"] === "1";

describe.skipIf(!LIVE)("Bulgaria against live sources", () => {
  it("finds places in Sofia, Plovdiv and Varna, and says what it has no Bulgarian source for", { timeout: 600_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "tavi-places-bg-"));
    const places = createEngine({
      storePath: join(home, "places.db"),
      fetcher: workerFetcher,
      openParquet: (url) => asyncBufferFromUrl({ url }),
      config: {},
      version: "0.1.0",
    });
    const attended = { unattended: false };
    const signal = new AbortController().signal;
    try {
      const pharmacies = await places.search({ query: "pharmacy", area: { text: "Sofia" }, limit: 6 }, signal, attended);
      const cyrillic = await places.search({ query: "аптека", area: { text: "София" }, limit: 6 }, signal, attended);
      const mechanics = await places.search({ query: "car mechanic", area: { text: "Пловдив" }, limit: 6 }, signal, attended);
      const openAt = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
      const restaurants = await places.search(
        { query: "restaurant", area: { text: "Varna, Bulgaria" }, filters: { openAt, excludeChains: true }, limit: 6 },
        signal,
        attended,
      );
      const bakeries = await places.search({ query: "bakery", area: { text: "1000" }, country: "BG", limit: 6 }, signal, attended);
      const first = pharmacies.places[0] ?? cyrillic.places[0];
      const details = first === undefined ? undefined : await places.details({ placeId: first.placeId }, signal, attended);
      const fuel = await places.fuelPrices({ area: { text: "Sofia" }, fuel: "diesel" }, signal, attended);
      const chargers = await places.evChargers({ area: { text: "Sofia" } }, signal, attended);
      const report = await places.areaReport({ area: { text: "Sofia" } }, signal, attended);
      const route = await places.routeStops({ from: "Sofia", to: "Plovdiv", kind: "fuel", fuel: "diesel" }, signal, attended);
      const licence = await places.verifyLicense({ jurisdiction: "BG-22", profession: "auto_repair" }, signal, attended);
      const watch = await places
        .watch({ op: "add", area: { text: "Sofia" }, fuel: "diesel", threshold: 1.5, currency: "EUR" }, signal, attended)
        .then(
          () => "added",
          (error: unknown) => String(error),
        );
      const searches = { pharmacies, cyrillic, mechanics, restaurants, bakeries };
      {
        const shown = Object.fromEntries(
          Object.entries(searches).map(([name, answer]) => [
            name,
            {
              area: answer.area,
              sources: answer.sources,
              found: answer.found,
              places: answer.places.map((place) => ({
                name: place.name,
                address: place.address,
                phone: place.phone,
                hours: place.hours,
                flags: place.flags,
                sources: Object.keys(place.ids),
              })),
            },
          ]),
        );
        console.log(
          `${JSON.stringify({ at: new Date().toISOString(), ...shown, details, fuel: { average: fuel.regionalAverage, note: fuel.note }, chargers: chargers.note, report: report.note, route: { note: route.note, stops: route.stops.length, sources: route.sources }, licence: licence.note, watch, requests: places.sources().recentRequests }, null, 2)}\n`,
        );
      }
      // Every area is Bulgarian, whatever script it was typed in.
      for (const answer of Object.values(searches)) expect(answer.area?.label).toMatch(/България|Bulgaria/);
      // A search answers from Overpass or, when it did not, from Photon; and a category never returns a name that only shares a word.
      for (const answer of [pharmacies, cyrillic, restaurants])
        expect(answer.places.length > 0 || answer.sources.every((source) => source.outcome !== "ok" || source.source === "nominatim")).toBe(
          true,
        );
      expect(mechanics.places.filter((place) => /^car/i.test(place.name) && !/repair|service|сервиз/i.test(place.name))).toEqual([]);
      // No station prices: the EU's Weekly Oil Bulletin's national average, a week old at most, said to be one.
      expect(fuel.regionalAverage).toMatchObject({ currency: "EUR", unit: "litre", area: "Bulgaria", source: "eu-oil-bulletin" });
      expect(Date.now() - Date.parse(fuel.regionalAverage?.reportedAt ?? "")).toBeLessThan(21 * 86_400_000);
      expect(fuel.note).toMatch(/^Tavi has no station prices for Bulgaria: this is the EU's Weekly Oil Bulletin's national average/);
      expect(chargers.note).toMatch(/^No charging source answered for BG|No source here reports/);
      expect(report.note).toMatch(/^Tavi has no neighbourhood data for this area/);
      expect(licence).toMatchObject({ regime: "unknown", access: "none" });
      expect(watch).toMatch(/Tavi has no station prices for BG, only a regional or national average/);
      for (const entry of places.sources().recentRequests) {
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
