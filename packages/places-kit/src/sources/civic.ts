import { z } from "zod";

import { PlacesSourceRecordSchema, type CIVIC_TOPICS, type PlacesSourceRecord } from "../contracts.js";
import { boxAround, coarsenPoint, distanceKm } from "../geo.js";
import { statusOutcome } from "./common.js";
import type { Failure, PlacesRequest, SourceCall, SourceResponse } from "./types.js";

/**
 * Neighbourhood open data for `area_report`: NYC 311 and building permits on Socrata, Open311
 * cities (a list kept as data), and data.police.uk. Each answers counts by
 * kind and a few of the latest, by type and date only: no complainant's
 * words, no address, no photo leaves the adapter.
 */

export type CivicTopic = (typeof CIVIC_TOPICS)[number];

export interface CivicQuery {
  readonly point: { readonly lat: number; readonly lon: number };
  readonly radiusKm: number;
  /** The start of the window, ISO. */
  readonly since: string;
}

/** One report, record or crime: its kind, status, when, and how far from the point. */
export interface CivicItem {
  readonly kind: string;
  readonly status?: string;
  readonly at: string;
  readonly distanceKm: number;
}

export interface CivicReport {
  readonly topic: CivicTopic;
  readonly items: readonly CivicItem[];
  /** When the source's data covers less than the window asked (data.police.uk's month). */
  readonly period?: string;
  /** Why the items are not the whole count: a row cap, a city server's sample, or no data for the point. */
  readonly caveat?: string;
}

export type CivicOutcome =
  | { readonly kind: "ok"; readonly report: CivicReport }
  | { readonly kind: "skipped"; readonly reason: string }
  | Failure;
export type CivicFetch = (request: PlacesRequest) => Promise<SourceResponse | { readonly skipped: string }>;

export interface CivicAdapter {
  readonly record: PlacesSourceRecord;
  readonly topic: CivicTopic;
  covers(point: { readonly lat: number; readonly lon: number }, country: string | undefined): boolean;
  run(query: CivicQuery, call: SourceCall, fetch: CivicFetch): Promise<CivicOutcome>;
}

/** Rows one request reads at most. */
const ROWS_MAX = 1_000;
/** A point leaves at 3 decimals, about 110 m: a 500 m report needs it finer than a search's kilometre. */
const CIVIC_PRECISION = 3;

type Box = { readonly south: number; readonly west: number; readonly north: number; readonly east: number };
const inBox = (point: { readonly lat: number; readonly lon: number }, box: Box): boolean =>
  point.lat >= box.south && point.lat <= box.north && point.lon >= box.west && point.lon <= box.east;
/** New York City as boxes that leave out New Jersey's shore (Jersey City, Hoboken, Bayonne, Newark): approximate at the edges. */
const NYC_BOXES: readonly Box[] = [
  // Manhattan below Washington Heights, east of the Hudson; above it, east of Fort Lee's shore, with the Bronx.
  { south: 40.7, west: -74.02, north: 40.8, east: -73.76 },
  { south: 40.8, west: -73.94, north: 40.92, east: -73.76 },
  // Brooklyn and southern Queens, south of Jersey City's latitude.
  { south: 40.54, west: -74.05, north: 40.7, east: -73.7 },
  // Northern Queens, east of the East River.
  { south: 40.7, west: -73.96, north: 40.8, east: -73.7 },
  // Staten Island, south of Bayonne.
  { south: 40.49, west: -74.26, north: 40.65, east: -74.05 },
];
const inNyc = (point: { readonly lat: number; readonly lon: number }): boolean => NYC_BOXES.some((box) => inBox(point, box));

const civicRecord = (record: Omit<z.input<typeof PlacesSourceRecordSchema>, "kind" | "precisionDecimals" | "fields">): PlacesSourceRecord =>
  PlacesSourceRecordSchema.parse({ ...record, kind: "civic", precisionDecimals: CIVIC_PRECISION, fields: [] });

async function ask(fetch: CivicFetch, request: PlacesRequest, now: string): Promise<SourceResponse | CivicOutcome> {
  const answer = await fetch(request);
  if ("skipped" in answer) return { kind: "skipped", reason: answer.skipped };
  return statusOutcome(answer, now) ?? answer;
}
const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
/** Socrata's floating timestamp (New York time, no offset), as written: a date, for counting by day. */
const socrataDay = (value: string): string => value.slice(0, 10);
/** An instant as NYC Open Data's floating timestamps hold it: New York's wall clock, no offset. */
export function newYorkFloating(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"] ?? ""}-${parts["month"] ?? ""}-${parts["day"] ?? ""}T${parts["hour"] ?? ""}:${parts["minute"] ?? ""}:${parts["second"] ?? ""}`;
}
/** The caveat for an answer that filled its row cap. */
const capped = (rows: number): string | undefined =>
  rows >= ROWS_MAX ? `the source answers at most ${String(ROWS_MAX)} rows: there are at least this many` : undefined;

// New York City: 311 service requests on Socrata.

export const nyc311Record = civicRecord({
  id: "nyc-311",
  name: "NYC 311 service requests",
  countries: ["US"],
  hosts: ["data.cityofnewyork.us"],
  auth: "none",
  credential: ["socrataAppToken"],
  terms: {
    url: "https://opendata.cityofnewyork.us/overview/#termsofuse",
    reviewedAt: "2026-10-17",
    licence: "public",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "NYC Open Data, 311 Service Requests",
    displayRules: ["Complaints are what people reported, not findings"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 500 },
});
const Nyc311Row = z.looseObject({
  complaint_type: z.string(),
  descriptor: z.string().optional(),
  status: z.string().optional(),
  created_date: z.string(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
});

export const nyc311: CivicAdapter = {
  record: nyc311Record,
  topic: "complaints",
  covers: (point, country) => (country === undefined || country === "US") && inNyc(point),
  async run(query, call, fetch) {
    const point = coarsenPoint(query.point, CIVIC_PRECISION);
    const metres = Math.round(query.radiusKm * 1_000);
    const where = `within_circle(location, ${String(point.lat)}, ${String(point.lon)}, ${String(metres)}) AND created_date > '${newYorkFloating(query.since)}'`;
    const token = call.credential("socrataAppToken");
    const request: PlacesRequest = {
      source: nyc311Record.id,
      url: `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$select=${encodeURIComponent("complaint_type,descriptor,status,created_date,latitude,longitude")}&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent("created_date DESC")}&$limit=${String(ROWS_MAX)}`,
      ...(token === undefined ? {} : { headers: { "X-App-Token": token } }),
      body: "json",
      area: { point, precisionDecimals: CIVIC_PRECISION, country: "US" },
    };
    const answer = await ask(fetch, request, call.now);
    if ("kind" in answer) return answer;
    if (!Array.isArray(answer.body)) return { kind: "drift", detail: "the answer is not a list of rows" };
    const items: CivicItem[] = [];
    for (const item of answer.body) {
      const row = Nyc311Row.safeParse(item);
      if (!row.success) continue;
      const lat = number(row.data.latitude);
      const lon = number(row.data.longitude);
      // within_circle matched its location; a row without coordinates is counted, at no distance of Tavi's making.
      if (lat === undefined || lon === undefined) continue;
      items.push({
        kind: row.data.descriptor === undefined ? row.data.complaint_type : `${row.data.complaint_type}: ${row.data.descriptor}`,
        ...(row.data.status === undefined ? {} : { status: row.data.status }),
        at: socrataDay(row.data.created_date),
        distanceKm: Math.round(distanceKm(query.point, { lat, lon }) * 100) / 100,
      });
    }
    if (answer.body.length > 0 && items.length * 2 < answer.body.length) return { kind: "drift", detail: "the rows are not 311 requests" };
    const caveat = capped(answer.body.length);
    return { kind: "ok", report: { topic: "complaints", items, ...(caveat === undefined ? {} : { caveat }) } };
  },
};

// New York City: DOB NOW approved building permits on Socrata.

export const nycDobRecord = civicRecord({
  id: "nyc-dob",
  name: "NYC DOB NOW building permits",
  countries: ["US"],
  hosts: ["data.cityofnewyork.us"],
  auth: "none",
  credential: ["socrataAppToken"],
  terms: {
    url: "https://opendata.cityofnewyork.us/overview/#termsofuse",
    reviewedAt: "2026-10-17",
    licence: "public",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "NYC Open Data, DOB NOW: Build – Approved Permits",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 500 },
});
const DobRow = z.looseObject({
  work_type: z.string(),
  permit_status: z.string().optional(),
  issued_date: z.string(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
});

export const nycDob: CivicAdapter = {
  record: nycDobRecord,
  topic: "permits",
  covers: nyc311.covers,
  async run(query, call, fetch) {
    const point = coarsenPoint(query.point, CIVIC_PRECISION);
    const box = boxAround(point, query.radiusKm);
    const fixed = (value: number): string => value.toFixed(4);
    // Issue dates are midnight only: the window's first day is counted whole.
    const where = `latitude between ${fixed(box.south)} and ${fixed(box.north)} AND longitude between ${fixed(box.west)} and ${fixed(box.east)} AND issued_date >= '${newYorkFloating(query.since).slice(0, 10)}T00:00:00'`;
    const token = call.credential("socrataAppToken");
    const request: PlacesRequest = {
      source: nycDobRecord.id,
      url: `https://data.cityofnewyork.us/resource/rbx6-tga4.json?$select=${encodeURIComponent("work_type,permit_status,issued_date,latitude,longitude")}&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent("issued_date DESC")}&$limit=${String(ROWS_MAX)}`,
      ...(token === undefined ? {} : { headers: { "X-App-Token": token } }),
      body: "json",
      area: { point, precisionDecimals: CIVIC_PRECISION, country: "US" },
    };
    const answer = await ask(fetch, request, call.now);
    if ("kind" in answer) return answer;
    if (!Array.isArray(answer.body)) return { kind: "drift", detail: "the answer is not a list of rows" };
    const items: CivicItem[] = [];
    for (const item of answer.body) {
      const row = DobRow.safeParse(item);
      if (!row.success) continue;
      const lat = number(row.data.latitude);
      const lon = number(row.data.longitude);
      if (lat === undefined || lon === undefined) continue;
      const distance = distanceKm(query.point, { lat, lon });
      // The box's corners lie past the radius.
      if (distance > query.radiusKm) continue;
      items.push({
        kind: row.data.work_type,
        ...(row.data.permit_status === undefined ? {} : { status: row.data.permit_status }),
        at: socrataDay(row.data.issued_date),
        distanceKm: Math.round(distance * 100) / 100,
      });
    }
    const caveat = capped(answer.body.length);
    return { kind: "ok", report: { topic: "permits", items, ...(caveat === undefined ? {} : { caveat }) } };
  },
};

// England, Wales and Northern Ireland: data.police.uk's street-level crime, a month at a time, its points anonymised.

export const policeUkRecord = civicRecord({
  id: "police-uk",
  name: "data.police.uk street-level crime",
  countries: ["GB"],
  hosts: ["data.police.uk"],
  auth: "none",
  terms: {
    url: "https://data.police.uk/about/",
    reviewedAt: "2026-10-17",
    licence: "OGL-3.0",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "data.police.uk, Open Government Licence v3.0",
    displayRules: ["Crime locations are moved to anonymised points near where they happened; counts are one month's"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 5, perDay: 500 },
});
/** The largest radius a point rounded to 2 decimals still answers in full within the service's mile. */
const POLICE_COARSE_RADIUS_KM = 0.8;
const PoliceCrime = z.looseObject({
  category: z.string(),
  month: z.string(),
  location: z.looseObject({ latitude: z.string(), longitude: z.string() }),
  outcome_status: z.looseObject({ category: z.string() }).nullable().optional(),
});

export const policeUk: CivicAdapter = {
  record: policeUkRecord,
  topic: "crime",
  covers: (_point, country) => country === "GB",
  async run(query, call, fetch) {
    // The service answers a fixed mile around the point: rounded to about a kilometre, that mile still holds a radius up to 0.8 km.
    const decimals = query.radiusKm <= POLICE_COARSE_RADIUS_KM ? 2 : CIVIC_PRECISION;
    const point = coarsenPoint(query.point, decimals);
    // The latest month published; its radius is narrowed here.
    const request: PlacesRequest = {
      source: policeUkRecord.id,
      url: `https://data.police.uk/api/crimes-street/all-crime?lat=${String(point.lat)}&lng=${String(point.lon)}`,
      body: "json",
      area: { point, precisionDecimals: decimals, country: "GB" },
    };
    const answer = await ask(fetch, request, call.now);
    if ("kind" in answer) return answer;
    if (!Array.isArray(answer.body)) return { kind: "drift", detail: "the answer is not a list of crimes" };
    const items: CivicItem[] = [];
    let month: string | undefined;
    let dropped = 0;
    for (const item of answer.body) {
      const crime = PoliceCrime.safeParse(item);
      const lat = crime.success ? number(crime.data.location.latitude) : undefined;
      const lon = crime.success ? number(crime.data.location.longitude) : undefined;
      if (!crime.success || lat === undefined || lon === undefined) {
        dropped += 1;
        continue;
      }
      month ??= crime.data.month;
      const distance = distanceKm(query.point, { lat, lon });
      if (distance > query.radiusKm) continue;
      items.push({
        kind: crime.data.category.replace(/-/g, " "),
        ...(crime.data.outcome_status?.category === undefined ? {} : { status: crime.data.outcome_status.category }),
        at: crime.data.month,
        distanceKm: Math.round(distance * 100) / 100,
      });
    }
    if (answer.body.length > 0 && dropped * 2 > answer.body.length)
      return { kind: "drift", detail: `${String(dropped)} of ${String(answer.body.length)} crimes did not have the expected shape` };
    // A month with no crime in a whole mile is no data (Scotland is not published), not a quiet street.
    const caveat =
      answer.body.length === 0
        ? "data.police.uk has nothing within a mile of this point for its latest month: it publishes England, Wales and Northern Ireland only, so this is no data, not no crime"
        : undefined;
    return {
      kind: "ok",
      report: { topic: "crime", items, ...(month === undefined ? {} : { period: month }), ...(caveat === undefined ? {} : { caveat }) },
    };
  },
};

// Open311 GeoReport v2 cities: the list is data (the plugin's data/open311.json).

export const Open311CitySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  name: z.string().min(1).max(80),
  country: z.string().regex(/^[A-Z]{2}$/),
  endpoint: z
    .string()
    .url()
    .regex(/^https:\/\//),
  box: z.strictObject({ south: z.number(), west: z.number(), north: z.number(), east: z.number() }),
  reviewedAt: z.iso.date(),
});
export type Open311City = z.infer<typeof Open311CitySchema>;

const Open311Request = z.looseObject({
  service_name: z.string().optional(),
  status: z.string().optional(),
  requested_datetime: z.string(),
  lat: z.number().nullable().optional(),
  long: z.number().nullable().optional(),
});

/** An adapter for one Open311 city. Servers often ignore the point and radius, so both are applied here too. */
export function open311Adapter(city: Open311City): CivicAdapter {
  const record = civicRecord({
    id: `open311-${city.id}`,
    name: `${city.name} 311 (Open311)`,
    countries: [city.country],
    hosts: [new URL(city.endpoint).host],
    auth: "none",
    terms: {
      url: "https://wiki.open311.org/GeoReport_v2/",
      reviewedAt: city.reviewedAt,
      licence: "public",
      llmUse: "silent",
      cache: { mode: "none" },
      attribution: `${city.name} 311, via Open311`,
      displayRules: ["Requests are what people reported, not findings"],
      userTriggeredOnly: false,
    },
    budget: { perSecond: 1, perDay: 200 },
  });
  return {
    record,
    topic: "complaints",
    covers: (point, country) => (country === undefined || country === city.country) && inBox(point, city.box),
    async run(query, call, fetch) {
      // These servers answer the city's latest requests whatever point is sent, so none is: only the window leaves.
      const request: PlacesRequest = {
        source: record.id,
        url: `${city.endpoint.replace(/\/+$/, "")}/requests.json?start_date=${encodeURIComponent(new Date(query.since).toISOString().slice(0, 19))}Z`,
        body: "json",
      };
      const answer = await ask(fetch, request, call.now);
      if ("kind" in answer) return answer;
      if (!Array.isArray(answer.body)) return { kind: "drift", detail: "the answer is not a list of requests" };
      const items: CivicItem[] = [];
      for (const item of answer.body.slice(0, ROWS_MAX)) {
        const row = Open311Request.safeParse(item);
        if (!row.success || row.data.lat === null || row.data.lat === undefined || row.data.long === null || row.data.long === undefined)
          continue;
        const distance = distanceKm(query.point, { lat: row.data.lat, lon: row.data.long });
        if (distance > query.radiusKm || Date.parse(row.data.requested_datetime) < Date.parse(query.since)) continue;
        items.push({
          kind: row.data.service_name ?? "request",
          ...(row.data.status === undefined ? {} : { status: row.data.status }),
          at: row.data.requested_datetime.slice(0, 10),
          distanceKm: Math.round(distance * 100) / 100,
        });
      }
      return {
        kind: "ok",
        report: {
          topic: "complaints",
          items,
          caveat: `a sample: ${city.name}'s server answers its latest ${String(answer.body.length)} requests citywide, and only those within the radius are counted`,
        },
      };
    },
  };
}

/** The fixed civic sources; Open311 cities are added from their list. */
export const CIVIC_SOURCES: readonly CivicAdapter[] = [nyc311, nycDob, policeUk];
