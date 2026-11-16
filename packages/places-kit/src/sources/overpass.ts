import { z } from "zod";

import { PlacesSourceRecordSchema } from "../contracts.js";
import { coarsenPoint } from "../geo.js";
import type { LinePoint } from "../route.js";
import type { OsmElement } from "../store/store.js";
import { drifted, safeWords, statusOutcome } from "./common.js";
import { candidateFromOsm, DIET_TAGS, OSM_ATTRIBUTION, osmIdOf } from "./osm.js";
import type { PlacesRequest, PoiAdapter, PoiQuery, SourceCall } from "./types.js";

/**
 * OpenStreetMap through Overpass: every tag, keyless. Its
 * main instance asks regular use to stay near 100 queries and 10 MB a day,
 * with no parallel requests; another instance is the operator's choice.
 */
export const OVERPASS_INSTANCES = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"] as const;

export const overpassRecord = PlacesSourceRecordSchema.parse({
  id: "overpass",
  name: "OpenStreetMap (Overpass)",
  countries: ["*"],
  hosts: ["overpass-api.de", "overpass.private.coffee"],
  auth: "none",
  terms: {
    url: "https://wiki.openstreetmap.org/wiki/Overpass_API",
    reviewedAt: "2026-10-17",
    licence: "ODbL-1.0",
    llmUse: "allowed",
    cache: { mode: "keep" },
    attribution: OSM_ATTRIBUTION,
    displayRules: [
      "Credit OpenStreetMap where results are shown: © OpenStreetMap contributors, openstreetmap.org/copyright",
      "Never share or export the stored OSM data: that would be public use of a derived database",
    ],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.2, perDay: 100 },
  kind: "poi",
  precisionDecimals: 2,
  // A public OpenStreetMap service, busy at times: paused an hour, not a day, after five failures in a row.
  failurePauseHours: 1,
  fields: ["hours", "phone", "website", "accessibility", "status", "diet"],
});

const TAG_PART = /^[a-z][a-z0-9_:]*$/;
/** The longest one query may run on Overpass's side: under the worker's 25 s request timeout, so Overpass answers before the worker gives up. */
const TIMEOUT_S = 20;
/** Elements one answer may hold. */
const ANSWER_MAX = 200;

/**
 * A name word as an Overpass regex that matches it in either case. Overpass's
 * `,i` is not relied on beyond ASCII, so each other letter is an alternation
 * of its two cases, which holds whether the regex reads UTF-8 or bytes (a
 * bracket class of two-byte letters would not): "двойка" matches "Двойка".
 */
export function overpassWordPattern(word: string): string {
  return [...word]
    .map((char) => {
      const upper = char.toUpperCase();
      return /^[\x00-\x7f]$/.test(char) || upper === char || [...upper].length !== 1 ? char : `(${char}|${upper})`;
    })
    .join("");
}

/**
 * The Overpass QL for a query: each category tag (or, with none, a name
 * match on the words) around the point, rounded to the record's precision, with the diet and
 * wheelchair filters. Tags come from Tavi's own table and words pass
 * `safeWords`, so nothing a model wrote changes the query's shape.
 */
export function overpassQuery(query: PoiQuery): string {
  const point = coarsenPoint(query.point, overpassRecord.precisionDecimals);
  const around = `(around:${String(Math.round(query.radiusKm * 1_000))},${String(point.lat)},${String(point.lon)})`;
  const filters = [
    ...(query.diet ?? [])
      .map((diet) => DIET_TAGS.get(diet))
      .filter((key): key is string => key !== undefined)
      .map((key) => `["${key}"~"^(yes|only)$"]`),
    ...(query.wheelchair === true ? ['["wheelchair"~"^(yes|limited)$"]'] : []),
  ].join("");
  const words = safeWords(query.words);
  const selectors =
    query.tags.length > 0
      ? query.tags
          .filter(([key, value]) => TAG_PART.test(key) && TAG_PART.test(value))
          .map(([key, value]) => `nwr["${key}"="${value}"]${filters}${around};`)
      : words.length > 0
        ? [`nwr["name"~"${words.map(overpassWordPattern).join("|")}",i]${filters}${around};`]
        : filters === ""
          ? []
          : [`nwr${filters}${around};`];
  return selectors.length === 0
    ? ""
    : `[out:json][timeout:${String(TIMEOUT_S)}];(${selectors.join("")});out tags center ${String(Math.min(ANSWER_MAX, Math.max(query.limit * 4, 50)))};`;
}

/** OSM's `socket:<type>` for each connector a route's EV stops may need. */
export const CONNECTOR_SOCKETS: ReadonlyMap<string, string> = new Map([
  ["J1772", "type1"],
  ["CCS1", "type1_combo"],
  ["CCS2", "type2_combo"],
  ["NACS", "nacs"],
  ["CHADEMO", "chademo"],
  ["TYPE2", "type2"],
]);
/** The fuels whose stations OSM tags, so a stop must say it sells them; the rest are at nearly every station. */
const FUEL_FILTERS: ReadonlyMap<string, string> = new Map([
  ["lpg", '["fuel:lpg"="yes"]'],
  ["e85", '["fuel:e85"="yes"]'],
  ["diesel", '["fuel:diesel"!="no"]'],
]);
/** Points one query's line may hold. */
export const ALONG_LINE_MAX_POINTS = 100;

/** Stations within `radiusKm` of a route's line. */
export interface AlongQuery {
  readonly line: readonly LinePoint[];
  readonly radiusKm: number;
  readonly kind: "fuel" | "ev";
  readonly fuel?: string | undefined;
  readonly connectors?: readonly string[] | undefined;
  readonly limit: number;
}

/** The line rounded to the record's precision, repeats dropped: what a query along it sends. */
function roundedLine(line: readonly LinePoint[]): LinePoint[] {
  const rounded: LinePoint[] = [];
  for (const point of line.slice(0, ALONG_LINE_MAX_POINTS).map((each) => coarsenPoint(each, overpassRecord.precisionDecimals))) {
    const last = rounded.at(-1);
    if (last === undefined || last.lat !== point.lat || last.lon !== point.lon) rounded.push(point);
  }
  return rounded;
}

/** The Overpass QL for stations along a line: Overpass's `around` with every point of the line. */
export function overpassAlongQuery(query: AlongQuery): string {
  const line = roundedLine(query.line);
  if (line.length === 0) return "";
  const around = `(around:${String(Math.round(query.radiusKm * 1_000))},${line.map((point) => `${String(point.lat)},${String(point.lon)}`).join(",")})`;
  const sockets = (query.connectors ?? []).map((connector) => CONNECTOR_SOCKETS.get(connector)).filter((socket) => socket !== undefined);
  const filter =
    query.kind === "ev"
      ? `["amenity"="charging_station"]${sockets.length === 0 ? "" : `[~"^socket:(${sockets.join("|")})$"~"."]`}`
      : `["amenity"="fuel"]${FUEL_FILTERS.get(query.fuel ?? "") ?? ""}`;
  return `[out:json][timeout:${String(TIMEOUT_S)}];nwr${filter}${around};out tags center ${String(Math.min(ANSWER_MAX, Math.max(query.limit, 20)))};`;
}

/** A request for stations along a line, read with `overpass.parse`. */
export function overpassAlong(query: AlongQuery, call: SourceCall): PlacesRequest | undefined {
  const data = overpassAlongQuery(query);
  const first = roundedLine(query.line)[0];
  if (data === "" || first === undefined) return undefined;
  return {
    source: "overpass",
    url: `${instanceOf(call.baseUrl)}?data=${encodeURIComponent(data)}`,
    body: "json",
    area: { point: first, precisionDecimals: overpassRecord.precisionDecimals },
  };
}

const ElementSchema = z.looseObject({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.looseObject({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
const AnswerSchema = z.looseObject({ elements: z.array(z.unknown()) });

/** The known instance after `baseUrl`'s, for one retry when the first is overloaded. */
const instanceOf = (baseUrl: string | undefined): string =>
  OVERPASS_INSTANCES.find((instance) => instance === baseUrl) ?? OVERPASS_INSTANCES[0];

export function nextOverpassInstance(baseUrl: string | undefined): string | undefined {
  const asked = instanceOf(baseUrl);
  return OVERPASS_INSTANCES.find((instance) => instance !== asked);
}

export const overpass: PoiAdapter = {
  record: overpassRecord,
  search: (query, call) => {
    const data = overpassQuery(query);
    if (data === "") return undefined;
    return {
      source: "overpass",
      url: `${instanceOf(call.baseUrl)}?data=${encodeURIComponent(data)}`,
      body: "json",
      area: {
        point: coarsenPoint(query.point, overpassRecord.precisionDecimals),
        precisionDecimals: overpassRecord.precisionDecimals,
        ...(query.country === undefined ? {} : { country: query.country }),
      },
    };
  },
  details: (osmId, call) => {
    const match = /^(node|way|relation)\/(\d+)$/.exec(osmId);
    if (match === null) return undefined;
    return {
      source: "overpass",
      url: `${instanceOf(call.baseUrl)}?data=${encodeURIComponent(`[out:json][timeout:${String(TIMEOUT_S)}];${match[1] as string}(${match[2] as string});out tags center 1;`)}`,
      body: "json",
    };
  },
  parse: (response, _request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const answer = AnswerSchema.safeParse(response.body);
    if (!answer.success) return { kind: "drift", detail: "the answer has no elements list" };
    const osm: OsmElement[] = [];
    let dropped = 0;
    for (const item of answer.data.elements) {
      const element = ElementSchema.safeParse(item);
      const lat = element.success ? (element.data.lat ?? element.data.center?.lat) : undefined;
      const lon = element.success ? (element.data.lon ?? element.data.center?.lon) : undefined;
      const osmId = element.success ? osmIdOf(element.data.type, element.data.id) : undefined;
      if (!element.success || lat === undefined || lon === undefined || osmId === undefined) {
        dropped += 1;
        continue;
      }
      osm.push({ osmId, lat, lon, tags: element.data.tags ?? {} });
    }
    if (drifted(dropped, answer.data.elements.length))
      return {
        kind: "drift",
        detail: `${String(dropped)} of ${String(answer.data.elements.length)} elements did not have the expected shape`,
      };
    const candidates = osm.map(candidateFromOsm).filter((candidate) => candidate !== undefined);
    return { kind: "ok", candidates, osm, dropped };
  },
};
