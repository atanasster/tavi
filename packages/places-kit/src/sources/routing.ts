import { z } from "zod";

import { PlacesSourceRecordSchema, type PlacesSourceRecord } from "../contracts.js";
import { coarsenPoint } from "../geo.js";
import type { LinePoint } from "../route.js";
import { statusOutcome } from "./common.js";
import type { Failure, PlacesRequest, SourceCall, SourceResponse } from "./types.js";

/**
 * Routers for `route_stops`:
 * OpenRouteService with the person's key, or a router the operator
 * runs that speaks OSRM's HTTP API (`routingUrl`). OSRM's and FOSSGIS's
 * public demo servers are not used: their policies forbid an app's traffic.
 */

export const ORS_DIRECTIONS = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
/**
 * How far OpenRouteService may look for a road from each point, in metres: a
 * point rounded to 2 decimals can sit up to about 0.8 km from where it was,
 * past ORS's default of 350 m.
 */
const ORS_SNAP_RADIUS_M = 2_000;

export const orsRecord = PlacesSourceRecordSchema.parse({
  id: "ors",
  name: "OpenRouteService",
  countries: ["*"],
  hosts: ["api.openrouteservice.org"],
  auth: "key-header",
  credential: ["orsKey"],
  terms: {
    url: "https://account.heigit.org/info/tos",
    reviewedAt: "2026-10-17",
    licence: "ODbL-1.0",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors",
    displayRules: ["Credit openrouteservice.org by HeiGIT and OpenStreetMap where a route is shown"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.66, perDay: 2_000 },
  kind: "route",
  precisionDecimals: 2,
  fields: [],
});

/** Hosts no router setting may name, each with why. */
export const ROUTING_EXCLUDED_HOSTS: ReadonlyMap<string, string> = new Map([
  ["router.project-osrm.org", "OSRM's demo server: its policy forbids an app's traffic"],
  ["routing.openstreetmap.de", "FOSSGIS's demo server: its policy forbids an app's traffic"],
]);

/** The operator's own router, as a record, or why its address is refused. */
export function customRoutingRecord(routingUrl: string): PlacesSourceRecord | { readonly refused: string } {
  let url: URL;
  try {
    url = new URL(routingUrl);
  } catch {
    return { refused: "routingUrl is not an address" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { refused: "routingUrl is not an http address" };
  const excluded = ROUTING_EXCLUDED_HOSTS.get(url.hostname);
  if (excluded !== undefined) return { refused: `routingUrl names ${url.hostname}, ${excluded}` };
  return PlacesSourceRecordSchema.parse({
    id: "custom-router",
    name: "Your router",
    countries: ["*"],
    hosts: [url.hostname],
    auth: "none",
    terms: {
      url: url.origin,
      reviewedAt: orsRecord.terms.reviewedAt,
      licence: "operator",
      llmUse: "allowed",
      cache: { mode: "none" },
      attribution: "",
      displayRules: [],
      userTriggeredOnly: false,
    },
    budget: { perSecond: 5, perDay: 10_000 },
    kind: "route",
    precisionDecimals: 2,
    fields: [],
  });
}

/** A route as a router answered it: its line and its road distance. */
export type RouteOutcome = { readonly kind: "ok"; readonly line: readonly LinePoint[]; readonly distanceKm: number } | Failure;

const lonLat = (point: LinePoint, decimals: number): [number, number] => {
  const rounded = coarsenPoint(point, decimals);
  return [rounded.lon, rounded.lat];
};

/** OpenRouteService's driving route through `points`, each rounded to its record's precision. */
export function orsRouteRequest(points: readonly LinePoint[], call: SourceCall): PlacesRequest | undefined {
  const key = call.credential("orsKey");
  if (key === undefined || points.length < 2) return undefined;
  const first = points[0] as LinePoint;
  return {
    source: orsRecord.id,
    url: ORS_DIRECTIONS,
    method: "POST",
    payload: JSON.stringify({
      coordinates: points.map((point) => lonLat(point, orsRecord.precisionDecimals)),
      radiuses: points.map(() => ORS_SNAP_RADIUS_M),
    }),
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: "json",
    area: { point: coarsenPoint(first, orsRecord.precisionDecimals), precisionDecimals: orsRecord.precisionDecimals },
  };
}

const Coordinates = z.array(z.tuple([z.number(), z.number()]).rest(z.number())).min(2);
const OrsAnswer = z.looseObject({
  features: z
    .array(
      z.looseObject({
        geometry: z.looseObject({ coordinates: Coordinates }),
        properties: z.looseObject({ summary: z.looseObject({ distance: z.number().nonnegative() }) }),
      }),
    )
    .min(1),
});

const toLine = (coordinates: z.infer<typeof Coordinates>): LinePoint[] => coordinates.map(([lon, lat]) => ({ lat, lon }));

export function parseOrsRoute(response: SourceResponse, now: string): RouteOutcome {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  const answer = OrsAnswer.safeParse(response.body);
  if (!answer.success) return { kind: "drift", detail: "the answer has no route line" };
  const feature = answer.data.features[0] as z.infer<typeof OrsAnswer>["features"][number];
  return { kind: "ok", line: toLine(feature.geometry.coordinates), distanceKm: feature.properties.summary.distance / 1_000 };
}

/** The operator's router's route (OSRM's `route` service) through `points`. */
export function osrmRouteRequest(record: PlacesSourceRecord, routingUrl: string, points: readonly LinePoint[]): PlacesRequest | undefined {
  if (points.length < 2) return undefined;
  const path = points.map((point) => lonLat(point, record.precisionDecimals).join(",")).join(";");
  return {
    source: record.id,
    url: `${routingUrl.replace(/\/+$/, "")}/route/v1/driving/${path}?overview=full&geometries=geojson`,
    body: "json",
    area: { point: coarsenPoint(points[0] as LinePoint, record.precisionDecimals), precisionDecimals: record.precisionDecimals },
  };
}

const OsrmAnswer = z.looseObject({
  code: z.literal("Ok"),
  routes: z.array(z.looseObject({ distance: z.number().nonnegative(), geometry: z.looseObject({ coordinates: Coordinates }) })).min(1),
});

export function parseOsrmRoute(response: SourceResponse, now: string): RouteOutcome {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  const answer = OsrmAnswer.safeParse(response.body);
  if (!answer.success) return { kind: "drift", detail: "the answer is not an OSRM route" };
  const route = answer.data.routes[0] as z.infer<typeof OsrmAnswer>["routes"][number];
  return { kind: "ok", line: toLine(route.geometry.coordinates), distanceKm: route.distance / 1_000 };
}
