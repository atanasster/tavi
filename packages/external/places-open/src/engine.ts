import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  createBudgetLedger,
  delay,
  type BudgetLedger,
  type CallContext,
  type Fetched,
  type Fetcher as DomainFetcher,
  type HeartbeatSignalLike,
} from "@tavi/domain-kit";
import {
  boxAround,
  corridorLine,
  customRoutingRecord,
  candidateFromPlace,
  candidateFromRelayed,
  coarsenPoint,
  DATA_SOURCE_TERMS,
  EU_LOCAL_CURRENCIES,
  findLicensingRow,
  DAILY_BUDGET_SPENT,
  pausedOutcome,
  withExhaustion,
  FuelWatchInputSchema,
  openWatchStore,
  WATCH_CADENCES,
  AvailabilityInputSchema,
  bookingRoutes,
  BookingStatusInputSchema,
  receiptCheck,
  AreaReportInputSchema,
  CIVIC_SOURCES,
  CIVIC_TOPICS,
  open311Adapter,
  BNETZA_PAGE,
  bnetzaCsvUrl,
  bnetzaRecord,
  createBnetzaReader,
  EV_SOURCES,
  EvChargersInputSchema,
  openEvPack,
  writeEvPack,
  FUEL_SOURCES,
  FuelPricesInputSchema,
  parseTdlr,
  tdlrRecord,
  tdlrRequest,
  VerifyLicenseInputSchema,
  distanceKm,
  foldText,
  latinText,
  OVERTURE_PACK_MAX_KM,
  OVERTURE_STAC,
  openOverturePack,
  openPlacesStore,
  orsRecord,
  orsRouteRequest,
  osrmRouteRequest,
  overpass,
  overpassAlong,
  overtureAssetUrl,
  overtureItemsFor,
  overtureRecord,
  P1_GEOCODERS,
  P1_POI_SOURCES,
  parseOrsRoute,
  parseOsrmRoute,
  PlacesQuerySchema,
  planQuery,
  positionOnLine,
  ROAD_FACTOR,
  RouteStopsInputSchema,
  readOvertureBox,
  RelayedItemSchema,
  resolveClusters,
  resolvePlaces,
  SOURCE_PAUSE_MS,
  splitLine,
  thinLine,
  ALONG_LINE_MAX_POINTS,
  lineLengthKm,
  writeOverturePack,
  type Candidate,
  type GeocoderAdapter,
  type Availability,
  type BookingStatus,
  type Charger,
  type CivicAdapter,
  type CivicItem,
  type Open311City,
  type EvAdapter,
  type EvRead,
  type FuelAdapter,
  type FuelHit,
  type FuelWatch,
  type FuelQuery,
  type FuelRead,
  type FuelStation,
  type LicensingFile,
  type RegionalAverage,
  type LinePoint,
  type VerifyLicenseResult,
  type RouteOutcome,
  type RouteStop,
  type RouteStopsResult,
  type Place,
  type PlacesRequest,
  type PlacesSourceRecord,
  type PlacesStore,
  type PoiAdapter,
  type ParquetFile,
  type PoiQuery,
  type SourceCall,
  nextOverpassInstance,
} from "@tavi/places-kit";
import type { SiteProfile } from "@tavi/contracts";
import { csvList, definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { z } from "zod";

import { LICENSING } from "./licensing.js";
import { SITE_PROFILES } from "./sites.js";
import { OPEN311_CITIES } from "./open311.js";

/**
 * The `places.open` tools' work, apart from the plugin context so it is tested with a fake network.
 * Every request goes through its source's budget and health, leaves with the
 * area rounded to the source's precision, and is logged with that rounded
 * area only.
 */

export type { CallContext, Fetched, HeartbeatSignalLike } from "@tavi/domain-kit";
export type Fetcher = DomainFetcher<PlacesRequest>;
/** A remote Parquet file read by range (the Overture pack). */
type ParquetOpener = (url: string) => Promise<ParquetFile>;

export interface EngineOptions {
  /** `places.db` in the worker's home; its `cache/` beside it holds the area pack. */
  readonly storePath: string;
  readonly fetcher: Fetcher;
  readonly openParquet: ParquetOpener;
  readonly config: Readonly<Record<string, unknown>>;
  readonly version: string;
  readonly now?: () => string;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly geocoders?: readonly GeocoderAdapter[];
  readonly poiSources?: readonly PoiAdapter[];
  readonly fuelSources?: readonly FuelAdapter[];
  /** The site profiles `availability` reads; the shipped ones unless a test gives others. */
  readonly siteProfiles?: readonly SiteProfile[];
  readonly evSources?: readonly EvAdapter[];
  /** Neighbourhood sources; the fixed ones and the bundled Open311 cities unless a test gives others. */
  readonly civicSources?: readonly CivicAdapter[];
  readonly open311Cities?: readonly Open311City[];
  /** A remote text file read line by line, never whole (Germany's charging register): the worker's stream. */
  readonly openLines?: (url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal) => AsyncIterable<string>;
  /** The licensing matrix; the bundled one unless a test gives another. */
  readonly licensing?: readonly LicensingFile[];
  /** A credential setting's value: the worker's placeholder its proxy fills. */
  readonly credential?: (key: string) => Promise<string | null>;
}

/** The radius a text area is searched in, unless the query gives a point and a radius. */
const TEXT_AREA_RADIUS_KM = 5;
/** The longest one search runs; what is unread then is reported, not waited for. */
const SEARCH_DEADLINE_MS = 45_000;
/** The longest a search waits for a source's per-second rate. */
const RATE_WAIT_MAX_MS = 5_000;
/** The longest one `route_stops` runs: its points, its route and the stations along it. */
const ROUTE_DEADLINE_MS = 60_000;
/** Without a router, a point of the great circle at least this often. */
const CORRIDOR_SPACING_KM = 10;
/** A route's line is asked of Overpass in pieces of about this length, at most `ROUTE_PIECES_MAX` of them. */
const ROUTE_PIECE_KM = 250;
const ROUTE_PIECES_MAX = 3;
/** Stations kept near each point a stop is wanted at. */
const STOPS_PER_TARGET = 3;
/** With a range, a stop is wanted after this share of it, to leave a margin. */
const RANGE_MARGIN = 0.8;
/** A report's radius for a text area (a point's is its own, 500 m by default). */
const REPORT_RADIUS_KM = 0.5;
/** Kinds and latest items one section shows. */
const REPORT_KINDS_MAX = 10;
const REPORT_LATEST_MAX = 5;
/** Hits the heartbeat sees: those of the last day, at most 40 (its limit is 50 a source). */
const SIGNAL_WINDOW_MS = 24 * 3_600_000;
const SIGNALS_MAX = 40;
/** A watch's hits (station, price, time) are kept this long for its digest; the heartbeat hears only the last day's. */
const HITS_KEPT_MS = 7 * 86_400_000;
/** How long a geocode is cached. */
const GEOCODE_KEPT_MS = 30 * 86_400_000;
/** A watch reads prices at most this old, as fuel_prices does by default. */
const WATCH_MAX_AGE_HOURS = 12;

/** A charging register pack older than this is read, and a newer one built beside it. */
const REGISTER_MAX_AGE_DAYS = 40;
/** Places one `compare` takes. */
const COMPARE_MAX = 10;
/** Items one `reconcile` takes. */
const RELAYED_MAX = 20;

type SourceReport = {
  readonly source: string;
  readonly outcome: string;
  readonly found?: number;
  readonly exhausted?: true;
  readonly nextAt?: string;
};

/** A place as a search answers it: its distance from the search's point. */
export type ShownPlace = Place & { readonly distanceKm?: number };

/** What `search` answers: the places, the area it searched, what each source said, and their attribution. */
export interface SearchReply {
  readonly places: readonly ShownPlace[];
  readonly found: number;
  readonly sources: readonly SourceReport[];
  readonly area?: {
    readonly label: string | undefined;
    readonly point: { readonly lat: number; readonly lon: number };
    readonly radiusKm: number;
    readonly category?: string;
  };
  readonly attribution?: readonly string[];
  readonly note?: string;
  readonly taviFindings?: readonly { readonly kind: "place"; readonly records: readonly Record<string, unknown>[] }[];
}

/** What `fuel_prices` answers: stations cheapest first, the stale ones counted, and the US's regional average. */
export interface FuelPricesReply {
  readonly fuel: string;
  readonly area?: {
    readonly label: string | undefined;
    readonly point: { readonly lat: number; readonly lon: number };
    readonly radiusKm: number;
    readonly country: string;
  };
  readonly stations: readonly (FuelStation & { readonly distanceKm: number })[];
  readonly excludedStale: number;
  readonly regionalAverage?: RegionalAverage;
  readonly sources: readonly SourceReport[];
  readonly attribution?: readonly string[];
  readonly note?: string;
  readonly taviFindings?: readonly ReturnType<typeof placeFinding>[];
}

/** What `ev_chargers` answers: charging sites nearest first, each with its connectors, power and sources. */
export interface EvChargersReply {
  readonly area?: {
    readonly label: string | undefined;
    readonly point: { readonly lat: number; readonly lon: number };
    readonly radiusKm: number;
    readonly country: string;
  };
  readonly chargers: readonly (Charger & { readonly distanceKm: number })[];
  readonly sources: readonly SourceReport[];
  readonly attribution?: readonly string[];
  readonly note?: string;
  readonly taviFindings?: readonly ReturnType<typeof placeFinding>[];
}

/** One source's section of an area report: how many, of which kinds, and the latest few. */
interface AreaReportSection {
  readonly source: string;
  readonly topic: string;
  readonly count: number;
  readonly period?: string;
  readonly byKind: readonly { readonly kind: string; readonly count: number }[];
  readonly latest: readonly CivicItem[];
  /** Why `count` is not the whole count: a row cap, a city server's sample, or no data for the point. */
  readonly caveat?: string;
}

export interface AreaReportReply {
  readonly area?: {
    readonly label: string | undefined;
    readonly point: { readonly lat: number; readonly lon: number };
    readonly radiusKm: number;
    readonly country: string | undefined;
  };
  readonly since?: string;
  readonly sections: readonly AreaReportSection[];
  readonly sources: readonly SourceReport[];
  readonly attribution?: readonly string[];
  readonly note?: string;
}

/** `lat,lon,radiusKm`, the operator's area for the Overture pack. */
const AreaSettingSchema = z.string().regex(/^\s*-?\d{1,2}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?\s*,\s*\d{1,2}(\.\d+)?\s*$/);

export function createEngine(options: EngineOptions) {
  const now = options.now ?? nowTimestamp;
  const sleep = options.sleep ?? delay;
  const geocoders = options.geocoders ?? P1_GEOCODERS;
  const poiSources = options.poiSources ?? P1_POI_SOURCES;
  const records = new Map<string, PlacesSourceRecord>([...geocoders, ...poiSources].map((adapter) => [adapter.record.id, adapter.record]));
  records.set(overtureRecord.id, overtureRecord);
  records.set(orsRecord.id, orsRecord);
  records.set(tdlrRecord.id, tdlrRecord);
  const fuelSources = options.fuelSources ?? FUEL_SOURCES;
  for (const adapter of fuelSources) records.set(adapter.record.id, adapter.record);
  const evSources = options.evSources ?? EV_SOURCES;
  for (const adapter of evSources) records.set(adapter.record.id, adapter.record);
  records.set(bnetzaRecord.id, bnetzaRecord);
  const civicSources = options.civicSources ?? [...CIVIC_SOURCES, ...(options.open311Cities ?? OPEN311_CITIES).map(open311Adapter)];
  for (const adapter of civicSources) records.set(adapter.record.id, adapter.record);
  const licensing = options.licensing ?? LICENSING;
  const operatorContact =
    typeof options.config["contact"] === "string" && /^[\x21-\x7e]{3,200}$/.test(options.config["contact"])
      ? options.config["contact"]
      : undefined;
  const userAgent = `Tavi-places/${options.version}${operatorContact === undefined ? "" : ` (+${operatorContact})`}`;
  const baseUrl = typeof options.config["overpassInstance"] === "string" ? options.config["overpassInstance"] : undefined;
  const call = (instance = baseUrl): SourceCall => ({
    credential: () => undefined,
    userAgent,
    now: now(),
    ...(instance === undefined ? {} : { baseUrl: instance }),
  });
  const routingUrl =
    typeof options.config["routingUrl"] === "string" && options.config["routingUrl"].trim() !== ""
      ? options.config["routingUrl"].trim()
      : undefined;
  const customRouter = routingUrl === undefined ? undefined : customRoutingRecord(routingUrl);
  const enabled = (): Set<string> => {
    const named = csvList(options.config["sources"]);
    return new Set(
      named.length > 0
        ? named.filter((id) => records.has(id))
        : [...records.values()].filter((record) => record.defaultOn).map((record) => record.id),
    );
  };

  let opened:
    | { readonly store: PlacesStore; readonly budgets: BudgetLedger; readonly watches: ReturnType<typeof openWatchStore> }
    | undefined;
  const stopping = new AbortController();
  const cacheDir = join(dirname(options.storePath), "cache");
  const forgottenMarker = join(dirname(options.storePath), "forgotten");
  let retainedDay: string | undefined;

  /** The store, opened once; emptied first when the operator set `forget` (once, as `jobs.finder` does), and kept within its terms once a day. */
  const open = () => {
    if (stopping.signal.aborted) throw new Error("the places engine is closed");
    if (opened === undefined) {
      const store = openPlacesStore(options.storePath, DATA_SOURCE_TERMS);
      if (options.config["forget"] !== true) rmSync(forgottenMarker, { force: true });
      else if (!existsSync(forgottenMarker)) {
        store.forget();
        rmSync(cacheDir, { recursive: true, force: true });
        writeFileSync(forgottenMarker, `${now()}\n`);
      }
      opened = { store, budgets: createBudgetLedger(store.db), watches: openWatchStore(store.db) };
    }
    const day = now().slice(0, 10);
    if (retainedDay !== day) {
      opened.store.retain(now());
      opened.watches.prune(new Date(Date.parse(now()) - HITS_KEPT_MS).toISOString());
      retainedDay = day;
    }
    return opened;
  };

  /** Why a source is not asked now, or `undefined` when it may be: off, user-triggered only in a run nobody attends, paused. */
  const refusal = (record: PlacesSourceRecord, context: CallContext): string | undefined => {
    if (!enabled().has(record.id)) return "off: turned off in the plugin's settings";
    if (record.terms.userTriggeredOnly && context.unattended) return "skipped: its terms allow only requests a person makes";
    const health = open().store.health(record.id, now());
    if (health.disabledUntil !== undefined && Date.parse(health.disabledUntil) > Date.parse(now()))
      return pausedOutcome(health.disabledUntil);
    return undefined;
  };

  /** One request through its source's budget; its outcome recorded and the request logged with its rounded area. */
  const send = async (
    record: PlacesSourceRecord,
    request: PlacesRequest,
    signal: AbortSignal,
  ): Promise<Fetched | { readonly skipped: string }> => {
    const { store, budgets } = open();
    let budget = budgets.take(record.id, record.budget, Date.parse(now()));
    for (
      let waits = 0;
      !budget.ok && budget.reason === "per-second" && budget.retryAfterMs <= RATE_WAIT_MAX_MS && waits < 3 && !signal.aborted;
      waits += 1
    ) {
      await sleep(budget.retryAfterMs, signal);
      budget = budgets.take(record.id, record.budget, Date.parse(now()));
    }
    if (signal.aborted) return { skipped: "the search ran out of time" };
    if (!budget.ok) return { skipped: budget.reason === "per-day" ? DAILY_BUDGET_SPENT : "skipped: its rate limit" };
    const at = now();
    // Every request sent is logged, one that never answered with status 0.
    const log = (status: number, bytes: number): void =>
      store.log({
        source: record.id,
        host: new URL(request.url).host,
        at,
        status,
        bytes,
        ...(request.area === undefined
          ? {}
          : { country: request.area.country, precisionDecimals: request.area.precisionDecimals, roundedLatLon: request.area.point }),
      });
    try {
      const fetched = await options.fetcher({ ...request, headers: { "User-Agent": userAgent, ...request.headers } }, signal);
      log(fetched.status, fetched.bytes);
      return fetched;
    } catch (error) {
      log(0, 0);
      if (signal.aborted) return { skipped: "the search ran out of time" };
      // Recorded once here, with its own message: not parsed again as an answer.
      const message = errorMessage(error);
      store.recordOutcome(record.id, { ok: false, error: message, ...failurePause(record) }, at);
      return { skipped: `failed: ${message.slice(0, 200)}` };
    }
  };

  /** A source's own pause after five failures in a row (the public OSM services' hour); a day when it sets none. */
  const failurePause = (record: PlacesSourceRecord): { readonly failurePauseMs?: number } =>
    record.failurePauseHours === undefined ? {} : { failurePauseMs: record.failurePauseHours * 3_600_000 };

  /** A parsed outcome's mark on its source's health. */
  const noteOutcome = (
    record: PlacesSourceRecord,
    outcome: { readonly kind: string; readonly retryAfterMs?: number; readonly detail?: string; readonly status?: number },
  ): void => {
    const { store } = open();
    const at = now();
    if (outcome.kind === "ok" || outcome.kind === "not-found") store.recordOutcome(record.id, { ok: true }, at);
    else if (outcome.kind === "rate-limited")
      store.recordOutcome(
        record.id,
        { ok: false, error: "rate limited", pauseUntil: new Date(Date.parse(at) + (outcome.retryAfterMs ?? 60_000)).toISOString() },
        at,
      );
    else if (outcome.kind === "drift") {
      store.recordOutcome(record.id, { ok: false, drift: true, error: outcome.detail ?? "drift" }, at);
      store.pause(record.id, new Date(Date.parse(at) + SOURCE_PAUSE_MS).toISOString(), at);
    } else
      store.recordOutcome(
        record.id,
        { ok: false, error: outcome.kind === "failed" ? `HTTP ${String(outcome.status)}` : outcome.kind, ...failurePause(record) },
        at,
      );
  };

  /**
   * Geocodes cached in the worker's cache for a month: keyed by a hash of the
   * text typed, never the text, each point rounded to about 110 m. An address
   * (area_report's) is not cached at all.
   */
  const geocodeCacheFile = join(cacheDir, "geocodes.json");
  type CachedGeocode = { lat: number; lon: number; label: string; country?: string; at?: string };
  const readGeocodes = (): Record<string, CachedGeocode> => {
    try {
      return JSON.parse(readFileSync(geocodeCacheFile, "utf8")) as Record<string, CachedGeocode>;
    } catch {
      return {};
    }
  };

  /** An area's text as a point: the cache, then each geocoder in turn. */
  const geocode = async (
    text: string,
    country: string | undefined,
    signal: AbortSignal,
    context: CallContext,
    reports: SourceReport[],
    cache: "use" | "skip" = "use",
  ) => {
    const key = createHash("sha256")
      .update(`${country ?? ""}|${foldText(text)}`)
      .digest("hex")
      .slice(0, 32);
    const cached = cache === "use" ? readGeocodes()[key] : undefined;
    if (cached !== undefined && cached.at !== undefined && Date.parse(now()) - Date.parse(cached.at) <= GEOCODE_KEPT_MS) return cached;
    for (const geocoder of geocoders) {
      const why = refusal(geocoder.record, context);
      if (why !== undefined) {
        reports.push({ source: geocoder.record.id, outcome: why });
        continue;
      }
      const request = geocoder.geocode(text, call(), country);
      if (request === undefined) continue;
      const fetched = await send(geocoder.record, request, signal);
      if ("skipped" in fetched) {
        reports.push({ source: geocoder.record.id, outcome: fetched.skipped });
        continue;
      }
      const outcome = geocoder.parseGeocode(fetched, request, call());
      noteOutcome(geocoder.record, outcome);
      reports.push({ source: geocoder.record.id, outcome: outcome.kind });
      const point = outcome.kind === "ok" ? outcome.points[0] : undefined;
      if (point === undefined) continue;
      if (cache === "use") {
        mkdirSync(cacheDir, { recursive: true });
        const fresh = Object.fromEntries(
          Object.entries(readGeocodes()).filter(
            ([, entry]) => entry.at !== undefined && Date.parse(now()) - Date.parse(entry.at) <= GEOCODE_KEPT_MS,
          ),
        );
        writeFileSync(`${geocodeCacheFile}.tmp`, JSON.stringify({ ...fresh, [key]: { ...point, ...coarsenPoint(point, 3), at: now() } }));
        renameSync(`${geocodeCacheFile}.tmp`, geocodeCacheFile);
      }
      return point;
    }
    return undefined;
  };

  /** The operator's Overture area, when set and holding `point`. */
  const packArea = (): { readonly lat: number; readonly lon: number; readonly radiusKm: number } | undefined => {
    const setting = options.config["overtureArea"];
    if (typeof setting !== "string" || !AreaSettingSchema.safeParse(setting).success) return undefined;
    const [lat, lon, radiusKm] = setting.split(",").map((part) => Number(part.trim())) as [number, number, number];
    return { lat, lon, radiusKm: Math.min(radiusKm, OVERTURE_PACK_MAX_KM) };
  };
  const packPath = (area: { readonly lat: number; readonly lon: number; readonly radiusKm: number }, release: string): string =>
    join(cacheDir, `overture-${release}-${String(area.lat)}_${String(area.lon)}_${String(area.radiusKm)}.db`);

  /** Builds the area pack from the latest release: STAC, the files that meet it, their row groups. Counted once on Overture's budget. */
  const buildPack = async (
    area: { readonly lat: number; readonly lon: number; readonly radiusKm: number },
    signal: AbortSignal,
  ): Promise<string> => {
    const fetchJson = async (url: string): Promise<unknown> => {
      const fetched = await options.fetcher({ source: "overture", url, body: "json", headers: { "User-Agent": userAgent } }, signal);
      open().store.log({ source: "overture", host: new URL(url).host, at: now(), status: fetched.status, bytes: fetched.bytes });
      if (fetched.status !== 200) throw new Error(`Overture's catalogue answered HTTP ${String(fetched.status)}`);
      return fetched.body;
    };
    const catalog = z
      .looseObject({ links: z.array(z.looseObject({ rel: z.string(), href: z.string(), latest: z.boolean().optional() })) })
      .parse(await fetchJson(OVERTURE_STAC));
    const latest = catalog.links.find((link) => link.rel === "child" && link.latest === true);
    const release = latest === undefined ? undefined : /\/(\d{4}-\d{2}-\d{2}\.\d+)\//.exec(latest.href)?.[1];
    if (release === undefined) throw new Error("Overture's catalogue names no latest release");
    const path = packPath(area, release);
    if (existsSync(path)) return path;
    const box = boxAround(area, area.radiusKm);
    const items = overtureItemsFor(await fetchJson(`https://stac.overturemaps.org/${release}/places/place/collection.json`), box);
    if (items === undefined) throw new Error("Overture's places collection is not the shape Tavi reads");
    const candidates: Candidate[] = [];
    for (const item of items) {
      const url = overtureAssetUrl(await fetchJson(item));
      if (url === undefined) continue;
      // Each file's range reads, counted and logged once it is read, as every other request is.
      const file = await options.openParquet(url);
      let bytes = 0;
      const counted = {
        byteLength: file.byteLength,
        slice: async (start: number, end?: number) => {
          const part = await file.slice(start, end);
          bytes += part.byteLength;
          return part;
        },
      };
      const at = now();
      const read = await readOvertureBox(counted, box);
      open().store.log({ source: "overture", host: new URL(url).host, at, status: 200, bytes });
      candidates.push(...read.candidates);
    }
    mkdirSync(cacheDir, { recursive: true });
    const building = `${path}.building`;
    rmSync(building, { force: true });
    writeOverturePack(building, { release, box, builtAt: now() }, candidates);
    renameSync(building, path);
    return path;
  };

  /** The pack's candidates near `point`, built first when the person asks and it is missing. */
  const packCandidates = async (
    point: { readonly lat: number; readonly lon: number },
    radiusKm: number,
    plan: ReturnType<typeof planQuery>,
    limit: number,
    signal: AbortSignal,
    context: CallContext,
    reports: SourceReport[],
  ): Promise<Candidate[]> => {
    const area = packArea();
    if (area === undefined || distanceKm(area, point) > area.radiusKm) return [];
    // Turned off, a built pack is not read either; a pack already built needs no request, so a run nobody attends may read it.
    if (!enabled().has(overtureRecord.id)) {
      reports.push({ source: "overture", outcome: "off: turned off in the plugin's settings" });
      return [];
    }
    let path = readdirPacks(area);
    if (path === undefined) {
      const why = refusal(overtureRecord, context);
      if (why !== undefined) {
        reports.push({ source: "overture", outcome: why });
        return [];
      }
      const budget = open().budgets.take(overtureRecord.id, overtureRecord.budget, Date.parse(now()));
      if (!budget.ok) {
        reports.push({
          source: "overture",
          outcome:
            budget.reason === "per-day" ? "skipped: its daily budget for building packs is spent" : "skipped: a pack was built moments ago",
        });
        return [];
      }
      try {
        path = await buildPack(area, signal);
        noteOutcome(overtureRecord, { kind: "ok" });
      } catch (error) {
        // Tavi's own deadline cutting a build short is not Overture failing.
        if (signal.aborted) {
          reports.push({ source: "overture", outcome: "skipped: the search ran out of time while building the pack" });
          return [];
        }
        noteOutcome(overtureRecord, { kind: "failed", status: 0 });
        reports.push({ source: "overture", outcome: `failed: ${errorMessage(error)}` });
        return [];
      }
    }
    const pack = openOverturePack(path);
    try {
      const found = pack.near(point, radiusKm, plan, limit * 3);
      reports.push({ source: "overture", outcome: "ok", found: found.length });
      return found;
    } finally {
      pack.close();
    }
  };
  /** The newest pack built for `area`, if any. */
  const readdirPacks = (area: { readonly lat: number; readonly lon: number; readonly radiusKm: number }): string | undefined => {
    const suffix = `-${String(area.lat)}_${String(area.lon)}_${String(area.radiusKm)}.db`;
    const files = readdirSyncSafe(cacheDir)
      .filter((file) => file.startsWith("overture-") && file.endsWith(suffix))
      .sort();
    const newest = files.at(-1);
    return newest === undefined ? undefined : join(cacheDir, newest);
  };

  /**
   * A road route through `points`: the operator's router first, as it sends
   * the points nowhere else, then OpenRouteService with the person's key.
   * `undefined` when neither is set up or both failed: the corridor then.
   */
  const route = async (
    points: readonly LinePoint[],
    signal: AbortSignal,
    context: CallContext,
    reports: SourceReport[],
    notes: string[],
  ): Promise<{
    readonly routed?: {
      readonly line: readonly LinePoint[];
      readonly distanceKm: number;
      readonly source: "ors" | "custom";
      readonly attribution: string;
    };
    readonly tried: boolean;
  }> => {
    const attempts: {
      readonly record: PlacesSourceRecord;
      readonly source: "ors" | "custom";
      readonly request: () => Promise<PlacesRequest | undefined>;
      readonly parse: (fetched: Fetched) => RouteOutcome;
    }[] = [];
    if (customRouter !== undefined && "refused" in customRouter) notes.push(customRouter.refused);
    else if (customRouter !== undefined && routingUrl !== undefined)
      attempts.push({
        record: customRouter,
        source: "custom",
        request: async () => osrmRouteRequest(customRouter, routingUrl, points),
        parse: (fetched) => parseOsrmRoute(fetched, now()),
      });
    const orsKey = await options.credential?.("orsKey");
    if (typeof orsKey === "string" && orsKey !== "")
      attempts.push({
        record: orsRecord,
        source: "ors",
        request: async () => orsRouteRequest(points, { ...call(), credential: (key) => (key === "orsKey" ? orsKey : undefined) }),
        parse: (fetched) => parseOrsRoute(fetched, now()),
      });
    for (const attempt of attempts) {
      // The operator's own router is theirs to turn off by clearing routingUrl; only ORS is a listed source. Both pause on failures.
      const health = open().store.health(attempt.record.id, now());
      const paused =
        health.disabledUntil !== undefined && Date.parse(health.disabledUntil) > Date.parse(now())
          ? pausedOutcome(health.disabledUntil)
          : undefined;
      const why = attempt.source === "ors" ? refusal(attempt.record, context) : paused;
      if (why !== undefined) {
        reports.push({ source: attempt.record.id, outcome: why });
        continue;
      }
      const request = await attempt.request();
      if (request === undefined) continue;
      const fetched = await send(attempt.record, request, signal);
      if ("skipped" in fetched) {
        reports.push({ source: attempt.record.id, outcome: fetched.skipped });
        continue;
      }
      const outcome = attempt.parse(fetched);
      noteOutcome(attempt.record, outcome);
      reports.push({ source: attempt.record.id, outcome: outcome.kind });
      if (outcome.kind === "ok")
        return {
          routed: {
            line: outcome.line,
            distanceKm: outcome.distanceKm,
            source: attempt.source,
            attribution: attempt.record.terms.attribution,
          },
          tried: true,
        };
    }
    return { tried: attempts.length > 0 };
  };

  /** Germany's charging register packs in the cache, oldest first. */
  const registerPacks = (): string[] =>
    readdirSyncSafe(cacheDir)
      .filter((file) => /^bnetza-\d{4}-\d{2}-\d{2}\.db$/.test(file))
      .sort();
  let registerBuild: Promise<void> | undefined;

  /** A pack file and the side files SQLite may leave beside it. */
  const removeDb = (path: string): void => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  };

  /**
   * Reads the register's newest month into a pack as it streams in; older
   * packs go once it is built. `skipped` when the page was not asked (its
   * budget, or a failure `send` already marked); `drift` when the file no
   * longer reads as the register, which keeps the pack there is.
   */
  const buildRegister = async (signal: AbortSignal): Promise<"built" | "current" | "skipped" | { readonly drift: string }> => {
    const page = await send(bnetzaRecord, { source: bnetzaRecord.id, url: BNETZA_PAGE, body: "text" }, signal);
    if ("skipped" in page) return "skipped";
    if (page.status !== 200 || typeof page.body !== "string") throw new Error(`the register's page answered HTTP ${String(page.status)}`);
    const csv = bnetzaCsvUrl(page.body);
    if (csv === undefined) return { drift: "the register's page links no CSV" };
    const path = join(cacheDir, `bnetza-${csv.release}.db`);
    if (existsSync(path)) return "current";
    if (options.openLines === undefined) throw new Error("this worker cannot stream the register");
    mkdirSync(cacheDir, { recursive: true });
    const building = `${path}.building`;
    removeDb(building);
    const writer = writeEvPack(building);
    const reader = createBnetzaReader();
    const at = now();
    let bytes = 0;
    let sites = 0;
    const log = (status: number): void => open().store.log({ source: bnetzaRecord.id, host: new URL(csv.url).host, at, status, bytes });
    try {
      for await (const line of options.openLines(csv.url, { "User-Agent": userAgent }, signal)) {
        bytes += Buffer.byteLength(line) + 1;
        const site = reader.line(line);
        if (site !== undefined) {
          writer.add(site);
          sites += 1;
        }
      }
      // Most records are chargers in service: far fewer read means the file changed shape.
      if (!reader.header() || sites === 0 || sites * 2 < reader.records()) {
        writer.abort();
        removeDb(building);
        log(200);
        return {
          drift: reader.header() ? `${String(sites)} of ${String(reader.records())} records read` : "the register's file has no header row",
        };
      }
      writer.finish(csv.release, now());
    } catch (error) {
      writer.abort();
      removeDb(building);
      log(0);
      throw error;
    }
    renameSync(building, path);
    log(200);
    for (const old of registerPacks()) if (old !== basename(path)) removeDb(join(cacheDir, old));
    return "built";
  };

  /** Starts a register build in the background, unless one is running or the source may not be asked. */
  const startRegister = (context: CallContext, reports: SourceReport[]): void => {
    if (registerBuild !== undefined) {
      reports.push({ source: bnetzaRecord.id, outcome: "building: the register is being read; ask again in a minute or two" });
      return;
    }
    const why = refusal(bnetzaRecord, context);
    if (why !== undefined) {
      reports.push({ source: bnetzaRecord.id, outcome: why });
      return;
    }
    registerBuild = buildRegister(stopping.signal)
      .then((result) => {
        if (result === "built" || result === "current") noteOutcome(bnetzaRecord, { kind: "ok" });
        else if (result !== "skipped") noteOutcome(bnetzaRecord, { kind: "drift", detail: result.drift });
      })
      .catch((error: unknown) => {
        if (stopping.signal.aborted) return;
        open().store.recordOutcome(bnetzaRecord.id, { ok: false, error: errorMessage(error) }, now());
      })
      .finally(() => {
        registerBuild = undefined;
      });
    reports.push({ source: bnetzaRecord.id, outcome: "building: the register is being read; ask again in a minute or two" });
  };

  /** A source's credential settings, read once per call. */
  const secretsFor = async (record: PlacesSourceRecord): Promise<SourceCall["credential"]> => {
    const secrets = new Map<string, string>();
    for (const key of record.credential ?? []) {
      const value = await options.credential?.(key);
      if (typeof value === "string" && value !== "") secrets.set(key, value);
    }
    return (key) => secrets.get(key);
  };

  /**
   * What a source keeps between calls, in the worker's cache (left out of
   * backups): one JSON file each, only for a source whose terms allow keeping.
   */
  const sourceCache = (record: PlacesSourceRecord): SourceCall["cache"] => {
    if (record.terms.cache.mode === "none" || record.terms.cache.mode === "ids-only") return undefined;
    const file = join(cacheDir, `source-${record.id}.json`);
    return {
      read: () => {
        try {
          return JSON.parse(readFileSync(file, "utf8")) as unknown;
        } catch {
          return undefined;
        }
      },
      write: (value) => {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(`${file}.writing`, JSON.stringify(value));
        renameSync(`${file}.writing`, file);
      },
    };
  };

  /** One fuel source asked, its outcome reported and marked on its health; the answer when it gave one. */
  const askFuel = async (
    adapter: FuelAdapter,
    fuelQuery: FuelQuery,
    signal: AbortSignal,
    context: CallContext,
    reports: SourceReport[],
  ) => {
    const why = refusal(adapter.record, context);
    if (why !== undefined) {
      reports.push({ source: adapter.record.id, outcome: why });
      return undefined;
    }
    const outcome = await adapter.run(
      fuelQuery,
      { ...call(), credential: await secretsFor(adapter.record), cache: sourceCache(adapter.record) },
      (request) => send(adapter.record, request, signal),
    );
    if (outcome.kind === "skipped") {
      reports.push({ source: adapter.record.id, outcome: outcome.reason });
      return undefined;
    }
    noteOutcome(adapter.record, outcome);
    if (outcome.kind !== "ok") {
      reports.push({ source: adapter.record.id, outcome: outcome.kind });
      return undefined;
    }
    reports.push({ source: adapter.record.id, outcome: "ok", found: outcome.stations.length });
    return outcome;
  };

  /** The fuel sources a watch may ask: its country's, covering its point, never one only a person may ask. */
  const watchSources = (area: FuelWatch["area"]): FuelAdapter[] =>
    fuelSources.filter(
      (adapter) =>
        adapter.record.countries.includes(area.country) &&
        (adapter.covers?.(area) ?? true) &&
        !adapter.record.terms.userTriggeredOnly &&
        adapter.averagesOnly !== true,
    );

  /** One watch's sweep: its sources as a run nobody attends; fresh prices at or under its threshold are hits. */
  const sweepOne = async (watch: FuelWatch, signal: AbortSignal): Promise<void> => {
    const { watches } = open();
    const started = now();
    let outcome: string;
    try {
      const reports: SourceReport[] = [];
      const cutoff = Date.parse(started) - WATCH_MAX_AGE_HOURS * 3_600_000;
      const found: Omit<FuelHit, "watchId" | "firstSeen">[] = [];
      const above: string[] = [];
      for (const adapter of watchSources(watch.area)) {
        const answer = await askFuel(
          adapter,
          {
            point: watch.area,
            radiusKm: watch.area.radiusKm,
            fuel: watch.fuel,
            areaLabel: watch.area.label,
            country: watch.area.country,
            limit: 30,
          },
          signal,
          { unattended: true },
          reports,
        );
        for (const read of answer?.stations ?? []) {
          const price = read.price;
          if (price === undefined || price.currency !== watch.currency) continue;
          if (price.amount > watch.threshold) {
            above.push(`${read.candidate.source}:${read.candidate.sourceId}`);
            continue;
          }
          if (price.basis !== "daily" && Date.parse(price.reportedAt) < cutoff) continue;
          if (distanceKm(watch.area, read.candidate) > watch.area.radiusKm) continue;
          found.push({
            stationKey: `${read.candidate.source}:${read.candidate.sourceId}`,
            price: price.amount,
            currency: price.currency,
            station: stationLabel(read.candidate),
            reportedAt: price.reportedAt,
          });
        }
      }
      watches.clearStations(watch.watchId, above);
      const added = watches.addHits(watch.watchId, found, now());
      const trouble = reports.filter((report) => report.outcome !== "ok").map((report) => report.source);
      outcome = `${String(added)} new of ${String(found.length)} at or under ${String(watch.threshold)} ${watch.currency}${trouble.length === 0 ? "" : `; not read: ${[...new Set(trouble)].join(", ")}`}`;
    } catch (error) {
      outcome = `failed: ${errorMessage(error)}`;
    }
    if (stopping.signal.aborted) return;
    watches.swept(watch.watchId, outcome, now(), new Date(Date.parse(started) + watch.cadenceHours * 3_600_000).toISOString());
  };
  /**
   * The sources that keep an issue (the Oil Bulletin's week) read the next
   * one in the background once it is due, as a run nobody attends: a request
   * only where an issue is kept, so only once someone has asked.
   */
  const refreshKept = async (signal: AbortSignal): Promise<void> => {
    for (const adapter of fuelSources) {
      if (adapter.refresh === undefined || signal.aborted || refusal(adapter.record, { unattended: true }) !== undefined) continue;
      let asked = false;
      const failure = await adapter.refresh(
        { ...call(), credential: await secretsFor(adapter.record), cache: sourceCache(adapter.record) },
        (request) => {
          asked = true;
          return send(adapter.record, request, signal);
        },
      );
      if (failure !== undefined && failure.kind !== "skipped") noteOutcome(adapter.record, failure);
      else if (failure === undefined && asked) noteOutcome(adapter.record, { kind: "ok" });
    }
  };
  let sweeping: Promise<void> | undefined;
  /** The last sweep that failed outside a watch's own run (the store), for `sources`. */
  let sweepError: { readonly at: string; readonly error: string } | undefined;
  /** Every due watch, one at a time; one run at once, however often it is asked. */
  const sweep = (): Promise<void> => {
    sweeping ??= (async () => {
      for (const watch of open().watches.due(now())) {
        if (stopping.signal.aborted) break;
        await sweepOne(watch, stopping.signal);
      }
      await refreshKept(stopping.signal);
    })().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };
  const watchSummary = (watch: FuelWatch) => ({
    watchId: watch.watchId,
    area: watch.area,
    fuel: watch.fuel,
    threshold: watch.threshold,
    currency: watch.currency,
    cadenceHours: watch.cadenceHours,
    enabled: watch.enabled,
    ...(watch.lastRunAt === undefined ? {} : { lastRunAt: watch.lastRunAt }),
    ...(watch.lastOutcome === undefined ? {} : { lastOutcome: watch.lastOutcome }),
    nextRunAt: watch.nextRunAt,
  });

  /** A stored place, and what OSM says of it now when it is OSM's and a person asks. */
  const detailsOf = async (input: { readonly placeId: string }, signal: AbortSignal, context: CallContext) => {
    const { store } = open();
    const place = store.place(input.placeId, now());
    if (place === undefined) throw new Error(`no place ${input.placeId}: find it with search first`);
    const osmId = place.ids["osm"];
    const why = refusal(overpass.record, context);
    if (osmId === undefined || why !== undefined) return { place, ...(osmId === undefined ? {} : { osm: why }) };
    const request = overpass.details?.(osmId, call());
    if (request === undefined) return { place };
    const fetched = await send(overpass.record, request, signal);
    if ("skipped" in fetched) return { place, osm: fetched.skipped };
    const outcome = overpass.parse(fetched, request, call());
    noteOutcome(overpass.record, outcome);
    if (outcome.kind !== "ok" || outcome.candidates[0] === undefined)
      return { place, osm: outcome.kind === "ok" ? "gone from OSM" : outcome.kind };
    store.putOsm(outcome.osm, now());
    const fresh = outcome.candidates[0];
    return {
      place,
      osm: {
        name: fresh.name,
        ...definedOnly({
          phone: fresh.phone,
          website: fresh.website,
          hours: fresh.hours,
          hoursCheckedAt: fresh.hoursCheckedAt,
          checkedAt: fresh.checkedAt,
        }),
        status: fresh.status,
      },
    };
  };

  /** A place as a reply shows it, with its distance from the search's point. */
  const shown = (place: Place, point?: { readonly lat: number; readonly lon: number }): ShownPlace => ({
    ...place,
    ...(point === undefined ? {} : { distanceKm: Math.round(distanceKm(point, place.location) * 100) / 100 }),
  });
  const notices = (places: readonly Place[]): string[] => [
    ...new Set(
      places.flatMap((place) => [
        ...place.attribution,
        ...Object.keys(place.ids).flatMap((source) => DATA_SOURCE_TERMS.get(source)?.terms.displayRules ?? []),
      ]),
    ),
  ];

  return {
    async search(input: unknown, signal: AbortSignal, context: CallContext): Promise<SearchReply> {
      const query = PlacesQuerySchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const area = "text" in query.area ? await geocode(query.area.text, query.country, deadline, context, reports) : query.area;
      if (area === undefined)
        return {
          places: [],
          found: 0,
          sources: withExhaustion(reports, now()),
          note: "The area could not be found: name a city, postcode or district",
        };
      const radiusKm = "radiusKm" in query.area ? query.area.radiusKm : TEXT_AREA_RADIUS_KM;
      const country = query.country ?? ("country" in area ? area.country : undefined);
      const plan = planQuery(query.query);
      // A diet or wheelchair filter only OSM's tags can answer: the other sources are not asked.
      const tagFiltered = (query.filters?.diet?.length ?? 0) > 0 || query.filters?.wheelchair === true;
      const poi: PoiQuery = {
        point: coarsenPoint(area, 2),
        radiusKm,
        ...(country === undefined ? {} : { country }),
        tags: plan.tags,
        words: plan.nameWords,
        ...(query.filters?.diet === undefined ? {} : { diet: query.filters.diet }),
        ...(query.filters?.wheelchair === undefined ? {} : { wheelchair: query.filters.wheelchair }),
        limit: query.limit,
      };
      const candidates: Candidate[] = [];
      // With Overpass unanswered, Photon is asked for the category by its name ("pharmacy"), its tags filtering the answer.
      let overpassAnswered = false;
      const fallbackWords =
        plan.words.length === 0 && plan.tags.length > 0 && plan.label !== undefined ? (plan.label.split(", ")[0] ?? "").split(" ") : [];
      for (const adapter of poiSources) {
        if (query.sources !== undefined && !query.sources.includes(adapter.record.id)) continue;
        if (tagFiltered && adapter !== overpass) continue;
        const asking =
          adapter.record.id === "photon" && !overpassAnswered && fallbackWords.length > 0 ? { ...poi, words: fallbackWords } : poi;
        const why = refusal(adapter.record, context);
        if (why !== undefined) {
          reports.push({ source: adapter.record.id, outcome: why });
          continue;
        }
        const ask = async (instance: string | undefined) => {
          const request = adapter.search(asking, call(instance));
          if (request === undefined) return undefined;
          const fetched = await send(adapter.record, request, deadline);
          if ("skipped" in fetched) return { skipped: fetched.skipped };
          const parsed = adapter.parse(fetched, request, call(instance));
          noteOutcome(adapter.record, parsed);
          return { outcome: parsed };
        };
        let asked = await ask(baseUrl);
        // An Overpass that answers overloaded (a 429, or a 5xx) is asked once more on the other known instance. One that never
        // answered is not: its wait already used most of the search's deadline.
        const failedFirst =
          asked !== undefined &&
          !("skipped" in asked) &&
          (asked.outcome.kind === "rate-limited" || (asked.outcome.kind === "failed" && asked.outcome.status >= 500));
        const other = adapter === overpass ? nextOverpassInstance(baseUrl) : undefined;
        if (failedFirst && other !== undefined && !deadline.aborted) asked = await ask(other);
        if (asked === undefined) continue;
        if ("skipped" in asked) {
          reports.push({ source: adapter.record.id, outcome: asked.skipped });
          continue;
        }
        const { outcome } = asked;
        if (outcome.kind !== "ok") {
          reports.push({ source: adapter.record.id, outcome: outcome.kind });
          continue;
        }
        if (adapter === overpass) overpassAnswered = true;
        if (outcome.osm.length > 0) open().store.putOsm(outcome.osm, now());
        // A phone written without its country code is read in the search's country.
        candidates.push(
          ...outcome.candidates.map((candidate) =>
            candidate.country === undefined && country !== undefined ? { ...candidate, country } : candidate,
          ),
        );
        reports.push({ source: adapter.record.id, outcome: "ok", found: outcome.candidates.length });
      }
      if (!tagFiltered && (query.sources === undefined || query.sources.includes("overture")))
        candidates.push(...(await packCandidates(area, radiusKm, plan, query.limit, deadline, context, reports)));
      // One OSM element found twice (Overpass and Photon) is one candidate, Overpass's fuller one first.
      const unique = [
        ...new Map(candidates.map((candidate) => [`${candidate.source}:${candidate.sourceId}`, candidate] as const).reverse()).values(),
      ].reverse();
      const chains = query.filters?.excludeChains === true;
      const resolved = resolvePlaces(
        unique.filter((candidate) => !chains || candidate.brand === undefined),
        { now: now(), priority: ["osm", "overture"], ...(query.filters?.openAt === undefined ? {} : { openAt: query.filters.openAt }) },
      );
      const { places: kept } = open().store.putPlaces(resolved, now());
      // Names that carry the query's words first, then confidence, then distance.
      const words = (plan.nameWords.length > 0 ? plan.nameWords : plan.words).map(latinText);
      const rank = (place: Place): number => words.filter((word) => latinText(place.name).includes(word)).length;
      const nearby = kept.filter((place) => distanceKm(area, place.location) <= radiusKm * 1.1);
      // At a time asked for, a place known to be closed then is left out; one whose hours are uncertain stays.
      const notClosed = query.filters?.openAt === undefined ? nearby : nearby.filter((place) => place.hours?.openNow !== "no");
      const ordered = [...notClosed]
        .sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence || distanceKm(area, a.location) - distanceKm(area, b.location))
        .slice(0, query.limit);
      const places = ordered.map((place) => shown(place, area));
      const attribution = notices(ordered);
      return {
        places,
        found: nearby.length,
        area: {
          label: "label" in area ? area.label : undefined,
          point: coarsenPoint(area, 2),
          radiusKm,
          ...(plan.label === undefined ? {} : { category: plan.label }),
        },
        sources: withExhaustion(reports, now()),
        ...(attribution.length === 0 ? {} : { attribution }),
        ...(places.length === 0
          ? {}
          : {
              taviFindings: [
                {
                  kind: "place",
                  records: places.map((place) => ({
                    placeId: place.placeId,
                    name: place.name,
                    ...definedOnly({ address: place.address, phone: place.phone, website: place.website }),
                    confidence: place.confidence,
                    sources: Object.keys(place.ids),
                  })),
                },
              ],
            }),
      };
    },

    /**
     * Fuel or EV stops along a route: the operator's router or
     * OpenRouteService when set up, else the great circle through the route's
     * points with its road distance estimated; then OSM's stations near the
     * line, spread along it.
     */
    async routeStops(
      input: unknown,
      signal: AbortSignal,
      context: CallContext,
    ): Promise<
      RouteStopsResult & {
        readonly sources: readonly SourceReport[];
        readonly attribution?: readonly string[];
        readonly taviFindings?: SearchReply["taviFindings"];
      }
    > {
      const query = RouteStopsInputSchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(ROUTE_DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const notes: string[] = [];
      const points: LinePoint[] = [];
      let start: Awaited<ReturnType<typeof geocode>>;
      for (const text of [query.from, ...(query.via ?? []), query.to]) {
        const point = await geocode(text, undefined, deadline, context, reports);
        start ??= point;
        if (point === undefined)
          return {
            routeGeometry: "corridor_estimate",
            routingSource: "corridor_estimate",
            distanceKm: 0,
            stops: [],
            sources: withExhaustion(reports, now()),
            note: deadline.aborted
              ? "The route's points took too long to find: try again"
              : `"${text.slice(0, 80)}" could not be found: name a city, postcode or district`,
          };
        points.push(point);
      }
      const { routed, tried } = await route(points, deadline, context, reports, notes);
      const line = routed?.line ?? corridorLine(points, CORRIDOR_SPACING_KM);
      const lineKm = lineLengthKm(line);
      const distanceKm = routed?.distanceKm ?? lineKm * ROAD_FACTOR;
      // Along-route distances are the road's: the router's own, or the corridor's estimate.
      const roadScale = lineKm === 0 ? 1 : distanceKm / lineKm;
      if (routed === undefined)
        notes.push(
          `${tried ? "The router did not answer" : "No router is set up"}, so the route is the straight line between its points and its ${String(Math.round(distanceKm))} km an estimate (${String(ROAD_FACTOR)}× the straight distance): stops may sit off the road you take`,
        );
      const candidates: Candidate[] = [];
      const why = refusal(overpass.record, context);
      if (why !== undefined) reports.push({ source: "overpass", outcome: why });
      else {
        const pieces = splitLine(line, Math.min(ROUTE_PIECES_MAX, Math.max(1, Math.ceil(lineKm / ROUTE_PIECE_KM))));
        for (const piece of pieces) {
          const request = overpassAlong(
            {
              line: thinLine(piece, ALONG_LINE_MAX_POINTS),
              radiusKm: query.maxDetourKm,
              kind: query.kind,
              fuel: query.fuel,
              connectors: query.connectors,
              limit: 100,
            },
            call(),
          );
          if (request === undefined) continue;
          const fetched = await send(overpass.record, request, deadline);
          if ("skipped" in fetched) {
            reports.push({ source: "overpass", outcome: fetched.skipped });
            continue;
          }
          const outcome = overpass.parse(fetched, request, call());
          noteOutcome(overpass.record, outcome);
          if (outcome.kind !== "ok") {
            reports.push({ source: "overpass", outcome: outcome.kind });
            continue;
          }
          if (outcome.osm.length > 0) open().store.putOsm(outcome.osm, now());
          candidates.push(...outcome.candidates);
          reports.push({ source: "overpass", outcome: "ok", found: outcome.candidates.length });
        }
      }
      const unique = [...new Map(candidates.map((candidate) => [candidate.sourceId, candidate] as const)).values()];
      const { places } = open().store.putPlaces(resolvePlaces(unique, { now: now(), priority: ["osm"] }), now());
      const placed = places
        .map((place) => ({ place, ...positionOnLine(place.location, line) }))
        .filter((each) => each.offKm <= query.maxDetourKm);
      const { targets, spacingKm, coveredKm, capped } = stopTargets(
        lineKm,
        query.stops,
        query.rangeKm === undefined ? undefined : query.rangeKm / roadScale,
      );
      if (capped)
        notes.push(`Stops are given for the first ${String(Math.round(coveredKm * roadScale))} km only: ask again from there for the rest`);
      const chosen = new Map<string, (typeof placed)[number]>();
      for (const target of targets) {
        // A stop for a target lies within half the spacing of it, so each is where it was wanted.
        const nearest = placed
          .filter((each) => Math.abs(each.alongKm - target) <= spacingKm / 2)
          .sort((a, b) => Math.abs(a.alongKm - target) + a.offKm - (Math.abs(b.alongKm - target) + b.offKm));
        for (const each of nearest.slice(0, STOPS_PER_TARGET)) chosen.set(each.place.placeId, each);
      }
      // Where the start's country has no station prices (the US, most of the EU), its fuel stops carry the country's or state's
      // weekly average, said to be one; where it has them, fuel_prices near a stop gives them.
      const startCountry = start?.country;
      const priced =
        startCountry !== undefined &&
        fuelSources.some((adapter) => adapter.averagesOnly !== true && adapter.record.countries.includes(startCountry));
      const averages =
        startCountry === undefined || priced
          ? undefined
          : fuelSources.find((adapter) => adapter.averagesOnly === true && adapter.record.countries.includes(startCountry));
      let average: RegionalAverage | undefined;
      if (query.kind === "fuel" && start !== undefined && averages !== undefined && chosen.size > 0) {
        average = (
          await askFuel(
            averages,
            { point: start, radiusKm: 1, fuel: query.fuel ?? "e10", areaLabel: start.label, country: startCountry, limit: 1 },
            deadline,
            context,
            reports,
          )
        )?.average;
        const where = startCountry === "US" ? "the US" : countryName(startCountry ?? "");
        const publisher = averages.record.id === "us-eia" ? "EIA" : "the EU's Weekly Oil Bulletin";
        const local = EU_LOCAL_CURRENCIES.get(startCountry ?? "");
        notes.push(
          average === undefined
            ? `Tavi has no station prices for ${where}, and ${publisher}'s weekly average was not available`
            : `Tavi has no station prices for ${where}: each stop shows ${publisher}'s weekly average for ${average.area} (week of ${average.reportedAt.slice(0, 10)}), not its own price${local === undefined ? "" : `, converted to EUR (the pumps price in ${local})`}${average.staleDays === undefined ? "" : `; that week is ${String(average.staleDays)} days old, as the Commission has published none since`}`,
        );
      }
      const stops: RouteStop[] = [...chosen.values()]
        .sort((a, b) => a.alongKm - b.alongKm)
        .slice(0, 30)
        .map(({ place, alongKm, offKm }) => ({
          ...place,
          ...(average === undefined
            ? { priceKind: "none" as const }
            : {
                priceKind: "regional_average" as const,
                price: {
                  amount: average.amount,
                  currency: average.currency,
                  fuel: average.fuel,
                  reportedAt: average.reportedAt,
                  source: average.source,
                },
              }),
          alongKm: Math.round(alongKm * roadScale * 10) / 10,
          offRouteKm: Math.round(offKm * 100) / 100,
        }));
      // Stations come only from Overpass: with none of its answers read, no stop is not "no station".
      const overpassRead = reports.some((report) => report.source === "overpass" && report.outcome === "ok");
      if (placed.length === 0 && !overpassRead)
        notes.push(
          `OpenStreetMap's stations were not read (Overpass: ${reports.find((report) => report.source === "overpass")?.outcome ?? "not asked"}), so no stop is known`,
        );
      else if (placed.length === 0)
        notes.push(
          `No ${query.kind === "ev" ? "charging station" : "fuel station"} within ${String(query.maxDetourKm)} km of the route was found`,
        );
      const attribution = [
        ...new Set([
          ...notices(stops),
          ...(routed?.attribution === undefined ? [] : [routed.attribution]),
          ...(average === undefined || averages === undefined
            ? []
            : [averages.record.terms.attribution, ...averages.record.terms.displayRules]),
        ]),
      ].filter((line) => line !== "");
      return {
        routeGeometry: routed === undefined ? "corridor_estimate" : "road_network",
        routingSource: routed?.source ?? "corridor_estimate",
        distanceKm: Math.round(distanceKm * 10) / 10,
        stops,
        ...(notes.length === 0 ? {} : { note: notes.join(". ").slice(0, 500) }),
        sources: withExhaustion(reports, now()),
        ...(attribution.length === 0 ? {} : { attribution }),
        ...(stops.length === 0
          ? {}
          : {
              taviFindings: [
                {
                  kind: "place",
                  records: stops.map((stop) => ({
                    placeId: stop.placeId,
                    name: stop.name,
                    ...(stop.address === undefined ? {} : { address: stop.address }),
                    alongKm: stop.alongKm,
                    offRouteKm: stop.offRouteKm,
                    confidence: stop.confidence,
                    sources: Object.keys(stop.ids),
                  })),
                },
              ],
            }),
      };
    },

    /**
     * Charging sites near an area: Germany's register pack, AFDC in the
     * US and Canada, Open Charge Map everywhere; one site several sources list
     * is one charger, with all their connectors. No live availability.
     */
    async evChargers(input: unknown, signal: AbortSignal, context: CallContext): Promise<EvChargersReply> {
      const query = EvChargersInputSchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const empty = (note: string): EvChargersReply => ({ chargers: [], sources: withExhaustion(reports, now()), note });
      const area = "text" in query.area ? await geocode(query.area.text, query.country, deadline, context, reports) : query.area;
      if (area === undefined)
        return empty(
          deadline.aborted ? "The area took too long to find: try again" : "The area could not be found: name a city, postcode or district",
        );
      const radiusKm = "radiusKm" in query.area ? query.area.radiusKm : TEXT_AREA_RADIUS_KM;
      const country = query.country ?? ("country" in area ? area.country : undefined);
      if (country === undefined) return empty("Say which country the area is in (country: a two-letter code)");
      const reads: EvRead[] = [];
      const notes: string[] = [];
      if (bnetzaRecord.countries.includes(country)) {
        if (!enabled().has(bnetzaRecord.id)) reports.push({ source: bnetzaRecord.id, outcome: "off: turned off in the plugin's settings" });
        else {
          const newest = registerPacks().at(-1);
          if (newest !== undefined) {
            const pack = openEvPack(join(cacheDir, newest));
            try {
              const found = pack.near(area, radiusKm, query.connectors, query.limit * 3);
              reads.push(...found);
              reports.push({ source: bnetzaRecord.id, outcome: "ok", found: found.length });
              if (Date.parse(now()) - Date.parse(pack.release) > REGISTER_MAX_AGE_DAYS * 86_400_000) startRegister(context, []);
            } finally {
              pack.close();
            }
          } else startRegister(context, reports);
        }
      }
      for (const adapter of evSources.filter((each) => each.record.countries.includes(country) || each.record.countries.includes("*"))) {
        const why = refusal(adapter.record, context);
        if (why !== undefined) {
          reports.push({ source: adapter.record.id, outcome: why });
          continue;
        }
        const outcome = await adapter.run(
          { point: area, radiusKm, connectors: query.connectors, limit: query.limit },
          { ...call(), credential: await secretsFor(adapter.record) },
          (request) => send(adapter.record, request, deadline),
        );
        if (outcome.kind === "skipped") {
          reports.push({ source: adapter.record.id, outcome: outcome.reason });
          continue;
        }
        noteOutcome(adapter.record, outcome);
        if (outcome.kind !== "ok") {
          reports.push({ source: adapter.record.id, outcome: outcome.kind });
          continue;
        }
        reads.push(...outcome.sites);
        reports.push({ source: adapter.record.id, outcome: "ok", found: outcome.sites.length });
      }
      const bySource = new Map(reads.map((read) => [`${read.candidate.source}:${read.candidate.sourceId}`, read] as const));
      // Every row merged into a site counts: one register site is often several rows, each with its own plugs.
      const merged = resolveClusters(
        reads.map((read) => read.candidate),
        { now: now(), priority: [bnetzaRecord.id, "afdc", "ocm"] },
      );
      const chargers = merged
        .flatMap(({ place, members: candidates }): (Charger & { readonly distanceKm: number })[] => {
          const members = candidates
            .map((candidate) => bySource.get(`${candidate.source}:${candidate.sourceId}`))
            .filter((read) => read !== undefined);
          const connectors = [...new Set(members.flatMap((read) => read.connectors))];
          const kws = members.flatMap((read) => (read.maxKw === undefined ? [] : [read.maxKw]));
          const counts = members.flatMap((read) => (read.points === undefined ? [] : [read.points]));
          const registerRows = members.filter((read) => read.candidate.source === bnetzaRecord.id);
          const maxKw = kws.length === 0 ? undefined : Math.max(...kws);
          const distance = distanceKm(area, place.location);
          if (distance > radiusKm) return [];
          if (
            query.connectors !== undefined &&
            query.connectors.length > 0 &&
            !connectors.some((connector) => query.connectors?.includes(connector))
          )
            return [];
          // A site whose power no source states stays: only a known lower power leaves it out.
          if (query.minKw !== undefined && maxKw !== undefined && maxKw < query.minKw) return [];
          // The register's rows at one site are separate chargers, so their points add up; other sources describe the site whole.
          const points =
            registerRows.length > 1
              ? registerRows.reduce((sum, read) => sum + (read.points ?? 0), 0)
              : counts.length === 0
                ? undefined
                : Math.max(...counts);
          return [
            {
              ...place,
              connectors,
              ...(maxKw === undefined ? {} : { maxKw }),
              ...(points === undefined || points === 0 ? {} : { points }),
              distanceKm: Math.round(distance * 100) / 100,
            },
          ];
        })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, query.limit);
      const used = new Set(chargers.flatMap((charger) => Object.keys(charger.ids)));
      const attribution = [
        ...new Set([
          ...chargers.flatMap((charger) => charger.attribution),
          ...[...used].flatMap((id) => records.get(id)?.terms.displayRules ?? []),
        ]),
      ];
      // Outside the US and Germany only Open Charge Map covers a country: without its key nothing answers, and OSM's stations still do.
      // The geocoder's report is not a charging source's.
      if (!reports.some((report) => report.outcome === "ok" && report.source !== "nominatim" && report.source !== "photon"))
        notes.push(
          `No charging source answered for ${country}${reports.some((report) => report.source === "ocm" && report.outcome.startsWith("not set up")) ? " (Open Charge Map needs its free key, ocmKey)" : ""}: search for "ev charging" finds OpenStreetMap's stations, without their plugs or power`,
        );
      notes.push("No source here reports whether a charger is free now: check its network's app before relying on it");
      if (query.minKw !== undefined && chargers.some((charger) => charger.maxKw === undefined))
        notes.push("Some sites' power is not stated, so they are kept");
      return {
        area: { label: "label" in area ? area.label : undefined, point: coarsenPoint(area, 2), radiusKm, country },
        chargers,
        sources: withExhaustion(reports, now()),
        ...(chargers.length === 0 ? {} : { taviFindings: [placeFinding(chargers)] }),
        ...(attribution.length === 0 ? {} : { attribution }),
        note: notes.join(". ").slice(0, 500),
      };
    },

    /**
     * What the neighbourhood's open data says near a point: complaints,
     * permits and crime, counted by kind with the latest few, from the
     * sources that cover it. Kinds and dates only, never a report's own words.
     */
    async areaReport(input: unknown, signal: AbortSignal, context: CallContext): Promise<AreaReportReply> {
      const query = AreaReportInputSchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      // An address the person named for a report goes to the geocoder and is never cached.
      const area = "text" in query.area ? await geocode(query.area.text, query.country, deadline, context, reports, "skip") : query.area;
      if (area === undefined)
        return {
          sections: [],
          sources: withExhaustion(reports, now()),
          note: deadline.aborted
            ? "The area took too long to find: try again"
            : "The area could not be found: name an address area, postcode or district",
        };
      const radiusKm = "radiusKm" in query.area ? query.area.radiusKm : REPORT_RADIUS_KM;
      const country = query.country ?? ("country" in area ? area.country : undefined);
      const since = new Date(Date.parse(now()) - query.days * 86_400_000).toISOString();
      const topics = query.topics ?? CIVIC_TOPICS;
      const adapters = civicSources.filter((adapter) => topics.includes(adapter.topic) && adapter.covers(area, country));
      const where = { label: "label" in area ? area.label : undefined, point: coarsenPoint(area, 3), radiusKm, country };
      if (adapters.length === 0) {
        const cities = (options.open311Cities ?? OPEN311_CITIES).map((city) => city.name).join(", ");
        return {
          area: where,
          since,
          sections: [],
          sources: withExhaustion(reports, now()),
          note: `Tavi has no neighbourhood data for this area. It covers New York City (311 and permits), England, Wales and Northern Ireland (crime), and these Open311 cities: ${cities}`,
        };
      }
      const sections: AreaReportSection[] = [];
      for (const adapter of adapters) {
        const why = refusal(adapter.record, context);
        if (why !== undefined) {
          reports.push({ source: adapter.record.id, outcome: why });
          continue;
        }
        const outcome = await adapter.run(
          { point: area, radiusKm, since },
          { ...call(), credential: await secretsFor(adapter.record) },
          (request) => send(adapter.record, request, deadline),
        );
        if (outcome.kind === "skipped") {
          reports.push({ source: adapter.record.id, outcome: outcome.reason });
          continue;
        }
        noteOutcome(adapter.record, outcome);
        if (outcome.kind !== "ok") {
          reports.push({ source: adapter.record.id, outcome: outcome.kind });
          continue;
        }
        const { items } = outcome.report;
        reports.push({ source: adapter.record.id, outcome: "ok", found: items.length });
        const counts = new Map<string, number>();
        for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
        sections.push({
          source: adapter.record.id,
          topic: outcome.report.topic,
          count: items.length,
          ...(outcome.report.period === undefined ? {} : { period: outcome.report.period }),
          byKind: [...counts]
            .map(([kind, count]) => ({ kind, count }))
            .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
            .slice(0, REPORT_KINDS_MAX),
          latest: [...items].sort((a, b) => b.at.localeCompare(a.at) || a.distanceKm - b.distanceKm).slice(0, REPORT_LATEST_MAX),
          ...(outcome.report.caveat === undefined ? {} : { caveat: outcome.report.caveat }),
        });
      }
      const attribution = [
        ...new Set(
          sections.flatMap((section) => {
            const record = records.get(section.source);
            return record === undefined ? [] : [record.terms.attribution, ...record.terms.displayRules];
          }),
        ),
      ];
      return {
        area: where,
        since,
        sections,
        sources: withExhaustion(reports, now()),
        ...(attribution.length === 0 ? {} : { attribution }),
        ...(notes(sections).length === 0 ? {} : { note: notes(sections).join(". ") }),
      };
    },

    /** Waits for a background build (Germany's charging register) to end. */
    async idle(): Promise<void> {
      await registerBuild;
    },

    /**
     * Fuel prices near an area: the country's sources, each price with
     * when it was reported. One older than `maxAgeHours` is left out and
     * counted; the US has only EIA's weekly regional average.
     */
    async fuelPrices(input: unknown, signal: AbortSignal, context: CallContext): Promise<FuelPricesReply> {
      const query = FuelPricesInputSchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const empty = (note: string): FuelPricesReply => ({
        fuel: query.fuel,
        stations: [],
        excludedStale: 0,
        sources: withExhaustion(reports, now()),
        note,
      });
      const area = "text" in query.area ? await geocode(query.area.text, query.country, deadline, context, reports) : query.area;
      if (area === undefined)
        return empty(
          deadline.aborted ? "The area took too long to find: try again" : "The area could not be found: name a city, postcode or district",
        );
      const radiusKm = "radiusKm" in query.area ? query.area.radiusKm : TEXT_AREA_RADIUS_KM;
      const country = query.country ?? ("country" in area ? area.country : undefined);
      if (country === undefined) return empty("Say which country the area is in (country: a two-letter code)");
      const adapters = fuelSources.filter((adapter) => adapter.record.countries.includes(country) && (adapter.covers?.(area) ?? true));
      if (adapters.length === 0) return empty(`Tavi has no fuel price source for ${country}`);
      const reads: FuelRead[] = [];
      let average: RegionalAverage | undefined;
      const used = new Set<string>();
      const cutoff = Date.parse(now()) - query.maxAgeHours * 3_600_000;
      const fresh = (read: FuelRead): boolean =>
        read.price === undefined || read.price.basis === "daily" || Date.parse(read.price.reportedAt) >= cutoff;
      for (const adapter of adapters) {
        // A country's average only where no station's own price was read within the area and fresh: none published, their
        // source failed, or each one is too old.
        if (
          adapter.averagesOnly === true &&
          reads.some((read) => read.price !== undefined && fresh(read) && distanceKm(area, read.candidate) <= radiusKm)
        )
          continue;
        const outcome = await askFuel(
          adapter,
          { point: area, radiusKm, fuel: query.fuel, areaLabel: "label" in area ? area.label : undefined, country, limit: query.limit },
          deadline,
          context,
          reports,
        );
        if (outcome === undefined) continue;
        used.add(adapter.record.id);
        reads.push(...outcome.stations);
        average ??= outcome.average;
      }
      const nearby = reads
        .map((read) => ({ read, distance: distanceKm(area, read.candidate) }))
        .filter(({ distance }) => distance <= radiusKm);
      // A once-a-day snapshot is always a day old: its date is shown, not cut.
      const kept = nearby.filter(({ read }) => fresh(read));
      const ordered = [...kept]
        .sort((a, b) => (a.read.price?.amount ?? Infinity) - (b.read.price?.amount ?? Infinity) || a.distance - b.distance)
        .slice(0, query.limit);
      const stations = ordered.flatMap(({ read, distance }): (FuelStation & { readonly distanceKm: number })[] => {
        const [place] = resolvePlaces([read.candidate], { now: now(), priority: [read.candidate.source] });
        if (place === undefined) return [];
        const priceKind: FuelStation["priceKind"] = read.price === undefined ? "none" : "station";
        return [
          { ...place, ...(read.price === undefined ? {} : { price: read.price }), priceKind, distanceKm: Math.round(distance * 100) / 100 },
        ];
      });
      const attribution = [...used].flatMap((id) => {
        const record = records.get(id);
        return record === undefined ? [] : [record.terms.attribution, ...record.terms.displayRules];
      });
      const notes: string[] = [];
      if (average !== undefined)
        notes.push(
          averageNote(
            average,
            country,
            adapters.some((adapter) => adapter.averagesOnly !== true),
          ),
        );
      const excludedStale = nearby.length - kept.length;
      if (excludedStale > 0)
        notes.push(
          `${String(excludedStale)} station${excludedStale === 1 ? "'s price was" : "s' prices were"} older than ${String(query.maxAgeHours)} hours and left out`,
        );
      return {
        fuel: query.fuel,
        area: { label: "label" in area ? area.label : undefined, point: coarsenPoint(area, 2), radiusKm, country },
        stations,
        excludedStale,
        ...(average === undefined ? {} : { regionalAverage: average }),
        sources: withExhaustion(reports, now()),
        ...(stations.length === 0 ? {} : { taviFindings: [placeFinding(stations)] }),
        ...(attribution.length === 0 ? {} : { attribution: [...new Set(attribution)] }),
        ...(notes.length === 0 ? {} : { note: notes.join(". ").slice(0, 500) }),
      };
    },

    /**
     * Whether a trade is licensed in a jurisdiction, from the matrix,
     * and a licensee's record when the row's register has an API and the
     * person named someone. "Not licensed here" makes no request.
     */
    async verifyLicense(
      input: unknown,
      signal: AbortSignal,
      context: CallContext,
    ): Promise<VerifyLicenseResult & { readonly sources?: readonly SourceReport[]; readonly attribution?: readonly string[] }> {
      const query = VerifyLicenseInputSchema.parse(input);
      const found = findLicensingRow(licensing, query.jurisdiction, query.profession);
      if (found === undefined)
        return {
          regime: "unknown",
          access: "none",
          matches: [],
          note: `Tavi has no record of how ${query.profession.replace(/_/g, " ")} is licensed in ${query.jurisdiction}: ask the local regulator`,
          matrixRow: "none",
        };
      const { row, ref } = found;
      const base = {
        regime: row.regime,
        ...(row.regulator === undefined ? {} : { regulator: row.regulator }),
        access: row.access,
        ...(row.verifyUrl === undefined ? {} : { verifyUrl: row.verifyUrl }),
        matrixRow: ref,
      };
      const answer = (
        note: string,
        extra: {
          readonly matches?: VerifyLicenseResult["matches"];
          readonly sources?: readonly SourceReport[];
          readonly attribution?: readonly string[];
        } = {},
      ) => ({
        ...base,
        matches: extra.matches ?? [],
        note: note.slice(0, 500),
        ...(extra.sources === undefined ? {} : { sources: extra.sources }),
        ...(extra.attribution === undefined ? {} : { attribution: extra.attribution }),
      });
      if (row.access !== "api" || row.regime === "not_licensed") return answer(row.note);
      const subject = query.subject ?? {};
      if (subject.name === undefined && subject.licenceNumber === undefined)
        return answer(`${row.note} Give a name or licence number to look one up.`);
      if (row.source !== tdlrRecord.id) return answer(`${row.note} Tavi cannot read that register yet.`);
      const why = refusal(tdlrRecord, context);
      if (why !== undefined)
        return answer(`${row.note} The register was not asked (${why}).`, {
          sources: withExhaustion([{ source: tdlrRecord.id, outcome: why }], now()),
        });
      const token = await options.credential?.("socrataAppToken");
      const request = tdlrRequest(row, subject, {
        ...call(),
        credential: (key) => (key === "socrataAppToken" && typeof token === "string" && token !== "" ? token : undefined),
      });
      if (request === undefined) return answer(`${row.note} The name or number has nothing to look up.`);
      const fetched = await send(tdlrRecord, request, AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]));
      if ("skipped" in fetched)
        return answer(`${row.note} The register did not answer (${fetched.skipped}).`, {
          sources: withExhaustion([{ source: tdlrRecord.id, outcome: fetched.skipped }], now()),
        });
      const outcome = parseTdlr(fetched, now());
      noteOutcome(tdlrRecord, outcome);
      if (outcome.kind !== "ok")
        return answer(`${row.note} The register did not answer (${outcome.kind}).`, {
          sources: [{ source: tdlrRecord.id, outcome: outcome.kind }],
        });
      const sources = [{ source: tdlrRecord.id, outcome: "ok", found: outcome.matches.length }];
      const attribution = [tdlrRecord.terms.attribution, ...tdlrRecord.terms.displayRules];
      if (outcome.matches.length === 0) {
        const next =
          subject.licenceNumber === undefined
            ? "names differ, so ask them for their licence number"
            : "check the number with the regulator itself";
        return answer(
          `No licence of this kind was found for that name or number in ${row.regulator ?? "the register"}'s data. That is not the same as unlicensed: ${next}${row.verifyUrl === undefined ? "" : " on its own search"}.`,
          { sources, attribution },
        );
      }
      return answer(row.note, { matches: outcome.matches, sources, attribution });
    },

    /** A stored place, what OSM says of it now, and the place as a finding kept with the task. */
    async details(input: { readonly placeId: string }, signal: AbortSignal, context: CallContext) {
      const answer = await detailsOf(input, signal, context);
      return { ...answer, taviFindings: [placeFinding([answer.place])] };
    },

    /**
     * A fuel watch the person approved: add one, change, pause, resume
     * or remove it. Its area is geocoded now, while a person asks; a watch on
     * sources only a person may ask (Tankerkönig) is refused.
     */
    async watch(input: unknown, signal: AbortSignal, context: CallContext) {
      if (context.unattended) throw new Error("a watch is changed only by a person: this run is unattended");
      const query = FuelWatchInputSchema.parse(input);
      const { watches } = open();
      if (query.op === "add") {
        const { area, fuel, threshold, currency } = query;
        const reports: SourceReport[] = [];
        const point =
          "text" in area
            ? await geocode(area.text, query.country, AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]), context, reports)
            : area;
        if (point === undefined) throw new Error("the area could not be found: name a city, postcode or district");
        const country = query.country ?? ("country" in point ? point.country : undefined);
        if (country === undefined) throw new Error("say which country the area is in (country: a two-letter code)");
        const radiusKm = "radiusKm" in area ? area.radiusKm : TEXT_AREA_RADIUS_KM;
        const stored = {
          lat: point.lat,
          lon: point.lon,
          radiusKm,
          country,
          ...("label" in point && point.label !== undefined ? { label: point.label.slice(0, 200) } : {}),
        };
        const sources = watchSources(stored);
        if (sources.length > 0 && !sources.some((adapter) => adapter.currency === currency))
          throw new Error(
            `${country}'s fuel prices are in ${[...new Set(sources.map((adapter) => adapter.currency))].join(" or ")}, not ${currency}: a watch in ${currency} would never fire`,
          );
        if (sources.length === 0) {
          const personal = fuelSources
            .filter((adapter) => adapter.record.countries.includes(country) && adapter.record.terms.userTriggeredOnly)
            .map((adapter) => adapter.record.name);
          const averages = fuelSources.some((adapter) => adapter.record.countries.includes(country) && adapter.averagesOnly === true);
          throw new Error(
            personal.length > 0
              ? `${personal.join(", ")} allows only requests a person makes, so a watch cannot run on it: ask fuel_prices when you want prices`
              : averages
                ? `Tavi has no station prices for ${country}, only a regional or national average, so no station can come under a price: ask fuel_prices for the average`
                : `Tavi has no fuel price source a watch may use for ${country}`,
          );
        }
        const watch = watches.add(
          { area: stored, fuel, threshold, currency, cadenceHours: WATCH_CADENCES[query.cadence ?? "every-6h"] },
          now(),
        );
        return {
          watch: watchSummary(watch),
          note: "The plugin checks it on its cadence, with no model, and tells your heartbeat of a station at or under the price",
        };
      }
      const { watchId } = query;
      if (watches.watch(watchId) === undefined) throw new Error(`no watch ${watchId}`);
      if (query.op === "remove") return { removed: watches.remove(watchId), watchId };
      if (query.op === "pause" || query.op === "resume")
        return { watch: watchSummary(watches.change(watchId, { enabled: query.op === "resume" }, now())) };
      return {
        watch: watchSummary(
          watches.change(
            watchId,
            {
              ...definedOnly({ fuel: query.fuel, threshold: query.threshold, currency: query.currency }),
              ...(query.cadence === undefined ? {} : { cadenceHours: WATCH_CADENCES[query.cadence] }),
            },
            now(),
          ),
        ),
      };
    },

    /** The watches, or one watch's hits first seen after `since`: it reads, and writes nothing. */
    digest(input: { readonly watchId?: string | undefined; readonly since?: string | undefined }) {
      const { watches } = open();
      if (input.watchId === undefined) return { watches: watches.watches().map(watchSummary) };
      const watch = watches.watch(input.watchId);
      if (watch === undefined) throw new Error(`no watch ${input.watchId}`);
      const since = new Date(input.since ?? new Date(Date.parse(now()) - SIGNAL_WINDOW_MS).toISOString());
      if (Number.isNaN(since.getTime())) throw new Error("since is an ISO date and time");
      const hits = watches.hitsSince(watch.watchId, since.toISOString());
      return { watch: watchSummary(watch), since: since.toISOString(), count: hits.length, hits: hits.slice(0, 20) };
    },

    /** Runs the due watches; the heartbeat's collection starts it, and tests wait for it. */
    sweep,

    /**
     * What the heartbeat's Places source sees, model-free and quick: the
     * last day's hits not yet told. It starts the due sweeps and does not wait
     * for them: their hits are in the next collection.
     */
    signals(): HeartbeatSignalLike[] {
      // Its own failure (the store) is kept for `sources`, never left to end the worker.
      void sweep().catch((error: unknown) => {
        sweepError = { at: now(), error: errorMessage(error) };
      });
      const at = now();
      const { watches } = open();
      const fuels = new Map(watches.watches().map((watch) => [watch.watchId, watch]));
      return watches.deliver(new Date(Date.parse(at) - SIGNAL_WINDOW_MS).toISOString(), at, SIGNALS_MAX).map((hit) => {
        const watch = fuels.get(hit.watchId);
        return {
          key: `hit:${hit.watchId}:${hit.stationKey}`,
          hash: hit.price.toFixed(3),
          title:
            `${(watch?.fuel ?? "Fuel").toUpperCase()} at ${hit.station}: ${hit.price.toFixed(3)} ${hit.currency}, at or under your ${String(watch?.threshold ?? "")}`.slice(
              0,
              120,
            ),
          at: hit.firstSeen,
          source: "Places",
          data: {
            watch: hit.watchId,
            station: hit.station.slice(0, 200),
            price: hit.price.toFixed(3),
            currency: hit.currency,
            reportedAt: hit.reportedAt,
          },
        };
      });
    },

    /**
     * A stored place's booking routes: its platforms from the pages the
     * agent read this task and its own site and phone, each with what its site
     * profile allows. Nothing is fetched or kept.
     */
    availability(input: unknown): Availability & { readonly note: string } {
      const query = AvailabilityInputSchema.parse(input);
      const place = open().store.place(query.placeId, now());
      if (place === undefined) throw new Error(`no place ${query.placeId}: find it with search first`);
      const routes = bookingRoutes(place, query.pages, options.siteProfiles ?? SITE_PROFILES, now());
      return {
        placeId: place.placeId,
        routes,
        note:
          routes.length === 0
            ? "Tavi knows no way to book this place: no booking page was read, and it has no website or phone on record"
            : "A route's mode is what Tavi may do there once you turn on its site profile; a booking always ends at your own confirm step. Slots are as read on that platform's own page this task",
      };
    },

    /**
     * The receipt check: whether a booking Tavi staged went
     * through, on the platform's own word only, and the calendar hold a
     * staged one may propose. Nothing is fetched or kept.
     */
    bookingStatus(input: unknown): BookingStatus {
      return receiptCheck(BookingStatusInputSchema.parse(input), options.siteProfiles ?? SITE_PROFILES, now());
    },

    /** Relayed candidates compared with stored places: the merge answered, nothing relayed stored. */
    reconcile(input: {
      readonly items: readonly unknown[];
      readonly placeIds?: readonly string[] | undefined;
      readonly openAt?: string | undefined;
    }) {
      const { store } = open();
      const relayed = input.items
        .slice(0, RELAYED_MAX)
        .map((item) => RelayedItemSchema.safeParse(item))
        .flatMap((parsed) => (parsed.success ? [candidateFromRelayed(parsed.data)] : []))
        .filter((candidate) => candidate !== undefined);
      const stored = (input.placeIds ?? [])
        .slice(0, COMPARE_MAX)
        .map((placeId) => store.place(placeId, now()))
        .filter((place) => place !== undefined);
      const nearby = stored.length > 0 ? stored : relayed.flatMap((candidate) => store.placesNear(candidate, 0.15, now()));
      const merged = resolvePlaces(
        [...new Map([...nearby].map((place) => [place.placeId, place])).values()].map(candidateFromPlace).concat(relayed),
        { now: now(), priority: ["stored"], ...(input.openAt === undefined ? {} : { openAt: input.openAt }) },
      );
      return {
        places: merged,
        read: relayed.length,
        ignored: Math.min(input.items.length, RELAYED_MAX) - relayed.length,
        note: "Compared, not kept: what a page says is checked against stored places and never stored",
      };
    },

    /** Stored places side by side. */
    compare(input: { readonly placeIds: readonly string[] }) {
      const { store } = open();
      const places = input.placeIds.slice(0, COMPARE_MAX).map((placeId) => ({ placeId, place: store.place(placeId, now()) }));
      const attribution = notices(places.flatMap(({ place }) => (place === undefined ? [] : [place])));
      return {
        rows: places.map(({ placeId, place }) =>
          place === undefined
            ? { placeId, missing: true }
            : {
                placeId,
                name: place.name,
                address: place.address,
                phone: place.phone,
                website: place.website,
                hours: place.hours,
                status: place.status,
                confidence: place.confidence,
                flags: place.flags,
                sources: Object.keys(place.ids),
              },
        ),
        ...(attribution.length === 0 ? {} : { attribution }),
      };
    },

    sources() {
      const { store, budgets } = open();
      const on = enabled();
      const at = now();
      const area = packArea();
      const pack = area === undefined ? undefined : readdirPacks(area);
      return {
        sources: [...records.values()].map((record) => ({
          id: record.id,
          name: record.name,
          kind: record.kind,
          on: on.has(record.id),
          countries: record.countries,
          terms: {
            url: record.terms.url,
            reviewedAt: record.terms.reviewedAt,
            licence: record.terms.licence,
            cache: record.terms.cache,
            attribution: record.terms.attribution,
            displayRules: record.terms.displayRules,
            userTriggeredOnly: record.terms.userTriggeredOnly,
          },
          budget: { ...record.budget, usedToday: usedToday(budgets, record.id, at) },
          health: store.health(record.id, at),
        })),
        recentRequests: store.recentRequests(20),
        ...(sweepError === undefined ? {} : { sweepError }),
        ...(area === undefined ? {} : { overtureArea: { ...area, built: pack !== undefined } }),
      };
    },

    close() {
      stopping.abort();
      opened?.store.close();
      opened = undefined;
    },
  };
}

/** Stop targets one route takes. */
const STOP_TARGETS_MAX = 6;

/**
 * Where along a line of `lineKm` stops are wanted, and how far apart: every
 * `rangeKm` less a margin when a range is given, else `stops` evenly spread;
 * at most `STOP_TARGETS_MAX`, `capped` when the route needs more.
 */
export function stopTargets(
  lineKm: number,
  stops: number,
  rangeKm: number | undefined,
): { readonly targets: number[]; readonly spacingKm: number; readonly coveredKm: number; readonly capped: boolean } {
  if (rangeKm !== undefined) {
    const step = rangeKm * RANGE_MARGIN;
    const targets: number[] = [];
    for (let along = step; along < lineKm && targets.length < STOP_TARGETS_MAX; along += step) targets.push(along);
    if (targets.length === 0) return { targets: [lineKm / 2], spacingKm: lineKm, coveredKm: lineKm, capped: false };
    // After the last stop, a full range is left.
    const coveredKm = (targets.at(-1) ?? 0) + rangeKm;
    return { targets, spacingKm: step, coveredKm: Math.min(coveredKm, lineKm), capped: coveredKm < lineKm };
  }
  const spacingKm = lineKm / (stops + 1);
  return { targets: Array.from({ length: stops }, (_, index) => spacingKm * (index + 1)), spacingKm, coveredKm: lineKm, capped: false };
}

/** An area report's caveats by what it holds: complaints are reports, not findings; a section's own caveat is said. */
function notes(sections: readonly AreaReportSection[]): string[] {
  const said: string[] = [];
  if (sections.some((section) => section.topic === "complaints"))
    said.push("Complaints are what people reported to the city, not findings; a count depends on how much people report");
  if (sections.some((section) => section.topic === "crime"))
    said.push("Crimes are one month's, at anonymised points near where they happened");
  if (sections.some((section) => section.caveat !== undefined)) said.push("Some counts are partial: each section's caveat says why");
  return said;
}

/** A station as a heartbeat item names it: its name, then the parts of its address the name does not already say (France's feed names a station by its address). */
export function stationLabel(candidate: { readonly name: string; readonly address?: string | undefined }): string {
  // Whole parts only: a town called "Rue" is not in "… RUE DE GERLAND".
  const named = new Set(csvList(candidate.name).map((part) => part.toLowerCase()));
  return [candidate.name, ...csvList(candidate.address ?? "").filter((part) => !named.has(part.toLowerCase()))].join(", ");
}

/** Places as a finding kept with the task: `search`'s shape, at most 30. */
/** A country's English name from its code: "Bulgaria" for BG. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Who publishes an average, as a note names it. */
function averageSource(average: RegionalAverage): string {
  return average.source === "us-eia" ? "EIA" : "the EU's Weekly Oil Bulletin";
}

/** What `fuel_prices` says of an average: whose, for where and which week, and that it is no station's price. */
function averageNote(average: RegionalAverage, country: string, hasStationSource: boolean): string {
  const week = average.reportedAt.slice(0, 10);
  if (average.source === "us-eia")
    return `There are no official station prices in the US: this is EIA's weekly average for ${average.area} (week of ${week}), not any station's price. Check a station's own price in an app or at the pump`;
  const local = EU_LOCAL_CURRENCIES.get(country);
  const why = hasStationSource ? "The stations' own prices could not be read" : `Tavi has no station prices for ${average.area}`;
  const stale =
    average.staleDays === undefined
      ? ""
      : `. Its latest week is ${String(average.staleDays)} days old: the Commission may have stopped publishing it, so say how old it is`;
  return `${why}: this is ${averageSource(average)}'s national average with taxes for ${average.area} (week of ${week}), not any station's price${local === undefined ? "" : `, converted to EUR (the pumps price in ${local})`}${stale}. Check a station's own price in an app or at the pump`;
}

function placeFinding(places: readonly (Place & { readonly distanceKm?: number })[]): {
  readonly kind: "place";
  readonly records: Record<string, unknown>[];
} {
  return {
    kind: "place",
    records: places.slice(0, 30).map((place) => ({
      placeId: place.placeId,
      name: place.name,
      ...definedOnly({ address: place.address, phone: place.phone, website: place.website }),
      confidence: place.confidence,
      sources: Object.keys(place.ids),
    })),
  };
}

/** What a source has used of its budget today. */
function usedToday(budgets: BudgetLedger, source: string, at: string): number {
  const state = budgets.peek(source);
  return state?.day === at.slice(0, 10) ? state.usedToday : 0;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export type Engine = ReturnType<typeof createEngine>;
