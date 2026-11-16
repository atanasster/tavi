import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openPlacesStore,
  PlacesSourceRecordSchema,
  resolvePlaces,
  storeRecords,
  type PlacesSourceRecord,
  type PlacesStore,
} from "./helpers.js";

const NOW = "2026-10-17T12:00:00Z";

const record = (id: string, cache: PlacesSourceRecord["terms"]["cache"]): PlacesSourceRecord =>
  PlacesSourceRecordSchema.parse({
    id,
    name: id,
    countries: ["*"],
    hosts: [`${id}.example`],
    auth: "none",
    terms: {
      url: "https://example.org/terms",
      reviewedAt: "2026-10-17",
      licence: "test",
      llmUse: "allowed",
      cache,
      attribution: id,
      displayRules: [],
      userTriggeredOnly: false,
    },
    budget: { perSecond: 1, perDay: 100 },
    kind: "poi",
    precisionDecimals: 2,
    fields: [],
  });

describe("places.db", () => {
  let dir = "";
  let store: PlacesStore;
  const records = storeRecords([
    record("osm", { mode: "keep" }),
    record("week", { mode: "ttl", days: 7 }),
    record("idsonly", { mode: "ids-only" }),
    record("nothing", { mode: "none" }),
    record("aaa", { mode: "keep" }),
  ]);
  const temp = temporaryDirectories();
  beforeEach(() => {
    dir = temp.create("places-store-");
    store = openPlacesStore(join(dir, "places.db"), records);
  });
  afterEach(() => {
    store.close();
    temp.cleanup();
  });
  const candidate = (source: string, id: string, extra: object = {}) => ({
    source,
    sourceId: id,
    licence: "test",
    attribution: source,
    name: "Corner Tailor",
    lat: 51.5,
    lon: -0.12,
    categories: ["tailor"],
    ...extra,
  });

  it("keeps a place its sources' terms allow, until the shortest of their times", () => {
    const [kept] = resolvePlaces([candidate("osm", "node/1")], { now: NOW });
    const [week] = resolvePlaces([candidate("osm", "node/2", { lat: 52 }), candidate("week", "w2", { lat: 52 })], { now: NOW });
    expect(
      store.putPlaces(
        [kept, week].filter((place) => place !== undefined),
        NOW,
      ),
    ).toMatchObject({ stored: 2, idsOnly: 0 });
    expect(store.place(kept?.placeId ?? "", NOW)?.name).toBe("Corner Tailor");
    expect(store.placesNear({ lat: 51.5, lon: -0.12 }, 1, NOW).map((place) => place.placeId)).toEqual([kept?.placeId]);
    // Eight days on, the week-long source's place is gone, the kept one stays.
    const later = "2026-10-25T13:00:00Z";
    expect(store.place(week?.placeId ?? "", later)).toBeUndefined();
    expect(store.retain(later)).toEqual({ deleted: 1 });
    expect(store.place(kept?.placeId ?? "", later)).toBeDefined();
  });

  it("keeps a place's hours but not whether it was open at the time a search asked about", () => {
    // Two sources agreeing, one checked lately: high confidence, so the search's time reads "yes".
    const [open] = resolvePlaces(
      [candidate("osm", "node/9", { hours: "24/7", hoursCheckedAt: "2026-10-01T00:00:00Z" }), candidate("aaa", "a9", { hours: "24/7" })],
      { now: NOW, openAt: "2026-10-17T14:00:00+01:00" },
    );
    expect(open?.hours?.openNow).toBe("yes");
    store.putPlaces(open === undefined ? [] : [open], NOW);
    expect(store.place(open?.placeId ?? "", NOW)?.hours).toMatchObject({ spec: "Mo-Su 00:00-24:00", openNow: "unknown" });
  });

  it("keeps only the ids of a place an ids-only source is in, and nothing of a source it has no record of", () => {
    const [mixed] = resolvePlaces([candidate("osm", "node/3"), candidate("idsonly", "g3")], { now: NOW });
    const [relayed] = resolvePlaces([candidate("page", "https://shop.example/", { lat: 40 })], { now: NOW });
    expect(
      store.putPlaces(
        [mixed, relayed].filter((place) => place !== undefined),
        NOW,
      ),
    ).toMatchObject({ stored: 0, idsOnly: 2 });
    expect(store.place(mixed?.placeId ?? "", NOW)).toBeUndefined();
    expect(store.placeIdOf("idsonly", "g3")).toBe(mixed?.placeId);
    expect(store.placeIdOf("page", "https://shop.example/")).toBeUndefined();
  });

  it("keeps no id of a source whose terms keep nothing", () => {
    const [place] = resolvePlaces([candidate("osm", "node/4"), candidate("nothing", "n4")], { now: NOW });
    store.putPlaces(place === undefined ? [] : [place], NOW);
    expect(store.placeIdOf("osm", "node/4")).toBe(place?.placeId);
    expect(store.placeIdOf("nothing", "n4")).toBeUndefined();
  });

  it("keeps a place's id when a source that sorts first joins it, and leaves no stale copy", () => {
    const [before] = resolvePlaces([candidate("osm", "node/5")], { now: NOW });
    store.putPlaces(before === undefined ? [] : [before], NOW);
    const [after] = resolvePlaces([candidate("osm", "node/5"), candidate("aaa", "a5")], { now: NOW });
    expect(after?.placeId).not.toBe(before?.placeId);
    const { places } = store.putPlaces(after === undefined ? [] : [after], NOW);
    expect(places[0]?.placeId).toBe(before?.placeId);
    expect(store.placesNear({ lat: 51.5, lon: -0.12 }, 1, NOW).map((place) => place.placeId)).toEqual([before?.placeId]);
    expect(store.placeIdOf("aaa", "a5")).toBe(before?.placeId);
  });

  it("pauses a source after five failures in a row and keeps its log coarse", () => {
    for (let failure = 0; failure < 5; failure += 1) store.recordOutcome("osm", { ok: false, error: "HTTP 500" }, NOW);
    expect(store.health("osm", NOW)).toMatchObject({ consecutiveFailures: 5, disabledUntil: "2026-10-18T12:00:00.000Z", callsToday: 5 });
    expect(store.recordOutcome("osm", { ok: true }, NOW)).toMatchObject({ consecutiveFailures: 0 });
    store.log({
      source: "osm",
      host: "osm.example",
      at: NOW,
      status: 200,
      bytes: 10,
      country: "GB",
      precisionDecimals: 2,
      roundedLatLon: { lat: 51.5, lon: -0.12 },
    });
    expect(store.recentRequests(5)).toEqual([
      {
        source: "osm",
        host: "osm.example",
        at: NOW,
        status: 200,
        bytes: 10,
        country: "GB",
        precisionDecimals: 2,
        roundedLatLon: { lat: 51.5, lon: -0.12 },
      },
    ]);
  });

  it("keeps OSM elements apart, and forgets everything", () => {
    store.putOsm([{ osmId: "node/9", lat: 51.5, lon: -0.12, tags: { name: "Corner Tailor", craft: "tailor" } }], NOW);
    expect(store.osmNear({ lat: 51.5, lon: -0.12 }, 0.5)).toEqual([
      { osmId: "node/9", lat: 51.5, lon: -0.12, tags: { name: "Corner Tailor", craft: "tailor" } },
    ]);
    store.forget();
    expect(store.osmNear({ lat: 51.5, lon: -0.12 }, 0.5)).toEqual([]);
    expect(store.recentRequests(5)).toEqual([]);
  });
});
