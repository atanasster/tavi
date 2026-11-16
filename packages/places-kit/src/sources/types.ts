import type { SourceResponse } from "@tavi/domain-kit";

import type { Candidate, PlacesSourceRecord } from "../contracts.js";
import type { OsmElement } from "../store/store.js";

export type { SourceResponse };

/**
 * A places source as a pure adapter: it says which request to make and reads the answer; the plugin's
 * worker makes it. A new source is one adapter and one record, replayed in
 * tests from recorded answers.
 */
export interface PlacesRequest {
  /** The adapter's record id, for its budget, health and log. */
  readonly source: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** How the answer is read: JSON, text, or the bytes of a file (a spreadsheet). */
  readonly body: "json" | "text" | "bytes";
  /** `GET` unless set; a `POST` sends `payload` as JSON. */
  readonly method?: "POST";
  readonly payload?: string;
  /** The area as it leaves the worker, already coarsened: what `sources` logs. */
  readonly area?: {
    readonly point: { readonly lat: number; readonly lon: number };
    readonly precisionDecimals: number;
    readonly country?: string;
  };
}

export type Failure =
  | { readonly kind: "not-found" }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly status: number }
  /** The answer is not the shape this adapter reads: the source changed. */
  | { readonly kind: "drift"; readonly detail: string };

/** A point an area's text named, with what the geocoder called it. */
export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
  readonly country?: string;
}

export type GeocodeOutcome = { readonly kind: "ok"; readonly points: readonly GeoPoint[] } | Failure;
/** `osm`: the elements as OSM has them, kept apart. */
export type PoiOutcome =
  | { readonly kind: "ok"; readonly candidates: readonly Candidate[]; readonly osm: readonly OsmElement[]; readonly dropped: number }
  | Failure;

export interface SourceCall {
  readonly credential: (key: string) => string | undefined;
  /** `Tavi-places/<version> (+<contact>)`. */
  readonly userAgent: string;
  readonly now: string;
  /** A base address the operator chose for this source (another Overpass instance). */
  readonly baseUrl?: string | undefined;
  /** What this source keeps in the worker's cache between calls, as its terms allow (the Oil Bulletin's week). */
  readonly cache?: { read(): unknown; write(value: unknown): void } | undefined;
}

/** What a POI search asks a source for: an area already coarsened, and what to look for. */
export interface PoiQuery {
  readonly point: { readonly lat: number; readonly lon: number };
  readonly radiusKm: number;
  readonly country?: string | undefined;
  /** OSM tags, any of which a place may carry: `[["shop", "car_repair"], ["craft", "car_repair"]]`. */
  readonly tags: readonly (readonly [string, string])[];
  /** Words left after the category, as the query wrote them: matched against names. */
  readonly words: readonly string[];
  readonly diet?: readonly string[] | undefined;
  readonly wheelchair?: boolean | undefined;
  readonly limit: number;
}

export interface GeocoderAdapter {
  readonly record: PlacesSourceRecord;
  geocode(text: string, call: SourceCall, country?: string): PlacesRequest | undefined;
  parseGeocode(response: SourceResponse, request: PlacesRequest, call: SourceCall): GeocodeOutcome;
}

export interface PoiAdapter {
  readonly record: PlacesSourceRecord;
  /** `undefined` when the source cannot serve the query (Photon without words). */
  search(query: PoiQuery, call: SourceCall): PlacesRequest | undefined;
  /** One OSM element by its id, `node/123`. */
  details?(osmId: string, call: SourceCall): PlacesRequest | undefined;
  parse(response: SourceResponse, request: PlacesRequest, call: SourceCall): PoiOutcome;
}
