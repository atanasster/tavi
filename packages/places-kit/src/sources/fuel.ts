import { z } from "zod";

import { CandidateSchema, PlacesSourceRecordSchema, type Candidate, type FUELS, type PlacesSourceRecord } from "../contracts.js";
import { coarsenPoint, distanceKm } from "../geo.js";
import { drifted, statusOutcome } from "./common.js";
import { excelDate, readXlsxRows } from "../xlsx.js";
import type { Failure, PlacesRequest, SourceCall, SourceResponse } from "./types.js";

/**
 * Fuel prices by country: each source an adapter that runs its own requests through
 * the engine's `fetch`, so its budget, health and log apply to every one.
 * A price carries when the source says it was reported; the US has only
 * EIA's weekly regional averages.
 */

export type Fuel = (typeof FUELS)[number];

export interface FuelQuery {
  readonly point: { readonly lat: number; readonly lon: number };
  readonly radiusKm: number;
  readonly fuel: Fuel;
  /** What the geocoder called the area, for a source that answers by region (EIA's states). */
  readonly areaLabel?: string | undefined;
  /** The area's country, for a source that answers by country (the EU's Oil Bulletin). */
  readonly country?: string | undefined;
  readonly limit: number;
}

/**
 * What a price's `reportedAt` means: `read`, as a live service answered now;
 * `changed`, when the station last changed it; `published`, when the feed was
 * built; `daily`, the time of a once-a-day snapshot, which `maxAgeHours`
 * does not cut, as it is always a day old.
 */
export type PriceBasis = "read" | "changed" | "published" | "daily";

export interface FuelPrice {
  readonly amount: number;
  readonly currency: string;
  /** The fuel as the source names it. */
  readonly fuel: string;
  readonly reportedAt: string;
  readonly basis: PriceBasis;
  readonly source: string;
}

/** A station a source reported, with its price for the fuel asked when it has one. */
export interface FuelRead {
  readonly candidate: Candidate;
  readonly price?: FuelPrice;
}

/** A weekly average for a region, where no station prices exist (EIA, the EU's Oil Bulletin). */
export interface RegionalAverage extends FuelPrice {
  readonly area: string;
  readonly unit: "gallon" | "litre";
  /** Days since the average's week, when the publisher has missed issues (the Oil Bulletin's past 15). */
  readonly staleDays?: number;
}

export type FuelOutcome =
  | { readonly kind: "ok"; readonly stations: readonly FuelRead[]; readonly average?: RegionalAverage }
  | { readonly kind: "skipped"; readonly reason: string }
  | Failure;

/** One request through the engine: its budget, health and log. */
export type FuelFetch = (request: PlacesRequest) => Promise<SourceResponse | { readonly skipped: string }>;

export interface FuelAdapter {
  readonly record: PlacesSourceRecord;
  /** The currency its prices are in. */
  readonly currency: string;
  /** A source of regional averages, never a station's price (EIA): nothing a watch can find under a price. */
  readonly averagesOnly?: true;
  /** Whether a point is in the area the source covers, when that is less than its countries. */
  covers?(point: { readonly lat: number; readonly lon: number }): boolean;
  run(query: FuelQuery, call: SourceCall, fetch: FuelFetch): Promise<FuelOutcome>;
  /** A background read of a newer issue, for a source that keeps one (the Oil Bulletin's week); a failure when it failed. */
  refresh?(call: SourceCall, fetch: FuelFetch): Promise<Exclude<FuelOutcome, { readonly kind: "ok" }> | undefined>;
}

/** Stations one source answers at most. */
const STATIONS_MAX = 100;

const fuelRecord = (record: Omit<z.input<typeof PlacesSourceRecordSchema>, "kind" | "precisionDecimals" | "fields">): PlacesSourceRecord =>
  PlacesSourceRecordSchema.parse({ ...record, kind: "fuel", precisionDecimals: 2, fields: ["price"] });

/** A station as a candidate, or `undefined` when the source's row has no name or place. */
function stationCandidate(
  record: PlacesSourceRecord,
  fields: {
    readonly id: string;
    readonly name: string | undefined;
    readonly lat: number;
    readonly lon: number;
    readonly address?: string | undefined;
    readonly postcode?: string | undefined;
    readonly country: string;
    readonly phone?: string | undefined;
    readonly brand?: string | undefined;
  },
): Candidate | undefined {
  const name = fields.name?.trim();
  if (name === undefined || name === "" || !Number.isFinite(fields.lat) || !Number.isFinite(fields.lon)) return undefined;
  const parsed = CandidateSchema.safeParse({
    source: record.id,
    sourceId: fields.id.slice(0, 200),
    licence: record.terms.licence,
    attribution: record.terms.attribution,
    name: name.slice(0, 200),
    categories: ["fuel"],
    ...(fields.address === undefined || fields.address.trim() === "" ? {} : { address: fields.address.trim().slice(0, 300) }),
    ...(fields.postcode === undefined || fields.postcode === "" ? {} : { postcode: fields.postcode.slice(0, 20) }),
    country: fields.country,
    lat: fields.lat,
    lon: fields.lon,
    ...(fields.phone === undefined || fields.phone === "" ? {} : { phone: fields.phone.slice(0, 60) }),
    ...(fields.brand === undefined || fields.brand === "" ? {} : { brand: fields.brand.slice(0, 120) }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A positive price, or `undefined`. */
const priceOf = (value: unknown, scale = 1): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(",", ".")) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? Math.round((number / scale) * 1_000) / 1_000 : undefined;
};

/** One request, read as an answer or a failure the adapter reports. */
async function ask(
  fetch: FuelFetch,
  request: PlacesRequest,
  now: string,
): Promise<SourceResponse | { readonly skipped: string } | Failure> {
  const answer = await fetch(request);
  if ("skipped" in answer) return answer;
  return statusOutcome(answer, now) ?? answer;
}
/** The outcome that ends an adapter's run here, or `undefined` for an answer to read. */
type Stop = Exclude<FuelOutcome, { readonly kind: "ok" }>;
const failed = (answer: SourceResponse | { readonly skipped: string } | Failure): Stop | undefined =>
  "skipped" in answer ? { kind: "skipped", reason: answer.skipped } : "kind" in answer ? answer : undefined;

/** An ISO instant from a source's own time text, or `undefined` for one that is not a time. */
const safeIso = (text: string | undefined): string | undefined => {
  const ms = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/** A zone's offset from UTC at an instant, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return (
    Date.UTC(
      Number(parts["year"]),
      Number(parts["month"]) - 1,
      Number(parts["day"]),
      Number(parts["hour"]),
      Number(parts["minute"]),
      Number(parts["second"]),
    ) - instant
  );
}

/** A wall-clock time in a zone as an ISO instant; the offset taken again at the first answer, so a time near a clock change is right. */
export function zonedIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): string | undefined {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(wall)) return undefined;
  const first = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(first, timeZone)).toISOString();
}
/** `dd/mm/yyyy h:mm[:ss]` in a zone. */
function dmyIso(text: string | undefined, timeZone: string): string | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text?.trim() ?? "");
  if (match === null) return undefined;
  return zonedIso(
    Number(match[3]),
    Number(match[2]),
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? "0"),
    timeZone,
  );
}

// Germany: Tankerkönig (MTS-K). A personal key in the query string; only for requests a person makes.

export const tankerkoenigRecord = fuelRecord({
  id: "tankerkoenig",
  name: "Tankerkönig (MTS-K)",
  countries: ["DE"],
  hosts: ["creativecommons.tankerkoenig.de"],
  auth: "key-query",
  credential: ["tankerkoenigKey"],
  terms: {
    url: "https://creativecommons.tankerkoenig.de/",
    reviewedAt: "2026-10-17",
    licence: "CC-BY-4.0",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Tankerkönig (MTS-K), CC BY 4.0",
    displayRules: [
      "Prices from the Markttransparenzstelle für Kraftstoffe via Tankerkönig",
      "Do not filter stations by brand unless the person asks",
    ],
    userTriggeredOnly: true,
  },
  budget: { perSecond: 0.2, perDay: 500 },
});
const TANKERKOENIG_FUELS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "diesel"],
  ["e5", "e5"],
  ["e10", "e10"],
]);
const TankerkoenigAnswer = z.looseObject({ ok: z.boolean(), message: z.string().optional(), stations: z.array(z.unknown()).optional() });
const TankerkoenigStation = z.looseObject({
  id: z.string(),
  name: z.string(),
  brand: z.string().optional(),
  street: z.string().optional(),
  houseNumber: z.string().nullable().optional(),
  postCode: z.union([z.string(), z.number()]).nullable().optional(),
  place: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
});

export const tankerkoenig: FuelAdapter = {
  record: tankerkoenigRecord,
  currency: "EUR",
  async run(query, call, fetch) {
    const field = TANKERKOENIG_FUELS.get(query.fuel);
    if (field === undefined) return { kind: "skipped", reason: "Tankerkönig reports only diesel, E5 and E10" };
    const key = call.credential("tankerkoenigKey");
    if (key === undefined) return { kind: "skipped", reason: "not set up: its key (tankerkoenigKey) is missing" };
    const point = coarsenPoint(query.point, tankerkoenigRecord.precisionDecimals);
    const radius = Math.min(25, Math.max(1, Math.round(query.radiusKm)));
    const request: PlacesRequest = {
      source: tankerkoenigRecord.id,
      url: `https://creativecommons.tankerkoenig.de/json/list.php?lat=${String(point.lat)}&lng=${String(point.lon)}&rad=${String(radius)}&sort=dist&type=all&apikey=${encodeURIComponent(key)}`,
      body: "json",
      area: { point, precisionDecimals: tankerkoenigRecord.precisionDecimals, country: "DE" },
    };
    const answer = await ask(fetch, request, call.now);
    const stop = failed(answer);
    if (stop !== undefined) return stop;
    const body = TankerkoenigAnswer.safeParse((answer as SourceResponse).body);
    if (!body.success) return { kind: "drift", detail: "the answer is not Tankerkönig's list" };
    if (!body.data.ok) return /api ?key/i.test(body.data.message ?? "") ? { kind: "unauthorized" } : { kind: "failed", status: 200 };
    const stations: FuelRead[] = [];
    const items = (body.data.stations ?? []).slice(0, STATIONS_MAX);
    let dropped = 0;
    for (const item of items) {
      const station = TankerkoenigStation.safeParse(item);
      if (!station.success) {
        dropped += 1;
        continue;
      }
      const row = station.data;
      const candidate = stationCandidate(tankerkoenigRecord, {
        id: row.id,
        name: row.name,
        lat: row.lat,
        lon: row.lng,
        address: [[row.street, row.houseNumber].filter((part) => part !== undefined && part !== null && part !== "").join(" "), row.place]
          .filter((part) => part !== undefined && part !== "")
          .join(", "),
        postcode: row.postCode === undefined || row.postCode === null ? undefined : String(row.postCode).padStart(5, "0"),
        country: "DE",
        brand: row.brand,
      });
      if (candidate === undefined) continue;
      const amount = priceOf((item as Record<string, unknown>)[field]);
      // Tankerkönig reads MTS-K live: its prices are as of the request.
      stations.push({
        candidate,
        ...(amount === undefined
          ? {}
          : { price: { amount, currency: "EUR", fuel: field, reportedAt: call.now, basis: "read", source: tankerkoenigRecord.id } }),
      });
    }
    if (drifted(dropped, items.length))
      return { kind: "drift", detail: `${String(dropped)} of ${String(items.length)} stations did not have the expected shape` };
    return { kind: "ok", stations };
  },
};

// France: prix des carburants v2 on data.economie.gouv.fr (Opendatasoft), keyless.

export const frCarburantsRecord = fuelRecord({
  id: "fr-carburants",
  name: "Prix des carburants (France)",
  countries: ["FR"],
  hosts: ["data.economie.gouv.fr"],
  auth: "none",
  terms: {
    url: "https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/information/",
    reviewedAt: "2026-10-17",
    licence: "Licence Ouverte 2.0",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Ministère de l'Économie, prix-carburants.gouv.fr (Licence Ouverte 2.0)",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
});
const FR_FUELS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "gazole"],
  ["e5", "sp95"],
  ["e10", "e10"],
  ["super98", "sp98"],
  ["lpg", "gplc"],
  ["e85", "e85"],
]);
const FrAnswer = z.looseObject({ results: z.array(z.unknown()) });
const FrStation = z.looseObject({
  id: z.union([z.number(), z.string()]),
  adresse: z.string().optional(),
  ville: z.string().optional(),
  cp: z.string().optional(),
  geom: z.looseObject({ lat: z.number(), lon: z.number() }),
});

export const frCarburants: FuelAdapter = {
  record: frCarburantsRecord,
  currency: "EUR",
  async run(query, call, fetch) {
    const field = FR_FUELS.get(query.fuel) as string;
    const point = coarsenPoint(query.point, frCarburantsRecord.precisionDecimals);
    const radius = Math.min(50, Math.max(1, Math.round(query.radiusKm)));
    const where = `within_distance(geom, geom'POINT(${String(point.lon)} ${String(point.lat)})', ${String(radius)}km) and ${field}_prix is not null`;
    const request: PlacesRequest = {
      source: frCarburantsRecord.id,
      url: `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?where=${encodeURIComponent(where)}&order_by=${field}_prix&limit=${String(Math.min(100, query.limit * 3))}`,
      body: "json",
      area: { point, precisionDecimals: frCarburantsRecord.precisionDecimals, country: "FR" },
    };
    const answer = await ask(fetch, request, call.now);
    const stop = failed(answer);
    if (stop !== undefined) return stop;
    const body = FrAnswer.safeParse((answer as SourceResponse).body);
    if (!body.success) return { kind: "drift", detail: "the answer has no results list" };
    const stations: FuelRead[] = [];
    const items = body.data.results.slice(0, STATIONS_MAX);
    let dropped = 0;
    for (const item of items) {
      const station = FrStation.safeParse(item);
      if (!station.success) {
        dropped += 1;
        continue;
      }
      const row = station.data;
      // The feed names no station: its address stands for it.
      const candidate = stationCandidate(frCarburantsRecord, {
        id: String(row.id),
        name: row.adresse === undefined ? undefined : `Station, ${row.adresse}`,
        lat: row.geom.lat,
        lon: row.geom.lon,
        address: [row.adresse, row.ville].filter((part) => part !== undefined).join(", "),
        postcode: row.cp,
        country: "FR",
      });
      if (candidate === undefined) continue;
      const fields = item as Record<string, unknown>;
      const amount = priceOf(fields[`${field}_prix`]);
      const reportedAt = safeIso(typeof fields[`${field}_maj`] === "string" ? (fields[`${field}_maj`] as string) : undefined);
      stations.push({
        candidate,
        ...(amount === undefined || reportedAt === undefined
          ? {}
          : { price: { amount, currency: "EUR", fuel: field, reportedAt, basis: "changed", source: frCarburantsRecord.id } }),
      });
    }
    if (drifted(dropped, items.length))
      return { kind: "drift", detail: `${String(dropped)} of ${String(items.length)} stations did not have the expected shape` };
    return { kind: "ok", stations };
  },
};

// Spain: the ministry's Geoportal REST service, keyless, one province's stations per request.

export const esGeoportalRecord = fuelRecord({
  id: "es-geoportal",
  name: "Geoportal Gasolineras (Spain)",
  countries: ["ES"],
  hosts: ["sedeaplicaciones.minetur.gob.es"],
  auth: "none",
  terms: {
    url: "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/help",
    reviewedAt: "2026-10-17",
    licence: "datos.gob.es (unconfirmed)",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Ministerio para la Transición Ecológica, Geoportal Gasolineras",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.5, perDay: 200 },
});
/** Each province's id and the centre of its stations, from the ministry's national list on 2026-10-17. */
export const ES_PROVINCES: readonly (readonly [string, number, number])[] = [
  ["01", 42.85, -2.7],
  ["02", 38.95, -1.87],
  ["03", 38.38, -0.53],
  ["04", 37.0, -2.4],
  ["05", 40.63, -4.8],
  ["06", 38.75, -6.34],
  ["07", 39.56, 2.83],
  ["08", 41.48, 2.09],
  ["09", 42.32, -3.6],
  ["10", 39.74, -6.09],
  ["11", 36.5, -5.95],
  ["12", 40.05, -0.06],
  ["13", 38.98, -3.55],
  ["14", 37.77, -4.73],
  ["15", 43.16, -8.47],
  ["16", 39.74, -2.34],
  ["17", 42.07, 2.84],
  ["18", 37.19, -3.51],
  ["19", 40.7, -3.01],
  ["20", 43.22, -2.09],
  ["21", 37.39, -6.88],
  ["22", 42.04, -0.04],
  ["23", 37.97, -3.6],
  ["24", 42.55, -5.88],
  ["25", 41.8, 0.89],
  ["26", 42.38, -2.37],
  ["27", 43.09, -7.5],
  ["28", 40.37, -3.69],
  ["29", 36.71, -4.62],
  ["30", 37.81, -1.23],
  ["31", 42.62, -1.71],
  ["32", 42.24, -7.73],
  ["33", 43.43, -5.88],
  ["34", 42.23, -4.48],
  ["35", 28.23, -14.97],
  ["36", 42.14, -8.39],
  ["37", 40.86, -5.87],
  ["38", 28.34, -16.65],
  ["39", 43.11, -3.85],
  ["40", 41.09, -4.12],
  ["41", 37.36, -5.79],
  ["42", 41.63, -2.53],
  ["43", 41.06, 1.02],
  ["44", 40.68, -0.75],
  ["45", 39.9, -4.03],
  ["46", 39.36, -0.47],
  ["47", 41.59, -4.79],
  ["48", 43.27, -2.88],
  ["49", 41.72, -5.77],
  ["50", 41.63, -1.03],
  ["51", 35.89, -5.32],
  ["52", 35.28, -2.94],
];
/** Provinces one query reads: the point's own and its nearest neighbour, as a radius may cross a border. */
const ES_PROVINCES_PER_QUERY = 2;
const ES_FUELS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "Precio Gasoleo A"],
  ["e5", "Precio Gasolina 95 E5"],
  ["e10", "Precio Gasolina 95 E10"],
  ["super98", "Precio Gasolina 98 E5"],
  ["lpg", "Precio Gases licuados del petróleo"],
  ["e85", "Precio Gasolina 95 E85"],
]);
const EsAnswer = z.looseObject({ Fecha: z.string(), ListaEESSPrecio: z.array(z.record(z.string(), z.unknown())) });

export const esGeoportal: FuelAdapter = {
  record: esGeoportalRecord,
  currency: "EUR",
  async run(query, call, fetch) {
    const field = ES_FUELS.get(query.fuel) as string;
    const provinces = [...ES_PROVINCES]
      .sort((a, b) => distanceKm(query.point, { lat: a[1], lon: a[2] }) - distanceKm(query.point, { lat: b[1], lon: b[2] }))
      .slice(0, ES_PROVINCES_PER_QUERY);
    const stations: FuelRead[] = [];
    for (const [province] of provinces) {
      // A province's id is all that leaves: no point at all.
      const request: PlacesRequest = {
        source: esGeoportalRecord.id,
        url: `https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/${province}`,
        body: "json",
      };
      const answer = await ask(fetch, request, call.now);
      const stop = failed(answer);
      // A neighbouring province failing leaves the stations already read.
      if (stop !== undefined) return stations.length > 0 ? { kind: "ok", stations: stations.slice(0, STATIONS_MAX) } : stop;
      const body = EsAnswer.safeParse((answer as SourceResponse).body);
      if (!body.success) return { kind: "drift", detail: "the answer has no station list" };
      const reportedAt = dmyIso(body.data.Fecha, "Europe/Madrid");
      let dropped = 0;
      for (const row of body.data.ListaEESSPrecio) {
        const lat = Number(String(row["Latitud"] ?? "").replace(",", "."));
        const lon = Number(String(row["Longitud (WGS84)"] ?? "").replace(",", "."));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          dropped += 1;
          continue;
        }
        if (distanceKm(query.point, { lat, lon }) > query.radiusKm) continue;
        const text = (key: string): string | undefined => (typeof row[key] === "string" ? (row[key] as string) : undefined);
        const candidate = stationCandidate(esGeoportalRecord, {
          id: text("IDEESS") ?? `${String(lat)},${String(lon)}`,
          name: text("Rótulo"),
          lat,
          lon,
          address: [text("Dirección"), text("Localidad")].filter((part) => part !== undefined).join(", "),
          postcode: text("C.P."),
          country: "ES",
        });
        if (candidate === undefined) continue;
        const amount = priceOf(row[field]);
        stations.push({
          candidate,
          ...(amount === undefined || reportedAt === undefined
            ? {}
            : {
                price: {
                  amount,
                  currency: "EUR",
                  fuel: field.replace(/^Precio /, ""),
                  reportedAt,
                  basis: "published",
                  source: esGeoportalRecord.id,
                },
              }),
        });
      }
      if (drifted(dropped, body.data.ListaEESSPrecio.length))
        return { kind: "drift", detail: `${String(dropped)} of ${String(body.data.ListaEESSPrecio.length)} stations had no place` };
    }
    return { kind: "ok", stations: stations.slice(0, STATIONS_MAX) };
  },
};

// Italy: MIMIT's daily CSVs (the stations, and yesterday's 08:00 prices), keyless.

export const itMimitRecord = fuelRecord({
  id: "it-mimit",
  name: "Osservaprezzi carburanti (Italy)",
  countries: ["IT"],
  hosts: ["www.mimit.gov.it"],
  auth: "none",
  terms: {
    url: "https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti",
    reviewedAt: "2026-10-17",
    licence: "IODL-2.0",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Ministero delle Imprese e del Made in Italy, Osservaprezzi carburanti (IODL 2.0)",
    displayRules: ["Prices are those reported at 08:00 the day before"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.1, perDay: 10 },
});
const IT_FUELS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "gasolio"],
  ["e5", "benzina"],
  ["lpg", "gpl"],
]);

/** A CSV with a title line before its header, `|` or `;` between fields, as rows by header name. */
export function mimitRows(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  const headerAt = lines.findIndex((line) => /idImpianto/i.test(line));
  if (headerAt < 0) return [];
  const header = lines[headerAt] as string;
  const separator = header.includes("|") ? "|" : ";";
  const names = header.split(separator).map((name) => name.trim());
  return lines
    .slice(headerAt + 1)
    .map((line) => Object.fromEntries(line.split(separator).map((value, index) => [names[index] ?? String(index), value.trim()])));
}

export const itMimit: FuelAdapter = {
  record: itMimitRecord,
  currency: "EUR",
  async run(query, call, fetch) {
    const wanted = IT_FUELS.get(query.fuel);
    if (wanted === undefined)
      return { kind: "skipped", reason: "MIMIT's data is read for petrol (benzina), diesel (gasolio) and LPG only" };
    const read = async (file: string): Promise<Record<string, string>[] | FuelOutcome> => {
      const answer = await ask(
        fetch,
        { source: itMimitRecord.id, url: `https://www.mimit.gov.it/images/exportCSV/${file}`, body: "text" },
        call.now,
      );
      const stop = failed(answer);
      if (stop !== undefined) return stop;
      const body = (answer as SourceResponse).body;
      return typeof body === "string" ? mimitRows(body) : { kind: "drift", detail: `${file} is not text` };
    };
    const registry = await read("anagrafica_impianti_attivi.csv");
    if (!Array.isArray(registry)) return registry;
    const prices = await read("prezzo_alle_8.csv");
    if (!Array.isArray(prices)) return prices;
    if (registry.length > 0 && registry[0]?.["Latitudine"] === undefined)
      return { kind: "drift", detail: "the stations file has no Latitudine column" };
    if (prices.length > 0 && prices[0]?.["prezzo"] === undefined) return { kind: "drift", detail: "the prices file has no prezzo column" };
    const near = new Map<string, Candidate>();
    for (const row of registry) {
      const lat = Number((row["Latitudine"] ?? "").replace(",", "."));
      const lon = Number((row["Longitudine"] ?? "").replace(",", "."));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || distanceKm(query.point, { lat, lon }) > query.radiusKm) continue;
      const candidate = stationCandidate(itMimitRecord, {
        id: row["idImpianto"] ?? "",
        name: row["Nome Impianto"] || row["Bandiera"],
        lat,
        lon,
        address: [row["Indirizzo"], row["Comune"]].filter((part) => part !== undefined && part !== "").join(", "),
        country: "IT",
        brand: row["Bandiera"],
      });
      if (candidate !== undefined && candidate.sourceId !== "") near.set(candidate.sourceId, candidate);
    }
    // The cheapest self-service price for the fuel, else the cheapest served one.
    const best = new Map<string, { amount: number; self: boolean; reportedAt: string | undefined; label: string }>();
    for (const row of prices) {
      const id = row["idImpianto"] ?? "";
      const label = row["descCarburante"] ?? "";
      if (!near.has(id) || label.toLowerCase() !== wanted) continue;
      const amount = priceOf(row["prezzo"]);
      if (amount === undefined) continue;
      const self = row["isSelf"] === "1";
      const current = best.get(id);
      if (current === undefined || (self && !current.self) || (self === current.self && amount < current.amount))
        best.set(id, { amount, self, reportedAt: dmyIso(row["dtComu"], "Europe/Rome"), label });
    }
    const stations = [...near.values()].slice(0, STATIONS_MAX).map((candidate): FuelRead => {
      const price = best.get(candidate.sourceId);
      return {
        candidate,
        ...(price === undefined || price.reportedAt === undefined
          ? {}
          : {
              price: {
                amount: price.amount,
                currency: "EUR",
                fuel: `${price.label}${price.self ? " (self)" : ""}`,
                reportedAt: price.reportedAt,
                basis: "daily",
                source: itMimitRecord.id,
              },
            }),
      };
    });
    return { kind: "ok", stations };
  },
};

// Austria: E-Control's Spritpreisrechner, keyless; only the 5 cheapest of the 10 nearest carry prices.

export const atEcontrolRecord = fuelRecord({
  id: "at-econtrol",
  name: "E-Control Spritpreisrechner (Austria)",
  countries: ["AT"],
  hosts: ["api.e-control.at"],
  auth: "none",
  terms: {
    url: "https://www.e-control.at/spritpreisrechner",
    reviewedAt: "2026-10-17",
    licence: "unknown",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "E-Control Spritpreisrechner",
    displayRules: ["Only the 5 cheapest of the 10 nearest stations carry a price: the others are not dearer by being unpriced"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 500 },
});
const AT_FUELS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "DIE"],
  ["e5", "SUP"],
]);
const AtStation = z.looseObject({
  id: z.number(),
  name: z.string(),
  location: z.looseObject({
    address: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
  }),
  contact: z.looseObject({ telephone: z.string().optional() }).optional(),
  prices: z.array(z.looseObject({ fuelType: z.string(), amount: z.number(), label: z.string().optional() })).optional(),
});

export const atEcontrol: FuelAdapter = {
  record: atEcontrolRecord,
  currency: "EUR",
  async run(query, call, fetch) {
    const type = AT_FUELS.get(query.fuel);
    if (type === undefined) return { kind: "skipped", reason: "E-Control reports diesel and Super 95 only" };
    const point = coarsenPoint(query.point, atEcontrolRecord.precisionDecimals);
    const request: PlacesRequest = {
      source: atEcontrolRecord.id,
      url: `https://api.e-control.at/sprit/1.0/search/gas-stations/by-address?latitude=${String(point.lat)}&longitude=${String(point.lon)}&fuelType=${type}&includeClosed=false`,
      body: "json",
      area: { point, precisionDecimals: atEcontrolRecord.precisionDecimals, country: "AT" },
    };
    const answer = await ask(fetch, request, call.now);
    const stop = failed(answer);
    if (stop !== undefined) return stop;
    const body = (answer as SourceResponse).body;
    if (!Array.isArray(body)) return { kind: "drift", detail: "the answer is not a list of stations" };
    const stations: FuelRead[] = [];
    const items = body.slice(0, STATIONS_MAX);
    let dropped = 0;
    for (const item of items) {
      const station = AtStation.safeParse(item);
      if (!station.success) {
        dropped += 1;
        continue;
      }
      const row = station.data;
      const candidate = stationCandidate(atEcontrolRecord, {
        id: String(row.id),
        name: row.name,
        lat: row.location.latitude,
        lon: row.location.longitude,
        address: [row.location.address, row.location.city].filter((part) => part !== undefined).join(", "),
        postcode: row.location.postalCode,
        country: "AT",
        phone: row.contact?.telephone,
      });
      if (candidate === undefined) continue;
      const price = row.prices?.find((each) => each.fuelType === type);
      // The service reads live prices: they are as of the request.
      stations.push({
        candidate,
        ...(price === undefined
          ? {}
          : {
              price: {
                amount: price.amount,
                currency: "EUR",
                fuel: price.label ?? type,
                reportedAt: call.now,
                basis: "read",
                source: atEcontrolRecord.id,
              },
            }),
      });
    }
    if (drifted(dropped, items.length))
      return { kind: "drift", detail: `${String(dropped)} of ${String(items.length)} stations did not have the expected shape` };
    return { kind: "ok", stations };
  },
};

// Western Australia: FuelWatch's RSS, keyless, statewide for one product.

export const waFuelwatchRecord = fuelRecord({
  id: "wa-fuelwatch",
  name: "FuelWatch (Western Australia)",
  countries: ["AU"],
  hosts: ["www.fuelwatch.wa.gov.au"],
  auth: "none",
  terms: {
    url: "https://www.fuelwatch.wa.gov.au/",
    reviewedAt: "2026-10-17",
    licence: "unknown",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "FuelWatch, Government of Western Australia",
    displayRules: ["Each price holds for the whole day from 06:00; tomorrow's are published at 14:30"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.5, perDay: 200 },
});
/** A rough box around Western Australia, and around New South Wales and Tasmania: who a lookup asks. */
const WA_BOX = { south: -35.2, west: 112.9, north: -13.6, east: 129.0 };
const NSW_BOX = { south: -37.6, west: 140.9, north: -28.1, east: 153.7 };
const TAS_BOX = { south: -43.7, west: 143.8, north: -39.5, east: 148.5 };
const inBox = (
  point: { readonly lat: number; readonly lon: number },
  box: { readonly south: number; readonly west: number; readonly north: number; readonly east: number },
): boolean => point.lat >= box.south && point.lat <= box.north && point.lon >= box.west && point.lon <= box.east;
const WA_PRODUCTS: ReadonlyMap<Fuel, string> = new Map([
  ["e5", "1"],
  ["diesel", "4"],
  ["lpg", "5"],
  ["super98", "6"],
  ["e85", "10"],
]);
const xmlText = (item: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(item);
  return match?.[1]
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
};

export const waFuelwatch: FuelAdapter = {
  record: waFuelwatchRecord,
  currency: "AUD",
  covers: (point) => inBox(point, WA_BOX),
  async run(query, call, fetch) {
    const product = WA_PRODUCTS.get(query.fuel);
    if (product === undefined) return { kind: "skipped", reason: "FuelWatch has no product for that fuel" };
    // The whole state's list for the product: no point leaves.
    const answer = await ask(
      fetch,
      { source: waFuelwatchRecord.id, url: `https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS?Product=${product}`, body: "text" },
      call.now,
    );
    const stop = failed(answer);
    if (stop !== undefined) return stop;
    const body = (answer as SourceResponse).body;
    if (typeof body !== "string" || !body.includes("<rss")) return { kind: "drift", detail: "the answer is not FuelWatch's RSS" };
    const stations: FuelRead[] = [];
    const items = body.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    let dropped = 0;
    for (const item of items) {
      const lat = Number(xmlText(item, "latitude"));
      const lon = Number(xmlText(item, "longitude"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || xmlText(item, "latitude") === undefined) {
        dropped += 1;
        continue;
      }
      if (distanceKm(query.point, { lat, lon }) > query.radiusKm) continue;
      const name = xmlText(item, "trading-name");
      const candidate = stationCandidate(waFuelwatchRecord, {
        id: `${name ?? ""}@${String(lat)},${String(lon)}`,
        name,
        lat,
        lon,
        address: [xmlText(item, "address"), xmlText(item, "location")].filter((part) => part !== undefined && part !== "").join(", "),
        country: "AU",
        phone: xmlText(item, "phone"),
        brand: xmlText(item, "brand"),
      });
      if (candidate === undefined) continue;
      const amount = priceOf(xmlText(item, "price"), 100);
      const day = xmlText(item, "date");
      const reportedAt = day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day) ? safeIso(`${day}T06:00:00+08:00`) : undefined;
      stations.push({
        candidate,
        ...(amount === undefined || reportedAt === undefined
          ? {}
          : {
              price: {
                amount,
                currency: "AUD",
                fuel: `FuelWatch product ${product}`,
                reportedAt,
                basis: "daily",
                source: waFuelwatchRecord.id,
              },
            }),
      });
      if (stations.length >= STATIONS_MAX) break;
    }
    if (drifted(dropped, items.length))
      return { kind: "drift", detail: `${String(dropped)} of ${String(items.length)} items had no place` };
    return { kind: "ok", stations };
  },
};

// New South Wales and Tasmania: FuelCheck on API.NSW, OAuth client credentials.

export const nswFuelcheckRecord = fuelRecord({
  id: "nsw-fuelcheck",
  name: "FuelCheck (NSW and Tasmania)",
  countries: ["AU"],
  hosts: ["api.onegov.nsw.gov.au"],
  auth: "oauth-client",
  credential: ["nswKey", "nswSecret"],
  terms: {
    url: "https://api.nsw.gov.au/Product/Index/22",
    reviewedAt: "2026-10-17",
    licence: "API.NSW terms",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "FuelCheck, NSW Government",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // 2,500 calls a month on the free plan, two per lookup (a token and the prices).
  budget: { perSecond: 0.5, perDay: 80 },
});
const NSW_FUELS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "DL"],
  ["e10", "E10"],
  ["e5", "U91"],
  ["super98", "P98"],
  ["lpg", "LPG"],
  ["e85", "E85"],
]);
const NswToken = z.looseObject({ access_token: z.string().min(1), expires_in: z.union([z.string(), z.number()]).optional() });
/** A token kept until a minute before it expires, by key: one token request serves many lookups. */
const nswTokens = new Map<string, { readonly token: string; readonly until: number }>();
const NSW_TOKEN_DEFAULT_S = 3_600;
const NswAnswer = z.looseObject({
  stations: z.array(
    z.looseObject({
      code: z.union([z.string(), z.number()]),
      name: z.string(),
      brand: z.string().optional(),
      address: z.string().optional(),
      location: z.looseObject({ latitude: z.number(), longitude: z.number() }),
    }),
  ),
  prices: z.array(
    z.looseObject({
      stationcode: z.union([z.string(), z.number()]),
      fueltype: z.string(),
      price: z.number(),
      lastupdated: z.string().optional(),
    }),
  ),
});

/** `dd/MM/yyyy hh:mm:ss AM`, as FuelCheck's `requesttimestamp` wants it, in UTC. */
function nswTimestamp(now: string): string {
  const at = new Date(now);
  const two = (value: number): string => String(value).padStart(2, "0");
  const hour = at.getUTCHours() % 12 === 0 ? 12 : at.getUTCHours() % 12;
  return `${two(at.getUTCDate())}/${two(at.getUTCMonth() + 1)}/${String(at.getUTCFullYear())} ${two(hour)}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCHours() < 12 ? "AM" : "PM"}`;
}

export const nswFuelcheck: FuelAdapter = {
  record: nswFuelcheckRecord,
  currency: "AUD",
  covers: (point) => inBox(point, NSW_BOX) || inBox(point, TAS_BOX),
  async run(query, call, fetch) {
    const key = call.credential("nswKey");
    const secret = call.credential("nswSecret");
    if (key === undefined || secret === undefined)
      return { kind: "skipped", reason: "not set up: its key and secret (nswKey, nswSecret) are missing" };
    const type = NSW_FUELS.get(query.fuel) as string;
    const nowMs = Date.parse(call.now);
    let bearer = nswTokens.get(key);
    if (bearer === undefined || bearer.until <= nowMs) {
      const token = await ask(
        fetch,
        {
          source: nswFuelcheckRecord.id,
          url: "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
          headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` },
          body: "json",
        },
        call.now,
      );
      const stopToken = failed(token);
      if (stopToken !== undefined) return stopToken;
      const access = NswToken.safeParse((token as SourceResponse).body);
      if (!access.success) return { kind: "drift", detail: "the token answer has no access_token" };
      const seconds = Number(access.data.expires_in ?? NSW_TOKEN_DEFAULT_S);
      bearer = {
        token: access.data.access_token,
        until: nowMs + (Number.isFinite(seconds) ? seconds : NSW_TOKEN_DEFAULT_S) * 1_000 - 60_000,
      };
      nswTokens.set(key, bearer);
    }
    const point = coarsenPoint(query.point, nswFuelcheckRecord.precisionDecimals);
    const request: PlacesRequest = {
      source: nswFuelcheckRecord.id,
      url: "https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/nearby",
      method: "POST",
      payload: JSON.stringify({
        fueltype: type,
        latitude: String(point.lat),
        longitude: String(point.lon),
        radius: String(Math.min(50, Math.max(1, Math.round(query.radiusKm)))),
        sortby: "price",
        sortascending: "true",
      }),
      headers: {
        apikey: key,
        Authorization: `Bearer ${bearer.token}`,
        "Content-Type": "application/json",
        transactionid: `tavi-${call.now}`,
        requesttimestamp: nswTimestamp(call.now),
      },
      body: "json",
      area: { point, precisionDecimals: nswFuelcheckRecord.precisionDecimals, country: "AU" },
    };
    const answer = await ask(fetch, request, call.now);
    const stop = failed(answer);
    // A refused token is dropped, so the next lookup asks for a new one.
    if (stop !== undefined && "kind" in stop && stop.kind === "unauthorized") nswTokens.delete(key);
    if (stop !== undefined) return stop;
    const body = NswAnswer.safeParse((answer as SourceResponse).body);
    if (!body.success) return { kind: "drift", detail: "the answer has no stations and prices" };
    const prices = new Map(body.data.prices.filter((price) => price.fueltype === type).map((price) => [String(price.stationcode), price]));
    const stations: FuelRead[] = [];
    for (const row of body.data.stations.slice(0, STATIONS_MAX)) {
      const candidate = stationCandidate(nswFuelcheckRecord, {
        id: String(row.code),
        name: row.name,
        lat: row.location.latitude,
        lon: row.location.longitude,
        address: row.address,
        country: "AU",
        brand: row.brand,
      });
      if (candidate === undefined) continue;
      const price = prices.get(String(row.code));
      const amount = priceOf(price?.price, 100);
      const reportedAt = dmyIso(price?.lastupdated, "Australia/Sydney");
      stations.push({
        candidate,
        ...(amount === undefined || reportedAt === undefined
          ? {}
          : { price: { amount, currency: "AUD", fuel: type, reportedAt, basis: "changed", source: nswFuelcheckRecord.id } }),
      });
    }
    return { kind: "ok", stations };
  },
};

// The US: no station prices; EIA's weekly retail averages for 9 states and the nation.

export const usEiaRecord = fuelRecord({
  id: "us-eia",
  name: "EIA weekly retail prices (US)",
  countries: ["US"],
  hosts: ["api.eia.gov"],
  auth: "key-query",
  credential: ["eiaKey"],
  terms: {
    url: "https://www.eia.gov/about/copyright_reuse.php",
    reviewedAt: "2026-10-17",
    licence: "public domain",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "U.S. Energy Information Administration",
    displayRules: ["A weekly regional average, not a station's price: say so"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 200 },
});
const EIA_PRODUCTS: ReadonlyMap<Fuel, string> = new Map([
  ["diesel", "EPD2D"],
  ["e5", "EPMR"],
  ["e10", "EPMR"],
  ["super98", "EPMP"],
]);
/** The states EIA publishes weekly averages for, by the name a geocoder's label carries. */
const EIA_STATES: ReadonlyMap<string, string> = new Map([
  ["California", "SCA"],
  ["Colorado", "SCO"],
  ["Florida", "SFL"],
  ["Massachusetts", "SMA"],
  ["Minnesota", "SMN"],
  ["New York", "SNY"],
  ["Ohio", "SOH"],
  ["Texas", "STX"],
  ["Washington", "SWA"],
]);
const EiaAnswer = z.looseObject({
  response: z.looseObject({
    data: z.array(
      z.looseObject({
        period: z.string(),
        "area-name": z.string().optional(),
        "product-name": z.string().optional(),
        value: z.union([z.number(), z.string()]).nullable(),
        units: z.string().optional(),
      }),
    ),
  }),
});

export const usEia: FuelAdapter = {
  record: usEiaRecord,
  currency: "USD",
  averagesOnly: true,
  async run(query, call, fetch) {
    const product = EIA_PRODUCTS.get(query.fuel);
    if (product === undefined) return { kind: "skipped", reason: "EIA averages gasoline and diesel only" };
    const key = call.credential("eiaKey");
    if (key === undefined) return { kind: "skipped", reason: "not set up: its key (eiaKey) is missing" };
    // The state is the label's part before "United States", as Nominatim and Photon write it; else the national average.
    const parts = (query.areaLabel ?? "").split(",").map((part) => part.trim());
    const named = parts.at(-1) === "United States" ? parts.at(-2) : undefined;
    const state = [...EIA_STATES].find(([name]) => name === named);
    const area = state?.[1] ?? "NUS";
    const request: PlacesRequest = {
      source: usEiaRecord.id,
      url: `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${encodeURIComponent(key)}&frequency=weekly&data[0]=value&facets[duoarea][]=${area}&facets[product][]=${product}&sort[0][column]=period&sort[0][direction]=desc&length=1`,
      body: "json",
    };
    const answer = await ask(fetch, request, call.now);
    const stop = failed(answer);
    if (stop !== undefined) return stop;
    const body = EiaAnswer.safeParse((answer as SourceResponse).body);
    if (!body.success) return { kind: "drift", detail: "the answer has no data list" };
    const latest = body.data.response.data[0];
    const amount = priceOf(latest?.value);
    if (latest === undefined || amount === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(latest.period)) return { kind: "ok", stations: [] };
    return {
      kind: "ok",
      stations: [],
      average: {
        amount,
        currency: "USD",
        unit: "gallon",
        fuel: latest["product-name"] ?? product,
        area: latest["area-name"] ?? state?.[0] ?? "United States",
        reportedAt: `${latest.period}T00:00:00.000Z`,
        basis: "published",
        source: usEiaRecord.id,
      },
    };
  },
};

// The EU: the Commission's Weekly Oil Bulletin, each member state's average retail price with taxes, keyless.

/** The member states as the Bulletin names them. */
const EU_COUNTRIES: ReadonlyMap<string, string> = new Map([
  ["Austria", "AT"],
  ["Belgium", "BE"],
  ["Bulgaria", "BG"],
  ["Croatia", "HR"],
  ["Cyprus", "CY"],
  ["Czechia", "CZ"],
  ["Denmark", "DK"],
  ["Estonia", "EE"],
  ["Finland", "FI"],
  ["France", "FR"],
  ["Germany", "DE"],
  ["Greece", "GR"],
  ["Hungary", "HU"],
  ["Ireland", "IE"],
  ["Italy", "IT"],
  ["Latvia", "LV"],
  ["Lithuania", "LT"],
  ["Luxembourg", "LU"],
  ["Malta", "MT"],
  ["Netherlands", "NL"],
  ["Poland", "PL"],
  ["Portugal", "PT"],
  ["Romania", "RO"],
  ["Slovakia", "SK"],
  ["Slovenia", "SI"],
  ["Spain", "ES"],
  ["Sweden", "SE"],
]);
/** Member states outside the euro, whose prices the Bulletin gives converted to euros. */
export const EU_LOCAL_CURRENCIES: ReadonlyMap<string, string> = new Map([
  ["CZ", "CZK"],
  ["DK", "DKK"],
  ["HU", "HUF"],
  ["PL", "PLN"],
  ["RO", "RON"],
  ["SE", "SEK"],
]);

export const euOilBulletinRecord = fuelRecord({
  id: "eu-oil-bulletin",
  name: "Weekly Oil Bulletin (European Commission)",
  countries: [...EU_COUNTRIES.values()],
  hosts: ["energy.ec.europa.eu"],
  auth: "none",
  terms: {
    url: "https://commission.europa.eu/legal-notice_en",
    reviewedAt: "2026-10-17",
    licence: "CC-BY-4.0",
    llmUse: "silent",
    cache: { mode: "ttl", days: 30 },
    attribution: "European Commission, Weekly Oil Bulletin (CC BY 4.0)",
    displayRules: [
      "A country's weekly average price with taxes, not a station's price: say so",
      "Outside the euro the Commission converts the price to euros: the pumps price in the country's own currency",
    ],
    userTriggeredOnly: false,
  },
  // Two requests a read (the page, then its file); a week is kept, and asked for again only once the next is due.
  budget: { perSecond: 0.5, perDay: 40 },
});
export const EU_OIL_BULLETIN_PAGE = "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en";
/** The sheet's columns Tavi reads, by the words of each header. */
const BULLETIN_COLUMNS = [
  { key: "petrol", header: /Euro-super 95/i, name: "Euro-super 95" },
  { key: "diesel", header: /Automotive gas oil/i, name: "Automotive gas oil (diesel)" },
  { key: "lpg", header: /LPG motor fuel/i, name: "LPG motor fuel" },
] as const;
type BulletinColumn = (typeof BULLETIN_COLUMNS)[number]["key"];
/** Each fuel asked for, the column that prices it. */
const BULLETIN_FUELS: ReadonlyMap<Fuel, BulletinColumn> = new Map([
  ["e5", "petrol"],
  ["e10", "petrol"],
  ["diesel", "diesel"],
  ["lpg", "lpg"],
]);

/** The Bulletin's week, kept in the worker's cache between its weekly issues. */
export const BulletinTableSchema = z.strictObject({
  /** The Monday the prices are for. */
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** When its file was read, and when the page was last asked for a newer one. */
  fetchedAt: z.string().datetime({ offset: true }),
  checkedAt: z.string().datetime({ offset: true }),
  /** Price a litre in EUR, by column and member state. */
  prices: z.strictObject({
    petrol: z.record(z.string(), z.number()),
    diesel: z.record(z.string(), z.number()),
    lpg: z.record(z.string(), z.number()),
  }),
});
export type BulletinTable = z.infer<typeof BulletinTableSchema>;

const DAY_MS = 86_400_000;
/** The next week's prices are dated a week after the last, and published a day or few later. */
export const BULLETIN_NEXT_AFTER_DAYS = 8;
/** While a newer week is due, the page is asked again at most this often. */
export const BULLETIN_RECHECK_HOURS = 6;
/** A week older than this means the Bulletin missed two issues: its average is said to be stale. */
export const BULLETIN_STALE_DAYS = 15;
/** A kept week is dropped this long after its file was read, as the record's terms say. */
export const BULLETIN_KEPT_DAYS = 30;

/** The page's link to the latest prices with taxes, on its own host; `undefined` when the page no longer has one. */
export function bulletinFileUrl(html: string): string | undefined {
  for (const anchor of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = anchor[0];
    const href = /\bhref="(\/document\/download\/[^"]+)"/.exec(tag)?.[1];
    if (href === undefined) continue;
    const label = /\bdata-untranslated-label="([^"]*)"/.exec(tag)?.[1] ?? "";
    if (/prices with taxes\s+latest prices/i.test(label) || (label === "" && /prices%20with%20taxes/i.test(href)))
      return `https://energy.ec.europa.eu${href.replace(/&amp;/g, "&")}`;
  }
  return undefined;
}

/** The Bulletin's sheet as a week's table; drift when it is not that sheet. */
export function bulletinTable(rows: readonly (readonly string[])[], at: string): BulletinTable | { readonly drift: string } {
  const header = rows[0] ?? [];
  if (!/in EUR/i.test(header[0] ?? "")) return { drift: "the sheet does not say its prices are in EUR" };
  const week = excelDate(rows[1]?.[0]);
  if (week === undefined) return { drift: "the sheet's date is not a date" };
  const prices: Record<BulletinColumn, Record<string, number>> = { petrol: {}, diesel: {}, lpg: {} };
  for (const column of BULLETIN_COLUMNS) {
    const index = header.findIndex((cell, at) => at > 0 && column.header.test(cell));
    if (index < 0) return { drift: `the sheet has no ${column.name} column` };
    if ((rows[1]?.[index] ?? "").replace(/\s+/g, " ").trim() !== "1000 l") return { drift: `${column.name} is not priced per 1000 l` };
    for (const row of rows.slice(2)) {
      const country = EU_COUNTRIES.get((row[0] ?? "").trim());
      const amount = priceOf(row[index], 1_000);
      if (country !== undefined && amount !== undefined) prices[column.key][country] = amount;
    }
  }
  // Nearly every member state reports petrol and diesel each week.
  for (const key of ["petrol", "diesel"] as const)
    if (Object.keys(prices[key]).length < EU_COUNTRIES.size / 2)
      return { drift: `only ${String(Object.keys(prices[key]).length)} member states' ${key} read` };
  return { week, fetchedAt: at, checkedAt: at, prices };
}

/** The kept week, if it is one Tavi wrote and its terms still allow. */
function keptTable(call: SourceCall): BulletinTable | undefined {
  const parsed = BulletinTableSchema.safeParse(call.cache?.read());
  return parsed.success && Date.parse(call.now) - Date.parse(parsed.data.fetchedAt) <= BULLETIN_KEPT_DAYS * DAY_MS
    ? parsed.data
    : undefined;
}

/** Whether to ask the page for a newer week: none kept, or the next is due and the page was not asked in the last hours. */
export function bulletinDue(table: BulletinTable | undefined, now: string): boolean {
  if (table === undefined) return true;
  const ms = Date.parse(now);
  return (
    ms - Date.parse(`${table.week}T00:00:00.000Z`) >= BULLETIN_NEXT_AFTER_DAYS * DAY_MS &&
    ms - Date.parse(table.checkedAt) >= BULLETIN_RECHECK_HOURS * 3_600_000
  );
}

/** Asks the page and, when it links a newer file than the kept week's, reads it; the week to use, kept. */
async function refreshBulletin(call: SourceCall, fetch: FuelFetch, kept: BulletinTable | undefined): Promise<BulletinTable | Stop> {
  const page = await ask(fetch, { source: euOilBulletinRecord.id, url: EU_OIL_BULLETIN_PAGE, body: "text" }, call.now);
  const pageStop = failed(page);
  if (pageStop !== undefined) return pageStop;
  const html = (page as SourceResponse).body;
  const url = typeof html === "string" ? bulletinFileUrl(html) : undefined;
  if (url === undefined) return { kind: "drift", detail: "the Bulletin's page links no latest prices with taxes" };
  const file = await ask(fetch, { source: euOilBulletinRecord.id, url, body: "bytes" }, call.now);
  const fileStop = failed(file);
  if (fileStop !== undefined) return fileStop;
  const bytes = (file as SourceResponse).body;
  const rows = bytes instanceof Uint8Array ? readXlsxRows(bytes) : undefined;
  if (rows === undefined) return { kind: "drift", detail: "the Bulletin's file is not a workbook Tavi reads" };
  const read = bulletinTable(rows, call.now);
  if ("drift" in read) return { kind: "drift", detail: read.drift };
  // The page may still link last week's file: the kept week stands, asked again later.
  const table = kept !== undefined && kept.week >= read.week ? { ...kept, checkedAt: call.now } : read;
  call.cache?.write(table);
  return table;
}

/** The week to answer from: the kept one, or a newer one read now when it is due; a failure only when there is none to answer from. */
async function currentTable(call: SourceCall, fetch: FuelFetch): Promise<BulletinTable | Stop> {
  const kept = keptTable(call);
  if (kept !== undefined && !bulletinDue(kept, call.now)) return kept;
  const fresh = await refreshBulletin(call, fetch, kept);
  // A failed refresh leaves the kept week to answer from; its age says how old it is.
  return "kind" in fresh && kept !== undefined ? kept : fresh;
}

export const euOilBulletin: FuelAdapter = {
  record: euOilBulletinRecord,
  currency: "EUR",
  averagesOnly: true,
  async run(query, call, fetch) {
    const column = BULLETIN_FUELS.get(query.fuel);
    if (column === undefined) return { kind: "skipped", reason: "the Oil Bulletin averages Euro-super 95, diesel and LPG only" };
    const country = query.country;
    const named = [...EU_COUNTRIES].find(([, code]) => code === country)?.[0];
    if (country === undefined || named === undefined)
      return { kind: "skipped", reason: "the Oil Bulletin covers the EU's member states only" };
    const table = await currentTable(call, fetch);
    if ("kind" in table) return table;
    const amount = table.prices[column][country];
    if (amount === undefined) return { kind: "ok", stations: [] };
    const ageDays = Math.floor((Date.parse(call.now) - Date.parse(`${table.week}T00:00:00.000Z`)) / DAY_MS);
    const name = BULLETIN_COLUMNS.find((each) => each.key === column)?.name ?? column;
    return {
      kind: "ok",
      stations: [],
      average: {
        amount,
        currency: "EUR",
        unit: "litre",
        fuel: name,
        area: named,
        reportedAt: `${table.week}T00:00:00.000Z`,
        basis: "published",
        source: euOilBulletinRecord.id,
        ...(ageDays > BULLETIN_STALE_DAYS ? { staleDays: ageDays } : {}),
      },
    };
  },
  // The sweep's background read: a newer week fetched once one is due, only where a week is already kept (someone asked).
  async refresh(call, fetch) {
    const kept = keptTable(call);
    if (kept === undefined || !bulletinDue(kept, call.now)) return undefined;
    const fresh = await refreshBulletin(call, fetch, kept);
    return "kind" in fresh ? fresh : undefined;
  },
};

/** Every fuel source, in the order a country's are asked: station prices first, then averages. */
export const FUEL_SOURCES: readonly FuelAdapter[] = [
  tankerkoenig,
  frCarburants,
  esGeoportal,
  itMimit,
  atEcontrol,
  nswFuelcheck,
  waFuelwatch,
  usEia,
  euOilBulletin,
];
