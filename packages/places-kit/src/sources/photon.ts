import { z } from "zod";

import { CandidateSchema, PlacesSourceRecordSchema } from "../contracts.js";
import { boxAround, coarsenPoint } from "../geo.js";
import { drifted, safeWords, statusOutcome } from "./common.js";
import { OSM_ATTRIBUTION, OSM_LICENCE, osmIdOf } from "./osm.js";
import type { GeocoderAdapter, PoiAdapter } from "./types.js";

/**
 * Photon (komoot's public OSM geocoder): keyless, "be fair",
 * minutely OSM data. Its location bias is weak (a search near Austin answered
 * a shop in Libya, recorded 2026-10-17), so a place search always sends a
 * bounding box, and an area is geocoded on its place layers only.
 */
export const photonRecord = PlacesSourceRecordSchema.parse({
  id: "photon",
  name: "Photon (OpenStreetMap)",
  countries: ["*"],
  hosts: ["photon.komoot.io"],
  auth: "none",
  terms: {
    url: "https://photon.komoot.io/",
    reviewedAt: "2026-10-17",
    licence: "ODbL-1.0",
    llmUse: "allowed",
    cache: { mode: "keep" },
    attribution: OSM_ATTRIBUTION,
    displayRules: ["Credit OpenStreetMap where results are shown: © OpenStreetMap contributors, openstreetmap.org/copyright"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 500 },
  kind: "geocode",
  precisionDecimals: 2,
  // A public OpenStreetMap service, busy at times: paused an hour, not a day, after five failures in a row.
  failurePauseHours: 1,
  fields: [],
});

const FeatureSchema = z.looseObject({
  geometry: z.looseObject({ coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.looseObject({
    osm_type: z.string(),
    osm_id: z.number().int(),
    osm_key: z.string().optional(),
    osm_value: z.string().optional(),
    name: z.string().optional(),
    housenumber: z.string().optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    postcode: z.string().optional(),
    countrycode: z.string().optional(),
    state: z.string().optional(),
  }),
});
const AnswerSchema = z.looseObject({ features: z.array(z.unknown()) });

const BASE = "https://photon.komoot.io/api/";
/** An OSM key or value as Photon's `osm_tag` filter takes it. */
const TAG_PART = /^[a-z][a-z0-9_:]*$/;

/** The answer's features, the unreadable ones counted; `undefined` when it is not a feature list, or mostly unreadable. */
function features(body: unknown): { readonly read: z.infer<typeof FeatureSchema>[]; readonly dropped: number } | undefined {
  const answer = AnswerSchema.safeParse(body);
  if (!answer.success) return undefined;
  const read: z.infer<typeof FeatureSchema>[] = [];
  let dropped = 0;
  for (const item of answer.data.features) {
    const feature = FeatureSchema.safeParse(item);
    if (feature.success) read.push(feature.data);
    else dropped += 1;
  }
  return drifted(dropped, answer.data.features.length) ? undefined : { read, dropped };
}

export const photonGeocoder: GeocoderAdapter = {
  record: photonRecord,
  geocode: (text) => {
    const words = safeWords(text.split(/[,\s]+/));
    if (words.length === 0) return undefined;
    const layers = ["city", "district", "locality", "county"].map((layer) => `&layer=${layer}`).join("");
    return { source: "photon", url: `${BASE}?q=${encodeURIComponent(words.join(" "))}&limit=1&lang=en${layers}`, body: "json" };
  },
  parseGeocode: (response, _request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const read = features(response.body);
    if (read === undefined) return { kind: "drift", detail: "the answer is not a feature list Tavi reads" };
    return {
      kind: "ok",
      points: read.read.map((feature) => ({
        lat: feature.geometry.coordinates[1],
        lon: feature.geometry.coordinates[0],
        label: [feature.properties.name, feature.properties.city, feature.properties.state].filter((part) => part !== undefined).join(", "),
        ...(feature.properties.countrycode === undefined ? {} : { country: feature.properties.countrycode.toUpperCase() }),
      })),
    };
  },
};

export const photonPlaces: PoiAdapter = {
  record: photonRecord,
  search: (query) => {
    const words = safeWords(query.words);
    if (words.length === 0) return undefined;
    const point = coarsenPoint(query.point, photonRecord.precisionDecimals);
    const box = boxAround(point, query.radiusKm);
    const bbox = [box.west, box.south, box.east, box.north].map((value) => value.toFixed(2)).join(",");
    // A category's tags filter the answer, so a name word ("car") never returns a carpet shop; no `lang`, so streets are in
    // OSM's own names, as Overpass's tags give them.
    const tags = query.tags
      .filter(([key, value]) => TAG_PART.test(key) && TAG_PART.test(value))
      .map(([key, value]) => `&osm_tag=${key}:${value}`)
      .join("");
    return {
      source: "photon",
      url: `${BASE}?q=${encodeURIComponent(words.join(" "))}&bbox=${bbox}&limit=${String(Math.min(20, query.limit * 2))}${tags}`,
      body: "json",
      area: {
        point,
        precisionDecimals: photonRecord.precisionDecimals,
        ...(query.country === undefined ? {} : { country: query.country }),
      },
    };
  },
  parse: (response, _request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const read = features(response.body);
    if (read === undefined) return { kind: "drift", detail: "the answer is not a feature list Tavi reads" };
    const candidates = read.read.flatMap((feature) => {
      const osmId = osmIdOf(feature.properties.osm_type, feature.properties.osm_id);
      const name = feature.properties.name;
      if (osmId === undefined || name === undefined) return [];
      const street = [feature.properties.housenumber, feature.properties.street].filter((part) => part !== undefined).join(" ");
      const address = [street, feature.properties.city].filter((part) => part !== undefined && part !== "").join(", ");
      return [
        CandidateSchema.parse({
          source: "osm",
          sourceId: osmId,
          licence: OSM_LICENCE,
          attribution: OSM_ATTRIBUTION,
          name: name.slice(0, 200),
          categories: feature.properties.osm_value === undefined ? [] : [feature.properties.osm_value.replace(/_/g, " ")],
          ...(address === "" ? {} : { address: address.slice(0, 300) }),
          ...(feature.properties.postcode === undefined ? {} : { postcode: feature.properties.postcode.slice(0, 20) }),
          ...(feature.properties.countrycode === undefined ? {} : { country: feature.properties.countrycode.toUpperCase() }),
          lat: feature.geometry.coordinates[1],
          lon: feature.geometry.coordinates[0],
          url: `https://www.openstreetmap.org/${osmId}`,
        }),
      ];
    });
    return { kind: "ok", candidates, osm: [], dropped: read.dropped };
  },
};
