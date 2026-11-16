import { z } from "zod";

import { CandidateSchema, PlacesSourceRecordSchema, type Candidate, type CONNECTORS, type PlacesSourceRecord } from "../contracts.js";
import { coarsenPoint } from "../geo.js";
import { drifted, statusOutcome } from "./common.js";
import type { Failure, PlacesRequest, SourceCall, SourceResponse } from "./types.js";

/**
 * EV charging sites: the US and Canada's AFDC and Open Charge Map, each with the
 * person's key in a header, live; Germany's Bundesnetzagentur register, a
 * monthly file read into a pack (`store/ev-pack.ts`). No source here gives
 * live per-port availability.
 */

export type Connector = (typeof CONNECTORS)[number];

export interface EvQuery {
  readonly point: { readonly lat: number; readonly lon: number };
  readonly radiusKm: number;
  readonly connectors?: readonly Connector[] | undefined;
  readonly limit: number;
}

/** A charging site a source reported. */
export interface EvRead {
  readonly candidate: Candidate;
  readonly connectors: readonly Connector[];
  readonly maxKw?: number;
  readonly points?: number;
}

export type EvOutcome =
  | { readonly kind: "ok"; readonly sites: readonly EvRead[] }
  | { readonly kind: "skipped"; readonly reason: string }
  | Failure;

/** One request through the engine: its budget, health and log. */
export type EvFetch = (request: PlacesRequest) => Promise<SourceResponse | { readonly skipped: string }>;

export interface EvAdapter {
  readonly record: PlacesSourceRecord;
  run(query: EvQuery, call: SourceCall, fetch: EvFetch): Promise<EvOutcome>;
}

/** Sites one source answers at most. */
const SITES_MAX = 100;

const evRecord = (record: Omit<z.input<typeof PlacesSourceRecordSchema>, "kind" | "precisionDecimals" | "fields">): PlacesSourceRecord =>
  PlacesSourceRecordSchema.parse({ ...record, kind: "ev", precisionDecimals: 2, fields: ["status"] });

/** A site as a candidate under its own licence, or `undefined` without a name or place. */
export function siteCandidate(
  source: string,
  licence: string,
  attribution: string,
  fields: {
    readonly id: string;
    readonly name: string | undefined;
    readonly lat: number;
    readonly lon: number;
    readonly address?: string | undefined;
    readonly postcode?: string | undefined;
    readonly country?: string | undefined;
    readonly phone?: string | undefined;
    readonly brand?: string | undefined;
    readonly checkedAt?: string | undefined;
    readonly status?: "open" | "permanently_closed" | "temporarily_closed" | "unknown";
  },
): Candidate | undefined {
  const name = fields.name?.trim();
  if (name === undefined || name === "") return undefined;
  const parsed = CandidateSchema.safeParse({
    source,
    sourceId: fields.id.slice(0, 200),
    licence: licence.slice(0, 60),
    attribution: attribution.slice(0, 200),
    name: name.slice(0, 200),
    categories: ["charging station"],
    ...(fields.address === undefined || fields.address.trim() === "" ? {} : { address: fields.address.trim().slice(0, 300) }),
    ...(fields.postcode === undefined || fields.postcode === "" ? {} : { postcode: fields.postcode.slice(0, 20) }),
    ...(fields.country !== undefined && /^[A-Z]{2}$/.test(fields.country) ? { country: fields.country } : {}),
    lat: fields.lat,
    lon: fields.lon,
    ...(fields.phone === undefined || fields.phone === null || fields.phone === "" ? {} : { phone: fields.phone.slice(0, 60) }),
    ...(fields.brand === undefined || fields.brand === "" ? {} : { brand: fields.brand.slice(0, 120) }),
    ...(fields.checkedAt === undefined ? {} : { checkedAt: fields.checkedAt }),
    status: fields.status ?? "unknown",
  });
  return parsed.success ? parsed.data : undefined;
}

/** A data provider's licence text as a short id where it is a known licence, else its words up to 60 characters. */
export function licenceId(text: string): string {
  if (/CC[ -]?BY[ -]?4\.0|Creative Commons Attribution 4\.0/i.test(text) && !/ShareAlike|SA\b/i.test(text)) return "CC-BY-4.0";
  if (/CC[ -]?BY[ -]?SA[ -]?4\.0|Attribution-ShareAlike 4\.0/i.test(text)) return "CC-BY-SA-4.0";
  if (/ODbL|Open Database License/i.test(text)) return "ODbL-1.0";
  if (/CC0|Public Domain Dedication/i.test(text)) return "CC0-1.0";
  return text.length <= 60 ? text : `${text.slice(0, 60).replace(/\s+\S*$/, "")}…`.slice(0, 60);
}

const isoDay = (text: string | null | undefined): string | undefined =>
  typeof text === "string" && /^\d{4}-\d{2}-\d{2}/.test(text) && Number.isFinite(Date.parse(text))
    ? new Date(text).toISOString()
    : undefined;

async function ask(fetch: EvFetch, request: PlacesRequest, now: string): Promise<SourceResponse | EvOutcome> {
  const answer = await fetch(request);
  if ("skipped" in answer) return { kind: "skipped", reason: answer.skipped };
  return statusOutcome(answer, now) ?? answer;
}

// The US and Canada: AFDC (NLR, through api.data.gov), a key in X-Api-Key.

export const afdcRecord = evRecord({
  id: "afdc",
  name: "Alternative Fuels Data Center (US, Canada)",
  countries: ["US", "CA"],
  hosts: ["developer.nlr.gov"],
  auth: "key-header",
  credential: ["afdcKey"],
  terms: {
    url: "https://developer.nlr.gov/docs/transportation/alt-fuel-stations-v1/",
    reviewedAt: "2026-10-17",
    licence: "public",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Alternative Fuels Data Center, U.S. Department of Energy",
    displayRules: ["Stations are as last confirmed by the AFDC; check a charger's live status in its network's app"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
});
/** AFDC's `ev_connector_type` for each connector it has. */
const AFDC_CONNECTORS: ReadonlyMap<Connector, string> = new Map([
  ["J1772", "J1772"],
  ["CCS1", "J1772COMBO"],
  ["CHADEMO", "CHADEMO"],
  ["NACS", "TESLA"],
]);
const AFDC_BACK: ReadonlyMap<string, Connector> = new Map([...AFDC_CONNECTORS].map(([connector, code]) => [code, connector]));
const AfdcAnswer = z.looseObject({ fuel_stations: z.array(z.unknown()) });
const AfdcStation = z.looseObject({
  id: z.number(),
  station_name: z.string(),
  street_address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  latitude: z.number(),
  longitude: z.number(),
  station_phone: z.string().nullable().optional(),
  ev_network: z.string().nullable().optional(),
  ev_connector_types: z.array(z.string()).nullable().optional(),
  ev_dc_fast_num: z.number().nullable().optional(),
  ev_level2_evse_num: z.number().nullable().optional(),
  ev_level1_evse_num: z.number().nullable().optional(),
  date_last_confirmed: z.string().nullable().optional(),
});

export const afdc: EvAdapter = {
  record: afdcRecord,
  async run(query, call, fetch) {
    const key = call.credential("afdcKey");
    if (key === undefined) return { kind: "skipped", reason: "not set up: its key (afdcKey, from api.data.gov) is missing" };
    const point = coarsenPoint(query.point, afdcRecord.precisionDecimals);
    const types = (query.connectors ?? []).map((connector) => AFDC_CONNECTORS.get(connector)).filter((code) => code !== undefined);
    if ((query.connectors ?? []).length > 0 && types.length === 0)
      return { kind: "skipped", reason: "AFDC lists J1772, CCS1, CHAdeMO and NACS only" };
    // AFDC's radius is in miles.
    const miles = Math.max(0.5, Math.round((query.radiusKm / 1.609344) * 10) / 10);
    const request: PlacesRequest = {
      source: afdcRecord.id,
      url: `https://developer.nlr.gov/api/alt-fuel-stations/v1/nearest.json?latitude=${String(point.lat)}&longitude=${String(point.lon)}&radius=${String(miles)}&fuel_type=ELEC&status=E&access=public&limit=${String(Math.min(SITES_MAX, query.limit * 3))}${types.length === 0 ? "" : `&ev_connector_type=${types.join(",")}`}`,
      headers: { "X-Api-Key": key },
      body: "json",
      area: { point, precisionDecimals: afdcRecord.precisionDecimals },
    };
    const answer = await ask(fetch, request, call.now);
    if ("kind" in answer) return answer;
    const body = AfdcAnswer.safeParse(answer.body);
    if (!body.success) return { kind: "drift", detail: "the answer has no fuel_stations list" };
    const sites: EvRead[] = [];
    let dropped = 0;
    for (const item of body.data.fuel_stations.slice(0, SITES_MAX)) {
      const station = AfdcStation.safeParse(item);
      if (!station.success) {
        dropped += 1;
        continue;
      }
      const row = station.data;
      const candidate = siteCandidate(afdcRecord.id, afdcRecord.terms.licence, afdcRecord.terms.attribution, {
        id: String(row.id),
        name: row.station_name,
        lat: row.latitude,
        lon: row.longitude,
        address: [row.street_address, row.city, row.state].filter((part) => typeof part === "string" && part !== "").join(", "),
        postcode: row.zip ?? undefined,
        country: row.country ?? undefined,
        phone: row.station_phone ?? undefined,
        brand: row.ev_network ?? undefined,
        checkedAt: isoDay(row.date_last_confirmed),
        status: "open",
      });
      if (candidate === undefined) continue;
      const points = (row.ev_dc_fast_num ?? 0) + (row.ev_level2_evse_num ?? 0) + (row.ev_level1_evse_num ?? 0);
      sites.push({
        candidate,
        connectors: [
          ...new Set((row.ev_connector_types ?? []).map((code) => AFDC_BACK.get(code)).filter((connector) => connector !== undefined)),
        ],
        ...(points > 0 ? { points } : {}),
      });
    }
    if (drifted(dropped, body.data.fuel_stations.length))
      return {
        kind: "drift",
        detail: `${String(dropped)} of ${String(body.data.fuel_stations.length)} stations did not have the expected shape`,
      };
    return { kind: "ok", sites };
  },
};

// Everywhere: Open Charge Map, a key in X-API-Key; each record keeps its data provider's licence.

export const ocmRecord = evRecord({
  id: "ocm",
  name: "Open Charge Map",
  countries: ["*"],
  hosts: ["api.openchargemap.io"],
  auth: "key-header",
  credential: ["ocmKey"],
  terms: {
    url: "https://openchargemap.org/site/develop/api",
    reviewedAt: "2026-10-17",
    licence: "CC-BY-4.0",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Open Charge Map (CC BY 4.0), and each record's data provider",
    displayRules: ["Credit Open Charge Map and each record's data provider under its own licence"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
});
/** Open Charge Map's connection type ids for each connector. */
const OCM_CONNECTORS: ReadonlyMap<Connector, readonly number[]> = new Map([
  ["J1772", [1]],
  ["CHADEMO", [2]],
  ["TYPE2", [25, 1036]],
  ["NACS", [27]],
  ["CCS1", [32]],
  ["CCS2", [33]],
]);
const OCM_BACK: ReadonlyMap<number, Connector> = new Map(
  [...OCM_CONNECTORS].flatMap(([connector, ids]) => ids.map((id) => [id, connector] as const)),
);
const OcmPoi = z.looseObject({
  ID: z.number(),
  DataProvider: z.looseObject({ Title: z.string().optional(), License: z.string().nullable().optional() }).nullable().optional(),
  OperatorInfo: z.looseObject({ Title: z.string().optional() }).nullable().optional(),
  StatusType: z.looseObject({ IsOperational: z.boolean().nullable().optional() }).nullable().optional(),
  AddressInfo: z.looseObject({
    Title: z.string().optional(),
    AddressLine1: z.string().nullable().optional(),
    Town: z.string().nullable().optional(),
    Postcode: z.string().nullable().optional(),
    Country: z.looseObject({ ISOCode: z.string().optional() }).nullable().optional(),
    Latitude: z.number(),
    Longitude: z.number(),
  }),
  Connections: z
    .array(
      z.looseObject({
        ConnectionTypeID: z.number().nullable().optional(),
        PowerKW: z.number().nullable().optional(),
        Quantity: z.number().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  NumberOfPoints: z.number().nullable().optional(),
  DateLastVerified: z.string().nullable().optional(),
});

export const ocm: EvAdapter = {
  record: ocmRecord,
  async run(query, call, fetch) {
    const key = call.credential("ocmKey");
    if (key === undefined) return { kind: "skipped", reason: "not set up: its key (ocmKey) is missing" };
    const point = coarsenPoint(query.point, ocmRecord.precisionDecimals);
    const ids = (query.connectors ?? []).flatMap((connector) => OCM_CONNECTORS.get(connector) ?? []);
    const request: PlacesRequest = {
      source: ocmRecord.id,
      url: `https://api.openchargemap.io/v3/poi?output=json&latitude=${String(point.lat)}&longitude=${String(point.lon)}&distance=${String(Math.round(query.radiusKm * 10) / 10)}&distanceunit=KM&maxresults=${String(Math.min(SITES_MAX, query.limit * 3))}&compact=false&verbose=false${ids.length === 0 ? "" : `&connectiontypeid=${ids.join(",")}`}`,
      headers: { "X-API-Key": key },
      body: "json",
      area: { point, precisionDecimals: ocmRecord.precisionDecimals },
    };
    const answer = await ask(fetch, request, call.now);
    if ("kind" in answer) return answer;
    if (!Array.isArray(answer.body)) return { kind: "drift", detail: "the answer is not a list of sites" };
    const sites: EvRead[] = [];
    let dropped = 0;
    for (const item of answer.body.slice(0, SITES_MAX)) {
      const poi = OcmPoi.safeParse(item);
      if (!poi.success) {
        dropped += 1;
        continue;
      }
      const row = poi.data;
      const address = row.AddressInfo;
      const licence = licenceId(row.DataProvider?.License ?? "CC-BY-4.0");
      const operational = row.StatusType?.IsOperational;
      const candidate = siteCandidate(
        ocmRecord.id,
        licence,
        `Open Charge Map${row.DataProvider?.Title === undefined ? "" : `, ${row.DataProvider.Title}`}`,
        {
          id: String(row.ID),
          name: address.Title,
          lat: address.Latitude,
          lon: address.Longitude,
          address: [address.AddressLine1, address.Town].filter((part) => typeof part === "string" && part !== "").join(", "),
          postcode: address.Postcode ?? undefined,
          country: address.Country?.ISOCode,
          brand: row.OperatorInfo?.Title,
          checkedAt: isoDay(row.DateLastVerified),
          status: operational === false ? "temporarily_closed" : operational === true ? "open" : "unknown",
        },
      );
      if (candidate === undefined) continue;
      const connections = row.Connections ?? [];
      const power = Math.max(0, ...connections.map((connection) => connection.PowerKW ?? 0));
      const points = row.NumberOfPoints ?? connections.reduce((sum, connection) => sum + (connection.Quantity ?? 0), 0);
      sites.push({
        candidate,
        connectors: [
          ...new Set(
            connections
              .map((connection) =>
                connection.ConnectionTypeID === null || connection.ConnectionTypeID === undefined
                  ? undefined
                  : OCM_BACK.get(connection.ConnectionTypeID),
              )
              .filter((connector) => connector !== undefined),
          ),
        ],
        ...(power > 0 ? { maxKw: power } : {}),
        ...(points > 0 ? { points } : {}),
      });
    }
    if (drifted(dropped, answer.body.length))
      return { kind: "drift", detail: `${String(dropped)} of ${String(answer.body.length)} sites did not have the expected shape` };
    return { kind: "ok", sites };
  },
};

// Germany: the Bundesnetzagentur's charging register, monthly, CC BY 4.0, read into a pack.

export const BNETZA_PAGE = "https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html";

export const bnetzaRecord = evRecord({
  id: "de-bnetza",
  name: "Ladesäulenregister (Bundesnetzagentur)",
  countries: ["DE"],
  hosts: ["www.bundesnetzagentur.de", "data.bundesnetzagentur.de"],
  auth: "none",
  terms: {
    url: BNETZA_PAGE,
    reviewedAt: "2026-10-17",
    licence: "CC-BY-4.0",
    llmUse: "silent",
    cache: { mode: "keep" },
    attribution: "Bundesnetzagentur.de (CC BY 4.0)",
    displayRules: ["The register lists chargers whose operators completed its notice; Germany has more than it shows"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.2, perDay: 4 },
});

/** The newest register CSV the page links to, with its date, or `undefined`. */
export function bnetzaCsvUrl(page: string): { readonly url: string; readonly release: string } | undefined {
  const links = [
    ...page.matchAll(/href="(https:\/\/data\.bundesnetzagentur\.de\/[^"]*Ladesaeulenregister_BNetzA_(\d{4}-\d{2}-\d{2})\.csv)"/g),
  ].map((match) => ({ url: match[1] as string, release: match[2] as string }));
  return links.sort((a, b) => b.release.localeCompare(a.release))[0];
}

/** One semicolon-separated line's fields, quotes honoured. */
export function semicolonFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ";") {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields;
}

/** A plug type as the register names it, as a connector. */
function bnetzaConnector(text: string): Connector | undefined {
  if (/CCS|Combo/i.test(text)) return "CCS2";
  if (/CHAdeMO/i.test(text)) return "CHADEMO";
  if (/Tesla|NACS/i.test(text)) return "NACS";
  if (/Typ 2/i.test(text)) return "TYPE2";
  return undefined;
}

const number = (text: string | undefined): number | undefined => {
  const value = Number((text ?? "").replace(",", "."));
  return text === undefined || text.trim() === "" || !Number.isFinite(value) ? undefined : value;
};

/**
 * Reads the register's lines into sites: its header row is found by name,
 * the notes above it skipped. A site not "In Betrieb" is left out; `records`
 * counts every data record, so a caller can tell a changed file from a full one.
 */
export function createBnetzaReader(): {
  readonly line: (text: string) => EvRead | undefined;
  readonly header: () => boolean;
  readonly records: () => number;
} {
  let names: string[] | undefined;
  let pending = "";
  let records = 0;
  return {
    header: () => names !== undefined,
    records: () => records,
    line: (text) => {
      // A quoted field (a charge point's public key) may run over several lines: a record ends where its quotes close.
      const part = text.replace(/\r$/, "");
      pending = pending === "" ? part.replace(/^﻿/, "") : `${pending}\n${part}`;
      if ((pending.match(/"/g)?.length ?? 0) % 2 === 1) return undefined;
      const fields = semicolonFields(pending);
      pending = "";
      if (names === undefined) {
        if (fields[0]?.trim() === "Ladeeinrichtungs-ID") names = fields.map((name) => name.trim());
        return undefined;
      }
      if (fields.every((field) => field.trim() === "")) return undefined;
      records += 1;
      const at = (name: string): string | undefined => {
        const index = names?.indexOf(name) ?? -1;
        return index < 0 ? undefined : fields[index]?.trim();
      };
      const lat = number(at("Breitengrad"));
      const lon = number(at("Längengrad"));
      const id = at("Ladeeinrichtungs-ID");
      if (lat === undefined || lon === undefined || id === undefined || id === "" || at("Status") !== "In Betrieb") return undefined;
      const operator = at("Betreiber");
      const plugs = names.flatMap((name, index) => (name.startsWith("Steckertypen") ? (fields[index] ?? "").split(/[;,]/) : []));
      const candidate = siteCandidate(bnetzaRecord.id, bnetzaRecord.terms.licence, bnetzaRecord.terms.attribution, {
        id,
        name: at("Anzeigename (Karte)") || operator,
        lat,
        lon,
        address: [[at("Straße"), at("Hausnummer")].filter((part) => part !== undefined && part !== "").join(" "), at("Ort")]
          .filter((part) => part !== undefined && part !== "")
          .join(", "),
        postcode: at("Postleitzahl"),
        country: "DE",
        brand: operator,
        status: "open",
      });
      if (candidate === undefined) return undefined;
      const maxKw = number(at("Nennleistung Ladeeinrichtung [kW]"));
      const points = number(at("Anzahl Ladepunkte"));
      return {
        candidate,
        connectors: [...new Set(plugs.map(bnetzaConnector).filter((connector) => connector !== undefined))],
        ...(maxKw === undefined || maxKw <= 0 ? {} : { maxKw }),
        ...(points === undefined || points <= 0 ? {} : { points: Math.round(points) }),
      };
    },
  };
}

/** The live EV sources, in the order a country's are asked. */
export const EV_SOURCES: readonly EvAdapter[] = [afdc, ocm];
