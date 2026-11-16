import type { PlacesSourceRecord } from "../contracts.js";
import { nominatim } from "./nominatim.js";
import { overpass } from "./overpass.js";
import { overtureRecord } from "./overture.js";
import { photonGeocoder, photonPlaces } from "./photon.js";
import type { GeocoderAdapter, PoiAdapter } from "./types.js";

export * from "./categories.js";
export * from "./care.js";
export * from "./civic.js";
export * from "./common.js";
export * from "./ev.js";
export * from "./fuel.js";
export * from "./nominatim.js";
export * from "./osm.js";
export * from "./overpass.js";
export * from "./overture.js";
export * from "./photon.js";
export * from "./routing.js";
export * from "./tdlr.js";
export type * from "./types.js";

/** Area geocoders, in the order they are tried: Nominatim for what a person typed, then Photon. */
export const P1_GEOCODERS: readonly GeocoderAdapter[] = [nominatim, photonGeocoder];
/** POI sources, in the order their answers win: Overpass's full tags, then Photon's names. */
export const P1_POI_SOURCES: readonly PoiAdapter[] = [overpass, photonPlaces];

/**
 * Where a candidate's data comes from, by the candidate's `source`: what the
 * store reads a place's terms from. Every OSM-derived adapter answers `osm`
 * candidates, kept under Overpass's terms (keep, ODbL).
 */
export const DATA_SOURCE_TERMS: ReadonlyMap<string, PlacesSourceRecord> = new Map([
  ["osm", overpass.record],
  ["overture", overtureRecord],
]);
